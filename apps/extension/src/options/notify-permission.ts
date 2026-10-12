import type { WatchAction } from '@gramgrab/protocol';
import { browser } from '../lib/browser.ts';

/**
 * Asks for notification permission when notify is chosen. It must run inside the click, before
 * any other await. A refusal is not an error here: delivery records it on the entries it affects.
 */
export const askToNotify = (actions: readonly WatchAction[]) => {
  if (actions.includes('notify'))
    void browser.permissions.request({ permissions: ['notifications'] }).catch(() => false);
};
