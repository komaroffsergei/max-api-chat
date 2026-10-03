import { GreenApiError, isAuthorizationError } from '../api/greenApi';
import type { GreenApiClient } from '../api/greenApi';
import { normalizeNotification } from '../api/notifications';
import type { NotificationEvent, PollingStatus } from '../types';

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    // setTimeout переполняется после ~24,8 дня. Длинный Retry-After ждём частями.
    let remaining = Math.max(0, milliseconds);
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const schedule = () => {
      const chunk = Math.min(remaining, 2_147_483_647);
      remaining -= chunk;
      timer = setTimeout(() => remaining > 0 ? schedule() : finish(), chunk);
    };
    schedule();
    signal.addEventListener('abort', finish, { once: true });
  });
}

type LoopOptions = {
  api: Pick<GreenApiClient, 'receiveNotification' | 'deleteNotification' | 'getStateInstance'>;
  signal: AbortSignal;
  onNotification: (event: NotificationEvent) => void;
  onStatus: (status: PollingStatus) => void;
  delay?: typeof abortableDelay;
};

function safeError(error: unknown): string {
  return error instanceof GreenApiError ? error.message : 'Не удалось получить уведомление.';
}

function cannotRetry(error: unknown): boolean {
  // 408/429 и сбои сети можно переждать. Ошибку адреса или настроек повтор не исправит.
  return error instanceof GreenApiError && (error.kind === 'format' ||
    (error.status !== null && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)));
}

// Читаем очередь последовательно: обработка события всегда предшествует DELETE.
export async function runNotificationLoop({ api, signal, onNotification, onStatus, delay = abortableDelay }: LoopOptions): Promise<void> {
  const backoff = [1000, 2000, 4000, 8000, 15_000];
  let receiveFailures = 0;

  while (!signal.aborted) {
    onStatus({ phase: 'listening', message: null });
    let receipt;
    try {
      receipt = await api.receiveNotification(signal);
      if (signal.aborted) return;
      receiveFailures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (isAuthorizationError(error)) { onStatus({ phase: 'stopped', message: safeError(error) }); return; }
      if (cannotRetry(error)) {
        onStatus({ phase: 'paused', message: `${safeError(error)} Проверьте настройки инстанса и повторите приём.` }); return;
      }
      const wait = error instanceof GreenApiError && error.retryAfterMs !== null
        ? error.retryAfterMs
        : backoff[Math.min(receiveFailures++, backoff.length - 1)];
      onStatus({ phase: 'backoff', message: `${safeError(error)} Повторяем приём.`, retryAt: Date.now() + wait });
      await delay(wait, signal);
      continue;
    }

    if (!receipt) { await delay(300, signal); continue; }

    let event: NotificationEvent;
    try {
      event = normalizeNotification(receipt.body);
      // Сначала передаём событие в состояние. receiptId нужен только для удаления.
      onNotification(event);
    } catch {
      onStatus({ phase: 'paused', message: 'Повреждённое уведомление: приём остановлен, уведомление не удалено.' });
      return;
    }

    let acknowledged = false;
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt += 1) {
      try {
        acknowledged = await api.deleteNotification(receipt.receiptId, signal);
        if (signal.aborted) return;
        if (!acknowledged) {
          onStatus({ phase: 'paused', message: 'GREEN-API не подтвердил удаление уведомления. Повторите приём.' });
          return;
        }
        break;
      } catch (error) {
        if (signal.aborted) return;
        if (isAuthorizationError(error)) { onStatus({ phase: 'stopped', message: safeError(error) }); return; }
        if (cannotRetry(error)) {
          onStatus({ phase: 'paused', message: `${safeError(error)} Уведомление не подтверждено. Проверьте настройки и повторите приём.` }); return;
        }
        if (attempt === 2) {
          onStatus({ phase: 'paused', message: 'Не удалось подтвердить уведомление после трёх попыток. Повторите приём.' });
          return;
        }
        const wait = error instanceof GreenApiError && error.retryAfterMs !== null ? error.retryAfterMs : backoff[attempt];
        onStatus({ phase: 'backoff', message: 'Не удалось подтвердить уведомление. Повторяем подтверждение.', retryAt: Date.now() + wait });
        await delay(wait, signal);
      }
    }

    if (!acknowledged || signal.aborted) return;
    if (event.kind === 'state' && event.state.toLowerCase() !== 'authorized') {
      // В очереди может лежать старое событие от прошлого входа. Проверяем состояние сейчас.
      try {
        const state = await api.getStateInstance(signal);
        if (signal.aborted) return;
        if (state.toLowerCase() !== 'authorized') {
          onStatus({ phase: 'stopped', message: 'Инстанс потерял авторизацию в Telegram. Выйдите и подключитесь снова.' });
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        onStatus({ phase: isAuthorizationError(error) ? 'stopped' : 'paused', message: `${safeError(error)} Не удалось проверить авторизацию. Повторите приём.` });
        return;
      }
    }
  }
}

type LockOptions = {
  instanceId: string;
  signal: AbortSignal;
  onStatus: (status: PollingStatus) => void;
  run: () => Promise<void>;
  locks?: Pick<LockManager, 'request'> | null;
};

// Вторая вкладка не должна забирать уведомления из очереди первой.
export async function runWithConsumerLock({ instanceId, signal, onStatus, run, locks = globalThis.navigator?.locks }: LockOptions): Promise<void> {
  if (signal.aborted) return;
  if (!locks) {
    onStatus({ phase: 'unsupported', message: 'Браузер не поддерживает Web Locks. Откройте приложение в современном браузере по HTTPS.' });
    return;
  }
  try {
    // Токен в имени блокировки не нужен: очередь одна на весь инстанс.
    await locks.request(`green-api:telegram:${instanceId}`, { ifAvailable: true }, async lock => {
      if (signal.aborted) return;
      if (!lock) {
        onStatus({ phase: 'blocked', message: 'Этот инстанс уже открыт в другой вкладке. Закройте её и повторите приём здесь.' });
        return;
      }
      await run();
    });
  } catch {
    if (!signal.aborted) onStatus({ phase: 'stopped', message: 'Не удалось получить право на приём уведомлений. Обновите страницу.' });
  }
}
