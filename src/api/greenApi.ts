import type { Credentials, NotificationReceipt } from '../types';
import { normalizePhoneNumber } from '../phone';

export const DEFAULT_API_URL = 'https://4100.api.green-api.com';
export const MESSAGE_LENGTH_LIMIT = 4096;

type ApiErrorKind = 'network' | 'http' | 'format' | 'validation' | 'business' | 'authorization';

export class GreenApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(message: string, options: { kind?: ApiErrorKind; status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'GreenApiError';
    this.kind = options.kind ?? 'format';
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function isAuthorizationError(error: unknown): boolean {
  return error instanceof GreenApiError && (error.status === 401 || error.status === 403 || error.kind === 'authorization');
}

// Разрешаем только выделенные HTTPS-серверы GREEN-API, без сторонних адресов и путей.
export function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new GreenApiError('Введите HTTPS-адрес API-сервера GREEN-API.', { kind: 'validation' });
  }
  if (
    url.protocol !== 'https:' ||
    !/^\d+\.api\.green-api\.com$/.test(url.hostname) ||
    url.username || url.password || url.port || url.search || url.hash ||
    url.pathname !== '/'
  ) {
    throw new GreenApiError('Адрес должен иметь вид https://4100.api.green-api.com, без пути и дополнительных параметров.', { kind: 'validation' });
  }
  return url.origin;
}

// Проверяем поля до запроса, но не сохраняем ключи вне текущей сессии.
export function validateCredentials(values: Credentials): Credentials {
  const idInstance = values.idInstance.trim();
  const apiTokenInstance = values.apiTokenInstance.trim();
  if (!/^\d+$/.test(idInstance) || !apiTokenInstance || /[\s/?#]/.test(apiTokenInstance)) {
    throw new GreenApiError('Проверьте idInstance и apiTokenInstance.', { kind: 'validation' });
  }
  return { idInstance, apiTokenInstance, apiUrl: normalizeApiUrl(values.apiUrl) };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : null;
}

export type InstanceSettings = {
  typeInstance: string;
  webhookUrl: string;
  incomingWebhook: string;
  outgoingWebhook: string | null;
  stateWebhook: string | null;
};

// Все методы одной Telegram-сессии используют введённые пользователем ключи.
export function createGreenApiClient(values: Credentials) {
  const credentials = validateCredentials(values);

  async function request(method: string, options: { body?: unknown; signal?: AbortSignal; receiptId?: number; empty?: boolean; receiveTimeout?: number } = {}): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 35_000);
    const receipt = options.receiptId === undefined ? '' : `/${options.receiptId}`;
    const query = options.receiveTimeout === undefined ? '' : `?receiveTimeout=${options.receiveTimeout}`;
    const url = `${credentials.apiUrl}/waInstance${credentials.idInstance}/${method}/${encodeURIComponent(credentials.apiTokenInstance)}${receipt}${query}`;

    try {
      const response = await fetch(url, {
        method: options.receiptId !== undefined ? 'DELETE' : options.body === undefined ? 'GET' : 'POST',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) {
        const message = response.status === 401 || response.status === 403
          ? 'GREEN-API отклонил доступ. Проверьте ключи и авторизацию инстанса.'
          : response.status === 469 && method === 'checkAccount'
            ? 'Telegram ограничил поиск номеров. Повторите проверку через несколько часов.'
          : response.status === 429
            ? 'GREEN-API временно ограничил число запросов.'
            : `GREEN-API вернул ошибку ${response.status}.`;
        throw new GreenApiError(message, { kind: 'http', status: response.status, retryAfterMs: retryAfter(response.headers.get('Retry-After')) ?? undefined });
      }
      const text = await response.text();
      if (!text.trim() && options.empty) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new GreenApiError('GREEN-API вернул ответ в неожиданном формате.', { kind: 'format' });
      }
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('Запрос отменён.', 'AbortError');
      if (error instanceof GreenApiError) throw error;
      // Ошибка fetch может содержать URL с токеном. Наружу отдаём только наш текст.
      throw new GreenApiError('Нет связи с GREEN-API. Проверьте соединение и адрес API-сервера.', { kind: 'network' });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  return {
    async getStateInstance(signal?: AbortSignal): Promise<string> {
      const value = object(await request('getStateInstance', { signal }));
      if (typeof value?.stateInstance !== 'string') throw new GreenApiError('Не удалось прочитать состояние инстанса.');
      return value.stateInstance;
    },

    async getSettings(signal?: AbortSignal): Promise<InstanceSettings> {
      const value = object(await request('getSettings', { signal }));
      if (typeof value?.typeInstance !== 'string' || typeof value.webhookUrl !== 'string' || typeof value.incomingWebhook !== 'string') {
        throw new GreenApiError('Не удалось прочитать настройки инстанса.');
      }
      return {
        typeInstance: value.typeInstance,
        webhookUrl: value.webhookUrl,
        incomingWebhook: value.incomingWebhook,
        outgoingWebhook: typeof value.outgoingWebhook === 'string' ? value.outgoingWebhook : null,
        stateWebhook: typeof value.stateWebhook === 'string' ? value.stateWebhook : null,
      };
    },

    async checkAccount(phone: string, signal?: AbortSignal): Promise<{ exist: boolean; chatId: string | null }> {
      const phoneNumber = Number(normalizePhoneNumber(phone));
      const value = object(await request('checkAccount', { body: { phoneNumber }, signal }));
      if (value?.status === false) {
        const data = object(value.data);
        if (data?.reason === 'rate_limit_exceeded') {
          throw new GreenApiError('Поиск номеров временно ограничен. Повторите проверку позже.', { kind: 'business', status: 200 });
        }
        if (value.reason === 'instance is starting or not authorized') {
          throw new GreenApiError('Инстанс запускается или потерял авторизацию. Проверьте его в личном кабинете GREEN-API.', { kind: 'authorization', status: 200 });
        }
        // Произвольный reason не показываем: сервер может вернуть в нём данные запроса.
        throw new GreenApiError('GREEN-API не смог проверить номер телефона. Повторите позже.', { kind: 'business', status: 200 });
      }
      if (typeof value?.exist !== 'boolean') throw new GreenApiError('Не удалось проверить номер телефона.');
      if (!value.exist) return { exist: false, chatId: null };
      if (typeof value.chatId !== 'string' || !value.chatId.trim()) throw new GreenApiError('GREEN-API не вернул адрес чата.');
      return { exist: true, chatId: value.chatId };
    },

    async sendMessage(chatId: string, message: string, signal?: AbortSignal): Promise<{ idMessage: string }> {
      if (!chatId || !message.trim() || message.length > MESSAGE_LENGTH_LIMIT) {
        throw new GreenApiError(`Сообщение должно содержать от 1 до ${MESSAGE_LENGTH_LIMIT} символов.`, { kind: 'validation' });
      }
      const value = object(await request('sendMessage', { body: { chatId, message }, signal }));
      if (typeof value?.idMessage !== 'string' || !value.idMessage) throw new GreenApiError('GREEN-API не вернул номер сообщения.');
      return { idMessage: value.idMessage };
    },

    async receiveNotification(signal?: AbortSignal): Promise<NotificationReceipt | null> {
      const value = await request('receiveNotification', { signal, empty: true, receiveTimeout: 25 });
      if (value === null) return null;
      const receipt = object(value);
      if (!Number.isSafeInteger(receipt?.receiptId) || Number(receipt?.receiptId) < 0 || !object(receipt?.body)) {
        throw new GreenApiError('Повреждённое уведомление: приём остановлен, уведомление не удалено.');
      }
      return { receiptId: receipt!.receiptId as number, body: receipt!.body };
    },

    async deleteNotification(receiptId: number, signal?: AbortSignal): Promise<boolean> {
      if (!Number.isSafeInteger(receiptId) || receiptId < 0) throw new GreenApiError('Не удалось подтвердить уведомление.');
      const value = object(await request('deleteNotification', { receiptId, signal }));
      if (typeof value?.result !== 'boolean') throw new GreenApiError('GREEN-API не подтвердил удаление уведомления.');
      return value.result;
    },
  };
}

export type GreenApiClient = ReturnType<typeof createGreenApiClient>;
