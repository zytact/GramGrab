import { useEffect, useState } from 'react';
import type { InstagramLogin } from '@gramgrab/protocol';
import type { LinkedLoginState } from '../messaging/contracts';
import { linkedLoginState } from '../instagram/linked-login';

/** Where the linked login stands, read once when the surface opens. */
export function useLinkedLoginState(): LinkedLoginState | undefined {
  const [state, setState] = useState<LinkedLoginState>();
  useEffect(() => {
    void linkedLoginState().then(setState, () => undefined);
  }, []);
  return state;
}

/** Picks which Instagram login fetches. Shown only while a second login is linked (Beta). */
export function LoginPicker({
  state,
  login,
  disabled,
  onChange,
}: {
  readonly state: LinkedLoginState | undefined;
  readonly login: InstagramLogin;
  readonly disabled: boolean;
  readonly onChange: (login: InstagramLogin) => void;
}) {
  if (state !== 'linked' && state !== 'ended') return null;
  return (
    <label className="login-picker">
      <span className="login-picker-label">Login</span>
      <select
        id="instagram-login"
        value={login}
        disabled={disabled}
        onChange={event => onChange(event.currentTarget.value === 'linked' ? 'linked' : 'main')}
      >
        <option value="main">Main</option>
        <option value="linked" disabled={state === 'ended'}>
          {state === 'ended' ? 'Linked (signed out)' : 'Linked'}
        </option>
      </select>
      <span className="login-picker-beta">Beta</span>
    </label>
  );
}
