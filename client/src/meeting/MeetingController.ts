import {
  TRANSCRIPT_TEXT_MAX_LENGTH,
  type JoinSuccess,
  type MediaState,
  type ParticipantInfo,
  type TranscriptState,
} from '../../../shared/protocol';
import { fetchSpeechToken } from '../lib/api';
import { stopStream } from '../lib/media';
import { createMeetingSocket, type MeetingSocket } from '../lib/socket';
import { SpeechTranscriber, type RecognitionStatus } from '../speech/SpeechTranscriber';
import { PeerManager } from '../webrtc/PeerManager';
import { RecognitionCoordinator } from './RecognitionCoordinator';
import {
  EMPTY_TRANSCRIPT,
  TranscriptExpiryTimer,
  transcriptDeleted,
  transcriptEntryAdded,
  transcriptFromServer,
  transcriptStarted,
  transcriptStopped,
} from './transcriptState';

/**
 * Owns the socket, the WebRTC mesh and the local speech recognizer for one
 * meeting. React subscribes to immutable snapshots of `MeetingState`.
 *
 * Transcript data lives only in this in-memory state (never in
 * localStorage/sessionStorage) and is dropped when the server deletes it,
 * or locally once the server-announced expiry passes (e.g. while offline).
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
  transcript: TranscriptState;
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
  /** Serializes speech recognizer start/stop so instances never overlap. */
  private readonly recognition: RecognitionCoordinator;
  private participantToken: string | null = null;
  private hostKey: string | undefined;
  private leaving = false;
  /** Local privacy fallback; the server timer stays authoritative. */
  private readonly expiry = new TranscriptExpiryTimer((sessionId) => this.purgeTranscript(sessionId));

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
      transcript: EMPTY_TRANSCRIPT,
      clockOffsetMs: 0,
      partialText: '',
      recognition: { status: 'idle', message: null },
      notice: null,
    };
    this.recognition = new RecognitionCoordinator({
      createTranscriber: (callbacks) => {
        const track = this.opts.localStream.getAudioTracks()[0];
        if (!track) return null;
        return new SpeechTranscriber({
          audioTrack: track,
          getToken: () => {
            if (!this.participantToken) return Promise.reject(new Error('not joined'));
            return fetchSpeechToken(this.participantToken);
          },
          ...callbacks,
        });
      },
      sink: {
        setRecognition: (status, message) => this.set({ recognition: { status, message } }),
        setPartial: (text) => this.set({ partialText: text }),
        sendFinal: (sessionId, text) => this.sendFinal(sessionId, text),
      },
      unavailableMessage: 'No microphone available, so your speech cannot be transcribed.',
    });
    this.recognition.setMuted(!audio?.enabled);
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
    this.expiry.dispose();
    // Waits until any active or draining recognizer has fully cleaned up.
    await this.recognition.dispose();
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
      transcript: EMPTY_TRANSCRIPT,
      partialText: '',
    });
  }

  toggleAudio(): void {
    const track = this.opts.localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.recognition.setMuted(!track.enabled);
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
    this.recognition.retry();
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
      void this.recognition.stop();
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
      this.expiry.cancel();
      this.set({
        transcript: transcriptStarted(sessionId),
        clockOffsetMs: serverNow - Date.now(),
        notice: null,
      });
      void this.recognition.start(sessionId);
    });

    s.on('transcript:entry', (entry) => {
      const next = transcriptEntryAdded(this.state.transcript, entry);
      if (next !== this.state.transcript) this.set({ transcript: next });
    });

    s.on('transcript:stopped', ({ sessionId, expiresAt, serverNow }) => {
      const next = transcriptStopped(this.state.transcript, sessionId, expiresAt);
      if (next === this.state.transcript) return;
      const clockOffsetMs = serverNow - Date.now();
      this.set({ transcript: next, clockOffsetMs });
      this.expiry.schedule(sessionId, expiresAt, clockOffsetMs);
      void this.recognition.stop();
    });

    s.on('transcript:deleted', ({ sessionId }) => this.purgeTranscript(sessionId));
  }

  /** Same cleanup for the server event and the local expiry fallback; idempotent. */
  private purgeTranscript(sessionId: string | null): void {
    const t = this.state.transcript;
    const next = transcriptDeleted(t, sessionId);
    if (next === t) return;
    this.expiry.cancel();
    this.set({
      transcript: next,
      partialText: '',
      notice: t.status === 'stopped' ? 'The transcript has been permanently deleted.' : this.state.notice,
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
          void this.recognition.dispose();
          stopStream(this.opts.localStream);
          this.expiry.dispose();
          this.set({ phase: 'error', error: message, transcript: EMPTY_TRANSCRIPT, partialText: '' });
          return;
        }
        this.hostKey = undefined; // one-time secret
        this.onJoined(res);
      },
    );
  }

  private onJoined(res: JoinSuccess): void {
    this.participantToken = res.participantToken;
    // Server state always replaces whatever this tab still held locally.
    const transcript = transcriptFromServer(res.transcript);
    const clockOffsetMs = res.serverNow - Date.now();
    this.expiry.cancel();
    this.set({
      phase: 'joined',
      error: null,
      selfId: res.selfId,
      hostId: res.hostId,
      participants: res.participants,
      remoteStreams: {},
      connectionStates: {},
      transcript,
      partialText: '',
      clockOffsetMs,
    });
    if (transcript.status === 'stopped' && transcript.sessionId && transcript.expiresAt !== null) {
      this.expiry.schedule(transcript.sessionId, transcript.expiresAt, clockOffsetMs);
    }

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

    // Queued behind any recognizer still draining from before the reconnect.
    if (res.transcript.status === 'active' && res.transcript.sessionId) void this.recognition.start(res.transcript.sessionId);
    else void this.recognition.stop();
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
