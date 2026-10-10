import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ago, confirmCard, manualEntry, pasteIntake, signIn } from './helpers.ts';

// One container (ZZZU1234564, seeded with no events, shared with the client and the haulier) walked through the whole
// import chain by three people, checking the board after each hand-over. Screenshots go to test-results/chain-*.png.
const NO = 'ZZZU1234564';

async function boardShows(page: Page, status: string, shot: string) {
  await page.goto('/');
  const group = page.getByTestId(`board-group-${status}`);
  await expect(group.getByTestId(`container-${NO}`)).toBeVisible();
  await expect(group.getByTestId(`age-${NO}`)).toBeVisible();
  await expect(group.getByTestId(`evidence-${NO}`)).toBeVisible();
  await page.screenshot({ path: `test-results/chain-${shot}.png`, fullPage: true });
}

test('one container, the whole chain, three people', async ({ page }) => {
  // --- the CHA: clearance ---
  await signIn(page, 'CHA ops');
  await manualEntry(page, { containerNo: NO, stage: 'vessel_discharged', when: ago(9), reason: 'vessel berthed, discharge list' });
  const card = await pasteIntake(page, `DO received for ${NO}, B/L ESLCMB000101.`, NO);
  await card.getByTestId('when').fill(ago(8));
  await confirmCard(page, card); // one tap: container, B/L and stage are prefilled
  await boardShows(page, 'do_received', '1-do-received');

  await manualEntry(page, { containerNo: NO, stage: 'cusdec_lodged', when: ago(6), reason: 'CusDec lodged by the CHA, reference on file' });
  await manualEntry(page, { containerNo: NO, stage: 'channel_assigned', when: ago(5), reason: 'channel shown in ASYCUDA' });
  await manualEntry(page, { containerNo: NO, stage: 'release_advice', when: ago(2), reason: 'e-DA received from the terminal' });
  await boardShows(page, 'release_advice', '2-released');

  // the CHA cannot record trucking stages
  await page.goto('/inbox');
  await expect(page.locator('form:has([data-testid=manual-container]) [data-testid=stage] option[value=delivered]')).toHaveCount(0);

  // tell the client and the haulier (logging stubs: nothing leaves the machine)
  await page.goto('/');
  await page.getByTestId('send-notifications').click();
  await expect(page.getByTestId('flash')).toContainText(/\d+/);

  // --- the client watches ---
  await signIn(page, 'Client');
  await boardShows(page, 'release_advice', '3-client-sees-release');
  await expect(page.getByTestId('send-notifications')).toHaveCount(0);

  // --- the haulier: trucking ---
  await signIn(page, 'Haulier');
  await boardShows(page, 'release_advice', '4-haulier-sees-job');
  const gate = await pasteIntake(page, `Gate pass shown for ${NO}, driver is at the gate.`, NO);
  await expect(gate.getByTestId('stage')).toHaveValue('gate_pass');
  await gate.getByTestId('when').fill(ago(1, 6));
  await confirmCard(page, gate);
  await boardShows(page, 'gate_pass', '5-gate-pass');

  await manualEntry(page, { containerNo: NO, stage: 'truck_dispatched', when: ago(1, 4), reason: 'dispatcher assigned truck WP-1234 (synthetic)' });
  await manualEntry(page, { containerNo: NO, stage: 'picked_up', when: ago(1, 2), reason: 'driver confirmed pickup by phone' });
  await manualEntry(page, { containerNo: NO, stage: 'delivered', when: ago(0, 6), reason: 'delivery note signed at the warehouse' });
  await manualEntry(page, { containerNo: NO, stage: 'empty_returned', when: ago(0, 1), reason: 'empty returned to the depot, receipt on file' });
  await boardShows(page, 'empty_returned', '6-empty-returned');

  // --- the client sees the end of the chain ---
  await signIn(page, 'Client');
  await boardShows(page, 'empty_returned', '7-client-sees-end');
  await page.getByTestId(`container-${NO}`).getByRole('link', { name: NO }).click();
  const timeline = page.getByTestId('timeline');
  await expect(timeline.getByTestId('event-live')).toHaveCount(10);
  await expect(timeline.locator('.badge')).toHaveCount(10); // time spent in each status
  await page.screenshot({ path: 'test-results/chain-8-timeline.png', fullPage: true });

  // --- the CHA's board shows it too ---
  await signIn(page, 'CHA ops');
  await boardShows(page, 'empty_returned', '9-cha-sees-end');
});

test('the haulier cannot see the B/L number or containers it was not assigned', async ({ page }) => {
  await signIn(page, 'Haulier');
  await page.goto('/');
  await expect(page.getByText('ESLCMB')).toHaveCount(0);
  await expect(page.getByTestId('container-ZZZU3456787')).toHaveCount(0); // seeded, shared with the client only
});
