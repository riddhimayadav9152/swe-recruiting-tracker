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
};

test.describe('Edit Application', () => {
  test('edits base fields through the Edit Application modal and records the change', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const company = `Edit Co ${uniqueId()}`;
    await createOpportunity(page, company);
    await openApplication(page, company);

    await page.getByTestId('drawer-tab-overview').click();
    await page.getByTestId('open-edit-application').click();

    await page.getByLabel('Job ID').fill('REQ-9001');
    await page.getByLabel('Location').fill('Austin, TX');
    await page.getByLabel('Compensation summary').fill('$175k base');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText('Application updated')).toBeVisible();

    // Persisted server-side.
    const applications = await page.request.get('/api/applications').then((res) => res.json());
    const updated = applications.find((app: { company: string }) => app.company === company);
    expect(updated.jobId).toBe('REQ-9001');
    expect(updated.location).toBe('Austin, TX');
    expect(updated.compensationSummary).toBe('$175k base');

    // Reflected in the Overview tab.
    await expect(page.locator('dl').filter({ hasText: 'Compensation' })).toContainText('$175k base');
  });

  test('does not offer a status field on the edit form — status only changes via workflow actions', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const company = `No Status Field Co ${uniqueId()}`;
    await createOpportunity(page, company);
    await openApplication(page, company);
    await page.getByTestId('drawer-tab-overview').click();
    await page.getByTestId('open-edit-application').click();

    await expect(page.getByLabel('Status', { exact: true })).toHaveCount(0);
  });
});

test.describe('Notes CRUD', () => {
  test('adds, edits, and deletes a note from the Notes tab', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const company = `Notes Co ${uniqueId()}`;
    await createOpportunity(page, company);
    await openApplication(page, company);
    await page.getByTestId('drawer-tab-notes').click();

    await page.getByPlaceholder('Add a note…').fill('Great first conversation');
    await page.getByRole('button', { name: 'Add Note' }).click();
    await expect(page.getByText('Note added')).toBeVisible();

    // Held as a live handle (not re-filtered by text) — once edit mode
    // swaps the card's content for a <select>/<textarea>, the note's
    // content no longer appears as literal DOM text (it's a controlled
    // form value), so re-querying by hasText would stop matching.
    const noteCard = page.getByTestId('note-card');
    await expect(noteCard).toContainText('Great first conversation');

    await noteCard.getByRole('button', { name: 'Edit' }).click();
    await noteCard.locator('textarea').fill('Updated note content');
    await noteCard.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Note updated')).toBeVisible();
    await expect(noteCard).toContainText('Updated note content');

    page.once('dialog', (dialog) => dialog.accept());
    await noteCard.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Note deleted')).toBeVisible();
    await expect(page.getByTestId('note-card')).toHaveCount(0);
  });
});

test.describe('Links CRUD', () => {
  test('adds, edits, and deletes an additional link from the Links & Login tab', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const company = `Links Co ${uniqueId()}`;
    await createOpportunity(page, company);
    await openApplication(page, company);
    await page.getByTestId('drawer-tab-links').click();

    await page.getByRole('button', { name: '+ Add link' }).click();
    await page.getByPlaceholder('Label').fill('Company careers page');
    await page.getByPlaceholder('https://…').fill('https://example.com/careers');
    await page.getByRole('button', { name: 'Save Link' }).click();
    await expect(page.getByText('Link added')).toBeVisible();

    // Held as a live handle for the same reason as the note-card handle
    // above — editing swaps the label text for an <input>, so re-filtering
    // by hasText after that point would stop matching.
    const linkCard = page.getByTestId('application-link');
    await expect(linkCard).toContainText('Company careers page');

    await linkCard.getByTitle('Edit link').click();
    await linkCard.locator('input').first().fill('Renamed careers page');
    await linkCard.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Link updated')).toBeVisible();
    await expect(linkCard).toContainText('Renamed careers page');

    page.once('dialog', (dialog) => dialog.accept());
    await linkCard.getByTitle('Delete link').click();
    await expect(page.getByText('Link deleted')).toBeVisible();
    await expect(page.getByTestId('application-link')).toHaveCount(0);
  });

  test('renders Open Job Posting / Open Candidate Portal buttons and login details from the base record', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const company = `Portal Co ${uniqueId()}`;
    await createOpportunity(page, company);
    await openApplication(page, company);
    await page.getByTestId('drawer-tab-overview').click();
    await page.getByTestId('open-edit-application').click();
    await page.getByLabel('Candidate portal URL').fill('https://portal.example.com');
    await page.getByLabel('Login email').fill('candidate@example.com');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText('Application updated')).toBeVisible();

    await page.getByTestId('drawer-tab-links').click();
    await expect(page.getByRole('link', { name: /Open Job Posting/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Open Candidate Portal/ })).toBeVisible();
    await expect(page.getByText('candidate@example.com')).toBeVisible();
  });
});

test.describe('Sidebar collapse/expansion + persistence', () => {
  test('collapsing the sidebar persists across a reload, and expanding it persists too', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toHaveCount(0);

    await page.reload();
    await waitForTrackerLoaded(page);
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();

    await page.reload();
    await waitForTrackerLoaded(page);
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
  });
});

test.describe('JSON import ("Paste Application Import")', () => {
  const jsonImportPayload = (applications: Array<Record<string, unknown>>) => JSON.stringify({
    format: 'swe-recruiting-tracker.application-import.v1',
    applications,
  });

  test('imports a single application from pasted JSON', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const company = `JSON Single Co ${uniqueId()}`;
    await page.getByRole('button', { name: 'Paste Application Import' }).click();
    await page.getByPlaceholder('Paste JSON here…').fill(jsonImportPayload([
      { company, role: 'Software Engineer', applicationUrl: `https://example.com/apply/${uniqueId()}`, priority: 'P1', status: 'Not Applied' },
    ]));
    await page.getByRole('button', { name: 'Validate and Preview' }).click();
    await expect(page.getByText('1 valid, 0 invalid')).toBeVisible();

    await page.getByRole('button', { name: 'Confirm Import' }).click();
    await expect(page.getByText(/1 created/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Applications', exact: true }).click();
    await waitForTrackerLoaded(page);
    await expect(page.locator('table tbody tr', { hasText: company })).toHaveCount(1);
  });

  test('imports multiple applications from a single pasted document', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const companyA = `JSON Multi A ${uniqueId()}`;
    const companyB = `JSON Multi B ${uniqueId()}`;
    await page.getByRole('button', { name: 'Paste Application Import' }).click();
    await page.getByPlaceholder('Paste JSON here…').fill(jsonImportPayload([
      { company: companyA, role: 'Software Engineer', applicationUrl: `https://example.com/apply/${uniqueId()}`, priority: 'P0', status: 'Not Applied' },
      { company: companyB, role: 'Backend Engineer', applicationUrl: `https://example.com/apply/${uniqueId()}`, priority: 'P2', status: 'Not Applied' },
    ]));
    await page.getByRole('button', { name: 'Validate and Preview' }).click();
    await expect(page.getByText('2 valid, 0 invalid')).toBeVisible();

    await page.getByRole('button', { name: 'Confirm Import' }).click();
    await expect(page.getByText(/2 created/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Applications', exact: true }).click();
    await waitForTrackerLoaded(page);
    await expect(page.locator('table tbody tr', { hasText: companyA })).toHaveCount(1);
    await expect(page.locator('table tbody tr', { hasText: companyB })).toHaveCount(1);
  });

  test('flags a duplicate against an existing application, defaults it to Skip, and never creates a second row', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const company = `JSON Dup Co ${uniqueId()}`;
    const applicationUrl = `https://example.com/apply/${uniqueId()}`;
    await createOpportunity(page, company);

    await page.getByRole('button', { name: 'Paste Application Import' }).click();
    await page.getByPlaceholder('Paste JSON here…').fill(jsonImportPayload([
      { company, role: 'Software Engineer', applicationUrl, priority: 'P1', status: 'Not Applied' },
    ]));
    await page.getByRole('button', { name: 'Validate and Preview' }).click();
    await expect(page.getByTestId('json-import-duplicate-warning')).toBeVisible();
    await expect(page.getByTestId('json-import-row-action')).toHaveValue('skip');

    await page.getByRole('button', { name: 'Confirm Import' }).click();
    await expect(page.getByText(/1 skipped/).first()).toBeVisible();

    const applications = await page.request.get('/api/applications').then((res) => res.json());
    expect(applications.filter((app: { company: string }) => app.company === company)).toHaveLength(1);
  });

  test('rejects an unsupported format version before writing anything', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    await page.getByRole('button', { name: 'Paste Application Import' }).click();
    await page.getByPlaceholder('Paste JSON here…').fill(JSON.stringify({
      format: 'some-other-format.v99',
      applications: [{ company: 'X', role: 'Y', applicationUrl: 'https://example.com', priority: 'P1', status: 'Not Applied' }],
    }));
    await page.getByRole('button', { name: 'Validate and Preview' }).click();
    await expect(page.getByText(/Unsupported or missing format version/)).toBeVisible();
  });

  test('shows a "Paste Application Import" button beside "+ New" on the Applications page', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);
    await page.getByRole('button', { name: 'Applications', exact: true }).click();
    await waitForTrackerLoaded(page);

    const importButton = page.getByTestId('paste-application-import-button');
    await expect(importButton).toBeVisible();
    await expect(importButton).toHaveText('Paste Application Import');
    await expect(page.getByRole('button', { name: '+ New' })).toBeVisible();
  });

  test('does not offer Create for an in-batch duplicate and imports only the non-duplicate row', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const company = `JSON Rollback Co ${uniqueId()}`;
    const applicationUrl = `https://example.com/apply/${uniqueId()}`;
    await page.getByRole('button', { name: 'Paste Application Import' }).click();
    await page.getByPlaceholder('Paste JSON here…').fill(jsonImportPayload([
      { company, role: 'Software Engineer', applicationUrl, priority: 'P1', status: 'Not Applied' },
      { company, role: 'Software Engineer', applicationUrl, priority: 'P1', status: 'Not Applied' },
    ]));
    await page.getByRole('button', { name: 'Validate and Preview' }).click();
    await expect(page.getByText('2 valid, 0 invalid')).toBeVisible();
    await expect(page.getByTestId('json-import-duplicate-warning')).toBeVisible();

    const rowActions = page.getByTestId('json-import-row-action');
    await rowActions.nth(0).selectOption('create');
    await expect(rowActions.nth(1)).toHaveValue('skip');
    await expect(rowActions.nth(1).locator('option[value="create"]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Confirm Import' }).click();
    await expect(page.getByText('Imported: 1 created, 0 updated, 1 skipped')).toBeVisible();

    await page.getByRole('button', { name: 'Applications', exact: true }).click();
    await waitForTrackerLoaded(page);
    await expect(page.locator('table tbody tr', { hasText: company })).toHaveCount(1);
  });
});

test.describe('Job descriptions', () => {
  test('resets unsaved editor values when selecting another application', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const companyA = `JD Leak A ${uniqueId()}`;
    const companyB = `JD Leak B ${uniqueId()}`;
    await createOpportunity(page, companyA);
    await createOpportunity(page, companyB);
    await openApplication(page, companyA);

    await page.getByRole('button', { name: 'Job Descriptions' }).click();
    await page.getByLabel('Full job description').fill('Unsaved Company A description');
    await page.getByLabel('Source URL').fill('https://example.com/company-a-jd');
    await page.getByLabel('Keywords / tags').fill('company-a-keyword');

    await page.getByRole('button', { name: 'Applications', exact: true }).click();
    await page.locator('table tbody tr', { hasText: companyB }).click();
    await page.getByRole('button', { name: 'Job Descriptions' }).click();

    await expect(page.getByLabel('Full job description')).toHaveValue('');
    await expect(page.getByLabel('Source URL')).toHaveValue('');
    await expect(page.getByLabel('Keywords / tags')).toHaveValue('');

    await page.getByLabel('Full job description').fill('Company B real description');
    await page.getByRole('button', { name: 'Save description' }).click();
    await expect(page.getByText('Job description saved')).toBeVisible();

    const applications = await page.request.get('/api/applications').then((res) => res.json());
    const appA = applications.find((app: { company: string }) => app.company === companyA);
    const appB = applications.find((app: { company: string }) => app.company === companyB);
    expect(appA.jobDescription).toBeNull();
    expect(appB.jobDescription.fullText).toBe('Company B real description');
  });
});

test.describe('Applications table layout', () => {
  test('table is full width with no permanent side panel; row selection opens a dismissible drawer above the table', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const company = `Layout Co ${uniqueId()}`;
    await createOpportunity(page, company);
    await page.getByRole('button', { name: 'Applications', exact: true }).click();
    await waitForTrackerLoaded(page);

    // A newly created opportunity is auto-selected — close it to get back to
    // the baseline "nothing selected" state before checking table width.
    await page.getByTestId('close-drawer').click();
    await expect(page.getByTestId('application-detail-drawer')).toHaveCount(0);
    const table = page.locator('table');
    const tableBoxBefore = await table.boundingBox();
    expect(tableBoxBefore).not.toBeNull();
    // Comfortably wider than any fixed two-column layout would allow at the
    // default ~1280px viewport, confirming the table isn't sharing width with
    // a permanently reserved side panel.
    expect(tableBoxBefore!.width).toBeGreaterThan(700);

    await page.locator('table tbody tr', { hasText: company }).click();
    const drawer = page.getByTestId('application-detail-drawer');
    await expect(drawer).toBeVisible();

    const drawerBox = await drawer.boundingBox();
    const tableBoxAfter = await table.boundingBox();
    expect(drawerBox).not.toBeNull();
    expect(tableBoxAfter).not.toBeNull();
    // Stacked vertically above the table (not side-by-side): the drawer ends
    // at or above where the table begins, and both span roughly the same width.
    expect(drawerBox!.y + drawerBox!.height).toBeLessThanOrEqual(tableBoxAfter!.y + 5);
    expect(Math.abs(drawerBox!.width - tableBoxAfter!.width)).toBeLessThan(50);

    // Collapsing hides the tab content but keeps the header (and toggle) visible.
    await drawer.getByTitle('Collapse').click();
    await expect(page.getByTestId('drawer-tab-overview')).toHaveCount(0);
    await expect(drawer).toContainText(company);

    // Expanding again restores the tabs.
    await drawer.getByTitle('Collapse').click();
    await expect(page.getByTestId('drawer-tab-overview')).toBeVisible();

    // Closing removes the drawer entirely, reclaiming the space.
    await page.getByTestId('close-drawer').click();
    await expect(page.getByTestId('application-detail-drawer')).toHaveCount(0);
  });
});

test.describe('Column sorting', () => {
  test('clicking the Company header sorts ascending, then descending', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const companyA = `AAA Sort ${uniqueId()}`;
    const companyZ = `ZZZ Sort ${uniqueId()}`;
    await createOpportunity(page, companyA);
    await createOpportunity(page, companyZ);
    await page.getByRole('button', { name: 'Applications', exact: true }).click();
    await waitForTrackerLoaded(page);

    await page.getByRole('columnheader', { name: 'Company' }).click();
    const rowsAsc = await page.locator('table tbody tr').allTextContents();
    const idxAAsc = rowsAsc.findIndex((t) => t.includes(companyA));
    const idxZAsc = rowsAsc.findIndex((t) => t.includes(companyZ));
    expect(idxAAsc).toBeGreaterThanOrEqual(0);
    expect(idxZAsc).toBeGreaterThanOrEqual(0);
    expect(idxAAsc).toBeLessThan(idxZAsc);

    await page.getByRole('columnheader', { name: 'Company' }).click();
    const rowsDesc = await page.locator('table tbody tr').allTextContents();
    const idxADesc = rowsDesc.findIndex((t) => t.includes(companyA));
    const idxZDesc = rowsDesc.findIndex((t) => t.includes(companyZ));
    expect(idxADesc).toBeGreaterThan(idxZDesc);
  });
});

test.describe('Deadlines tab', () => {
  test('auto-generates a personal deadline for a new opportunity and labels My/Official deadline separately', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const company = `Deadline Co ${uniqueId()}`;
    await createOpportunity(page, company);

    await page.getByRole('button', { name: 'Deadlines', exact: true }).click();
    await waitForTrackerLoaded(page);
    const row = page.getByTestId('deadline-row').filter({ hasText: company });
    await expect(row).toBeVisible();
    await expect(row).toContainText('My deadline:');
    await expect(row).toContainText('Official deadline:');
    // A personal apply-by date is generated even though none was supplied.
    await expect(row).not.toContainText('My deadline: —');
  });

  test('sorts overdue personal deadlines ahead of future ones', async ({ page }) => {
    await page.goto('/');
    await waitForTrackerLoaded(page);

    const overdueCompany = `Overdue Co ${uniqueId()}`;
    const futureCompany = `Future Co ${uniqueId()}`;
    await createOpportunity(page, overdueCompany);
    await createOpportunity(page, futureCompany);

    await openApplication(page, overdueCompany);
    await page.getByTestId('drawer-tab-overview').click();
    await page.getByTestId('open-edit-application').click();
    const dueField = page.locator('label', { hasText: 'Personal next-action due' }).locator('input[type="date"]');
    await dueField.fill('2020-01-01');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText('Application updated')).toBeVisible();

    await page.getByRole('button', { name: 'Deadlines', exact: true }).click();
    await waitForTrackerLoaded(page);
    const rows = await page.getByTestId('deadline-row').allTextContents();
    const overdueIdx = rows.findIndex((t) => t.includes(overdueCompany));
    const futureIdx = rows.findIndex((t) => t.includes(futureCompany));
    expect(overdueIdx).toBeGreaterThanOrEqual(0);
    expect(futureIdx).toBeGreaterThanOrEqual(0);
    expect(overdueIdx).toBeLessThan(futureIdx);
  });
});
