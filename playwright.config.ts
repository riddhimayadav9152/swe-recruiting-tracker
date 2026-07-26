import { defineConfig, devices } from '@playwright/test';
import { e2eDatabaseUrl } from './tests/e2e/e2e-db';

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  globalSetup: require.resolve('./tests/e2e/global-setup.ts'),
  reporter: [['html', { open: 'never' }]],
  use: { baseURL, browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    // Invoke `next dev` directly rather than through `npm run dev` — npm
    // doesn't forward signals to the process it spawns, so going through it
    // can leave the dev server running after Playwright tears down.
    command: `npx next dev -p ${port}`,
    url: baseURL,
    // Always launch a fresh server against the dedicated E2E database —
    // reusing a server the developer left running elsewhere (e.g. on the
    // dev database) would silently defeat the isolation `global-setup.ts`
    // sets up, so this is never conditional on CI.
    reuseExistingServer: false,
    timeout: 120_000,
    env: { DATABASE_URL: e2eDatabaseUrl },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
