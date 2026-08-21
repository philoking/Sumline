import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs, render } from '../src/cli.js';

/**
 * The two halves of the CLI that are not the network.
 *
 * `main` is a POST and a printer, and the endpoint it posts to has a suite of
 * its own. What is worth pinning here is the argument grammar — where one line
 * ends and the next begins — and the shape of the output, because a script
 * reading it positionally is relying on that shape.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('reading the arguments', () => {
  it('takes the words of one line without needing them quoted', () => {
    // Quoting is the shell's business. `sumline 10 + 5` should answer 15
    // rather than complain about three arguments.
    expect(parseArgs(['10', '+', '5']).lines).toEqual(['10 + 5']);
  });

  it('treats -- as the break between lines', () => {
    expect(parseArgs(['day rate * 3', '--', 'prev + 100']).lines).toEqual([
      'day rate * 3',
      'prev + 100',
    ]);
  });

  it('keeps an empty line that was asked for', () => {
    // A sheet can have a blank in it, and dropping one would shift every `line
    // N` reference below it.
    expect(parseArgs(['10', '--', '--', '20']).lines).toEqual(['10', '', '20']);
  });

  it('has no lines at all when given none, so stdin is read instead', () => {
    expect(parseArgs([]).lines).toEqual([]);
    expect(parseArgs(['--json']).lines).toEqual([]);
  });

  it('reads the options without taking them for expression words', () => {
    const options = parseArgs([
      '--url',
      'http://box:8422',
      '--space',
      'teaching',
      '--json',
      '3+4',
    ]);
    expect(options).toMatchObject({
      url: 'http://box:8422',
      space: 'teaching',
      json: true,
      lines: ['3+4'],
    });
  });

  it('defaults the instance to the port the compose file publishes', () => {
    // Which is what every `curl` example in the README uses; a CLI that
    // defaulted somewhere else would be the one thing on the page that needed
    // a flag to work. Stubbed rather than assumed, so this says the same thing
    // on a machine that has the variable set.
    vi.stubEnv('SUMLINE_URL', '');
    expect(parseArgs([]).url).toBe('http://localhost:8422');
  });

  it('prefers the environment to the default, and the flag to both', () => {
    // The launcher case: one export in a shell profile, and every invocation
    // afterwards asks the right instance without repeating itself.
    vi.stubEnv('SUMLINE_URL', 'http://box:8422');
    vi.stubEnv('SUMLINE_SPACE', 'consulting');
    expect(parseArgs([])).toMatchObject({ url: 'http://box:8422', space: 'consulting' });
    expect(parseArgs(['--url', 'http://other:9000']).url).toBe('http://other:9000');
  });
});

describe('printing the answers', () => {
  const line = (input: string, output: string, error?: string) => ({
    index: 0,
    kind: 'expression',
    input,
    output,
    ...(error !== undefined && { error }),
  });

  it('prints one answer bare, for a command substitution', () => {
    expect(render([line('2 + 2', '4')])).toEqual({ out: ['4'], err: [] });
  });

  it('keeps a single failure off stdout entirely', () => {
    // The failure that matters: `total=$(sumline "…")` must not come back
    // holding a sentence about what went wrong and spend it as a number.
    expect(render([line('10 USD in XYZ', '', 'No unit or currency called XYZ')])).toEqual(
      {
        out: [],
        err: ['No unit or currency called XYZ'],
      },
    );
  });

  it('lines a sheet’s answers up in a column', () => {
    const { out } = render([line('10', '10'), line('10 + 5', '15')]);
    expect(out).toEqual(['10      10', '10 + 5  15']);
  });

  it('marks a failed line in place rather than dropping it', () => {
    // One line in, one line out: a caller reading the output positionally must
    // not have its lines renumbered by a failure in the middle.
    const { out } = render([
      line('1 + 1', '2'),
      line('nope in XYZ', '', 'No unit or currency called XYZ'),
      line('3 + 3', '6'),
    ]);
    expect(out).toHaveLength(3);
    expect(out[1]).toContain('! No unit or currency called XYZ');
  });

  it('shows a line that has no answer as itself', () => {
    // Headings and comments answer nothing; padding them out to an empty
    // column would be trailing whitespace and nothing else.
    const { out } = render([line('# Costs', ''), line('1 + 1', '2')]);
    expect(out[0]).toBe('# Costs');
  });
});
