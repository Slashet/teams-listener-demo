import { useEffect, useRef, useState } from 'react';
import { CrownIcon, MicOffIcon } from './Icons';

interface Props {
  stream: MediaStream | null;
  displayName: string;
  isLocal: boolean;
  isHost: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  connectionState?: RTCPeerConnectionState;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0] ?? '?'];
  return letters.map((p) => (p ? Array.from(p)[0] : '')).join('').toUpperCase();
}

export function VideoTile({ stream, displayName, isLocal, isHost, audioEnabled, videoEnabled, connectionState }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playBlocked, setPlayBlocked] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (!stream) return;
    el.play()
      .then(() => setPlayBlocked(false))
      .catch((err: unknown) => {
        // Autoplay with sound can be blocked until the user interacts with the page.
        if (err instanceof DOMException && err.name === 'NotAllowedError') setPlayBlocked(true);
      });
  }, [stream]);

  const hasLiveVideo = Boolean(stream?.getVideoTracks().length) && videoEnabled;
  const connecting = !isLocal && connectionState !== 'connected';
  const label = connectionState === 'failed' ? 'Connection failed, retrying…' : connectionState === 'disconnected' ? 'Reconnecting…' : 'Connecting…';

  return (
    <div className={`tile${isLocal ? ' tile--local' : ''}`}>
      {/* Local preview is always muted so the user never hears their own microphone. */}
      <video ref={videoRef} autoPlay playsInline muted={isLocal} className={hasLiveVideo ? '' : 'hidden'} />
      {!hasLiveVideo && (
        <div className="tile__avatar" aria-label="Camera off">
          <span>{initials(displayName)}</span>
          <small>Camera off</small>
        </div>
      )}
      {connecting && <div className="tile__status">{label}</div>}
      {playBlocked && (
        <button
          className="tile__unblock"
          onClick={() => {
            void videoRef.current?.play().then(() => setPlayBlocked(false));
          }}
        >
          Click to enable audio
        </button>
      )}
      <div className="tile__name">
        {isHost && <CrownIcon width={14} height={14} className="tile__host" aria-label="Host" />}
        <span>
          {displayName}
          {isLocal ? ' (You)' : ''}
        </span>
        {!audioEnabled && (
          <span className="tile__muted" title="Microphone muted">
            <MicOffIcon width={14} height={14} />
          </span>
        )}
      </div>
    </div>
  );
}
