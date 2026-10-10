// Connection settings. The app connects as `colombo_app` (no superuser, not the
// table owner, so row-level security always applies). Migrations run as the owner.
// Outside tests the URLs must come from the environment; the test defaults below
// are throwaway credentials for the local, synthetic test database only.

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

const TEST_DEFAULTS = {
  APP_DATABASE_URL: 'postgresql://colombo_app:colombo_app_pw@localhost:5432/colombo_test',
  OWNER_DATABASE_URL: 'postgresql://colombo_owner:colombo_owner_pw@localhost:5432/colombo_test',
  ADMIN_DATABASE_URL: 'postgresql://colombo_owner:colombo_owner_pw@localhost:5432/postgres',
} as const;

export type DbUrlName = keyof typeof TEST_DEFAULTS;

export function dbUrl(name: DbUrlName): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  if (isTest) return TEST_DEFAULTS[name];
  throw new Error(`${name} is not set`);
}

export const APP_ROLE = 'colombo_app';

// Secret for signing actor tokens (hex, >= 32 bytes). Held only by the app process: the database
// holds a copy in actor_key (owner-only) to verify with. Tests use a throwaway value.
const TEST_ACTOR_SECRET = 'ab'.repeat(32);

export function actorSecretHex(): string {
  const fromEnv = process.env.ACTOR_CONTEXT_SECRET;
  const secret = fromEnv || (isTest ? TEST_ACTOR_SECRET : undefined);
  if (!secret) throw new Error('ACTOR_CONTEXT_SECRET is not set');
  if (!/^[0-9a-f]{64,}$/i.test(secret)) throw new Error('ACTOR_CONTEXT_SECRET must be hex, at least 32 bytes');
  return secret.toLowerCase();
}
