import type { TranscriptEntry, TranscriptState } from '../../../shared/protocol';

/**
 * Client-side transcript state transitions (pure functions) and the local
 * privacy-expiry fallback.
 *
 * The server is the source of truth for transcript deletion. The local
 * fallback only guarantees that a browser which missed `transcript:deleted`
 * (e.g. it was disconnected at the time) still drops the text from memory
 * once the server-announced `expiresAt` has passed.
 */

export type ClientTranscript = TranscriptState;

export const EMPTY_TRANSCRIPT: ClientTranscript = Object.freeze({
  status: 'idle',
  sessionId: null,
  entries: [],
  expiresAt: null,
}) as ClientTranscript;

export function transcriptStarted(sessionId: string): ClientTranscript {
  return { status: 'active', sessionId, entries: [], expiresAt: null };
}

export function transcriptEntryAdded(t: ClientTranscript, entry: TranscriptEntry): ClientTranscript {
  if (t.status === 'idle') return t;
  return { ...t, entries: [...t.entries, entry] };
}

export function transcriptStopped(t: ClientTranscript, sessionId: string, expiresAt: number): ClientTranscript {
  if (t.sessionId !== sessionId) return t;
  return { ...t, status: 'stopped', expiresAt };
}

/**
 * Deletion (server event or local expiry). Idempotent; a deletion for an
 * older session never removes a newer one. `sessionId === null` deletes any.
 */
export function transcriptDeleted(t: ClientTranscript, sessionId: string | null): ClientTranscript {
  if (sessionId !== null && t.sessionId !== sessionId) return t;
  if (t === EMPTY_TRANSCRIPT) return t;
  return EMPTY_TRANSCRIPT;
}

/** State received from the server on (re)join always replaces local state. */
export function transcriptFromServer(server: TranscriptState): ClientTranscript {
  if (server.status === 'idle') return EMPTY_TRANSCRIPT;
  return { status: server.status, sessionId: server.sessionId, entries: [...server.entries], expiresAt: server.expiresAt };
}

/** True when a stopped transcript's server-side expiry has passed. */
export function isTranscriptExpired(t: ClientTranscript, clockOffsetMs: number, clientNow: number): boolean {
  return t.status === 'stopped' && t.expiresAt !== null && clientNow + clockOffsetMs >= t.expiresAt;
}

// ------------------------------------------------------------------------

export interface ExpiryEnvironment {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Subscribes to "page became active again"; returns an unsubscribe function. */
  onPageActive(fn: () => void): () => void;
}

export const browserExpiryEnvironment: ExpiryEnvironment = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h as number),
  onPageActive: (fn) => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fn();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', fn);
    window.addEventListener('pageshow', fn);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', fn);
      window.removeEventListener('pageshow', fn);
    };
  },
};

/**
 * Local fallback timer. `schedule()` converts the server expiry into the
 * local clock using the server-calibrated offset. Background tabs may delay
 * timers, so the deadline is also re-checked whenever the page becomes
 * active again.
 */
export class TranscriptExpiryTimer {
  private handle: unknown = null;
  private deadline: { localMs: number; sessionId: string } | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly onExpire: (sessionId: string) => void,
    private readonly env: ExpiryEnvironment = browserExpiryEnvironment,
  ) {
    this.unsubscribe = env.onPageActive(() => this.check());
  }

  /** `expiresAt` is server time; `clockOffsetMs` = serverNow - clientNow. */
  schedule(sessionId: string, expiresAt: number, clockOffsetMs: number): void {
    this.cancel();
    this.deadline = { localMs: expiresAt - clockOffsetMs, sessionId };
    this.check();
  }

  cancel(): void {
    if (this.handle !== null) this.env.clearTimeout(this.handle);
    this.handle = null;
    this.deadline = null;
  }

  /** Purges immediately if the deadline has already passed, otherwise (re)arms the timer. */
  check(): void {
    if (!this.deadline) return;
    const remaining = this.deadline.localMs - this.env.now();
    if (remaining <= 0) {
      this.fire();
      return;
    }
    if (this.handle !== null) return;
    this.handle = this.env.setTimeout(() => {
      this.handle = null;
      this.check();
    }, remaining);
  }

  dispose(): void {
    this.cancel();
    this.unsubscribe();
  }

  private fire(): void {
    const d = this.deadline;
    this.cancel();
    if (d) this.onExpire(d.sessionId);
  }
}
