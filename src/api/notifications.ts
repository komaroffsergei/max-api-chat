import type { MessageStatus, NotificationEvent } from '../types';

export class NotificationFormatError extends Error {
  constructor() {
    super('Повреждённое уведомление: приём остановлен, уведомление не удалено.');
    this.name = 'NotificationFormatError';
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new NotificationFormatError();
  return value;
}

// Приводим Telegram-события к данным чата; повреждённый текст не подтверждаем.
export function normalizeNotification(value: unknown): NotificationEvent {
  const body = object(value);
  const type = requiredString(body?.typeWebhook);

  if (type === 'incomingMessageReceived') {
    const data = object(body?.messageData);
    const messageType = requiredString(data?.typeMessage);
    if (messageType !== 'textMessage' && messageType !== 'extendedTextMessage') {
      return { kind: 'ignored', type: `${type}:${messageType}` };
    }
    const sender = object(body?.senderData);
    const textData = object(messageType === 'textMessage' ? data?.textMessageData : data?.extendedTextMessageData);
    const text = messageType === 'textMessage' ? textData?.textMessage : textData?.text;
    const timestamp = typeof body?.timestamp === 'number' ? body.timestamp * 1000 : NaN;
    // Невалидная дата сломает вывод сообщения уже после удаления уведомления.
    if (typeof text !== 'string' || !Number.isFinite(timestamp) || Number.isNaN(new Date(timestamp).getTime())) {
      throw new NotificationFormatError();
    }
    return {
      kind: 'incoming',
      senderName: typeof sender?.senderName === 'string' && sender.senderName.trim() ? sender.senderName : null,
      // Имя автора сообщения и название группы — разные вещи. Ответ уйдёт в chatId.
      chatName: typeof sender?.chatName === 'string' && sender.chatName.trim() ? sender.chatName : null,
      isGroup: sender?.chatType === 'group' || sender?.chatType === 'supergroup',
      message: {
        id: requiredString(body?.idMessage),
        chatId: requiredString(sender?.chatId),
        text,
        timestamp,
        direction: 'incoming',
      },
    };
  }

  if (type === 'outgoingMessageStatus') {
    const status = requiredString(body?.status);
    if (!['sent', 'delivered', 'read', 'failed', 'noAccount'].includes(status)) return { kind: 'ignored', type: `${type}:${status}` };
    const messageId = typeof body?.idMessage === 'string' && body.idMessage ? body.idMessage : null;
    if (!messageId && status !== 'failed' && status !== 'noAccount') throw new NotificationFormatError();
    return {
      kind: 'status',
      chatId: requiredString(body?.chatId),
      messageId,
      status: status as MessageStatus,
    };
  }

  if (type === 'stateInstanceChanged') return { kind: 'state', state: requiredString(body?.stateInstance) };

  // Медиа и служебные события тоже надо убрать из общей очереди инстанса.
  return { kind: 'ignored', type };
}
