import { describe, expect, it, vi } from 'vitest';
import {
  createGreenApiClient, DEFAULT_API_URL, GreenApiError, isAuthorizationError,
  MESSAGE_LENGTH_LIMIT, normalizeApiUrl, validateCredentials,
} from '../src/api/greenApi';
import { chatId, credentials, incomingBody, phone, settings } from './fixtures';

const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });

describe('API address and credentials boundary', () => {
  it('defaults to the Telegram cluster and normalizes the permitted HTTPS origin', () => {
    expect(DEFAULT_API_URL).toBe('https://4100.api.green-api.com');
    expect(normalizeApiUrl('  https://4100.api.green-api.com/  ')).toBe(DEFAULT_API_URL);
    expect(normalizeApiUrl('https://4101.api.green-api.com')).toBe('https://4101.api.green-api.com');
  });

  it.each([
    'http://4100.api.green-api.com', 'https://example.test', 'https://api.green-api.com',
    'https://4100.api.green-api.com.evil.test', 'https://evil.4100.api.green-api.com',
    'https://user:password@4100.api.green-api.com', 'https://4100.api.green-api.com:444',
    'https://4100.api.green-api.com/path', 'https://4100.api.green-api.com/?token=abc',
    'https://4100.api.green-api.com/#secret', '//4100.api.green-api.com', '',
  ])('rejects unsupported origin %j', input => {
    expect(() => normalizeApiUrl(input)).toThrow(GreenApiError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('trims credentials and retains an instance identifier as a string', () => {
    expect(validateCredentials({ ...credentials, idInstance: ' 900719925474099312345 ', apiTokenInstance: ' synthetic-token ' })).toEqual({
      ...credentials, idInstance: '900719925474099312345', apiTokenInstance: 'synthetic-token',
    });
  });

  it.each([
    { idInstance: '' }, { idInstance: '12x' }, { idInstance: '-1' },
    { apiTokenInstance: '' }, { apiTokenInstance: 'a b' }, { apiTokenInstance: 'a/b' },
    { apiTokenInstance: 'a?b' }, { apiTokenInstance: 'a#b' },
  ])('rejects invalid credentials %j', overrides => {
    expect(() => createGreenApiClient({ ...credentials, ...overrides })).toThrow(GreenApiError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('GREEN-API contract with a denied-by-default fetch mock', () => {
  it('issues a credential-free, noncached GET against the configured instance', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ stateInstance: 'authorized' }));
    expect(await createGreenApiClient(credentials).getStateInstance()).toBe('authorized');
    expect(fetch).toHaveBeenCalledWith(`${credentials.apiUrl}/waInstance${credentials.idInstance}/getStateInstance/${credentials.apiTokenInstance}`, expect.objectContaining({
      method: 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: expect.any(AbortSignal),
    }));
  });

  it.each([{}, null, [], { stateInstance: 42 }])('rejects malformed instance state %j', async body => {
    vi.mocked(fetch).mockResolvedValue(json(body));
    await expect(createGreenApiClient(credentials).getStateInstance()).rejects.toBeInstanceOf(GreenApiError);
  });

  it('reads settings including optional notification switches', async () => {
    vi.mocked(fetch).mockResolvedValue(json(settings));
    expect(await createGreenApiClient(credentials).getSettings()).toEqual(settings);
    vi.mocked(fetch).mockResolvedValue(json({ typeInstance: 'telegram', webhookUrl: '', incomingWebhook: 'yes' }));
    expect(await createGreenApiClient(credentials).getSettings()).toEqual({ ...settings, outgoingWebhook: null, stateWebhook: null });
  });

  it.each([{}, { ...settings, typeInstance: undefined }, { ...settings, incomingWebhook: true }, { ...settings, webhookUrl: null }])('rejects incomplete settings %j', async body => {
    vi.mocked(fetch).mockResolvedValue(json(body));
    await expect(createGreenApiClient(credentials).getSettings()).rejects.toBeInstanceOf(GreenApiError);
  });

  it('sends normalized phoneNumber as a JSON number and retains canonical chatId exactly', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ exist: true, chatId, fromCache: true }));
    expect(await createGreenApiClient(credentials).checkAccount('+7 (000) 000-00-01')).toEqual({ exist: true, chatId });
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/checkAccount/');
    expect(options).toMatchObject({ method: 'POST', body: JSON.stringify({ phoneNumber: Number(phone) }), headers: { 'Content-Type': 'application/json' } });
  });

  it('returns not-found without constructing a chat from the supplied phone', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ exist: false, chatId: '' }));
    expect(await createGreenApiClient(credentials).checkAccount(phone)).toEqual({ exist: false, chatId: null });
  });

  it.each([{ exist: true }, { exist: true, chatId: 123 }, { exist: true, chatId: ' ' }, { status: false, reason: 'instance is starting or not authorized' }])('rejects business failure/malformed CheckAccount %j despite HTTP 200', async body => {
    vi.mocked(fetch).mockResolvedValue(json(body));
    await expect(createGreenApiClient(credentials).checkAccount(phone)).rejects.toBeInstanceOf(GreenApiError);
  });

  it.each(['x', '0123456789'])('does not call CheckAccount for invalid phone %s', async input => {
    await expect(createGreenApiClient(credentials).checkAccount(input)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['A'.repeat(4095), 'Я'.repeat(4096), 'A'.repeat(4094) + '😀', '  Привет 😀\n<script>alert(1)</script>  '])('preserves valid text and Unicode exactly', async text => {
    vi.mocked(fetch).mockResolvedValue(json({ idMessage: 'synthetic-sent-id' }));
    expect(await createGreenApiClient(credentials).sendMessage(chatId, text)).toEqual({ idMessage: 'synthetic-sent-id' });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ chatId, message: text });
    expect(MESSAGE_LENGTH_LIMIT).toBe(4096);
  });

  it.each(['', ' \n\t ', 'A'.repeat(4097)])('rejects invalid message length before network', async text => {
    await expect(createGreenApiClient(credentials).sendMessage(chatId, text)).rejects.toMatchObject({ kind: 'validation' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not send without a chat and rejects an absent server message id', async () => {
    await expect(createGreenApiClient(credentials).sendMessage('', 'text')).rejects.toMatchObject({ kind: 'validation' });
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(json({}));
    await expect(createGreenApiClient(credentials).sendMessage(chatId, 'text')).rejects.toBeInstanceOf(GreenApiError);
  });

  it.each(['', '   ', 'null'])('treats empty receive %j as no notification, not an error', async body => {
    vi.mocked(fetch).mockResolvedValue(new Response(body));
    expect(await createGreenApiClient(credentials).receiveNotification()).toBeNull();
  });

  it('accepts a valid receipt without changing its body', async () => {
    const body = incomingBody();
    vi.mocked(fetch).mockResolvedValue(json({ receiptId: 3, body }));
    expect(await createGreenApiClient(credentials).receiveNotification()).toEqual({ receiptId: 3, body });
  });

  it.each([
    {}, { receiptId: '3', body: {} }, { receiptId: -1, body: {} },
    { receiptId: 0.5, body: {} }, { receiptId: Number.MAX_SAFE_INTEGER + 1, body: {} },
    { receiptId: 3 }, { receiptId: 3, body: [] }, { receiptId: 3, body: null },
  ])('rejects malformed receipt %j without a DELETE', async body => {
    vi.mocked(fetch).mockResolvedValue(json(body));
    await expect(createGreenApiClient(credentials).receiveNotification()).rejects.toMatchObject({ kind: 'format' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe('GET');
  });

  it.each([true, false])('distinguishes DELETE business result %s', async result => {
    vi.mocked(fetch).mockResolvedValue(json({ result, reason: result ? '' : 'already removed or wrong receipt' }));
    expect(await createGreenApiClient(credentials).deleteNotification(3)).toBe(result);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/deleteNotification/synthetic-token-for-tests-only/3'), expect.objectContaining({ method: 'DELETE' }));
  });

  it('rejects malformed ACK and invalid receipt before DELETE', async () => {
    const api = createGreenApiClient(credentials);
    await expect(api.deleteNotification(-1)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(json({ result: 'true' }));
    await expect(api.deleteNotification(3)).rejects.toBeInstanceOf(GreenApiError);
  });

  it.each([400, 401, 403, 429, 469, 500])('exposes status %i while hiding vendor error bodies and tokens', async status => {
    vi.mocked(fetch).mockResolvedValue(json({ secret: credentials.apiTokenInstance }, status));
    const error = await createGreenApiClient(credentials).getStateInstance().catch(value => value);
    expect(error).toBeInstanceOf(GreenApiError);
    expect(error.status).toBe(status);
    expect(error.message).not.toContain(credentials.apiTokenInstance);
    expect(isAuthorizationError(error)).toBe(status === 401 || status === 403);
  });

  it.each([['3', 3000], ['0', 1000], ['nonsense', null]])('parses Retry-After %j safely', async (header, expected) => {
    vi.mocked(fetch).mockResolvedValue(json({}, 429, { 'Retry-After': header }));
    await expect(createGreenApiClient(credentials).receiveNotification()).rejects.toMatchObject({ retryAfterMs: expected });
  });

  it('supports HTTP-date Retry-After', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    vi.mocked(fetch).mockResolvedValue(json({}, 429, { 'Retry-After': 'Tue, 01 Jan 2030 00:00:05 GMT' }));
    await expect(createGreenApiClient(credentials).receiveNotification()).rejects.toMatchObject({ retryAfterMs: 5000 });
  });

  it('never exposes an infinite retry duration after converting an oversized header to milliseconds', async () => {
    vi.mocked(fetch).mockResolvedValue(json({}, 429, { 'Retry-After': '1e308' }));
    const error = await createGreenApiClient(credentials).receiveNotification().catch(value => value);
    expect(error).toBeInstanceOf(GreenApiError);
    expect(error.retryAfterMs === null || Number.isFinite(error.retryAfterMs)).toBe(true);
  });

  it.each(['<html>upstream error</html>', '{broken'])('rejects malformed JSON %j', async body => {
    vi.mocked(fetch).mockResolvedValue(new Response(body));
    await expect(createGreenApiClient(credentials).getStateInstance()).rejects.toMatchObject({ kind: 'format' });
  });

  it('sanitizes network errors that contain an API URL and never automatically resends', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(`${credentials.apiUrl}/${credentials.apiTokenInstance}`));
    const error = await createGreenApiClient(credentials).sendMessage(chatId, 'text').catch(value => value);
    expect(error).toMatchObject({ kind: 'network' });
    expect(error.message).not.toContain(credentials.apiTokenInstance);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates user abort to fetch and cancels its request timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation((_input, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('synthetic abort', 'AbortError')), { once: true });
    }));
    const controller = new AbortController();
    const pending = createGreenApiClient(credentials).receiveNotification(controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds an unresponsive request without exposing the aborted fetch URL', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation((_input, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error(credentials.apiTokenInstance)), { once: true });
    }));
    const pending = createGreenApiClient(credentials).getStateInstance();
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'network' });
    await vi.advanceTimersByTimeAsync(35_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
