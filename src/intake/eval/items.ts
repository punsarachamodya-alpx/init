import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface EvalItem {
  id: string;
  kind: 'document' | 'message';
  text: string;
  docType?: string;
  language?: string;
  /** null = no event may be suggested as ready (e.g. the invalid check-digit message). */
  expectedEvent: string | null;
  expectedFields: Record<string, string | boolean>;
  note?: string;
}

interface LabelsFile {
  documents: Array<{ file: string; doc_type: string; expected_event: string; fields: Record<string, string | boolean> }>;
  messages: Array<{ text: string; language?: string; expected_event: string | null; fields: Record<string, string | boolean>; note?: string }>;
}

/** Read the ground truth. fixtures/labels.json is input only; this code never writes it. */
export function loadEvalItems(labelsPath: string): EvalItem[] {
  const labels = JSON.parse(readFileSync(labelsPath, 'utf8')) as LabelsFile;
  const base = path.dirname(labelsPath);
  const docs: EvalItem[] = labels.documents.map((d) => ({
    id: path.basename(d.file, path.extname(d.file)),
    kind: 'document',
    text: readFileSync(path.resolve(base, d.file), 'utf8'),
    docType: d.doc_type,
    expectedEvent: d.expected_event,
    expectedFields: d.fields,
  }));
  const msgs: EvalItem[] = labels.messages.map((m, i) => ({
    id: `message-${i + 1}`,
    kind: 'message',
    text: m.text,
    ...(m.language ? { language: m.language } : {}),
    expectedEvent: m.expected_event,
    expectedFields: m.fields,
    ...(m.note ? { note: m.note } : {}),
  }));
  return [...docs, ...msgs];
}
