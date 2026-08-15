// tsc does not emit non-TypeScript files, so the bundled rate seed is copied
// into dist as part of the build.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, '../src/seed-rates.json');
const to = resolve(here, '../dist/seed-rates.json');

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`copied ${from} -> ${to}`);
