import type { IceServerConfig, SignalData } from '../../../shared/protocol';

/**
 * Mesh WebRTC: one RTCPeerConnection per remote participant (max 3).
 *
 * Negotiation is deterministic to avoid offer glare: the participant who
 * joins later sends the offer to everyone already present, and only the
 * offerer performs ICE restarts. Both sides always negotiate one audio and
 * one video transceiver so camera/mic toggles never need renegotiation
 * (toggles only flip `track.enabled`).
 */

export interface PeerManagerCallbacks {
  sendSignal(to: string, data: SignalData): void;
  onRemoteStream(peerId: string, stream: MediaStream): void;
  onConnectionState(peerId: string, state: RTCPeerConnectionState): void;
}

interface Peer {
  pc: RTCPeerConnection;
  isOfferer: boolean;
  remoteStream: MediaStream;
  pendingCandidates: RTCIceCandidateInit[];
  localTracksAttached: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
  restarting: boolean;
}

const DISCONNECT_GRACE_MS = 4_000;

export class PeerManager {
  private readonly peers = new Map<string, Peer>();
  private closed = false;
  /** Signals are processed strictly in arrival order. */
  private signalQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly iceServers: IceServerConfig[],
    private readonly localStream: MediaStream,
    private readonly cb: PeerManagerCallbacks,
  ) {}

  /** Called by the newcomer for each participant already in the room. */
  async connectTo(peerId: string): Promise<void> {
    if (this.closed) return;
    this.removePeer(peerId);
    const peer = this.createPeer(peerId, true);
    this.addLocalTransceivers(peer.pc);
    peer.localTracksAttached = true;
    await this.sendOffer(peerId, peer, false);
  }

  handleSignal(from: string, data: SignalData): Promise<void> {
    this.signalQueue = this.signalQueue.then(async () => {
      if (this.closed) return;
      try {
        if (data.type === 'description') await this.handleDescription(from, data.description);
        else await this.handleCandidate(from, data.candidate);
      } catch (err) {
        console.warn('[webrtc] signal handling failed', err instanceof Error ? err.name : err);
      }
    });
    return this.signalQueue;
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    if (peer.restartTimer) clearTimeout(peer.restartTimer);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
  }

  closeAll(): void {
    this.closed = true;
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  // ------------------------------------------------------------------ private

  private createPeer(peerId: string, isOfferer: boolean): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    const peer: Peer = {
      pc,
      isOfferer,
      remoteStream: new MediaStream(),
      pendingCandidates: [],
      localTracksAttached: false,
      restartTimer: null,
      restarting: false,
    };
    this.peers.set(peerId, peer);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const c = ev.candidate.toJSON();
      this.cb.sendSignal(peerId, {
        type: 'candidate',
        candidate: {
          candidate: c.candidate ?? '',
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
          usernameFragment: c.usernameFragment ?? null,
        },
      });
    };

    pc.ontrack = (ev) => {
      const stream = peer.remoteStream;
      for (const existing of stream.getTracks()) {
        if (existing.kind === ev.track.kind && existing.id !== ev.track.id) stream.removeTrack(existing);
      }
      if (!stream.getTracks().includes(ev.track)) stream.addTrack(ev.track);
      // Hand out a fresh MediaStream object so React sees a change.
      peer.remoteStream = new MediaStream(stream.getTracks());
      this.cb.onRemoteStream(peerId, peer.remoteStream);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.cb.onConnectionState(peerId, state);
      if (state === 'connected') {
        if (peer.restartTimer) clearTimeout(peer.restartTimer);
        peer.restartTimer = null;
        peer.restarting = false;
      } else if (state === 'failed') {
        void this.restartIce(peerId, peer);
      } else if (state === 'disconnected' && !peer.restartTimer) {
        // Transient drops often recover by themselves; restart only if they persist.
        peer.restartTimer = setTimeout(() => {
          peer.restartTimer = null;
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') void this.restartIce(peerId, peer);
        }, DISCONNECT_GRACE_MS);
      }
    };

    return peer;
  }

  private addLocalTransceivers(pc: RTCPeerConnection): void {
    const audio = this.localStream.getAudioTracks()[0];
    const video = this.localStream.getVideoTracks()[0];
    pc.addTransceiver(audio ?? 'audio', { direction: 'sendrecv', streams: [this.localStream] });
    pc.addTransceiver(video ?? 'video', { direction: 'sendrecv', streams: [this.localStream] });
  }

  /** Answerer: bind local tracks to the transceivers created by the remote offer. */
  private async attachLocalTracksToOffer(pc: RTCPeerConnection): Promise<void> {
    const byKind: Record<string, MediaStreamTrack | undefined> = {
      audio: this.localStream.getAudioTracks()[0],
      video: this.localStream.getVideoTracks()[0],
    };
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      const track = byKind[kind];
      if (!track) continue;
      byKind[kind] = undefined;
      await t.sender.replaceTrack(track);
      t.direction = 'sendrecv';
    }
  }

  private async sendOffer(peerId: string, peer: Peer, iceRestart: boolean): Promise<void> {
    const offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    if (this.peers.get(peerId) !== peer) return;
    await peer.pc.setLocalDescription(offer);
    const local = peer.pc.localDescription;
    if (!local) return;
    this.cb.sendSignal(peerId, { type: 'description', description: { type: 'offer', sdp: local.sdp } });
  }

  private async restartIce(peerId: string, peer: Peer): Promise<void> {
    if (!peer.isOfferer || peer.restarting || this.peers.get(peerId) !== peer) return;
    if (peer.pc.signalingState !== 'stable') return;
    peer.restarting = true;
    try {
      await this.sendOffer(peerId, peer, true);
    } catch (err) {
      console.warn('[webrtc] ICE restart failed', err instanceof Error ? err.name : err);
    } finally {
      // Allow another attempt later if this one does not recover the connection.
      setTimeout(() => {
        peer.restarting = false;
      }, 10_000);
    }
  }

  private async handleDescription(from: string, description: { type: 'offer' | 'answer'; sdp: string }): Promise<void> {
    if (description.type === 'offer') {
      let peer = this.peers.get(from);
      if (peer?.isOfferer) {
        // Unexpected glare: the offerer keeps its own offer (impolite side).
        if (peer.pc.signalingState !== 'stable') return;
      }
      peer ??= this.createPeer(from, false);
      await peer.pc.setRemoteDescription(description);
      if (!peer.localTracksAttached) {
        await this.attachLocalTracksToOffer(peer.pc);
        peer.localTracksAttached = true;
      }
      await this.flushCandidates(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      const local = peer.pc.localDescription;
      if (local) this.cb.sendSignal(from, { type: 'description', description: { type: 'answer', sdp: local.sdp } });
      return;
    }

    const peer = this.peers.get(from);
    if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
    await peer.pc.setRemoteDescription(description);
    await this.flushCandidates(peer);
  }

  private async handleCandidate(from: string, candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!candidate?.candidate) return;
    const peer = this.peers.get(from);
    if (!peer) return;
    if (!peer.pc.remoteDescription) {
      peer.pendingCandidates.push(candidate);
      return;
    }
    await peer.pc.addIceCandidate(candidate);
  }

  private async flushCandidates(peer: Peer): Promise<void> {
    const queued = peer.pendingCandidates.splice(0);
    for (const c of queued) {
      try {
        await peer.pc.addIceCandidate(c);
      } catch {
        // Candidates from a previous ICE generation may be rejected; harmless.
      }
    }
  }
}
