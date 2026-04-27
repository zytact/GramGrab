export const OPERATIONS = {
  MEDIA_BY_SHORTCODE: {
    doc_id: '8845758582119845',
    url: 'https://www.instagram.com/graphql/query/',
  },
  REELS_MEDIA: {
    query_hash: '45246d3fe16ccc6577e0bd297a5db1ab',
    url: 'https://www.instagram.com/graphql/query/',
  },
} as const;

export const IG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'X-IG-App-ID': '936619743392459',
  'X-Requested-With': 'XMLHttpRequest',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Mode': 'cors',
  Referer: 'https://www.instagram.com/',
} as const;

export const ENDPOINTS = {
  userProfile: 'https://www.instagram.com/api/v1/users/web_profile_info/',
} as const;
