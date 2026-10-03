import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageComposer } from '../src/components/MessageComposer';
import { MessageList } from '../src/components/MessageList';
import { chatId, otherChatId, outgoing } from './fixtures';

describe('message composer keyboard and boundary behavior', () => {
  it.each(['', ' \n ', 'A'.repeat(4097)])('disables submission for invalid draft %#', draft => {
    const onSend = vi.fn(async () => {});
    render(<MessageComposer draft={draft} sending={false} canSend onDraftChange={vi.fn()} onSend={onSend} />);
    expect(screen.getByRole('button', { name: 'Отправить сообщение' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Сообщение' }), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    if (draft.length > 4096) expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it.each(['A'.repeat(4096), 'Я'.repeat(4096), 'A'.repeat(4094) + '😀'])('accepts the exact limit without modifying or splitting Unicode %#', draft => {
    render(<MessageComposer draft={draft} sending={false} canSend onDraftChange={vi.fn()} onSend={vi.fn(async () => {})} />);
    expect(screen.getByRole('textbox')).toHaveValue(draft);
    expect(screen.getByRole('button', { name: 'Отправить сообщение' })).toBeEnabled();
    expect(screen.getByText('4096 / 4096')).toBeInTheDocument();
  });

  it.each([{ sending: true, canSend: true }, { sending: false, canSend: false }])('blocks submission while sending/unavailable: %j', props => {
    render(<MessageComposer draft="Текст" {...props} onDraftChange={vi.fn()} onSend={vi.fn(async () => {})} />);
    expect(screen.getByRole('button', { name: 'Отправить сообщение' })).toBeDisabled();
  });

  it('uses Enter to send and Shift+Enter for a newline', async () => {
    const onSend = vi.fn(async () => {});
    function ControlledComposer() {
      const [draft, setDraft] = useState('Привет');
      return <MessageComposer draft={draft} sending={false} canSend onDraftChange={setDraft} onSend={onSend} />;
    }
    const user = userEvent.setup();
    render(<ControlledComposer />);
    const input = screen.getByRole('textbox', { name: 'Сообщение' });
    await user.click(input);
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(input).toHaveValue('Привет\n');
    expect(onSend).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('never sends an IME composition Enter, including keyCode 229, and sends after composition ends', () => {
    const onSend = vi.fn(async () => {});
    render(<MessageComposer draft="日本語" sending={false} canSend onDraftChange={vi.fn()} onSend={onSend} />);
    const input = screen.getByRole('textbox');
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('message rendering and autoscroll policy', () => {
  it('renders sender direction, accessible statuses, newlines and HTML as text', () => {
    const text = '<script>window.syntheticExecuted=true</script>\nВторая строка 😀';
    const { container } = render(<MessageList chatId={chatId} messages={[
      outgoing({ text, status: 'queued' }), outgoing({ id: 'reply', direction: 'incoming', text: 'Ответ' }),
    ]} />);
    expect(screen.getByRole('log', { name: 'Сообщения' })).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('article', { name: 'Исходящее сообщение' }).querySelector('p')?.textContent).toBe(text);
    expect(screen.getByRole('article', { name: 'Входящее сообщение' })).toHaveTextContent('Ответ');
    expect(screen.getByLabelText('В очереди')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
  });

  it.each([['sent', 'Отправлено'], ['delivered', 'Доставлено'], ['read', 'Прочитано'], ['failed', 'Не отправлено'], ['noAccount', 'Ошибка получателя']] as const)('announces %s without implying delivery of a queued message', (status, label) => {
    render(<MessageList chatId={chatId} messages={[outgoing({ status })]} />);
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it('preserves an older reading position and jumps only on explicit action or chat switch', async () => {
    const { rerender } = render(<MessageList chatId={chatId} messages={[outgoing()]} />);
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    rerender(<MessageList chatId={chatId} messages={[outgoing(), outgoing({ id: 'second' })]} />);
    expect(log.scrollTop).toBe(100);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'К новым сообщениям' }));
    expect(log.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: 'К новым сообщениям' })).not.toBeInTheDocument();
    log.scrollTop = 100;
    fireEvent.scroll(log);
    rerender(<MessageList chatId={otherChatId} messages={[outgoing({ chatId: otherChatId })]} />);
    expect(log.scrollTop).toBe(1000);
  });
});
