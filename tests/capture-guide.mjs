import { mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout } from 'node:timers';
import console from 'node:console';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

// Снимаем настоящий интерфейс на вымышленных данных. Запросы к провайдеру перехвачены.
// Скрипт нужен только для картинок инструкции, в production-сборку не попадает.
const origin = 'http://127.0.0.1:4193';
const images = fileURLToPath(new URL('../public/guide/images/', import.meta.url));
const queue = [];
const chatId = 'guide-chat-001';
const phone = '70000000001';
const apiSettings = { typeInstance: 'telegram', webhookUrl: '', incomingWebhook: 'yes', outgoingWebhook: 'yes', stateWebhook: 'yes' };
await mkdir(images, { recursive: true });
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4193, strictPort: true } });
let browser;

try {
  await server.listen();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1120, height: 900 }, serviceWorkers: 'block' });

  // Наружу ничего не отправляем. Даже не предусмотренный здесь метод прерывается.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) { await route.continue(); return; }
    if (!/^\d+\.api\.green-api\.com$/.test(url.hostname)) { await route.abort(); return; }
    const parts = url.pathname.split('/');
    let data;
    switch (parts[2]) {
      case 'getStateInstance': data = { stateInstance: 'authorized' }; break;
      case 'getSettings': data = apiSettings; break;
      case 'checkAccount': data = { exist: true, chatId }; break;
      case 'sendMessage': data = { idMessage: 'guide-sent-001' }; break;
      case 'receiveNotification':
        await new Promise(resolve => setTimeout(resolve, 100));
        data = queue[0] ?? null;
        break;
      case 'deleteNotification':
        if (queue[0]?.receiptId === Number(parts[4])) queue.shift();
        data = { result: true };
        break;
      default: await route.abort(); return;
    }
    // При закрытии браузера последний long poll может быть уже отменён.
    try { await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) }); }
    catch (error) { if (!/closed|cancel|interception/i.test(String(error))) throw error; }
  });

  const page = await context.newPage();
  await page.goto(origin);
  await page.getByLabel('idInstance', { exact: true }).fill('4100000000');
  await page.getByLabel('apiTokenInstance', { exact: true }).fill('guide-example-not-a-real-key');
  const form = page.locator('.connection-panel');
  const formBounds = await form.boundingBox();
  await form.screenshot({ path: `${images}/connect.jpg`, type: 'jpeg', quality: 88 });

  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await page.getByRole('textbox', { name: 'Номер телефона', exact: true }).fill(phone);
  await page.getByRole('button', { name: 'Начать чат', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await draft.fill('Привет. Во сколько завтра встречаемся?');
  await page.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Исходящее сообщение' })).toHaveCount(1);

  // Ответ и статус нужны только для снимка; это не доказательство живой доставки.
  queue.push({ receiptId: 1, body: {
    typeWebhook: 'incomingMessageReceived', idMessage: 'guide-reply-001', timestamp: Math.floor(Date.now() / 1000),
    senderData: { chatId, senderName: 'Пример переписки' },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Привет. Давай в 12.' } },
  } }, { receiptId: 2, body: { typeWebhook: 'outgoingMessageStatus', chatId, idMessage: 'guide-sent-001', status: 'read' } });
  await expect(page.getByRole('article', { name: 'Входящее сообщение' })).toHaveCount(1);
  await expect(page.locator('.message-status')).toHaveAttribute('aria-label', 'Прочитано');
  await page.setViewportSize({ width: 1120, height: 720 });
  await page.screenshot({ path: `${images}/chat.jpg`, type: 'jpeg', quality: 88 });

  // Список и переписка на телефоне — разные экраны, как в самом приложении.
  await page.setViewportSize({ width: 390, height: 844 });
  if (!await page.getByRole('button', { name: 'Назад к чатам' }).isVisible()) {
    await page.getByRole('navigation', { name: 'Диалоги' }).getByRole('button').click();
  }
  await expect(page.getByRole('button', { name: 'Назад к чатам' })).toBeVisible();
  await page.screenshot({ path: `${images}/mobile.jpg`, type: 'jpeg', quality: 88 });
  console.log(JSON.stringify({ form: { width: Math.round(formBounds.width), height: Math.round(formBounds.height) }, files: ['connect.jpg', 'chat.jpg', 'mobile.jpg'] }));
} finally {
  await browser?.close();
  await server.close();
}
