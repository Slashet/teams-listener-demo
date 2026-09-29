import { loadConfig } from './config.js';
import { configureLogger, errorKind, logger } from './logger.js';
import { buildServer } from './server.js';

const config = loadConfig();
configureLogger({ level: config.logLevel });

if (!config.speech.key || !config.speech.region) {
  logger.warn('Azure Speech is not configured; live transcription will be unavailable');
}
if (config.ice.turnUrls.length === 0) {
  logger.warn('No TURN server configured; calls across restrictive NATs may fail');
}

const server = buildServer({ config });

server.httpServer.listen(config.port, config.host, () => {
  logger.info('server listening', { port: config.port, env: config.nodeEnv });
});

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });
  const force = setTimeout(() => process.exit(0), 5_000);
  force.unref();
  server
    .close()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      logger.error('shutdown failed', { error: errorKind(err) });
      process.exit(1);
    });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { error: errorKind(err) }));
