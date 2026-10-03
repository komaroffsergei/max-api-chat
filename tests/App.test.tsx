import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { chatId, credentials, deferred, incomingBody, makeLockManager, otherChatId, otherPhone, phone, receipt } from './fixtures';
import { mockGreenApi } from './mockGreenApi';

let api: ReturnType<typeof mockGreenApi>;

async function login() {
  fireEvent.change(screen.getByLabelText('idInstance'), { target: { value: credentials.idInstance } });
  fireEvent.change(screen.getByLabelText('apiTokenInstance'), { target: { value: credentials.apiTokenInstance } });
  await userEvent.click(screen.getByRole('button', { name: 'Подключиться' }));
}

async function connect() {
  await login();
  await screen.findByRole('textbox', { name: 'Номер телефона' });
  await screen.findByText('Подключено');
}

async function openChat(number = phone) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Номер телефона' }), { target: { value: number } });
  await userEvent.click(screen.getByRole('button', { name: 'Начать чат' }));
  await screen.findByRole('textbox', { name: 'Сообщение' });
}

beforeEach(() => {
  api = mockGreenApi();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: makeLockManager() });
});

describe('real React flow with a fully mocked HTTP boundary', () => {
  it('starts with a masked token, Telegram cluster, labels, and empty session', () => {
    render(<App />);
    expect(screen.getByLabelText('apiTokenInstance')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('API-сервер')).toHaveValue(credentials.apiUrl);
    expect(screen.getByLabelText('idInstance')).toHaveValue('');
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['not authorized', { stateInstance: 'notAuthorized' }, {}, /не авторизован/],
    ['wrong messenger', { stateInstance: 'authorized' }, { typeInstance: 'max' }, /работает с Telegram/],
    ['custom webhook', { stateInstance: 'authorized' }, { webhookUrl: 'https://example.test/hook' }, /webhookUrl/],
    ['incoming disabled', { stateInstance: 'authorized' }, { incomingWebhook: 'no' }, /incomingWebhook/],
  ])('rejects %s without changing instance settings or starting receive', async (_label, state, settings, error) => {
    api.state = state;
    Object.assign(api.settings, settings);
    render(<App />);
    await login();
    expect(await screen.findByRole('alert')).toHaveTextContent(error);
    expect(api.calls.some(call => call.method === 'receiveNotification' || call.method === 'setSettings')).toBe(false);
    expect(screen.queryByRole('textbox', { name: 'Номер телефона' })).not.toBeInTheDocument();
  });

  it('validates an edited API origin and malformed instance before fetching', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('API-сервер'), { target: { value: 'https://example.test' } });
    await login();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Адрес/);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('API-сервер'), { target: { value: credentials.apiUrl } });
    fireEvent.change(screen.getByLabelText('idInstance'), { target: { value: 'invalid-id' } });
    await userEvent.click(screen.getByRole('button', { name: 'Подключиться' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/idInstance/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('starts only one connection on repeated submit while the state request is pending', async () => {
    const pending = deferred<unknown>();
    api.getState.mockReturnValue(pending.promise);
    render(<App />);
    await login();
    fireEvent.submit(screen.getByLabelText('idInstance').closest('form')!);
    expect(api.getState).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('idInstance')).toBeDisabled();
    await act(async () => { pending.resolve({ stateInstance: 'authorized' }); });
    await screen.findByRole('textbox', { name: 'Номер телефона' });
  });

  it('creates by phone but sends to the canonical string chatId, with exact Unicode text', async () => {
    render(<App />);
    await connect();
    await openChat();
    const text = '  Привет 😀\n<script>alert(1)</script>  ';
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: text } });
    await userEvent.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(chatId, text));
    const message = await screen.findByRole('article', { name: 'Исходящее сообщение' });
    expect(message.querySelector('p')?.textContent).toBe(text);
    expect(within(message).getByLabelText('В очереди')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('');
    expect(document.querySelector('script')).toBeNull();
  });

  it('shows a not-found/privacy error without creating a chat and supports retry', async () => {
    api.checkAccount.mockResolvedValueOnce({ exist: false, chatId: '' });
    render(<App />);
    await connect();
    fireEvent.change(screen.getByRole('textbox', { name: 'Номер телефона' }), { target: { value: phone } });
    await userEvent.click(screen.getByRole('button', { name: 'Начать чат' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/скрыт.*Telegram/);
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).not.toBeInTheDocument();
    await openChat();
    expect(api.checkAccount).toHaveBeenCalledTimes(2);
  });

  it('deduplicates displayed replies while ACKing each FIFO receipt', async () => {
    render(<App />);
    await connect();
    await openChat();
    act(() => {
      api.push(receipt(1, incomingBody()));
      api.push(receipt(2, incomingBody()));
      api.push(receipt(3, incomingBody({ id: 'different-id', text: 'Второй ответ' })));
    });
    await waitFor(() => expect(screen.getAllByRole('article', { name: 'Входящее сообщение' })).toHaveLength(2));
    expect(api.deleteNotification.mock.calls.map(call => call[0])).toEqual([1, 2, 3]);
    expect(within(screen.getByRole('log')).getAllByText('Ответ для теста')).toHaveLength(1);
  });

  // Адресат группового ответа должен быть виден как группа, а не как имя её участника.
  it('labels a group recipient with chatName and group context rather than its senderName', async () => {
    render(<App />);
    await connect();
    const groupId = '-10000000000000';
    const body = incomingBody({ chat: groupId, senderName: 'Алиса', text: 'Сообщение в команде' });
    act(() => api.push(receipt(1, { ...body, senderData: { ...body.senderData, chatName: 'Тестовая команда', chatType: 'supergroup' } })));
    const row = await within(screen.getByRole('navigation', { name: 'Диалоги' })).findByRole('button');
    expect(row).toHaveTextContent('Тестовая команда');
    await userEvent.click(row);
    const header = screen.getByRole('heading', { level: 2 });
    expect(header).toHaveTextContent('Тестовая команда');
    expect(screen.getByRole('main')).toHaveTextContent(/групп/i);
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: 'Ответ команде' } });
    await userEvent.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(groupId, 'Ответ команде');
  });

  it('prevents double send and retains per-chat drafts when an old request finishes after switching', async () => {
    const pending = deferred<unknown>();
    api.sendMessage.mockReturnValue(pending.promise);
    render(<App />);
    await connect();
    await openChat();
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: 'Из чата A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    fireEvent.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    await openChat(otherPhone);
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: 'Черновик B' } });
    await act(async () => { pending.resolve({ idMessage: 'late-sent' }); });
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('Черновик B');
    expect(screen.queryByRole('article', { name: 'Исходящее сообщение' })).not.toBeInTheDocument();
    const row = within(screen.getByRole('navigation', { name: 'Диалоги' })).getByRole('button', { name: /00 01/ });
    await userEvent.click(row);
    expect(await screen.findByRole('article', { name: 'Исходящее сообщение' })).toHaveTextContent('Из чата A');
    expect(api.sendMessage.mock.calls[0][0]).not.toBe(otherChatId);
  });

  it('retains a newer draft when its earlier send completes', async () => {
    const pending = deferred<unknown>();
    api.sendMessage.mockReturnValue(pending.promise);
    render(<App />);
    await connect();
    await openChat();
    const input = screen.getByRole('textbox', { name: 'Сообщение' });
    fireEvent.change(input, { target: { value: 'Предыдущий текст' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    fireEvent.change(input, { target: { value: 'Новый черновик' } });
    await act(async () => { pending.resolve({ idMessage: 'late-sent' }); });
    expect(input).toHaveValue('Новый черновик');
  });

  // Совпадение текста не означает, что пользователь не создавал новый черновик.
  it('does not erase a newly edited A→B→A draft when the original A send completes', async () => {
    const pending = deferred<unknown>();
    api.sendMessage.mockReturnValue(pending.promise);
    render(<App />);
    await connect();
    await openChat();
    const input = screen.getByRole('textbox', { name: 'Сообщение' });
    fireEvent.change(input, { target: { value: 'Текст A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    fireEvent.change(input, { target: { value: 'Текст B' } });
    fireEvent.change(input, { target: { value: 'Текст A' } });
    await act(async () => { pending.resolve({ idMessage: 'late-original-A' }); });
    expect(input).toHaveValue('Текст A');
    expect(screen.getByRole('article', { name: 'Исходящее сообщение' })).toHaveTextContent('Текст A');
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores an old send after logout/reconnect, clears history, and never persists credentials/messages', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const pending = deferred<unknown>();
    api.sendMessage.mockReturnValue(pending.promise);
    render(<App />);
    await connect();
    await openChat();
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: 'Старый запрос' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    await userEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(screen.getByLabelText('apiTokenInstance')).toHaveValue('');
    await connect();
    await openChat();
    await act(async () => { pending.resolve({ idMessage: 'obsolete-id' }); });
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('shows an unknown send result and leaves the draft without automatic retry', async () => {
    api.sendMessage.mockRejectedValue(new Error(`synthetic network ${credentials.apiTokenInstance}`));
    render(<App />);
    await connect();
    await openChat();
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: 'Проверить в Telegram' } });
    await userEvent.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Результат отправки неизвестен/);
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('Проверить в Telegram');
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).not.toHaveTextContent(credentials.apiTokenInstance);
  });

  it.each([
    ['missing idMessage', {}],
    ['malformed JSON', new Response('{broken')],
    ['HTTP 500', new Response('{}', { status: 500 })],
  ])('shows an uncertain result for %s rather than inviting an automatic resend', async (_label, result) => {
    api.sendMessage.mockResolvedValue(result);
    render(<App />);
    await connect();
    await openChat();
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: 'Проверить результат' } });
    await userEvent.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Результат отправки неизвестен/);
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('Проверить результат');
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('starts a single consumer under StrictMode and cancels it on unmount', async () => {
    const { unmount } = render(<StrictMode><App /></StrictMode>);
    await connect();
    expect(api.maxPendingReceives).toBe(1);
    const receive = api.calls.find(call => call.method === 'receiveNotification');
    expect(receive?.signal?.aborted).toBe(false);
    unmount();
    expect(receive?.signal?.aborted).toBe(true);
  });
});
