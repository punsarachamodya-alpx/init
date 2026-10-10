import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { grantAccess } from '../src/access/access.ts';
import { loadBoard, loadTimeline } from '../src/board/board.ts';
import { closeAppPool } from '../src/db/pool.ts';
import { withActor } from '../src/db/withActor.ts';
import type { EventType } from '../src/domain/statusChain.ts';
import { formatAge, formatColombo } from '../src/i18n/format.ts';
import { appendCorrection, appendEvent, createContainer, voidEvent } from '../src/ledger/ledger.ts';
import { newBl, seedActor, seedMessage, validContainerNo } from './helpers.ts';
import type { TestActor } from './helpers.ts';

const NOW = new Date('2026-10-20T06:00:00Z');
const at = (iso: string) => new Date(iso);
const person = { type: 'person', ref: 'synthetic' } as const;

let cha: TestActor;
let client: TestActor;
let haulier: TestActor;
let other: TestActor; // an unrelated CHA

let msgId: string;
let id: { fresh: string; mid: string; late: string; empty: string };
let no: Record<keyof typeof id, string>;

async function ev(actor: TestActor, containerId: string, eventType: EventType, iso: string, evidence: Parameters<typeof appendEvent>[1]['evidence']) {
  return withActor(actor, (c) => appendEvent(c, { containerId, eventType, occurredAt: at(iso), source: person, evidence }));
}

beforeAll(async () => {
  cha = await seedActor('cha');
  client = await seedActor('client');
  haulier = await seedActor('haulier');
  other = await seedActor('cha');
  msgId = await seedMessage(cha, 'ZZZU0000000 DO kittu. This message text is private to the CHA company.');
  const make = (c: Parameters<Parameters<typeof withActor>[1]>[0]) => createContainer(c, { blNo: newBl(), containerNo: validContainerNo() });
  const made = await withActor(cha, async (c) => ({ fresh: await make(c), mid: await make(c), late: await make(c), empty: await make(c) }));
  id = { fresh: made.fresh.id, mid: made.mid.id, late: made.late.id, empty: made.empty.id };
  no = { fresh: made.fresh.containerNo, mid: made.mid.containerNo, late: made.late.containerNo, empty: made.empty.containerNo };

  await ev(cha, id.fresh, 'vessel_discharged', '2026-10-19T06:00:00Z', { type: 'manual', note: 'synthetic' });
  await ev(cha, id.mid, 'do_received', '2026-10-15T06:00:00Z', { type: 'message', messageId: msgId });
  await ev(cha, id.mid, 'cusdec_lodged', '2026-10-17T03:30:00Z', { type: 'manual', note: 'lodged by CHA' });
  await ev(cha, id.late, 'release_advice', '2026-10-18T00:00:00Z', { type: 'manual', note: 'e-DA received' });
  // client and haulier see only "late"
  await withActor(cha, async (c) => {
    await grantAccess(c, { containerId: id.late, granteeCompanyId: client.companyId, kind: 'client' });
    await grantAccess(c, { containerId: id.late, granteeCompanyId: haulier.companyId, kind: 'haulier' });
  });
  await ev(haulier, id.late, 'gate_pass', '2026-10-19T02:00:00Z', { type: 'manual', note: 'gate pass shown on phone' });
});
afterAll(closeAppPool);

describe('the CHA board', () => {
  test('lists every container, furthest status first, with the age in that status from the injected clock', async () => {
    const board = await withActor(cha, (c) => loadBoard(c, NOW));
    const mine = board.filter((r) => Object.values(no).includes(r.containerNo));
    expect(mine.map((r) => [r.containerNo, r.status])).toEqual([
      [no.late, 'gate_pass'],
      [no.mid, 'cusdec_lodged'],
      [no.fresh, 'vessel_discharged'],
      [no.empty, null],
    ]);
    const mid = mine.find((r) => r.containerNo === no.mid)!;
    expect(mid.ageMs).toBe(NOW.getTime() - at('2026-10-17T03:30:00Z').getTime());
    expect(mid.owned).toBe(true);
    expect(mine.find((r) => r.containerNo === no.empty)).toMatchObject({ status: null, ageMs: null, lastChange: null });
  });

  test('shows the evidence of the last change: its type, who recorded it, and the text the CHA owns', async () => {
    const board = await withActor(cha, (c) => loadBoard(c, NOW));
    const late = board.find((r) => r.containerNo === no.late)!;
    expect(late.lastChange).toMatchObject({ source: person, recordedByOwnCompany: false, evidence: { kind: 'manual', note: 'gate pass shown on phone', excerpt: null } });
    // the cusdec on "mid" is manual; point a message-backed stage at another container to see an excerpt
    const m = await withActor(cha, async (c) => {
      const k = await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() });
      await appendEvent(c, { containerId: k.id, eventType: 'do_received', occurredAt: at('2026-10-16T00:00:00Z'), source: person, evidence: { type: 'message', messageId: msgId } });
      return k;
    });
    const row = (await withActor(cha, (c) => loadBoard(c, NOW))).find((r) => r.containerNo === m.containerNo)!;
    expect(row.lastChange).toMatchObject({ recordedByOwnCompany: true, evidence: { kind: 'message', excerpt: expect.stringContaining('private to the CHA company') } });
    expect(row.lastChange!.evidence.excerpt!.length).toBeLessThanOrEqual(200);
  });

  test('a voided stage drops back to the previous one; a container with only voided events has no status', async () => {
    const k = await withActor(cha, (c) => createContainer(c, { blNo: newBl(), containerNo: validContainerNo() }));
    const a = await ev(cha, k.id, 'do_received', '2026-10-10T00:00:00Z', { type: 'manual', note: 'a' });
    const b = await ev(cha, k.id, 'cusdec_lodged', '2026-10-11T00:00:00Z', { type: 'manual', note: 'b' });
    const rowOf = async () => (await withActor(cha, (c) => loadBoard(c, NOW))).find((r) => r.containerNo === k.containerNo)!;
    expect((await rowOf()).status).toBe('cusdec_lodged');
    await withActor(cha, (c) => voidEvent(c, b.id, { source: person, evidence: { type: 'manual', note: 'wrong container' } }));
    expect((await rowOf()).status).toBe('do_received');
    await withActor(cha, (c) => voidEvent(c, a.id, { source: person, evidence: { type: 'manual', note: 'wrong container' } }));
    expect(await rowOf()).toMatchObject({ status: null, lastChange: null });
  });

  test('another CHA sees none of it', async () => {
    const board = await withActor(other, (c) => loadBoard(c, NOW));
    expect(board.filter((r) => Object.values(no).includes(r.containerNo))).toEqual([]);
  });
});

describe('role shaping comes from the database', () => {
  test('the client sees only the shared container, with no text from the CHA\'s own messages', async () => {
    const board = await withActor(client, (c) => loadBoard(c, NOW));
    expect(board.map((r) => r.containerNo)).toEqual([no.late]);
    expect(board[0]).toMatchObject({ owned: false, status: 'gate_pass', blNo: expect.any(String) });
    expect(board[0]!.lastChange!.evidence.excerpt).toBeNull();
  });

  test('the haulier sees only its job and no BL number, and never evidence text', async () => {
    const board = await withActor(haulier, (c) => loadBoard(c, NOW));
    expect(board.map((r) => r.containerNo)).toEqual([no.late]);
    expect(board[0]).toMatchObject({ blNo: null, owned: false });
    expect(board[0]!.lastChange!.evidence.excerpt).toBeNull();
    expect(JSON.stringify(board)).not.toMatch(/private to the CHA/);
  });
});

describe('the container timeline', () => {
  test('time spent in each status runs to the next live event, the last one to now', async () => {
    const t = await withActor(cha, (c) => loadTimeline(c, id.mid, NOW));
    expect(t.map((e) => [e.eventType, e.kind])).toEqual([['do_received', 'live'], ['cusdec_lodged', 'live']]);
    expect(t[0]!.spentMs).toBe(at('2026-10-17T03:30:00Z').getTime() - at('2026-10-15T06:00:00Z').getTime());
    expect(t[1]!.spentMs).toBe(NOW.getTime() - at('2026-10-17T03:30:00Z').getTime());
    expect(t[0]!.evidence).toMatchObject({ kind: 'message', excerpt: expect.stringContaining('private to the CHA company') });
  });

  test('replaced and voided events stay visible and are marked, and do not count as time in status', async () => {
    const k = await withActor(cha, (c) => createContainer(c, { blNo: newBl(), containerNo: validContainerNo() }));
    const a = await ev(cha, k.id, 'do_received', '2026-10-10T00:00:00Z', { type: 'manual', note: 'a' });
    const wrong = await ev(cha, k.id, 'cusdec_lodged', '2026-10-11T00:00:00Z', { type: 'manual', note: 'wrong time' });
    const fixed = await withActor(cha, (c) =>
      appendCorrection(c, wrong.id, { containerId: k.id, eventType: 'cusdec_lodged', occurredAt: at('2026-10-12T00:00:00Z'), source: person, evidence: { type: 'manual', note: 'corrected time' } }),
    );
    const bad = await ev(cha, k.id, 'channel_assigned', '2026-10-13T00:00:00Z', { type: 'manual', note: 'false' });
    await withActor(cha, (c) => voidEvent(c, bad.id, { source: person, evidence: { type: 'manual', note: 'not real' } }));

    const t = await withActor(cha, (c) => loadTimeline(c, k.id, NOW));
    expect(t.map((e) => [e.eventId, e.kind])).toEqual([
      [a.id, 'live'], [wrong.id, 'replaced'], [fixed.id, 'live'], [bad.id, 'voided'], [expect.any(String), 'void_row'],
    ]);
    expect(t.find((e) => e.eventId === a.id)!.spentMs).toBe(at('2026-10-12T00:00:00Z').getTime() - at('2026-10-10T00:00:00Z').getTime());
    expect(t.filter((e) => e.kind !== 'live').every((e) => e.spentMs === null)).toBe(true);
  });

  test('the haulier\'s timeline carries no evidence text', async () => {
    const t = await withActor(haulier, (c) => loadTimeline(c, id.late, NOW));
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((e) => e.evidence.excerpt === null)).toBe(true);
  });
});

describe('display in Asia/Colombo', () => {
  test('UTC is shown as Colombo time (UTC+5:30)', () => {
    expect(formatColombo(new Date('2026-10-14T03:00:00Z'), 'en')).toMatch(/14 Oct 2026.*08:30/);
    expect(formatColombo(new Date('2026-10-14T20:00:00Z'), 'en')).toMatch(/15 Oct 2026.*01:30/); // crosses midnight
  });

  test('ages show the two largest units, localised', () => {
    const ms = (d: number, h: number, m: number) => ((d * 24 + h) * 60 + m) * 60_000;
    expect(formatAge(ms(2, 4, 30), 'en')).toMatch(/2\s*days?.*4\s*hr?s?/i);
    expect(formatAge(ms(0, 3, 20), 'en')).toMatch(/3\s*hr?s?.*20\s*min/i);
    expect(formatAge(-5000, 'en')).toMatch(/0\s*min/);
    expect(formatAge(ms(2, 4, 30), 'si')).not.toBe(formatAge(ms(2, 4, 30), 'en'));
    expect(formatAge(ms(2, 4, 30), 'ta')).not.toBe(formatAge(ms(2, 4, 30), 'en'));
  });
});
