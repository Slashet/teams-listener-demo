import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../../shared/protocol';
import { RecognitionCoordinator, type TranscriberCallbacks, type TranscriberLike } from '../src/meeting/RecognitionCoordinator';
import { transcriptEntryAdded, transcriptStarted } from '../src/meeting/transcriptState';
import type { RecognitionStatus } from '../src/speech/SpeechTranscriber';

/** Fake SpeechTranscriber whose stop() completes only when the test says so. */
class FakeTranscriber implements TranscriberLike {
  started = 0;
  stopCalls = 0;
  muted: boolean | null = null;
  retries = 0;
  stopped = false;
  private finishStop: (() => void) | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(public readonly cb: TranscriberCallbacks) {}

  async start(): Promise<void> {
    this.started++;
    this.cb.onStatus('starting');
    this.cb.onStatus('running');
  }

  stop(): Promise<void> {
    this.stopCalls++;
    this.stopPromise ??= new Promise<void>((resolve) => {
      this.finishStop = () => {
        // Like SpeechTranscriber: cleanup callbacks fire at the very end of stop.
        this.cb.onPartial('');
        this.cb.onStatus('idle');
        this.stopped = true;
        resolve();
      };
    });
    return this.stopPromise;
  }

  /** Completes the pending graceful stop (Azure acknowledged). */
  completeStop(): void {
    this.finishStop?.();
  }

  async retry(): Promise<void> {
    this.retries++;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(opts: { noMic?: boolean } = {}) {
  const instances: FakeTranscriber[] = [];
  const ui = { status: 'idle' as RecognitionStatus, message: null as string | null, partial: '' };
  const sent: { sessionId: string; text: string }[] = [];
  const coordinator = new RecognitionCoordinator({
    createTranscriber: (cb) => {
      if (opts.noMic) return null;
      const t = new FakeTranscriber(cb);
      instances.push(t);
      return t;
    },
    sink: {
      setRecognition: (status, message) => Object.assign(ui, { status, message }),
      setPartial: (text) => (ui.partial = text),
      sendFinal: (sessionId, text) => sent.push({ sessionId, text }),
    },
    unavailableMessage: 'no mic',
  });
  return { coordinator, instances, ui, sent };
}

describe('RecognitionCoordinator (MeetingController recognition lifecycle)', () => {
  it('TEST 1: session B is not created until A has fully stopped; then exactly one B', async () => {
    const { coordinator, instances } = setup();
    await coordinator.start('A');
    const a = instances[0]!;
    expect(a.started).toBe(1);

    void coordinator.stop(); // transcript:stopped — A starts draining
    const startB = coordinator.start('B'); // host immediately starts a new session
    await flush();
    expect(a.stopCalls).toBe(1);
    expect(instances).toHaveLength(1); // B must wait for A

    a.completeStop();
    await startB;
    expect(instances).toHaveLength(2);
    expect(instances[1]!.started).toBe(1);
    expect(a.stopped).toBe(true);

    await flush();
    expect(instances).toHaveLength(2); // exactly one B
  });

  it('TEST 2: a draining A cannot overwrite B recognition status or partial text', async () => {
    const { coordinator, instances, ui } = setup();
    await coordinator.start('A');
    const a = instances[0]!;
    void coordinator.stop();
    const startB = coordinator.start('B');
    await flush();

    // While waiting, A still emits partial text: must not reach the UI.
    a.cb.onPartial('stale partial from A');
    expect(ui.partial).toBe('');

    a.completeStop();
    await startB;
    const b = instances[1]!;
    b.cb.onPartial('B is speaking');
    expect(ui).toMatchObject({ status: 'running', partial: 'B is speaking' });

    // A's late cleanup callbacks (idle / cleared partial) arrive after B runs.
    a.cb.onStatus('idle');
    a.cb.onStatus('error', 'A failed');
    a.cb.onPartial('');
    expect(ui).toMatchObject({ status: 'running', message: null, partial: 'B is speaking' });
  });

  it('TEST 3: leave (dispose) waits until the draining recognizer has cleaned up', async () => {
    const { coordinator, instances } = setup();
    await coordinator.start('A');
    const a = instances[0]!;
    void coordinator.stop(); // A draining

    let left = false;
    const leaving = coordinator.dispose().then(() => (left = true));
    await flush();
    expect(left).toBe(false);

    a.completeStop();
    await leaving;
    expect(left).toBe(true);
    expect(a.stopped).toBe(true);

    // Nothing can start after leave.
    await coordinator.start('C');
    expect(instances).toHaveLength(1);
  });

  it('TEST 4: after a disconnect, the reconnect start waits for the draining recognizer', async () => {
    const { coordinator, instances } = setup();
    await coordinator.start('A');
    const a = instances[0]!;

    void coordinator.stop(); // socket disconnect
    const rejoin = coordinator.start('A'); // reconnect: server says session A still active
    await flush();
    expect(instances).toHaveLength(1);

    a.completeStop();
    await rejoin;
    expect(instances).toHaveLength(2);
    expect(instances[1]!.started).toBe(1);
  });

  it('TEST 5: a late final from draining A is sent with sessionId A and never shows as B locally', async () => {
    const { coordinator, instances, ui, sent } = setup();
    await coordinator.start('A');
    const a = instances[0]!;
    void coordinator.stop();
    const startB = coordinator.start('B');
    await flush();

    a.cb.onFinal('last phrase of A'); // flushed during graceful drain
    expect(sent).toEqual([{ sessionId: 'A', text: 'last phrase of A' }]);
    expect(ui.partial).toBe('');

    a.completeStop();
    await startB;
    instances[1]!.cb.onFinal('first phrase of B');
    expect(sent.at(-1)).toEqual({ sessionId: 'B', text: 'first phrase of B' });

    // Local entries only come from the server broadcast. The server rejects
    // entries whose sessionId is not the current session (STALE_SESSION, see
    // server/test/roomManager.test.ts), so A's late phrase never enters B.
    const currentSession = 'B';
    let local = transcriptStarted('B');
    for (const msg of sent) {
      if (msg.sessionId !== currentSession) continue; // server: STALE_SESSION
      const entry: TranscriptEntry = { id: msg.text, participantId: 'me', displayName: 'Me', text: msg.text, timestamp: 1 };
      local = transcriptEntryAdded(local, entry);
    }
    expect(local.entries.map((e) => e.text)).toEqual(['first phrase of B']);
  });

  it('coalesces repeated stops and does not start a superseded session', async () => {
    const { coordinator, instances, ui } = setup();
    await coordinator.start('A');
    const a = instances[0]!;
    const s1 = coordinator.stop();
    const s2 = coordinator.stop();
    void coordinator.start('B');
    void coordinator.stop(); // B superseded before A finished draining
    await flush();
    a.completeStop();
    await Promise.all([s1, s2]);
    await flush();
    expect(a.stopCalls).toBe(1);
    expect(instances).toHaveLength(1);
    expect(ui.status).toBe('idle');
  });

  it('only the latest of several queued starts creates a transcriber', async () => {
    const { coordinator, instances } = setup();
    await coordinator.start('A');
    void coordinator.start('B');
    const last = coordinator.start('C');
    await flush();
    instances[0]!.completeStop();
    await last;
    expect(instances).toHaveLength(2);
    instances[1]!.cb.onFinal('x');
  });

  it('applies mute state to new transcribers and forwards retry only to the current one', async () => {
    const { coordinator, instances } = setup();
    coordinator.setMuted(true);
    await coordinator.start('A');
    expect(instances[0]!.muted).toBe(true);
    coordinator.retry();
    expect(instances[0]!.retries).toBe(1);
    void coordinator.stop();
    coordinator.retry();
    expect(instances[0]!.retries).toBe(1);
  });

  it('reports a missing microphone without creating a transcriber', async () => {
    const { coordinator, ui } = setup({ noMic: true });
    await coordinator.start('A');
    expect(ui).toMatchObject({ status: 'error', message: 'no mic' });
  });
});
