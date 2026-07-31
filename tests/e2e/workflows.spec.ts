import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';

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

// Selecting a row opens the detail drawer on its "Actions" tab by default
// (see components/applications/applications-table.tsx), so workflow
// buttons are immediately visible — no extra tab click needed.
//
// A row click TOGGLES selection, and a just-created opportunity is already
// auto-selected (see tracker-shell.tsx) — so if its drawer is already open,
// clicking the row again would close it instead. Only click when needed.
const openApplication = async (page: Page, company: string) => {
  await page.getByRole('button', { name: 'Applications', exact: true }).click();
  await waitForTrackerLoaded(page);
  const drawer = page.getByTestId('application-detail-drawer').filter({ hasText: company });
  if (!(await drawer.count())) {
    await page.locator('table tbody tr', { hasText: company }).click();
  }
  await expect(drawer).toBeVisible();
  await page.getByTestId('drawer-tab-actions').click();
};

// The drawer's Overview tab is where status details like offer/assessment
// fields and "Date applied" live — switch to it explicitly when a test
// needs to read those (workflow actions themselves are on the default
// "Actions" tab and never require this).
const openOverviewTab = async (page: Page) => {
  await page.getByTestId('drawer-tab-overview').click();
};

// OA/Interview/Offer actions are only valid once an application has been
// marked applied (see lib/workflow-policy.ts) — before that, the buttons
// are hidden entirely, so tests that need to reach those stages must apply
// first, same as a real user would. Resume tracking is no longer part of
// this workflow (the user manages resumes elsewhere) — Mark Applied needs
// nothing beyond opening it and saving.
const markApplied = async (page: Page, company: string) => {
  await openApplication(page, company);
  await page.getByRole('button', { name: 'Mark Applied' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();
};

test('completes an OA and interview workflow for a single application', async ({ page }) => {
  await page.goto('/');
  await waitForTrackerLoaded(page);

  const company = `Acme ${uniqueId()}`;
  await createOpportunity(page, company);
  await openApplication(page, company);

  // Mark Applied is only offered before the application has been submitted.
  // Resume tracking is no longer part of this workflow.
  await expect(page.getByRole('button', { name: 'Mark Applied' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark Applied' }).click();
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
  // Offer details live on the drawer's Overview tab.
  await openOverviewTab(page);
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
    data: { action: 'oaReceived', dueAt: '2026-08-01T09:00', timezone: 'America/New_York' },
  });
  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error).toMatch(/not a valid transition/);
});

test('backend rejects Set Application Date on an ordinary Not Applied record without submission evidence', async ({ page }) => {
  const company = `No Evidence Co ${uniqueId()}`;
  const created = await page.request
    .post('/api/applications', {
      data: { company, role: 'Software Engineer', applicationUrl: `https://example.com/apply/${uniqueId()}`, priority: 'P1' },
    })
    .then((res) => res.json());

  const rejected = await page.request.patch(`/api/applications/${created.id}`, {
    data: { action: 'setApplicationDate', dateApplied: '2026-07-20' },
  });
  expect(rejected.status()).toBe(400);
  const rejectedBody = await rejected.json();
  expect(rejectedBody.error).toMatch(/submission evidence/);

  // The explicit, narrow escape hatch still works for a caller that
  // deliberately confirms it (e.g. a future import pathway).
  const accepted = await page.request.patch(`/api/applications/${created.id}`, {
    data: { action: 'setApplicationDate', dateApplied: '2026-07-20', confirmImportRepair: true },
  });
  expect(accepted.ok()).toBe(true);
  const acceptedBody = await accepted.json();
  expect(new Date(acceptedBody.dateApplied).toISOString().slice(0, 10)).toBe('2026-07-20');
});

test('renders two Technical Interview records for the same application distinctly, with no React key warning', async ({ page }) => {
  const consoleWarnings: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /key/i.test(msg.text())) consoleWarnings.push(msg.text());
  });

  await page.goto('/');
  await waitForTrackerLoaded(page);

  const company = `Two Rounds Co ${uniqueId()}`;
  await createOpportunity(page, company);
  await markApplied(page, company);

  await page.getByRole('button', { name: 'Interview Received' }).click();
  await page.getByLabel('Interview stage').selectOption('Technical Interview');
  await page.getByLabel('Scheduled start').fill('2026-08-10T10:00');
  await page.getByLabel('Time zone').selectOption('America/New_York');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();

  await page.getByRole('button', { name: 'Interview Received' }).click();
  await page.getByLabel('Interview stage').selectOption('Technical Interview');
  await page.getByLabel('Scheduled start').fill('2026-08-20T15:00');
  await page.getByLabel('Time zone').selectOption('America/New_York');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();

  await page.getByRole('button', { name: 'Interviews', exact: true }).click();
  await waitForTrackerLoaded(page);

  const rows = page.getByText(`${company} • Software Engineer`, { exact: true });
  await expect(rows).toHaveCount(2);
  await expect(page.getByText('Aug 10, 2026')).toBeVisible();
  await expect(page.getByText('Aug 20, 2026')).toBeVisible();
  expect(consoleWarnings).toEqual([]);
});

const uploadWorkbook = async (page: Page, rows: Array<Record<string, unknown>>) => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  await page.getByRole('button', { name: 'Import / Export' }).click();
  await page.locator('#import-file').setInputFiles({ name: 'import.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
};

test('import preview distinguishes valid, invalid, and blank rows before anything is written', async ({ page }) => {
  await page.goto('/');
  await waitForTrackerLoaded(page);

  const company = `Preview Co ${uniqueId()}`;
  await uploadWorkbook(page, [
    { Company: company, Role: 'Software Engineer', URL: `https://example.com/apply/${uniqueId()}` },
    { Company: '', Role: '', URL: '' },
    { Company: 'Bad Row Co', Role: 'SWE', URL: 'not-a-url' },
  ]);

  await expect(page.getByText('3 rows')).toBeVisible();
  await expect(page.getByText('1 valid')).toBeVisible();
  await expect(page.getByText('1 invalid')).toBeVisible();
  await expect(page.getByText('1 blank')).toBeVisible();
  await expect(page.getByTestId('import-row-error')).toContainText('URL');

  // Nothing has been written to the database yet — only the preview ran.
  const beforeConfirm = await page.request.get('/api/applications').then((res) => res.json());
  expect(beforeConfirm.find((app: { company: string }) => app.company === company)).toBeUndefined();

  await page.getByRole('button', { name: 'Confirm Import' }).click();
  await expect(page.getByText(/1 created/).first()).toBeVisible();

  const afterConfirm = await page.request.get('/api/applications').then((res) => res.json());
  expect(afterConfirm.find((app: { company: string }) => app.company === company)).toBeTruthy();
  // The invalid/blank rows never got created.
  expect(afterConfirm.filter((app: { company: string }) => app.company === 'Bad Row Co')).toHaveLength(0);
});

test('import preview flags a duplicate against an existing application and defaults it to Skip', async ({ page }) => {
  await page.goto('/');
  await waitForTrackerLoaded(page);

  const company = `Existing Dup Co ${uniqueId()}`;
  const applicationUrl = `https://example.com/apply/${uniqueId()}`;
  await createOpportunity(page, company);

  await uploadWorkbook(page, [{ Company: company, Role: 'Software Engineer', URL: applicationUrl }]);
  await expect(page.getByText('1 match existing records')).toBeVisible();
  await expect(page.getByText('Matches an existing application')).toBeVisible();

  await page.getByRole('button', { name: 'Confirm Import' }).click();
  await expect(page.getByText(/1 skipped/).first()).toBeVisible();

  const applications = await page.request.get('/api/applications').then((res) => res.json());
  expect(applications.filter((app: { company: string }) => app.company === company)).toHaveLength(1);
});

test('repairs an imported Applied record missing its application date', async ({ page }) => {
  const company = `Imported Applied Co ${uniqueId()}`;

  await page.goto('/');
  await waitForTrackerLoaded(page);
  await uploadWorkbook(page, [{ Company: company, Role: 'Software Engineer', URL: `https://example.com/apply/${uniqueId()}`, Priority: 'P1', Status: 'Applied' }]);
  await expect(page.getByText('1 valid')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm Import' }).click();
  await expect(page.getByText(/1 created/).first()).toBeVisible();

  await openApplication(page, company);

  // Imported directly as "Applied" with no dateApplied — Mark Applied is
  // unavailable (the status is already past it), so the warning must offer
  // a real way to fix the record instead of pointing at a hidden button.
  await expect(page.getByRole('button', { name: 'Mark Applied' })).toHaveCount(0);
  const warning = page.getByTestId('missing-date-applied-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('Applied');

  await warning.getByRole('button', { name: 'Set Application Date' }).click();
  await page.getByLabel('Application date').fill('2026-07-15');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow updated').last()).toBeVisible();

  await expect(page.getByTestId('missing-date-applied-warning')).toHaveCount(0);
  await openOverviewTab(page);
  await expect(page.getByTestId('date-applied')).toHaveText('Jul 15, 2026');

  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await waitForTrackerLoaded(page);
  // The Activity view is global across all applications, so scope the
  // check to an entry that also mentions this test's own company — other
  // tests running in the same shared e2e database may log the same event
  // type for their own (differently-named) applications.
  await expect(page.locator('div', { hasText: company }).filter({ hasText: 'Application date repaired' }).first()).toBeVisible();
});

test('commit API rejects an unknown action rather than silently ignoring it', async ({ page }) => {
  const response = await page.request.post('/api/import/commit', {
    data: { rows: [{ rowNumber: 2, action: 'delete', data: { company: 'X', role: 'Y', applicationUrl: 'https://example.com', priority: 'P1', status: 'Not Applied' } }] },
  });
  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error).toBe('Invalid commit request');
});

test('commit API rejects a stale/tampered matchedApplicationId that no longer matches the row', async ({ page }) => {
  const companyA = `Stale Match A ${uniqueId()}`;
  const companyB = `Stale Match B ${uniqueId()}`;
  const createdA = await page.request
    .post('/api/applications', { data: { company: companyA, role: 'Software Engineer', applicationUrl: `https://example.com/apply/${uniqueId()}`, priority: 'P1' } })
    .then((res) => res.json());
  await page.request.post('/api/applications', { data: { company: companyB, role: 'Software Engineer', applicationUrl: `https://example.com/apply/${uniqueId()}`, priority: 'P1' } });

  // Claims to update application A's id, but the row's own company/role/URL
  // match neither A nor anything else — the server must re-verify the match
  // itself rather than trusting this client-supplied id at face value.
  const response = await page.request.post('/api/import/commit', {
    data: {
      rows: [{
        rowNumber: 2,
        action: 'update',
        matchedApplicationId: createdA.id,
        data: {
          company: `Totally Different Co ${uniqueId()}`, role: 'Some Other Role', applicationUrl: `https://example.com/apply/${uniqueId()}`,
          priority: 'P1', status: 'Not Applied', applicationDeadline: null, dateFound: null,
          dateApplied: null, assessmentDueAt: null, assessmentTimezone: null,
          interviewScheduledStart: null, interviewTimezone: null, offerDecisionDeadline: null,
          nextActionDue: null, nextActionDueKind: null,
        },
      }],
    },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.errors).toHaveLength(1);
  expect(body.errors[0].errors[0]).toMatch(/no longer matches/);

  // Company A itself must be untouched.
  const stillA = await page.request.get(`/api/applications/${createdA.id}`).then((res) => res.json());
  expect(stillA.company).toBe(companyA);
});

test('commit API rejects Update existing when the matched application no longer exists', async ({ page }) => {
  const response = await page.request.post('/api/import/commit', {
    data: {
      rows: [{
        rowNumber: 2,
        action: 'update',
        matchedApplicationId: 'does-not-exist-at-all',
        data: {
          company: 'Ghost Co', role: 'SWE', applicationUrl: `https://example.com/apply/${uniqueId()}`,
          priority: 'P1', status: 'Not Applied', applicationDeadline: null, dateFound: null,
          dateApplied: null, assessmentDueAt: null, assessmentTimezone: null,
          interviewScheduledStart: null, interviewTimezone: null, offerDecisionDeadline: null,
          nextActionDue: null, nextActionDueKind: null,
        },
      }],
    },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.errors).toHaveLength(1);
  expect(body.errors[0].errors[0]).toMatch(/no longer exists/);
});

test('commit API automatically backs up the database before writing, and reports the backup path', async ({ page }) => {
  const company = `Backup Check Co ${uniqueId()}`;
  const response = await page.request.post('/api/import/commit', {
    data: {
      rows: [{
        rowNumber: 2,
        action: 'create',
        data: {
          company, role: 'SWE', applicationUrl: `https://example.com/apply/${uniqueId()}`,
          priority: 'P1', status: 'Not Applied', applicationDeadline: null, dateFound: null,
          dateApplied: null, assessmentDueAt: null, assessmentTimezone: null,
          interviewScheduledStart: null, interviewTimezone: null, offerDecisionDeadline: null,
          nextActionDue: null, nextActionDueKind: null,
        },
      }],
    },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.created).toBe(1);
  expect(body.backup?.fileName).toMatch(/e2e-test\.db\.pre-import-.*\.bak/);

  const backupPath = path.resolve(__dirname, '..', '..', 'data', 'backups', body.backup.fileName);
  expect(fs.existsSync(backupPath)).toBe(true);
});
