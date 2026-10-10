import { config } from './config.js';
import { createApp } from './app.js';
import { closeDatabase, initDatabase, sweepOldSessions } from './db.js';
import { createPollRegistry } from './pollManager.js';
import { createShutdownHandler, startServer } from './server.js';

const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

for (const warning of config.warnings) {
  console.warn(`Warning: ${warning}`);
}

initDatabase();

function runRetentionSweep(): void {
  if (config.sessionRetentionDays === 0) return;
  try {
    const removed = sweepOldSessions(config.sessionRetentionDays);
    if (removed > 0) {
      console.log(
        `Retention: deleted ${removed} session(s) idle for over ${config.sessionRetentionDays} days`
      );
    }
  } catch (err) {
    console.error('Retention sweep failed:', err);
  }
}

runRetentionSweep();
const retentionTimer = setInterval(runRetentionSweep, RETENTION_SWEEP_INTERVAL_MS);
retentionTimer.unref();

const bindLabel = `${config.host ?? '*'}:${config.port}`;

const polls = createPollRegistry();

const server = startServer({
  app: createApp(config, polls),
  port: config.port,
  host: config.host,
  onListening: address => {
    const bracketed = (host: string) => (host.includes(':') ? `[${host}]` : host);
    console.log(`Touch Grass backend listening on ${bracketed(address.address)}:${address.port}`);
    console.log(`Database: ${config.dbPath}`);
    // A wildcard bind answers on loopback; any other bind answers only on the address it took.
    const wildcard = address.address === '0.0.0.0' || address.address === '::';
    const webHost = wildcard ? 'localhost' : (config.host ?? address.address);
    console.log(`Web UI: http://${bracketed(webHost)}:${address.port}/web/`);
    const corsDisplay =
      config.corsOrigins === '*'
        ? 'allow all (*)'
        : (config.corsOrigins?.join(', ') ?? 'none (same-origin only)');
    console.log(`CORS: ${corsDisplay}`);
    console.log(
      `Session retention: ${config.sessionRetentionDays === 0 ? 'off' : `${config.sessionRetentionDays} days`}`
    );
  },
  onListenError: err => {
    console.error(`Cannot listen on ${bindLabel}: ${err.message}`);
    clearInterval(retentionTimer);
    closeDatabase();
    process.exit(1);
  },
});

const shutdown = createShutdownHandler({
  server,
  polls,
  onClosed: () => {
    clearInterval(retentionTimer);
    closeDatabase();
    process.exit(0);
  },
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
