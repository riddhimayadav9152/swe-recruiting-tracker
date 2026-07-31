import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';
import { defineConfig, globalIgnores } from 'eslint/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = defineConfig([
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@next/next/no-img-element': 'off',
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Playwright's own generated artifacts (HTML report + trace viewer
    // assets, per-test trace/screenshot output) — minified bundles that
    // aren't project source, only ever present after running `npm run
    // test:e2e` locally. Already gitignored; excluding them here too so a
    // local test run (especially one with a failure, which is when
    // Playwright actually populates playwright-report/trace/assets) can't
    // make `npm run lint` fail on someone else's generated JS.
    'playwright-report/**',
    'test-results/**',
  ]),
]);

export default eslintConfig;
