import { describe, expect, it } from 'vitest';
import { safeFilename, toCsv, toMarkdown, toPlainText } from '../src/export';
import type { LineResult } from '@sumline/engine';

/** Answers positionally, the way the editor hands them over. */
const answers = (...outputs: string[]): LineResult[] =>
  outputs.map((output) => ({ output }) as LineResult);

const sheet = {
  title: 'Kitchen',
  content: '# Costs\ntiles $40\nlabour $60\nsum',
  results: answers('', '$40.00', '$60.00', '$100.00'),
};

describe('toPlainText', () => {
  it('lines the answers up in a column', () => {
    const lines = toPlainText(sheet).split('\n');
    // Every answer starts at the same offset, which is the whole point of the
    // padding and what makes a pasted sheet still read as two columns.
    // Located by the answer itself: the sheet text contains `$` too, so the
    // first one on the line is not the column being measured.
    const offsets = ['$40.00', '$60.00', '$100.00'].map((answer, index) =>
      lines[index + 1]!.lastIndexOf(answer),
    );
    expect(new Set(offsets).size).toBe(1);
    expect(offsets[0]).toBeGreaterThan('labour $60'.length);
  });

  it('leaves a line with no answer alone, without trailing spaces', () => {
    expect(toPlainText(sheet).split('\n')[0]).toBe('# Costs');
  });

  it('strips heading marks when asked, as Soulver’s PDF export can', () => {
    expect(toPlainText({ ...sheet, stripHeadingMarks: true }).split('\n')[0]).toBe('Costs');
  });
});

describe('toMarkdown', () => {
  it('escapes a pipe so one cell cannot become two', () => {
    // `5 | 3` is real sheet input: bitwise or. Unescaped it would end the cell
    // and silently shift every column after it.
    const table = toMarkdown({
      title: 'Bits',
      content: '5 | 3',
      results: answers('7'),
    });
    expect(table).toContain('| 5 \\| 3 | 7 |');
  });

  it('drops rows that would be blank on both sides', () => {
    const table = toMarkdown({ title: 'T', content: 'a\n\n\nb', results: answers('1', '', '', '2') });
    expect(table.split('\n').filter((line) => line === '|  |  |')).toEqual([]);
  });

  it('titles the document with the sheet name', () => {
    expect(toMarkdown(sheet).startsWith('# Kitchen')).toBe(true);
  });
});

describe('toCsv', () => {
  it('quotes a cell containing a comma, a quote or a newline', () => {
    const csv = toCsv({
      title: 'T',
      content: 'a,b\nsay "hi"\nplain',
      results: answers('1', '2', '3'),
    });
    expect(csv.split('\n')).toEqual(['"a,b",1', '"say ""hi""",2', 'plain,3']);
  });
});

describe('safeFilename', () => {
  it('keeps words, spaces and hyphens', () => {
    expect(safeFilename('Kitchen remodel-2026', 'txt')).toBe('Kitchen remodel-2026.txt');
  });

  it('strips anything that could steer a path', () => {
    // The title is user text and lands in a download filename.
    expect(safeFilename('../../etc/passwd', 'csv')).toBe('etcpasswd.csv');
    expect(safeFilename('a/b\\c:d', 'md')).toBe('abcd.md');
  });

  it('falls back rather than producing a nameless file', () => {
    expect(safeFilename('///', 'txt')).toBe('sheet.txt');
    expect(safeFilename('   ', 'txt')).toBe('sheet.txt');
  });
});
