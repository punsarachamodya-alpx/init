import type { CompanyClient } from '../db/withCompany.ts';
import { EVENT_TYPES } from '../domain/statusChain.ts';
import type { EventType } from '../domain/statusChain.ts';

export type EvidenceKind = 'message' | 'document' | 'manual';

export interface BoardEvidence {
  kind: EvidenceKind;
  /** First characters of the message or document, only when the viewer's own company owns that evidence. */
  excerpt: string | null;
  /** The reason typed for a manual entry (events carry it themselves, so any viewer of the event may read it). */
  note: string | null;
}

export interface BoardRow {
  containerId: string;
  containerNo: string;
  /** Hidden from hauliers: it identifies the consignment, not the job. */
  blNo: string | null;
  cargoType: 'FCL' | 'LCL';
  /** True when the viewer's company owns the container. */
  owned: boolean;
  status: EventType | null;
  /** When the current status happened (occurred_at of the stage event). */
  statusSince: Date | null;
  /** now - statusSince, in milliseconds, using the injected clock. */
  ageMs: number | null;
  lastChange: {
    eventId: string;
    recordedAt: Date;
    source: { type: 'person' | 'system'; ref: string };
    /** True when the viewer's own company recorded it. */
    recordedByOwnCompany: boolean;
    evidence: BoardEvidence;
  } | null;
}

interface Row {
  container_id: string;
  container_no: string;
  bl_no: string;
  cargo_type: 'FCL' | 'LCL';
  owner_company_id: string;
  my_company_id: string;
  my_role: string;
  event_id: string | null;
  event_type: EventType | null;
  occurred_at: Date | null;
  recorded_at: Date | null;
  source_type: 'person' | 'system' | null;
  source_ref: string | null;
  evidence_type: EvidenceKind | null;
  evidence_note: string | null;
  recorded_by_company_id: string | null;
  excerpt: string | null;
}

const EXCERPT_CHARS = 200;
const rank = (s: EventType | null) => (s === null ? -1 : EVENT_TYPES.indexOf(s));

/**
 * One row per container the acting user can see, furthest status first, oldest in status first within a status.
 * The shape depends on the database, not on the caller: row-level security decides which containers and events are
 * visible and which evidence text can be read (only the viewing company's own messages and documents); hauliers
 * additionally get no BL number.
 */
export async function loadBoard(c: CompanyClient, now: Date): Promise<BoardRow[]> {
  const { rows } = await c.query<Row>(
    `SELECT ct.id AS container_id, ct.container_no, ct.bl_no, ct.cargo_type, ct.company_id AS owner_company_id,
            app_company_id() AS my_company_id, app_role() AS my_role,
            cs.event_id, cs.event_type, cs.occurred_at, cs.recorded_at, cs.source_type, cs.source_ref,
            e.evidence_type, e.evidence_note, e.recorded_by_company_id,
            left(coalesce(m.body, d.text_content), ${EXCERPT_CHARS}) AS excerpt
     FROM containers ct
     LEFT JOIN container_current_status cs ON cs.container_id = ct.id
     LEFT JOIN events e ON e.id = cs.event_id
     LEFT JOIN messages m ON m.id = e.message_id
     LEFT JOIN documents d ON d.id = e.document_id`,
  );
  const board = rows.map((r): BoardRow => {
    const haulier = r.my_role === 'haulier_dispatcher';
    const last = r.event_id && r.recorded_at && r.source_type && r.source_ref && r.evidence_type ? r : null;
    return {
      containerId: r.container_id,
      containerNo: r.container_no,
      blNo: haulier ? null : r.bl_no,
      cargoType: r.cargo_type,
      owned: r.owner_company_id === r.my_company_id,
      status: r.event_type,
      statusSince: r.occurred_at,
      ageMs: r.occurred_at ? now.getTime() - r.occurred_at.getTime() : null,
      lastChange: last
        ? {
            eventId: last.event_id!,
            recordedAt: last.recorded_at!,
            source: { type: last.source_type!, ref: last.source_ref! },
            recordedByOwnCompany: last.recorded_by_company_id === r.my_company_id,
            evidence: {
              kind: last.evidence_type!,
              excerpt: last.excerpt,
              note: last.evidence_note,
            },
          }
        : null,
    };
  });
  return board.sort(
    (a, b) => rank(b.status) - rank(a.status) || (b.ageMs ?? 0) - (a.ageMs ?? 0) || a.containerNo.localeCompare(b.containerNo),
  );
}

// Timeline ---------------------------------------------------------------------------------------------

export interface TimelineEntry {
  eventId: string;
  eventType: EventType;
  occurredAt: Date;
  recordedAt: Date;
  source: { type: 'person' | 'system'; ref: string };
  recordedByOwnCompany: boolean;
  evidence: BoardEvidence;
  kind: 'live' | 'replaced' | 'voided' | 'void_row';
  /** For live entries: how long the container stayed in this status (until the next live event, or `now`). */
  spentMs: number | null;
}

interface EventRowT {
  id: string;
  event_type: EventType;
  occurred_at: Date;
  recorded_at: Date;
  source_type: 'person' | 'system';
  source_ref: string;
  evidence_type: EvidenceKind;
  evidence_note: string | null;
  recorded_by_company_id: string;
  corrects_event_id: string | null;
  correction_kind: 'replace' | 'void' | null;
  my_company_id: string;
  my_role: string;
  excerpt: string | null;
}

/**
 * The full story of one container: every event the viewer can see, with replaced and voided events marked (never
 * hidden), and, for the live ones, the time spent in each status. Spent time runs from an event's own time to the
 * next live event in time order (the last one runs to `now`); an event dated ahead of `now` spends nothing.
 */
export async function loadTimeline(c: CompanyClient, containerId: string, now: Date): Promise<TimelineEntry[]> {
  const { rows } = await c.query<EventRowT>(
    `SELECT e.id, e.event_type, e.occurred_at, e.recorded_at, e.source_type, e.source_ref, e.evidence_type, e.evidence_note,
            e.recorded_by_company_id, e.corrects_event_id, e.correction_kind,
            app_company_id() AS my_company_id, app_role() AS my_role,
            left(coalesce(m.body, d.text_content), ${EXCERPT_CHARS}) AS excerpt
     FROM events e
     LEFT JOIN messages m ON m.id = e.message_id
     LEFT JOIN documents d ON d.id = e.document_id
     WHERE e.container_id = $1
     ORDER BY e.seq`,
    [containerId],
  );
  const corrected = new Set(rows.flatMap((r) => (r.corrects_event_id ? [r.corrects_event_id] : [])));
  const voided = new Set(rows.flatMap((r) => (r.correction_kind === 'void' && r.corrects_event_id ? [r.corrects_event_id] : [])));
  const entries: TimelineEntry[] = rows.map((r) => ({
    eventId: r.id,
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    source: { type: r.source_type, ref: r.source_ref },
    recordedByOwnCompany: r.recorded_by_company_id === r.my_company_id,
    evidence: { kind: r.evidence_type, excerpt: r.excerpt, note: r.evidence_note },
    kind: r.correction_kind === 'void' ? 'void_row' : voided.has(r.id) ? 'voided' : corrected.has(r.id) ? 'replaced' : 'live',
    spentMs: null,
  }));
  const live = entries.filter((e) => e.kind === 'live').sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  live.forEach((e, i) => {
    const end = live[i + 1]?.occurredAt.getTime() ?? now.getTime();
    e.spentMs = Math.max(0, end - e.occurredAt.getTime());
  });
  return entries;
}
