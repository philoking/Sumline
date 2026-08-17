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

// Absent means no authentication, which is the documented default. Only a
// non-empty value turns the password on, so an empty assignment left in a
// compose file cannot lock everyone out.
const password = process.env['WEBCALC_PASSWORD']?.trim();

const { server } = buildApp({
  dbPath: resolve(dataDir, 'webcalc.db'),
  staticRoot,
  holidayCountry: process.env['HOLIDAY_COUNTRY'] ?? 'US',
  ...(spaces && { spaces }),
  ...(password && { password }),
  logger: true,
});

try {
  await server.listen({ port, host });
  server.log.info(`WebCalc listening on http://${host}:${port}`);
  server.log.info(
    password
      ? 'WEBCALC_PASSWORD is set: the app asks for a password before showing any sheet'
      : 'No WEBCALC_PASSWORD: anyone who can reach this port can read and edit every sheet',
  );
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
