import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  MAX_PARTICIPANTS,
  TRANSCRIPT_RETENTION_MS,
  type MediaState,
  type ParticipantInfo,
  type TranscriptEntry,
  type TranscriptState,
} from '../../../shared/protocol.js';

/**
 * In-memory meeting state. Contains no Socket.IO code so the rules can be unit
 * tested in isolation. Nothing here is ever persisted.
 */

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Participant {
  participantId: string;
  socketId: string;
  /** Secret proving HTTP requests come from this participant (e.g. speech token). */
  token: string;
  displayName: string;
  joinedAt: number;
  media: MediaState;
}

interface TranscriptSession {
  status: 'idle' | 'active' | 'stopped';
  sessionId: string | null;
  entries: TranscriptEntry[];
  stoppedAt: number | null;
  expiresAt: number | null;
  deleteTimer: unknown;
}

interface Room {
  roomId: string;
  createdAt: number;
  /** Map preserves insertion (= join) order, used for host reassignment. */
  participants: Map<string, Participant>;
  hostId: string | null;
  /** Present until the creator redeems it by joining. */
  hostKey: Buffer | null;
  pendingTimer: unknown;
  transcript: TranscriptSession;
}

export type Fail<C extends string = string> = { ok: false; code: C; message: string };
export type Result<T, C extends string = string> = ({ ok: true } & T) | Fail<C>;

const fail = <C extends string>(code: C, message: string): Fail<C> => ({ ok: false, code, message });

export interface RoomManagerOptions {
  clock?: Clock;
  maxParticipants?: number;
  transcriptRetentionMs?: number;
  /** Finalized speech may arrive shortly after "stop" (recognizer flush). */
  lateEntryGraceMs?: number;
  /** A created room nobody joins is discarded after this time. */
  pendingRoomTtlMs?: number;
  maxRooms?: number;
  maxEntriesPerSession?: number;
  onTranscriptDeleted?: (roomId: string, sessionId: string | null) => void;
}

export type JoinOutcome = Result<
  { roomId: string; participant: Participant; hostId: string | null; hostChanged: boolean },
  'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'ALREADY_JOINED'
>;

export interface LeaveOutcome {
  roomId: string;
  participantId: string;
  roomDeleted: boolean;
  /** Set when the host changed because the leaving participant was host. */
  newHostId: string | null | undefined;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly socketIndex = new Map<string, { roomId: string; participantId: string }>();
  private readonly tokenIndex = new Map<string, { roomId: string; participantId: string }>();
  private readonly clock: Clock;
  private readonly maxParticipants: number;
  private readonly retentionMs: number;
  private readonly lateEntryGraceMs: number;
  private readonly pendingRoomTtlMs: number;
  private readonly maxRooms: number;
  private readonly maxEntriesPerSession: number;
  private readonly onTranscriptDeleted: (roomId: string, sessionId: string | null) => void;

  constructor(opts: RoomManagerOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.maxParticipants = opts.maxParticipants ?? MAX_PARTICIPANTS;
    this.retentionMs = opts.transcriptRetentionMs ?? TRANSCRIPT_RETENTION_MS;
    this.lateEntryGraceMs = opts.lateEntryGraceMs ?? 5_000;
    this.pendingRoomTtlMs = opts.pendingRoomTtlMs ?? 10 * 60_000;
    this.maxRooms = opts.maxRooms ?? 500;
    this.maxEntriesPerSession = opts.maxEntriesPerSession ?? 5_000;
    this.onTranscriptDeleted = opts.onTranscriptDeleted ?? (() => undefined);
  }

  // ---------------------------------------------------------------- rooms

  /** Creates an empty room with a cryptographically random ID. */
  createRoom(): Result<{ roomId: string; hostKey: string }, 'CAPACITY'> {
    if (this.rooms.size >= this.maxRooms) return fail('CAPACITY', 'Server is at capacity. Please try again later.');
    let roomId: string;
    do {
      roomId = randomBytes(8).toString('hex');
    } while (this.rooms.has(roomId));
    const hostKey = randomBytes(24).toString('base64url');
    const room: Room = {
      roomId,
      createdAt: this.clock.now(),
      participants: new Map(),
      hostId: null,
      hostKey: Buffer.from(hostKey),
      pendingTimer: null,
      transcript: emptyTranscript(),
    };
    room.pendingTimer = this.clock.setTimeout(() => {
      const r = this.rooms.get(roomId);
      if (r && r.participants.size === 0) this.deleteRoom(r);
    }, this.pendingRoomTtlMs);
    this.rooms.set(roomId, room);
    return { ok: true, roomId, hostKey };
  }

  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  roomCount(): number {
    return this.rooms.size;
  }

  // --------------------------------------------------------- participants

  join(req: { roomId: string; socketId: string; displayName: string; hostKey?: string; media: MediaState }): JoinOutcome {
    if (this.socketIndex.has(req.socketId)) return fail('ALREADY_JOINED', 'You have already joined a meeting.');
    const room = this.rooms.get(req.roomId);
    if (!room) return fail('ROOM_NOT_FOUND', 'This meeting does not exist or has ended.');
    if (room.participants.size >= this.maxParticipants) {
      return fail('ROOM_FULL', `This meeting is full. Maximum ${this.maxParticipants} participants.`);
    }

    const participant: Participant = {
      participantId: randomUUID(),
      socketId: req.socketId,
      token: randomBytes(24).toString('base64url'),
      displayName: req.displayName,
      joinedAt: this.clock.now(),
      media: { ...req.media },
    };
    room.participants.set(participant.participantId, participant);
    this.socketIndex.set(req.socketId, { roomId: room.roomId, participantId: participant.participantId });
    this.tokenIndex.set(participant.token, { roomId: room.roomId, participantId: participant.participantId });

    if (room.pendingTimer !== null) {
      this.clock.clearTimeout(room.pendingTimer);
      room.pendingTimer = null;
    }

    let hostChanged = false;
    const redeemsHostKey = req.hostKey !== undefined && room.hostKey !== null && safeEqual(room.hostKey, req.hostKey);
    if (redeemsHostKey) {
      // The creator becomes host, even if someone opened the link first.
      room.hostKey = null;
      hostChanged = room.hostId !== participant.participantId;
      room.hostId = participant.participantId;
    } else if (room.hostId === null) {
      room.hostId = participant.participantId;
      hostChanged = true;
    }

    return { ok: true, roomId: room.roomId, participant, hostId: room.hostId, hostChanged };
  }

  /** Removes the participant bound to a socket. Returns null if the socket had not joined. */
  leave(socketId: string): LeaveOutcome | null {
    const ref = this.socketIndex.get(socketId);
    if (!ref) return null;
    this.socketIndex.delete(socketId);
    const room = this.rooms.get(ref.roomId);
    if (!room) return null;
    const participant = room.participants.get(ref.participantId);
    if (participant) this.tokenIndex.delete(participant.token);
    room.participants.delete(ref.participantId);

    if (room.participants.size === 0) {
      this.deleteRoom(room);
      return { roomId: room.roomId, participantId: ref.participantId, roomDeleted: true, newHostId: undefined };
    }

    let newHostId: string | null | undefined;
    if (room.hostId === ref.participantId) {
      // Earliest remaining participant (Map iteration = join order).
      const next = room.participants.values().next();
      room.hostId = next.done ? null : next.value.participantId;
      newHostId = room.hostId;
    }
    return { roomId: room.roomId, participantId: ref.participantId, roomDeleted: false, newHostId };
  }

  getBySocket(socketId: string): { roomId: string; participant: Participant; hostId: string | null } | null {
    const ref = this.socketIndex.get(socketId);
    if (!ref) return null;
    const room = this.rooms.get(ref.roomId);
    const participant = room?.participants.get(ref.participantId);
    if (!room || !participant) return null;
    return { roomId: room.roomId, participant, hostId: room.hostId };
  }

  getByToken(token: string): { roomId: string; participant: Participant; transcriptStatus: TranscriptSession['status'] } | null {
    const ref = this.tokenIndex.get(token);
    if (!ref) return null;
    const room = this.rooms.get(ref.roomId);
    const participant = room?.participants.get(ref.participantId);
    if (!room || !participant) return null;
    return { roomId: room.roomId, participant, transcriptStatus: room.transcript.status };
  }

  listParticipants(roomId: string): ParticipantInfo[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.participants.values()].map(toInfo);
  }

  getHostId(roomId: string): string | null {
    return this.rooms.get(roomId)?.hostId ?? null;
  }

  updateMedia(socketId: string, media: MediaState): { roomId: string; participantId: string } | null {
    const found = this.getBySocket(socketId);
    if (!found) return null;
    found.participant.media = { ...media };
    return { roomId: found.roomId, participantId: found.participant.participantId };
  }

  /**
   * Resolves the socket to relay a signalling message to. Only succeeds when
   * sender and target are distinct participants of the same room.
   */
  resolveSignalTarget(fromSocketId: string, toParticipantId: string): { fromParticipantId: string; toSocketId: string } | null {
    const from = this.socketIndex.get(fromSocketId);
    if (!from) return null;
    const room = this.rooms.get(from.roomId);
    const target = room?.participants.get(toParticipantId);
    if (!target || target.participantId === from.participantId) return null;
    return { fromParticipantId: from.participantId, toSocketId: target.socketId };
  }

  // ----------------------------------------------------------- transcript

  startTranscript(socketId: string): Result<{ roomId: string; sessionId: string }, 'NOT_JOINED' | 'NOT_HOST' | 'ALREADY_ACTIVE'> {
    const ctx = this.hostContext(socketId);
    if (!ctx.ok) return ctx;
    const { room } = ctx;
    if (room.transcript.status === 'active') return fail('ALREADY_ACTIVE', 'Live transcript is already active.');

    // Starting during the download window discards the previous transcript
    // immediately (and cancels its pending deletion) before the new session.
    this.clearTranscript(room);
    room.transcript.status = 'active';
    room.transcript.sessionId = randomUUID();
    return { ok: true, roomId: room.roomId, sessionId: room.transcript.sessionId };
  }

  stopTranscript(socketId: string): Result<{ roomId: string; sessionId: string; expiresAt: number }, 'NOT_JOINED' | 'NOT_HOST' | 'NOT_ACTIVE'> {
    const ctx = this.hostContext(socketId);
    if (!ctx.ok) return ctx;
    const { room } = ctx;
    const t = room.transcript;
    if (t.status !== 'active' || t.sessionId === null) return fail('NOT_ACTIVE', 'Live transcript is not active.');

    const now = this.clock.now();
    t.status = 'stopped';
    t.stoppedAt = now;
    t.expiresAt = now + this.retentionMs;
    const sessionId = t.sessionId;
    t.deleteTimer = this.clock.setTimeout(() => this.expireTranscript(room.roomId, sessionId), this.retentionMs);
    return { ok: true, roomId: room.roomId, sessionId, expiresAt: t.expiresAt };
  }

  addTranscriptEntry(
    socketId: string,
    input: { sessionId: string; text: string },
  ): Result<{ roomId: string; entry: TranscriptEntry }, 'NOT_JOINED' | 'NOT_ACTIVE' | 'STALE_SESSION' | 'LIMIT'> {
    const found = this.getBySocket(socketId);
    if (!found) return fail('NOT_JOINED', 'Join a meeting first.');
    const room = this.rooms.get(found.roomId);
    if (!room) return fail('NOT_JOINED', 'Join a meeting first.');
    const t = room.transcript;
    const now = this.clock.now();
    const acceptingLate = t.status === 'stopped' && t.stoppedAt !== null && now - t.stoppedAt <= this.lateEntryGraceMs;
    if (t.status !== 'active' && !acceptingLate) return fail('NOT_ACTIVE', 'Live transcript is not active.');
    if (input.sessionId !== t.sessionId) return fail('STALE_SESSION', 'Transcript session has changed.');
    if (t.entries.length >= this.maxEntriesPerSession) return fail('LIMIT', 'Transcript size limit reached.');

    // Identity comes from the server-side session, never from the payload.
    const entry: TranscriptEntry = {
      id: randomUUID(),
      participantId: found.participant.participantId,
      displayName: found.participant.displayName,
      text: input.text,
      timestamp: now,
    };
    t.entries.push(entry);
    return { ok: true, roomId: room.roomId, entry };
  }

  /** Snapshot for downloading. Only available while a transcript exists. */
  getTranscriptForDownload(socketId: string): Result<{ roomId: string; entries: TranscriptEntry[] }, 'NOT_JOINED' | 'UNAVAILABLE'> {
    const found = this.getBySocket(socketId);
    if (!found) return fail('NOT_JOINED', 'Join a meeting first.');
    const room = this.rooms.get(found.roomId);
    if (!room) return fail('NOT_JOINED', 'Join a meeting first.');
    const t = room.transcript;
    if (t.status === 'idle' || t.entries.length === 0) return fail('UNAVAILABLE', 'No transcript is available.');
    return { ok: true, roomId: room.roomId, entries: t.entries.map((e) => ({ ...e })) };
  }

  getTranscriptState(roomId: string): TranscriptState {
    const room = this.rooms.get(roomId);
    if (!room) return { status: 'idle', sessionId: null, entries: [], expiresAt: null };
    const t = room.transcript;
    return { status: t.status, sessionId: t.sessionId, entries: t.entries.map((e) => ({ ...e })), expiresAt: t.expiresAt };
  }

  /** Clears every timer and all state (used on shutdown and in tests). */
  dispose(): void {
    for (const room of [...this.rooms.values()]) this.deleteRoom(room);
  }

  // -------------------------------------------------------------- private

  private hostContext(socketId: string): Result<{ room: Room }, 'NOT_JOINED' | 'NOT_HOST'> {
    const ref = this.socketIndex.get(socketId);
    const room = ref ? this.rooms.get(ref.roomId) : undefined;
    if (!ref || !room) return fail('NOT_JOINED', 'Join a meeting first.');
    if (room.hostId !== ref.participantId) return fail('NOT_HOST', 'Only the host can control the live transcript.');
    return { ok: true, room };
  }

  private expireTranscript(roomId: string, sessionId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.transcript.sessionId !== sessionId || room.transcript.status !== 'stopped') return;
    this.clearTranscript(room);
    this.onTranscriptDeleted(roomId, sessionId);
  }

  private clearTranscript(room: Room): void {
    const t = room.transcript;
    if (t.deleteTimer !== null) this.clock.clearTimeout(t.deleteTimer);
    // Drop references to the text so it can be garbage collected.
    t.entries.length = 0;
    room.transcript = emptyTranscript();
  }

  private deleteRoom(room: Room): void {
    if (room.pendingTimer !== null) this.clock.clearTimeout(room.pendingTimer);
    this.clearTranscript(room);
    for (const p of room.participants.values()) {
      this.socketIndex.delete(p.socketId);
      this.tokenIndex.delete(p.token);
    }
    room.participants.clear();
    room.hostKey = null;
    this.rooms.delete(room.roomId);
  }
}

function emptyTranscript(): TranscriptSession {
  return { status: 'idle', sessionId: null, entries: [], stoppedAt: null, expiresAt: null, deleteTimer: null };
}

function toInfo(p: Participant): ParticipantInfo {
  return { participantId: p.participantId, displayName: p.displayName, joinedAt: p.joinedAt, media: { ...p.media } };
}

function safeEqual(expected: Buffer, provided: string): boolean {
  const given = Buffer.from(provided);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export { toInfo as participantInfo };
