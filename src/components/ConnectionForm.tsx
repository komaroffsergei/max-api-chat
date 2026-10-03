import { useState } from 'react';
import type { FormEvent } from 'react';
import { DEFAULT_API_URL } from '../api/greenApi';
import type { Credentials } from '../types';
import { Icon } from './Icon';

type Props = {
  connecting: boolean;
  error: string | null;
  onConnect: (credentials: Credentials) => Promise<void>;
};

// Собираем данные инстанса и показываем результат проверки подключения.
export function ConnectionForm({ connecting, error, onConnect }: Props) {
  const [idInstance, setIdInstance] = useState('');
  const [apiTokenInstance, setApiTokenInstance] = useState('');
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onConnect({ idInstance, apiTokenInstance, apiUrl });
  }

  function showInvalidApiField(event: FormEvent<HTMLInputElement>) {
    // Браузер не может показать ошибку в поле, скрытом закрытыми настройками.
    const options = event.currentTarget.closest('details');
    if (options) options.open = true;
    event.currentTarget.focus();
  }

  return <main className="connection-page">
    <div className="connection-brand"><span className="brand-mark"><Icon name="telegram" /></span><span>Telegram</span></div>
    <section className="connection-panel" aria-labelledby="connection-title">
      <div className="connection-illustration"><Icon name="telegram" /></div>
      <h1 id="connection-title">Telegram-чат</h1>
      <p className="connection-description">Данные инстанса из кабинета GREEN-API</p>
      <form onSubmit={submit} className="connection-form" autoComplete="off">
        <label htmlFor="instance-id">idInstance</label>
        <input id="instance-id" name="idInstance" inputMode="numeric" autoComplete="off" required value={idInstance} onChange={event => setIdInstance(event.target.value)} placeholder="Из личного кабинета GREEN-API" disabled={connecting} />
        <label htmlFor="instance-token">apiTokenInstance</label>
        <input id="instance-token" name="apiTokenInstance" type="password" autoComplete="off" required value={apiTokenInstance} onChange={event => setApiTokenInstance(event.target.value)} placeholder="Токен вашего инстанса" disabled={connecting} />
        <details className="api-options">
          <summary>Дополнительные настройки</summary>
          <label htmlFor="api-url">API-сервер</label>
          <input id="api-url" name="apiUrl" type="url" autoComplete="off" required value={apiUrl} onChange={event => setApiUrl(event.target.value)} onInvalid={showInvalidApiField} disabled={connecting} aria-describedby="api-help" />
          <p id="api-help">Адрес API из вашего личного кабинета.</p>
        </details>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button connection-submit" type="submit" disabled={connecting}>{connecting ? <><span className="spinner" /> Подключаемся…</> : 'Подключиться'}</button>
      </form>
      <p className="connection-privacy">Ключи и переписка остаются в памяти этой вкладки.<br />При выходе или обновлении страницы они исчезнут.</p>
    </section>
    {/* Открываем инструкцию отдельно: переход в этой вкладке очистил бы сессию. */}
    <footer className="connection-footer"><span>Простой чат через GREEN-API</span><a href="/guide.html" target="_blank" rel="noopener noreferrer">Как пользоваться ↗</a><a href="/local-run.html" target="_blank" rel="noopener noreferrer">Локальный запуск ↗</a></footer>
  </main>;
}
