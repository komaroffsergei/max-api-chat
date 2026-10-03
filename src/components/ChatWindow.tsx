import type { Chat, PollingStatus } from '../types';
import { formatPhoneNumber } from '../phone';
import { Icon } from './Icon';
import { MessageList } from './MessageList';
import { MessageComposer } from './MessageComposer';

type Props = {
  chat: Chat | null;
  polling: PollingStatus;
  hints: string[];
  sending: boolean;
  canSend: boolean;
  onBack: () => void;
  onRetry: () => void;
  onDraftChange: (text: string) => void;
  onSend: () => Promise<void>;
};

// Собираем выбранный диалог и оставляем ошибки приёма рядом с перепиской.
export function ChatWindow({ chat, polling, hints, sending, canSend, onBack, onRetry, onDraftChange, onSend }: Props) {
  const canRetry = polling.phase === 'paused' || polling.phase === 'blocked';

  return <main className="chat-window">
    <header className="chat-header">
      {chat ? <><button type="button" className="icon-button mobile-back" aria-label="Назад к чатам" onClick={onBack}><Icon name="arrowLeft" /></button><span className="chat-avatar header-avatar">{chat.phone ? chat.phone.slice(-2) : chat.title.slice(0, 2).toUpperCase()}</span><div><h2>{chat.phone ? formatPhoneNumber(chat.phone) : chat.title}</h2><p>{chat.isGroup ? 'Групповой чат · Telegram' : 'Telegram'}</p></div></> : <div className="chat-header-empty"><span>Переписка</span><span>Telegram</span></div>}
    </header>
    {polling.message && <div className={`session-banner ${polling.phase === 'backoff' ? 'reconnecting' : ''}`} role="status"><Icon name="alert" /><p>{polling.message}</p>{canRetry && <button type="button" onClick={onRetry}>Повторить приём</button>}</div>}
    {chat ? <>
      <MessageList chatId={chat.id} messages={chat.messages} />
      {chat.error && <div className="chat-error" role="alert"><Icon name="alert" /><p>{chat.error}</p></div>}
      <MessageComposer draft={chat.draft} sending={sending} canSend={canSend} onDraftChange={onDraftChange} onSend={onSend} />
    </> : <div className="no-chat-selected"><span className="no-chat-icon"><Icon name="telegram" /></span><h2>Выберите чат</h2><p>Откройте чат слева или введите<br />номер телефона, чтобы начать новый.</p></div>}
    {hints.length > 0 && <details className="settings-hints"><summary>О статусах сообщений</summary>{hints.map(hint => <p key={hint}>{hint}</p>)}</details>}
  </main>;
}
