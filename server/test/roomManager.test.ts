import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomManager } from '../src/rooms/RoomManager.js';

const media = { audioEnabled: true, videoEnabled: true };

function setup(opts: ConstructorParameters<typeof RoomManager>[0] = {}) {
  const onTranscriptDeleted = vi.fn();
  const rooms = new RoomManager({ onTranscriptDeleted, ...opts });
  const created = rooms.createRoom();
  if (!created.ok) throw new Error('room creation failed');
  const { roomId, hostKey } = created;
  const join = (socketId: string, displayName = socketId, key?: string) => rooms.join({ roomId, socketId, displayName, hostKey: key, media });
  return { rooms, roomId, hostKey, join, onTranscriptDeleted };
}

function joined(res: ReturnType<RoomManager['join']>) {
  if (!res.ok) throw new Error(`join failed: ${res.code}`);
  return res;
}

describe('RoomManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T14:05:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('room creation', () => {
    it('generates non-sequential 16-hex-char room IDs', () => {
      const rooms = new RoomManager();
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const r = rooms.createRoom();
        if (!r.ok) throw new Error();
        expect(r.roomId).toMatch(/^[a-f0-9]{16}$/);
        ids.add(r.roomId);
      }
      expect(ids.size).toBe(50);
      rooms.dispose();
    });

    it('rejects joining a room that does not exist', () => {
      const rooms = new RoomManager();
      const res = rooms.join({ roomId: 'ffffffffffffffff', socketId: 's1', displayName: 'A', media });
      expect(res).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' });
    });

    it('discards a created room nobody joins', () => {
      const { rooms, roomId } = setup({ pendingRoomTtlMs: 60_000 });
      expect(rooms.hasRoom(roomId)).toBe(true);
      vi.advanceTimersByTime(60_000);
      expect(rooms.hasRoom(roomId)).toBe(false);
    });
  });

  describe('capacity', () => {
    it('allows up to 4 participants', () => {
      const { rooms, roomId, join } = setup();
      for (const id of ['a', 'b', 'c', 'd']) expect(join(id).ok).toBe(true);
      expect(rooms.listParticipants(roomId)).toHaveLength(4);
    });

    it('rejects the fifth participant with a friendly message', () => {
      const { rooms, roomId, join } = setup();
      for (const id of ['a', 'b', 'c', 'd']) join(id);
      const fifth = join('e');
      expect(fifth).toEqual({ ok: false, code: 'ROOM_FULL', message: 'This meeting is full. Maximum 4 participants.' });
      expect(rooms.listParticipants(roomId)).toHaveLength(4);
      expect(rooms.getBySocket('e')).toBeNull();
    });

    it('frees a slot when someone leaves', () => {
      const { join, rooms } = setup();
      for (const id of ['a', 'b', 'c', 'd']) join(id);
      rooms.leave('b');
      expect(join('e').ok).toBe(true);
    });

    it('prevents a socket from joining twice', () => {
      const { join } = setup();
      join('a');
      expect(join('a')).toMatchObject({ ok: false, code: 'ALREADY_JOINED' });
    });
  });

  describe('host', () => {
    it('makes the creator (host key holder) the host', () => {
      const { join, hostKey } = setup();
      const guest = joined(join('guest'));
      const creator = joined(join('creator', 'Creator', hostKey));
      expect(guest.hostId).toBe(guest.participant.participantId); // temporarily
      expect(creator.hostId).toBe(creator.participant.participantId);
      expect(creator.hostChanged).toBe(true);
    });

    it('host key is single-use', () => {
      const { join, hostKey, rooms } = setup();
      const creator = joined(join('creator', 'Creator', hostKey));
      const other = joined(join('other', 'Other', hostKey));
      expect(other.hostId).toBe(creator.participant.participantId);
      expect(rooms.getBySocket('other')?.hostId).toBe(creator.participant.participantId);
    });

    it('reassigns host to the earliest remaining participant when the host leaves', () => {
      const { join, rooms, hostKey } = setup();
      joined(join('host', 'Host', hostKey));
      vi.advanceTimersByTime(1000);
      const second = joined(join('second'));
      vi.advanceTimersByTime(1000);
      joined(join('third'));

      const outcome = rooms.leave('host');
      expect(outcome?.newHostId).toBe(second.participant.participantId);
      expect(rooms.getHostId(outcome!.roomId)).toBe(second.participant.participantId);
    });

    it('does not report a host change when a non-host leaves', () => {
      const { join, rooms, hostKey } = setup();
      joined(join('host', 'Host', hostKey));
      joined(join('second'));
      expect(rooms.leave('second')?.newHostId).toBeUndefined();
    });
  });

  describe('transcript control', () => {
    it('only the host can start the transcript', () => {
      const { join, rooms, hostKey } = setup();
      join('host', 'Host', hostKey);
      join('guest');
      expect(rooms.startTranscript('guest')).toMatchObject({ ok: false, code: 'NOT_HOST' });
      expect(rooms.startTranscript('stranger')).toMatchObject({ ok: false, code: 'NOT_JOINED' });
      expect(rooms.startTranscript('host').ok).toBe(true);
    });

    it('only the host can stop the transcript', () => {
      const { join, rooms, hostKey, roomId } = setup();
      join('host', 'Host', hostKey);
      join('guest');
      rooms.startTranscript('host');
      expect(rooms.stopTranscript('guest')).toMatchObject({ ok: false, code: 'NOT_HOST' });
      expect(rooms.getTranscriptState(roomId).status).toBe('active');
      expect(rooms.stopTranscript('host').ok).toBe(true);
      expect(rooms.getTranscriptState(roomId).status).toBe('stopped');
    });

    it('new host can control the transcript after reassignment', () => {
      const { join, rooms, hostKey } = setup();
      join('host', 'Host', hostKey);
      join('guest');
      rooms.startTranscript('host');
      rooms.leave('host');
      expect(rooms.stopTranscript('guest').ok).toBe(true);
    });
  });

  describe('transcript entries', () => {
    it('stores finalized entries in memory with server-side identity', () => {
      const { join, rooms, hostKey, roomId } = setup();
      const melih = joined(join('host', 'Melih', hostKey));
      const ahmet = joined(join('guest', 'Ahmet'));
      const start = rooms.startTranscript('host');
      if (!start.ok) throw new Error();

      rooms.addTranscriptEntry('host', { sessionId: start.sessionId, text: 'Bugünkü toplantıya başlayabiliriz.' });
      vi.advanceTimersByTime(6000);
      rooms.addTranscriptEntry('guest', { sessionId: start.sessionId, text: 'Evet, Azure Speech çalışıyor.' });

      const state = rooms.getTranscriptState(roomId);
      expect(state.entries).toHaveLength(2);
      expect(state.entries[0]).toMatchObject({
        participantId: melih.participant.participantId,
        displayName: 'Melih',
        text: 'Bugünkü toplantıya başlayabiliriz.',
        timestamp: new Date('2026-09-29T14:05:00Z').getTime(),
      });
      expect(state.entries[1]).toMatchObject({ participantId: ahmet.participant.participantId, displayName: 'Ahmet' });
    });

    it('rejects entries when no transcript is active or from a stale session', () => {
      const { join, rooms, hostKey } = setup();
      join('host', 'Host', hostKey);
      expect(rooms.addTranscriptEntry('host', { sessionId: crypto.randomUUID(), text: 'x' })).toMatchObject({ ok: false, code: 'NOT_ACTIVE' });
      rooms.startTranscript('host');
      expect(rooms.addTranscriptEntry('host', { sessionId: crypto.randomUUID(), text: 'x' })).toMatchObject({ ok: false, code: 'STALE_SESSION' });
      expect(rooms.addTranscriptEntry('nobody', { sessionId: crypto.randomUUID(), text: 'x' })).toMatchObject({ ok: false, code: 'NOT_JOINED' });
    });

    it('accepts late finalized speech only within the short grace period after stop', () => {
      const { join, rooms, hostKey } = setup({ lateEntryGraceMs: 3000 });
      join('host', 'Host', hostKey);
      const start = rooms.startTranscript('host');
      if (!start.ok) throw new Error();
      rooms.stopTranscript('host');
      vi.advanceTimersByTime(2000);
      expect(rooms.addTranscriptEntry('host', { sessionId: start.sessionId, text: 'flush' }).ok).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(rooms.addTranscriptEntry('host', { sessionId: start.sessionId, text: 'too late' })).toMatchObject({ ok: false, code: 'NOT_ACTIVE' });
    });
  });

  describe('30-second expiry', () => {
    function withTranscript() {
      const ctx = setup();
      ctx.join('host', 'Host', ctx.hostKey);
      ctx.join('guest', 'Guest');
      const start = ctx.rooms.startTranscript('host');
      if (!start.ok) throw new Error();
      ctx.rooms.addTranscriptEntry('guest', { sessionId: start.sessionId, text: 'Benim sesim geliyor mu?' });
      return { ...ctx, sessionId: start.sessionId };
    }

    it('sets expiry to exactly 30 seconds after stop', () => {
      const { rooms, roomId } = withTranscript();
      const stop = rooms.stopTranscript('host');
      if (!stop.ok) throw new Error();
      const now = Date.now();
      expect(stop.expiresAt).toBe(now + 30_000);
      expect(rooms.getTranscriptState(roomId).expiresAt).toBe(now + 30_000);
    });

    it('keeps the transcript downloadable during the window', () => {
      const { rooms } = withTranscript();
      rooms.stopTranscript('host');
      vi.advanceTimersByTime(29_999);
      const dl = rooms.getTranscriptForDownload('guest');
      expect(dl.ok).toBe(true);
      if (dl.ok) expect(dl.entries[0]?.text).toBe('Benim sesim geliyor mu?');
    });

    it('deletes the transcript from memory after 30 seconds and notifies', () => {
      const { rooms, roomId, onTranscriptDeleted, sessionId } = withTranscript();
      rooms.stopTranscript('host');
      vi.advanceTimersByTime(30_000);

      expect(onTranscriptDeleted).toHaveBeenCalledExactlyOnceWith(roomId, sessionId);
      const state = rooms.getTranscriptState(roomId);
      expect(state).toEqual({ status: 'idle', sessionId: null, entries: [], expiresAt: null });
      expect(JSON.stringify(state)).not.toContain('Benim sesim');
    });

    it('download is unavailable after deletion', () => {
      const { rooms } = withTranscript();
      rooms.stopTranscript('host');
      vi.advanceTimersByTime(30_000);
      expect(rooms.getTranscriptForDownload('guest')).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
      expect(rooms.getTranscriptForDownload('host')).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    });

    it('a new session starts empty after deletion', () => {
      const { rooms, roomId } = withTranscript();
      rooms.stopTranscript('host');
      vi.advanceTimersByTime(30_000);
      const next = rooms.startTranscript('host');
      expect(next.ok).toBe(true);
      expect(rooms.getTranscriptState(roomId).entries).toEqual([]);
    });

    it('starting a new session during the window cancels the timer and discards the old transcript', () => {
      const { rooms, roomId, onTranscriptDeleted, sessionId } = withTranscript();
      rooms.stopTranscript('host');
      vi.advanceTimersByTime(10_000);

      const next = rooms.startTranscript('host');
      if (!next.ok) throw new Error();
      expect(next.sessionId).not.toBe(sessionId);
      const state = rooms.getTranscriptState(roomId);
      expect(state).toMatchObject({ status: 'active', entries: [], expiresAt: null });

      // Old entries from the previous session are rejected.
      expect(rooms.addTranscriptEntry('guest', { sessionId, text: 'old' })).toMatchObject({ ok: false, code: 'STALE_SESSION' });

      // The old deletion timer must not fire against the new session.
      rooms.addTranscriptEntry('guest', { sessionId: next.sessionId, text: 'new session' });
      vi.advanceTimersByTime(60_000);
      expect(onTranscriptDeleted).not.toHaveBeenCalled();
      expect(rooms.getTranscriptState(roomId).entries.map((e) => e.text)).toEqual(['new session']);
    });
  });

  describe('cleanup', () => {
    it('removes the room when the last participant leaves', () => {
      const { join, rooms, roomId, hostKey } = setup();
      join('a', 'A', hostKey);
      join('b');
      expect(rooms.leave('a')?.roomDeleted).toBe(false);
      expect(rooms.leave('b')?.roomDeleted).toBe(true);
      expect(rooms.hasRoom(roomId)).toBe(false);
      expect(rooms.roomCount()).toBe(0);
    });

    it('deletes the room and transcript immediately if everyone leaves during the window', () => {
      const { join, rooms, roomId, hostKey, onTranscriptDeleted } = setup();
      join('a', 'A', hostKey);
      const start = rooms.startTranscript('a');
      if (!start.ok) throw new Error();
      rooms.addTranscriptEntry('a', { sessionId: start.sessionId, text: 'secret' });
      rooms.stopTranscript('a');
      rooms.leave('a');
      expect(rooms.hasRoom(roomId)).toBe(false);
      expect(rooms.getTranscriptState(roomId).entries).toEqual([]);
      vi.advanceTimersByTime(60_000);
      expect(onTranscriptDeleted).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('invalidates participant tokens after leaving', () => {
      const { join, rooms, hostKey } = setup();
      const a = joined(join('a', 'A', hostKey));
      joined(join('b'));
      expect(rooms.getByToken(a.participant.token)).not.toBeNull();
      rooms.leave('a');
      expect(rooms.getByToken(a.participant.token)).toBeNull();
    });
  });

  describe('signalling scope', () => {
    it('only resolves targets inside the sender room', () => {
      const rooms = new RoomManager();
      const r1 = rooms.createRoom();
      const r2 = rooms.createRoom();
      if (!r1.ok || !r2.ok) throw new Error();
      const a = joined(rooms.join({ roomId: r1.roomId, socketId: 'a', displayName: 'A', media }));
      const b = joined(rooms.join({ roomId: r1.roomId, socketId: 'b', displayName: 'B', media }));
      const x = joined(rooms.join({ roomId: r2.roomId, socketId: 'x', displayName: 'X', media }));

      expect(rooms.resolveSignalTarget('a', b.participant.participantId)).toEqual({ fromParticipantId: a.participant.participantId, toSocketId: 'b' });
      expect(rooms.resolveSignalTarget('a', x.participant.participantId)).toBeNull();
      expect(rooms.resolveSignalTarget('x', a.participant.participantId)).toBeNull();
      expect(rooms.resolveSignalTarget('a', a.participant.participantId)).toBeNull();
      expect(rooms.resolveSignalTarget('unjoined', a.participant.participantId)).toBeNull();
      rooms.dispose();
    });
  });
});
