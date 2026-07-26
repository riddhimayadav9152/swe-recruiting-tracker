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
    command: `npm run dev -- -p ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { DATABASE_URL: e2eDatabaseUrl },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
