import { EVENT_TYPES, EXAM_YARDS, ROLES, eventAllowed } from '../domain/statusChain.ts';
import type { EventType } from '../domain/statusChain.ts';
import { InvalidContainerNoError, normalizeContainerNo, parseContainerNo } from '../domain/iso6346.ts';
import {
  BOOLEAN_FIELDS,
  CHANNELS,
  DATE_FIELDS,
  DOC_TYPES,
  FIELD_NAMES,
  TIMESTAMP_FIELDS,
} from './types.ts';
import type {
  DocType,
  ExtractionInput,
  FailureReason,
  FieldName,
  Fields,
  Issue,
  RawExtraction,
  Suggestion,
  SuggestionEvidence,
} from './types.ts';

// Trusted, deterministic checks applied to whatever the model returned. The model proposes; this
// code decides what is acceptable (container check digit, grounding in the source text, closed
// vocabularies, valid dates). Used for extraction and again for values a person edits.

const COLOMBO_OFFSET = '+05:30';

const issue = (code: string, severity: Issue['severity'], message: string, field?: FieldName): Issue =>
  field ? { code, severity, message, field } : { code, severity, message };

function validCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  return d <= dim;
}

/** YYYY-MM-DD that is a real calendar date, or null. */
function parseDateOnly(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m || !validCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
  return m[0];
}

/** ISO 8601 timestamp with offset (Colombo +05:30 assumed when missing), or null. */
function parseTimestamp(v: string): { value: string; assumedOffset: boolean } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, off] = m;
  if (!validCalendarDate(Number(y), Number(mo), Number(d)) || Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59) return null;
  const value = `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${off ?? COLOMBO_OFFSET}`;
  if (Number.isNaN(Date.parse(value))) return null;
  return { value, assumedOffset: off === undefined };
}

const cleanText = (v: string) => v.replace(/\s+/g, ' ').trim();

/**
 * Normalise and validate raw field values. `sourceText` (extraction only) enables the grounding
 * check: a container number the text does not contain is dropped.
 */
export function normaliseFields(
  input: Partial<Record<FieldName, unknown>>,
  opts: { sourceText?: string } = {},
): { fields: Fields; issues: Issue[] } {
  const fields: Fields = {};
  const issues: Issue[] = [];

  for (const name of FIELD_NAMES) {
    const value = input[name];
    if (value === null || value === undefined) continue;

    if (BOOLEAN_FIELDS.includes(name)) {
      if (typeof value === 'boolean') fields[name] = value;
      else issues.push(issue('invalid_value', 'warning', `${name} must be true or false`, name));
      continue;
    }
    if (typeof value !== 'string' || cleanText(value) === '') {
      issues.push(issue('invalid_value', 'warning', `${name} must be a non-empty text value`, name));
      continue;
    }

    if (name === 'container_no') {
      let parsed: string;
      try {
        parsed = parseContainerNo(value);
      } catch (e) {
        if (!(e instanceof InvalidContainerNoError)) throw e;
        issues.push(issue('invalid_container_no', 'error', `"${cleanText(value)}" is not a valid ISO 6346 container number (check digit or format)`, name));
        continue;
      }
      if (opts.sourceText !== undefined && !normalizeContainerNo(opts.sourceText).includes(parsed)) {
        issues.push(issue('ungrounded_container_no', 'warning', `${parsed} does not appear in the source text`, name));
        continue;
      }
      fields[name] = parsed;
    } else if (DATE_FIELDS.includes(name)) {
      const d = parseDateOnly(value);
      if (d) fields[name] = d;
      else issues.push(issue('invalid_date', 'warning', `${name}: "${value}" is not a YYYY-MM-DD date`, name));
    } else if (TIMESTAMP_FIELDS.includes(name)) {
      const t = parseTimestamp(value);
      if (!t) issues.push(issue('invalid_date', 'warning', `${name}: "${value}" is not an ISO 8601 timestamp`, name));
      else {
        fields[name] = t.value;
        if (t.assumedOffset) issues.push(issue('assumed_colombo_time', 'info', `${name}: no offset given, assumed Asia/Colombo (+05:30)`, name));
      }
    } else if (name === 'channel') {
      const c = cleanText(value).toLowerCase();
      if ((CHANNELS as readonly string[]).includes(c)) fields[name] = c;
      else issues.push(issue('unknown_channel', 'warning', `unknown customs channel "${value}"`, name));
    } else if (name === 'exam_location') {
      const yard = EXAM_YARDS.find((y) => y.toLowerCase() === cleanText(value).toLowerCase());
      if (yard) fields[name] = yard;
      else issues.push(issue('unknown_exam_yard', 'warning', `unknown exam yard "${value}"`, name));
    } else {
      fields[name] = cleanText(value);
    }
  }
  return { fields, issues };
}

/** When the event happened, as far as the extracted fields say (the confirmer can change it). */
export function suggestOccurredAt(eventType: EventType | null, fields: Fields): Date | null {
  const instant = (v: unknown) => (typeof v === 'string' ? new Date(v) : null);
  switch (eventType) {
    case 'do_received':
      return typeof fields.do_date === 'string' ? new Date(`${fields.do_date}T00:00:00${COLOMBO_OFFSET}`) : null;
    case 'channel_assigned':
      return instant(fields.cusdec_registered_at);
    case 'release_advice':
      return instant(fields.advice_issued_at);
    case 'exam':
      return instant(fields.exam_scheduled_at);
    default:
      return null;
  }
}

function confirmableBy(eventType: EventType | null) {
  return eventType ? ROLES.filter((r) => eventAllowed(r, eventType)) : [];
}

export function buildSuggestion(raw: RawExtraction, input: ExtractionInput, evidence: SuggestionEvidence): Suggestion {
  const { fields, issues } = normaliseFields(raw.fields, { sourceText: input.text });

  let eventType: EventType | null = null;
  if (raw.suggestedEvent !== null && raw.suggestedEvent !== undefined) {
    if ((EVENT_TYPES as readonly string[]).includes(raw.suggestedEvent)) eventType = raw.suggestedEvent as EventType;
    else issues.push(issue('unknown_event_type', 'warning', `"${raw.suggestedEvent}" is not a status in the import chain`));
  } else {
    issues.push(issue('missing_event_type', 'warning', 'no event could be suggested from this text'));
  }

  const containerIssue = issues.some((i) => i.field === 'container_no');
  if (!fields.container_no && !containerIssue) {
    issues.push(issue('missing_container_no', 'warning', 'no container number found', 'container_no'));
  }

  const docType: DocType | null = (DOC_TYPES as readonly string[]).includes(raw.docType ?? '') ? (raw.docType as DocType) : null;

  const rejected = issues.some((i) => i.severity === 'error');
  const needsReview = issues.some((i) => i.severity === 'warning');
  const status: Suggestion['status'] = rejected ? 'rejected' : needsReview ? 'needs_review' : 'ready';

  return {
    status,
    eventType,
    docType,
    language: raw.language ?? null,
    fields,
    issues,
    suggestedOccurredAt: suggestOccurredAt(eventType, fields),
    confirmableBy: rejected ? [] : confirmableBy(eventType),
    evidence,
  };
}

/** A suggestion for an item the extractor could not process; a person handles it manually. */
export function failedSuggestion(reason: FailureReason, evidence: SuggestionEvidence): Suggestion {
  return {
    status: 'failed',
    eventType: null,
    docType: null,
    language: null,
    fields: {},
    issues: [issue('extraction_failed', 'error', `automatic extraction failed (${reason}); enter the details manually`)],
    suggestedOccurredAt: null,
    confirmableBy: [],
    evidence,
  };
}
