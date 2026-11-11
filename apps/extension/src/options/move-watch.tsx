import { useState } from 'react';
import {
  WatchIdSelector,
  WatchMove,
  type InstagramLogin,
  type WatchCommand,
  type WatchSummary,
} from '@gramgrab/protocol';
import type { WatchCommandResponse } from '../messaging/contracts.ts';
import { OWNER_LABEL } from './owners.tsx';

type Outcome = 'moving' | 'already-watched' | undefined;

/**
 * Moves a Watch, with its baselines and inbox, to another signed-in login. `destinations` are the
 * signed-in logins other than the Watch's owner, each with its username.
 */
export function MoveWatch({
  watch,
  destinations,
  onSend,
}: {
  watch: WatchSummary;
  destinations: readonly { readonly login: InstagramLogin; readonly username: string }[];
  onSend: (command: WatchCommand, login: InstagramLogin) => Promise<WatchCommandResponse>;
}) {
  const [outcome, setOutcome] = useState<Outcome>();
  if (destinations.length === 0) return null;
  const move = (login: InstagramLogin) => {
    setOutcome('moving');
    void onSend(
      WatchMove.make({ watches: [WatchIdSelector.make({ watchId: watch.watchId })] }),
      login
    ).then(response =>
      setOutcome(
        response.result?._tag === 'WatchMoveResult' && response.result.alreadyWatched.length
          ? 'already-watched'
          : undefined
      )
    );
  };
  return (
    <>
      <span className="opt-label">Owner</span>
      <div className="opt-col">
        {destinations.map(({ login, username }) => (
          <button
            key={login}
            className="opt-btn"
            disabled={outcome === 'moving'}
            onClick={() => move(login)}
          >
            Move to {OWNER_LABEL[login]} (@{username})
          </button>
        ))}
        <p className="opt-meta">
          Moving keeps baselines and the inbox. Checks then run as the new login.
        </p>
        {outcome === 'already-watched' && (
          <p className="opt-banner opt-banner-error">
            That login already watches @{watch.username}, so this Watch stayed where it is. Delete
            one of the two first.
          </p>
        )}
      </div>
    </>
  );
}
