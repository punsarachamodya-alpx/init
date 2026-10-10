import { expect, test } from '@playwright/test';
import en from '../locales/en.json' with { type: 'json' };
import { ago, confirmCard, freshContainerNo, pasteIntake, signIn } from './helpers.ts';

test('the CHA pastes a message, confirms the suggestion in one tap, and sees the container on the board', async ({ page }) => {
  const containerNo = freshContainerNo();
  await signIn(page, 'CHA ops');

  const card = await pasteIntake(page, `DO received from the shipping line. Container ${containerNo}, B/L ESLCMB9${containerNo.slice(4, 10)}. Please start clearance.`, containerNo);
  await expect(card.getByTestId('suggestion-status')).toHaveText(/Ready to confirm|Needs review/);
  // every extracted field is shown prefilled; the person only checks them and taps Confirm
  await expect(card.getByTestId('field-container_no')).toHaveValue(containerNo);
  await expect(card.getByTestId('stage')).toHaveValue('do_received');
  await card.getByTestId('when').fill(ago(1, 3));
  await card.locator('input[name=createContainer]').check(); // a new container: the CHA creates it from the B/L in the message
  await confirmCard(page, card);

  // the board shows it in the right group with an age and the evidence of the change
  await expect(page.getByTestId('flash')).toContainText(containerNo);
  const group = page.getByTestId('board-group-do_received');
  await expect(group.getByTestId(`container-${containerNo}`)).toBeVisible();
  await expect(group.getByTestId(`age-${containerNo}`)).toContainText(/1 day.*3 hrs?/);
  await expect(group.getByTestId(`evidence-${containerNo}`)).toContainText(en['evidence.message']);
  await expect(group.getByTestId(`evidence-${containerNo}`)).toContainText('DO received from the shipping line');

  // the suggestion is gone from the inbox and cannot be confirmed twice
  await page.goto('/inbox');
  await expect(page.getByTestId('suggestion').filter({ hasText: containerNo })).toHaveCount(0);
});

test('a suggestion whose container is not in the text is refused, and nothing is recorded', async ({ page }) => {
  const containerNo = freshContainerNo();
  await signIn(page, 'CHA ops');
  const card = await pasteIntake(page, `DO received for ${containerNo}`, containerNo);
  await card.getByTestId('field-container_no').fill(freshContainerNo()); // a different, valid number not in the original text
  await card.locator('input[name=createContainer]').check();
  await card.getByTestId('confirm').click();
  await expect(page.getByTestId('flash-error')).toBeVisible();
  await page.goto('/');
  await expect(page.getByTestId(`container-${containerNo}`)).toHaveCount(0);
});
