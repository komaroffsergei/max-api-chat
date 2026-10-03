import { useEffect, useReducer, useRef, useState } from 'react';
import { createGreenApiClient, GreenApiError, isAuthorizationError } from '../api/greenApi';
import type { GreenApiClient } from '../api/greenApi';
import { normalizePhoneNumber } from '../phone';
import { chatReducer, createInitialChatState } from '../state/chatState';
import { runNotificationLoop, runWithConsumerLock } from '../state/pollNotifications';
import type { Credentials, PollingStatus } from '../types';

type Session = {
  api: GreenApiClient;
  idInstance: string;
  generation: number;
  controller: AbortController;
  hints: string[];
};

const initialPolling: PollingStatus = { phase: 'starting', message: null };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof GreenApiError ? error.message : fallback;
}

// Держим переписку и запросы одной сессии только в памяти вкладки.
export function useChatSession() {
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialChatState);
  const [session, setSession] = useState<Session | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [newChatError, setNewChatError] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [sendingChatId, setSendingChatId] = useState<string | null>(null);
  const [polling, setPolling] = useState<PollingStatus>(initialPolling);
  const [pollRestart, setPollRestart] = useState(0);
  const generationRef = useRef(0);
  const connectionControllerRef = useRef<AbortController | null>(null);
  const consumerTaskRef = useRef<Promise<void> | null>(null);
  const connectingRef = useRef(false);
  const creatingRef = useRef(false);
  const sendingRef = useRef(false);
  const draftRevisionsRef = useRef(new Map<string, number>());

  useEffect(() => () => {
    generationRef.current += 1;
    connectionControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    session.controller.signal.addEventListener('abort', abort, { once: true });
    const current = () => !controller.signal.aborted && generationRef.current === session.generation;
    const onStatus = (status: PollingStatus) => { if (current()) setPolling(status); };
    const previousTask = consumerTaskRef.current;

    const task = (async () => {
      // Новый effect ждёт отпускания нашей старой блокировки, в том числе в StrictMode.
      await previousTask;
      if (!current()) return;
      onStatus(initialPolling);
      await runWithConsumerLock({
        instanceId: session.idInstance,
        signal: controller.signal,
        onStatus,
        run: () => runNotificationLoop({
          api: session.api,
          signal: controller.signal,
          onStatus,
          onNotification: event => { if (current()) dispatch({ type: 'notification', event }); },
        }),
      });
    })();
    consumerTaskRef.current = task;

    return () => {
      controller.abort();
      session.controller.signal.removeEventListener('abort', abort);
    };
  }, [session, pollRestart]);

  const canSend = session !== null && (polling.phase === 'listening' || polling.phase === 'backoff');
  const activeChat = state.chats.find(chat => chat.id === state.activeChatId) ?? null;

  // Отменяем запросы раньше очистки экрана, чтобы поздние ответы не вернули данные.
  function logout() {
    generationRef.current += 1;
    connectionControllerRef.current?.abort();
    connectionControllerRef.current = null;
    connectingRef.current = false;
    creatingRef.current = false;
    sendingRef.current = false;
    draftRevisionsRef.current.clear();
    setSession(null);
    setConnecting(false);
    setCreatingChat(false);
    setSendingChatId(null);
    setConnectionError(null);
    setNewChatError(null);
    setPolling(initialPolling);
    dispatch({ type: 'clear' });
  }

  // До открытия чатов проверяем Telegram-авторизацию и настройки приёма.
  async function connect(credentials: Credentials) {
    if (connectingRef.current) return;
    connectingRef.current = true;
    const generation = ++generationRef.current;
    connectionControllerRef.current?.abort();
    const controller = new AbortController();
    connectionControllerRef.current = controller;
    setConnecting(true);
    setConnectionError(null);
    draftRevisionsRef.current.clear();
    dispatch({ type: 'clear' });
    setSession(null);

    try {
      const api = createGreenApiClient(credentials);
      const instanceState = await api.getStateInstance(controller.signal);
      if (instanceState.toLowerCase() !== 'authorized') {
        throw new GreenApiError('Инстанс не авторизован. Подключите Telegram в личном кабинете GREEN-API.');
      }
      const settings = await api.getSettings(controller.signal);
      if (settings.typeInstance.toLowerCase() !== 'telegram') {
        throw new GreenApiError('Это приложение работает с Telegram. Выберите Telegram-инстанс.');
      }
      if (settings.webhookUrl.trim()) {
        throw new GreenApiError('Для приёма здесь поле webhookUrl должно быть пустым. Проверьте настройки в личном кабинете GREEN-API.');
      }
      if (settings.incomingWebhook !== 'yes') {
        throw new GreenApiError('Для входящих сообщений включите incomingWebhook в личном кабинете GREEN-API.');
      }
      if (controller.signal.aborted || generationRef.current !== generation) return;
      const hints: string[] = [];
      if (settings.outgoingWebhook !== 'yes') hints.push('Статусы доставки появятся, если включить outgoingWebhook в GREEN-API.');
      if (settings.stateWebhook !== 'yes') hints.push('Уведомления об авторизации появятся, если включить stateWebhook в GREEN-API.');
      setPolling(initialPolling);
      setSession({ api, idInstance: credentials.idInstance.trim(), generation, controller, hints });
    } catch (error) {
      if (!controller.signal.aborted && generationRef.current === generation) {
        setConnectionError(errorMessage(error, 'Не удалось подключиться к GREEN-API.'));
      }
    } finally {
      if (generationRef.current === generation) {
        connectingRef.current = false;
        setConnecting(false);
      }
    }
  }

  // Проверяем номер один раз и используем адрес чата из ответа CheckAccount.
  async function createChat(value: string): Promise<boolean> {
    if (!session || creatingRef.current) return false;
    let phone: string;
    try {
      phone = normalizePhoneNumber(value);
    } catch {
      setNewChatError('Введите номер с кодом страны: от 7 до 15 цифр.');
      return false;
    }
    const existing = state.chats.find(chat => chat.phone === phone);
    if (existing) {
      dispatch({ type: 'selectChat', chatId: existing.id });
      setNewChatError(null);
      return true;
    }
    creatingRef.current = true;
    setCreatingChat(true);
    setNewChatError(null);
    try {
      const result = await session.api.checkAccount(phone, session.controller.signal);
      if (session.controller.signal.aborted || generationRef.current !== session.generation) return false;
      if (!result.exist || !result.chatId) {
        setNewChatError('Не удалось найти аккаунт по этому номеру. Номер может быть скрыт в настройках Telegram.');
        return false;
      }
      // Адрес чата берём из CheckAccount, а не собираем из номера телефона.
      dispatch({ type: 'openChat', chatId: result.chatId, phone });
      return true;
    } catch (error) {
      if (!session.controller.signal.aborted && generationRef.current === session.generation) {
        setNewChatError(errorMessage(error, 'Не удалось начать чат.'));
        if (isAuthorizationError(error)) {
          session.controller.abort();
          setPolling({ phase: 'stopped', message: errorMessage(error, 'Проверьте авторизацию инстанса.') });
        }
      }
      return false;
    } finally {
      if (generationRef.current === session.generation) {
        creatingRef.current = false;
        setCreatingChat(false);
      }
    }
  }

  // Запоминаем чат, черновик и сессию до запроса; автоматически отправку не повторяем.
  async function sendMessage(): Promise<void> {
    if (!session || !activeChat || !canSend || sendingRef.current) return;
    const snapshot = {
      chatId: activeChat.id,
      text: activeChat.draft,
      draftRevision: draftRevisionsRef.current.get(activeChat.id) ?? 0,
      session,
    };
    if (!snapshot.text.trim()) return;
    sendingRef.current = true;
    setSendingChatId(snapshot.chatId);
    dispatch({ type: 'chatError', chatId: snapshot.chatId, error: null });
    try {
      const result = await snapshot.session.api.sendMessage(snapshot.chatId, snapshot.text, snapshot.session.controller.signal);
      if (snapshot.session.controller.signal.aborted || generationRef.current !== snapshot.session.generation) return;
      dispatch({
        type: 'messageSent',
        // Правки A→B→A тоже создают новый черновик, хотя текст снова совпадает.
        submittedDraft: (draftRevisionsRef.current.get(snapshot.chatId) ?? 0) === snapshot.draftRevision ? snapshot.text : undefined,
        message: { id: result.idMessage, chatId: snapshot.chatId, text: snapshot.text, timestamp: Date.now(), direction: 'outgoing', status: 'queued' },
      });
    } catch (error) {
      if (!snapshot.session.controller.signal.aborted && generationRef.current === snapshot.session.generation) {
        let message = errorMessage(error, 'Не удалось отправить сообщение.');
        if (error instanceof GreenApiError && (error.kind === 'network' || error.kind === 'format' || (error.status !== null && error.status >= 500))) {
          message = 'Результат отправки неизвестен. Проверьте чат в Telegram перед повторной отправкой.';
        }
        dispatch({ type: 'chatError', chatId: snapshot.chatId, error: message });
        if (isAuthorizationError(error)) {
          snapshot.session.controller.abort();
          setPolling({ phase: 'stopped', message });
        }
      }
    } finally {
      // Старый запрос не должен снимать блокировку отправки в новой сессии.
      if (generationRef.current === snapshot.session.generation) {
        sendingRef.current = false;
        setSendingChatId(null);
      }
    }
  }

  function setDraft(chatId: string, text: string) {
    draftRevisionsRef.current.set(chatId, (draftRevisionsRef.current.get(chatId) ?? 0) + 1);
    dispatch({ type: 'setDraft', chatId, text });
  }

  return {
    state, activeChat, session, connecting, connectionError, newChatError,
    creatingChat, sendingChatId, polling, canSend,
    connect, logout, createChat, sendMessage,
    selectChat: (chatId: string) => dispatch({ type: 'selectChat', chatId }),
    setDraft,
    retryPolling: () => setPollRestart(value => value + 1),
  };
}
