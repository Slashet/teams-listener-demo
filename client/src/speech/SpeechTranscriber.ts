import type * as SpeechSdkTypes from 'microsoft-cognitiveservices-speech-sdk';
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
 */

// The SDK is large, so it is loaded lazily when transcription first starts.
type SpeechSdk = typeof SpeechSdkTypes;

export type RecognitionStatus = 'idle' | 'starting' | 'running' | 'error';

export interface SpeechTranscriberOptions {
  audioTrack: MediaStreamTrack;
  getToken(): Promise<SpeechTokenResponse>;
  onPartial(text: string): void;
  onFinal(text: string): void;
  onStatus(status: RecognitionStatus, message?: string): void;
}

const MAX_AUTO_RETRIES = 3;

export class SpeechTranscriber {
  private sdk: SpeechSdk | null = null;
  private recognizer: SpeechSdkTypes.SpeechRecognizer | null = null;
  /** Private clone so the SDK may stop it on release without affecting the call. */
  private track: MediaStreamTrack | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private active = false;
  private generation = 0;

  constructor(private readonly opts: SpeechTranscriberOptions) {}

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.retries = 0;
    await this.startRecognizer();
  }

  /** Stops recognition; any in-flight final result is still delivered. */
  async stop(): Promise<void> {
    this.active = false;
    this.generation++;
    this.clearTimers();
    await this.teardownRecognizer();
    this.opts.onPartial('');
    this.opts.onStatus('idle');
  }

  /** Mirrors the meeting mute state: muted audio is silence, so nothing is recognized. */
  setMuted(muted: boolean): void {
    if (this.track) this.track.enabled = !muted;
  }

  /** Manual retry after a failure. */
  async retry(): Promise<void> {
    if (!this.active) return;
    this.retries = 0;
    this.clearTimers();
    await this.teardownRecognizer();
    await this.startRecognizer();
  }

  // ------------------------------------------------------------------ private

  private async startRecognizer(): Promise<void> {
    const gen = ++this.generation;
    this.opts.onStatus('starting');
    try {
      this.sdk ??= await import('microsoft-cognitiveservices-speech-sdk');
      const sdk = this.sdk;
      const auth = await this.opts.getToken();
      if (gen !== this.generation || !this.active) return;

      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(auth.token, auth.region);
      speechConfig.speechRecognitionLanguage = auth.language;
      speechConfig.outputFormat = sdk.OutputFormat.Simple;

      const source = this.opts.audioTrack;
      this.track = source.clone();
      this.track.enabled = source.enabled;
      const audioConfig = sdk.AudioConfig.fromStreamInput(new MediaStream([this.track]));
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      this.recognizer = recognizer;

      recognizer.recognizing = (_s, e) => {
        if (gen === this.generation) this.opts.onPartial(e.result.text);
      };
      recognizer.recognized = (_s, e) => {
        if (e.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
        const text = e.result.text.trim();
        this.opts.onPartial('');
        if (text) this.opts.onFinal(text);
        this.retries = 0;
      };
      recognizer.canceled = (_s, e) => {
        if (gen !== this.generation || !this.active) return;
        if (e.reason === sdk.CancellationReason.Error) {
          // errorDetails may contain service internals; only the code is surfaced.
          console.warn('[speech] recognition canceled', sdk.CancellationErrorCode[e.errorCode]);
          this.handleFailure(e.errorCode === sdk.CancellationErrorCode.AuthenticationFailure ? 'auth' : 'service');
        }
      };

      await new Promise<void>((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(resolve, () => reject(new Error('start failed')));
      });
      if (gen !== this.generation || !this.active) return;
      this.opts.onStatus('running');
      this.scheduleRefresh(auth.refreshAfterSeconds);
    } catch (err) {
      if (gen !== this.generation || !this.active) return;
      console.warn('[speech] failed to start', err instanceof Error ? err.name : err);
      this.handleFailure('start');
    }
  }

  private scheduleRefresh(seconds: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delayMs = Math.max(30, seconds) * 1000;
    this.refreshTimer = setTimeout(() => void this.refreshToken(), delayMs);
  }

  private async refreshToken(): Promise<void> {
    if (!this.active || !this.recognizer) return;
    try {
      const auth = await this.opts.getToken();
      if (!this.active || !this.recognizer) return;
      this.recognizer.authorizationToken = auth.token;
      this.scheduleRefresh(auth.refreshAfterSeconds);
    } catch {
      // Try again soon; the current token is still valid for several minutes.
      this.scheduleRefresh(30);
    }
  }

  private handleFailure(kind: 'auth' | 'service' | 'start'): void {
    void this.teardownRecognizer();
    if (!this.active) return;
    if (this.retries < MAX_AUTO_RETRIES) {
      this.retries++;
      const delay = 1_000 * 2 ** (this.retries - 1);
      this.opts.onStatus('starting');
      this.retryTimer = setTimeout(() => void this.startRecognizer(), delay);
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

  private async teardownRecognizer(): Promise<void> {
    const recognizer = this.recognizer;
    const track = this.track;
    this.recognizer = null;
    this.track = null;
    if (recognizer) {
      await new Promise<void>((resolve) => {
        recognizer.stopContinuousRecognitionAsync(
          () => resolve(),
          () => resolve(),
        );
      });
      try {
        recognizer.close();
      } catch {
        // already closed
      }
    }
    track?.stop();
  }
}
