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
  return src ? (
    <img className={`opt-avatar opt-avatar-${size}`} src={src} alt="" />
  ) : (
    <span className={`opt-avatar opt-avatar-${size}`} aria-hidden="true">
      {username.charAt(0).toUpperCase()}
    </span>
  );
}
