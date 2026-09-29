import type { ReactNode } from 'react';

/** 1 tile: large centered; 2: two columns; 3–4: 2×2 grid. */
export function VideoGrid({ count, children }: { count: number; children: ReactNode }) {
  const layout = count <= 1 ? 'one' : count === 2 ? 'two' : 'four';
  return <div className={`grid grid--${layout}`}>{children}</div>;
}
