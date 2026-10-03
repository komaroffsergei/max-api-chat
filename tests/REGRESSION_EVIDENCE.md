# Регрессии финальной проверки — 3 октября 2026

Проверки используют синтетические ключи, номера и сообщения. HTTP-моки не обращаются к GREEN-API. Playwright запускает изолированный Chromium и Vite на `127.0.0.1:4187`, перехватывает API и блокирует неизвестный внешний трафик. Параметры одного дефекта считаются одним дефектом.

## Подтверждённые дефекты до исправления

| Дефект | Воспроизведение и наблюдение до исправления | Источник RED и проверка после исправления |
| --- | --- | --- |
| Новый черновик стирался после позднего ответа | Отправить текст A с задержанным ответом, изменить черновик на B и обратно на A. После ответа старой отправки поле становилось пустым. | Собственный Vitest RED: expected `Текст A`, received `''`. `App.test.tsx`: `A→B→A draft`. Теперь PASS; отправка выполнена один раз. |
| Старое состояние инстанса останавливало актуальный приём | Актуальное состояние authorized; в FIFO старое notAuthorized/starting, затем authorized и входящий текст. Приём заканчивался после первого ACK, актуальное состояние не запрашивалось. | Собственный Vitest RED в двух вариантах: ожидался один getStateInstance, получено ноль. `pollNotifications.test.ts`: `stale queued`. Теперь PASS; ACK всех трёх receipt и доставка текста. |
| Постоянная HTTP-ошибка повторялась бесконечно | ReceiveNotification возвращает 400 или 404. Запрос автоматически повторялся с растущим backoff, хотя изменение настроек требует действия пользователя. | Собственный Vitest RED в двух вариантах: ожидался один receive, получено два до тестового завершения. Reviewer отдельно наблюдал пять receive и delays 1000/2000/4000/8000/15000. `pollNotifications.test.ts`: `permanent receive` и `permanent ACK`. Теперь PASS; transient 408/429/500 продолжают повторяться. |
| Группа показывалась как личный получатель | Входящий senderData: chatId отрицательный, chatType supergroup, chatName «Тестовая команда», senderName «Алиса». Название чата было «Алиса», хотя ответ ушёл бы группе. | RED воспроизвёл reviewer локальными normalizer/reducer без API. `notifications.test.ts`, `chatState.test.ts`, `App.test.tsx`: группа имеет chatName или безопасное «Группа <id>», явный групповой контекст и тот же canonical chatId при ответе. PASS. |
| Resize скрывал последние сообщения | После 45 сообщений, при чтении низа, уменьшить окно 1440×900 до 1440×500. ScrollTop оставался 2518, видимая высота менялась с 711 до 311, зазор снизу становился 400; кнопка перехода вниз не появлялась. | RED воспроизвёл developer в настоящем Chromium с HTTP-моками. Независимый `e2e/chat.spec.ts`: `sticks to the latest`. Теперь PASS desktop/mobile для viewport и роста composer; чтение старой истории сохраняет scrollTop. |
| Длинный Retry-After переполнял таймер | 429 с Retry-After 2592000 секунд превращался в 2592000000 мс, больше предела одного setTimeout. Таймер срабатывал почти сразу. Дополнительно header `1e308` превращался в Infinity после умножения. | Переполнение таймера воспроизвёл reviewer; Infinity — собственный Vitest RED, finite/null assertion получил false. `greenApi.test.ts` и fake-timer проверки `pollNotifications.test.ts`: конечная длительность, полное ожидание частями и очистка при abort. PASS. Оба случая — один дефект обработки больших ожиданий. |
| Скрытый неверный API-адрес молча блокировал форму | Раскрыть дополнительные настройки, ввести `not-a-url`, свернуть их, заполнить id/token и подключиться. Native validation блокировала submit, ошибочное поле оставалось скрытым. | Собственный Playwright RED на desktop/mobile: API field expected visible, received hidden. `e2e/chat.spec.ts`: `invalid API server hidden`. Теперь PASS: поле раскрыто, сфокусировано, до исправления нет API-запросов; исправление URL позволяет подключиться. |
| Окончательная ошибка после потерянного SendMessage-ответа была невидимой | Клиент не получил idMessage, затем пришёл failed/noAccount с этим id. Статус оставался только pending, без сообщения или видимой ошибки чата, после ACK событие терялось для пользователя. | RED воспроизвёл reviewer локальным reducer. `chatState.test.ts`: `unmatched` в существующем и неизвестном чате. Теперь PASS: видимая ошибка без выдуманного текста, черновик сохранён, pending-статус применится к позднему ответу. |

## Прогоны тестировщика после исправлений

| Команда | Результат |
| --- | --- |
| `npx vitest run --config tests/vitest.config.ts tests/App.test.tsx tests/pollNotifications.test.ts tests/greenApi.test.ts tests/notifications.test.ts tests/chatState.test.ts` | 202/202 PASS, пять изменённых наборов, 8,21 с. |
| `npx playwright test --config tests/playwright.config.ts` | 14/14 PASS, семь сценариев × desktop 1440×900/mobile 390×844, 44,3 с. Resize также проверяет высоты 480 и 700. |
| `npx eslint tests` | PASS. |
| `npx tsc --project tests/tsconfig.json --pretty false` | PASS. |

Перед исправлениями собственный targeted Vitest дал пять FAIL из 49: три разных дефекта (черновик, stale state, permanent 4xx). Дополнительный прогон дал отдельный Infinity RED. Targeted Playwright дал два FAIL из четырёх: один дефект hidden validation; resize был уже исправлен. После изменения контракта normalizer ожидаются поля chatName/isGroup; сравнение текста paused заменено на проверку причины и фазы. Эти два обновления тестовых ожиданий не считаются багами продукта.

## Покрытие и границы результата

- Подключение: поля, нормализация/allowlist API URL, instance/token, авторизация, Telegram settings, повторный клик, StrictMode и obsolete responses.
- Адресат: телефон, canonical строковый chatId без потери больших чисел, отсутствие аккаунта и business errors, private/group context, переход между чатами.
- Отправка: пустой/whitespace текст, 4095/4096/4097 и Unicode, Enter/Shift+Enter/IME, pending/double click, поздний ответ и черновики, неизвестный результат без auto-resend, logout/reconnect.
- Приём: text/extended/status/state, invalid dates/malformed/unsupported, FIFO и ACK после обработки, дедупликация, DELETE false/ошибки, auth/429/408/5xx/permanent 4xx, retry timings и abort, актуальное состояние после старого события.
- Интерфейс: названия/семантика элементов, обычный текст без исполнения HTML, статусы, мобильный список/чат/назад, реальная прокрутка, две вкладки с настоящими Web Locks, очистка сессии и отсутствие persistence.

Результат подтверждает приложение с контролируемыми HTTP-ответами, а не доступность провайдера. CORS настоящего GREEN-API, отправка и ответ настоящего Telegram-получателя, TLS/production, CI/CD и публикация GitHub проверяются отдельно владельцем выпуска. Настоящий мобильный браузер/экранная клавиатура и системный IME не воспроизводились: мобильные проверки используют эмуляцию Chromium, IME — composition events. Полная общая проверка Vitest/build/typecheck/lint после freeze остаётся единым release gate владельца выпуска.
