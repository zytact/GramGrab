import { useEffect, useState } from 'react';

function formatStoryExpiry(expiresAt: string | undefined, now: number): string | undefined {
  if (expiresAt === undefined) return undefined;
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining)) return undefined;
  if (remaining <= 0) return 'Expired';
  const minutes = Math.floor(remaining / 60_000);
  if (minutes === 0) return 'Expires in <1m';
  return minutes >= 60 ? `Expires in ${Math.floor(minutes / 60)}h` : `Expires in ${minutes}m`;
}

export function StoryExpiry({ expiresAt }: { expiresAt?: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (expiresAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  const label = formatStoryExpiry(expiresAt, now);
  return label ? (
    <time className="item-expiry" dateTime={expiresAt}>
      {label}
    </time>
  ) : null;
}
