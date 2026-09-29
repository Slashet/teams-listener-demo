import type { IncomingMessage } from 'node:http';

/**
 * Client IP for a raw Node request, honouring `trustProxy` hops the same way
 * Express does (take the address `trustProxy` entries from the right of
 * X-Forwarded-For). Used for Socket.IO handshakes, which bypass Express.
 */
export function clientIp(req: IncomingMessage, trustProxy: number): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (trustProxy <= 0) return remote;
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const chain = [...raw.split(',').map((s) => s.trim()).filter(Boolean), remote];
  return chain[Math.max(0, chain.length - 1 - trustProxy)] ?? remote;
}
