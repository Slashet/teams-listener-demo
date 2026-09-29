import type { TranscriptEntry } from '../../../shared/protocol.js';

/** Returns the zone if the runtime recognises it, otherwise UTC. */
export function safeTimeZone(zone: string | undefined): string {
  if (!zone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/**
 * Builds the plain-text transcript on demand from in-memory entries.
 * Never written to disk.
 */
export function formatTranscriptTxt(entries: readonly TranscriptEntry[], opts: { timeZone?: string; now?: number } = {}): string {
  const timeZone = safeTimeZone(opts.timeZone);
  const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'long', year: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  const first = entries[0];
  const headerDate = dateFmt.format(new Date(first ? first.timestamp : (opts.now ?? Date.now())));
  const lines = ['Teams Listener Meeting Transcript', headerDate, ''];
  for (const e of entries) {
    lines.push(`${timeFmt.format(new Date(e.timestamp))} - ${e.displayName}`);
    lines.push(e.text);
    lines.push('');
  }
  return lines.join('\n');
}

/** Filename safe on all major OSes: `[a-z0-9-]` only. */
export function transcriptFilename(roomId: string, timestamp: number): string {
  const iso = new Date(timestamp).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const safeRoom = roomId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32) || 'meeting';
  return `transcript-${safeRoom}-${iso}.txt`.replace(/[^a-z0-9.-]/g, '');
}
