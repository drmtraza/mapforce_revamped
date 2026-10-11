import { expect, test } from '@playwright/test';
import { ALICE, createWorkspace, expectAccessible, signIn } from './helpers';

test.describe.serial('Hardening ops', () => {
  test('alice sees operations status on settings', async ({ page }) => {
    await signIn(page, ALICE);
    await createWorkspace(page, `E2E ops ${Date.now()}`);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible();
    await expect(page.getByText(/not a claim of production capacity/i)).toBeVisible();
    await expectAccessible(page);
  });
});
