import { describe, expect, test } from 'vitest';
import { scanContainerTokens } from '../src/intake/suggest.ts';
import { ExtractionFailedError } from '../src/intake/types.ts';
import { assertDevLoginAllowed, parseDemoUsers } from '../src/web/demoUsers.ts';
import { RuleExtractor, selectExtractor } from '../src/web/extractor.ts';
import { SESSION_TTL_SECONDS, createSession, sessionSecret, verifySession } from '../src/web/session.ts';

const SECRET = 'x'.repeat(40);
const actor = { companyId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' };
const NOW = new Date('2026-10-20T06:00:00Z');

describe('session cookie', () => {
  test('round trip gives back the same actor', () => {
    expect(verifySession(createSession(actor, SECRET, NOW), SECRET, NOW)).toEqual(actor);
  });

  test('tampered payload, tampered signature, wrong secret, garbage and empty are all refused', () => {
    const token = createSession(actor, SECRET, NOW);
    const [v, body, sig] = token.split('.') as [string, string, string];
    const other = Buffer.from(JSON.stringify({ c: actor.companyId, u: '33333333-3333-4333-8333-333333333333', exp: 9_999_999_999 })).toString('base64url');
    expect(verifySession(`${v}.${other}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifySession(`${v}.${body}.${sig.replace(/.$/, sig.endsWith('0') ? '1' : '0')}`, SECRET, NOW)).toBeNull();
    expect(verifySession(token, 'y'.repeat(40), NOW)).toBeNull();
    for (const bad of ['', 'x', 'v1..', 'v1.a.b', `v2.${body}.${sig}`, `${token}.extra`]) expect(verifySession(bad, SECRET, NOW), bad).toBeNull();
    expect(verifySession(undefined, SECRET, NOW)).toBeNull();
  });

  test('expires after the lifetime, not before', () => {
    const token = createSession(actor, SECRET, NOW);
    expect(verifySession(token, SECRET, new Date(NOW.getTime() + (SESSION_TTL_SECONDS - 1) * 1000))).toEqual(actor);
    expect(verifySession(token, SECRET, new Date(NOW.getTime() + (SESSION_TTL_SECONDS + 1) * 1000))).toBeNull();
  });

  test('the secret: a throwaway default outside production, required in production, long enough', () => {
    expect(sessionSecret({ NODE_ENV: 'development' })).toBeTruthy();
    expect(() => sessionSecret({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
    expect(() => sessionSecret({ NODE_ENV: 'production', SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(sessionSecret({ NODE_ENV: 'production', SESSION_SECRET: SECRET })).toBe(SECRET);
  });
});

describe('the pilot user picker is dev only', () => {
  test('refused in production, allowed otherwise', () => {
    expect(() => assertDevLoginAllowed({ NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => assertDevLoginAllowed({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertDevLoginAllowed({})).not.toThrow();
  });

  test('the demo user file is validated', () => {
    const good = { users: [{ label: 'CHA ops', role: 'cha_ops', companyName: 'Demo CHA', companyId: actor.companyId, userId: actor.userId }] };
    expect(parseDemoUsers(JSON.stringify(good))).toEqual(good.users);
    expect(() => parseDemoUsers('not json')).toThrow();
    expect(() => parseDemoUsers(JSON.stringify({ users: [{ ...good.users[0], role: 'admin' }] }))).toThrow();
    expect(() => parseDemoUsers(JSON.stringify({ users: [{ ...good.users[0], companyId: 'nope' }] }))).toThrow();
  });
});

describe('extractor selection', () => {
  test('the rule-based fake is refused in production', () => {
    expect(() => selectExtractor({ NODE_ENV: 'production', INTAKE_EXTRACTOR: 'fake' })).toThrow(/production/);
    expect(selectExtractor({ NODE_ENV: 'development', INTAKE_EXTRACTOR: 'fake' })).toBeInstanceOf(RuleExtractor);
  });

  test('with neither a key nor the fake, extraction fails cleanly (intake stores a failed suggestion; staff use manual entry)', async () => {
    const ex = selectExtractor({ NODE_ENV: 'development' });
    await expect(ex.extract({ kind: 'message', text: 'ZZZU1234564 DO kittu' })).rejects.toBeInstanceOf(ExtractionFailedError);
  });

  test('the rule extractor reads a container number and a stage from plain text', async () => {
    const raw = await new RuleExtractor().extract({ kind: 'message', text: 'DO received for ZZZU1234564, B/L ESLCMB000101' });
    expect(raw.suggestedEvent).toBe('do_received');
    expect(raw.fields.container_no).toBe('ZZZU1234564');
    expect(raw.fields.bl_no).toBe('ESLCMB000101');
    expect(scanContainerTokens('ZZZU1234564').valid).toContain('ZZZU1234564');
    const none = await new RuleExtractor().extract({ kind: 'message', text: 'good morning' });
    expect(none.suggestedEvent).toBeNull();
    expect(none.fields.container_no ?? null).toBeNull();
  });
});

describe('what the user is told', () => {
  test('database and unexpected errors are mapped to a fixed code, never passed through', async () => {
    const { uiErrorCode } = await import('../src/web/errors.ts');
    const { ConfirmationError } = await import('../src/intake/confirm.ts');
    const { InvalidContainerNoError } = await import('../src/domain/iso6346.ts');
    expect(uiErrorCode(new ConfirmationError('duplicate', 'x'))).toBe('duplicate');
    expect(uiErrorCode(new InvalidContainerNoError('ZZZU1234565'))).toBe('invalid_container');
    expect(uiErrorCode(Object.assign(new Error('new row violates row-level security policy for table "events"'), { code: '42501' }))).toBe('forbidden');
    expect(uiErrorCode(new Error('connection to server at "10.0.0.5" failed; actor_key'))).toBe('unexpected');
    expect(uiErrorCode('boom')).toBe('unexpected');
  });

  test('return paths stay on this site', async () => {
    const { safeReturnTo } = await import('../src/web/errors.ts');
    expect(safeReturnTo('/inbox?x=1')).toBe('/inbox?x=1');
    for (const bad of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '/\\evil', undefined, 5]) expect(safeReturnTo(bad), String(bad)).toBe('/');
  });
});
