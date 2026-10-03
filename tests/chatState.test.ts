import { describe, expect, it } from 'vitest';
import { chatReducer, createInitialChatState } from '../src/state/chatState';
import type { ChatState } from '../src/state/chatState';
import { normalizeNotification } from '../src/api/notifications';
import { chatId, incomingBody, otherChatId, otherPhone, outgoing, phone } from './fixtures';

const opened = () => chatReducer(createInitialChatState(), { type: 'openChat', chatId, phone });
const status = (state: ChatState, value: 'sent' | 'delivered' | 'read' | 'failed' | 'noAccount', id = 'sent-001', chat = chatId) => chatReducer(state, {
  type: 'notification', event: { kind: 'status', chatId: chat, messageId: id, status: value },
});

describe('session chat state', () => {
  it('starts empty with no implicit history', () => {
    expect(createInitialChatState()).toEqual({ chats: [], activeChatId: null, pendingStatuses: {} });
  });

  it('opens canonical chats and avoids duplicates when the same result is returned twice', () => {
    const first = opened();
    const second = chatReducer(first, { type: 'openChat', chatId, phone });
    expect(second.chats).toHaveLength(1);
    expect(second.activeChatId).toBe(chatId);
    expect(second.chats[0]).toMatchObject({ id: chatId, phone, draft: '', messages: [] });
    expect(first.chats).toHaveLength(1);
  });

  it('keeps drafts with their chats and ignores selection of an unknown chat', () => {
    let state = chatReducer(opened(), { type: 'setDraft', chatId, text: 'Черновик A' });
    state = chatReducer(state, { type: 'openChat', chatId: otherChatId, phone: otherPhone });
    state = chatReducer(state, { type: 'setDraft', chatId: otherChatId, text: 'Черновик B' });
    state = chatReducer(state, { type: 'selectChat', chatId });
    expect(state.chats.map(chat => chat.draft)).toEqual(['Черновик A', 'Черновик B']);
    expect(chatReducer(state, { type: 'selectChat', chatId: 'missing' })).toBe(state);
  });

  it('appends a sent result to its original chat after switching and clears only its submitted draft', () => {
    let state = chatReducer(opened(), { type: 'setDraft', chatId, text: 'Отправлено из A' });
    state = chatReducer(state, { type: 'openChat', chatId: otherChatId, phone: otherPhone });
    state = chatReducer(state, { type: 'setDraft', chatId: otherChatId, text: 'Черновик B' });
    state = chatReducer(state, { type: 'messageSent', message: outgoing({ text: 'Отправлено из A' }), submittedDraft: 'Отправлено из A' });
    expect(state.activeChatId).toBe(otherChatId);
    expect(state.chats[0].messages).toHaveLength(1);
    expect(state.chats[0].draft).toBe('');
    expect(state.chats[1].draft).toBe('Черновик B');
    expect(state.chats[1].messages).toHaveLength(0);
  });

  it('does not clear a newer draft when the previous send finishes late', () => {
    const state = chatReducer(chatReducer(opened(), { type: 'setDraft', chatId, text: 'Новый черновик' }), {
      type: 'messageSent', message: outgoing({ text: 'Предыдущий черновик' }), submittedDraft: 'Предыдущий черновик',
    });
    expect(state.chats[0].draft).toBe('Новый черновик');
  });

  it('deduplicates identical ids but preserves identical texts with different ids', () => {
    const event = normalizeNotification(incomingBody());
    let state = chatReducer(opened(), { type: 'notification', event });
    state = chatReducer(state, { type: 'notification', event });
    state = chatReducer(state, { type: 'notification', event: normalizeNotification(incomingBody({ id: 'incoming-002' })) });
    expect(state.chats[0].messages.map(message => message.id)).toEqual(['incoming-001', 'incoming-002']);
  });

  it('deduplicates within a chat without merging matching ids from another chat', () => {
    let state = chatReducer(opened(), { type: 'notification', event: normalizeNotification(incomingBody()) });
    state = chatReducer(state, { type: 'notification', event: normalizeNotification(incomingBody({ chat: otherChatId })) });
    expect(state.chats).toHaveLength(2);
    expect(state.chats.map(chat => chat.messages.length)).toEqual([1, 1]);
    expect(state.activeChatId).toBe(chatId);
    expect(state.chats[1].title).toBe('Тестовый получатель');
  });

  it('applies an early status after send resolves and clears its pending entry', () => {
    const early = status(opened(), 'read');
    expect(Object.values(early.pendingStatuses)).toEqual(['read']);
    const state = chatReducer(early, { type: 'messageSent', message: outgoing(), submittedDraft: '' });
    expect(state.chats[0].messages[0].status).toBe('read');
    expect(state.pendingStatuses).toEqual({});
  });

  it('does not regress a delivered/read state when earlier status notifications arrive late', () => {
    let state = chatReducer(opened(), { type: 'messageSent', message: outgoing(), submittedDraft: '' });
    state = status(state, 'read');
    state = status(state, 'delivered');
    state = status(state, 'sent');
    expect(state.chats[0].messages[0].status).toBe('read');
  });

  it.each(['failed', 'noAccount'] as const)('associates %s with an exact outgoing message', failure => {
    const state = status(chatReducer(opened(), { type: 'messageSent', message: outgoing(), submittedDraft: '' }), failure);
    expect(state.chats[0].messages[0].status).toBe(failure);
  });

  it('makes an unidentifiable failure a chat error, not a fabricated message bubble', () => {
    const state = chatReducer(opened(), { type: 'notification', event: { kind: 'status', chatId, messageId: null, status: 'failed' } });
    expect(state.chats[0].error).toMatch(/ошибке отправки/);
    expect(state.chats[0].messages).toEqual([]);
  });

  it('keeps an unknown-chat failure visible without creating a fake message', () => {
    const state = chatReducer(createInitialChatState(), { type: 'notification', event: { kind: 'status', chatId, messageId: null, status: 'noAccount' } });
    expect(state.chats).toHaveLength(1);
    expect(state.chats[0]).toMatchObject({ id: chatId, messages: [], error: expect.stringContaining('ошибке отправки') });
  });

  it.each(['failed', 'noAccount'] as const)('retains a chat-level %s error when an unrelated message arrives or a later send is queued', failure => {
    const initial = chatReducer(opened(), { type: 'notification', event: { kind: 'status', chatId, messageId: null, status: failure } });
    const withIncoming = chatReducer(initial, { type: 'notification', event: normalizeNotification(incomingBody()) });
    const withQueued = chatReducer(initial, { type: 'messageSent', message: outgoing(), submittedDraft: '' });
    expect(withIncoming.chats[0].error).toBe(initial.chats[0].error);
    expect(withQueued.chats[0].error).toBe(initial.chats[0].error);
  });

  it.each(['failed', 'noAccount'] as const)('retains terminal %s when delayed delivered/read statuses arrive', failure => {
    let state = status(chatReducer(opened(), { type: 'messageSent', message: outgoing(), submittedDraft: '' }), failure);
    state = status(state, 'delivered');
    state = status(state, 'read');
    expect(state.chats[0].messages[0].status).toBe(failure);
  });

  it('does not render service/state/unsupported events as messages', () => {
    const state = opened();
    expect(chatReducer(state, { type: 'notification', event: { kind: 'ignored', type: 'imageMessage' } })).toBe(state);
    expect(chatReducer(state, { type: 'notification', event: { kind: 'state', state: 'authorized' } })).toBe(state);
  });

  it('isolates chat errors and clears every session element on logout', () => {
    const original = status(chatReducer(opened(), { type: 'setDraft', chatId, text: 'Черновик' }), 'delivered');
    const state = chatReducer(original, { type: 'chatError', chatId, error: 'Ошибка' });
    expect(state.chats[0].error).toBe('Ошибка');
    expect(original.chats[0].error).toBeNull();
    expect(chatReducer(state, { type: 'clear' })).toEqual(createInitialChatState());
  });
});
