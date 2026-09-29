export interface LocalMediaResult {
  stream: MediaStream;
  /** Non-fatal notice, e.g. camera missing but microphone available. */
  notice: string | null;
}

export class MediaAccessError extends Error {
  constructor(
    message: string,
    public readonly kind: 'denied' | 'unavailable' | 'insecure',
  ) {
    super(message);
    this.name = 'MediaAccessError';
  }
}

const VIDEO: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } };
const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

function errName(err: unknown): string {
  return err instanceof DOMException || err instanceof Error ? err.name : '';
}

/**
 * Requests camera + microphone, degrading to whichever device is available.
 * Permission denial is reported as an error so the UI can explain how to fix it.
 */
export async function getLocalMedia(): Promise<LocalMediaResult> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new MediaAccessError('Camera and microphone access requires HTTPS (or localhost).', 'insecure');
  }
  try {
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: VIDEO }), notice: null };
  } catch (err) {
    if (isDenied(err)) throw deniedError();
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
    return { stream, notice: 'No camera is available. You joined with microphone only.' };
  } catch (err) {
    if (isDenied(err)) throw deniedError();
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO });
    return { stream, notice: 'No microphone is available. Others cannot hear you and live transcript will not capture you.' };
  } catch (err) {
    if (isDenied(err)) throw deniedError();
  }
  throw new MediaAccessError('No camera or microphone could be opened. Check that they are connected and not used by another app.', 'unavailable');
}

function isDenied(err: unknown): boolean {
  const n = errName(err);
  return n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError';
}

function deniedError(): MediaAccessError {
  return new MediaAccessError(
    'Camera/microphone permission was denied. Allow access for this site in your browser settings (the camera icon in the address bar), then try again.',
    'denied',
  );
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}
