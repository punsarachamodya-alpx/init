import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROLES } from '../domain/statusChain.ts';
import type { RoleName } from '../domain/statusChain.ts';

// The pilot login is a PICKER over synthetic demo users written by `pnpm seed:demo` (gitignored file). It is a
// development convenience, not authentication: it throws in production. Real authentication is a flagged follow-up.

export interface DemoUser {
  label: string;
  role: RoleName;
  companyName: string;
  companyId: string;
  userId: string;
}

export const DEMO_USERS_FILE = path.join(process.cwd(), '.demo-users.json');

export function assertDevLoginAllowed(env: { NODE_ENV?: string } = process.env): void {
  if (env.NODE_ENV === 'production') throw new Error('the pilot user picker is disabled in production: real authentication is required');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDemoUsers(json: string): DemoUser[] {
  const data = JSON.parse(json) as { users?: unknown };
  if (!Array.isArray(data.users)) throw new Error('demo users file: "users" must be a list');
  return data.users.map((u: Record<string, unknown>, i) => {
    const ok =
      typeof u.label === 'string' && u.label.length > 0 &&
      typeof u.companyName === 'string' &&
      typeof u.role === 'string' && (ROLES as readonly string[]).includes(u.role) &&
      typeof u.companyId === 'string' && UUID.test(u.companyId) &&
      typeof u.userId === 'string' && UUID.test(u.userId);
    if (!ok) throw new Error(`demo users file: entry ${i} is malformed`);
    return { label: u.label as string, role: u.role as RoleName, companyName: u.companyName as string, companyId: u.companyId as string, userId: u.userId as string };
  });
}

export function loadDemoUsers(file: string = DEMO_USERS_FILE): DemoUser[] {
  assertDevLoginAllowed();
  try {
    return parseDemoUsers(readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
