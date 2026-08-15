import { resolve } from 'node:path';
import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';
const dataDir = process.env['DATA_DIR'] ?? resolve(process.cwd(), 'data');
const staticRoot =
  process.env['STATIC_ROOT'] ?? resolve(process.cwd(), '../web/dist');

const { server } = buildApp({
  dbPath: resolve(dataDir, 'webcalc.db'),
  staticRoot,
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
