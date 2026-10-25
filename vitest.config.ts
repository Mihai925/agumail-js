import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  define: { __VERSION__: JSON.stringify(version) },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // A key in the developer's own environment must not reach the tests.
    env: { AGUMAIL_API_KEY: '' },
  },
});
