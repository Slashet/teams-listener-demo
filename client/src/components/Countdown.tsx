import { formatCountdown, useCountdown } from './useCountdown';

export function Countdown({ expiresAt, clockOffsetMs }: { expiresAt: number; clockOffsetMs: number }) {
  const remaining = useCountdown(expiresAt, clockOffsetMs);
  return (
    <strong className="countdown" aria-live="off">
      {formatCountdown(remaining)}
    </strong>
  );
}
