import { describe, expect, it } from 'vitest';
import { normalizeNotification, NotificationFormatError } from '../src/api/notifications';
import { chatId, incomingBody, timestamp } from './fixtures';

describe('Telegram notification normalization', () => {
  it('preserves canonical string identifiers and plain text and converts seconds to milliseconds', () => {
    const text = '  Кириллица 😀\n<script>alert(1)</script>  ';
    expect(normalizeNotification(incomingBody({ id: '900719925474099399999', text }))).toEqual({
      kind: 'incoming', senderName: 'Тестовый получатель', chatName: null, isGroup: false,
      message: { id: '900719925474099399999', chatId, text, timestamp: timestamp * 1000, direction: 'incoming' },
    });
  });

  it('normalizes extended text with a URL without stripping its text', () => {
    const event = normalizeNotification(incomingBody({ extended: true, text: 'Ответ\nhttps://example.test?q=1' }));
    expect(event.kind).toBe('incoming');
    if (event.kind === 'incoming') expect(event.message.text).toBe('Ответ\nhttps://example.test?q=1');
  });

  it('accepts empty received text and falls back when a sender name is absent', () => {
    const event = normalizeNotification(incomingBody({ text: '', senderName: ' ' }));
    expect(event.kind).toBe('incoming');
    if (event.kind === 'incoming') {
      expect(event.senderName).toBeNull();
      expect(event.message.text).toBe('');
    }
  });

  it.each(['group', 'supergroup'])('distinguishes %s chat identity from the individual sender', chatType => {
    const body = incomingBody();
    const event = normalizeNotification({
      ...body,
      senderData: { chatId: '-10000000000000', chatType, chatName: 'Тестовая команда', senderName: 'Алиса' },
    });
    expect(event).toMatchObject({ kind: 'incoming', isGroup: true, chatName: 'Тестовая команда', senderName: 'Алиса', message: { chatId: '-10000000000000' } });
  });

  it('retains group context when chatName is empty so the UI can use a safe recipient fallback', () => {
    const body = incomingBody();
    expect(normalizeNotification({ ...body, senderData: { chatId: '-10000000000000', chatType: 'group', chatName: ' ', senderName: 'Алиса' } }))
      .toMatchObject({ kind: 'incoming', isGroup: true, chatName: null });
  });

  it.each(['sent', 'delivered', 'read', 'failed', 'noAccount'])('normalizes outgoing status %s', status => {
    expect(normalizeNotification({ typeWebhook: 'outgoingMessageStatus', chatId, idMessage: 'sent-001', status })).toEqual({
      kind: 'status', chatId, messageId: 'sent-001', status,
    });
  });

  it.each(['failed', 'noAccount'])('accepts a chat-level %s event without a message id', status => {
    expect(normalizeNotification({ typeWebhook: 'outgoingMessageStatus', chatId, status })).toEqual({ kind: 'status', chatId, messageId: null, status });
  });

  it.each(['authorized', 'notAuthorized', 'starting', 'sleepMode'])('passes instance state %s to the polling lifecycle', stateInstance => {
    expect(normalizeNotification({ typeWebhook: 'stateInstanceChanged', stateInstance })).toEqual({ kind: 'state', state: stateInstance });
  });

  it.each(['imageMessage', 'audioMessage', 'documentMessage', 'stickerMessage'])('identifies unsupported %s as an intentional skip that may be ACKed', typeMessage => {
    expect(normalizeNotification({ typeWebhook: 'incomingMessageReceived', messageData: { typeMessage } })).toEqual({
      kind: 'ignored', type: `incomingMessageReceived:${typeMessage}`,
    });
  });

  it('ignores future status/service types without constructing fake text messages', () => {
    expect(normalizeNotification({ typeWebhook: 'outgoingMessageStatus', status: 'futureStatus' })).toEqual({ kind: 'ignored', type: 'outgoingMessageStatus:futureStatus' });
    expect(normalizeNotification({ typeWebhook: 'futureServiceEvent' })).toEqual({ kind: 'ignored', type: 'futureServiceEvent' });
  });

  const valid = incomingBody();
  it.each([
    null, [], {}, { typeWebhook: 42 },
    { ...valid, idMessage: '' }, { ...valid, idMessage: 9007199254740992 },
    { ...valid, senderData: { chatId: ' ' } }, { ...valid, senderData: { chatId: 123 } },
    { ...valid, messageData: {} }, { ...valid, messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 123 } } },
    { ...valid, timestamp: '1770000000' }, { ...valid, timestamp: Number.NaN }, { ...valid, timestamp: Number.POSITIVE_INFINITY },
    { ...valid, timestamp: 1e20 }, { ...valid, timestamp: Number.MAX_VALUE },
    { typeWebhook: 'outgoingMessageStatus', chatId, status: 'sent' },
    { typeWebhook: 'outgoingMessageStatus', chatId: '', idMessage: 'sent-001', status: 'read' },
    { typeWebhook: 'stateInstanceChanged', stateInstance: '' },
  ])('refuses malformed event %# without acknowledging it', body => {
    expect(() => normalizeNotification(body)).toThrow(NotificationFormatError);
  });
});
