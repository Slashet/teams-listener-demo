import type { Server, Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  ErrorResult,
  JoinResult,
  ServerToClientEvents,
} from '../../../shared/protocol.js';
import type { AppConfig } from '../config.js';
import { buildIceServers } from '../ice.js';
import { errorKind, logger } from '../logger.js';
import { participantInfo, type RoomManager } from '../rooms/RoomManager.js';
import { formatTranscriptTxt, safeTimeZone, transcriptFilename } from '../rooms/transcriptFormat.js';
import { createSocketLimiter, type EventCategory } from './rateLimiter.js';
import { downloadSchema, joinSchema, mediaStateSchema, signalSchema, transcriptEntrySchema } from './schemas.js';

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

const channel = (roomId: string) => `room:${roomId}`;

const rateLimited: ErrorResult = { ok: false, code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' };
const invalid: ErrorResult = { ok: false, code: 'INVALID_REQUEST', message: 'Invalid request.' };

/** Calls an acknowledgement callback only if the client actually supplied one. */
function reply<T>(ack: unknown, value: T): void {
  if (typeof ack === 'function') (ack as (v: T) => void)(value);
}

export interface SocketDeps {
  io: AppServer;
  rooms: RoomManager;
  ice: AppConfig['ice'];
  now?: () => number;
}

export function registerSocketHandlers({ io, rooms, ice, now = Date.now }: SocketDeps): void {
  io.on('connection', (socket: AppSocket) => {
    const allow = createSocketLimiter(now);

    /** Wraps a handler with rate limiting and content-free error logging. */
    const on = <A extends unknown[]>(event: string, category: EventCategory, handler: (...args: A) => void) => {
      (socket.on as (ev: string, fn: (...args: unknown[]) => void) => void)(event, (...args: unknown[]) => {
        if (!allow(category)) {
          reply(args[args.length - 1], rateLimited);
          return;
        }
        try {
          handler(...(args as A));
        } catch (err) {
          logger.error('socket handler failed', { event, error: errorKind(err) });
          reply(args[args.length - 1], { ok: false, code: 'INTERNAL', message: 'Unexpected server error.' });
        }
      });
    };

    const leave = (reason: string) => {
      const outcome = rooms.leave(socket.id);
      if (!outcome) return;
      void socket.leave(channel(outcome.roomId));
      logger.info('participant left', {
        roomId: outcome.roomId,
        participantId: outcome.participantId,
        reason,
        roomDeleted: outcome.roomDeleted,
      });
      if (outcome.roomDeleted) return;
      io.to(channel(outcome.roomId)).emit('participant:left', { participantId: outcome.participantId });
      if (outcome.newHostId !== undefined) {
        io.to(channel(outcome.roomId)).emit('host:changed', { hostId: outcome.newHostId });
        logger.info('host reassigned', { roomId: outcome.roomId, hostId: outcome.newHostId });
      }
    };

    on('room:join', 'join', (payload: unknown, ack: unknown) => {
      const parsed = joinSchema.safeParse(payload);
      if (!parsed.success) {
        reply<JoinResult>(ack, { ok: false, code: 'INVALID_REQUEST', message: 'Invalid room ID or display name.' });
        return;
      }
      const { roomId, displayName, hostKey, media } = parsed.data;
      const result = rooms.join({ roomId, socketId: socket.id, displayName, hostKey, media });
      if (!result.ok) {
        logger.info('join rejected', { roomId, code: result.code });
        reply<JoinResult>(ack, result);
        return;
      }
      const { participant } = result;
      void socket.join(channel(roomId));
      logger.info('participant joined', { roomId, participantId: participant.participantId });

      reply<JoinResult>(ack, {
        ok: true,
        selfId: participant.participantId,
        participantToken: participant.token,
        hostId: result.hostId,
        participants: rooms.listParticipants(roomId),
        transcript: rooms.getTranscriptState(roomId),
        iceServers: buildIceServers(ice, participant.participantId, now()),
        serverNow: now(),
      });
      socket.to(channel(roomId)).emit('participant:joined', participantInfo(participant));
      if (result.hostChanged) socket.to(channel(roomId)).emit('host:changed', { hostId: result.hostId });
    });

    on('room:leave', 'join', (ack: unknown) => {
      leave('left');
      reply(ack, { ok: true });
    });

    on('media:state', 'media', (payload: unknown) => {
      const parsed = mediaStateSchema.safeParse(payload);
      if (!parsed.success) return;
      const updated = rooms.updateMedia(socket.id, parsed.data);
      if (!updated) return;
      socket.to(channel(updated.roomId)).emit('participant:media', { participantId: updated.participantId, media: parsed.data });
    });

    on('signal', 'signal', (payload: unknown) => {
      const parsed = signalSchema.safeParse(payload);
      if (!parsed.success) return;
      // Target must be another participant in the sender's own room.
      const route = rooms.resolveSignalTarget(socket.id, parsed.data.to);
      if (!route) return;
      io.to(route.toSocketId).emit('signal', { from: route.fromParticipantId, data: parsed.data.data });
    });

    on('transcript:start', 'control', (ack: unknown) => {
      const before = rooms.getBySocket(socket.id);
      const previous = before ? rooms.getTranscriptState(before.roomId) : null;
      const result = rooms.startTranscript(socket.id);
      if (!result.ok) {
        reply(ack, result);
        return;
      }
      if (previous?.status === 'stopped') {
        // Old transcript was discarded to start a clean session.
        io.to(channel(result.roomId)).emit('transcript:deleted', { sessionId: previous.sessionId });
      }
      io.to(channel(result.roomId)).emit('transcript:started', { sessionId: result.sessionId, serverNow: now() });
      logger.info('transcript started', { roomId: result.roomId });
      reply(ack, { ok: true });
    });

    on('transcript:stop', 'control', (ack: unknown) => {
      const result = rooms.stopTranscript(socket.id);
      if (!result.ok) {
        reply(ack, result);
        return;
      }
      io.to(channel(result.roomId)).emit('transcript:stopped', {
        sessionId: result.sessionId,
        expiresAt: result.expiresAt,
        serverNow: now(),
      });
      logger.info('transcript stopped', { roomId: result.roomId });
      reply(ack, { ok: true });
    });

    on('transcript:entry', 'transcript', (payload: unknown, ack: unknown) => {
      const parsed = transcriptEntrySchema.safeParse(payload);
      if (!parsed.success) {
        reply(ack, invalid);
        return;
      }
      const result = rooms.addTranscriptEntry(socket.id, parsed.data);
      if (!result.ok) {
        reply(ack, result);
        return;
      }
      // Note: the entry text is broadcast but never logged.
      io.to(channel(result.roomId)).emit('transcript:entry', result.entry);
      reply(ack, { ok: true });
    });

    on('transcript:download', 'download', (payload: unknown, ack: unknown) => {
      const parsed = downloadSchema.safeParse(payload ?? {});
      if (!parsed.success) {
        reply(ack, invalid);
        return;
      }
      const result = rooms.getTranscriptForDownload(socket.id);
      if (!result.ok) {
        reply(ack, result);
        return;
      }
      const timeZone = safeTimeZone(parsed.data.timeZone);
      reply(ack, {
        ok: true,
        filename: transcriptFilename(result.roomId, now()),
        content: formatTranscriptTxt(result.entries, { timeZone, now: now() }),
      });
    });

    socket.on('disconnect', (reason) => leave(reason));
  });
}

/** Wires transcript expiry notifications from the RoomManager to clients. */
export function transcriptDeletedNotifier(getIo: () => AppServer | undefined) {
  return (roomId: string, sessionId: string | null) => {
    getIo()?.to(channel(roomId)).emit('transcript:deleted', { sessionId });
    logger.info('transcript deleted', { roomId });
  };
}
