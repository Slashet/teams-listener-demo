/**
 * Socket.IO protocol shared between client and server.
 *
 * Plain TypeScript with no dependencies: bundled into both the Vite client
 * build and the server bundle (tsup).
 */

export const MAX_PARTICIPANTS = 4;
export const TRANSCRIPT_RETENTION_MS = 30_000;
export const DISPLAY_NAME_MAX_LENGTH = 40;
export const TRANSCRIPT_TEXT_MAX_LENGTH = 1_000;

export interface MediaState {
  audioEnabled: boolean;
  videoEnabled: boolean;
}

export interface ParticipantInfo {
  participantId: string;
  displayName: string;
  joinedAt: number;
  media: MediaState;
}

export interface TranscriptEntry {
  id: string;
  participantId: string;
  displayName: string;
  text: string;
  /** Server receive time, epoch milliseconds. */
  timestamp: number;
}

export type TranscriptStatus = 'idle' | 'active' | 'stopped';

export interface TranscriptState {
  status: TranscriptStatus;
  /** Identifies one transcript session; entries from other sessions are rejected. */
  sessionId: string | null;
  entries: TranscriptEntry[];
  /** Epoch ms at which the server deletes the transcript (only while `stopped`). */
  expiresAt: number | null;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface JoinSuccess {
  ok: true;
  selfId: string;
  /** Opaque secret used to authenticate HTTP calls (speech token) as this participant. */
  participantToken: string;
  hostId: string | null;
  participants: ParticipantInfo[];
  transcript: TranscriptState;
  iceServers: IceServerConfig[];
  serverNow: number;
}

export type JoinErrorCode = 'ROOM_FULL' | 'ROOM_NOT_FOUND' | 'INVALID_REQUEST' | 'ALREADY_JOINED' | 'RATE_LIMITED';

export interface ErrorResult<C extends string = string> {
  ok: false;
  code: C;
  message: string;
}

export type JoinResult = JoinSuccess | ErrorResult<JoinErrorCode>;
export type SimpleResult = { ok: true } | ErrorResult;

export interface DownloadSuccess {
  ok: true;
  filename: string;
  content: string;
}
export type DownloadResult = DownloadSuccess | ErrorResult;

/** WebRTC signalling payload relayed between two participants of the same room. */
export type SignalData =
  | { type: 'description'; description: { type: 'offer' | 'answer'; sdp: string } }
  | { type: 'candidate'; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } | null };

export interface JoinRequest {
  roomId: string;
  displayName: string;
  hostKey?: string;
  media: MediaState;
}

export interface ClientToServerEvents {
  'room:join': (req: JoinRequest, ack: (res: JoinResult) => void) => void;
  'room:leave': (ack?: (res: SimpleResult) => void) => void;
  'media:state': (state: MediaState) => void;
  signal: (msg: { to: string; data: SignalData }) => void;
  'transcript:start': (ack: (res: SimpleResult) => void) => void;
  'transcript:stop': (ack: (res: SimpleResult) => void) => void;
  'transcript:entry': (entry: { sessionId: string; text: string }, ack?: (res: SimpleResult) => void) => void;
  'transcript:download': (req: { timeZone?: string; locale?: string }, ack: (res: DownloadResult) => void) => void;
}

export interface ServerToClientEvents {
  'participant:joined': (p: ParticipantInfo) => void;
  'participant:left': (p: { participantId: string }) => void;
  'participant:media': (p: { participantId: string; media: MediaState }) => void;
  'host:changed': (p: { hostId: string | null }) => void;
  signal: (msg: { from: string; data: SignalData }) => void;
  'transcript:started': (p: { sessionId: string; serverNow: number }) => void;
  'transcript:entry': (entry: TranscriptEntry) => void;
  'transcript:stopped': (p: { sessionId: string; expiresAt: number; serverNow: number }) => void;
  'transcript:deleted': (p: { sessionId: string | null }) => void;
}

export interface CreateRoomResponse {
  roomId: string;
  /** One-time secret proving the holder created the room; grants host on join. */
  hostKey: string;
}

export interface SpeechTokenResponse {
  token: string;
  region: string;
  language: string;
  /** Seconds after which the client should fetch a fresh token. */
  refreshAfterSeconds: number;
}
