import { expect, test } from '@playwright/test';
import { ALICE, createWorkspace, expectAccessible, signIn } from './helpers';

test.describe.serial('organization mapping', () => {
  test('alice runs AI mapping after research and sees labelled personas plus drafts', async ({
    page,
  }) => {
    await signIn(page, ALICE);
    await createWorkspace(page, `E2E orgmap ${Date.now()}`);
    await page.getByLabel('Company domain').fill('acme.example');
    await page.getByRole('button', { name: 'Add company' }).click();
    await expect(page.getByRole('heading', { name: /acme/i })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /Run research/ }).click();
    await expect(page.getByText(/Status:\s*(succeeded|partial success)/)).toBeVisible({
      timeout: 90_000,
    });

    const org = page.getByRole('region', { name: 'Organization map' });
    await expect(org.getByText('Persona unknown').first()).toBeVisible();
    await org.getByRole('button', { name: 'Run AI mapping' }).click();
    await expect(org.getByText(/Last mapping/)).toBeVisible({ timeout: 30_000 });
    await expect(org.getByText('Technical eval')).toBeVisible();
    await expect(org.getByText('Procurement')).toBeVisible();
    await expect(org.getByRole('heading', { name: 'Outreach drafts' })).toBeVisible();
    await expect(org.getByText(/never sends outreach automatically/i)).toBeVisible();
    await expect(org.getByText(/Hiring is not evidence of approved budget/)).toBeVisible();
    await expectAccessible(page);
  });
});
