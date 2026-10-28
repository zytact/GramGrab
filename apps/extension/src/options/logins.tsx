import { useState } from 'react';
import type { InstagramLogin } from '@gramgrab/protocol';
import type { LinkRefusalReason } from '../messaging/contracts.ts';
import { sendMessage } from '../messaging/send.ts';
import type { Logins } from '../popup/login-picker.tsx';
import { Avatar } from './avatar.tsx';
import { OWNER_LABEL } from './owners.tsx';

const REFUSAL: Record<LinkRefusalReason, string> = {
  'main-unverified':
    'GramGrab could not confirm your main login, so it cannot tell the two apart. Sign in to Instagram in this window, then link again.',
  'incognito-not-allowed':
    "Allow GramGrab in Incognito on the browser's extensions page, then link again.",
  'no-incognito-window':
    'No Incognito window is open. Open one, sign in to the other account on instagram.com there, then link again.',
  'not-signed-in':
    'Your Incognito window is not signed in to Instagram. Open instagram.com there, sign in to the other account, then link again.',
  'not-verified':
    'Instagram did not confirm that login. Sign in again in the Incognito window, then link again.',
  'same-login':
    'That Incognito window is signed in to your main login. Sign in to a different account there.',
};

const hasLinked = ({ state }: Logins) => state === 'linked' || state === 'ended';

const loginName = (login: InstagramLogin, { state, names }: Logins) => {
  if (login === 'linked' && state === 'ended') return 'Signed out';
  const name = names[login];
  return name ? `@${name}` : 'Not verified';
};

/** A login's Avatar. Only the main login's picture is cached, and an ended login's is greyed. */
function LoginAvatar({
  login,
  logins,
  mainAvatar,
}: {
  login: InstagramLogin;
  logins: Logins;
  mainAvatar: string | undefined;
}) {
  const avatar = (
    <Avatar
      src={login === 'main' ? mainAvatar : undefined}
      username={logins.names[login] ?? OWNER_LABEL[login]}
      size="sm"
    />
  );
  return login === 'linked' && logins.state === 'ended' ? (
    <span className="opt-login-ended">{avatar}</span>
  ) : (
    avatar
  );
}

/**
 * Each login's full username, then Link or Unlink for the second one (Beta). `onChange` runs after
 * a link or unlink. Link and Unlink are hidden where the browser cannot link a login.
 */
export function LoginsPanel({
  logins,
  mainAvatar,
  onChange,
}: {
  logins: Logins;
  mainAvatar?: string;
  onChange: () => void;
}) {
  const { state, names } = logins;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const shown = (['main', 'linked'] as const).filter(login =>
    login === 'main' ? names.main !== undefined : hasLinked(logins)
  );

  const link = async () => {
    setBusy(true);
    const response = await sendMessage({ type: 'LINK_LOGIN' });
    setBusy(false);
    if (response._tag === 'refused') return setNotice(REFUSAL[response.reason]);
    onChange();
    setNotice(
      `Linked @${response.username}. You can close the Incognito window, but do not log out of it.`
    );
  };
  const unlink = async () => {
    setBusy(true);
    await sendMessage({ type: 'UNLINK_LOGIN' });
    setBusy(false);
    onChange();
    setNotice(undefined);
  };

  return (
    <div className="opt-logins">
      <span className="opt-label">
        Logins <span className="opt-beta">Beta</span>
      </span>
      {shown.length > 0 && (
        <ul className="opt-login-names">
          {shown.map(login => (
            <li key={login}>
              <LoginAvatar login={login} logins={logins} mainAvatar={mainAvatar} />
              <span className="opt-grow">
                <span className="opt-meta">{OWNER_LABEL[login]} login</span>
                {loginName(login, logins)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {state === 'ended' && (
        <p className="opt-banner opt-banner-error">
          <strong>Your linked login was signed out.</strong> Its Watches are paused. Sign in to it
          in an Incognito window, then link this login again.
        </p>
      )}
      {state === 'unlinked' && (
        <p className="opt-meta">
          To fetch and watch accounts only another Instagram login can see, sign in to it in an
          Incognito window, then link it here.
        </p>
      )}
      {state && state !== 'unsupported' && (
        <div className="opt-login-actions">
          {state !== 'linked' && (
            <button className="opt-btn" disabled={busy} onClick={() => void link()}>
              {state === 'ended' ? 'Link this login again' : 'Link a second login'}
            </button>
          )}
          {state !== 'unlinked' && (
            <button className="opt-btn opt-danger" disabled={busy} onClick={() => void unlink()}>
              Unlink
            </button>
          )}
        </div>
      )}
      {notice && <p className="opt-meta">{notice}</p>}
    </div>
  );
}

/** The sidebar's Logins control. Closed, it names both logins; open, it shows `LoginsPanel`. */
export function LoginsMenu({
  logins,
  mainAvatar,
  onChange,
}: {
  logins: Logins;
  mainAvatar: string | undefined;
  onChange: () => void;
}) {
  const { state } = logins;
  return (
    <details className="opt-logins-menu">
      <summary className="opt-logins-summary" title="Verified from your Instagram session">
        <span className="opt-avatar-stack">
          <LoginAvatar login="main" logins={logins} mainAvatar={mainAvatar} />
          {hasLinked(logins) && (
            <LoginAvatar login="linked" logins={logins} mainAvatar={mainAvatar} />
          )}
        </span>
        <span className="opt-grow">
          <span className="opt-name">{loginName('main', logins)}</span>
          {hasLinked(logins) && (
            <span className="opt-meta opt-name">
              {state === 'ended' ? 'Linked login signed out' : `+ ${loginName('linked', logins)}`}
            </span>
          )}
        </span>
        {state === 'ended' && <span className="opt-dot" />}
        <span className="opt-caret" aria-hidden="true">
          ▾
        </span>
      </summary>
      <LoginsPanel logins={logins} mainAvatar={mainAvatar} onChange={onChange} />
    </details>
  );
}
