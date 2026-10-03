import { vi } from 'vitest';
import type { NotificationReceipt } from '../src/types';
import { chatId, otherChatId, otherPhone, settings } from './fixtures';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

// Имитируем HTTP API и FIFO-очередь для React-тестов; реальный fetch заблокирован.
export function mockGreenApi() {
  const queue: NotificationReceipt[] = [];
  const waiting = new Set<{ resolve: (value: Response) => void; reject: (reason: unknown) => void; removeAbort: () => void }>();
  const calls: { method: string; body: unknown; signal?: AbortSignal | null }[] = [];
  const mock = {
    queue, calls,
    maxPendingReceives: 0,
    state: { stateInstance: 'authorized' },
    settings: { ...settings },
    getState: vi.fn(async () => mock.state as unknown),
    getSettings: vi.fn(async () => mock.settings as unknown),
    checkAccount: vi.fn(async (number: number) => ({ exist: true, chatId: String(number) === otherPhone ? otherChatId : chatId } as unknown)),
    sendMessage: vi.fn(async (chat: string, text: string) => {
      void chat; void text;
      return { idMessage: `synthetic-sent-${mock.sendMessage.mock.calls.length}` } as unknown;
    }),
    deleteNotification: vi.fn(async (id: number) => {
      if (queue[0]?.receiptId !== id) return { result: false, reason: 'wrong receipt' };
      queue.shift();
      return { result: true, reason: '' };
    }),
    push(value: NotificationReceipt) {
      queue.push(value);
      for (const waiter of waiting) {
        waiter.removeAbort();
        waiter.resolve(json(queue[0]));
      }
      waiting.clear();
    },
  };

  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const url = new URL(String(input));
    if (!/^\d+\.api\.green-api\.com$/.test(url.hostname)) throw new Error('Unexpected external test request.');
    const parts = url.pathname.split('/');
    const method = parts[2];
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined;
    calls.push({ method, body, signal: options?.signal });
    switch (method) {
      case 'getStateInstance': return json(await mock.getState());
      case 'getSettings': return json(await mock.getSettings());
      case 'checkAccount': return json(await mock.checkAccount(Number(body?.phoneNumber)));
      case 'sendMessage': {
        const value = await mock.sendMessage(String(body?.chatId), String(body?.message));
        return value instanceof Response ? value : json(value);
      }
      case 'deleteNotification': return json(await mock.deleteNotification(Number(parts[4])));
      case 'receiveNotification': {
        if (options?.signal?.aborted) throw new DOMException('synthetic abort', 'AbortError');
        if (queue.length) return json(queue[0]);
        return new Promise<Response>((resolve, reject) => {
          const signal = options?.signal;
          const onAbort = () => { waiting.delete(waiter); reject(new DOMException('synthetic abort', 'AbortError')); };
          const waiter = { resolve, reject, removeAbort: () => signal?.removeEventListener('abort', onAbort) };
          waiting.add(waiter);
          mock.maxPendingReceives = Math.max(mock.maxPendingReceives, waiting.size);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      default: throw new Error(`Unexpected API method in test: ${method}`);
    }
  });
  return mock;
}
