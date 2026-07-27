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

// OA/Interview/Offer actions are only valid once an application has been
// marked applied (see lib/workflow-policy.ts) — before that, the buttons
// are hidden entirely, so tests that need to reach those stages must apply
// first, same as a real user would.
const markApplied = async (page: Page, company: string) => {
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

  // Mark Applied is only offered before the application has been submitted.
  await expect(page.getByRole('button', { name: 'Mark Applied' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark Applied' }).click();
  await page.getByLabel('Resume version').selectOption({ label: resumeName });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();
  await expect(page.getByTestId('app-status')).toHaveText('Applied');
  await expect(page.getByRole('button', { name: 'Mark Applied' })).toHaveCount(0);

  await page.getByRole('button', { name: 'OA Received' }).click();
  await page.getByLabel('Due at').fill('2026-08-01T09:00');
  await page.getByLabel('Platform').fill('Coderbyte');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();
  await expect(page.getByTestId('app-status')).toHaveText('OA');
  // OA Completed only becomes available once an incomplete OA exists.
  await expect(page.getByRole('button', { name: 'OA Completed' })).toBeVisible();

  await page.getByRole('button', { name: 'OA Completed' }).click();
  await page.getByLabel('Assessment').selectOption({ index: 1 });
  await page.getByLabel('Result').fill('Passed');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();
  // Once completed, the OA no longer offers a completion action.
  await expect(page.getByRole('button', { name: 'OA Completed' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Interview Received' }).click();
  await page.getByLabel('Interview stage').selectOption('Recruiter Screen');
  await page.getByLabel('Scheduled start').fill('2026-08-05T14:00');
  await page.getByLabel('Time zone').selectOption('America/Los_Angeles');
  await page.getByLabel('Recruiter').fill('Mina');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();
  await expect(page.getByTestId('app-status')).toHaveText('Recruiter Screen');
  await expect(page.getByRole('button', { name: 'Interview Completed' })).toBeVisible();

  await page.getByRole('button', { name: 'Interview Completed' }).click();
  await page.getByLabel('Interview', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Result', { exact: true }).fill('Passed');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();
  // The exact interview that was scheduled is now completed, so the action disappears.
  await expect(page.getByRole('button', { name: 'Interview Completed' })).toHaveCount(0);
});

test('shows field-level validation errors for invalid input', async ({ page }) => {
  await page.goto('/');
  await waitForTrackerLoaded(page);

  const company = `Invalid Co ${uniqueId()}`;
  await createOpportunity(page, company);
  await markApplied(page, company);

  await page.getByRole('button', { name: 'Interview Received' }).click();
  await page.getByLabel('Interview stage').selectOption('Recruiter Screen');
  await page.getByLabel('Scheduled start').fill('2026-08-05T14:00');
  await page.getByLabel('Time zone').selectOption('America/Los_Angeles');
  await page.getByLabel('Meeting URL').fill('not-a-url');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('Please fix the highlighted fields')).toBeVisible();
  await expect(page.locator('#meeting-url + p')).toContainText('Enter a valid URL');
});

test('records an offer on one application and a rejection on a separate application', async ({ page }) => {
  await page.goto('/');
  await waitForTrackerLoaded(page);

  const offerCompany = `Offer Co ${uniqueId()}`;
  const rejectCompany = `Reject Co ${uniqueId()}`;

  await createOpportunity(page, offerCompany);
  await createOpportunity(page, rejectCompany);

  await markApplied(page, offerCompany);
  await page.getByRole('button', { name: 'Offer Received' }).click();
  await page.getByLabel('Decision deadline').fill('2026-08-15');
  await page.getByLabel('Compensation').fill('$180k base');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();
  await expect(page.getByTestId('app-status')).toHaveText('Offer');
  // The exact displayed calendar day for a date-only value must never shift
  // with the viewer's local timezone (see lib/dates.ts / formatDateOnly).
  await expect(page.getByTestId('offer-deadline')).toHaveText('Aug 15, 2026');
  await expect(page.getByTestId('offer-compensation')).toHaveText('$180k base');

  // Confirm the offer fields actually persisted server-side, independent of
  // any local-timezone display formatting for the date.
  const applications = await page.request.get('/api/applications').then((res) => res.json());
  const offerApplication = applications.find((app: { company: string }) => app.company === offerCompany);
  expect(offerApplication.offers.compensationSummary).toBe('$180k base');
  expect(new Date(offerApplication.offers.decisionDeadline).toISOString().slice(0, 10)).toBe('2026-08-15');

  await openApplication(page, rejectCompany);
  await page.getByRole('button', { name: 'Rejected' }).click();
  await page.getByLabel('Rejection notes').fill('No longer hiring');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();
  await expect(page.getByTestId('app-status')).toHaveText('Rejected');

  await openApplication(page, offerCompany);
  await expect(page.getByTestId('app-status')).toHaveText('Offer');
  await expect(page.locator('table tbody tr', { hasText: offerCompany })).toContainText('Offer');
  await expect(page.locator('table tbody tr', { hasText: offerCompany })).not.toContainText('Rejected');

  await openApplication(page, rejectCompany);
  await expect(page.getByTestId('app-status')).toHaveText('Rejected');
  await expect(page.locator('table tbody tr', { hasText: rejectCompany })).toContainText('Rejected');
  await expect(page.locator('table tbody tr', { hasText: rejectCompany })).not.toContainText('Offer');
});

test('adds a contact and persists all its fields', async ({ page }) => {
  await page.goto('/');
  await waitForTrackerLoaded(page);

  const company = `Contact Co ${uniqueId()}`;
  await createOpportunity(page, company);
  await openApplication(page, company);

  await page.getByRole('button', { name: 'Add Contact' }).click();
  await page.getByLabel('Name').fill('Taylor Recruiter');
  await page.getByLabel('Title').fill('Recruiter');
  await page.getByLabel('Email').fill('taylor@example.com');
  await page.getByLabel('Relationship').fill('Recruiter');
  await page.getByLabel('Referral status').fill('Warm intro');
  await page.getByLabel('Next follow-up date').fill('2026-09-01');
  await page.getByLabel('Notes', { exact: true }).fill('Follow up after OA');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();

  const applications = await page.request.get('/api/applications').then((res) => res.json());
  const application = applications.find((app: { company: string }) => app.company === company);
  const contact = application.contacts.find((c: { name: string }) => c.name === 'Taylor Recruiter');
  expect(contact).toBeTruthy();
  expect(contact.title).toBe('Recruiter');
  expect(contact.email).toBe('taylor@example.com');
  expect(contact.relationship).toBe('Recruiter');
  expect(contact.referralStatus).toBe('Warm intro');
  expect(contact.notes).toBe('Follow up after OA');
  expect(new Date(contact.nextFollowUp).toISOString().slice(0, 10)).toBe('2026-09-01');
});

test('rejecting an application prevents OA Received and Interview Received without an explicit override', async ({ page }) => {
  await page.goto('/');
  await waitForTrackerLoaded(page);

  const company = `Rejected Guard Co ${uniqueId()}`;
  await createOpportunity(page, company);
  await openApplication(page, company);

  await page.getByRole('button', { name: 'Rejected' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();
  await expect(page.getByTestId('app-status')).toHaveText('Rejected');

  // Both actions remain offered (not hidden) but require confirming an override.
  const oaReceivedButton = page.getByRole('button', { name: /OA Received/ });
  const interviewReceivedButton = page.getByRole('button', { name: /Interview Received/ });
  await expect(oaReceivedButton).toBeVisible();
  await expect(interviewReceivedButton).toBeVisible();

  page.once('dialog', (dialog) => dialog.dismiss());
  await oaReceivedButton.click();
  await expect(page.getByRole('heading', { name: 'OA Received' })).toHaveCount(0);
  await expect(page.getByTestId('app-status')).toHaveText('Rejected');

  page.once('dialog', (dialog) => dialog.dismiss());
  await interviewReceivedButton.click();
  await expect(page.getByRole('heading', { name: 'Interview Received' })).toHaveCount(0);
  await expect(page.getByTestId('app-status')).toHaveText('Rejected');

  // Confirming the override lets the transition through, and the backend
  // actually enforces it (not just the UI's confirm dialog).
  page.once('dialog', (dialog) => dialog.accept());
  await oaReceivedButton.click();
  await page.getByLabel('Due at').fill('2026-08-01T09:00');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();
  await expect(page.getByTestId('app-status')).toHaveText('OA');
});

test('the standard creation endpoint rejects an advanced status', async ({ page }) => {
  // Only Not Applied/Preparing can be created directly — Applied and beyond
  // are only reachable through the matching workflow action, which is what
  // guarantees status and currentStage always stay consistent (see
  // lib/schemas/workflows.ts and lib/workflow-policy.ts). This is also what
  // makes the missing-application-date warning logic exercised at the unit
  // level (lib/__tests__/workflow-policy.test.ts) safe to rely on: there is
  // no path — short of a future, separately-validated import feature — that
  // produces an "Applied" (or later) record with no application date.
  const company = `Invalid Status Co ${uniqueId()}`;
  const response = await page.request.post('/api/applications', {
    data: {
      company,
      role: 'Software Engineer',
      applicationUrl: `https://example.com/apply/${uniqueId()}`,
      priority: 'P1',
      status: 'Applied',
    },
  });
  expect(response.status()).toBe(400);

  await page.goto('/');
  await waitForTrackerLoaded(page);
  await page.getByRole('button', { name: 'Applications', exact: true }).click();
  await waitForTrackerLoaded(page);
  await expect(page.locator('table tbody tr', { hasText: company })).toHaveCount(0);
});

test('backend rejects an invalid workflow transition even via a direct API call', async ({ page }) => {
  const company = `Invalid Transition Co ${uniqueId()}`;
  const created = await page.request
    .post('/api/applications', {
      data: {
        company,
        role: 'Software Engineer',
        applicationUrl: `https://example.com/apply/${uniqueId()}`,
        priority: 'P1',
      },
    })
    .then((res) => res.json());

  // A freshly created application is "Not Applied" — OA Received is not a
  // valid transition from there, regardless of what the UI would allow.
  const response = await page.request.patch(`/api/applications/${created.id}`, {
    data: { action: 'oaReceived', dueAt: '2026-08-01T09:00' },
  });
  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error).toMatch(/not a valid transition/);
});
