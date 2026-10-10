import type { CompanyClient } from '../db/withCompany.ts';
import { parseContainerNo } from '../domain/iso6346.ts';
import type { EventType } from '../domain/statusChain.ts';

// The only write path to `events`. Everything runs on a client from `withCompany`,
// so company_id always comes from the transaction's company context (app_company_id()),
// never from the caller. Events are appended, never changed: a correction is a new
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
  payload?: Record<string, unknown>;
}

export interface LedgerEvent {
  id: string;
  seq: string;
  containerId: string;
  eventType: EventType;
  occurredAt: Date;
  recordedAt: Date;
  source: Source;
  /** The user who confirmed the event: always the acting user, set by the database. */
  confirmedByUserId: string;
  evidence: Evidence;
  correctsEventId: string | null;
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

const EVENT_COLUMNS = `id, seq, container_id, event_type, occurred_at, recorded_at, source_type, source_ref,
  evidence_type, message_id, document_id, evidence_note, corrects_event_id, payload, confirmed_by_user_id`;

interface EventRow {
  id: string;
  seq: string;
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
    containerId: row.container_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    source: { type: row.source_type, ref: row.source_ref },
    confirmedByUserId: row.confirmed_by_user_id,
    evidence: toEvidence(row),
    correctsEventId: row.corrects_event_id,
    payload: row.payload,
  };
}

async function insertEvent(c: CompanyClient, input: EventInput, correctsEventId: string | null): Promise<LedgerEvent> {
  const ev = input.evidence;
  const { rows } = await c.query<EventRow>(
    `INSERT INTO events (company_id, container_id, event_type, occurred_at, source_type, source_ref,
                         evidence_type, message_id, document_id, evidence_note, corrects_event_id, payload)
     VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return toEvent(rows[0]!);
}

/** Append a new event to the ledger. The confirming person is the acting user (set by the database). */
export function appendEvent(c: CompanyClient, input: EventInput): Promise<LedgerEvent> {
  return insertEvent(c, input, null);
}

/**
 * Append an event that supersedes `correctsEventId` (same company, same container, once only).
 * The original row stays exactly as written; current status ignores superseded events.
 */
export function appendCorrection(c: CompanyClient, correctsEventId: string, input: EventInput): Promise<LedgerEvent> {
  return insertEvent(c, input, correctsEventId);
}

/** All events for a container in the order they were recorded, corrections included. */
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
