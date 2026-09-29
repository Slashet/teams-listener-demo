import {
  TRANSCRIPT_TEXT_MAX_LENGTH,
  type JoinSuccess,
  type MediaState,
  type ParticipantInfo,
  type TranscriptEntry,
  type TranscriptStatus,
} from '../../../shared/protocol';
import { fetchSpeechToken } from '../lib/api';
import { stopStream } from '../lib/media';
import { createMeetingSocket, type MeetingSocket } from '../lib/socket';
import { SpeechTranscriber, type RecognitionStatus } from '../speech/SpeechTranscriber';
import { PeerManager } from '../webrtc/PeerManager';

/**
 * Owns the socket, the WebRTC mesh and the local speech recognizer for one
 * meeting. React subscribes to immutable snapshots of `MeetingState`.
 *
 * Transcript data lives only in this in-memory state (never in
 * localStorage/sessionStorage) and is dropped when the server deletes it.
 */

export type MeetingPhase = 'connecting' | 'joined' | 'reconnecting' | 'ended' | 'error';

export interface MeetingState {
  phase: MeetingPhase;
  error: string | null;
  selfId: string | null;
  hostId: string | null;
  participants: ParticipantInfo[];
  remoteStreams: Record<string, MediaStream>;
  connectionStates: Record<string, RTCPeerConnectionState>;
  hasAudioTrack: boolean;
  hasVideoTrack: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  transcript: {
    status: TranscriptStatus;
    sessionId: string | null;
    entries: TranscriptEntry[];
    expiresAt: number | null;
  };
  /** serverTime - clientTime, used for the synchronized countdown. */
  clockOffsetMs: number;
  partialText: string;
  recognition: { status: RecognitionStatus; message: string | null };
  notice: string | null;
}

export interface MeetingOptions {
  roomId: string;
  displayName: string;
  hostKey?: string;
  localStream: MediaStream;
}

type Listener = () => void;

export class MeetingController {
  private state: MeetingState;
  private readonly listeners = new Set<Listener>();
  private readonly socket: MeetingSocket;
  private peers: PeerManager | null = null;
  private transcriber: SpeechTranscriber | null = null;
  private participantToken: string | null = null;
  private hostKey: string | undefined;
  private leaving = false;

  constructor(private readonly opts: MeetingOptions) {
    this.hostKey = opts.hostKey;
    const audio = opts.localStream.getAudioTracks()[0];
    const video = opts.localStream.getVideoTracks()[0];
    this.state = {
      phase: 'connecting',
      error: null,
      selfId: null,
      hostId: null,
      participants: [],
      remoteStreams: {},
      connectionStates: {},
      hasAudioTrack: Boolean(audio),
      hasVideoTrack: Boolean(video),
      audioEnabled: Boolean(audio?.enabled),
      videoEnabled: Boolean(video?.enabled),
      transcript: { status: 'idle', sessionId: null, entries: [], expiresAt: null },
      clockOffsetMs: 0,
      partialText: '',
      recognition: { status: 'idle', message: null },
      notice: null,
    };
    this.socket = createMeetingSocket();
    this.bindSocket();
  }

  // ------------------------------------------------------------ store API

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): MeetingState => this.state;

  get localStream(): MediaStream {
    return this.opts.localStream;
  }

  private set(patch: Partial<MeetingState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  // -------------------------------------------------------------- actions

  start(): void {
    this.socket.connect();
  }

  async leave(): Promise<void> {
    if (this.leaving) return;
    this.leaving = true;
    await this.stopRecognition();
    this.peers?.closeAll();
    this.peers = null;
    if (this.socket.connected) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1_000);
        this.socket.emit('room:leave', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    this.socket.removeAllListeners();
    this.socket.disconnect();
    stopStream(this.opts.localStream);
    this.set({
      phase: 'ended',
      remoteStreams: {},
      participants: [],
      transcript: { status: 'idle', sessionId: null, entries: [], expiresAt: null },
      partialText: '',
    });
  }

  toggleAudio(): void {
    const track = this.opts.localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.transcriber?.setMuted(!track.enabled);
    this.set({ audioEnabled: track.enabled });
    this.publishMedia();
  }

  toggleVideo(): void {
    const track = this.opts.localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.set({ videoEnabled: track.enabled });
    this.publishMedia();
  }

  startTranscript(): Promise<string | null> {
    return new Promise((resolve) => {
      this.socket.emit('transcript:start', (res) => resolve(res.ok ? null : res.message));
    });
  }

  stopTranscript(): Promise<string | null> {
    return new Promise((resolve) => {
      this.socket.emit('transcript:stop', (res) => resolve(res.ok ? null : res.message));
    });
  }

  /** Asks the server to build the TXT from its in-memory transcript and saves it. */
  downloadTranscript(): Promise<string | null> {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return new Promise((resolve) => {
      this.socket.emit('transcript:download', { timeZone }, (res) => {
        if (!res.ok) {
          resolve(res.message);
          return;
        }
        // Blob lives only in memory; the object URL is revoked right away.
        const blob = new Blob(['﻿', res.content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
        resolve(null);
      });
    });
  }

  retryRecognition(): void {
    void this.transcriber?.retry();
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  // ------------------------------------------------------------- internals

  private mediaState(): MediaState {
    return { audioEnabled: this.state.audioEnabled, videoEnabled: this.state.videoEnabled };
  }

  private publishMedia(): void {
    const media = this.mediaState();
    const selfId = this.state.selfId;
    if (selfId) {
      this.set({ participants: this.state.participants.map((p) => (p.participantId === selfId ? { ...p, media } : p)) });
    }
    if (this.socket.connected) this.socket.emit('media:state', media);
  }

  private bindSocket(): void {
    const s = this.socket;

    s.on('connect', () => this.join());

    s.on('disconnect', () => {
      if (this.leaving) return;
      // The server drops us on disconnect; tear down and rejoin on reconnect.
      void this.stopRecognition();
      this.peers?.closeAll();
      this.peers = null;
      this.set({ phase: 'reconnecting', remoteStreams: {}, connectionStates: {}, partialText: '' });
    });

    s.on('participant:joined', (p) => {
      // The newcomer sends us an offer; we only record the participant.
      this.set({ participants: [...this.state.participants.filter((x) => x.participantId !== p.participantId), p] });
    });

    s.on('participant:left', ({ participantId }) => {
      this.peers?.removePeer(participantId);
      this.set({
        participants: this.state.participants.filter((p) => p.participantId !== participantId),
        remoteStreams: omit(this.state.remoteStreams, participantId),
        connectionStates: omit(this.state.connectionStates, participantId),
      });
    });

    s.on('participant:media', ({ participantId, media }) => {
      this.set({ participants: this.state.participants.map((p) => (p.participantId === participantId ? { ...p, media } : p)) });
    });

    s.on('host:changed', ({ hostId }) => {
      const becameHost = hostId !== null && hostId === this.state.selfId && this.state.hostId !== hostId;
      this.set({ hostId, notice: becameHost ? 'You are now the host of this meeting.' : this.state.notice });
    });

    s.on('signal', ({ from, data }) => {
      void this.peers?.handleSignal(from, data);
    });

    s.on('transcript:started', ({ sessionId, serverNow }) => {
      this.set({
        transcript: { status: 'active', sessionId, entries: [], expiresAt: null },
        clockOffsetMs: serverNow - Date.now(),
        notice: null,
      });
      void this.startRecognition(sessionId);
    });

    s.on('transcript:entry', (entry) => {
      const t = this.state.transcript;
      if (t.status === 'idle') return;
      this.set({ transcript: { ...t, entries: [...t.entries, entry] } });
    });

    s.on('transcript:stopped', ({ sessionId, expiresAt, serverNow }) => {
      const t = this.state.transcript;
      if (t.sessionId !== sessionId) return;
      this.set({ transcript: { ...t, status: 'stopped', expiresAt }, clockOffsetMs: serverNow - Date.now() });
      void this.stopRecognition();
    });

    s.on('transcript:deleted', ({ sessionId }) => {
      const t = this.state.transcript;
      if (sessionId !== null && t.sessionId !== sessionId) return;
      const wasStopped = t.status === 'stopped';
      this.set({
        transcript: { status: 'idle', sessionId: null, entries: [], expiresAt: null },
        partialText: '',
        notice: wasStopped ? 'The transcript has been permanently deleted.' : this.state.notice,
      });
    });
  }

  private join(): void {
    const firstJoin = this.state.selfId === null;
    this.socket.emit(
      'room:join',
      { roomId: this.opts.roomId, displayName: this.opts.displayName, hostKey: this.hostKey, media: this.mediaState() },
      (res) => {
        if (!res.ok) {
          const message =
            !firstJoin && res.code === 'ROOM_NOT_FOUND' ? 'The connection was lost and the meeting has ended.' : res.message;
          this.socket.removeAllListeners();
          this.socket.disconnect();
          stopStream(this.opts.localStream);
          this.set({ phase: 'error', error: message });
          return;
        }
        this.hostKey = undefined; // one-time secret
        this.onJoined(res);
      },
    );
  }

  private onJoined(res: JoinSuccess): void {
    this.participantToken = res.participantToken;
    this.set({
      phase: 'joined',
      error: null,
      selfId: res.selfId,
      hostId: res.hostId,
      participants: res.participants,
      remoteStreams: {},
      connectionStates: {},
      transcript: { ...res.transcript },
      clockOffsetMs: res.serverNow - Date.now(),
    });

    this.peers?.closeAll();
    const peers = new PeerManager(res.iceServers, this.opts.localStream, {
      sendSignal: (to, data) => this.socket.emit('signal', { to, data }),
      onRemoteStream: (peerId, stream) => this.set({ remoteStreams: { ...this.state.remoteStreams, [peerId]: stream } }),
      onConnectionState: (peerId, st) => this.set({ connectionStates: { ...this.state.connectionStates, [peerId]: st } }),
    });
    this.peers = peers;
    for (const p of res.participants) {
      if (p.participantId !== res.selfId) void peers.connectTo(p.participantId);
    }

    if (res.transcript.status === 'active' && res.transcript.sessionId) void this.startRecognition(res.transcript.sessionId);
  }

  private async startRecognition(sessionId: string): Promise<void> {
    await this.stopRecognition();
    const track = this.opts.localStream.getAudioTracks()[0];
    if (!track) {
      this.set({ recognition: { status: 'error', message: 'No microphone available, so your speech cannot be transcribed.' } });
      return;
    }
    const transcriber = new SpeechTranscriber({
      audioTrack: track,
      getToken: () => {
        if (!this.participantToken) return Promise.reject(new Error('not joined'));
        return fetchSpeechToken(this.participantToken);
      },
      onPartial: (text) => this.set({ partialText: text }),
      onFinal: (text) => this.sendFinal(sessionId, text),
      onStatus: (status, message) => this.set({ recognition: { status, message: message ?? null } }),
    });
    this.transcriber = transcriber;
    transcriber.setMuted(!track.enabled);
    await transcriber.start();
  }

  private async stopRecognition(): Promise<void> {
    const t = this.transcriber;
    this.transcriber = null;
    if (t) await t.stop();
    this.set({ partialText: '', recognition: { status: 'idle', message: null } });
  }

  private sendFinal(sessionId: string, text: string): void {
    // Long utterances are split to respect the server's per-entry limit.
    for (let i = 0; i < text.length; i += TRANSCRIPT_TEXT_MAX_LENGTH) {
      this.socket.emit('transcript:entry', { sessionId, text: text.slice(i, i + TRANSCRIPT_TEXT_MAX_LENGTH) });
    }
  }
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}
