import { useState } from 'react';
import { ConnectionForm } from './components/ConnectionForm';
import { ChatSidebar } from './components/ChatSidebar';
import { ChatWindow } from './components/ChatWindow';
import { useChatSession } from './hooks/useChatSession';

// Связываем экран подключения и чат; на телефоне показываем по одному разделу.
export default function App() {
  const chat = useChatSession();
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

  if (!chat.session) return <ConnectionForm connecting={chat.connecting} error={chat.connectionError} onConnect={chat.connect} />;

  async function createChat(phone: string): Promise<boolean> {
    const opened = await chat.createChat(phone);
    if (opened) setMobileChatOpen(true);
    return opened;
  }

  return <div className={`chat-app ${mobileChatOpen && chat.activeChat ? 'mobile-chat-open' : ''}`}>
    <ChatSidebar chats={chat.state.chats} activeChatId={chat.state.activeChatId} idInstance={chat.session.idInstance} polling={chat.polling} creatingChat={chat.creatingChat} newChatError={chat.newChatError} onCreateChat={createChat} onSelectChat={chatId => { chat.selectChat(chatId); setMobileChatOpen(true); }} onLogout={() => { chat.logout(); setMobileChatOpen(false); }} onRetry={chat.retryPolling} />
    <ChatWindow chat={chat.activeChat} polling={chat.polling} hints={chat.session.hints} sending={chat.sendingChatId === chat.activeChat?.id} canSend={chat.canSend && chat.sendingChatId === null} onBack={() => setMobileChatOpen(false)} onRetry={chat.retryPolling} onDraftChange={text => { if (chat.activeChat) chat.setDraft(chat.activeChat.id, text); }} onSend={chat.sendMessage} />
  </div>;
}
