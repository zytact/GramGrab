import { useCallback, useEffect, useState } from 'react';
import type { InstagramLogin } from '@gramgrab/protocol';
import type { LinkedLoginState, LoginNamesResponse } from '../messaging/contracts';
import { linkedLoginState } from '../instagram/linked-login';
import { browser } from '../lib/browser';
import { sendMessage } from '../messaging/send';

export interface Logins {
  readonly state: LinkedLoginState | undefined;
  readonly names: LoginNamesResponse;
}

/** A second login is linked, whether or not its session is still alive. */
export const hasLinked = ({ state }: Pick<Logins, 'state'>) =>
  state === 'linked' || state === 'ended';

/**
 * Where the linked login stands and each login's username, read when the surface opens. `reload`
 * reads both again after a link or unlink.
 */
export function useLogins(): Logins & { readonly reload: () => void } {
  const [logins, setLogins] = useState<Logins>({ state: undefined, names: {} });
  const reload = useCallback(() => {
    void linkedLoginState()
      .then(async state => {
        setLogins(current => ({ ...current, state }));
        if (hasLinked({ state }))
          setLogins({ state, names: await sendMessage({ type: 'LOGIN_NAMES' }) });
      })
      .catch(() => undefined);
  }, []);
  useEffect(reload, [reload]);
  return { ...logins, reload };
}

/** A picked login that reads as `main` whenever the linked login cannot run. */
export function useLoginChoice(logins: Logins) {
  const [picked, setPicked] = useState<InstagramLogin>('main');
  return [logins.state === 'linked' ? picked : 'main', setPicked] as const;
}

/** The login's `@username` once known, else `Main` or `Linked`. */
function loginLabel(login: InstagramLogin, { state, names }: Logins): string {
  const name = names[login];
  const label = name ? `@${name}` : login === 'main' ? 'Main' : 'Linked';
  return login === 'linked' && state === 'ended' ? `${label} (signed out)` : label;
}

/** Opens the Watches page, where linking lives, while no second login is linked (Beta). */
export function LinkLoginEntry({ logins }: { readonly logins: Logins }) {
  if (logins.state !== 'unlinked') return null;
  return (
    <button
      type="button"
      className="login-picker login-link-entry"
      title="Opens the Watches page, where you link a second Instagram login"
      onClick={() => void browser.runtime.openOptionsPage()}
    >
      <span className="login-link-text">Link a second login</span>
      <span className="login-picker-beta">Beta</span>
    </button>
  );
}

/** Picks which Instagram login fetches. Shown only while a second login is linked (Beta). */
export function LoginPicker({
  logins,
  login,
  disabled,
  onChange,
}: {
  readonly logins: Logins;
  readonly login: InstagramLogin;
  readonly disabled: boolean;
  readonly onChange: (login: InstagramLogin) => void;
}) {
  if (!hasLinked(logins)) return null;
  return (
    <label className="login-picker">
      <span className="login-picker-label">Login</span>
      <select
        id="instagram-login"
        value={login}
        disabled={disabled}
        onChange={event => onChange(event.currentTarget.value === 'linked' ? 'linked' : 'main')}
      >
        <option value="main">{loginLabel('main', logins)}</option>
        <option value="linked" disabled={logins.state === 'ended'}>
          {loginLabel('linked', logins)}
        </option>
      </select>
      <span className="login-picker-beta">Beta</span>
    </label>
  );
}
