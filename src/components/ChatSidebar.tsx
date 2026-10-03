import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Chat, PollingStatus } from '../types';
import { formatPhoneNumber } from '../phone';
import { Icon } from './Icon';

type Props = {
  chats: Chat[];
  activeChatId: string | null;
  idInstance: string;
  polling: PollingStatus;
  creatingChat: boolean;
  newChatError: string | null;
  onCreateChat: (phone: string) => Promise<boolean>;
  onSelectChat: (chatId: string) => void;
  onLogout: () => void;
  onRetry: () => void;
};

function chatTime(timestamp: number) {
  return new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

// Здесь пользователь открывает чат по номеру и переключается между диалогами.
export function ChatSidebar({ chats, activeChatId, idInstance, polling, creatingChat, newChatError, onCreateChat, onSelectChat, onLogout, onRetry }: Props) {
  const [phone, setPhone] = useState('');
  const sortedChats = [...chats].sort((left, right) => (right.messages.at(-1)?.timestamp ?? 0) - (left.messages.at(-1)?.timestamp ?? 0));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await onCreateChat(phone)) setPhone('');
  }

  return <aside className="chat-sidebar" aria-label="Список чатов">
    <header className="sidebar-header">
      <div className="sidebar-brand"><span className="brand-mark"><Icon name="telegram" /></span><span>Telegram</span></div>
      <button type="button" className="icon-button" onClick={onLogout} aria-label="Выйти" title="Выйти"><Icon name="logout" /></button>
    </header>
    <div className="sidebar-title"><h1>Чаты</h1><span className={`connection-dot ${polling.phase === 'listening' ? 'online' : ''}`} /><span className="sidebar-connection">{polling.phase === 'listening' ? 'Подключено' : polling.phase === 'starting' ? 'Подключаемся' : 'Приём приостановлен'}</span></div>
    {polling.message && <div className="sidebar-status" role="status"><p>{polling.message}</p>{(polling.phase === 'paused' || polling.phase === 'blocked') && <button type="button" onClick={onRetry}>Повторить приём</button>}</div>}
    <form className="new-chat-form" onSubmit={event => { void submit(event); }} aria-label="Новый чат">
      <label className="sr-only" htmlFor="new-chat-phone">Номер телефона</label>
      <div className="phone-field"><input id="new-chat-phone" name="phone" type="tel" value={phone} onChange={event => setPhone(event.target.value)} autoComplete="off" placeholder="Номер с кодом страны" disabled={creatingChat} /><button type="submit" aria-label="Начать чат" title="Начать чат" disabled={creatingChat || !phone.trim()}>{creatingChat ? <span className="spinner" /> : <Icon name="plus" />}</button></div>
      {newChatError && <p className="form-error" role="alert">{newChatError}</p>}
    </form>
    <nav className="chat-list" aria-label="Диалоги">
      {sortedChats.length === 0 ? <div className="sidebar-empty"><Icon name="message" /><p>Здесь будут ваши чаты</p><span>Введите номер телефона,<br />чтобы начать разговор.</span></div> : sortedChats.map(chat => {
        const lastMessage = chat.messages.at(-1);
        return <button type="button" key={chat.id} className={`chat-row ${activeChatId === chat.id ? 'selected' : ''}`} aria-current={activeChatId === chat.id ? 'page' : undefined} onClick={() => onSelectChat(chat.id)}>
          <span className="chat-avatar">{chat.phone ? chat.phone.slice(-2) : chat.title.slice(0, 2).toUpperCase()}</span>
          <span className="chat-row-content"><span className="chat-row-top"><span className="chat-row-title">{chat.phone ? formatPhoneNumber(chat.phone) : chat.title}</span>{lastMessage && <time dateTime={new Date(lastMessage.timestamp).toISOString()}>{chatTime(lastMessage.timestamp)}</time>}</span><span className="chat-row-preview">{chat.draft ? <><span className="draft-label">Черновик: </span>{chat.draft}</> : lastMessage ? `${lastMessage.direction === 'outgoing' ? 'Вы: ' : ''}${lastMessage.text}` : 'Начните переписку'}</span></span>
        </button>;
      })}
    </nav>
    {/* Справка не уводит из подключённого чата: всё состояние хранится в памяти. */}
    <a className="sidebar-guide" href="/guide.html" target="_blank" rel="noopener noreferrer">Как пользоваться <span aria-hidden="true">↗</span></a>
    <footer className="sidebar-footer"><span className="account-avatar">TG</span><div><strong>Telegram-инстанс</strong><span>{idInstance}</span></div><span className="footer-lock">Только в этой вкладке</span></footer>
  </aside>;
}
