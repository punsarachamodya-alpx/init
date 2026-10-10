import type { EventType, RoleName } from '../domain/statusChain.ts';

// Fields the extractor may report. All are optional: a field the text does not state is null.
export const FIELD_NAMES = [
  'container_no',
  'bl_no',
  'vessel',
  'voyage',
  'consignee',
  'importer',
  'cha',
  'do_date',
  'do_valid_until',
  'freight_paid',
  'channel',
  'advice_issued_at',
  'storage_free_until',
  'cusdec_registered_at',
  'exam_location',
  'exam_scheduled_at',
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

/** Calendar dates (YYYY-MM-DD), Asia/Colombo. */
export const DATE_FIELDS: readonly FieldName[] = ['do_date', 'do_valid_until', 'storage_free_until'];
/** Instants: ISO 8601 with an offset (Asia/Colombo is +05:30). */
export const TIMESTAMP_FIELDS: readonly FieldName[] = ['advice_issued_at', 'cusdec_registered_at', 'exam_scheduled_at'];
export const BOOLEAN_FIELDS: readonly FieldName[] = ['freight_paid'];

export const DOC_TYPES = ['delivery_order', 'delivery_advice', 'cusdec_summary', 'other'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const CHANNELS = ['green', 'yellow', 'red', 'blue'] as const;

export type FieldValue = string | boolean;
/** Validated, normalised, non-null fields. */
export type Fields = Partial<Record<FieldName, FieldValue>>;

/** What the model returned, before any deterministic checking. */
export interface RawExtraction {
  docType: string | null;
  suggestedEvent: string | null;
  language: string | null;
  fields: Partial<Record<FieldName, FieldValue | null>>;
  notes: string | null;
}

export interface ExtractionInput {
  kind: 'message' | 'document';
  text: string;
}

export interface Extractor {
  extract(input: ExtractionInput): Promise<RawExtraction>;
}

export type FailureReason = 'refusal' | 'max_tokens' | 'invalid_output' | 'api_error';

/** The extractor could not produce a usable result. A person handles the item manually. */
export class ExtractionFailedError extends Error {
  readonly reason: FailureReason;
  constructor(reason: FailureReason, options?: { cause?: unknown }) {
    super(`extraction failed: ${reason}`, options);
    this.name = 'ExtractionFailedError';
    this.reason = reason;
  }
}

export interface Issue {
  code: string;
  severity: 'info' | 'warning' | 'error';
  field?: FieldName;
  message: string;
}

export type SuggestionEvidence = { type: 'message'; messageId: string } | { type: 'document'; documentId: string };

/**
 * A SUGGESTED event. Nothing here is in the ledger: a person must confirm it
 * (see confirm.ts), and a rejected or failed suggestion can never be confirmed.
 */
export interface Suggestion {
  status: 'ready' | 'needs_review' | 'rejected' | 'failed';
  eventType: EventType | null;
  docType: DocType | null;
  language: string | null;
  fields: Fields;
  issues: Issue[];
  suggestedOccurredAt: Date | null;
  /** Roles whose permission matrix lets them record this event type. */
  confirmableBy: RoleName[];
  evidence: SuggestionEvidence;
}
