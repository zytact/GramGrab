import { ENDPOINTS, IG_HEADERS } from './config';

export async function resolveUsernameToId(username: string): Promise<string | null> {
  const url = `${ENDPOINTS.userProfile}?username=${encodeURIComponent(username)}`;

  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      ...IG_HEADERS,
      Origin: 'https://www.instagram.com',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to resolve username: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    data?: { user?: { id?: string | number } };
    status?: string;
  };

  const userId = data?.data?.user?.id;
  if (!userId) return null;
  return String(userId);
}
