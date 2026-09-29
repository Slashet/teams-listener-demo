import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { CreateRoomResponse, SpeechTokenResponse } from '../../../shared/protocol.js';
import type { AppConfig } from '../config.js';
import { errorKind, logger } from '../logger.js';
import type { RoomManager } from '../rooms/RoomManager.js';
import { SpeechNotConfiguredError, type SpeechTokenService } from '../speech/azureToken.js';

export interface AppDeps {
  config: AppConfig;
  rooms: RoomManager;
  speech: SpeechTokenService;
  /** Directory of the built client; static serving is skipped if missing. */
  clientDir?: string;
}

// Azure Speech SDK endpoints used by the browser (token auth over WebSocket).
const AZURE_CONNECT_SRC = [
  'https://*.api.cognitive.microsoft.com',
  'wss://*.stt.speech.microsoft.com',
  'https://*.stt.speech.microsoft.com',
  'wss://*.speech.microsoft.com',
  'https://*.cognitiveservices.azure.com',
  'wss://*.cognitiveservices.azure.com',
];

export function createApp({ config, rooms, speech, clientDir }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const httpsDeployment = config.isProduction && (config.publicBaseUrl?.startsWith('https://') ?? false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          // Azure Speech SDK loads its AudioWorklet module from a blob: URL.
          scriptSrc: ["'self'", 'blob:'],
          workerSrc: ["'self'", 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:', 'mediastream:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", ...AZURE_CONNECT_SRC],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          ...(httpsDeployment ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: httpsDeployment ? undefined : false,
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(), geolocation=()');
    next();
  });

  app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });

  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Unjoined rooms expire after 5 minutes, so one IP can hold at most ~10 pending rooms.
  const createRoomLimiter = rateLimit({ windowMs: 5 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
  api.post('/rooms', createRoomLimiter, (_req, res) => {
    const result = rooms.createRoom();
    if (!result.ok) {
      res.status(503).json({ error: result.message });
      return;
    }
    logger.info('room created', { roomId: result.roomId });
    const body: CreateRoomResponse = { roomId: result.roomId, hostKey: result.hostKey };
    res.status(201).json(body);
  });

  /**
   * Temporary Azure Speech token. Only for participants of a room whose live
   * transcript is active; they authenticate with the participant token issued
   * on join. The subscription key never leaves the server.
   */
  const speechLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  api.get('/speech/token', speechLimiter, async (req: Request, res: Response) => {
    const auth = req.get('authorization') ?? '';
    const token = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(auth)?.[1];
    const who = token ? rooms.getByToken(token) : null;
    if (!who) {
      res.status(401).json({ error: 'Not a meeting participant.' });
      return;
    }
    if (who.transcriptStatus !== 'active') {
      res.status(409).json({ error: 'Live transcript is not active.' });
      return;
    }
    try {
      const issued = await speech.issue();
      const body: SpeechTokenResponse = issued;
      res.json(body);
    } catch (err) {
      if (err instanceof SpeechNotConfiguredError) {
        res.status(503).json({ error: 'Azure Speech is not configured on the server.' });
        return;
      }
      logger.error('speech token request failed', { roomId: who.roomId, error: errorKind(err) });
      res.status(502).json({ error: 'Could not obtain a speech token.' });
    }
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  if (clientDir && existsSync(path.join(clientDir, 'index.html'))) {
    app.use(
      '/assets',
      express.static(path.join(clientDir, 'assets'), { immutable: true, maxAge: '1y', index: false, fallthrough: false }),
    );
    app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
    const sendIndex = (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDir, 'index.html'));
    };
    app.get('/', sendIndex);
    app.get('/room/:roomId', sendIndex);
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
