/**
 * Small token bucket used to throttle Socket.IO events per connection.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(cost = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSecond);
    this.last = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export type EventCategory = 'join' | 'signal' | 'media' | 'control' | 'transcript' | 'download';

const LIMITS: Record<EventCategory, { capacity: number; perSecond: number }> = {
  join: { capacity: 5, perSecond: 0.2 },
  // ICE candidate bursts during negotiation with up to 3 peers.
  signal: { capacity: 300, perSecond: 30 },
  media: { capacity: 20, perSecond: 2 },
  control: { capacity: 6, perSecond: 0.5 },
  transcript: { capacity: 30, perSecond: 3 },
  download: { capacity: 5, perSecond: 0.5 },
};

export function createSocketLimiter(now: () => number = Date.now): (category: EventCategory) => boolean {
  const buckets = new Map<EventCategory, TokenBucket>();
  return (category) => {
    let bucket = buckets.get(category);
    if (!bucket) {
      const l = LIMITS[category];
      bucket = new TokenBucket(l.capacity, l.perSecond, now);
      buckets.set(category, bucket);
    }
    return bucket.take();
  };
}
