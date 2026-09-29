import { useEffect, useState, type FormEvent } from 'react';
import { DISPLAY_NAME_MAX_LENGTH } from '../../../shared/protocol';
import { getLocalMedia, MediaAccessError } from '../lib/media';
import { consumeNavState, navigate, ROOM_ID_PATTERN } from '../lib/navigation';
import { MeetingController } from '../meeting/MeetingController';
import { MeetingView } from './MeetingView';

type Stage = { kind: 'prejoin' } | { kind: 'meeting'; controller: MeetingController; notice: string | null };

export function RoomPage({ roomId }: { roomId: string }) {
  // Handoff from the landing page (name + one-time host key), memory only.
  const [handoff] = useState(consumeNavState);
  const [name, setName] = useState(handoff?.displayName ?? '');
  const [stage, setStage] = useState<Stage>({ kind: 'prejoin' });
  const [error, setError] = useState<{ message: string; canRetry: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const validRoom = ROOM_ID_PATTERN.test(roomId);

  const join = async (displayName: string) => {
    setBusy(true);
    setError(null);
    try {
      const { stream, notice } = await getLocalMedia();
      const controller = new MeetingController({ roomId, displayName, hostKey: handoff?.hostKey, localStream: stream });
      controller.start();
      setStage({ kind: 'meeting', controller, notice });
    } catch (err) {
      const message = err instanceof MediaAccessError ? err.message : 'Could not access camera or microphone.';
      setError({ message, canRetry: !(err instanceof MediaAccessError && err.kind === 'insecure') });
    } finally {
      setBusy(false);
    }
  };

  // Creator arrives with a name already chosen: join right away.
  const [autoJoin] = useState(() => Boolean(handoff?.displayName));
  useEffect(() => {
    if (!autoJoin || !validRoom) return;
    const t = setTimeout(() => void join(handoff?.displayName ?? ''), 0);
    return () => clearTimeout(t);
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!validRoom) {
    return (
      <main className="landing">
        <div className="card">
          <h1>Meeting not found</h1>
          <p className="muted">The meeting link is not valid.</p>
          <button className="btn btn--primary" onClick={() => navigate('/')}>
            Back to start
          </button>
        </div>
      </main>
    );
  }

  if (stage.kind === 'meeting') {
    return <MeetingView controller={stage.controller} displayName={name.trim()} initialNotice={stage.notice} />;
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError({ message: 'Please enter your display name.', canRetry: false });
      return;
    }
    void join(name.trim());
  };

  return (
    <main className="landing">
      <form className="card stack" onSubmit={onSubmit}>
        <div className="brand">
          <img src="/favicon.svg" alt="" width={40} height={40} />
          <div>
            <h1>Join meeting</h1>
            <p className="muted mono">{roomId}</p>
          </div>
        </div>
        <label className="field">
          <span>Display name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            placeholder="Your name"
            autoFocus
            autoComplete="nickname"
          />
        </label>
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? 'Starting camera…' : error?.canRetry ? 'Try again' : 'Join Meeting'}
        </button>
        {error && (
          <p className="error-text" role="alert">
            {error.message}
          </p>
        )}
        <p className="fineprint">Your browser will ask for camera and microphone access.</p>
        <button type="button" className="link" onClick={() => navigate('/')}>
          ← Back
        </button>
      </form>
    </main>
  );
}
