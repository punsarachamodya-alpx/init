import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { checkDigit } from '../scripts/check-iso6346.mjs';
import { toColomboInput } from '../src/i18n/format.ts';

/** A fresh, valid, synthetic container number (ZZZU is not a registered owner code). */
let n = 600000;
export function freshContainerNo(): string {
  const prefix = `ZZZU${n++}`;
  return `${prefix}${checkDigit(prefix)}`;
}

/** Colombo-time value for a datetime-local input, `days`/`hours` before now. */
export const ago = (days: number, hours = 0) => toColomboInput(new Date(Date.now() - (days * 24 + hours) * 3_600_000));

export async function signIn(page: Page, label: 'CHA ops' | 'Client' | 'Haulier') {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByTestId(`login-${label}`).click();
  await expect(page.getByTestId('viewer')).toBeVisible();
}

/** Paste text into the inbox and return the new suggestion card for the container. */
export async function pasteIntake(page: Page, text: string, containerNo: string) {
  await page.goto('/inbox');
  await page.getByTestId('intake-text').fill(text);
  await page.getByTestId('intake-submit').click();
  await expect(page.getByTestId('flash')).toBeVisible();
  const card = page.getByTestId('suggestion').filter({ hasText: containerNo }).first();
  await expect(card).toBeVisible();
  return card;
}

export async function manualEntry(page: Page, o: { containerNo: string; stage: string; when: string; reason: string }) {
  await page.goto('/inbox');
  await page.getByTestId('manual-container').fill(o.containerNo);
  await page.locator('form:has([data-testid=manual-container]) [data-testid=stage]').selectOption(o.stage);
  await page.locator('form:has([data-testid=manual-container]) input[name=occurredAt]').fill(o.when);
  await page.getByTestId('manual-reason').fill(o.reason);
  await page.getByTestId('manual-submit').click();
  await page.waitForURL(/flash=manual_done/);
  await expect(page.getByTestId('flash')).toBeVisible();
}

/** One tap on Confirm, then wait for the server action to finish (the redirect to the board with a result banner). */
export async function confirmCard(page: Page, card: Locator) {
  await card.getByTestId('confirm').click();
  await page.waitForURL(/flash=confirmed/);
  await expect(page.getByTestId('flash')).toBeVisible();
}
