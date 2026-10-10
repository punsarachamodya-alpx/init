import type { CompanyClient } from '../db/withCompany.ts';
import { EVENT_TYPES, isValidPayloadEntry } from '../domain/statusChain.ts';
import type { EventPayload, EventType } from '../domain/statusChain.ts';
import { appendEvent, createContainer } from '../ledger/ledger.ts';
import type { Container, LedgerEvent } from '../ledger/ledger.ts';
import { loadEvidenceText, loadSuggestion } from './store.ts';
import { normaliseFields, scanContainerTokens } from './suggest.ts';
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
  | 'duplicate'
  | 'suggestion_not_found'
  | 'already_decided'
  | 'ungrounded_container'
  | 'reason_required';

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

interface Validated {
  fields: Fields;
  containerNo: string;
  blNo: string | null;
  occurredAt: Date;
}

/** Everything that can be checked without touching the database. */
function validate(suggestion: Suggestion, confirmation: Confirmation): Validated {
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
  checkOccurredAt(occurredAt);
  return { fields, containerNo: fields.container_no, blNo: typeof fields.bl_no === 'string' ? fields.bl_no : null, occurredAt };
}

function checkOccurredAt(occurredAt: Date): void {
  const t = occurredAt instanceof Date ? occurredAt.getTime() : NaN;
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || t > Date.now() + 366 * 86_400_000) {
    // Up to a year ahead is allowed (a scheduled exam lies in the future); absurd years are not.
    throw new ConfirmationError('occurred_at_invalid', 'the event time must be a real date between 2000 and one year from now');
  }
}

/** Find the container among those the acting user can see; create it only when asked (the database gates the role). */
async function resolveContainer(c: CompanyClient, containerNo: string, blNo: string | null, create: boolean | undefined): Promise<Container> {
  const found = await c.query<{ id: string; container_no: string; bl_no: string; cargo_type: 'FCL' | 'LCL' }>(
    'SELECT id, container_no, bl_no, cargo_type FROM containers WHERE container_no = $1 AND ($2::text IS NULL OR bl_no = $2)',
    [containerNo, blNo],
  );
  if (found.rows.length > 1) throw new ConfirmationError('ambiguous_container', 'several consignments share this container number; give the BL number');
  const row = found.rows[0];
  if (row) return { id: row.id, containerNo: row.container_no, blNo: row.bl_no, cargoType: row.cargo_type };
  if (create === true && blNo) return createContainer(c, { containerNo, blNo });
  throw new ConfirmationError('container_not_found', 'no visible container with this number; ask the CHA to create it');
}

async function persist(c: CompanyClient, suggestion: Suggestion, confirmation: Confirmation, v: Validated): Promise<{ event: LedgerEvent; container: Container }> {
  const container = await resolveContainer(c, v.containerNo, v.blNo, confirmation.createContainer);

  // The same evidence cannot produce the same event twice (app-level guard; the stored path adds a unique decision).
  const ev = suggestion.evidence;
  // An event keeps its evidence while its correction chain is live: a replacement (which may carry other evidence)
  // does not release it. Only a chain that ends in a void does: confirm wrongly -> void -> confirm again must work.
  const dup = await c.query(
    `WITH RECURSIVE chain AS (
       SELECT e.id AS cur, e.correction_kind AS kind FROM events e
       WHERE e.container_id = $1 AND e.event_type = $2 AND (e.message_id = $3 OR e.document_id = $4)
         AND e.correction_kind IS DISTINCT FROM 'void'
       UNION ALL
       SELECT n.id, n.correction_kind FROM chain ch JOIN events n ON n.corrects_event_id = ch.cur
     )
     SELECT 1 FROM chain ch
     WHERE ch.kind IS DISTINCT FROM 'void'
       AND NOT EXISTS (SELECT 1 FROM events n WHERE n.corrects_event_id = ch.cur)
     LIMIT 1`,
    [container.id, confirmation.eventType, ev.type === 'message' ? ev.messageId : null, ev.type === 'document' ? ev.documentId : null],
  );
  if ((dup.rowCount ?? 0) > 0) throw new ConfirmationError('duplicate', 'this message/document has already produced this event');

  const event = await appendEvent(c, {
    containerId: container.id,
    eventType: confirmation.eventType,
    occurredAt: v.occurredAt,
    source: { type: 'system', ref: 'intake' },
    evidence: ev,
    payload: payloadFor(confirmation.eventType, v.fields),
  });
  return { event, container };
}

/**
 * Confirm a suggestion the CALLER holds. Trusted callers only (tests, scripts): anything reachable from a
 * browser must use confirmSuggestionById, where the server loads status, evidence and fields itself.
 */
export async function confirmSuggestion(
  c: CompanyClient,
  suggestion: Suggestion,
  confirmation: Confirmation,
): Promise<{ event: LedgerEvent; container: Container }> {
  return persist(c, suggestion, confirmation, validate(suggestion, confirmation));
}

async function assertUndecided(c: CompanyClient, id: string): Promise<void> {
  const decided = await c.query('SELECT 1 FROM intake_decisions WHERE suggestion_id = $1', [id]);
  if ((decided.rowCount ?? 0) > 0) throw new ConfirmationError('already_decided', 'this suggestion has already been confirmed or rejected');
}

const isUniqueViolation = (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

/**
 * Confirm a STORED suggestion. The caller supplies only the person's values: status, evidence and the extracted
 * fields are loaded from the database; the container number must be a whole token in the stored evidence text;
 * the event and the (unique) decision are written in the caller's transaction, so a concurrent second confirm
 * rolls back completely.
 */
export async function confirmSuggestionById(
  c: CompanyClient,
  id: string,
  confirmation: Confirmation,
): Promise<{ event: LedgerEvent; container: Container }> {
  const stored = await loadSuggestion(c, id);
  if (!stored) throw new ConfirmationError('suggestion_not_found', 'no such suggestion');
  await assertUndecided(c, id);
  const validated = validate(stored.suggestion, confirmation);

  const text = await loadEvidenceText(c, stored.suggestion.evidence);
  if (text === null || !scanContainerTokens(text).valid.includes(validated.containerNo)) {
    throw new ConfirmationError('ungrounded_container', `${validated.containerNo} does not appear in the original message or document; use manual entry`);
  }

  let result: { event: LedgerEvent; container: Container };
  try {
    result = await persist(c, stored.suggestion, confirmation, validated);
  } catch (err) {
    // Losing a race looks like a duplicate event; the person-level answer is that the suggestion is decided.
    if (err instanceof ConfirmationError && err.code === 'duplicate') await assertUndecided(c, id);
    throw err;
  }
  try {
    await c.query(
      `INSERT INTO intake_decisions (company_id, suggestion_id, decision, event_id, final_fields)
       VALUES (app_company_id(), $1, 'confirmed', $2, $3)`,
      [id, result.event.id, JSON.stringify(validated.fields)],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConfirmationError('already_decided', 'this suggestion has already been confirmed or rejected');
    throw err;
  }
  return result;
}

/** Reject a stored suggestion with a reason. Nothing is written to the ledger. */
export async function rejectSuggestionById(c: CompanyClient, id: string, reason: string): Promise<void> {
  const text = reason.trim();
  if (!text) throw new ConfirmationError('reason_required', 'say why you are rejecting it');
  if (text.length > 200) throw new ConfirmationError('invalid_field', 'the reason is too long (200 characters at most)');
  const stored = await loadSuggestion(c, id);
  if (!stored) throw new ConfirmationError('suggestion_not_found', 'no such suggestion');
  await assertUndecided(c, id);
  try {
    await c.query(
      `INSERT INTO intake_decisions (company_id, suggestion_id, decision, reason) VALUES (app_company_id(), $1, 'rejected', $2)`,
      [id, text],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConfirmationError('already_decided', 'this suggestion has already been confirmed or rejected');
    throw err;
  }
}

export interface ManualEntry {
  containerNo: string;
  blNo?: string;
  eventType: EventType;
  occurredAt: Date;
  /** Why/how the person knows (stored as the event's manual evidence). */
  reason: string;
  createContainer?: boolean;
}

/**
 * A person records a stage directly (extraction failed, or there was no message). Same role rules as everything
 * else; the evidence is the person's own reason, the source is "manual".
 */
export async function recordManualEvent(c: CompanyClient, input: ManualEntry): Promise<{ event: LedgerEvent; container: Container }> {
  const reason = input.reason.trim();
  if (!reason) throw new ConfirmationError('reason_required', 'say how you know this (it is kept as the evidence)');
  if (reason.length > 200) throw new ConfirmationError('invalid_field', 'the reason is too long (200 characters at most)');
  if (!(EVENT_TYPES as readonly string[]).includes(input.eventType)) throw new ConfirmationError('event_type_required', 'choose a status from the import chain');
  const { fields, issues } = normaliseFields({ container_no: input.containerNo, ...(input.blNo ? { bl_no: input.blNo } : {}) });
  const bad = issues.filter((i) => i.severity !== 'info');
  if (bad.length > 0 || typeof fields.container_no !== 'string') {
    throw new ConfirmationError('invalid_field', bad.map((i) => i.message).join('; ') || 'a valid container number is required');
  }
  checkOccurredAt(input.occurredAt);
  const blNo = typeof fields.bl_no === 'string' ? fields.bl_no : null;
  const container = await resolveContainer(c, fields.container_no, blNo, input.createContainer);
  const event = await appendEvent(c, {
    containerId: container.id,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    source: { type: 'person', ref: 'manual' },
    evidence: { type: 'manual', note: reason },
    payload: {},
  });
  return { event, container };
}
