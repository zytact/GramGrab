import { useCallback, useEffect, useState } from 'react';
import type { InstagramLogin } from '@gramgrab/protocol';
import type { LinkedLoginState, LoginNamesResponse } from '../messaging/contracts';
import { linkedLoginState } from '../instagram/linked-login';
import { sendMessage } from '../messaging/send';

export interface Logins {
  readonly state: LinkedLoginState | undefined;
  readonly names: LoginNamesResponse;
}

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
        if (state === 'linked' || state === 'ended')
          setLogins({ state, names: await sendMessage({ type: 'LOGIN_NAMES' }) });
      })
      .catch(() => undefined);
  }, []);
  useEffect(reload, [reload]);
  return { ...logins, reload };
}

/** The login's `@username` once known, else `Main` or `Linked`. */
export function loginLabel(login: InstagramLogin, { state, names }: Logins): string {
  const name = names[login];
  const label = name ? `@${name}` : login === 'main' ? 'Main' : 'Linked';
  return login === 'linked' && state === 'ended' ? `${label} (signed out)` : label;
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
  if (logins.state !== 'linked' && logins.state !== 'ended') return null;
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
