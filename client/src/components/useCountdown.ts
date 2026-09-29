import { useEffect, useState } from 'react';

/**
 * Seconds remaining until a server-provided expiry. `clockOffsetMs`
 * (serverNow - clientNow) corrects for client clock skew so every
 * participant sees the same countdown. Mount it only while counting.
 */
export function useCountdown(expiresAt: number, clockOffsetMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  return Math.max(0, Math.ceil((expiresAt - (now + clockOffsetMs)) / 1000));
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
