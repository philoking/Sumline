import { defineConfig } from 'vitest/config';

/**
 * `node`, not a browser environment.
 *
 * What is tested here is the editor's *state* logic, which CodeMirror keeps
 * entirely separate from its view: `@codemirror/state` touches no DOM, so a
 * transaction filter can be driven headlessly. Anything needing a real view
 * would need jsdom, and would be testing CodeMirror rather than this app.
 *
 * Two files opt out, with `// @vitest-environment jsdom` at the top.
 * `useSheetLock` and `useActiveSheet` are effects, timers and a `pagehide`
 * listener, and between them they decide whether two people can overwrite each
 * other, so they have to be rendered to be tested at all. Opted into per file
 * rather than switched on for everything, so the rest keeps running headless
 * and the paragraph above stays true of it.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
