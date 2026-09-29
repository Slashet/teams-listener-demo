import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ClientToServerEvents,
  CreateRoomResponse,
  DownloadResult,
  JoinResult,
  JoinSuccess,
  ServerToClientEvents,
  SimpleResult,
  TranscriptEntry,
} from '../../shared/protocol.js';
import { loadConfig } from '../src/config.js';
import { configureLogger } from '../src/logger.js';
import { buildServer, type StartedServer } from '../src/server.js';
import { SpeechTokenService } from '../src/speech/azureToken.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const media = { audioEnabled: true, videoEnabled: true };

let server: StartedServer;
let baseUrl: string;
let clients: Client[] = [];
let stsCalls = 0;

beforeAll(() => configureLogger({ silent: true }));

beforeEach(async () => {
  stsCalls = 0;
  const config = loadConfig({
    NODE_ENV: 'test',
    STUN_URL: 'stun:stun.example.test:3478',
    TURN_URL: 'turn:turn.example.test:3478',
    TURN_USERNAME: 'demo-user',
    TURN_PASSWORD: 'demo-pass',
  });
  const fakeFetch: typeof fetch = async () => {
    stsCalls++;
    return new Response('fake-azure-token', { status: 200 });
  };
  const speech = new SpeechTokenService({ key: 'test-key', region: 'westeurope', language: 'tr-TR', fetchImpl: fakeFetch });
  server = buildServer({ config, speech, roomOptions: { transcriptRetentionMs: 400, lateEntryGraceMs: 0 }, clientDir: '/nonexistent' });
  await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  clients.forEach((c) => c.disconnect());
  clients = [];
  await server.close();
});

async function createRoom(): Promise<CreateRoomResponse> {
  const res = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateRoomResponse;
}

async function connect(): Promise<Client> {
  const c: Client = ioClient(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(c);
  await new Promise<void>((resolve, reject) => {
    c.once('connect', () => resolve());
    c.once('connect_error', reject);
  });
  return c;
}

function join(c: Client, roomId: string, displayName: string, hostKey?: string): Promise<JoinResult> {
  return new Promise((resolve) => c.emit('room:join', { roomId, displayName, hostKey, media }, resolve));
}

async function joinOk(c: Client, roomId: string, displayName: string, hostKey?: string): Promise<JoinSuccess> {
  const res = await join(c, roomId, displayName, hostKey);
  if (!res.ok) throw new Error(`join failed: ${res.code}`);
  return res;
}

function ack(c: Client, event: 'transcript:start' | 'transcript:stop'): Promise<SimpleResult> {
  return new Promise((resolve) => c.emit(event, resolve));
}

function next<E extends keyof ServerToClientEvents>(c: Client, event: E, timeoutMs = 2000): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${String(event)}`)), timeoutMs);
    (c.once as (ev: string, fn: (arg: unknown) => void) => void)(event, (arg) => {
      clearTimeout(t);
      resolve(arg as Parameters<ServerToClientEvents[E]>[0]);
    });
  });
}

function expectNone(c: Client, event: keyof ServerToClientEvents, ms = 200): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = () => reject(new Error(`unexpected ${String(event)}`));
    (c.on as (ev: string, fn: () => void) => void)(event, handler);
    setTimeout(() => {
      (c.off as (ev: string, fn: () => void) => void)(event, handler);
      resolve();
    }, ms);
  });
}

async function roomWithParticipants(n: number) {
  const { roomId, hostKey } = await createRoom();
  const sockets: Client[] = [];
  const joins: JoinSuccess[] = [];
  for (let i = 0; i < n; i++) {
    const c = await connect();
    sockets.push(c);
    joins.push(await joinOk(c, roomId, `User${i}`, i === 0 ? hostKey : undefined));
  }
  return { roomId, sockets, joins };
}

describe('HTTP', () => {
  it('health check does not expose configuration', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('has no endpoint listing rooms', async () => {
    await createRoom();
    expect((await fetch(`${baseUrl}/api/rooms`)).status).toBe(404);
  });
});

describe('joining', () => {
  it('returns participants, host and ICE servers to a joined socket', async () => {
    const { joins } = await roomWithParticipants(2);
    const [host, guest] = joins as [JoinSuccess, JoinSuccess];
    expect(host.hostId).toBe(host.selfId);
    expect(guest.hostId).toBe(host.selfId);
    expect(guest.participants.map((p) => p.displayName)).toEqual(['User0', 'User1']);
    expect(guest.iceServers).toEqual([
      { urls: ['stun:stun.example.test:3478'] },
      { urls: ['turn:turn.example.test:3478'], username: 'demo-user', credential: 'demo-pass' },
    ]);
  });

  it('rejects a fifth participant', async () => {
    const { roomId } = await roomWithParticipants(4);
    const fifth = await connect();
    const res = await join(fifth, roomId, 'Fifth');
    expect(res).toEqual({ ok: false, code: 'ROOM_FULL', message: 'This meeting is full. Maximum 4 participants.' });
  });

  it('validates the join payload', async () => {
    const { roomId } = await createRoom();
    const c = await connect();
    expect(await join(c, roomId, '   ')).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(await join(c, roomId, 'x'.repeat(41))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(await join(c, '../etc/passwd', 'Name')).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(await join(c, 'aaaaaaaaaaaaaaaa', 'Name')).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' });
  });

  it('notifies peers of join, leave and host reassignment', async () => {
    const { roomId, sockets, joins } = await roomWithParticipants(2);
    const [host, guest] = sockets as [Client, Client];
    const third = await connect();
    const joinedEvt = next(guest, 'participant:joined');
    const thirdJoin = await joinOk(third, roomId, 'Third');
    expect((await joinedEvt).participantId).toBe(thirdJoin.selfId);

    const leftEvt = next(guest, 'participant:left');
    const hostEvt = next(guest, 'host:changed');
    host.disconnect();
    expect((await leftEvt).participantId).toBe(joins[0]!.selfId);
    expect((await hostEvt).hostId).toBe(joins[1]!.selfId);
  });
});

describe('signalling', () => {
  it('relays signals to a peer in the same room with the server-known sender id', async () => {
    const { sockets, joins } = await roomWithParticipants(2);
    const [a, b] = sockets as [Client, Client];
    const received = next(b, 'signal');
    a.emit('signal', { to: joins[1]!.selfId, data: { type: 'description', description: { type: 'offer', sdp: 'v=0' } } });
    expect(await received).toEqual({ from: joins[0]!.selfId, data: { type: 'description', description: { type: 'offer', sdp: 'v=0' } } });
  });

  it('does not relay signals to a participant of another room', async () => {
    const roomA = await roomWithParticipants(1);
    const roomB = await roomWithParticipants(1);
    const attacker = roomA.sockets[0]!;
    const victim = roomB.sockets[0]!;
    const none = expectNone(victim, 'signal');
    attacker.emit('signal', { to: roomB.joins[0]!.selfId, data: { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' } } });
    await none;
  });

  it('ignores signals from sockets that have not joined', async () => {
    const { sockets, joins } = await roomWithParticipants(1);
    const outsider = await connect();
    const none = expectNone(sockets[0]!, 'signal');
    outsider.emit('signal', { to: joins[0]!.selfId, data: { type: 'candidate', candidate: null } });
    await none;
  });
});

describe('transcript', () => {
  it('only the host can start and stop; everyone receives the events', async () => {
    const { sockets } = await roomWithParticipants(2);
    const [host, guest] = sockets as [Client, Client];

    expect(await ack(guest, 'transcript:start')).toMatchObject({ ok: false, code: 'NOT_HOST' });
    const started = next(guest, 'transcript:started');
    expect(await ack(host, 'transcript:start')).toEqual({ ok: true });
    expect((await started).sessionId).toMatch(/[0-9a-f-]{36}/);

    expect(await ack(guest, 'transcript:stop')).toMatchObject({ ok: false, code: 'NOT_HOST' });
    const stopped = next(guest, 'transcript:stopped');
    const before = Date.now();
    expect(await ack(host, 'transcript:stop')).toEqual({ ok: true });
    const evt = await stopped;
    expect(evt.expiresAt).toBeGreaterThanOrEqual(before + 400);
  });

  it('attributes entries to the sending socket, ignoring spoofed identity fields', async () => {
    const { sockets, joins } = await roomWithParticipants(2);
    const [host, guest] = sockets as [Client, Client];
    const started = next(host, 'transcript:started');
    await ack(host, 'transcript:start');
    const { sessionId } = await started;

    const received = next(host, 'transcript:entry');
    // A malicious client tries to impersonate the host.
    (guest.emit as (ev: string, payload: unknown) => void)('transcript:entry', {
      sessionId,
      text: 'I am definitely the host',
      participantId: joins[0]!.selfId,
      userId: joins[0]!.selfId,
      displayName: 'User0',
    });
    const entry: TranscriptEntry = await received;
    expect(entry.participantId).toBe(joins[1]!.selfId);
    expect(entry.displayName).toBe('User1');
    expect(entry.text).toBe('I am definitely the host');
  });

  it('rejects oversized transcript text', async () => {
    const { sockets } = await roomWithParticipants(1);
    const host = sockets[0]!;
    const started = next(host, 'transcript:started');
    await ack(host, 'transcript:start');
    const { sessionId } = await started;
    const res = await new Promise<SimpleResult>((resolve) => host.emit('transcript:entry', { sessionId, text: 'a'.repeat(5000) }, resolve));
    expect(res).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });

  it('downloads during the window, then deletes and broadcasts transcript:deleted', async () => {
    const { sockets } = await roomWithParticipants(2);
    const [host, guest] = sockets as [Client, Client];
    const started = next(guest, 'transcript:started');
    await ack(host, 'transcript:start');
    const { sessionId } = await started;

    const entryEvt = next(guest, 'transcript:entry');
    await new Promise<SimpleResult>((resolve) => guest.emit('transcript:entry', { sessionId, text: 'Benim sesim geliyor mu?' }, resolve));
    await entryEvt;
    await ack(host, 'transcript:stop');

    const dl = await new Promise<DownloadResult>((resolve) => guest.emit('transcript:download', { timeZone: 'Europe/Istanbul' }, resolve));
    expect(dl.ok).toBe(true);
    if (dl.ok) {
      expect(dl.content).toContain('Teams Listener Meeting Transcript');
      expect(dl.content).toContain(' - User1\nBenim sesim geliyor mu?');
      expect(dl.filename).toMatch(/^transcript-[a-f0-9]{16}-[0-9-]+\.txt$/);
    }

    const deleted = await next(guest, 'transcript:deleted', 2000);
    expect(deleted.sessionId).toBe(sessionId);

    const after = await new Promise<DownloadResult>((resolve) => guest.emit('transcript:download', {}, resolve));
    expect(after).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
  });

  it('a participant outside the room cannot download', async () => {
    await roomWithParticipants(1);
    const outsider = await connect();
    const res = await new Promise<DownloadResult>((resolve) => outsider.emit('transcript:download', {}, resolve));
    expect(res).toMatchObject({ ok: false, code: 'NOT_JOINED' });
  });
});

describe('speech token endpoint', () => {
  it('requires a participant token and an active transcript; never returns the key', async () => {
    const { sockets, joins } = await roomWithParticipants(1);
    const token = joins[0]!.participantToken;

    expect((await fetch(`${baseUrl}/api/speech/token`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/speech/token`, { headers: { Authorization: 'Bearer not-a-real-participant-token' } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/speech/token`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(409);

    const started = next(sockets[0]!, 'transcript:started');
    await ack(sockets[0]!, 'transcript:start');
    await started;
    const res = await fetch(`${baseUrl}/api/speech/token`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const bodyText = await res.text();
    expect(JSON.parse(bodyText)).toEqual({ token: 'fake-azure-token', region: 'westeurope', language: 'tr-TR', refreshAfterSeconds: 180 });
    expect(bodyText).not.toContain('test-key');

    // Cached: a second request does not hit Azure STS again.
    await fetch(`${baseUrl}/api/speech/token`, { headers: { Authorization: `Bearer ${token}` } });
    expect(stsCalls).toBe(1);
  });
});

describe('production origin check', () => {
  it('rejects WebSocket connections from foreign origins', async () => {
    await server.close();
    const config = loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://teamslistener.example.test', TRUST_PROXY: '0' });
    server = buildServer({ config, clientDir: '/nonexistent' });
    await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;

    const attempt = (origin: string) =>
      new Promise<boolean>((resolve) => {
        const c: Client = ioClient(url, { transports: ['polling'], forceNew: true, reconnection: false, extraHeaders: { origin } });
        clients.push(c);
        c.once('connect', () => resolve(true));
        c.once('connect_error', () => resolve(false));
      });

    expect(await attempt('https://evil.example.test')).toBe(false);
    expect(await attempt('https://teamslistener.example.test')).toBe(true);
  });
});
