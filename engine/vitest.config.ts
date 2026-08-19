import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    /*
     * Coverage as a gap-finder, not a tracked number.
     *
     * Run on demand with `npm run coverage`, not with the suite. The v8
     * instrumentation put the 20,000-line fuzz sweep over its five-second
     * budget, so every deploy would have paid for a table nobody reads on the
     * way past — the same cost the number itself was rejected for.
     *
     * The useful output is the list of branches nothing has ever executed —
     * `preprocess.ts` and `evaluate.ts` are where most of the engine's own
     * decisions live, and with no measurement at all nobody could say which of
     * them had been reached. It prints with the run and no threshold gates
     * anything: a percentage in CI starts costing more than it returns the
     * first time somebody writes a test to move it.
     */
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text'],
    },
  },
});
