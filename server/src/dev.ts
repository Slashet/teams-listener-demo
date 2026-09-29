/**
 * Local development entry (`npm run dev`): loads ../.env if present and
 * forces development mode (no production origin check), then starts the app.
 * Not used by the Docker image.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

const envFile = path.resolve(import.meta.dirname, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'development';

await import('./index.js');
