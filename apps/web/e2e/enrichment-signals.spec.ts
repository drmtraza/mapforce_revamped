import { expect, test } from '@playwright/test';
import { ALICE, BOB, createWorkspace, expectAccessible, signIn } from './helpers';

test.describe.serial('people enrichment and signals', () => {
  let personPath = '';

  test('alice researches a company, sees signals, and enriches an unverified contact', async ({
    page,
  }) => {
    await signIn(page, ALICE);
    await createWorkspace(page, `E2E enrich ${Date.now()}`);
    await page.getByLabel('Company domain').fill('acme.example');
    await page.getByRole('button', { name: 'Add company' }).click();
    await expect(page.getByRole('heading', { name: /acme/i })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Start research' }).click();
    await expect(page.getByText(/Status:\s*(succeeded|partial success)/)).toBeVisible({
      timeout: 90_000,
    });
    await expect(page.getByRole('heading', { name: 'Signals' })).toBeVisible();
    await expect(page.getByText(/Hiring activity is not evidence of budget/)).toBeVisible();
    await expect(page.getByText(/Engineering roles posted/)).toBeVisible();
    await expect(page.getByText(/Implies budget: no/).first()).toBeVisible();
    await expectAccessible(page);

    await page
      .getByRole('link', { name: /Avery Example|Jordan Sample|Riley Placeholder/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    personPath = new URL(page.url()).pathname;
    await expect(page.getByText(/never labelled verified/i)).toBeVisible();
    await page.getByRole('button', { name: 'Enrich contacts' }).click();
    await expect(page.getByText(/Enrichment queued/)).toBeVisible();
    await expect
      .poll(
        async () => {
          await page.reload();
          return page.getByText('pattern').count();
        },
        { timeout: 90_000 },
      )
      .toBeGreaterThan(0);
    await expect(page.getByText('unverified').first()).toBeVisible();
    await expect(page.getByText('***@')).toBeVisible();
    await expect(page.getByText('provider_verified')).toHaveCount(0);
    await expectAccessible(page);

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByText('Licensed contact provider')).toBeVisible();
    await expect(
      page
        .getByRole('row', { name: /Licensed contact provider/ })
        .getByText('Disabled by the platform owner.')
        .first(),
    ).toBeVisible();
  });

  test('bob cannot open alice’s person', async ({ page }) => {
    await signIn(page, BOB);
    await page.goto(personPath);
    await expect(page.getByText(/not found|does not exist|404/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
