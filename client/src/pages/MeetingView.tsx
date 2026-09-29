import { useEffect, useState, useSyncExternalStore } from 'react';
import { MAX_PARTICIPANTS } from '../../../shared/protocol';
import { ControlBar } from '../components/ControlBar';
import { LinkIcon } from '../components/Icons';
import { TranscriptPanel } from '../components/TranscriptPanel';
import { VideoGrid } from '../components/VideoGrid';
import { VideoTile } from '../components/VideoTile';
import { navigate } from '../lib/navigation';
import type { MeetingController } from '../meeting/MeetingController';

interface Props {
  controller: MeetingController;
  displayName: string;
  initialNotice: string | null;
}

export function MeetingView({ controller, displayName, initialNotice }: Props) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(initialNotice);
  const [copied, setCopied] = useState(false);

  // Leave cleanly on tab close, browser back/forward, or unmount.
  useEffect(() => {
    const onHide = () => void controller.leave();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      void controller.leave();
    };
  }, [controller]);

  const notice = state.notice ?? toast;
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => {
      controller.dismissNotice();
      setToast(null);
    }, 6_000);
    return () => clearTimeout(t);
  }, [notice, controller]);

  const leave = async () => {
    await controller.leave();
    navigate('/');
  };

  if (state.phase === 'error' || state.phase === 'ended') {
    return (
      <main className="landing">
        <div className="card stack">
          <h1>{state.phase === 'error' ? 'Unable to join' : 'You left the meeting'}</h1>
          {state.error && <p className="error-text">{state.error}</p>}
          <button className="btn btn--primary" onClick={() => navigate('/')}>
            Back to start
          </button>
        </div>
      </main>
    );
  }

  const isHost = state.selfId !== null && state.hostId === state.selfId;
  const t = state.transcript;
  const panelOpen = t.status !== 'idle';
  const hostName = state.participants.find((p) => p.participantId === state.hostId)?.displayName;

  const toggleTranscript = async () => {
    setBusy(true);
    const err = t.status === 'active' ? await controller.stopTranscript() : await controller.startTranscript();
    setBusy(false);
    if (err) setToast(err);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setToast('Copy failed. Share the address from your browser bar.');
    }
  };

  const ordered = [...state.participants].sort((a, b) => a.joinedAt - b.joinedAt);

  return (
    <div className={`meeting${panelOpen ? ' meeting--with-panel' : ''}`}>
      <header className="topbar">
        <div className="topbar__title">
          <strong>Teams Listener</strong>
          <span className="muted">
            {state.participants.length}/{MAX_PARTICIPANTS} participants{hostName ? ` · Host: ${hostName}` : ''}
          </span>
        </div>
        {t.status === 'active' && (
          <div className="live-banner" role="status">
            <span className="dot" /> Live transcript active — everyone&apos;s speech is being transcribed
          </div>
        )}
        {t.status === 'stopped' && <div className="live-banner live-banner--stopped">Live transcription has stopped</div>}
        <div className="topbar__actions">
          {isHost && <span className="badge badge--host">You are the host</span>}
          <button className="btn btn--ghost btn--small" onClick={() => void copyLink()}>
            <LinkIcon width={16} height={16} /> {copied ? 'Copied!' : 'Copy invite link'}
          </button>
        </div>
      </header>

      {state.phase === 'reconnecting' && <div className="banner banner--warn">Connection lost. Reconnecting…</div>}
      {state.phase === 'connecting' && <div className="banner">Joining meeting…</div>}

      <div className="stage">
        <section className="videos" aria-label="Participants">
          <VideoGrid count={Math.max(1, ordered.length)}>
            {ordered.length === 0 && (
              <VideoTile
                stream={controller.localStream}
                displayName={displayName}
                isLocal
                isHost={false}
                audioEnabled={state.audioEnabled}
                videoEnabled={state.videoEnabled}
              />
            )}
            {ordered.map((p) => {
              const isSelf = p.participantId === state.selfId;
              return (
                <VideoTile
                  key={p.participantId}
                  stream={isSelf ? controller.localStream : (state.remoteStreams[p.participantId] ?? null)}
                  displayName={p.displayName}
                  isLocal={isSelf}
                  isHost={p.participantId === state.hostId}
                  audioEnabled={isSelf ? state.audioEnabled : p.media.audioEnabled}
                  videoEnabled={isSelf ? state.videoEnabled : p.media.videoEnabled}
                  connectionState={isSelf ? undefined : state.connectionStates[p.participantId]}
                />
              );
            })}
          </VideoGrid>
        </section>

        {panelOpen && (
          <TranscriptPanel
            status={t.status}
            entries={t.entries}
            expiresAt={t.expiresAt}
            clockOffsetMs={state.clockOffsetMs}
            selfId={state.selfId}
            selfName={displayName}
            partialText={state.partialText}
            recognition={state.recognition}
            onDownload={() => controller.downloadTranscript()}
            onRetryRecognition={() => controller.retryRecognition()}
          />
        )}
      </div>

      <ControlBar
        audioEnabled={state.audioEnabled}
        videoEnabled={state.videoEnabled}
        hasAudioTrack={state.hasAudioTrack}
        hasVideoTrack={state.hasVideoTrack}
        isHost={isHost}
        transcriptActive={t.status === 'active'}
        busy={busy || state.phase !== 'joined'}
        onToggleAudio={() => controller.toggleAudio()}
        onToggleVideo={() => controller.toggleVideo()}
        onToggleTranscript={() => void toggleTranscript()}
        onLeave={() => void leave()}
      />

      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}
