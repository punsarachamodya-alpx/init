// Shared by the Playwright config and its setup. Throwaway credentials for the local, synthetic e2e database only.
export const E2E_DB = 'colombo_e2e';
export const E2E_PORT = 3100;
export const DEMO_FILE = '.demo-users.e2e.json';

export const E2E_ENV = {
  APP_DATABASE_URL: `postgresql://colombo_app:colombo_app_pw@localhost:5432/${E2E_DB}`,
  OWNER_DATABASE_URL: `postgresql://colombo_owner:colombo_owner_pw@localhost:5432/${E2E_DB}`,
  ADMIN_DATABASE_URL: 'postgresql://colombo_owner:colombo_owner_pw@localhost:5432/postgres',
  ACTOR_CONTEXT_SECRET: 'ab'.repeat(32),
  SESSION_SECRET: 'e2e-only-session-secret-0123456789abcdef',
  INTAKE_EXTRACTOR: 'fake', // deterministic stand-in for the model; refused when NODE_ENV=production
  DEMO_USERS_FILE: DEMO_FILE,
} as const;
