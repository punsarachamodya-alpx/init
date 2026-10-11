import { expect, test } from '@playwright/test';
import { createSession, sessionSecret, SESSION_COOKIE } from '../src/web/session.ts';
import { E2E_ENV } from './env.ts';

test('a valid cookie for a user that no longer exists lands on the login page, not in a redirect loop', async ({ page, context, baseURL }) => {
  await context.clearCookies();
  const ghost = createSession(
    { companyId: crypto.randomUUID(), userId: crypto.randomUUID() },
    sessionSecret({ NODE_ENV: 'development', SESSION_SECRET: E2E_ENV.SESSION_SECRET }),
  );
  await context.addCookies([{ name: SESSION_COOKIE, value: ghost, url: baseURL! }]);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('login-CHA ops')).toBeVisible(); // the picker is shown, so choosing a user replaces the stale cookie
  await page.getByTestId('login-CHA ops').click();
  await expect(page.getByTestId('viewer')).toBeVisible();
});

test('a tampered cookie is treated as signed out', async ({ page, context, baseURL }) => {
  await context.clearCookies();
  await context.addCookies([{ name: SESSION_COOKIE, value: 'v1.e30.deadbeef', url: baseURL! }]);
  await page.goto('/inbox');
  await expect(page).toHaveURL(/\/login$/);
});
