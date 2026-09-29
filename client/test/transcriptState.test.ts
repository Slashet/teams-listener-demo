import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptEntry } from '../../shared/protocol';
import {
  EMPTY_TRANSCRIPT,
  TranscriptExpiryTimer,
  isTranscriptExpired,
  transcriptDeleted,
  transcriptEntryAdded,
  transcriptFromServer,
  transcriptStarted,
  transcriptStopped,
  type ExpiryEnvironment,
} from '../src/meeting/transcriptState';

const entry = (text: string): TranscriptEntry => ({ id: text, participantId: 'p1', displayName: 'Melih', text, timestamp: 1 });

function fakeEnv() {
  const activeListeners = new Set<() => void>();
  const env: ExpiryEnvironment = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onPageActive: (fn) => {
      activeListeners.add(fn);
      return () => activeListeners.delete(fn);
    },
  };
  return { env, pageBecameActive: () => activeListeners.forEach((l) => l()), activeListeners };
}

describe('transcript state transitions', () => {
  it('start → entries → stop → delete', () => {
    let t = transcriptStarted('s1');
    t = transcriptEntryAdded(t, entry('a'));
    t = transcriptStopped(t, 's1', 5_000);
    expect(t).toMatchObject({ status: 'stopped', sessionId: 's1', expiresAt: 5_000 });
    // Late flushed finals are still shown during the window.
    t = transcriptEntryAdded(t, entry('b'));
    expect(t.entries.map((e) => e.text)).toEqual(['a', 'b']);
    expect(transcriptDeleted(t, 's1')).toBe(EMPTY_TRANSCRIPT);
  });

  it('ignores entries when idle and stop events for another session', () => {
    expect(transcriptEntryAdded(EMPTY_TRANSCRIPT, entry('x'))).toBe(EMPTY_TRANSCRIPT);
    const t = transcriptStarted('s2');
    expect(transcriptStopped(t, 's1', 1)).toBe(t);
  });

  it('deletion is idempotent', () => {
    const t = transcriptStopped(transcriptEntryAdded(transcriptStarted('s1'), entry('a')), 's1', 1);
    const once = transcriptDeleted(t, 's1');
    expect(once).toBe(EMPTY_TRANSCRIPT);
    expect(transcriptDeleted(once, 's1')).toBe(once);
    expect(transcriptDeleted(once, null)).toBe(once);
  });

  it('a stale deletion for an older session does not delete a newer session', () => {
    const newer = transcriptEntryAdded(transcriptStarted('s2'), entry('new'));
    expect(transcriptDeleted(newer, 's1')).toBe(newer);
  });

  it('server state on reconnect replaces local state', () => {
    const local = transcriptStopped(transcriptEntryAdded(transcriptStarted('s1'), entry('old')), 's1', 10);
    expect(transcriptFromServer({ status: 'idle', sessionId: null, entries: [], expiresAt: null })).toBe(EMPTY_TRANSCRIPT);
    const replaced = transcriptFromServer({ status: 'active', sessionId: 's2', entries: [entry('srv')], expiresAt: null });
    expect(replaced).toEqual({ status: 'active', sessionId: 's2', entries: [entry('srv')], expiresAt: null });
    expect(replaced).not.toBe(local);
  });

  it('computes expiry with the server clock offset', () => {
    const t = transcriptStopped(transcriptStarted('s1'), 's1', 30_000);
    // Client clock is 5 s behind the server (offset +5 s).
    expect(isTranscriptExpired(t, 5_000, 24_999)).toBe(false);
    expect(isTranscriptExpired(t, 5_000, 25_000)).toBe(true);
    expect(isTranscriptExpired(transcriptStarted('s1'), 0, 1e12)).toBe(false);
  });
});

describe('TranscriptExpiryTimer (local privacy fallback)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => vi.useRealTimers());

  it('purges locally at expiresAt even without a server deletion event', () => {
    // Simulated controller: holds transcript, purges via the same idempotent path.
    let transcript = transcriptStopped(transcriptEntryAdded(transcriptStarted('s1'), entry('secret')), 's1', 130_000);
    const { env } = fakeEnv();
    const timer = new TranscriptExpiryTimer((sid) => (transcript = transcriptDeleted(transcript, sid)), env);
    timer.schedule('s1', 130_000, 0);

    vi.advanceTimersByTime(29_999);
    expect(transcript.entries).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(transcript).toBe(EMPTY_TRANSCRIPT);
    timer.dispose();
  });

  it('uses the server-calibrated clock (client clock skew)', () => {
    const onExpire = vi.fn();
    const timer = new TranscriptExpiryTimer(onExpire, fakeEnv().env);
    // Server is 10 s ahead of the client: server expiresAt 140 000 == client 130 000.
    timer.schedule('s1', 140_000, 10_000);
    vi.advanceTimersByTime(29_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledExactlyOnceWith('s1');
    timer.dispose();
  });

  it('purges immediately when scheduled for an already-past expiry', () => {
    const onExpire = vi.fn();
    const timer = new TranscriptExpiryTimer(onExpire, fakeEnv().env);
    timer.schedule('s1', 90_000, 0);
    expect(onExpire).toHaveBeenCalledOnce();
    timer.dispose();
  });

  it('purges as soon as a backgrounded tab becomes active after the deadline', () => {
    const onExpire = vi.fn();
    const { env, pageBecameActive } = fakeEnv();
    // Background tab: timers are throttled so the scheduled callback never runs on time.
    const throttledEnv: ExpiryEnvironment = { ...env, setTimeout: () => ({ throttled: true }), clearTimeout: () => undefined };
    const timer = new TranscriptExpiryTimer(onExpire, throttledEnv);
    timer.schedule('s1', 130_000, 0);

    vi.setSystemTime(120_000);
    pageBecameActive();
    expect(onExpire).not.toHaveBeenCalled();

    vi.setSystemTime(131_000);
    pageBecameActive();
    expect(onExpire).toHaveBeenCalledExactlyOnceWith('s1');
    pageBecameActive();
    expect(onExpire).toHaveBeenCalledOnce();
    timer.dispose();
  });

  it('server deletion first, then local expiry: cleanup happens once', () => {
    let transcript = transcriptStopped(transcriptEntryAdded(transcriptStarted('s1'), entry('x')), 's1', 130_000);
    let purges = 0;
    const purge = (sid: string | null) => {
      const next = transcriptDeleted(transcript, sid);
      if (next !== transcript) purges++;
      transcript = next;
    };
    const timer = new TranscriptExpiryTimer(purge, fakeEnv().env);
    timer.schedule('s1', 130_000, 0);
    purge('s1'); // transcript:deleted from the server
    timer.cancel();
    vi.advanceTimersByTime(60_000);
    expect(purges).toBe(1);
    timer.dispose();
  });

  it('a local expiry for an old session does not remove a newer session', () => {
    let transcript = transcriptStopped(transcriptStarted('s1'), 's1', 130_000);
    const timer = new TranscriptExpiryTimer((sid) => (transcript = transcriptDeleted(transcript, sid)), fakeEnv().env);
    timer.schedule('s1', 130_000, 0);
    // Host starts a new session; suppose the controller forgot to cancel the timer.
    transcript = transcriptEntryAdded(transcriptStarted('s2'), entry('new session'));
    vi.advanceTimersByTime(30_000);
    expect(transcript.sessionId).toBe('s2');
    expect(transcript.entries).toHaveLength(1);
    timer.dispose();
  });

  it('cancel and reschedule (reconnect with fresh server state)', () => {
    const onExpire = vi.fn();
    const timer = new TranscriptExpiryTimer(onExpire, fakeEnv().env);
    timer.schedule('s1', 130_000, 0);
    timer.cancel();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    timer.schedule('s2', 170_000, 0);
    vi.advanceTimersByTime(10_000);
    expect(onExpire).toHaveBeenCalledExactlyOnceWith('s2');
    timer.dispose();
  });

  it('dispose removes page-activity listeners', () => {
    const { env, activeListeners } = fakeEnv();
    const timer = new TranscriptExpiryTimer(vi.fn(), env);
    expect(activeListeners.size).toBe(1);
    timer.dispose();
    expect(activeListeners.size).toBe(0);
  });
});
