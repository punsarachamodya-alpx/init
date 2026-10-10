import type { CompanyClient } from '../db/withCompany.ts';
import { EVENT_TYPES, isValidPayloadEntry } from '../domain/statusChain.ts';
import type { EventPayload, EventType } from '../domain/statusChain.ts';
import { appendEvent, createContainer } from '../ledger/ledger.ts';
import type { Container, LedgerEvent } from '../ledger/ledger.ts';
import { normaliseFields } from './suggest.ts';
import { FIELD_NAMES } from './types.ts';
import type { Fields, Suggestion } from './types.ts';

// The ONLY module in src/intake that writes to the ledger (tests/intake.test.ts enforces this).
// A suggestion becomes an event only when a person passes a value for every field it extracted.

export type ConfirmationErrorCode =
  | 'not_confirmable'
  | 'fields_not_acknowledged'
  | 'invalid_field'
  | 'container_required'
  | 'event_type_required'
  | 'occurred_at_required'
  | 'occurred_at_invalid'
  | 'container_not_found'
  | 'ambiguous_container'
  | 'duplicate';

export class ConfirmationError extends Error {
  readonly code: ConfirmationErrorCode;
  constructor(code: ConfirmationErrorCode, message: string) {
    super(message);
    this.name = 'ConfirmationError';
    this.code = code;
  }
}

export interface Confirmation {
  eventType: EventType;
  /** When it happened. Defaults to the suggestion's time; required if the suggestion has none. */
  occurredAt?: Date;
  /** The person's final value for every field the suggestion extracted (edits allowed); may add more. */
  fields: Fields;
  /** Create the container (number + BL) if it does not exist. Only cha_ops can; the database enforces it. */
  createContainer?: boolean;
}

function payloadFor(eventType: EventType, f: Fields): EventPayload {
  const payload: EventPayload = {};
  if (typeof f.bl_no === 'string') payload.reference = f.bl_no;
  if ((eventType === 'channel_assigned' || eventType === 'release_advice') && typeof f.channel === 'string') payload.result = f.channel;
  if ((eventType === 'channel_assigned' || eventType === 'exam') && typeof f.exam_location === 'string') payload.yard = f.exam_location;
  if ((eventType === 'channel_assigned' || eventType === 'exam') && typeof f.exam_scheduled_at === 'string') {
    payload.scheduled_at = new Date(f.exam_scheduled_at).toISOString();
  }
  // Only values the ledger accepts (a B/L with spaces, say, is left out of the payload; it is still on the container).
  return Object.fromEntries(Object.entries(payload).filter(([k, v]) => isValidPayloadEntry(k, v))) as EventPayload;
}

export async function confirmSuggestion(
  c: CompanyClient,
  suggestion: Suggestion,
  confirmation: Confirmation,
): Promise<{ event: LedgerEvent; container: Container }> {
  if (suggestion.status === 'rejected' || suggestion.status === 'failed') {
    throw new ConfirmationError('not_confirmable', `a ${suggestion.status} suggestion cannot be confirmed`);
  }
  if (!(EVENT_TYPES as readonly string[]).includes(confirmation.eventType)) {
    throw new ConfirmationError('event_type_required', 'choose a status from the import chain');
  }

  const unknown = Object.keys(confirmation.fields).filter((k) => !(FIELD_NAMES as readonly string[]).includes(k));
  if (unknown.length > 0) throw new ConfirmationError('invalid_field', `unknown field(s): ${unknown.join(', ')}`);

  // Acknowledging a field means giving it a value: a string or boolean, not null, undefined or blank.
  const given = (k: string) => {
    const v = (confirmation.fields as Record<string, unknown>)[k];
    return typeof v === 'boolean' || (typeof v === 'string' && v.trim() !== '');
  };
  const missing = Object.keys(suggestion.fields).filter((k) => !given(k));
  if (missing.length > 0) {
    throw new ConfirmationError('fields_not_acknowledged', `confirm or correct every extracted field; missing: ${missing.join(', ')}`);
  }

  // The person's values go through the same checks as extracted ones (e.g. container check digit).
  const { fields, issues } = normaliseFields(confirmation.fields);
  const bad = issues.filter((i) => i.severity !== 'info');
  if (bad.length > 0) throw new ConfirmationError('invalid_field', bad.map((i) => i.message).join('; '));
  if (typeof fields.container_no !== 'string') throw new ConfirmationError('container_required', 'a valid container number is required');

  const occurredAt = confirmation.occurredAt ?? suggestion.suggestedOccurredAt;
  if (!occurredAt) throw new ConfirmationError('occurred_at_required', 'say when this happened');
  const t = occurredAt instanceof Date ? occurredAt.getTime() : NaN;
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || t > Date.now() + 366 * 86_400_000) {
    // Up to a year ahead is allowed (a scheduled exam lies in the future); absurd years are not.
    throw new ConfirmationError('occurred_at_invalid', 'the event time must be a real date between 2000 and one year from now');
  }

  // Resolve the container among those the acting user can see.
  const blNo = typeof fields.bl_no === 'string' ? fields.bl_no : null;
  const found = await c.query<{ id: string; container_no: string; bl_no: string; cargo_type: 'FCL' | 'LCL' }>(
    'SELECT id, container_no, bl_no, cargo_type FROM containers WHERE container_no = $1 AND ($2::text IS NULL OR bl_no = $2)',
    [fields.container_no, blNo],
  );
  if (found.rows.length > 1) throw new ConfirmationError('ambiguous_container', 'several consignments share this container number; give the BL number');
  let container: Container;
  const row = found.rows[0];
  if (row) {
    container = { id: row.id, containerNo: row.container_no, blNo: row.bl_no, cargoType: row.cargo_type };
  } else if (confirmation.createContainer === true && blNo) {
    container = await createContainer(c, { containerNo: fields.container_no, blNo });
  } else {
    throw new ConfirmationError('container_not_found', 'no visible container with this number; ask the CHA to create it');
  }

  // The same evidence cannot produce the same event twice (app-level guard).
  const ev = suggestion.evidence;
  // Voided and superseded events do not count: confirm wrongly -> void -> confirm again must work.
  const dup = await c.query(
    `SELECT 1 FROM events e
     WHERE e.container_id = $1 AND e.event_type = $2 AND (e.message_id = $3 OR e.document_id = $4)
       AND e.correction_kind IS DISTINCT FROM 'void'
       AND NOT EXISTS (SELECT 1 FROM events c WHERE c.corrects_event_id = e.id)
     LIMIT 1`,
    [container.id, confirmation.eventType, ev.type === 'message' ? ev.messageId : null, ev.type === 'document' ? ev.documentId : null],
  );
  if ((dup.rowCount ?? 0) > 0) throw new ConfirmationError('duplicate', 'this message/document has already produced this event');

  const event = await appendEvent(c, {
    containerId: container.id,
    eventType: confirmation.eventType,
    occurredAt,
    source: { type: 'system', ref: 'intake' },
    evidence: ev,
    payload: payloadFor(confirmation.eventType, fields),
  });
  return { event, container };
}
