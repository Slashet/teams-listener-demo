import { useState, type FormEvent } from 'react';
import { DISPLAY_NAME_MAX_LENGTH } from '../../../shared/protocol';
import { createRoom } from '../lib/api';
import { extractRoomId, navigate } from '../lib/navigation';

export function Landing() {
  const [name, setName] = useState('');
  const [roomInput, setRoomInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed) {
      setError('Please enter your display name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { roomId, hostKey } = await createRoom();
      navigate(`/room/${roomId}`, { displayName: trimmed, hostKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a meeting.');
      setBusy(false);
    }
  };

  const onJoin = () => {
    if (!trimmed) {
      setError('Please enter your display name.');
      return;
    }
    const roomId = extractRoomId(roomInput);
    if (!roomId) {
      setError('Enter a valid meeting ID or invite link.');
      return;
    }
    navigate(`/room/${roomId}`, { displayName: trimmed });
  };

  return (
    <main className="landing">
      <div className="card">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={40} height={40} />
          <div>
            <h1>Teams Listener Demo</h1>
            <p className="muted">Small video meetings with live Azure Speech transcription.</p>
          </div>
        </div>

        <form onSubmit={(e) => void onCreate(e)} className="stack">
          <label className="field">
            <span>Display name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              placeholder="e.g. Melih"
              autoFocus
              autoComplete="nickname"
            />
          </label>
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Creating…' : 'Create Meeting'}
          </button>
        </form>

        <div className="divider">
          <span>or join an existing meeting</span>
        </div>

        <div className="join-row">
          <input
            value={roomInput}
            onChange={(e) => setRoomInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onJoin();
            }}
            placeholder="Meeting ID or invite link"
            aria-label="Meeting ID or invite link"
            spellCheck={false}
          />
          <button type="button" className="btn" onClick={onJoin}>
            Join Meeting
          </button>
        </div>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <p className="fineprint">Up to 4 participants. No accounts. Transcripts are kept in memory only and deleted 30 seconds after transcription stops.</p>
      </div>
    </main>
  );
}
