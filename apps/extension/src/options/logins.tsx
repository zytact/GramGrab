import { useState } from 'react';
import type { LinkRefusalReason } from '../messaging/contracts.ts';
import { sendMessage } from '../messaging/send.ts';
import type { Logins } from '../popup/login-picker.tsx';

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

/**
 * Names both logins and links or unlinks the second one (Beta). `onChange` runs after a link or
 * unlink. Hidden where the browser cannot link one.
 */
export function LoginsSection({ logins, onChange }: { logins: Logins; onChange: () => void }) {
  const { state, names } = logins;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  if (!state || state === 'unsupported') return null;

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
        {state === 'unlinked' ? 'Link a second login' : 'Logins'}{' '}
        <span className="opt-beta">Beta</span>
      </span>
      {state !== 'unlinked' && (
        <ul className="opt-login-names">
          <li>
            <span className="opt-meta">Main</span>
            <span className="opt-name">{names.main && `@${names.main}`}</span>
          </li>
          <li>
            <span className="opt-meta">Linked</span>
            <span className="opt-name">
              {state === 'ended' ? 'Signed out' : names.linked && `@${names.linked}`}
            </span>
          </li>
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
      <div className="opt-login-actions">
        {state !== 'linked' && (
          <button className="opt-btn" disabled={busy} onClick={() => void link()}>
            Link this login
          </button>
        )}
        {state !== 'unlinked' && (
          <button className="opt-btn" disabled={busy} onClick={() => void unlink()}>
            Unlink
          </button>
        )}
      </div>
      {notice && <p className="opt-meta">{notice}</p>}
    </div>
  );
}
