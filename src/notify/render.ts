import { isEventType } from '../domain/statusChain.ts';
import { t } from '../i18n/index.ts';
import type { Locale, MessageKey } from '../i18n/index.ts';
import type { NotificationKind, NotificationParams } from './types.ts';

/** Subject and text in the recipient's language. Parameters are a container number, a status and a count: nothing else exists to leak. */
export function renderNotification(kind: NotificationKind, locale: Locale, params: NotificationParams): { subject: string; text: string } {
  const vars: Record<string, string> = {};
  if (params.container !== undefined) vars.container = params.container;
  if (params.count !== undefined) vars.count = params.count;
  if (params.status !== undefined) {
    if (!isEventType(params.status)) throw new Error(`unknown status "${String(params.status)}"`);
    vars.status = t(locale, `status.${params.status}`);
  }
  return {
    subject: t(locale, `notify.${kind}.subject` as MessageKey, vars),
    text: t(locale, `notify.${kind}.text` as MessageKey, vars),
  };
}
