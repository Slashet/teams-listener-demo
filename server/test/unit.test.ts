import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../../shared/protocol.js';
import { loadConfig } from '../src/config.js';
import { clientIp } from '../src/http/clientIp.js';
import { buildIceServers } from '../src/ice.js';
import { formatTranscriptTxt, safeTimeZone, transcriptFilename } from '../src/rooms/transcriptFormat.js';
import { displayNameSchema, signalSchema, transcriptEntrySchema } from '../src/socket/schemas.js';
import { createSocketLimiter } from '../src/socket/rateLimiter.js';
import { SpeechNotConfiguredError, SpeechTokenError, SpeechTokenService } from '../src/speech/azureToken.js';

const entry = (displayName: string, text: string, iso: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  participantId: crypto.randomUUID(),
  displayName,
  text,
  timestamp: new Date(iso).getTime(),
});

describe('transcript TXT format', () => {
  it('renders header, times and speakers in the requested time zone', () => {
    const txt = formatTranscriptTxt(
      [
        entry('Melih', 'Bugünkü toplantıya başlayabiliriz.', '2026-09-29T11:05:31Z'),
        entry('Ahmet', 'Azure Speech tarafı çalışıyor.', '2026-09-29T11:05:37Z'),
      ],
      { timeZone: 'Europe/Istanbul' },
    );
    expect(txt).toBe(
      'Teams Listener Meeting Transcript\n29 September 2026\n\n14:05:31 - Melih\nBugünkü toplantıya başlayabiliriz.\n\n14:05:37 - Ahmet\nAzure Speech tarafı çalışıyor.\n',
    );
  });

  it('falls back to UTC for unknown zones', () => {
    expect(safeTimeZone('Not/AZone')).toBe('UTC');
    expect(safeTimeZone(undefined)).toBe('UTC');
    expect(safeTimeZone('Europe/Istanbul')).toBe('Europe/Istanbul');
  });

  it('produces a sanitized filename', () => {
    const name = transcriptFilename('../../ETC/passwd', Date.UTC(2026, 8, 29, 14, 5));
    expect(name).toBe('transcript-etcpasswd-2026-09-29-14-05.txt');
  });
});

describe('validation schemas', () => {
  it('normalizes display names and strips control characters', () => {
    expect(displayNameSchema.parse('  Ayşe \u0000‮ Yılmaz  ')).toBe('Ayşe Yılmaz');
    expect(displayNameSchema.safeParse('\u0007\u0008').success).toBe(false);
  });

  it('bounds transcript text', () => {
    const id = crypto.randomUUID();
    expect(transcriptEntrySchema.parse({ sessionId: id, text: '  merhaba \n dünya ' }).text).toBe('merhaba dünya');
    expect(transcriptEntrySchema.safeParse({ sessionId: id, text: 'x'.repeat(1001) }).success).toBe(false);
    expect(transcriptEntrySchema.safeParse({ sessionId: 'nope', text: 'x' }).success).toBe(false);
  });

  it('rejects malformed signalling payloads', () => {
    const to = crypto.randomUUID();
    expect(signalSchema.safeParse({ to, data: { type: 'description', description: { type: 'offer', sdp: 'v=0' } } }).success).toBe(true);
    expect(signalSchema.safeParse({ to, data: { type: 'description', description: { type: 'rollback', sdp: '' } } }).success).toBe(false);
    expect(signalSchema.safeParse({ to: 'socket-id', data: { type: 'candidate', candidate: null } }).success).toBe(false);
    expect(signalSchema.safeParse({ to, data: { type: 'other' } }).success).toBe(false);
  });
});

describe('socket rate limiter', () => {
  it('throttles bursts and refills over time', () => {
    let now = 0;
    const allow = createSocketLimiter(() => now);
    const results = Array.from({ length: 8 }, () => allow('control'));
    expect(results.filter(Boolean)).toHaveLength(6);
    now += 2_000;
    expect(allow('control')).toBe(true);
  });
});

describe('ICE configuration', () => {
  it('uses static TURN credentials when configured', () => {
    const cfg = loadConfig({ STUN_URL: 'stun:a:3478', TURN_URL: 'turn:b:3478,turn:b:3478?transport=tcp', TURN_USERNAME: 'u', TURN_PASSWORD: 'p' });
    expect(buildIceServers(cfg.ice, 'abc')).toEqual([
      { urls: ['stun:a:3478'] },
      { urls: ['turn:b:3478', 'turn:b:3478?transport=tcp'], username: 'u', credential: 'p' },
    ]);
  });

  it('mints time-limited TURN credentials with a shared secret', () => {
    const cfg = loadConfig({ TURN_URL: 'turn:b:3478', TURN_SHARED_SECRET: 'shh', TURN_CREDENTIAL_TTL_SECONDS: '3600' });
    const [turn] = buildIceServers(cfg.ice, 'participant-1', 1_000_000);
    expect(turn?.username).toBe('4600:particip');
    expect(turn?.credential).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(JSON.stringify(turn)).not.toContain('shh');
  });

  it('omits TURN when credentials are missing', () => {
    const cfg = loadConfig({ TURN_URL: 'turn:b:3478' });
    expect(buildIceServers(cfg.ice, 'x')).toEqual([]);
  });
});

describe('SpeechTokenService', () => {
  it('fails clearly when not configured', async () => {
    const svc = new SpeechTokenService({ key: undefined, region: undefined, language: 'tr-TR' });
    await expect(svc.issue()).rejects.toBeInstanceOf(SpeechNotConfiguredError);
  });

  it('caches tokens and refetches after max age', async () => {
    let now = 0;
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++;
      expect((init?.headers as Record<string, string>)['Ocp-Apim-Subscription-Key']).toBe('k');
      return new Response(`tok${calls}`);
    };
    const svc = new SpeechTokenService({ key: 'k', region: 'westeurope', language: 'tr-TR', fetchImpl, now: () => now, maxTokenAgeMs: 240_000 });
    expect((await svc.issue()).token).toBe('tok1');
    now += 239_000;
    expect((await svc.issue()).token).toBe('tok1');
    now += 2_000;
    expect((await svc.issue()).token).toBe('tok2');
  });

  it('does not leak Azure error bodies', async () => {
    const fetchImpl: typeof fetch = async () => new Response('Access denied due to invalid subscription key sk-123', { status: 401 });
    const svc = new SpeechTokenService({ key: 'k', region: 'westeurope', language: 'tr-TR', fetchImpl });
    const err = await svc.issue().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpeechTokenError);
    expect(String((err as Error).message)).not.toContain('sk-123');
  });
});

describe('config', () => {
  it('reports invalid variables without echoing values', () => {
    expect(() => loadConfig({ PORT: 'not-a-port-secretvalue' })).toThrowError(/PORT/);
    expect(() => loadConfig({ PORT: 'not-a-port-secretvalue' })).not.toThrowError(/secretvalue/);
  });
});

describe('clientIp', () => {
  const req = (remote: string, xff?: string) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} }) as unknown as IncomingMessage;

  it('uses the socket address when no proxy is trusted', () => {
    expect(clientIp(req('10.0.0.5', '1.2.3.4'), 0)).toBe('10.0.0.5');
  });

  it('takes the address added by the trusted proxy, ignoring spoofed entries', () => {
    expect(clientIp(req('172.18.0.2', '6.6.6.6, 1.2.3.4'), 1)).toBe('1.2.3.4');
    expect(clientIp(req('172.18.0.2'), 1)).toBe('172.18.0.2');
  });
});
