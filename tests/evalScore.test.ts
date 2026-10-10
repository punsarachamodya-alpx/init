import { describe, expect, test } from 'vitest';
import { dryRunExtractor, evaluate, formatReport, loadEvalItems } from '../src/intake/eval/index.ts';

const LABELS = new URL('../fixtures/labels.json', import.meta.url).pathname;
const items = loadEvalItems(LABELS);

describe('eval items come straight from fixtures/labels.json', () => {
  test('three documents and three messages, with the text read from the synthetic fixtures', () => {
    expect(items.map((i) => i.kind)).toEqual(['document', 'document', 'document', 'message', 'message', 'message']);
    expect(items[0]!.text).toContain('SYNTHETIC TEST DOCUMENT');
    expect(items[3]!.text).toBe('ZZZU1234564 DO kittu. CHA ge cusdec adha dannawa.');
    expect(items[3]).toMatchObject({ expectedEvent: 'do_received', language: 'si-latin' });
    expect(items[5]).toMatchObject({ expectedEvent: null, text: 'ZZZU9999999 reached the yard' });
  });

  test('the labels file is read-only input: it is not modified by loading', () => {
    expect(loadEvalItems(LABELS)).toEqual(items);
  });
});

describe('scorer: oracle extractor (scorer sanity, not a model result)', () => {
  test('scores 100% on every labelled field, event and document type, with no misses', async () => {
    const report = await evaluate(items, dryRunExtractor('oracle', items));
    expect(report.misses).toEqual([]);
    for (const [field, s] of Object.entries(report.perField)) expect(s.correct, field).toBe(s.total);
    expect(report.perField.container_no).toEqual({ correct: 6 - 1, total: 6 - 1 }); // the invalid-check-digit item labels no container
    expect(report.event).toEqual({ correct: 6, total: 6 });
    expect(report.docType).toEqual({ correct: 3, total: 3 });
  });

  test('the invalid-check-digit message is rejected, not saved', async () => {
    const report = await evaluate(items, dryRunExtractor('oracle', items));
    const invalid = report.items.find((i) => i.id === items[5]!.id)!;
    expect(invalid.suggestion.status).toBe('rejected');
    expect(invalid.passedEvent).toBe(true);
  });
});

describe('scorer: flawed extractor lists the planted misses', () => {
  test('reports per-field accuracy below 100% and names each miss', async () => {
    const report = await evaluate(items, dryRunExtractor('flawed', items));
    const key = (m: { item: string; field: string }) => `${m.item}:${m.field}`;
    const missed = report.misses.map(key);
    expect(missed).toEqual(expect.arrayContaining([`${items[0]!.id}:bl_no`, `${items[1]!.id}:channel`, `${items[2]!.id}:vessel`, `${items[3]!.id}:event`]));
    expect(report.perField.bl_no).toEqual({ correct: 2, total: 3 });
    expect(report.perField.channel.correct).toBeLessThan(report.perField.channel.total);
    const miss = report.misses.find((m) => m.field === 'bl_no')!;
    expect(miss).toMatchObject({ expected: 'ESLCMB000101' });
    expect(miss.got).not.toBe('ESLCMB000101');
  });

  test('a model that proposes an event for the invalid container still cannot get it past the deterministic check', async () => {
    const report = await evaluate(items, dryRunExtractor('flawed', items));
    const invalid = report.items.find((i) => i.id === items[5]!.id)!;
    expect(invalid.suggestion.status).toBe('rejected');
    expect(report.misses.map((m) => m.item)).not.toContain(items[5]!.id);
  });

  test('unlabelled extras are listed for information, not counted as misses', async () => {
    const report = await evaluate(items, dryRunExtractor('flawed', items));
    expect(Array.isArray(report.extras)).toBe(true);
  });

  test('the printed report has the per-field table and the misses', async () => {
    const text = formatReport(await evaluate(items, dryRunExtractor('flawed', items)));
    expect(text).toMatch(/PER-FIELD ACCURACY/);
    expect(text).toMatch(/bl_no\s+2\/3/);
    expect(text).toMatch(/MISSES/);
    expect(text).toMatch(/expected "ESLCMB000101"/);
  });
});
