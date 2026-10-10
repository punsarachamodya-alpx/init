import type { CompanyClient } from '../db/withCompany.ts';
import { intake } from './intake.ts';
import type { IntakeInput } from './intake.ts';
import { rolesFor } from './suggest.ts';
import type { DocType, Extractor, Fields, Issue, Suggestion, SuggestionEvidence } from './types.ts';
import type { EventType } from '../domain/statusChain.ts';

// Persistence for suggestions (company-private, immutable). Nothing here writes the event ledger: that stays
// in confirm.ts. The server loads a suggestion's status, evidence and fields from here; callers never supply them.

export interface StoredSuggestion {
  id: string;
  suggestion: Suggestion;
  extractor: string;
  createdByUserId: string;
  createdAt: Date;
}

export interface InboxItem extends StoredSuggestion {
  /** First characters of the evidence text, for the inbox card. */
  excerpt: string;
}

interface Row {
  id: string;
  message_id: string | null;
  document_id: string | null;
  status: Suggestion['status'];
  event_type: EventType | null;
  doc_type: DocType | null;
  language: string | null;
  fields: Fields;
  issues: Issue[];
  suggested_occurred_at: Date | null;
  extractor: string;
  created_by_user_id: string;
  created_at: Date;
  excerpt?: string;
}

const COLUMNS = `s.id, s.message_id, s.document_id, s.status, s.event_type, s.doc_type, s.language, s.fields, s.issues,
  s.suggested_occurred_at, s.extractor, s.created_by_user_id, s.created_at`;

function toStored(r: Row): StoredSuggestion {
  const evidence: SuggestionEvidence = r.message_id
    ? { type: 'message', messageId: r.message_id }
    : { type: 'document', documentId: r.document_id! };
  const rejectedOrFailed = r.status === 'rejected' || r.status === 'failed';
  return {
    id: r.id,
    extractor: r.extractor,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    suggestion: {
      status: r.status,
      eventType: r.event_type,
      docType: r.doc_type,
      language: r.language,
      fields: r.fields,
      issues: r.issues,
      suggestedOccurredAt: r.suggested_occurred_at,
      confirmableBy: rejectedOrFailed ? [] : rolesFor(r.event_type),
      evidence,
    },
  };
}

export async function saveSuggestion(c: CompanyClient, s: Suggestion, extractor: string): Promise<StoredSuggestion> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO intake_suggestions (company_id, message_id, document_id, status, event_type, doc_type, language, fields, issues,
                                     suggested_occurred_at, extractor)
     VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      s.evidence.type === 'message' ? s.evidence.messageId : null,
      s.evidence.type === 'document' ? s.evidence.documentId : null,
      s.status,
      s.eventType,
      s.docType,
      s.language,
      JSON.stringify(s.fields),
      JSON.stringify(s.issues),
      s.suggestedOccurredAt,
      extractor,
    ],
  );
  const loaded = await loadSuggestion(c, rows[0]!.id);
  return loaded!;
}

export async function loadSuggestion(c: CompanyClient, id: string): Promise<StoredSuggestion | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await c.query<Row>(`SELECT ${COLUMNS} FROM intake_suggestions s WHERE s.id = $1`, [id]);
  return rows[0] ? toStored(rows[0]) : null;
}

/** Store the evidence, extract, and persist the suggestion in one go. Never writes the event ledger. */
export async function intakeAndStore(c: CompanyClient, extractor: Extractor, input: IntakeInput, label: string): Promise<StoredSuggestion> {
  return saveSuggestion(c, await intake(c, extractor, input), label);
}

const UNDECIDED = `NOT EXISTS (SELECT 1 FROM intake_decisions d WHERE d.suggestion_id = s.id)`;
const EXCERPT = `left(coalesce(m.body, doc.text_content, ''), 280) AS excerpt`;
const FROM = `FROM intake_suggestions s
  LEFT JOIN messages m ON m.id = s.message_id
  LEFT JOIN documents doc ON doc.id = s.document_id`;

/** Suggestions nobody has decided yet, newest first. */
export async function listInbox(c: CompanyClient, opts: { limit?: number } = {}): Promise<InboxItem[]> {
  const { rows } = await c.query<Row>(
    `SELECT ${COLUMNS}, ${EXCERPT} ${FROM} WHERE ${UNDECIDED} ORDER BY s.seq DESC LIMIT $1`,
    [opts.limit ?? 100],
  );
  return rows.map((r) => ({ ...toStored(r), excerpt: r.excerpt ?? '' }));
}

/** Undecided suggestions created before `olderThan` (for reminders). */
export async function listStaleUndecided(c: CompanyClient, olderThan: Date): Promise<InboxItem[]> {
  const { rows } = await c.query<Row>(
    `SELECT ${COLUMNS}, ${EXCERPT} ${FROM} WHERE ${UNDECIDED} AND s.created_at < $1 ORDER BY s.seq`,
    [olderThan],
  );
  return rows.map((r) => ({ ...toStored(r), excerpt: r.excerpt ?? '' }));
}

/** The text a suggestion was extracted from (company-private evidence). */
export async function loadEvidenceText(c: CompanyClient, evidence: SuggestionEvidence): Promise<string | null> {
  const { rows } =
    evidence.type === 'message'
      ? await c.query<{ t: string }>('SELECT body AS t FROM messages WHERE id = $1', [evidence.messageId])
      : await c.query<{ t: string }>('SELECT text_content AS t FROM documents WHERE id = $1', [evidence.documentId]);
  return rows[0]?.t ?? null;
}
