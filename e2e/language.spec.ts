import { expect, test } from '@playwright/test';
import en from '../locales/en.json' with { type: 'json' };
import si from '../locales/si.json' with { type: 'json' };
import ta from '../locales/ta.json' with { type: 'json' };
import { signIn } from './helpers.ts';

test('switching language changes the page text, the page language, and sticks across pages', async ({ page }) => {
  await signIn(page, 'CHA ops');
  await expect(page.getByTestId('page-title')).toHaveText(en['board.title']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.getByTestId('lang-si').click();
  await expect(page.getByTestId('page-title')).toHaveText(si['board.title']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'si');
  // status group headings are localised too (the seeded containers are in these statuses)
  await expect(page.getByTestId('board-group-channel_assigned').locator('h2')).toContainText(si['status.channel_assigned']);

  await page.getByTestId('lang-ta').click();
  await expect(page.getByTestId('page-title')).toHaveText(ta['board.title']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ta');
  await expect(page.getByTestId('board-group-channel_assigned').locator('h2')).toContainText(ta['status.channel_assigned']);

  // the choice sticks on another page, and the form labels follow it
  await page.goto('/inbox');
  await expect(page.getByTestId('page-title')).toHaveText(ta['inbox.title']);
  await expect(page.getByText(ta['inbox.paste_label'])).toBeVisible();

  await page.getByTestId('lang-en').click();
  await expect(page.getByTestId('page-title')).toHaveText(en['inbox.title']);
});

test('the login page is translated too, before anyone has signed in', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await expect(page.getByTestId('page-title')).toHaveText(en['login.title']);
  await page.getByTestId('lang-si').click();
  await expect(page.getByTestId('page-title')).toHaveText(si['login.title']);
  await page.getByTestId('lang-en').click();
});
