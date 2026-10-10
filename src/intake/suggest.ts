import { EVENT_TYPES, EXAM_YARDS, ROLES, eventAllowed } from '../domain/statusChain.ts';
import type { EventType } from '../domain/statusChain.ts';
import { InvalidContainerNoError, isValidContainerNo, parseContainerNo } from '../domain/iso6346.ts';
import { CHANNELS } from '../domain/statusChain.ts';
import {
  BOOLEAN_FIELDS,
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

const MIN_YEAR = 2000;

function validCalendarDate(y: number, m: number, d: number): boolean {
  if (y < MIN_YEAR || y > 2100 || m < 1 || m > 12 || d < 1) return false;
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

// --- Trusted scan of the source text -------------------------------------------------------------
// Container-shaped tokens: 4 letters (4th is U, J or Z per ISO 6346) + 6 digits + check digit, with at
// most one space or hyphen in each gap, delimited so they are not part of a longer alphanumeric run.
const CONTAINER_TOKEN = /(?<![A-Za-z0-9])([A-Za-z]{3}[UJZujz])[ -]?(\d{6})[ -]?(\d)(?![A-Za-z0-9])/g;

export function scanContainerTokens(text: string): { valid: string[]; invalid: string[] } {
  const valid = new Set<string>();
  const invalid = new Set<string>();
  for (const m of text.matchAll(CONTAINER_TOKEN)) {
    const token = `${m[1]}${m[2]}${m[3]}`.toUpperCase();
    (isValidContainerNo(token) ? valid : invalid).add(token);
  }
  return { valid: [...valid], invalid: [...invalid] };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Common ways a YYYY-MM-DD date is printed (day-first, ISO, month names). */
function dateRenderings(isoDate: string): string[] {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const name = MONTHS[m - 1]!;
  const abbr = name.slice(0, 3);
  return [
    `${y}-${mm}-${dd}`, `${y}/${mm}/${dd}`,
    `${dd}/${mm}/${y}`, `${d}/${m}/${y}`, `${dd}-${mm}-${y}`, `${dd}.${mm}.${y}`,
    `${d} ${name} ${y}`, `${dd} ${abbr} ${y}`, `${d} ${abbr} ${y}`, `${d}-${abbr}-${y}`, `${dd}-${abbr}-${y}`,
    `${name} ${d}, ${y}`, `${abbr} ${d}, ${y}`, `${name} ${d} ${y}`,
  ];
}

const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function containsToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i').test(text);
}


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
      if (opts.sourceText !== undefined && !scanContainerTokens(opts.sourceText).valid.includes(parsed)) {
        issues.push(issue('ungrounded_container_no', 'warning', `${parsed} does not appear in the source text as a container number`, name));
        continue;
      }
      fields[name] = parsed;
    } else if (DATE_FIELDS.includes(name)) {
      const d = parseDateOnly(value);
      if (!d) issues.push(issue('invalid_date', 'warning', `${name}: "${value}" is not a YYYY-MM-DD date`, name));
      else {
        fields[name] = d;
        if (opts.sourceText !== undefined && !groundedDate(opts.sourceText, d)) {
          issues.push(issue('ungrounded_date', 'warning', `${name}: ${d} does not appear in the source text; check it`, name));
        }
      }
    } else if (TIMESTAMP_FIELDS.includes(name)) {
      const t = parseTimestamp(value);
      if (!t) issues.push(issue('invalid_date', 'warning', `${name}: "${value}" is not an ISO 8601 timestamp`, name));
      else {
        fields[name] = t.value;
        if (opts.sourceText !== undefined && !groundedDate(opts.sourceText, t.value.slice(0, 10))) {
          issues.push(issue('ungrounded_date', 'warning', `${name}: ${t.value.slice(0, 10)} does not appear in the source text; check it`, name));
        }
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
    } else if (name === 'bl_no') {
      const bl = cleanText(value);
      if (opts.sourceText !== undefined && !containsToken(opts.sourceText, bl)) {
        issues.push(issue('ungrounded_bl_no', 'warning', `B/L ${bl} does not appear in the source text`, name));
      } else fields[name] = bl;
    } else {
      const v = cleanText(value);
      fields[name] = v;
      if ((name === 'vessel' || name === 'voyage') && opts.sourceText !== undefined && !squash(opts.sourceText).includes(squash(v))) {
        issues.push(issue('ungrounded_value', 'warning', `${name} "${v}" does not appear in the source text; check it`, name));
      }
    }
  }
  return { fields, issues };
}

function groundedDate(text: string, isoDate: string): boolean {
  const hay = text.toLowerCase();
  return dateRenderings(isoDate).some((r) => hay.includes(r.toLowerCase()));
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

  // The model is not trusted to report a bad container: scan the text itself.
  const scan = scanContainerTokens(input.text);
  for (const bad of scan.invalid) {
    if (!issues.some((i) => i.code === 'invalid_container_no' && i.message.includes(bad))) {
      issues.push(issue('invalid_container_no', 'error', `"${bad}" in the text is not a valid ISO 6346 container number (check digit)`, 'container_no'));
    }
  }
  if (scan.valid.length > 1) {
    issues.push(issue('multiple_containers', 'warning', `the text mentions several containers (${scan.valid.join(', ')}); pick one`, 'container_no'));
  }

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
