import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { parseSpaces } from './spaces.js';

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';
const dataDir = process.env['DATA_DIR'] ?? resolve(process.cwd(), 'data');
const staticRoot =
  process.env['STATIC_ROOT'] ?? resolve(process.cwd(), '../web/dist');

// Left undefined when SPACES says nothing usable, which is not the same as an
// empty list: the app then takes its spaces from the database rather than
// starting a running instance on a default that owns none of its sheets.
const spaces = parseSpaces(process.env['SPACES']);

const { server } = buildApp({
  dbPath: resolve(dataDir, 'webcalc.db'),
  staticRoot,
  holidayCountry: process.env['HOLIDAY_COUNTRY'] ?? 'US',
  ...(spaces && { spaces }),
  logger: true,
});

try {
  await server.listen({ port, host });
  server.log.info(`WebCalc listening on http://${host}:${port}`);
} catch (error) {
  server.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.log.info(`${signal} received, shutting down`);
    void server.close().then(() => process.exit(0));
  });
}
