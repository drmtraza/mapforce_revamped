import { expect, test } from '@playwright/test';
import { ALICE, BOB, createWorkspace, expectAccessible, signIn } from './helpers';

const CSV = [
  'domain,name,country,industry',
  'northwind-import.example,Northwind Import,GB,Software',
  'not a domain,,,',
].join('\n');

test.describe.serial('discovery, import and source settings', () => {
  let workspacePath = '';
  let searchUrl = '';

  test('alice previews and commits a CSV, then reviews discovery candidates', async ({ page }) => {
    await signIn(page, ALICE);
    await createWorkspace(page, `E2E import ${Date.now()}`);
    workspacePath = new URL(page.url()).pathname.replace(/\/companies$/, '');

    await page.getByRole('link', { name: 'Imports' }).click();
    await expectAccessible(page);
    await page.getByLabel('CSV file').setInputFiles({
      name: 'companies.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(CSV),
    });
    await page.getByRole('button', { name: 'Preview (dry run)' }).click();
    await expect(page.getByText(/Dry run: 2 rows · 1 new/)).toBeVisible();
    await expect(page.getByText(/1 invalid/)).toBeVisible();
    await page.getByRole('button', { name: /Commit 1 new/ }).click();
    await expect(page.getByText(/Committed/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open company' }).first()).toBeVisible();

    await page.getByRole('link', { name: 'Discovery' }).click();
    await expectAccessible(page);
    await page.getByLabel('What to look for').fill('logistics software');
    await page.getByRole('button', { name: 'Add United Kingdom' }).click();
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByText(/Status:\s*(succeeded|partial success)/)).toBeVisible({
      timeout: 90_000,
    });
    await expect(page.getByText('Provider fact').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept' }).first()).toBeVisible();
    await expectAccessible(page);
    searchUrl = page.url();
    await page.getByRole('button', { name: 'Accept' }).first().click();
    await expect(page.getByRole('link', { name: 'Open company' }).first()).toBeVisible();

    await page.getByRole('link', { name: 'Settings' }).click();
    await expectAccessible(page);
    await expect(page.getByText('Public company website')).toBeVisible();
    await expect(page.getByText('Brave Search API')).toBeVisible();
    await expect(
      page
        .getByRole('row', { name: /Brave Search API/ })
        .getByText('Disabled by the platform owner.')
        .first(),
    ).toBeVisible();
    await expect(page.getByText('No dead-lettered events.')).toBeVisible();
    await page
      .getByRole('row', { name: /Public company website/ })
      .getByRole('button', { name: 'Enable' })
      .click();
    await expect(
      page
        .getByRole('row', { name: /Public company website/ })
        .getByText('enabled', { exact: true }),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Audit trail' }).click();
    for (const action of [
      'import.companies_committed',
      'discovery.requested',
      'discovery.candidate_accepted',
      'source.enabled',
    ]) {
      await expect(page.getByText(action, { exact: true }).first()).toBeVisible();
    }
  });

  test('bob cannot open alice’s discovery search', async ({ page }) => {
    expect(workspacePath).not.toBe('');
    await signIn(page, BOB);
    await page.goto(`${workspacePath}/discovery`);
    await expect(page.locator('.notice-error[role="alert"]').first()).toBeVisible();
    if (searchUrl) {
      await page.goto(searchUrl);
      await expect(page.locator('.notice-error[role="alert"]').first()).toBeVisible();
    }
  });
});
