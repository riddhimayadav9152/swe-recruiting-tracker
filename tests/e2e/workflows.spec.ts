import { test, expect } from '@playwright/test';

const uniqueId = () => Math.random().toString(36).slice(2, 8);

test('creates an opportunity, resume version, and workflow records', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Opportunity' }).click();
  await page.getByPlaceholder('Company').fill(`Acme ${uniqueId()}`);
  await page.getByPlaceholder('Role').fill('Software Engineer');
  await page.getByPlaceholder('Application URL').fill('https://example.com/apply');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Opportunity created')).toBeVisible();

  await page.getByRole('button', { name: 'Resume Versions' }).click();
  await page.getByRole('button', { name: 'Create Resume' }).click();
  await page.getByPlaceholder('Resume name').fill(`Resume ${uniqueId()}`);
  await page.getByPlaceholder('Target role').fill('SWE');
  await page.getByRole('button', { name: 'Save resume' }).click();
  await expect(page.getByText('Resume created')).toBeVisible();

  await page.getByRole('button', { name: 'Dashboard' }).click();
  await page.getByRole('button', { name: 'Mark Applied' }).click();
  await page.getByLabel('Resume version').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated')).toBeVisible();

  await page.getByRole('button', { name: 'OA Received' }).click();
  await page.getByPlaceholder('Platform').fill('Coderbyte');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated')).toBeVisible();

  await page.getByRole('button', { name: 'Interview Received' }).click();
  await page.getByPlaceholder('Interview stage').fill('Recruiter Screen');
  await page.getByPlaceholder('Location').fill('Zoom');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated')).toBeVisible();

  await page.getByRole('button', { name: 'Interview Received' }).click();
  await page.getByPlaceholder('Interview stage').fill('Technical Interview');
  await page.getByPlaceholder('Location').fill('Office');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated')).toBeVisible();

  await page.getByRole('button', { name: 'Offer Received' }).click();
  await page.getByPlaceholder('Compensation').fill('$180k base');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated')).toBeVisible();

  await page.getByRole('button', { name: 'Rejected' }).click();
  await page.getByPlaceholder('Rejection notes').fill('No longer hiring');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated')).toBeVisible();
});
