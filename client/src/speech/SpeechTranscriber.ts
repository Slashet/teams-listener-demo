import type { SpeechTokenResponse } from '../../../shared/protocol';

/**
 * Runs Azure continuous speech recognition on THIS participant's microphone
 * only. Speaker identity is therefore known without diarization: every
 * result belongs to the local user.
 *
 * Auth: the browser only ever receives a short-lived authorization token from
 * our backend. It is refreshed on a timer and pushed into the live recognizer
 * (`recognizer.authorizationToken = ...`), so long sessions do not fail when
 * a token expires.
 *
 * Lifecycle: an instance is single-use (`start()` once, `stop()` once or
 * more). Each underlying recognizer lives in a `RecognizerSession` whose phase
 * moves strictly forward:
 *
 *   live      → partial + final results and errors are handled
 *   draining  → stopContinuousRecognitionAsync() is in progress; only FINAL
 *               results are still delivered (Azure flushes the last phrase here)
 *   closed    → the stop callback has fired; every callback is ignored
 *
 * At most one recognizer exists per instance: a replacement (automatic or
 * manual retry) is only created after every previous session has fully
 * closed, and `stop()` resolves only once all sessions are closed.
 */

/** The subset of the Azure Speech SDK used here (lets tests supply a fake). */
export interface RecognizerLike {
  authorizationToken: string;
  recognizing?: (sender: unknown, e: { result: { text: string } }) => void;
  recognized?: (sender: unknown, e: { result: { reason: number; text: string } }) => void;
  canceled?: (sender: unknown, e: { reason: number; errorCode: number }) => void;
  startContinuousRecognitionAsync(cb?: () => void, err?: (e: string) => void): void;
  stopContinuousRecognitionAsync(cb?: () => void, err?: (e: string) => void): void;
  close(): void;
}

export interface SpeechSdkLike {
  SpeechConfig: { fromAuthorizationToken(token: string, region: string): { speechRecognitionLanguage: string } };
  AudioConfig: { fromStreamInput(stream: MediaStream): unknown };
  SpeechRecognizer: new (speechConfig: never, audioConfig: never) => RecognizerLike;
  ResultReason: { RecognizedSpeech: number };
  CancellationReason: { Error: number };
  CancellationErrorCode: { AuthenticationFailure: number; [code: number]: string };
}

export type RecognitionStatus = 'idle' | 'starting' | 'running' | 'error';

export interface SpeechTranscriberOptions {
  audioTrack: MediaStreamTrack;
  getToken(): Promise<SpeechTokenResponse>;
  onPartial(text: string): void;
  onFinal(text: string): void;
  onStatus(status: RecognitionStatus, message?: string): void;
  /** Defaults to a lazy import of the (large) Azure Speech SDK. */
  loadSdk?: () => Promise<SpeechSdkLike>;
  /** Defaults to `new MediaStream([track])`. */
  createStream?: (track: MediaStreamTrack) => MediaStream;
}

interface RecognizerSession {
  recognizer: RecognizerLike;
  /** Private clone so the SDK may stop it on release without affecting the call. */
  track: MediaStreamTrack;
  phase: 'live' | 'draining' | 'closed';
  closing: Promise<void> | null;
}

const MAX_AUTO_RETRIES = 3;
/**
 * Upper bound for waiting on the SDK's stop callback. Normally the callback
 * fires as soon as Azure has flushed the final result; this only prevents a
 * broken connection from blocking leave/restart forever.
 */
const STOP_CALLBACK_GUARD_MS = 5_000;

const defaultLoadSdk = async (): Promise<SpeechSdkLike> =>
  (await import('microsoft-cognitiveservices-speech-sdk')) as unknown as SpeechSdkLike;

export class SpeechTranscriber {
  private state: 'new' | 'active' | 'stopping' | 'stopped' = 'new';
  private session: RecognizerSession | null = null;
  private sdk: SpeechSdkLike | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  /** Incremented per start attempt and on stop: invalidates in-flight starts. */
  private attempt = 0;
  private muted: boolean;
  private stopPromise: Promise<void> | null = null;
  /** Sessions still draining/closing; a new recognizer waits for all of them. */
  private readonly closings = new Set<Promise<void>>();

  constructor(private readonly opts: SpeechTranscriberOptions) {
    this.muted = !opts.audioTrack.enabled;
  }

  async start(): Promise<void> {
    if (this.state !== 'new') return;
    this.state = 'active';
    await this.startRecognizer();
  }

  /**
   * Gracefully stops recognition. Final results Azure emits while stopping
   * are still delivered; once this resolves nothing more is emitted.
   * Idempotent: repeated calls return the same promise.
   */
  stop(): Promise<void> {
    this.stopPromise ??= this.doStop();
    return this.stopPromise;
  }

  /** Mirrors the meeting mute state: muted audio is silence, so nothing is recognized. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.session) this.session.track.enabled = !muted;
  }

  /** Manual retry after a failure. No-op once stopping. */
  async retry(): Promise<void> {
    if (this.state !== 'active') return;
    this.retries = 0;
    this.clearTimers();
    await this.closeSession(this.session);
    if (this.state === 'active') await this.startRecognizer();
  }

  // ------------------------------------------------------------------ private

  private async doStop(): Promise<void> {
    // From here on no retry, refresh or new recognizer can start.
    this.state = 'stopping';
    this.attempt++;
    this.clearTimers();
    await this.closeSession(this.session);
    await this.allClosed(); // includes sessions closing after an earlier failure
    this.state = 'stopped';
    this.opts.onPartial('');
    this.opts.onStatus('idle');
  }

  private async startRecognizer(): Promise<void> {
    const attempt = ++this.attempt;
    const current = () => attempt === this.attempt && this.state === 'active';
    this.opts.onStatus('starting');
    try {
      // Never overlap recognizers: wait until any previous one has fully closed.
      await this.allClosed();
      if (!current()) return;
      this.sdk ??= await (this.opts.loadSdk ?? defaultLoadSdk)();
      const sdk = this.sdk;
      const auth = await this.opts.getToken();
      if (!current()) return;

      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(auth.token, auth.region);
      speechConfig.speechRecognitionLanguage = auth.language;

      const track = this.opts.audioTrack.clone();
      track.enabled = !this.muted;
      const stream = (this.opts.createStream ?? ((t) => new MediaStream([t])))(track);
      const audioConfig = sdk.AudioConfig.fromStreamInput(stream);
      const recognizer = new sdk.SpeechRecognizer(speechConfig as never, audioConfig as never);
      const session: RecognizerSession = { recognizer, track, phase: 'live', closing: null };
      this.session = session;

      recognizer.recognizing = (_s, e) => {
        if (session.phase === 'live') this.opts.onPartial(e.result.text);
      };
      recognizer.recognized = (_s, e) => {
        // Delivered while live AND while draining (graceful stop flush).
        if (session.phase === 'closed' || e.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
        const text = e.result.text.trim();
        this.opts.onPartial('');
        if (text) this.opts.onFinal(text);
        this.retries = 0;
      };
      recognizer.canceled = (_s, e) => {
        if (session.phase !== 'live' || this.session !== session || this.state !== 'active') return;
        if (e.reason === sdk.CancellationReason.Error) {
          // errorDetails may contain service internals; only the code is surfaced.
          console.warn('[speech] recognition canceled', sdk.CancellationErrorCode[e.errorCode]);
          this.handleFailure(session, e.errorCode === sdk.CancellationErrorCode.AuthenticationFailure ? 'auth' : 'service');
        }
      };

      await new Promise<void>((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(resolve, () => reject(new Error('start failed')));
      });
      if (!current() || this.session !== session) return;
      this.opts.onStatus('running');
      this.scheduleRefresh(auth.refreshAfterSeconds);
    } catch (err) {
      if (!current()) return;
      console.warn('[speech] failed to start', err instanceof Error ? err.name : err);
      this.handleFailure(this.session, 'start');
    }
  }

  private scheduleRefresh(seconds: number): void {
    if (this.state !== 'active') return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delayMs = Math.max(30, seconds) * 1000;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshToken();
    }, delayMs);
  }

  private async refreshToken(): Promise<void> {
    const session = this.session;
    if (this.state !== 'active' || !session || session.phase !== 'live') return;
    try {
      const auth = await this.opts.getToken();
      if (this.state !== 'active' || this.session !== session || session.phase !== 'live') return;
      session.recognizer.authorizationToken = auth.token;
      this.scheduleRefresh(auth.refreshAfterSeconds);
    } catch {
      // Try again soon; the current token is still valid for several minutes.
      this.scheduleRefresh(30);
    }
  }

  private handleFailure(session: RecognizerSession | null, kind: 'auth' | 'service' | 'start'): void {
    // Draining starts now and runs concurrently with the backoff delay; the
    // retry's startRecognizer() waits for it before creating a new recognizer.
    void this.closeSession(session);
    if (this.state !== 'active') return;
    if (this.retries < MAX_AUTO_RETRIES) {
      this.retries++;
      const delay = 1_000 * 2 ** (this.retries - 1);
      this.opts.onStatus('starting');
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.state === 'active') void this.startRecognizer();
      }, delay);
      return;
    }
    const message =
      kind === 'auth'
        ? 'Speech service rejected the authorization. Your call continues without transcription for your microphone.'
        : 'Live transcription failed for your microphone. Your call continues; other participants are unaffected.';
    this.opts.onStatus('error', message);
  }

  private clearTimers(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.refreshTimer = null;
    this.retryTimer = null;
  }

  private async allClosed(): Promise<void> {
    while (this.closings.size > 0) await Promise.all([...this.closings]);
  }

  /** Drains then closes a recognizer session. Safe to call repeatedly. */
  private closeSession(session: RecognizerSession | null): Promise<void> {
    if (!session) return Promise.resolve();
    if (this.session === session) this.session = null;
    session.closing ??= (async () => {
      session.phase = 'draining';
      await new Promise<void>((resolve) => {
        const guard = setTimeout(resolve, STOP_CALLBACK_GUARD_MS);
        const done = () => {
          clearTimeout(guard);
          resolve();
        };
        try {
          session.recognizer.stopContinuousRecognitionAsync(done, done);
        } catch {
          done();
        }
      });
      session.phase = 'closed';
      const r = session.recognizer;
      r.recognizing = undefined;
      r.recognized = undefined;
      r.canceled = undefined;
      try {
        r.close();
      } catch {
        // already closed
      }
      try {
        session.track.stop();
      } catch {
        // already stopped
      }
    })();
    const closing = session.closing;
    this.closings.add(closing);
    void closing.finally(() => this.closings.delete(closing));
    return closing;
  }
}
