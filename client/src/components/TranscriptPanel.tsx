import { useLayoutEffect, useRef, useState } from 'react';
import type { TranscriptEntry, TranscriptStatus } from '../../../shared/protocol';
import type { RecognitionStatus } from '../speech/SpeechTranscriber';
import { Countdown } from './Countdown';
import { DownloadIcon } from './Icons';

interface Props {
  status: TranscriptStatus;
  entries: TranscriptEntry[];
  expiresAt: number | null;
  clockOffsetMs: number;
  selfId: string | null;
  selfName: string;
  partialText: string;
  recognition: { status: RecognitionStatus; message: string | null };
  onDownload(): Promise<string | null>;
  onRetryRecognition(): void;
}

const NEAR_BOTTOM_PX = 80;
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function TranscriptPanel(props: Props) {
  const { status, entries, expiresAt, clockOffsetMs, selfId, selfName, partialText, recognition } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Follow new entries only when the reader is already near the bottom.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, partialText]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  const download = async () => {
    setDownloading(true);
    setDownloadError(null);
    const err = await props.onDownload();
    setDownloading(false);
    if (err) setDownloadError(err);
  };

  return (
    <aside className="transcript" aria-label="Live transcript">
      <header className="transcript__header">
        <h2>Live Transcript</h2>
        {status === 'active' ? (
          <span className="badge badge--live">
            <span className="dot" /> Active
          </span>
        ) : (
          <span className="badge badge--stopped">Stopped</span>
        )}
      </header>

      {status === 'active' && recognition.status === 'error' && (
        <div className="transcript__alert" role="alert">
          <p>{recognition.message}</p>
          <button className="btn btn--small" onClick={props.onRetryRecognition}>
            Retry
          </button>
        </div>
      )}
      {status === 'active' && recognition.status === 'starting' && <div className="transcript__info">Connecting to Azure Speech…</div>}

      <div className="transcript__list" ref={listRef} onScroll={onScroll} aria-live="polite">
        {entries.length === 0 && status === 'active' && !partialText && <p className="transcript__empty">Listening… speak to see your words here.</p>}
        {entries.length === 0 && status === 'stopped' && <p className="transcript__empty">No speech was transcribed.</p>}
        {entries.map((e, i) => {
          const prev = entries[i - 1];
          const grouped = prev?.participantId === e.participantId && e.timestamp - prev.timestamp < 60_000;
          return (
            <div key={e.id} className={`entry${e.participantId === selfId ? ' entry--self' : ''}${grouped ? ' entry--grouped' : ''}`}>
              {!grouped && (
                <div className="entry__meta">
                  <span className="entry__name">{e.displayName}</span>
                  <time dateTime={new Date(e.timestamp).toISOString()}>{timeFmt.format(e.timestamp)}</time>
                </div>
              )}
              <p className="entry__text">{e.text}</p>
            </div>
          );
        })}
        {status === 'active' && partialText && (
          <div className="entry entry--self entry--partial">
            <div className="entry__meta">
              <span className="entry__name">{selfName}</span>
              <span className="entry__typing">speaking…</span>
            </div>
            <p className="entry__text">{partialText}</p>
          </div>
        )}
      </div>

      {status === 'stopped' && (
        <div className="transcript__footer" role="status">
          <p className="transcript__stopped">Live transcription has stopped.</p>
          <p>Would you like to download the transcript?</p>
          <button className="btn btn--primary" onClick={() => void download()} disabled={downloading || entries.length === 0}>
            <DownloadIcon /> Download transcript (.txt)
          </button>
          {downloadError && <p className="error-text">{downloadError}</p>}
          <p className="transcript__warning">
            This transcript will be permanently deleted in{' '}
            {expiresAt !== null && <Countdown key={expiresAt} expiresAt={expiresAt} clockOffsetMs={clockOffsetMs} />}
          </p>
        </div>
      )}
    </aside>
  );
}
