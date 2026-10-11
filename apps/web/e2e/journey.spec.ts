import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Local-only Keycloak users from infra/compose/keycloak/mapforce-realm.json.
const ALICE = { username: 'alice@tenant-a.test', password: 'alice-local-only' };
const BOB = { username: 'bob@tenant-b.test', password: 'bob-local-only' };

async function signIn(page: Page, user: { username: string; password: string }) {
  await page.goto('/login');
  await expectAccessible(page);
  await page.getByRole('link', { name: 'Sign in with your organization' }).click();
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  await expect(page).toHaveURL(/\/workspaces$/);
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test.describe.serial('first milestone journey', () => {
  let companyUrl = '';

  test('alice researches a company end to end', async ({ page }) => {
    await signIn(page, ALICE);
    await expectAccessible(page);

    const workspaceName = `E2E ${Date.now()}`;
    await page.getByLabel('Workspace name').fill(workspaceName);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page).toHaveURL(/\/w\/[0-9a-f-]+\/companies$/);

    await page.getByRole('link', { name: 'Ideal customer profiles' }).click();
    await page.getByLabel('Name', { exact: true }).fill('US, UK and Europe software');
    await page.getByLabel('Industries (comma separated)').fill('Software');
    await page.getByRole('button', { name: 'Add United States' }).click();
    await page.getByRole('button', { name: 'Add United Kingdom' }).click();
    await page.getByRole('button', { name: 'Add EU / EEA + Switzerland' }).click();
    await page.getByLabel('Economic buyer').check();
    await page.getByRole('button', { name: 'Create profile' }).click();
    await expect(page.locator('strong', { hasText: 'US, UK and Europe software' })).toBeVisible();
    await expect(page.getByText(/US, GB, AT/)).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('link', { name: 'Companies' }).click();
    await page.getByLabel('Company domain').fill('https://www.acme.example/about');
    await page.getByRole('button', { name: 'Add company' }).click();
    await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+$/);
    companyUrl = page.url();

    await page.getByRole('button', { name: 'Run research' }).click();
    const research = page.getByRole('region', { name: 'Research' });
    await expect(research.getByText(/Status:\s*(succeeded|partial success)/)).toBeVisible({
      timeout: 90_000,
    });
    await expect(research.getByRole('cell', { name: 'mock_people' })).toBeVisible();

    const people = page.getByRole('region', { name: 'Candidate people' });
    await expect(people.getByRole('row')).not.toHaveCount(0);
    const evidence = page.getByRole('region', { name: 'Evidence' });
    await expect(evidence.getByText('Mock data').first()).toBeVisible();

    const orgMap = page.getByRole('region', { name: 'Organization map' });
    await expect(
      orgMap.getByRole('img', { name: /Organization map with \d+ people/ }),
    ).toBeVisible();
    await expect(orgMap.getByText('reports to').first()).toBeVisible();
    await expect(orgMap.getByText('verified').first()).toBeVisible();
    await expect(orgMap.getByText('inferred').first()).toBeVisible();
    await expectAccessible(page);
    await page.screenshot({ path: test.info().outputPath('company.png'), fullPage: true });

    await people.getByRole('link').first().click();
    await expect(page.getByRole('heading', { name: 'Claims and provenance' })).toBeVisible();
    await expect(page.getByText('Source fact').first()).toBeVisible();
    await expect(page.getByText(/No contact points collected/)).toBeVisible();
    await expectAccessible(page);
    await page.getByLabel(/^Confirm:/).check();
    await page.getByLabel('Reason (optional)').fill('Team page lists this person and title.');
    await page.getByRole('button', { name: 'Record review' }).click();
    await expect(page.getByText('Review recorded.')).toBeVisible();

    await page.getByRole('link', { name: 'Audit trail' }).click();
    for (const action of [
      'workspace.created',
      'icp.created',
      'company.created',
      'research.requested',
      'research.completed',
      'person.reviewed',
    ]) {
      await expect(page.getByText(action, { exact: true }).first()).toBeVisible();
    }
    await expectAccessible(page);
  });

  test('bob cannot see alice’s company', async ({ page }) => {
    expect(companyUrl).not.toBe('');
    await signIn(page, BOB);
    await page.goto(companyUrl);
    await expect(page.locator('.notice-error[role="alert"]')).toContainText(/not found/i);
    await expect(page.getByRole('heading', { name: /acme/i })).toHaveCount(0);
  });
});
