import { useSyncExternalStore } from 'react';

/** Tiny history-based router: only "/" and "/room/:id" exist. */
export type Route = { name: 'landing' } | { name: 'room'; roomId: string } | { name: 'notFound' };

export interface NavState {
  displayName?: string;
  hostKey?: string;
}

// Handoff data (e.g. the one-time host key) lives in memory only — never in storage or the URL.
let pendingNavState: NavState | null = null;

export function parseRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { name: 'landing' };
  const m = /^\/room\/([^/]+)\/?$/.exec(pathname);
  if (m?.[1]) return { name: 'room', roomId: decodeURIComponent(m[1]) };
  return { name: 'notFound' };
}

const listeners = new Set<() => void>();
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function navigate(path: string, state?: NavState): void {
  pendingNavState = state ?? null;
  window.history.pushState(null, '', path);
  listeners.forEach((l) => l());
}

/** Returns and clears handoff state set by the previous `navigate` call. */
export function consumeNavState(): NavState | null {
  const s = pendingNavState;
  pendingNavState = null;
  return s;
}

export function useRoute(): Route {
  const path = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => window.location.pathname,
  );
  return parseRoute(path);
}

export const ROOM_ID_PATTERN = /^[a-f0-9]{16}$/;

/** Accepts a bare room ID or a full invite link. */
export function extractRoomId(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = /\/room\/([a-f0-9]{16})\b/i.exec(trimmed)?.[1];
  const candidate = (fromUrl ?? trimmed).toLowerCase();
  return ROOM_ID_PATTERN.test(candidate) ? candidate : null;
}
