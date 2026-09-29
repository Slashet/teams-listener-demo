import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechTokenResponse } from '../../shared/protocol';
import { SpeechTranscriber, type RecognizerLike, type SpeechSdkLike } from '../src/speech/SpeechTranscriber';

const RECOGNIZED = 3;
const ERROR = 1;
const AUTH_FAILURE = 1;

/** Fake Azure recognizer whose start/stop completion is controlled by the test. */
class FakeRecognizer implements RecognizerLike {
  authorizationToken = '';
  recognizing?: RecognizerLike['recognizing'];
  recognized?: RecognizerLike['recognized'];
  canceled?: RecognizerLike['canceled'];
  closed = false;
  stopCalls = 0;
  private stopCb: (() => void) | null = null;
  /** Called synchronously inside stopContinuousRecognitionAsync (simulates Azure's flush). */
  onStop: ((r: FakeRecognizer) => void) | null = null;
  autoCompleteStop = true;

  constructor(public readonly initialToken: string) {
    this.authorizationToken = initialToken;
  }

  startContinuousRecognitionAsync(cb?: () => void): void {
    queueMicrotask(() => cb?.());
  }

  stopContinuousRecognitionAsync(cb?: () => void): void {
    this.stopCalls++;
    this.stopCb = cb ?? null;
    this.onStop?.(this);
    if (this.autoCompleteStop) this.completeStop();
  }

  completeStop(): void {
    const cb = this.stopCb;
    this.stopCb = null;
    queueMicrotask(() => cb?.());
  }

  close(): void {
    this.closed = true;
  }

  emitFinal(text: string): void {
    this.recognized?.(null, { result: { reason: RECOGNIZED, text } });
  }

  emitPartial(text: string): void {
    this.recognizing?.(null, { result: { text } });
  }

  emitError(errorCode = 4): void {
    this.canceled?.(null, { reason: ERROR, errorCode });
  }
}

function fakeTrack(): MediaStreamTrack {
  const clones: { enabled: boolean; stopped: boolean }[] = [];
  const make = (): MediaStreamTrack =>
    ({
      enabled: true,
      clone() {
        const c = { enabled: true, stopped: false, stop() { this.stopped = true; } };
        clones.push(c);
        return c as unknown as MediaStreamTrack;
      },
      stop() {},
      clones,
    }) as unknown as MediaStreamTrack;
  return make();
}

function setup(opts: { tokenDelay?: Promise<void> } = {}) {
  const recognizers: FakeRecognizer[] = [];
  let tokenCount = 0;
  const sdk: SpeechSdkLike = {
    SpeechConfig: { fromAuthorizationToken: (token) => ({ speechRecognitionLanguage: '', token }) },
    AudioConfig: { fromStreamInput: () => ({}) },
    SpeechRecognizer: function (speechConfig: { token: string }) {
      const r = new FakeRecognizer(speechConfig.token);
      recognizers.push(r);
      return r;
    } as unknown as SpeechSdkLike['SpeechRecognizer'],
    ResultReason: { RecognizedSpeech: RECOGNIZED },
    CancellationReason: { Error: ERROR },
    CancellationErrorCode: { AuthenticationFailure: AUTH_FAILURE, 4: 'ConnectionFailure' },
  };
  const getToken = vi.fn(async (): Promise<SpeechTokenResponse> => {
    if (opts.tokenDelay) await opts.tokenDelay;
    tokenCount++;
    return { token: `token-${tokenCount}`, region: 'westeurope', language: 'tr-TR', refreshAfterSeconds: 180 };
  });
  const finals: string[] = [];
  const partials: string[] = [];
  const statuses: string[] = [];
  const track = fakeTrack();
  const transcriber = new SpeechTranscriber({
    audioTrack: track,
    getToken,
    onFinal: (t) => finals.push(t),
    onPartial: (t) => partials.push(t),
    onStatus: (s) => statuses.push(s),
    loadSdk: async () => sdk,
    createStream: () => ({}) as MediaStream,
  });
  const clones = (track as unknown as { clones: { stopped: boolean; enabled: boolean }[] }).clones;
  return { transcriber, recognizers, getToken, finals, partials, statuses, clones };
}

describe('SpeechTranscriber', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts one recognizer with a backend token and reports running', async () => {
    const { transcriber, recognizers, statuses, finals, partials } = setup();
    await transcriber.start();
    expect(recognizers).toHaveLength(1);
    expect(recognizers[0]!.initialToken).toBe('token-1');
    expect(statuses).toEqual(['starting', 'running']);

    recognizers[0]!.emitPartial('merha');
    recognizers[0]!.emitFinal('Merhaba dünya');
    expect(partials).toContain('merha');
    expect(finals).toEqual(['Merhaba dünya']);

    await transcriber.start(); // idempotent
    expect(recognizers).toHaveLength(1);
  });

  it('delivers a final result emitted while Azure is stopping (graceful stop)', async () => {
    const { transcriber, recognizers, finals, statuses } = setup();
    await transcriber.start();
    const r = recognizers[0]!;
    // Azure flushes the last phrase from inside the stop call, before the stop callback.
    r.onStop = (rec) => rec.emitFinal('Son cümle kaybolmamalı.');
    await transcriber.stop();
    expect(finals).toEqual(['Son cümle kaybolmamalı.']);
    expect(statuses.at(-1)).toBe('idle');
  });

  it('delivers a final result that arrives after stop() was called but before the stop callback', async () => {
    const { transcriber, recognizers, finals, partials } = setup();
    await transcriber.start();
    const r = recognizers[0]!;
    r.autoCompleteStop = false;
    const stopping = transcriber.stop();
    await Promise.resolve();

    r.emitPartial('ignored partial');
    r.emitFinal('late final');
    expect(finals).toEqual(['late final']);
    expect(partials).not.toContain('ignored partial');

    r.completeStop();
    await stopping;
  });

  it('ignores callbacks from the recognizer after stop completes and cleans up', async () => {
    const { transcriber, recognizers, finals, clones } = setup();
    await transcriber.start();
    const r = recognizers[0]!;
    const recognized = r.recognized;
    await transcriber.stop();

    expect(r.closed).toBe(true);
    expect(clones[0]!.stopped).toBe(true);
    expect(r.recognized).toBeUndefined();
    // Even a retained handler reference is inert after close.
    recognized?.(null, { result: { reason: RECOGNIZED, text: 'too late' } });
    expect(finals).toEqual([]);
  });

  it('stop is idempotent', async () => {
    const { transcriber, recognizers, statuses } = setup();
    await transcriber.start();
    const a = transcriber.stop();
    const b = transcriber.stop();
    expect(a).toBe(b);
    await a;
    await transcriber.stop();
    expect(recognizers[0]!.stopCalls).toBe(1);
    expect(statuses.filter((s) => s === 'idle')).toHaveLength(1);
  });

  it('does not create a recognizer if stopped while the token request is pending', async () => {
    let release!: () => void;
    const tokenDelay = new Promise<void>((r) => (release = r));
    const { transcriber, recognizers } = setup({ tokenDelay });
    const starting = transcriber.start();
    await Promise.resolve();
    await transcriber.stop();
    release();
    await starting;
    expect(recognizers).toHaveLength(0);
    await transcriber.start(); // single-use: cannot restart after stop
    expect(recognizers).toHaveLength(0);
  });

  it('refreshes the authorization token on schedule', async () => {
    const { transcriber, recognizers, getToken } = setup();
    await transcriber.start();
    expect(getToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(recognizers[0]!.authorizationToken).toBe('token-2');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(recognizers[0]!.authorizationToken).toBe('token-3');
    await transcriber.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(getToken).toHaveBeenCalledTimes(3);
  });

  it('retries automatically after a recognition error', async () => {
    const { transcriber, recognizers, statuses } = setup();
    await transcriber.start();
    recognizers[0]!.emitError();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recognizers).toHaveLength(2);
    expect(recognizers[0]!.closed).toBe(true);
    expect(statuses.at(-1)).toBe('running');
    await transcriber.stop();
  });

  it('a pending retry does not resurrect a stopped transcriber', async () => {
    const { transcriber, recognizers, getToken } = setup();
    await transcriber.start();
    recognizers[0]!.emitError(); // schedules retry in 1 s
    await transcriber.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recognizers).toHaveLength(1);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('manual retry is a no-op after stop', async () => {
    const { transcriber, recognizers } = setup();
    await transcriber.start();
    await transcriber.stop();
    await transcriber.retry();
    expect(recognizers).toHaveLength(1);
  });

  it('reports an error after exhausting automatic retries', async () => {
    const { transcriber, recognizers, statuses } = setup();
    await transcriber.start();
    for (let i = 0; i < 4; i++) {
      recognizers.at(-1)!.emitError();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(recognizers).toHaveLength(4);
    expect(statuses.at(-1)).toBe('error');
    await transcriber.stop();
  });

  it('mirrors mute onto the private track clone', async () => {
    const { transcriber, clones } = setup();
    transcriber.setMuted(true);
    await transcriber.start();
    expect(clones[0]!.enabled).toBe(false);
    transcriber.setMuted(false);
    expect(clones[0]!.enabled).toBe(true);
    await transcriber.stop();
  });
});
