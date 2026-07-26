# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workflows.spec.ts >> creates an opportunity, resume version, and workflow records
- Location: tests/e2e/workflows.spec.ts:5:5

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.fill: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByPlaceholder('Company')

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - complementary [ref=e4]:
    - generic [ref=e5]:
      - paragraph [ref=e6]: Local SWE Tracker
      - heading "Riddhima's Recruiting Command Center" [level=1] [ref=e7]
    - button "New Opportunity" [active] [ref=e8]
    - navigation [ref=e11]:
      - button "Dashboard" [ref=e12]
      - button "Applications" [ref=e18]
      - button "Pipeline" [ref=e23]
      - button "Deadlines" [ref=e26]
      - button "Job Descriptions" [ref=e29]
      - button "Interviews" [ref=e33]
      - button "Contacts" [ref=e36]
      - button "Resume Versions" [ref=e42]
      - button "Activity" [ref=e47]
      - button "Import / Export" [ref=e50]
      - button "Settings" [ref=e54]
  - main [ref=e58]:
    - generic [ref=e59]:
      - generic [ref=e60]:
        - paragraph [ref=e61]: Riddhima Yadav
        - heading "Dashboard" [level=2] [ref=e62]
      - textbox "Search applications" [ref=e67]
    - generic [ref=e68]: Loading tracker data…
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | const uniqueId = () => Math.random().toString(36).slice(2, 8);
  4  | 
  5  | test('creates an opportunity, resume version, and workflow records', async ({ page }) => {
  6  |   await page.goto('/');
  7  |   await page.getByRole('button', { name: 'New Opportunity' }).click();
> 8  |   await page.getByPlaceholder('Company').fill(`Acme ${uniqueId()}`);
     |                                          ^ Error: locator.fill: Test timeout of 30000ms exceeded.
  9  |   await page.getByPlaceholder('Role').fill('Software Engineer');
  10 |   await page.getByPlaceholder('Application URL').fill('https://example.com/apply');
  11 |   await page.getByRole('button', { name: 'Save' }).click();
  12 |   await expect(page.getByText('Opportunity created')).toBeVisible();
  13 | 
  14 |   await page.getByRole('button', { name: 'Resume Versions' }).click();
  15 |   await page.getByRole('button', { name: 'Create Resume' }).click();
  16 |   await page.getByPlaceholder('Resume name').fill(`Resume ${uniqueId()}`);
  17 |   await page.getByPlaceholder('Target role').fill('SWE');
  18 |   await page.getByRole('button', { name: 'Save resume' }).click();
  19 |   await expect(page.getByText('Resume created')).toBeVisible();
  20 | 
  21 |   await page.getByRole('button', { name: 'Dashboard' }).click();
  22 |   await page.getByRole('button', { name: 'Mark Applied' }).click();
  23 |   await page.getByLabel('Resume version').selectOption({ index: 1 });
  24 |   await page.getByRole('button', { name: 'Save' }).click();
  25 |   await expect(page.getByText('Workflow updated')).toBeVisible();
  26 | 
  27 |   await page.getByRole('button', { name: 'OA Received' }).click();
  28 |   await page.getByPlaceholder('Platform').fill('Coderbyte');
  29 |   await page.getByRole('button', { name: 'Save' }).click();
  30 |   await expect(page.getByText('Workflow updated')).toBeVisible();
  31 | 
  32 |   await page.getByRole('button', { name: 'Interview Received' }).click();
  33 |   await page.getByPlaceholder('Interview stage').fill('Recruiter Screen');
  34 |   await page.getByPlaceholder('Location').fill('Zoom');
  35 |   await page.getByRole('button', { name: 'Save' }).click();
  36 |   await expect(page.getByText('Workflow updated')).toBeVisible();
  37 | 
  38 |   await page.getByRole('button', { name: 'Interview Received' }).click();
  39 |   await page.getByPlaceholder('Interview stage').fill('Technical Interview');
  40 |   await page.getByPlaceholder('Location').fill('Office');
  41 |   await page.getByRole('button', { name: 'Save' }).click();
  42 |   await expect(page.getByText('Workflow updated')).toBeVisible();
  43 | 
  44 |   await page.getByRole('button', { name: 'Offer Received' }).click();
  45 |   await page.getByPlaceholder('Compensation').fill('$180k base');
  46 |   await page.getByRole('button', { name: 'Save' }).click();
  47 |   await expect(page.getByText('Workflow updated')).toBeVisible();
  48 | 
  49 |   await page.getByRole('button', { name: 'Rejected' }).click();
  50 |   await page.getByPlaceholder('Rejection notes').fill('No longer hiring');
  51 |   await page.getByRole('button', { name: 'Save' }).click();
  52 |   await expect(page.getByText('Workflow updated')).toBeVisible();
  53 | });
  54 | 
```