import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // node:sqlite is behind a flag on Node 22 and unflagged from 23.4 onwards;
    // passing it here keeps `npm test` working on both.
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'],
      },
    },
  },
});
