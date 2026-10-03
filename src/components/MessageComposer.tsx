import { useRef } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { MESSAGE_LENGTH_LIMIT } from '../api/greenApi';
import { Icon } from './Icon';

type Props = {
  draft: string;
  sending: boolean;
  canSend: boolean;
  onDraftChange: (text: string) => void;
  onSend: () => Promise<void>;
};

// Enter отправляет текст, а Shift и ввод через IME остаются внутри редактора.
export function MessageComposer({ draft, sending, canSend, onDraftChange, onSend }: Props) {
  const composingRef = useRef(false);
  const tooLong = draft.length > MESSAGE_LENGTH_LIMIT;
  const ready = canSend && !sending && !tooLong && Boolean(draft.trim());

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ready) void onSend();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (ready) void onSend();
  }

  return <form className="composer" onSubmit={submit} aria-label="Отправка сообщения">
    <div className={`composer-field ${tooLong ? 'invalid' : ''}`}>
      <label className="sr-only" htmlFor="message-draft">Сообщение</label>
      <textarea id="message-draft" name="message" value={draft} onChange={event => onDraftChange(event.target.value)} onKeyDown={onKeyDown} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} placeholder="Написать сообщение…" aria-invalid={tooLong} aria-describedby="composer-help" rows={1} />
      <button type="submit" className="send-button" aria-label="Отправить сообщение" title="Отправить сообщение" disabled={!ready}>{sending ? <span className="spinner" /> : <Icon name="send" />}</button>
    </div>
    <div className="composer-help" id="composer-help"><span>{tooLong ? `Сообщение длиннее ${MESSAGE_LENGTH_LIMIT} символов` : 'Enter — отправить · Shift + Enter — новая строка'}</span>{draft.length > 0 && <span className={tooLong ? 'length-error' : ''}>{draft.length} / {MESSAGE_LENGTH_LIMIT}</span>}</div>
  </form>;
}
