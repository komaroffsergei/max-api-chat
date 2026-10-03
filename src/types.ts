export type Credentials = {
  idInstance: string;
  apiTokenInstance: string;
  apiUrl: string;
};

export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'noAccount';

export type Message = {
  id: string;
  chatId: string;
  text: string;
  timestamp: number;
  direction: 'incoming' | 'outgoing';
  status?: MessageStatus;
};

export type Chat = {
  id: string;
  phone: string;
  title: string;
  messages: Message[];
  draft: string;
  error: string | null;
};

export type NotificationReceipt = {
  receiptId: number;
  body: unknown;
};

export type NotificationEvent =
  | { kind: 'incoming'; message: Message; senderName: string | null }
  | { kind: 'status'; chatId: string; messageId: string | null; status: MessageStatus }
  | { kind: 'state'; state: string }
  | { kind: 'ignored'; type: string };

export type PollingPhase = 'starting' | 'listening' | 'backoff' | 'paused' | 'blocked' | 'unsupported' | 'stopped';

export type PollingStatus = {
  phase: PollingPhase;
  message: string | null;
  retryAt?: number;
};
