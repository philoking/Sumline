import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { findMatch } from '../src/db.js';
import type { SheetSummary } from '../src/db.js';

let app: App;

function build(): App {
  return buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    rateFetcher: async () => ({ base: 'USD', date: '2026-08-14', rates: { EUR: 0.8 } }),
    holidayFetcher: async () => [],
  });
}

async function createSheet(title: string, content = '') {
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/sheets',
    payload: { title, content },
  });
  return response.json() as { id: string };
}

async function search(term: string): Promise<SheetSummary[]> {
  const response = await app.server.inject({
    url: `/api/sheets?q=${encodeURIComponent(term)}`,
  });
  return (response.json() as { sheets: SheetSummary[] }).sheets;
}

beforeEach(() => {
  app = build();
});

afterEach(async () => {
  await app.server.close();
});

describe('finding the matching line', () => {
  it('quotes the line the term appears on, with its gutter number', () => {
    const match = findMatch('first line\nsecond line\nrent = 1500', 'rent');
    expect(match).toEqual({
      line: 3,
      text: 'rent = 1500',
      at: 0,
      length: 4,
      truncated: false,
    });
  });

  it('matches case-insensitively, the way the SQL LIKE that selected the row does', () => {
    // The two must agree. A row selected by LIKE that this could not find would
    // come back as a match with nothing to show for it.
    expect(findMatch('Total Rent Paid', 'rent')?.text).toBe('Total Rent Paid');
    expect(findMatch('total rent paid', 'RENT')?.text).toBe('total rent paid');
  });

  it('reports the offset of the match, not of the first occurrence in the sheet', () => {
    const match = findMatch('nothing here\npaid rent monthly', 'rent');
    expect(match?.line).toBe(2);
    expect(match?.at).toBe(5);
    expect(match?.text.slice(match.at, match.at + match.length)).toBe('rent');
  });

  it('strips a line’s leading indent and corrects the offset for it', () => {
    const match = findMatch('      rent = 1500', 'rent');
    expect(match?.text).toBe('rent = 1500');
    expect(match?.at).toBe(0);
  });

  it('windows a long line so the match stays visible', () => {
    const line = `${'x'.repeat(200)} rent ${'y'.repeat(200)}`;
    const match = findMatch(line, 'rent');
    expect(match?.truncated).toBe(true);
    expect(match?.text.length).toBeLessThanOrEqual(90);
    // The whole point of windowing rather than truncating from the start.
    expect(match?.text.slice(match.at, match.at + match.length)).toBe('rent');
  });

  it('finds nothing for a term that is not in the body', () => {
    expect(findMatch('groceries $20', 'rent')).toBeNull();
    expect(findMatch('groceries $20', '   ')).toBeNull();
  });
});

describe('search results', () => {
  it('carries the matching line back with the result', async () => {
    await createSheet('August', 'groceries $20\nmonthly rent = 1500');
    const [result] = await search('rent');
    expect(result?.match).toMatchObject({ line: 2, text: 'monthly rent = 1500' });
  });

  it('quotes nothing when only the title matched', async () => {
    // Quoting a body line that does not contain the term would misrepresent why
    // the sheet is in the list.
    await createSheet('Rent review', 'groceries $20');
    const [result] = await search('rent');
    expect(result?.title).toBe('Rent review');
    expect(result?.match).toBeUndefined();
  });

  it('never ships sheet bodies, searching or not', async () => {
    await createSheet('August', 'monthly rent = 1500');

    const [found] = await search('rent');
    expect(found).not.toHaveProperty('content');

    const plain = await app.server.inject({ url: '/api/sheets' });
    const [listed] = (plain.json() as { sheets: SheetSummary[] }).sheets;
    expect(listed).not.toHaveProperty('content');
    expect(listed).not.toHaveProperty('match');
  });

  it('still reports the line count, which is what a browsed row shows', async () => {
    await createSheet('August', 'a\nb\nc');
    const [listed] = await search('August');
    expect(listed?.lines).toBe(3);
  });
});

describe('a search term that looks like a wildcard', () => {
  // `%` and `_` mean something to SQLite’s LIKE and nothing to the reader
  // typing them. `20% of 250` is the editor’s own placeholder text, so a
  // search for `50%` is not an exotic thing for this app to be asked.
  it('matches a percent sign literally rather than as “anything”', async () => {
    await createSheet('August', '20% of 250');
    await createSheet('Shopping', '150 apples');

    const results = await search('50%');
    expect(results.map((sheet) => sheet.title)).toEqual(['August']);
  });

  it('finds nothing for a bare percent sign, rather than everything', async () => {
    await createSheet('August', '20% of 250');
    await createSheet('Shopping', '150 apples');

    expect(await search('%')).toEqual([]);
  });

  it('matches an underscore literally rather than as “any character”', async () => {
    await createSheet('Rates', 'a_b = 2');
    await createSheet('Other', 'axb = 3');

    const results = await search('a_b');
    expect(results.map((sheet) => sheet.title)).toEqual(['Rates']);
  });

  it('matches a backslash literally, being the escape character itself', async () => {
    await createSheet('Paths', 'C:\\temp = 1');
    await createSheet('Plain', 'C:temp = 1');

    const results = await search('C:\\temp');
    expect(results.map((sheet) => sheet.title)).toEqual(['Paths']);
  });

  it('brings back a quotable line for every result the body matched', async () => {
    // The invariant the two halves have to keep: LIKE selects on a pattern and
    // findMatch searches literally, so a row selected on a wildcard would come
    // back as a match with nothing to show for it.
    await createSheet('August', '20% of 250');
    await createSheet('Shopping', '150 apples');
    await createSheet('Rates', 'a_b = 2');

    for (const term of ['%', '_', '50%', 'a_b', 'apples', '20%']) {
      for (const result of await search(term)) {
        const byTitle = result.title.toLowerCase().includes(term.toLowerCase());
        expect(byTitle || result.match !== undefined).toBe(true);
      }
    }
  });
});
