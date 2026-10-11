import type { CompanyClient } from '../db/withCompany.ts';
import { parseContainerNo } from '../domain/iso6346.ts';
import type { EventPayload, EventType } from '../domain/statusChain.ts';

// The only write path to `events`. Everything runs on a client from `withActor`. The ledger owner
// (company_id) is the container's owning CHA, resolved by the database; the recorder and the
// confirming user are always the acting company and user (database defaults, not caller input). Events are appended, never changed: a correction is a new
// event that references the one it corrects.

export type Source = { type: 'person' | 'system'; ref: string };

export type Evidence =
  | { type: 'message'; messageId: string }
  | { type: 'document'; documentId: string }
  | { type: 'manual'; note: string };

export interface EventInput {
  containerId: string;
  eventType: EventType;
  occurredAt: Date;
  /** Who or what reported it (driver, intake, staff member). */
  source: Source;
  evidence: Evidence;
  /** Non-commercial details only (whitelisted keys); hauliers can read events. */
  payload?: EventPayload;
}

export interface LedgerEvent {
  id: string;
  seq: string;
  /** The owning CHA whose ledger this is. */
  companyId: string;
  /** The company that recorded the event (the CHA, a client or a haulier). */
  recordedByCompanyId: string;
  containerId: string;
  eventType: EventType;
  occurredAt: Date;
  recordedAt: Date;
  source: Source;
  /** The user who confirmed the event: always the acting user, set by the database. */
  confirmedByUserId: string;
  evidence: Evidence;
  correctsEventId: string | null;
  /** null = ordinary event; replace = supersedes another event; void = retracts another event. */
  correctionKind: 'replace' | 'void' | null;
  payload: Record<string, unknown>;
}

export interface CurrentStatus {
  containerId: string;
  eventId: string;
  eventType: EventType;
  occurredAt: Date;
  recordedAt: Date;
  source: Source;
}

export interface Container {
  id: string;
  containerNo: string;
  blNo: string;
  cargoType: 'FCL' | 'LCL';
}

/** Validates the ISO 6346 check digit (throws InvalidContainerNoError) before anything is written. */
export async function createContainer(
  c: CompanyClient,
  input: { containerNo: string; blNo: string; cargoType?: 'FCL' | 'LCL' },
): Promise<Container> {
  const containerNo = parseContainerNo(input.containerNo);
  const { rows } = await c.query<{ id: string; container_no: string; bl_no: string; cargo_type: 'FCL' | 'LCL' }>(
    `INSERT INTO containers (company_id, container_no, bl_no, cargo_type)
     VALUES (app_company_id(), $1, $2, $3)
     RETURNING id, container_no, bl_no, cargo_type`,
    [containerNo, input.blNo.trim(), input.cargoType ?? 'FCL'],
  );
  const row = rows[0]!;
  return { id: row.id, containerNo: row.container_no, blNo: row.bl_no, cargoType: row.cargo_type };
}

const EVENT_COLUMNS = `id, seq, company_id, recorded_by_company_id, container_id, event_type, occurred_at, recorded_at, source_type, source_ref,
  evidence_type, message_id, document_id, evidence_note, corrects_event_id, correction_kind, payload, confirmed_by_user_id`;

interface EventRow {
  id: string;
  seq: string;
  company_id: string;
  recorded_by_company_id: string;
  container_id: string;
  event_type: EventType;
  occurred_at: Date;
  recorded_at: Date;
  source_type: Source['type'];
  source_ref: string;
  evidence_type: Evidence['type'];
  message_id: string | null;
  document_id: string | null;
  evidence_note: string | null;
  corrects_event_id: string | null;
  correction_kind: 'replace' | 'void' | null;
  payload: Record<string, unknown>;
  confirmed_by_user_id: string;
}

function toEvidence(row: EventRow): Evidence {
  switch (row.evidence_type) {
    case 'message':
      return { type: 'message', messageId: row.message_id! };
    case 'document':
      return { type: 'document', documentId: row.document_id! };
    case 'manual':
      return { type: 'manual', note: row.evidence_note! };
  }
}

function toEvent(row: EventRow): LedgerEvent {
  return {
    id: row.id,
    seq: row.seq,
    companyId: row.company_id,
    recordedByCompanyId: row.recorded_by_company_id,
    containerId: row.container_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    source: { type: row.source_type, ref: row.source_ref },
    confirmedByUserId: row.confirmed_by_user_id,
    evidence: toEvidence(row),
    correctsEventId: row.corrects_event_id,
    correctionKind: row.correction_kind,
    payload: row.payload,
  };
}

async function insertEvent(
  c: CompanyClient,
  input: EventInput,
  correctsEventId: string | null,
  correctionKind: 'replace' | 'void' | null,
): Promise<LedgerEvent> {
  const ev = input.evidence;
  const { rows } = await c.query<EventRow>(
    `INSERT INTO events (company_id, container_id, event_type, occurred_at, source_type, source_ref,
                         evidence_type, message_id, document_id, evidence_note, corrects_event_id, correction_kind, payload)
     VALUES (COALESCE((SELECT company_id FROM containers WHERE id = $1), app_company_id()),
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${EVENT_COLUMNS}`,
    [
      input.containerId,
      input.eventType,
      input.occurredAt,
      input.source.type,
      input.source.ref,
      ev.type,
      ev.type === 'message' ? ev.messageId : null,
      ev.type === 'document' ? ev.documentId : null,
      ev.type === 'manual' ? ev.note : null,
      correctsEventId,
      correctionKind,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return toEvent(rows[0]!);
}

/** Append a new event to the ledger. The confirming person is the acting user (set by the database). */
export function appendEvent(c: CompanyClient, input: EventInput): Promise<LedgerEvent> {
  return insertEvent(c, input, null, null);
}

/**
 * Append an event that supersedes `correctsEventId` (same company, same container, once only).
 * The original row stays exactly as written; current status ignores superseded events.
 */
export function appendCorrection(c: CompanyClient, correctsEventId: string, input: EventInput): Promise<LedgerEvent> {
  return insertEvent(c, input, correctsEventId, 'replace');
}

/**
 * Retract a false event without deleting it: appends a `void` row carrying the voided event's own type.
 * The owning CHA may void any event on its ledger; other roles only what they may record. The evidence
 * is the reason. Throws if the event does not exist OR is not visible to the caller (same error either way).
 */
export async function voidEvent(c: CompanyClient, eventId: string, input: { source: Source; evidence: Evidence }): Promise<LedgerEvent> {
  const target = await c.query<{ container_id: string; event_type: EventType }>(
    'SELECT container_id, event_type FROM events WHERE id = $1',
    [eventId],
  );
  const row = target.rows[0];
  if (!row) throw new Error('event not found or not permitted (row-level security)');
  return insertEvent(
    c,
    { containerId: row.container_id, eventType: row.event_type, occurredAt: new Date(), source: input.source, evidence: input.evidence },
    eventId,
    'void',
  );
}

/**
 * All events for a container in the order they were recorded, corrections included. Void rows carry the
 * voided event's own `eventType`: consumers must filter on `correctionKind` (use `currentStatus` for status).
 */
export async function listEvents(c: CompanyClient, containerId: string): Promise<LedgerEvent[]> {
  const { rows } = await c.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE container_id = $1 ORDER BY seq`,
    [containerId],
  );
  return rows.map(toEvent);
}

/** Furthest chain status among events not superseded by a correction, or null if there are none. */
export async function currentStatus(c: CompanyClient, containerId: string): Promise<CurrentStatus | null> {
  const { rows } = await c.query<{
    container_id: string;
    event_id: string;
    event_type: EventType;
    occurred_at: Date;
    recorded_at: Date;
    source_type: Source['type'];
    source_ref: string;
  }>(
    `SELECT container_id, event_id, event_type, occurred_at, recorded_at, source_type, source_ref
     FROM container_current_status WHERE container_id = $1`,
    [containerId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    containerId: row.container_id,
    eventId: row.event_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    source: { type: row.source_type, ref: row.source_ref },
  };
}
