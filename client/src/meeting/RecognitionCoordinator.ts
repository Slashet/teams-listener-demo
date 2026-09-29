import type { RecognitionStatus } from '../speech/SpeechTranscriber';

/**
 * Serializes the lifecycle of the per-meeting SpeechTranscriber instances.
 *
 * - Every start/stop is a transition on one promise chain, so a new
 *   transcriber is only created after the previous one's `stop()` (graceful
 *   drain included) has resolved. No two instances ever overlap.
 * - Every start/stop bumps a generation number synchronously. Only the
 *   transcriber of the current generation may update local UI state
 *   (recognition status, partial text); a stale, draining instance cannot
 *   overwrite a newer one.
 * - Final results are always forwarded with the sessionId the transcriber was
 *   started for, even while it is draining after a stop. The server decides
 *   whether that session still accepts entries; local transcript entries only
 *   ever come from the server broadcast.
 */

export interface TranscriberLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  retry(): Promise<void>;
  setMuted(muted: boolean): void;
}

export interface TranscriberCallbacks {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onStatus(status: RecognitionStatus, message?: string): void;
}

export interface RecognitionSink {
  setRecognition(status: RecognitionStatus, message: string | null): void;
  setPartial(text: string): void;
  sendFinal(sessionId: string, text: string): void;
}

export interface RecognitionCoordinatorOptions {
  /** Returns null when no microphone is available. */
  createTranscriber(callbacks: TranscriberCallbacks): TranscriberLike | null;
  sink: RecognitionSink;
  unavailableMessage: string;
}

interface Active {
  generation: number;
  transcriber: TranscriberLike;
}

export class RecognitionCoordinator {
  private generation = 0;
  private active: Active | null = null;
  private transitions: Promise<void> = Promise.resolve();
  private muted = false;
  private disposed = false;

  constructor(private readonly opts: RecognitionCoordinatorOptions) {}

  /** Starts recognition for a transcript session once any previous recognizer has fully stopped. */
  start(sessionId: string): Promise<void> {
    if (this.disposed) return this.transitions;
    const generation = ++this.generation;
    return this.enqueue(async () => {
      await this.stopActive();
      // A later start/stop/dispose superseded this request while we waited.
      if (generation !== this.generation || this.disposed) return;

      const isCurrent = () => this.active?.generation === generation && generation === this.generation;
      const transcriber = this.opts.createTranscriber({
        onPartial: (text) => {
          if (isCurrent()) this.opts.sink.setPartial(text);
        },
        onStatus: (status, message) => {
          if (isCurrent()) this.opts.sink.setRecognition(status, message ?? null);
        },
        // Always bound to this transcriber's own session, also while draining.
        onFinal: (text) => this.opts.sink.sendFinal(sessionId, text),
      });
      if (!transcriber) {
        this.opts.sink.setRecognition('error', this.opts.unavailableMessage);
        return;
      }
      this.active = { generation, transcriber };
      transcriber.setMuted(this.muted);
      // Not awaited: a stop issued during start-up must not wait for the token
      // request; SpeechTranscriber.stop() safely handles an in-flight start.
      void transcriber.start();
    });
  }

  /**
   * Stops the current recognizer. UI state is reset immediately; the returned
   * promise resolves once the recognizer has drained and closed. Repeated
   * calls coalesce on the same transition chain.
   */
  stop(): Promise<void> {
    this.generation++;
    this.opts.sink.setPartial('');
    this.opts.sink.setRecognition('idle', null);
    return this.enqueue(() => this.stopActive());
  }

  /** Final shutdown (leave / fatal join error). Resolves after cleanup. */
  dispose(): Promise<void> {
    this.disposed = true;
    return this.stop();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.active?.transcriber.setMuted(muted);
  }

  retry(): void {
    const a = this.active;
    if (a && a.generation === this.generation) void a.transcriber.retry();
  }

  private async stopActive(): Promise<void> {
    const a = this.active;
    this.active = null;
    if (a) await a.transcriber.stop();
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    const next = this.transitions.then(step, step);
    this.transitions = next.catch(() => undefined);
    return this.transitions;
  }
}
