import { useState } from 'react';
import type { InstagramLogin } from '@gramgrab/protocol';
import type { LinkRefusalReason } from '../messaging/contracts.ts';
import { sendMessage } from '../messaging/send.ts';
import { loginLabel, useLogins } from '../popup/login-picker.tsx';

/** The login the Watches page shows, from its `login` query parameter. */
export const pageLogin = (): InstagramLogin =>
  new URLSearchParams(location.search).get('login') === 'linked' ? 'linked' : 'main';

const pageFor = (login: InstagramLogin) => {
  const url = new URL(location.href);
  url.hash = '';
  if (login === 'linked') url.searchParams.set('login', 'linked');
  else url.searchParams.delete('login');
  return url.href;
};

const REFUSAL: Record<LinkRefusalReason, string> = {
  'main-unverified':
    'GramGrab could not confirm your main login, so it cannot tell the two apart. Sign in to Instagram in this window, then link again.',
  'incognito-not-allowed':
    "Allow GramGrab in Incognito on the browser's extensions page, then link again.",
  'not-signed-in':
    'No Incognito window is signed in to Instagram. Open one, sign in to the other account, and keep it open while you link.',
  'not-verified':
    'Instagram did not confirm that login. Sign in again in the Incognito window, then link again.',
  'same-login':
    'That Incognito window is signed in to your main login. Sign in to a different account there.',
};

/**
 * Switches the page between the main and the linked login, and links or unlinks the second login
 * (Beta). Hidden where the browser cannot link one.
 */
export function LoginSwitch() {
  const logins = useLogins();
  const { state, reload } = logins;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  if (!state || state === 'unsupported') return null;
  const login = pageLogin();

  const link = async () => {
    setBusy(true);
    const response = await sendMessage({ type: 'LINK_LOGIN' });
    setBusy(false);
    if (response._tag === 'refused') return setNotice(REFUSAL[response.reason]);
    reload();
    setNotice(
      `Linked @${response.username}. You can close the Incognito window, but do not log out of it.`
    );
  };
  const unlink = async () => {
    setBusy(true);
    await sendMessage({ type: 'UNLINK_LOGIN' });
    setBusy(false);
    if (login === 'linked') location.assign(pageFor('main'));
    else reload();
    setNotice(undefined);
  };

  return (
    <div className="opt-login-switch">
      <span className="opt-label">
        {state === 'unlinked' ? 'Link a second login' : 'Logins'}{' '}
        <span className="opt-beta">Beta</span>
      </span>
      {state !== 'unlinked' && (
        <div className="opt-login-tabs">
          <a
            href={pageFor('main')}
            title={loginLabel('main', logins)}
            aria-current={login === 'main' ? 'page' : undefined}
          >
            {loginLabel('main', logins)}
          </a>
          <a
            href={pageFor('linked')}
            title={loginLabel('linked', logins)}
            aria-current={login === 'linked' ? 'page' : undefined}
          >
            {loginLabel('linked', logins)}
          </a>
        </div>
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
