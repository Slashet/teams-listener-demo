import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignalData } from '../../shared/protocol';
import { MAX_PENDING_CANDIDATES, PeerManager } from '../src/webrtc/PeerManager';

/** Minimal RTCPeerConnection fake recording what the manager does. */
class FakePC {
  static instances: FakePC[] = [];
  remoteDescription: { type: string; sdp: string } | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  signalingState = 'stable';
  connectionState = 'new';
  added: string[] = [];
  transceivers: { receiver: { track: { kind: string } }; sender: { replaceTrack: () => Promise<void> }; direction: string }[] = [];
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  closed = false;

  constructor() {
    FakePC.instances.push(this);
  }
  addTransceiver(kind: string | { kind: string }) {
    const k = typeof kind === 'string' ? kind : kind.kind;
    this.transceivers.push({ receiver: { track: { kind: k } }, sender: { replaceTrack: async () => undefined }, direction: 'sendrecv' });
  }
  getTransceivers() {
    return this.transceivers;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer-sdp' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer-sdp' };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    if (d.type === 'offer') {
      this.signalingState = 'have-remote-offer';
      if (this.transceivers.length === 0) {
        this.addTransceiver('audio');
        this.addTransceiver('video');
      }
    } else {
      this.signalingState = 'stable';
    }
  }
  async addIceCandidate(c: { candidate: string }) {
    if (!this.remoteDescription) throw new Error('InvalidStateError: no remote description');
    this.added.push(c.candidate);
  }
  close() {
    this.closed = true;
  }
}

class FakeMediaStream {
  private tracks: { kind: string }[];
  constructor(tracks: { kind: string }[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(t: { kind: string }) {
    this.tracks.push(t);
  }
  removeTrack(t: { kind: string }) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

const cand = (n: number): SignalData => ({ type: 'candidate', candidate: { candidate: `candidate:${n} 1 udp 1 1.2.3.4 ${1000 + n} typ host`, sdpMid: '0', sdpMLineIndex: 0 } });
const offer: SignalData = { type: 'description', description: { type: 'offer', sdp: 'remote-offer' } };
const answer: SignalData = { type: 'description', description: { type: 'answer', sdp: 'remote-answer' } };

function setup() {
  const sent: { to: string; data: SignalData }[] = [];
  const local = new FakeMediaStream([{ kind: 'audio' }, { kind: 'video' }]) as unknown as MediaStream;
  const pm = new PeerManager([], local, {
    sendSignal: (to, data) => sent.push({ to, data }),
    onRemoteStream: () => undefined,
    onConnectionState: () => undefined,
  });
  return { pm, sent };
}

describe('PeerManager ICE ordering', () => {
  beforeEach(() => {
    FakePC.instances = [];
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('MediaStream', FakeMediaStream);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('buffers candidates that arrive before the offer creates the peer, then applies them', async () => {
    const { pm, sent } = setup();
    await pm.handleSignal('peer-a', cand(1));
    await pm.handleSignal('peer-a', cand(2));
    expect(FakePC.instances).toHaveLength(0);

    await pm.handleSignal('peer-a', offer);
    const pc = FakePC.instances[0]!;
    expect(pc.added).toEqual([expect.stringContaining('candidate:1'), expect.stringContaining('candidate:2')]);
    expect(sent.at(-1)).toMatchObject({ to: 'peer-a', data: { type: 'description', description: { type: 'answer' } } });
  });

  it('buffers candidates received before the remote description (offerer side) and flushes on answer', async () => {
    const { pm } = setup();
    await pm.connectTo('peer-b');
    const pc = FakePC.instances[0]!;
    expect(pc.signalingState).toBe('have-local-offer');

    await pm.handleSignal('peer-b', cand(7));
    expect(pc.added).toEqual([]);
    await pm.handleSignal('peer-b', answer);
    expect(pc.added).toEqual([expect.stringContaining('candidate:7')]);

    await pm.handleSignal('peer-b', cand(8));
    expect(pc.added).toHaveLength(2);
  });

  it('keeps the early-candidate buffer bounded', async () => {
    const { pm } = setup();
    for (let i = 0; i < MAX_PENDING_CANDIDATES + 50; i++) await pm.handleSignal('peer-c', cand(i));
    await pm.handleSignal('peer-c', offer);
    expect(FakePC.instances[0]!.added).toHaveLength(MAX_PENDING_CANDIDATES);
  });

  it('limits how many unknown peers can hold early candidates', async () => {
    const { pm } = setup();
    for (let p = 0; p < 20; p++) await pm.handleSignal(`ghost-${p}`, cand(p));
    await pm.handleSignal('ghost-19', offer);
    expect(FakePC.instances[0]!.added).toEqual([]);
    await pm.handleSignal('ghost-0', offer);
    expect(FakePC.instances[1]!.added).toHaveLength(1);
  });

  it('drops buffered early candidates when the peer leaves', async () => {
    const { pm } = setup();
    await pm.handleSignal('peer-d', cand(1));
    pm.removePeer('peer-d');
    await pm.handleSignal('peer-d', offer);
    expect(FakePC.instances[0]!.added).toEqual([]);
  });

  it('keeps the newcomer-offers negotiation: answerer never sends an offer', async () => {
    const { pm, sent } = setup();
    await pm.handleSignal('peer-e', offer);
    expect(sent.filter((s) => s.data.type === 'description').map((s) => (s.data as { description: { type: string } }).description.type)).toEqual(['answer']);
  });

  it('ignores signals after closeAll', async () => {
    const { pm } = setup();
    pm.closeAll();
    await pm.handleSignal('peer-f', offer);
    expect(FakePC.instances).toHaveLength(0);
  });
});
