import { CamIcon, CamOffIcon, LeaveIcon, MicIcon, MicOffIcon, TranscriptIcon } from './Icons';

interface Props {
  audioEnabled: boolean;
  videoEnabled: boolean;
  hasAudioTrack: boolean;
  hasVideoTrack: boolean;
  isHost: boolean;
  transcriptActive: boolean;
  busy: boolean;
  onToggleAudio(): void;
  onToggleVideo(): void;
  onToggleTranscript(): void;
  onLeave(): void;
}

export function ControlBar(p: Props) {
  return (
    <footer className="controls" aria-label="Meeting controls">
      <button
        className={`ctrl${p.audioEnabled ? '' : ' ctrl--off'}`}
        onClick={p.onToggleAudio}
        disabled={!p.hasAudioTrack}
        aria-pressed={!p.audioEnabled}
        title={p.hasAudioTrack ? (p.audioEnabled ? 'Mute microphone' : 'Unmute microphone') : 'No microphone available'}
      >
        {p.audioEnabled ? <MicIcon /> : <MicOffIcon />}
        <span>{p.audioEnabled ? 'Mute' : 'Unmute'}</span>
      </button>
      <button
        className={`ctrl${p.videoEnabled ? '' : ' ctrl--off'}`}
        onClick={p.onToggleVideo}
        disabled={!p.hasVideoTrack}
        aria-pressed={!p.videoEnabled}
        title={p.hasVideoTrack ? (p.videoEnabled ? 'Turn camera off' : 'Turn camera on') : 'No camera available'}
      >
        {p.videoEnabled ? <CamIcon /> : <CamOffIcon />}
        <span>{p.videoEnabled ? 'Stop video' : 'Start video'}</span>
      </button>
      <button
        className={`ctrl ctrl--wide${p.transcriptActive ? ' ctrl--active' : ''}`}
        onClick={p.onToggleTranscript}
        disabled={!p.isHost || p.busy}
        title={p.isHost ? undefined : 'Only the host can start or stop the live transcript'}
      >
        <TranscriptIcon />
        <span>{p.transcriptActive ? 'Stop Live Transcript' : 'Start Live Transcript'}</span>
      </button>
      <button className="ctrl ctrl--leave" onClick={p.onLeave} title="Leave meeting">
        <LeaveIcon />
        <span>Leave</span>
      </button>
    </footer>
  );
}
