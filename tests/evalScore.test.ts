import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { EvalAbortedError, dryRunExtractor, evaluate, formatReport, loadEvalItems, resolveLabelsPath } from '../src/intake/eval/index.ts';
import { ExtractionFailedError } from '../src/intake/index.ts';
import type { Extractor } from '../src/intake/index.ts';

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

  test('fixtures/labels.json is the uploaded ground truth, unchanged (SHA-256 pinned)', () => {
    const sha = createHash('sha256').update(readFileSync(LABELS)).digest('hex');
    expect(sha).toBe('77a1b831e4512b133623e9088726e959252781c7131d63e40ba3e739685624a4');
  });

  test('a custom labels file must live inside fixtures/', () => {
    const fixtures = new URL('../fixtures/', import.meta.url).pathname;
    expect(resolveLabelsPath(undefined, fixtures)).toBe(`${fixtures}labels.json`);
    expect(resolveLabelsPath('more-labels.json', fixtures)).toBe(`${fixtures}more-labels.json`);
    expect(() => resolveLabelsPath('../../etc/passwd', fixtures)).toThrow(/inside fixtures/);
    expect(() => resolveLabelsPath('/etc/passwd', fixtures)).toThrow(/inside fixtures/);
  });
});

describe('scorer: oracle extractor (scorer sanity, not a model result)', () => {
  test('scores 100% on every labelled field, event and document type, with no misses', async () => {
    const report = await evaluate(items, dryRunExtractor('oracle', items), { label: 'DRY RUN (oracle)' });
    expect(report.misses).toEqual([]);
    for (const [field, s] of Object.entries(report.perField)) expect(s.correct, field).toBe(s.total);
    expect(report.perField.container_no).toEqual({ correct: 6 - 1, total: 6 - 1 }); // the invalid-check-digit item labels no container
    expect(report.event).toEqual({ correct: 6, total: 6 });
    expect(report.docType).toEqual({ correct: 3, total: 3 });
  });

  test('the invalid-check-digit message is rejected, not saved', async () => {
    const report = await evaluate(items, dryRunExtractor('oracle', items), { label: 'DRY RUN (oracle)' });
    const invalid = report.items.find((i) => i.id === items[5]!.id)!;
    expect(invalid.suggestion.status).toBe('rejected');
    expect(invalid.passedEvent).toBe(true);
  });
});

describe('the eval is honest about failures and about what it is', () => {
  const oracle = dryRunExtractor('oracle', items);
  const failingOn = (index: number, error: Error): Extractor => ({
    extract: async (input) => {
      if (input.text === items[index]!.text) throw error;
      return oracle.extract(input);
    },
  });

  test.each(['api_error', 'invalid_output'] as const)('%s aborts the whole eval instead of scoring a false 0%%', async (reason) => {
    const cause = Object.assign(new Error('401 invalid x-api-key'), { status: 401 });
    await expect(evaluate(items, failingOn(1, new ExtractionFailedError(reason, { cause })), { label: 'REAL RUN' })).rejects.toBeInstanceOf(EvalAbortedError);
    await expect(evaluate(items, failingOn(1, new ExtractionFailedError(reason, { cause })), { label: 'REAL RUN' })).rejects.toThrow(/401 invalid x-api-key/);
  });

  test('the abort message never contains the document text', async () => {
    const err = await evaluate(items, failingOn(0, new ExtractionFailedError('api_error', { cause: new Error('boom') })), { label: 'REAL RUN' }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('SYNTHETIC TEST DOCUMENT');
  });

  test('a refusal or max_tokens on one item is an item-level miss, and the run continues', async () => {
    const report = await evaluate(items, failingOn(1, new ExtractionFailedError('refusal')), { label: 'REAL RUN' });
    expect(report.items).toHaveLength(6);
    expect(report.misses.some((m) => m.item === items[1]!.id)).toBe(true);
    expect(report.items[1]!.suggestion.status).toBe('failed');
  });

  test('an item that expects no event passes only when it is rejected for the invalid container', async () => {
    const report = await evaluate(items, failingOn(5, new ExtractionFailedError('refusal')), { label: 'REAL RUN' });
    expect(report.items[5]!.passedEvent).toBe(false);
    expect(report.misses).toContainEqual(expect.objectContaining({ item: items[5]!.id, field: 'status' }));
  });

  test('the report says what kind of run it is, and counts unlabelled extras', async () => {
    const dry = formatReport(await evaluate(items, oracle, { label: 'DRY RUN (oracle) - NOT MODEL RESULTS' }));
    expect(dry.split('\n')[0]).toMatch(/DRY RUN .*NOT MODEL RESULTS/);
    expect(dry).toMatch(/unlabelled extras: \d+/);
    expect(dry).toMatch(/case-insensitive/);
  });
});

describe('scorer: flawed extractor lists the planted misses', () => {
  test('reports per-field accuracy below 100% and names each miss', async () => {
    const report = await evaluate(items, dryRunExtractor('flawed', items), { label: 'DRY RUN (flawed)' });
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
    const report = await evaluate(items, dryRunExtractor('flawed', items), { label: 'DRY RUN (flawed)' });
    const invalid = report.items.find((i) => i.id === items[5]!.id)!;
    expect(invalid.suggestion.status).toBe('rejected');
    expect(report.misses.map((m) => m.item)).not.toContain(items[5]!.id);
  });

  test('unlabelled extras are listed for information, not counted as misses', async () => {
    const report = await evaluate(items, dryRunExtractor('flawed', items), { label: 'DRY RUN (flawed)' });
    expect(Array.isArray(report.extras)).toBe(true);
  });

  test('the printed report has the per-field table and the misses', async () => {
    const text = formatReport(await evaluate(items, dryRunExtractor('flawed', items), { label: 'DRY RUN (flawed)' }));
    expect(text).toMatch(/PER-FIELD ACCURACY/);
    expect(text).toMatch(/bl_no\s+2\/3/);
    expect(text).toMatch(/MISSES/);
    expect(text).toMatch(/expected "ESLCMB000101"/);
  });
});
