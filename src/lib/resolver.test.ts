import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveUsernameToId } from './resolver';

globalThis.fetch = vi.fn() as unknown as typeof fetch;

describe('resolveUsernameToId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves username to id successfully', async () => {
    const mockResponse = {
      data: {
        user: {
          id: '123456789',
        },
      },
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await resolveUsernameToId('testuser');
    expect(result).toBe('123456789');
  });

  it('returns null when user id is missing', async () => {
    const mockResponse = {
      data: {},
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await resolveUsernameToId('testuser');
    expect(result).toBeNull();
  });

  it('returns null when user object is missing', async () => {
    const mockResponse = {
      data: {},
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await resolveUsernameToId('nonexistent');
    expect(result).toBeNull();
  });

  it('throws when response is not ok', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(resolveUsernameToId('testuser')).rejects.toThrow(
      'Failed to resolve username: 404 Not Found'
    );
  });

  it('converts numeric id to string', async () => {
    const mockResponse = {
      data: {
        user: {
          id: 123456789,
        },
      },
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await resolveUsernameToId('testuser');
    expect(result).toBe('123456789');
    expect(typeof result).toBe('string');
  });

  it('sends correct URL and headers', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { user: { id: '123' } } }),
    });

    await resolveUsernameToId('testuser');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    if (typeof url !== 'string') throw new Error('Expected fetch to be called with a URL');
    if (!options) throw new Error('Expected fetch to be called with options');
    expect(url).toContain('web_profile_info');
    expect(url).toContain('username=testuser');
    expect(options.headers).toBeDefined();
    expect(options.credentials).toBe('include');
  });

  it('encodes special characters in username', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { user: { id: '123' } } }),
    });

    await resolveUsernameToId('user.name');

    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    if (typeof url !== 'string') throw new Error('Expected fetch to be called with a URL');
    expect(url).toContain('username=user.name');
  });
});
