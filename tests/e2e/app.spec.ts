import { test, expect } from '@playwright/test';

test('loads the recruiting tracker', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
  await expect(page.getByText('Loading tracker data…')).toHaveCount(0);
});
