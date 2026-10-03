import { describe, expect, it, vi } from 'vitest';
import { GreenApiError } from '../src/api/greenApi';
import { chatReducer, createInitialChatState } from '../src/state/chatState';
import { abortableDelay, runNotificationLoop, runWithConsumerLock } from '../src/state/pollNotifications';
import { deferred, flushPromises, incomingBody, makeLockManager, receipt } from './fixtures';

// Управляем ответами очереди и остановкой без сети, настоящих ключей и живых таймеров.
function harness() {
  const controller = new AbortController();
  const api = {
    getStateInstance: vi.fn().mockResolvedValue('authorized'),
    receiveNotification: vi.fn(),
    deleteNotification: vi.fn().mockResolvedValue(true),
  };
  const onNotification = vi.fn();
  const onStatus = vi.fn();
  const delay = vi.fn(async (milliseconds: number, signal: AbortSignal) => { void milliseconds; void signal; });
  const finishReceive = async () => { controller.abort(); return null; };
  const run = () => runNotificationLoop({ api, signal: controller.signal, onNotification, onStatus, delay });
  return { api, controller, onNotification, onStatus, delay, finishReceive, run };
}

describe('sequential notification consumption', () => {
  it('processes a FIFO message before ACK and does not receive another while ACK is pending', async () => {
    const h = harness();
    const ack = deferred<boolean>();
    const order: string[] = [];
    h.api.receiveNotification.mockImplementationOnce(async () => { order.push('receive A'); return receipt(); }).mockImplementationOnce(h.finishReceive);
    h.onNotification.mockImplementation(() => { order.push('process A'); });
    h.api.deleteNotification.mockImplementationOnce(async () => { order.push('delete A'); return ack.promise; });
    const pending = h.run();
    await flushPromises();
    expect(order).toEqual(['receive A', 'process A', 'delete A']);
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(1);
    ack.resolve(true);
    await pending;
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(2);
    expect(h.api.deleteNotification).toHaveBeenCalledWith(1, h.controller.signal);
  });

  it('keeps A/B/C ordering and confirms every receipt including a duplicate message', async () => {
    const h = harness();
    let state = createInitialChatState();
    h.onNotification.mockImplementation(event => { state = chatReducer(state, { type: 'notification', event }); });
    for (const [id, messageId] of [[1, 'A'], [2, 'B'], [3, 'B'], [4, 'C']] as const) {
      h.api.receiveNotification.mockResolvedValueOnce(receipt(id, incomingBody({ id: messageId, text: messageId })));
    }
    h.api.receiveNotification.mockImplementationOnce(h.finishReceive);
    await h.run();
    expect(state.chats[0].messages.map(message => message.id)).toEqual(['A', 'B', 'C']);
    expect(h.api.deleteNotification.mock.calls.map(call => call[0])).toEqual([1, 2, 3, 4]);
  });

  it('paces an empty receive without DELETE or a busy loop', async () => {
    const h = harness();
    h.api.receiveNotification.mockResolvedValueOnce(null).mockImplementationOnce(h.finishReceive);
    await h.run();
    expect(h.delay).toHaveBeenCalledExactlyOnceWith(300, h.controller.signal);
    expect(h.api.deleteNotification).not.toHaveBeenCalled();
    expect(h.onNotification).not.toHaveBeenCalled();
  });

  it('ACKs a valid unsupported media/service notification so it cannot block the FIFO head', async () => {
    const h = harness();
    h.api.receiveNotification.mockResolvedValueOnce(receipt(1, { typeWebhook: 'incomingMessageReceived', messageData: { typeMessage: 'imageMessage' } })).mockImplementationOnce(h.finishReceive);
    await h.run();
    expect(h.onNotification).toHaveBeenCalledWith({ kind: 'ignored', type: 'incomingMessageReceived:imageMessage' });
    expect(h.api.deleteNotification).toHaveBeenCalledTimes(1);
  });

  it('pauses a malformed text event without deleting it or requesting the next receipt', async () => {
    const h = harness();
    h.api.receiveNotification.mockResolvedValue(receipt(1, { typeWebhook: 'incomingMessageReceived', messageData: { typeMessage: 'textMessage' } }));
    await h.run();
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused' }));
    expect(h.api.deleteNotification).not.toHaveBeenCalled();
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(1);
  });

  it('does not ACK if application processing fails', async () => {
    const h = harness();
    h.api.receiveNotification.mockResolvedValue(receipt());
    h.onNotification.mockImplementation(() => { throw new Error('synthetic state failure'); });
    await h.run();
    expect(h.api.deleteNotification).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused' }));
  });

  it('treats DELETE result:false as a business failure and pauses with the processed message retained', async () => {
    const h = harness();
    h.api.receiveNotification.mockResolvedValue(receipt());
    h.api.deleteNotification.mockResolvedValue(false);
    await h.run();
    expect(h.onNotification).toHaveBeenCalledTimes(1);
    expect(h.api.deleteNotification).toHaveBeenCalledTimes(1);
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(1);
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused' }));
  });

  it('retries a failed ACK three times with bounded backoff and never reprocesses its message', async () => {
    const h = harness();
    h.api.receiveNotification.mockResolvedValue(receipt());
    h.api.deleteNotification.mockRejectedValue(new GreenApiError('synthetic network', { kind: 'network' }));
    await h.run();
    expect(h.api.deleteNotification).toHaveBeenCalledTimes(3);
    expect(h.delay.mock.calls.map(call => call[0])).toEqual([1000, 2000]);
    expect(h.onNotification).toHaveBeenCalledTimes(1);
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(1);
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused', message: expect.stringContaining('трёх') }));
  });

  it('recovers from an ACK network error without another receive or duplicate processing', async () => {
    const h = harness();
    h.api.receiveNotification.mockResolvedValueOnce(receipt()).mockImplementationOnce(h.finishReceive);
    h.api.deleteNotification.mockRejectedValueOnce(new GreenApiError('network', { kind: 'network' })).mockResolvedValueOnce(true);
    await h.run();
    expect(h.onNotification).toHaveBeenCalledTimes(1);
    expect(h.api.deleteNotification).toHaveBeenCalledTimes(2);
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(2);
    expect(h.delay).toHaveBeenCalledExactlyOnceWith(1000, h.controller.signal);
  });

  it('deduplicates an already-rendered message after a paused consumer is restarted', async () => {
    let state = createInitialChatState();
    const first = harness();
    first.onNotification.mockImplementation(event => { state = chatReducer(state, { type: 'notification', event }); });
    first.api.receiveNotification.mockResolvedValue(receipt());
    first.api.deleteNotification.mockResolvedValue(false);
    await first.run();
    const restarted = harness();
    restarted.onNotification.mockImplementation(event => { state = chatReducer(state, { type: 'notification', event }); });
    restarted.api.receiveNotification.mockResolvedValueOnce(receipt()).mockImplementationOnce(restarted.finishReceive);
    await restarted.run();
    expect(state.chats[0].messages).toHaveLength(1);
    expect(restarted.api.deleteNotification).toHaveBeenCalledTimes(1);
  });

  it('caps receive backoff and resets it after a successful receive', async () => {
    const h = harness();
    const failure = new GreenApiError('offline', { kind: 'network' });
    for (let attempt = 0; attempt < 6; attempt += 1) h.api.receiveNotification.mockRejectedValueOnce(failure);
    h.api.receiveNotification.mockResolvedValueOnce(receipt()).mockRejectedValueOnce(failure).mockImplementationOnce(h.finishReceive);
    await h.run();
    expect(h.delay.mock.calls.map(call => call[0])).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 1000]);
  });

  it.each(['receive', 'delete'] as const)('honors Retry-After for 429 on %s', async operation => {
    const h = harness();
    const throttled = new GreenApiError('throttled', { kind: 'http', status: 429, retryAfterMs: 6000 });
    if (operation === 'receive') h.api.receiveNotification.mockRejectedValueOnce(throttled).mockImplementationOnce(h.finishReceive);
    else {
      h.api.receiveNotification.mockResolvedValueOnce(receipt()).mockImplementationOnce(h.finishReceive);
      h.api.deleteNotification.mockRejectedValueOnce(throttled).mockResolvedValueOnce(true);
    }
    await h.run();
    expect(h.delay).toHaveBeenCalledExactlyOnceWith(6000, h.controller.signal);
  });

  it.each([401, 403])('stops on receive authorization error %i without retry', async code => {
    const h = harness();
    h.api.receiveNotification.mockRejectedValue(new GreenApiError('access denied', { kind: 'http', status: code }));
    await h.run();
    expect(h.delay).not.toHaveBeenCalled();
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(1);
    expect(h.onStatus).toHaveBeenLastCalledWith({ phase: 'stopped', message: 'access denied' });
  });

  it('stops on ACK authorization error without receiving another notification', async () => {
    const h = harness();
    h.api.receiveNotification.mockResolvedValue(receipt());
    h.api.deleteNotification.mockRejectedValue(new GreenApiError('access denied', { kind: 'http', status: 401 }));
    await h.run();
    expect(h.api.deleteNotification).toHaveBeenCalledTimes(1);
    expect(h.delay).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'stopped' }));
  });

  it('pauses on an invalid receipt response without retry or DELETE', async () => {
    const h = harness();
    h.api.receiveNotification.mockRejectedValue(new GreenApiError('bad receipt', { kind: 'format' }));
    await h.run();
    expect(h.api.deleteNotification).not.toHaveBeenCalled();
    expect(h.delay).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused', message: expect.stringContaining('bad receipt') }));
  });

  it('ACKs a state loss event and then stops consumption', async () => {
    const h = harness();
    h.api.getStateInstance.mockResolvedValue('notAuthorized');
    h.api.receiveNotification.mockResolvedValue(receipt(1, { typeWebhook: 'stateInstanceChanged', stateInstance: 'notAuthorized' }));
    await h.run();
    expect(h.onNotification).toHaveBeenCalledWith({ kind: 'state', state: 'notAuthorized' });
    expect(h.api.deleteNotification).toHaveBeenCalledTimes(1);
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(1);
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'stopped' }));
  });

  // В FIFO может лежать старое событие отключения: актуальная авторизация важнее него.
  it.each(['notAuthorized', 'starting'])('does not stop an authorized instance on a stale queued %s event', async stateInstance => {
    const h = harness();
    h.api.getStateInstance.mockResolvedValue('authorized');
    h.api.receiveNotification
      .mockResolvedValueOnce(receipt(1, { typeWebhook: 'stateInstanceChanged', stateInstance }))
      .mockResolvedValueOnce(receipt(2, { typeWebhook: 'stateInstanceChanged', stateInstance: 'authorized' }))
      .mockResolvedValueOnce(receipt(3, incomingBody({ id: 'after-reconnect', text: 'Актуальный ответ' })))
      .mockImplementationOnce(h.finishReceive);
    await h.run();
    expect(h.api.getStateInstance).toHaveBeenCalledTimes(1);
    expect(h.api.deleteNotification.mock.calls.map(call => call[0])).toEqual([1, 2, 3]);
    expect(h.onNotification).toHaveBeenCalledWith(expect.objectContaining({ kind: 'incoming' }));
    expect(h.onStatus.mock.calls.some(([value]) => value.phase === 'stopped')).toBe(false);
  });

  // Постоянная ошибка запроса требует исправления настроек, а не вечного backoff.
  it.each([400, 404])('pauses permanent receive HTTP %i without automatically repeating it', async code => {
    const h = harness();
    h.api.receiveNotification
      .mockRejectedValueOnce(new GreenApiError('permanent request error', { kind: 'http', status: code }))
      .mockImplementationOnce(h.finishReceive);
    await h.run();
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(1);
    expect(h.delay).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: expect.stringMatching(/^(paused|stopped)$/) }));
  });

  it.each([400, 404])('pauses permanent ACK HTTP %i without retrying DELETE or taking the next receipt', async code => {
    const h = harness();
    h.api.receiveNotification.mockResolvedValue(receipt());
    h.api.deleteNotification.mockRejectedValue(new GreenApiError('permanent ACK error', { kind: 'http', status: code }));
    await h.run();
    expect(h.onNotification).toHaveBeenCalledTimes(1);
    expect(h.api.deleteNotification).toHaveBeenCalledTimes(1);
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(1);
    expect(h.delay).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused' }));
  });

  it.each([408, 500])('still retries transient HTTP %i for receive and ACK', async code => {
    const h = harness();
    const error = new GreenApiError('transient server error', { kind: 'http', status: code });
    h.api.receiveNotification.mockRejectedValueOnce(error).mockResolvedValueOnce(receipt()).mockImplementationOnce(h.finishReceive);
    h.api.deleteNotification.mockRejectedValueOnce(error).mockResolvedValueOnce(true);
    await h.run();
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(3);
    expect(h.api.deleteNotification).toHaveBeenCalledTimes(2);
    expect(h.onNotification).toHaveBeenCalledTimes(1);
    expect(h.delay.mock.calls.map(call => call[0])).toEqual([1000, 1000]);
  });

  it.each([
    [new GreenApiError('auth', { kind: 'http', status: 401 }), 'stopped'],
    [new GreenApiError('offline', { kind: 'network' }), 'paused'],
  ] as const)('does not consume the next receipt when current authorization cannot be verified (%s)', async (error, phase) => {
    const h = harness();
    h.api.receiveNotification.mockResolvedValue(receipt(1, { typeWebhook: 'stateInstanceChanged', stateInstance: 'notAuthorized' }));
    h.api.getStateInstance.mockRejectedValue(error);
    await h.run();
    expect(h.api.deleteNotification).toHaveBeenCalledExactlyOnceWith(1, h.controller.signal);
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(1);
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase }));
  });

  it('ACKs the queued state before checking authorization and ignores a late state result after logout', async () => {
    const h = harness();
    const ack = deferred<boolean>();
    const current = deferred<string>();
    h.api.receiveNotification.mockResolvedValue(receipt(1, { typeWebhook: 'stateInstanceChanged', stateInstance: 'notAuthorized' }));
    h.api.deleteNotification.mockReturnValue(ack.promise);
    h.api.getStateInstance.mockReturnValue(current.promise);
    const pending = h.run();
    await flushPromises();
    expect(h.api.getStateInstance).not.toHaveBeenCalled();
    ack.resolve(true);
    await flushPromises();
    expect(h.api.getStateInstance).toHaveBeenCalledExactlyOnceWith(h.controller.signal);
    h.controller.abort();
    current.resolve('notAuthorized');
    await pending;
    expect(h.onStatus.mock.calls.some(([value]) => value.phase === 'stopped')).toBe(false);
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(1);
  });

  it('ignores a receive that finishes after abort', async () => {
    const h = harness();
    const late = deferred<ReturnType<typeof receipt>>();
    h.api.receiveNotification.mockReturnValue(late.promise);
    const pending = h.run();
    h.controller.abort();
    late.resolve(receipt());
    await pending;
    expect(h.onNotification).not.toHaveBeenCalled();
    expect(h.api.deleteNotification).not.toHaveBeenCalled();
  });

  it('does not start ACK if the application aborts while processing the receipt', async () => {
    const h = harness();
    h.api.receiveNotification.mockResolvedValue(receipt());
    h.onNotification.mockImplementation(() => { h.controller.abort(); });
    await h.run();
    expect(h.api.deleteNotification).not.toHaveBeenCalled();
  });

  it('does not emit an obsolete failure after an ACK completes following abort', async () => {
    const h = harness();
    const late = deferred<boolean>();
    h.api.receiveNotification.mockResolvedValue(receipt());
    h.api.deleteNotification.mockReturnValue(late.promise);
    const pending = h.run();
    await flushPromises();
    h.controller.abort();
    late.resolve(false);
    await pending;
    expect(h.onStatus.mock.calls.some(([value]) => value.phase === 'paused')).toBe(false);
    expect(h.api.receiveNotification).toHaveBeenCalledTimes(1);
  });
});

describe('abortable timer and single consumer lock', () => {
  // Браузер ограничивает один setTimeout signed32; длинный Retry-After не должен стать 1 мс.
  it('does not collapse a large Retry-After delay to an immediate timeout and remains abortable', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finished = false;
    const pending = abortableDelay(2_592_000_000, controller.signal).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(finished).toBe(false);
    controller.abort();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits the complete oversized duration rather than stopping after its first safe chunk', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finished = false;
    const pending = abortableDelay(2_147_483_657, controller.signal).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(9);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(finished).toBe(true);
  });

  it('completes delay at its boundary, and clears a pending timer on abort', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finished = false;
    const first = abortableDelay(1000, controller.signal).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    const second = abortableDelay(20_000, controller.signal);
    controller.abort();
    await second;
    expect(vi.getTimerCount()).toBe(0);
    await abortableDelay(1000, controller.signal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('blocks a second tab/StrictMode consumer and releases the lock when the first finishes', async () => {
    const manager = makeLockManager();
    const locks = manager as unknown as Pick<LockManager, 'request'>;
    const signal = new AbortController().signal;
    const hold = deferred<void>();
    const firstRun = vi.fn(() => hold.promise);
    const first = runWithConsumerLock({ instanceId: '4100000000', signal, onStatus: vi.fn(), run: firstRun, locks });
    await flushPromises();
    const blockedStatus = vi.fn();
    const blockedRun = vi.fn();
    await runWithConsumerLock({ instanceId: '4100000000', signal, onStatus: blockedStatus, run: blockedRun, locks });
    expect(blockedRun).not.toHaveBeenCalled();
    expect(blockedStatus).toHaveBeenCalledWith(expect.objectContaining({ phase: 'blocked' }));
    expect([...manager.held]).toEqual(['green-api:telegram:4100000000']);
    hold.resolve();
    await first;
    const thirdRun = vi.fn(async () => {});
    await runWithConsumerLock({ instanceId: '4100000000', signal, onStatus: vi.fn(), run: thirdRun, locks });
    expect(thirdRun).toHaveBeenCalledTimes(1);
    expect(manager.held.size).toBe(0);
  });

  it('keeps independent instance queues independently consumable', async () => {
    const manager = makeLockManager();
    const locks = manager as unknown as Pick<LockManager, 'request'>;
    const signal = new AbortController().signal;
    const hold = deferred<void>();
    const first = runWithConsumerLock({ instanceId: '1', signal, onStatus: vi.fn(), run: () => hold.promise, locks });
    const secondRun = vi.fn(async () => {});
    await runWithConsumerLock({ instanceId: '2', signal, onStatus: vi.fn(), run: secondRun, locks });
    expect(secondRun).toHaveBeenCalledTimes(1);
    hold.resolve();
    await first;
  });

  it('fails closed without Web Locks instead of creating competing queue consumers', async () => {
    const onStatus = vi.fn();
    const run = vi.fn();
    await runWithConsumerLock({ instanceId: '1', signal: new AbortController().signal, onStatus, run, locks: null });
    expect(run).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ phase: 'unsupported' }));
  });

  it('does not acquire a lock after pre-abort and sanitizes lock-manager errors', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn().mockRejectedValue(new Error('synthetic-token-for-tests-only'));
    const locks = { request } as unknown as Pick<LockManager, 'request'>;
    const run = vi.fn();
    const onStatus = vi.fn();
    await runWithConsumerLock({ instanceId: '1', signal: controller.signal, onStatus, run, locks });
    expect(request).not.toHaveBeenCalled();
    await runWithConsumerLock({ instanceId: '1', signal: new AbortController().signal, onStatus, run, locks });
    expect(run).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ phase: 'stopped', message: expect.not.stringContaining('synthetic-token') }));
  });
});
