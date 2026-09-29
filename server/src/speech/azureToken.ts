/**
 * Exchanges the Azure Speech subscription key (server-side only) for a
 * short-lived authorization token that browsers may use.
 *
 * Azure tokens are valid for 10 minutes. One token is cached and shared for
 * up to `maxTokenAgeMs` so every browser receives a token with at least
 * `10 min - maxTokenAgeMs` of remaining lifetime; clients refresh well before.
 */

export const AZURE_TOKEN_LIFETIME_MS = 10 * 60_000;

export class SpeechNotConfiguredError extends Error {
  override name = 'SpeechNotConfiguredError';
}

export class SpeechTokenError extends Error {
  override name = 'SpeechTokenError';
  constructor(public readonly status: number | null) {
    // Intentionally generic: Azure responses are never forwarded.
    super('Failed to obtain Azure Speech token');
  }
}

export interface SpeechTokenServiceOptions {
  key: string | undefined;
  region: string | undefined;
  language: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxTokenAgeMs?: number;
  timeoutMs?: number;
}

export interface IssuedSpeechToken {
  token: string;
  region: string;
  language: string;
  refreshAfterSeconds: number;
}

export class SpeechTokenService {
  private cached: { token: string; fetchedAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxTokenAgeMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: SpeechTokenServiceOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.maxTokenAgeMs = opts.maxTokenAgeMs ?? 4 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get configured(): boolean {
    return Boolean(this.opts.key && this.opts.region);
  }

  async issue(): Promise<IssuedSpeechToken> {
    const { key, region, language } = this.opts;
    if (!key || !region) throw new SpeechNotConfiguredError('Azure Speech is not configured');

    const now = this.now();
    let token: string;
    if (this.cached && now - this.cached.fetchedAt < this.maxTokenAgeMs) {
      token = this.cached.token;
    } else {
      this.inflight ??= this.fetchToken(key, region).finally(() => {
        this.inflight = null;
      });
      token = await this.inflight;
    }
    // Remaining lifetime is at least (10 - maxAge) minutes; ask the client to
    // refresh after half of that so there is ample margin.
    const refreshAfterSeconds = Math.floor((AZURE_TOKEN_LIFETIME_MS - this.maxTokenAgeMs) / 2 / 1000);
    return { token, region, language, refreshAfterSeconds };
  }

  private async fetchToken(key: string, region: string): Promise<string> {
    const url = `https://${encodeURIComponent(region)}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SpeechTokenError(null);
    }
    if (!res.ok) throw new SpeechTokenError(res.status);
    const token = (await res.text()).trim();
    if (!token) throw new SpeechTokenError(res.status);
    this.cached = { token, fetchedAt: this.now() };
    return token;
  }
}
