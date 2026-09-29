import type { CreateRoomResponse, SpeechTokenResponse } from '../../../shared/protocol';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // fall through
  }
  return `Request failed (${res.status})`;
}

export async function createRoom(): Promise<CreateRoomResponse> {
  const res = await fetch('/api/rooms', { method: 'POST', cache: 'no-store' });
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return (await res.json()) as CreateRoomResponse;
}

/** Fetches a short-lived Azure Speech token; the subscription key stays on the server. */
export async function fetchSpeechToken(participantToken: string): Promise<SpeechTokenResponse> {
  const res = await fetch('/api/speech/token', {
    headers: { Authorization: `Bearer ${participantToken}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return (await res.json()) as SpeechTokenResponse;
}
