import { defineConfig } from 'vitest/config';

/**
 * `node`, not a browser environment.
 *
 * What is tested here is the editor's *state* logic, which CodeMirror keeps
 * entirely separate from its view: `@codemirror/state` touches no DOM, so a
 * transaction filter can be driven headlessly. Anything needing a real view
 * would need jsdom, and would be testing CodeMirror rather than this app.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
