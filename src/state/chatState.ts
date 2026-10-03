import type { Chat, Message, MessageStatus, NotificationEvent } from '../types';

export type ChatState = {
  chats: Chat[];
  activeChatId: string | null;
  pendingStatuses: Record<string, MessageStatus>;
};

export type ChatAction =
  | { type: 'openChat'; chatId: string; phone: string }
  | { type: 'selectChat'; chatId: string }
  | { type: 'setDraft'; chatId: string; text: string }
  | { type: 'messageSent'; message: Message; submittedDraft?: string }
  | { type: 'notification'; event: NotificationEvent }
  | { type: 'chatError'; chatId: string; error: string | null }
  | { type: 'clear' };

export function createInitialChatState(): ChatState {
  return { chats: [], activeChatId: null, pendingStatuses: {} };
}

function newChat(id: string, phone = '', title = ''): Chat {
  return { id, phone, title: title || (phone ? `+${phone}` : id), messages: [], draft: '', error: null };
}

function mergeStatus(current: MessageStatus | undefined, next: MessageStatus): MessageStatus {
  if (current === 'failed' || current === 'noAccount') return current;
  if (next === 'failed' || next === 'noAccount') return next;
  const rank = { queued: 0, sent: 1, delivered: 2, read: 3 };
  return current && rank[current] > rank[next] ? current : next;
}

function statusKey(chatId: string, messageId: string): string {
  return `${chatId}:${messageId}`;
}

function addMessage(state: ChatState, message: Message, senderName?: string | null, submittedDraft?: string, isGroup?: boolean): ChatState {
  const existing = state.chats.find(chat => chat.id === message.chatId);
  const chat = existing ?? newChat(message.chatId, '', senderName ?? '');
  const pendingKey = statusKey(message.chatId, message.id);
  const status = state.pendingStatuses[pendingKey];
  const normalized = status ? { ...message, status: mergeStatus(message.status, status) } : message;
  const messageExists = chat.messages.some(item => item.id === message.id);
  const messages = messageExists
    ? chat.messages.map(item => item.id === message.id ? { ...item, ...(normalized.status ? { status: mergeStatus(item.status, normalized.status) } : {}) } : item)
    : [...chat.messages, normalized];
  const updated = {
    ...chat,
    ...(isGroup ? { isGroup: true, title: senderName || `Группа ${message.chatId}` } : {}),
    messages,
    draft: submittedDraft !== undefined && chat.draft === submittedDraft ? '' : chat.draft,
    error: chat.error,
  };
  const pendingStatuses = { ...state.pendingStatuses };
  delete pendingStatuses[pendingKey];
  return {
    ...state,
    chats: existing ? state.chats.map(item => item.id === chat.id ? updated : item) : [...state.chats, updated],
    pendingStatuses,
  };
}

// Обновляем чаты в одном месте, чтобы повторные события не создавали дубли.
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'clear': return createInitialChatState();
    case 'openChat': {
      const existing = state.chats.find(chat => chat.id === action.chatId);
      return {
        ...state,
        activeChatId: action.chatId,
        chats: existing ? state.chats.map(chat => chat.id === action.chatId ? { ...chat, phone: action.phone, title: `+${action.phone}` } : chat) : [...state.chats, newChat(action.chatId, action.phone)],
      };
    }
    case 'selectChat': return state.chats.some(chat => chat.id === action.chatId) ? { ...state, activeChatId: action.chatId } : state;
    case 'setDraft': return { ...state, chats: state.chats.map(chat => chat.id === action.chatId ? { ...chat, draft: action.text } : chat) };
    case 'chatError': return { ...state, chats: state.chats.map(chat => chat.id === action.chatId ? { ...chat, error: action.error } : chat) };
    case 'messageSent': return addMessage(state, action.message, null, action.submittedDraft);
    case 'notification': {
      const event = action.event;
      if (event.kind === 'incoming') return addMessage(state, event.message, event.isGroup ? event.chatName || `Группа ${event.message.chatId}` : event.senderName, undefined, event.isGroup);
      if (event.kind !== 'status') return state;
      if (!event.messageId) {
        const existing = state.chats.find(chat => chat.id === event.chatId);
        const chat = { ...(existing ?? newChat(event.chatId)), error: 'GREEN-API сообщил об ошибке отправки в этом чате.' };
        return { ...state, chats: existing ? state.chats.map(item => item.id === event.chatId ? chat : item) : [...state.chats, chat] };
      }
      const key = statusKey(event.chatId, event.messageId);
      const chat = state.chats.find(item => item.id === event.chatId);
      if (!chat?.messages.some(message => message.id === event.messageId)) {
        // Ответ SendMessage мог потеряться. Окончательную ошибку всё равно показываем.
        const failed = event.status === 'failed' || event.status === 'noAccount';
        const updated = failed ? { ...(chat ?? newChat(event.chatId)), error: 'GREEN-API сообщил об ошибке отправки в этом чате.' } : chat;
        return {
          ...state,
          chats: failed && updated ? (chat ? state.chats.map(item => item.id === event.chatId ? updated : item) : [...state.chats, updated]) : state.chats,
          pendingStatuses: { ...state.pendingStatuses, [key]: mergeStatus(state.pendingStatuses[key], event.status) },
        };
      }
      return {
        ...state,
        chats: state.chats.map(item => item.id === event.chatId ? {
          ...item,
          messages: item.messages.map(message => message.id === event.messageId ? { ...message, status: mergeStatus(message.status, event.status) } : message),
        } : item),
      };
    }
  }
}
