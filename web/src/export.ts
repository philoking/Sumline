import type { LineResult } from '@webcalc/engine';

export interface ExportOptions {
  title: string;
  content: string;
  results: LineResult[];
  /** Drop the leading `#` from headings, as Soulver's PDF export can. */
  stripHeadingMarks?: boolean;
}

/** Text and answers side by side, padded so the columns line up. */
export function toPlainText(options: ExportOptions): string {
  const lines = prepare(options);
  const width = Math.max(...lines.map(({ text }) => text.length), 0);
  return lines
    .map(({ text, answer }) =>
      answer ? `${text.padEnd(width + 4)}${answer}` : text,
    )
    .join('\n')
    .replace(/[ \t]+$/gm, '');
}

/** A Markdown table, the web's equivalent of Soulver's PDF export. */
export function toMarkdown(options: ExportOptions): string {
  const rows = prepare(options)
    .filter(({ text, answer }) => text.trim() !== '' || answer !== '')
    .map(({ text, answer }) => `| ${escapeCell(text)} | ${escapeCell(answer)} |`);

  return [
    `# ${options.title}`,
    '',
    '| | |',
    '| --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

export function toCsv(options: ExportOptions): string {
  return prepare(options)
    .map(({ text, answer }) => `${csvCell(text)},${csvCell(answer)}`)
    .join('\n');
}

function prepare(options: ExportOptions): Array<{ text: string; answer: string }> {
  return options.content.split('\n').map((raw, index) => {
    const text = options.stripHeadingMarks ? raw.replace(/^(#{1,6})\s*/, '') : raw;
    return { text, answer: options.results[index]?.output ?? '' };
  });
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function csvCell(text: string): string {
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Offers a file to the browser.
 *
 * A blob URL rather than a data URI, so a large sheet is not limited by URL
 * length, and revoked on the next tick to avoid leaking it.
 */
export function download(filename: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function safeFilename(title: string, extension: string): string {
  const base = title.replace(/[^\w\- ]+/g, '').trim() || 'sheet';
  return `${base}.${extension}`;
}
