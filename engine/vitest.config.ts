import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    /*
     * Thirty seconds, not vitest's five.
     *
     * This suite is mostly sweeps rather than unit tests: 20,000 generated
     * lines across twenty seeds, every daylight-saving transition of every
     * supported zone for a year, every registered unit against every other.
     * The slowest take one to two seconds on a developer's machine, which
     * looks like comfortable headroom against five and is not. A shared CI
     * runner under contention is easily several times slower, and the fuzz
     * sweep duly timed out on GitHub having passed the four runs before it.
     *
     * A flaky red build teaches people to re-run rather than to read, which
     * costs more than the thing the tight budget was buying. Thirty still
     * catches a genuine hang, which is the only failure a timeout should be
     * detecting here.
     *
     * Speed itself is asserted where it actually matters, and not by this.
     * `fuzz.test.ts` times the tokenizer against a two-second bound directly,
     * because that one runs on every keystroke and a slow one is a frozen
     * editor.
     */
    testTimeout: 30_000,
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
