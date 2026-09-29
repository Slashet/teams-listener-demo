import { createHmac } from 'node:crypto';
import type { IceServerConfig } from '../../shared/protocol.js';
import type { AppConfig } from './config.js';

/**
 * Builds the ICE server list handed to joined participants only.
 *
 * With TURN_SHARED_SECRET (coturn `use-auth-secret`) each participant gets
 * time-limited credentials: username = "<expiry>:<id>", password =
 * base64(HMAC-SHA1(secret, username)). Otherwise the static TURN_USERNAME /
 * TURN_PASSWORD pair is used.
 */
export function buildIceServers(ice: AppConfig['ice'], participantId: string, nowMs: number = Date.now()): IceServerConfig[] {
  const servers: IceServerConfig[] = [];
  if (ice.stunUrls.length > 0) servers.push({ urls: ice.stunUrls });

  if (ice.turnUrls.length > 0) {
    if (ice.turnSharedSecret) {
      const expiry = Math.floor(nowMs / 1000) + ice.turnCredentialTtlSeconds;
      const username = `${expiry}:${participantId.slice(0, 8)}`;
      const credential = createHmac('sha1', ice.turnSharedSecret).update(username).digest('base64');
      servers.push({ urls: ice.turnUrls, username, credential });
    } else if (ice.turnUsername && ice.turnPassword) {
      servers.push({ urls: ice.turnUrls, username: ice.turnUsername, credential: ice.turnPassword });
    }
  }
  return servers;
}
