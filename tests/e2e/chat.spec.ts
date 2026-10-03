import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Route } from '@playwright/test';
import type { NotificationReceipt } from '../../src/types';
import { chatId, credentials, incomingBody, otherChatId, otherPhone, phone, receipt, settings } from '../fixtures';
import { formatPhoneNumber } from '../../src/phone';

const appOrigin = 'http://127.0.0.1:4187';

// Все запросы GREEN-API перехватываются; неизвестный внешний трафик блокируется.
// Очередь сохраняет головное уведомление до успешного DELETE, как в HTTP FIFO.
async function installMock(context: BrowserContext) {
  const mock = {
    queue: [] as NotificationReceipt[],
    calls: [] as { method: string; body: Record<string, unknown> | null }[],
    unexpectedExternal: [] as string[],
    sends: [] as { chatId: string; message: string }[],
    deleted: [] as number[],
    ackFalseOnce: false,
    sendFailure: false,
  };
  const fulfill = async (route: Route, body: unknown, status = 200) => {
    try {
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': appOrigin } });
    } catch (error) {
      if (!/closed|interception|canceled|cancelled/i.test(String(error))) throw error;
    }
  };
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === appOrigin) { await route.continue(); return; }
    if (!/^\d+\.api\.green-api\.com$/.test(url.hostname)) {
      mock.unexpectedExternal.push(`${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient');
      return;
    }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: {
        'Access-Control-Allow-Origin': appOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      } });
      return;
    }
    const parts = url.pathname.split('/');
    const method = parts[2];
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    mock.calls.push({ method, body });
    switch (method) {
      case 'getStateInstance': await fulfill(route, { stateInstance: 'authorized' }); break;
      case 'getSettings': await fulfill(route, settings); break;
      case 'checkAccount': await fulfill(route, { exist: true, chatId: String(body?.phoneNumber) === otherPhone ? otherChatId : chatId }); break;
      case 'sendMessage': {
        mock.sends.push({ chatId: String(body?.chatId), message: String(body?.message) });
        if (mock.sendFailure) await fulfill(route, { error: 'synthetic upstream failure' }, 500);
        else await fulfill(route, { idMessage: `browser-sent-${mock.sends.length}` });
        break;
      }
      case 'receiveNotification': {
        // Имитируем ожидание long polling; профиль не обращается к провайдеру.
        await new Promise(resolve => setTimeout(resolve, 100));
        await fulfill(route, mock.queue[0] ?? null);
        break;
      }
      case 'deleteNotification': {
        const id = Number(parts[4]);
        if (mock.ackFalseOnce) {
          mock.ackFalseOnce = false;
          await fulfill(route, { result: false, reason: 'synthetic ACK refusal' });
        } else if (mock.queue[0]?.receiptId === id) {
          mock.queue.shift();
          mock.deleted.push(id);
          await fulfill(route, { result: true, reason: '' });
        } else await fulfill(route, { result: false, reason: 'synthetic wrong receipt' });
        break;
      }
      default: {
        mock.unexpectedExternal.push(`${url.origin}/${method}`);
        await route.abort('blockedbyclient');
      }
    }
  });
  return mock;
}

async function login(page: Page) {
  await page.getByLabel('idInstance', { exact: true }).fill(credentials.idInstance);
  await page.getByLabel('apiTokenInstance', { exact: true }).fill(credentials.apiTokenInstance);
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Номер телефона', exact: true })).toBeVisible();
}

async function openChat(page: Page, number = phone) {
  const phoneInput = page.getByRole('textbox', { name: 'Номер телефона', exact: true });
  if (!await phoneInput.isVisible()) await page.getByRole('button', { name: 'Назад к чатам', exact: true }).click();
  await phoneInput.fill(number);
  await page.getByRole('button', { name: 'Начать чат', exact: true }).click();
  await expect(page.getByRole('heading', { name: formatPhoneNumber(number), exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toBeVisible();
}

test('mocked login → canonical chat → send → FIFO replies and dedup', async ({ page, context }, testInfo) => {
  const api = await installMock(context);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveTitle(/Telegram/);
  await login(page);
  await openChat(page);
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await input.fill('Привет 😀');
  await input.press('Shift+Enter');
  await input.press('End');
  await input.pressSequentially('Вторая строка');
  const submitted = await input.inputValue();
  await input.press('Enter');
  await expect(page.getByRole('article', { name: 'Исходящее сообщение', exact: true })).toHaveCount(1);
  expect(api.sends).toEqual([{ chatId, message: submitted }]);
  expect(submitted).toContain('\n');
  await expect(input).toHaveValue('');
  api.queue.push(
    receipt(1, incomingBody({ id: 'reply-A', text: 'Ответ A 😀' })),
    receipt(2, incomingBody({ id: 'reply-B', text: 'Ответ B\nhttps://example.test', extended: true })),
    receipt(3, incomingBody({ id: 'reply-B', text: 'Ответ B\nhttps://example.test', extended: true })),
    receipt(4, incomingBody({ id: 'reply-C', text: 'Ответ C' })),
  );
  const incoming = page.getByRole('article', { name: 'Входящее сообщение', exact: true });
  await expect(incoming).toHaveCount(3);
  await expect.poll(() => api.deleted).toEqual([1, 2, 3, 4]);
  await expect(incoming.nth(0)).toContainText('Ответ A 😀');
  await expect(incoming.nth(1)).toContainText('Ответ B');
  await expect(incoming.nth(2)).toContainText('Ответ C');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Назад к чатам', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Диалоги', exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: 'Диалоги' }).getByRole('button', { name: /00 01/ }).click();
    await expect(incoming).toHaveCount(3);
  }
  expect(api.unexpectedExternal).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('4096 boundary, empty draft, per-chat drafts and reload clear session', async ({ page, context }) => {
  const api = await installMock(context);
  await page.goto('/');
  await login(page);
  await openChat(page);
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  const send = page.getByRole('button', { name: 'Отправить сообщение', exact: true });
  await input.fill(' \n ');
  await expect(send).toBeDisabled();
  await input.fill('A'.repeat(4097));
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(send).toBeDisabled();
  await input.fill('A'.repeat(4094) + '😀');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(input).toHaveValue('');
  expect(api.sends[0].message).toBe('A'.repeat(4094) + '😀');
  await input.fill('Черновик A');
  await openChat(page, otherPhone);
  await input.fill('Черновик B');
  await openChat(page, phone);
  await expect(input).toHaveValue('Черновик A');
  expect(api.calls.filter(call => call.method === 'checkAccount')).toHaveLength(2);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.reload();
  await expect(page.getByLabel('idInstance', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('apiTokenInstance', { exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveCount(0);
  expect(api.unexpectedExternal).toEqual([]);
});

test('ACK false pauses and manual restart confirms duplicate without a second bubble', async ({ page, context }) => {
  const api = await installMock(context);
  await page.goto('/');
  await login(page);
  await openChat(page);
  api.ackFalseOnce = true;
  api.queue.push(receipt(1, incomingBody()));
  await expect(page.getByRole('article', { name: 'Входящее сообщение', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Повторить приём', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Отправить сообщение', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Повторить приём', exact: true }).click();
  await expect.poll(() => api.deleted).toEqual([1]);
  await expect(page.getByRole('article', { name: 'Входящее сообщение', exact: true })).toHaveCount(1);
  expect(api.unexpectedExternal).toEqual([]);
});

test('HTTP 500 send is explicitly uncertain and never automatically resent', async ({ page, context }) => {
  const api = await installMock(context);
  await page.goto('/');
  await login(page);
  await openChat(page);
  api.sendFailure = true;
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await input.fill('Проверить отправку в Telegram');
  await page.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Результат отправки неизвестен');
  await expect(input).toHaveValue('Проверить отправку в Telegram');
  await expect(page.getByRole('article')).toHaveCount(0);
  expect(api.sends).toHaveLength(1);
  expect(api.unexpectedExternal).toEqual([]);
});

test('native Web Locks permit one tab per instance and release on tab close', async ({ page, context }) => {
  const api = await installMock(context);
  await page.goto('/');
  await login(page);
  await openChat(page);
  const second = await context.newPage();
  await second.goto('/');
  await login(second);
  await openChat(second);
  await expect(second.getByRole('status')).toContainText('другой вкладке');
  const firstReceiveCount = api.calls.filter(call => call.method === 'receiveNotification').length;
  await page.close();
  await second.getByRole('button', { name: 'Повторить приём', exact: true }).click();
  await expect(second.getByRole('status')).toHaveCount(0);
  await expect.poll(() => api.calls.filter(call => call.method === 'receiveNotification').length).toBeGreaterThan(firstReceiveCount);
  api.queue.push(receipt(1, incomingBody({ text: 'Ответ в оставшейся вкладке' })));
  await expect(second.getByRole('article', { name: 'Входящее сообщение', exact: true })).toContainText('Ответ в оставшейся вкладке');
  expect(api.unexpectedExternal).toEqual([]);
});

test('invalid API server hidden in closed details is revealed before native validation blocks submission', async ({ page, context }) => {
  const api = await installMock(context);
  await page.goto('/');
  await page.getByText('Дополнительные настройки', { exact: true }).click();
  await page.getByLabel('API-сервер', { exact: true }).fill('not-a-url');
  await page.getByText('Дополнительные настройки', { exact: true }).click();
  await page.getByLabel('idInstance', { exact: true }).fill(credentials.idInstance);
  await page.getByLabel('apiTokenInstance', { exact: true }).fill(credentials.apiTokenInstance);
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await expect(page.getByLabel('API-сервер', { exact: true })).toBeVisible();
  await expect(page.getByLabel('API-сервер', { exact: true })).toBeFocused();
  expect(api.calls).toEqual([]);
  await page.getByLabel('API-сервер', { exact: true }).fill(credentials.apiUrl);
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Номер телефона', exact: true })).toBeVisible();
  expect(api.unexpectedExternal).toEqual([]);
});

// Проверяем настоящую геометрию браузера: ResizeObserver должен отличать низ списка от чтения истории.
test('sticks to the latest message across viewport and composer resize but preserves older reading position', async ({ page, context }, testInfo) => {
  const api = await installMock(context);
  await page.goto('/');
  await login(page);
  await openChat(page);
  for (let index = 0; index < 45; index += 1) {
    api.queue.push(receipt(index + 1, incomingBody({ id: `resize-${index}`, text: `Сообщение ${index + 1}: строка для проверки прокрутки` })));
  }
  const log = page.getByRole('log', { name: 'Сообщения', exact: true });
  const gap = () => log.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  await expect(page.getByRole('article', { name: 'Входящее сообщение', exact: true })).toHaveCount(45);
  await expect.poll(gap).toBeLessThan(2);
  const width = testInfo.project.name === 'mobile' ? 390 : 1440;
  await page.setViewportSize({ width, height: 480 });
  await expect.poll(gap).toBeLessThan(2);
  const composer = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await composer.fill('Черновик\n'.repeat(8));
  await expect.poll(gap).toBeLessThan(2);
  await log.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByRole('button', { name: 'К новым сообщениям', exact: true })).toBeVisible();
  await page.setViewportSize({ width, height: 700 });
  await composer.fill('Короткий черновик');
  api.queue.push(receipt(46, incomingBody({ id: 'while-reading', text: 'Новый ответ во время чтения истории' })));
  await expect(page.getByRole('article', { name: 'Входящее сообщение', exact: true })).toHaveCount(46);
  await expect.poll(() => log.evaluate(element => element.scrollTop)).toBe(0);
  await page.getByRole('button', { name: 'К новым сообщениям', exact: true }).click();
  await expect.poll(gap).toBeLessThan(2);
  expect(api.unexpectedExternal).toEqual([]);
});
