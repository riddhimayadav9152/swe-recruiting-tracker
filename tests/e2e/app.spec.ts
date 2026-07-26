import { test, expect } from '@playwright/test';

test('loads the recruiting tracker', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText("Riddhima's Recruiting Command Center")).toBeVisible();
});
