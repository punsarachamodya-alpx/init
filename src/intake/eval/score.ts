import { buildSuggestion, failedSuggestion } from '../suggest.ts';
import { ExtractionFailedError, FIELD_NAMES } from '../types.ts';
import type { Extractor, FieldName, Suggestion } from '../types.ts';
import { DATE_FIELDS, TIMESTAMP_FIELDS } from '../types.ts';
import type { EvalItem } from './items.ts';

export interface FieldScore {
  correct: number;
  total: number;
}
export interface Miss {
  item: string;
  /** A field name, 'event', 'doc_type' or 'status'. */
  field: string;
  expected: unknown;
  got: unknown;
}
export interface ItemResult {
  id: string;
  suggestion: Suggestion;
  /** Expected event suggested; or, when none is expected, the item is not ready to confirm. */
  passedEvent: boolean;
}
export interface EvalReport {
  items: ItemResult[];
  perField: Record<FieldName, FieldScore>;
  event: FieldScore;
  docType: FieldScore;
  misses: Miss[];
  /** Fields extracted that the labels do not mention. Informational, not misses. */
  extras: Array<{ item: string; field: string; got: unknown }>;
}

const norm = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().toLowerCase() : v);

function sameValue(field: string, expected: unknown, got: unknown): boolean {
  if (got === undefined || got === null) return false;
  if ((TIMESTAMP_FIELDS as readonly string[]).includes(field)) {
    return typeof expected === 'string' && typeof got === 'string' && Date.parse(expected) === Date.parse(got);
  }
  if ((DATE_FIELDS as readonly string[]).includes(field)) return expected === got;
  return norm(expected) === norm(got);
}

/** Run the extractor and the deterministic checks over every item, then score against the labels. */
export async function evaluate(items: EvalItem[], extractor: Extractor): Promise<EvalReport> {
  const perField = Object.fromEntries(FIELD_NAMES.map((f) => [f, { correct: 0, total: 0 }])) as Record<FieldName, FieldScore>;
  const report: EvalReport = {
    items: [],
    perField,
    event: { correct: 0, total: 0 },
    docType: { correct: 0, total: 0 },
    misses: [],
    extras: [],
  };

  for (const item of items) {
    const input = { kind: item.kind, text: item.text } as const;
    const evidence = { type: 'message', messageId: `eval:${item.id}` } as const;
    let suggestion: Suggestion;
    try {
      suggestion = buildSuggestion(await extractor.extract(input), input, evidence);
    } catch (err) {
      if (!(err instanceof ExtractionFailedError)) throw err;
      suggestion = failedSuggestion(err.reason, evidence);
    }

    // event
    report.event.total++;
    const passedEvent = item.expectedEvent === null ? suggestion.status !== 'ready' : suggestion.eventType === item.expectedEvent;
    if (passedEvent) report.event.correct++;
    else {
      report.misses.push(
        item.expectedEvent === null
          ? { item: item.id, field: 'status', expected: 'not ready (rejected or needs review)', got: suggestion.status }
          : { item: item.id, field: 'event', expected: item.expectedEvent, got: suggestion.eventType },
      );
    }

    // document type (documents only)
    if (item.docType) {
      report.docType.total++;
      if (suggestion.docType === item.docType) report.docType.correct++;
      else report.misses.push({ item: item.id, field: 'doc_type', expected: item.docType, got: suggestion.docType });
    }

    // labelled fields
    for (const [field, expected] of Object.entries(item.expectedFields)) {
      const name = field as FieldName;
      const got = suggestion.fields[name];
      perField[name].total++;
      if (sameValue(field, expected, got)) perField[name].correct++;
      else report.misses.push({ item: item.id, field, expected, got: got ?? null });
    }
    for (const [field, got] of Object.entries(suggestion.fields)) {
      if (!(field in item.expectedFields)) report.extras.push({ item: item.id, field, got });
    }
    report.items.push({ id: item.id, suggestion, passedEvent });
  }
  return report;
}

const pct = (s: FieldScore) => (s.total === 0 ? '  n/a' : `${((100 * s.correct) / s.total).toFixed(0).padStart(4)}%`);

export function formatReport(r: EvalReport): string {
  const lines: string[] = [];
  lines.push('INTAKE EXTRACTION EVAL');
  lines.push('');
  lines.push('PER-FIELD ACCURACY (labelled fields only)');
  for (const f of FIELD_NAMES) {
    const s = r.perField[f];
    if (s.total > 0) lines.push(`  ${f.padEnd(22)} ${`${s.correct}/${s.total}`.padEnd(6)} ${pct(s)}`);
  }
  lines.push('');
  lines.push(`  ${'event suggested'.padEnd(22)} ${`${r.event.correct}/${r.event.total}`.padEnd(6)} ${pct(r.event)}`);
  lines.push(`  ${'document type'.padEnd(22)} ${`${r.docType.correct}/${r.docType.total}`.padEnd(6)} ${pct(r.docType)}`);
  lines.push('');
  lines.push('ITEMS');
  for (const i of r.items) {
    const s = i.suggestion;
    lines.push(`  ${i.passedEvent ? 'ok  ' : 'MISS'} ${i.id.padEnd(34)} status=${s.status.padEnd(12)} event=${s.eventType ?? '-'}${s.issues.length ? `  issues=${s.issues.map((x) => x.code).join(',')}` : ''}`);
  }
  lines.push('');
  lines.push(`MISSES (${r.misses.length})`);
  if (r.misses.length === 0) lines.push('  none');
  for (const m of r.misses) lines.push(`  ${m.item} ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.got)}`);
  if (r.extras.length > 0) {
    lines.push('');
    lines.push(`UNLABELLED EXTRAS (${r.extras.length}, informational)`);
    for (const e of r.extras) lines.push(`  ${e.item} ${e.field}: ${JSON.stringify(e.got)}`);
  }
  return lines.join('\n');
}
