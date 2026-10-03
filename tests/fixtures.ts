import type { Credentials, Message, NotificationReceipt } from '../src/types';

// Все значения вымышлены: боевые токены и реальные контакты в фикстуры не попадают.
export const credentials: Credentials = {
  apiUrl: 'https://4100.api.green-api.com',
  idInstance: '4100000000',
  apiTokenInstance: 'synthetic-token-for-tests-only',
};
export const phone = '70000000001';
export const otherPhone = '70000000002';
export const chatId = '900719925474099312345';
export const otherChatId = '900719925474099312346';
export const timestamp = 1_770_000_000;

export const settings = {
  typeInstance: 'telegram',
  webhookUrl: '',
  incomingWebhook: 'yes',
  outgoingWebhook: 'yes',
  stateWebhook: 'yes',
};

export function incomingBody(overrides: {
  id?: string;
  chat?: string;
  text?: string;
  extended?: boolean;
  senderName?: string;
} = {}) {
  return {
    typeWebhook: 'incomingMessageReceived',
    instanceData: { idInstance: Number(credentials.idInstance), typeInstance: 'telegram' },
    idMessage: overrides.id ?? 'incoming-001',
    timestamp,
    senderData: {
      chatId: overrides.chat ?? chatId,
      senderName: overrides.senderName ?? 'Тестовый получатель',
    },
    messageData: overrides.extended
      ? { typeMessage: 'extendedTextMessage', extendedTextMessageData: { text: overrides.text ?? 'Ответ с https://example.test' } }
      : { typeMessage: 'textMessage', textMessageData: { textMessage: overrides.text ?? 'Ответ для теста' } },
  };
}

export function receipt(id = 1, body: unknown = incomingBody()): NotificationReceipt {
  return { receiptId: id, body };
}

export function outgoing(overrides: Partial<Message> = {}): Message {
  return {
    id: 'sent-001',
    chatId,
    text: 'Сообщение для теста',
    timestamp: timestamp * 1000,
    direction: 'outgoing',
    status: 'queued',
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

export function makeLockManager() {
  const held = new Set<string>();
  return {
    held,
    request: async (name: string, _options: unknown, callback: (lock: { name: string; mode: 'exclusive' } | null) => Promise<unknown>) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name, mode: 'exclusive' }); }
      finally { held.delete(name); }
    },
  };
}
