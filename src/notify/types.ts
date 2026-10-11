import type { EventType } from '../domain/statusChain.ts';

export type Channel = 'whatsapp' | 'email' | 'sms';
/** Fallback order: WhatsApp first, then email, then SMS as the last resort. */
export const CHANNEL_ORDER: readonly Channel[] = ['whatsapp', 'email', 'sms'];

export type NotificationKind = 'client_status' | 'haulier_assigned' | 'haulier_cleared' | 'suggestion_reminder';

/** Safe parameters only (the database enforces the same): a container number, a chain status, a small count. */
export interface NotificationParams {
  container?: string;
  status?: EventType;
  count?: string;
}

export interface OutboundMessage {
  to: string;
  subject: string;
  text: string;
  /** Stable per (notification, round, channel): a provider that supports it can drop a duplicate send. */
  idempotencyKey: string;
}

export interface Notifier {
  readonly channel: Channel;
  send(message: OutboundMessage): Promise<{ providerRef: string }>;
}

/** What a provider throws when it could not deliver; the message is stored (truncated), so it must not contain the body. */
export class NotifierError extends Error {
  override name = 'NotifierError';
}
