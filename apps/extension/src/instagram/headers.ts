import { protocolConfig } from '../instagram-protocol/config.ts';

const IG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'X-IG-App-ID': protocolConfig.client.appId,
  'X-Requested-With': 'XMLHttpRequest',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Mode': 'cors',
  Referer: 'https://www.instagram.com/',
} as const;

export const IG_GRAPHQL_HEADERS = { ...IG_HEADERS, Origin: 'https://www.instagram.com' } as const;
export const IG_API_GRAPHQL_HEADERS = {
  ...IG_GRAPHQL_HEADERS,
  Referer: 'https://www.instagram.com/',
  'X-ASBD-ID': protocolConfig.client.asbdId,
} as const;
