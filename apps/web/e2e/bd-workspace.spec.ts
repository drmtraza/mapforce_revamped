import { expect, test } from '@playwright/test';
import { ALICE, createWorkspace, expectAccessible, signIn } from './helpers';

test.describe.serial('BD workspace', () => {
  test('alice scores an account, adds it to a list and sees usage', async ({ page }) => {
    await signIn(page, ALICE);
    await createWorkspace(page, `E2E bd ${Date.now()}`);
    await page.getByRole('link', { name: 'Ideal customer profiles' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Software');
    await page.getByLabel('Industries (comma separated)').fill('Software');
    await page.getByRole('button', { name: 'Create profile' }).click();

    await page.getByRole('link', { name: 'Companies' }).click();
    await page.getByLabel('Company domain').fill('acme.example');
    await page.getByRole('button', { name: 'Add company' }).click();
    await expect(page.getByRole('heading', { name: /acme/i })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /Run research/ }).click();
    await expect(page.getByText(/Status:\s*(succeeded|partial success)/)).toBeVisible({
      timeout: 90_000,
    });

    await page.getByRole('button', { name: 'Score against active ICP' }).click();
    await expect(page.getByText(/Total \d+\/100/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/heuristic/)).toBeVisible();

    await page.getByRole('link', { name: 'Lists' }).click();
    await page.getByLabel('Name').fill('Outbound');
    await page.getByRole('button', { name: 'Create list' }).click();
    await expect(page.getByRole('link', { name: 'Outbound' })).toBeVisible();

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Usage and budgets' })).toBeVisible();
    await expect(page.getByText(/Billing\/plan integration is not enabled/)).toBeVisible();
    await expectAccessible(page);
  });
});
