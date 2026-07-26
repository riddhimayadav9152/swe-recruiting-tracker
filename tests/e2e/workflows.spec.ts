import { test, expect, type Page } from '@playwright/test';

const uniqueId = () => Math.random().toString(36).slice(2, 8);

const waitForTrackerLoaded = async (page: Page) => {
  await expect(page.getByText('Loading tracker data…')).toHaveCount(0);
};

const createOpportunity = async (page: Page, company: string) => {
  await page.getByRole('button', { name: 'New Opportunity' }).click();
  await page.getByLabel('Company').fill(company);
  await page.getByLabel('Role').fill('Software Engineer');
  await page.getByLabel('Application URL').fill(`https://example.com/apply/${uniqueId()}`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Opportunity created')).toBeVisible();
};

const openApplication = async (page: Page, company: string) => {
  await page.getByRole('button', { name: 'Applications', exact: true }).click();
  await waitForTrackerLoaded(page);
  await page.locator('table tbody tr', { hasText: company }).click();
};

test('completes an OA and interview workflow for a single application', async ({ page }) => {
  await page.goto('/');
  await waitForTrackerLoaded(page);

  const company = `Acme ${uniqueId()}`;
  await createOpportunity(page, company);

  const resumeName = `Resume ${uniqueId()}`;
  await page.getByRole('button', { name: 'Resume Versions' }).click();
  await waitForTrackerLoaded(page);
  await page.getByRole('button', { name: 'Create Resume' }).click();
  await page.getByLabel('Resume name').fill(resumeName);
  await page.getByLabel('Target type').fill('SWE Internship');
  await page.getByRole('button', { name: 'Save resume' }).click();
  await expect(page.getByText('Resume created')).toBeVisible();

  await openApplication(page, company);

  await page.getByRole('button', { name: 'Mark Applied' }).click();
  await page.getByLabel('Resume version').selectOption({ label: resumeName });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();

  await page.getByRole('button', { name: 'OA Received' }).click();
  await page.getByLabel('Due at').fill('2026-08-01T09:00');
  await page.getByLabel('Platform').fill('Coderbyte');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();

  await page.getByRole('button', { name: 'OA Completed' }).click();
  await page.getByLabel('Assessment').selectOption({ index: 1 });
  await page.getByLabel('Result').fill('Passed');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();

  await page.getByRole('button', { name: 'Interview Received' }).click();
  await page.getByLabel('Interview stage').selectOption('Recruiter Screen');
  await page.getByLabel('Scheduled start').fill('2026-08-05T14:00');
  await page.getByLabel('Recruiter').fill('Mina');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();

  await page.getByRole('button', { name: 'Interview Completed' }).click();
  await page.getByLabel('Interview', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Result', { exact: true }).fill('Passed');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();
});

test('records an offer on one application and a rejection on a separate application', async ({ page }) => {
  await page.goto('/');
  await waitForTrackerLoaded(page);

  const offerCompany = `Offer Co ${uniqueId()}`;
  const rejectCompany = `Reject Co ${uniqueId()}`;

  await createOpportunity(page, offerCompany);
  await createOpportunity(page, rejectCompany);

  await openApplication(page, offerCompany);
  await page.getByRole('button', { name: 'Offer Received' }).click();
  await page.getByLabel('Decision deadline').fill('2026-08-15');
  await page.getByLabel('Compensation').fill('$180k base');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();

  await openApplication(page, rejectCompany);
  await page.getByRole('button', { name: 'Rejected' }).click();
  await page.getByLabel('Rejection notes').fill('No longer hiring');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();

  await openApplication(page, offerCompany);
  await expect(page.locator('table tbody tr', { hasText: offerCompany })).toContainText('Offer');
  await expect(page.locator('table tbody tr', { hasText: offerCompany })).not.toContainText('Rejected');

  await openApplication(page, rejectCompany);
  await expect(page.locator('table tbody tr', { hasText: rejectCompany })).toContainText('Rejected');
  await expect(page.locator('table tbody tr', { hasText: rejectCompany })).not.toContainText('Offer');
});
