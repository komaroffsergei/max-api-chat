import { useLayoutEffect, useRef, useState } from 'react';
import type { Message, MessageStatus } from '../types';
import { Icon } from './Icon';

const statusText: Record<MessageStatus, string> = {
  queued: 'В очереди', sent: 'Отправлено', delivered: 'Доставлено', read: 'Прочитано', failed: 'Не отправлено', noAccount: 'Ошибка получателя',
};

function time(timestamp: number): string {
  return new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function date(timestamp: number): string {
  const today = new Date();
  const messageDate = new Date(timestamp);
  if (today.toDateString() === messageDate.toDateString()) return 'Сегодня';
  return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' }).format(timestamp);
}

// Новые сообщения прокручиваем только если пользователь уже читает низ списка.
export function MessageList({ chatId, messages }: { chatId: string; messages: Message[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  const previousChatRef = useRef<string | null>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (previousChatRef.current !== chatId || atBottomRef.current) {
      list.scrollTop = list.scrollHeight;
      atBottomRef.current = true;
      setShowJump(false);
    }
    previousChatRef.current = chatId;
  }, [chatId, messages]);

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    atBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    setShowJump(!atBottomRef.current);
  }

  function jumpToBottom() {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  }

  return <div className="message-list-region">
    <div className="message-list" ref={listRef} onScroll={onScroll} role="log" aria-label="Сообщения" aria-live="polite" aria-relevant="additions">
      {messages.length === 0 ? <div className="conversation-empty"><span className="empty-message-icon"><Icon name="message" /></span><h2>Начните разговор</h2><p>Напишите первое сообщение.<br />Ответ появится здесь.</p></div> : messages.map((message, index) => {
        const day = date(message.timestamp);
        const needsDay = index === 0 || date(messages[index - 1].timestamp) !== day;
        const isError = message.status === 'failed' || message.status === 'noAccount';
        return <div className="message-group" key={message.id}>
          {needsDay && <div className="day-divider"><span>{day}</span></div>}
          <article className={`message-bubble ${message.direction}`} aria-label={`${message.direction === 'outgoing' ? 'Исходящее' : 'Входящее'} сообщение`}>
            <p>{message.text}</p>
            <div className={`message-meta ${isError ? 'message-failed' : ''}`}>
              {message.direction === 'outgoing' && message.status && <span className={`message-status ${message.status}`} aria-label={statusText[message.status]} title={statusText[message.status]}>{message.status === 'queued' ? 'В очереди' : isError ? <><Icon name="alert" />{statusText[message.status]}</> : <Icon name={message.status === 'sent' ? 'check' : 'doubleCheck'} />}</span>}
              <time dateTime={new Date(message.timestamp).toISOString()}>{time(message.timestamp)}</time>
            </div>
          </article>
        </div>;
      })}
    </div>
    {showJump && <button type="button" className="jump-button" onClick={jumpToBottom} aria-label="К новым сообщениям"><Icon name="arrowDown" /></button>}
  </div>;
}
