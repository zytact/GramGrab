import { useState } from 'react';

/** An account's Avatar, or its username's first letter until a picture is cached. */
export function Avatar({
  src,
  username,
  size,
}: {
  src: string | undefined;
  username: string;
  size: 'sm' | 'md' | 'lg';
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  return src && src !== failedSrc ? (
    <img
      className={`opt-avatar opt-avatar-${size}`}
      src={src}
      alt=""
      onError={() => setFailedSrc(src)}
    />
  ) : (
    <span className={`opt-avatar opt-avatar-${size}`} aria-hidden="true">
      {username.charAt(0).toUpperCase()}
    </span>
  );
}
