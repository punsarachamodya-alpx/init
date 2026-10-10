import { isEventType } from '../../src/domain/statusChain.ts';
import type { Translate } from '../lib/context.ts';

const ERRORS = [
  'not_confirmable', 'fields_not_acknowledged', 'invalid_field', 'container_required', 'event_type_required', 'occurred_at_required',
  'occurred_at_invalid', 'container_not_found', 'ambiguous_container', 'duplicate', 'suggestion_not_found', 'already_decided',
  'ungrounded_container', 'reason_required', 'invalid_container', 'forbidden', 'unexpected',
] as const;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** A one-line result banner from the query string. Every value is checked against a fixed list or pattern before it is shown. */
export function Flash({ params, tr }: { params: Params; tr: Translate }) {
  const error = one(params.error);
  if (error) {
    const code = (ERRORS as readonly string[]).includes(error) ? (error as (typeof ERRORS)[number]) : 'unexpected';
    return <p className="flash err" role="alert" data-testid="flash-error">{tr(`error.${code}`)}</p>;
  }
  const flash = one(params.flash);
  const container = one(params.container);
  const status = one(params.status);
  const okContainer = container !== undefined && /^[A-Z]{4}[0-9]{7}$/.test(container);
  const okStatus = status !== undefined && isEventType(status);
  let text: string | null = null;
  if ((flash === 'confirmed' || flash === 'manual_done') && okContainer && okStatus) {
    text = tr(flash === 'confirmed' ? 'flash.confirmed' : 'flash.manual_done', { status: tr(`status.${status}`), container });
  } else if (flash === 'rejected') text = tr('flash.rejected');
  else if (flash === 'suggestion_ready') text = tr('flash.suggestion_ready');
  else if (flash === 'notifications') {
    const n = (k: string) => (/^\d{1,5}$/.test(one(params[k]) ?? '') ? one(params[k])! : '0');
    text = tr('board.notifications_result', { sent: n('sent'), failed: n('failed'), skipped: n('skipped') });
  }
  return text ? <p className="flash ok" role="status" data-testid="flash">{text}</p> : null;
}
