import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const ALICE = { username: 'alice@tenant-a.test', password: 'alice-local-only' };
export const BOB = { username: 'bob@tenant-b.test', password: 'bob-local-only' };

export async function signIn(page: Page, user: { username: string; password: string }) {
  await page.goto('/login');
  await expectAccessible(page);
  await page.getByRole('link', { name: 'Sign in with your organization' }).click();
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  await expect(page).toHaveURL(/\/workspaces$/);
}

export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

export async function createWorkspace(page: Page, name: string) {
  await page.getByLabel('Workspace name').fill(name);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]+\/companies$/);
}
