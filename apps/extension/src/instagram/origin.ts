import { browser } from '../lib/browser.ts';

const RULE_ID = 1;

/**
 * Sends `Origin: https://www.instagram.com` on this extension's own POSTs to Instagram. Instagram
 * Web's GraphQL answers its home page to any other Origin, and `fetch` cannot set the header.
 * Session rules outlive the worker but not the browser, so every worker start installs it again.
 */
export const installInstagramOrigin = () =>
  browser.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: [RULE_ID],
      addRules: [
        {
          id: RULE_ID,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'origin', operation: 'set', value: 'https://www.instagram.com' },
            ],
          },
          condition: {
            requestDomains: ['instagram.com'],
            initiatorDomains: [new URL(browser.runtime.getURL('/')).hostname],
            requestMethods: ['post'],
            tabIds: [-1],
          },
        },
      ],
    })
    .catch((error: unknown) => console.warn('Instagram Origin rule failed:', error));
