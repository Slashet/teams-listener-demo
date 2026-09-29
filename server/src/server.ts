import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import { Server } from 'socket.io';
import type { AppConfig } from './config.js';
import { createApp } from './http/app.js';
import { clientIp } from './http/clientIp.js';
import { RoomManager, type RoomManagerOptions } from './rooms/RoomManager.js';
import { registerSocketHandlers, transcriptDeletedNotifier, type AppServer } from './socket/handlers.js';
import { SpeechTokenService } from './speech/azureToken.js';

export interface StartedServer {
  httpServer: HttpServer;
  io: AppServer;
  rooms: RoomManager;
  close(): Promise<void>;
}

export interface BuildOptions {
  config: AppConfig;
  roomOptions?: Omit<RoomManagerOptions, 'onTranscriptDeleted'>;
  speech?: SpeechTokenService;
  clientDir?: string;
}

export function buildServer({ config, roomOptions, speech, clientDir }: BuildOptions): StartedServer {
  // The RoomManager is created before Socket.IO, so its expiry callback resolves `io` lazily.
  const ioRef: { current?: AppServer } = {};
  const rooms = new RoomManager({
    maxRooms: config.limits.maxRooms,
    maxEntriesPerSession: config.limits.maxTranscriptEntries,
    maxCharsPerSession: config.limits.maxTranscriptCharsPerSession,
    ...roomOptions,
    onTranscriptDeleted: transcriptDeletedNotifier(() => ioRef.current),
  });
  const speechService =
    speech ?? new SpeechTokenService({ key: config.speech.key, region: config.speech.region, language: config.speech.language });

  const app = createApp({
    config,
    rooms,
    speech: speechService,
    clientDir: clientDir ?? path.resolve(import.meta.dirname, '../../client/dist'),
  });
  const httpServer = createServer(app);

  const allowedOrigin = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : undefined;
  // Concurrent Socket.IO connections per client IP (a meeting needs one per tab).
  const maxConnectionsPerIp = 20;
  const connectionsByIp = new Map<string, number>();
  const io: AppServer = new Server(httpServer, {
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    // Reject cross-site WebSocket hijacking: in production only our own origin may connect.
    allowRequest: (req, callback) => {
      if (config.isProduction && allowedOrigin && req.headers.origin !== allowedOrigin) return callback('Origin not allowed', false);
      if ((connectionsByIp.get(clientIp(req, config.trustProxy)) ?? 0) >= maxConnectionsPerIp) return callback('Too many connections', false);
      callback(null, true);
    },
  });
  io.on('connection', (socket) => {
    const ip = clientIp(socket.request, config.trustProxy);
    connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
    socket.on('disconnect', () => {
      const n = (connectionsByIp.get(ip) ?? 1) - 1;
      if (n <= 0) connectionsByIp.delete(ip);
      else connectionsByIp.set(ip, n);
    });
  });
  ioRef.current = io;
  registerSocketHandlers({ io, rooms, ice: config.ice });

  return {
    httpServer,
    io,
    rooms,
    close: async () => {
      rooms.dispose();
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
    },
  };
}
