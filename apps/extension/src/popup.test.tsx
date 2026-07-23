import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Popup from './popup';

vi.mock('./styles.css', () => ({}));

const mockBrowser = {
  tabs: {
    query: vi
      .fn()
      .mockResolvedValue([
        { id: 1, url: 'https://www.instagram.com/p/abc123/', active: true, currentWindow: true },
      ]),
    create: vi.fn().mockResolvedValue({ id: 2 }),
    update: vi.fn().mockResolvedValue(undefined),
  },
  runtime: {
    sendMessage: vi.fn(),
    getURL: vi.fn().mockReturnValue('chrome-extension://test/popup.html'),
    getManifest: vi.fn().mockReturnValue({ version: '1.2.3' }),
  },
  windows: { update: vi.fn().mockResolvedValue(undefined) },
  storage: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
};

globalThis.browser = mockBrowser as typeof globalThis.browser;

describe('Popup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/popup.html');
  });

  it('renders main elements', async () => {
    await act(async () => {
      render(<Popup />);
    });
    expect(screen.getByPlaceholderText(/Paste an Instagram URL/i)).toBeDefined();
    expect(screen.getByText('Fetch Media')).toBeDefined();
  });

  it('opens a workspace tab from the header action', async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<Popup />);
    });
    await user.click(screen.getByRole('button', { name: 'Open in tab' }));
    await waitFor(() => {
      expect(mockBrowser.tabs.create).toHaveBeenCalledWith({
        active: true,
        url: expect.stringMatching(
          /^chrome-extension:\/\/test\/popup\.html\?surface=workspace&source=https%3A%2F%2Fwww\.instagram\.com%2Fp%2Fabc123%2F&offer=/
        ),
      });
    });
  });

  it('shows a useful error when the workspace cannot be opened', async () => {
    const user = userEvent.setup();
    mockBrowser.tabs.create.mockRejectedValueOnce(new Error('tabs.create failed'));
    await act(async () => {
      render(<Popup />);
    });
    await user.click(screen.getByRole('button', { name: 'Open in tab' }));
    await waitFor(() => {
      expect(
        screen.getByText(/Could not open the workspace: Error: tabs.create failed/)
      ).toBeDefined();
    });
  });

  it('does not transfer previous results after the draft source changes', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      media: [{ url: 'https://instagram.com/a.jpg', type: 'image', filenameHint: 'a' }],
    });
    await act(async () => {
      render(<Popup />);
    });
    await user.click(screen.getByText('Fetch Media'));
    await waitFor(() => expect(screen.getByText(/1 item found/i)).toBeDefined());

    const input = screen.getByPlaceholderText(/Paste an Instagram URL/i);
    await user.clear(input);
    await user.type(input, 'https://www.instagram.com/p/new-source/');
    await user.click(screen.getByRole('button', { name: 'Open in tab' }));

    await waitFor(() => {
      expect(mockBrowser.storage.set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          'workspace-transfer-v1': expect.objectContaining({
            url: 'https://www.instagram.com/p/new-source/',
            fetchedUrl: '',
            mediaItems: [],
            frameExportSettings: {},
          }),
        })
      );
    });
  });

  it('auto-detects Instagram URL from active tab', async () => {
    await act(async () => {
      render(<Popup />);
    });
    await waitFor(() => {
      expect(screen.getByDisplayValue('https://www.instagram.com/p/abc123/')).toBeDefined();
    });
  });

  it('shows Instagram URL detected message', async () => {
    await act(async () => {
      render(<Popup />);
    });
    await waitFor(() => {
      expect(screen.getByText(/Instagram URL detected/i)).toBeDefined();
    });
  });

  it('calls FETCH_MEDIA when fetch button is clicked', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      media: [{ url: 'https://instagram.com/img.jpg', type: 'image', filenameHint: 'abc123' }],
      error: undefined,
    });

    await act(async () => {
      render(<Popup />);
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://www.instagram.com/p/abc123/')).toBeDefined();
    });

    const fetchButton = screen.getByText('Fetch Media');
    await user.click(fetchButton);

    await waitFor(() => {
      expect(mockBrowser.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/p/abc123/',
      });
    });
  });

  it('displays media items after successful fetch', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      media: [
        { url: 'https://instagram.com/img1.jpg', type: 'image', filenameHint: 'abc123' },
        { url: 'https://instagram.com/img2.jpg', type: 'image', filenameHint: 'abc123' },
      ],
      error: undefined,
    });

    await act(async () => {
      render(<Popup />);
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://www.instagram.com/p/abc123/')).toBeDefined();
    });

    const fetchButton = screen.getByText('Fetch Media');
    await user.click(fetchButton);

    await waitFor(() => {
      expect(screen.getByText(/2 items found — select and download/i)).toBeDefined();
    });
  });

  it('displays error message from fetch', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      media: undefined,
      failure: {
        code: 'SOURCE_USERNAME_UNRESOLVED',
        phase: 'source',
        scope: 'batch',
      },
    });

    await act(async () => {
      render(<Popup />);
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://www.instagram.com/p/abc123/')).toBeDefined();
    });

    const fetchButton = screen.getByText('Fetch Media');
    await user.click(fetchButton);

    await waitFor(() => {
      expect(screen.getAllByText(/Source unavailable/)).not.toHaveLength(0);
    });
    await user.click(screen.getByRole('button', { name: 'Open in Instagram' }));
    expect(mockBrowser.tabs.create).toHaveBeenCalledWith({
      url: 'https://www.instagram.com/p/abc123/',
    });
  });

  it('retains typed source failures for refetch and diagnostics actions', async () => {
    const user = userEvent.setup();
    let fetches = 0;
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message: { type: string }) => {
        if (message.type !== 'FETCH_MEDIA') return {};
        fetches++;
        return fetches === 1
          ? {
              media: undefined,
              failure: {
                code: 'SOURCE_NETWORK_FAILED',
                phase: 'source',
                scope: 'batch',
              },
            }
          : {
              media: undefined,
              failure: {
                code: 'IG_RESPONSE_SHAPE_UNKNOWN',
                phase: 'source',
                scope: 'batch',
                cause: { message: 'schema detail' },
              },
            };
      }
    );
    await act(async () => render(<Popup />));
    await user.click(screen.getByText('Fetch Media'));
    await user.click(screen.getByRole('button', { name: 'Fetch source again' }));
    expect(fetches).toBe(2);
    const diagnostics = await screen.findByRole('button', { name: 'Copy diagnostics' });
    await user.click(diagnostics);
    expect(screen.getByRole('dialog', { name: 'Diagnostics preview' })).toBeDefined();
    expect(screen.getByText(/schema detail/)).toBeDefined();
  });

  it('shows downloading state', async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: unknown) => void;
    const fetchPromise = new Promise(resolve => {
      resolveFetch = resolve;
    });
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockReturnValue(fetchPromise);

    await act(async () => {
      render(<Popup />);
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://www.instagram.com/p/abc123/')).toBeDefined();
    });

    const fetchButton = screen.getByText('Fetch Media');
    await user.click(fetchButton);

    expect(screen.getByText('Fetching…')).toBeDefined();

    await act(async () => {
      resolveFetch!({ media: [], error: undefined });
    });
  });

  it('shows "No media found" when fetch returns empty', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      media: [],
      error: undefined,
    });

    await act(async () => {
      render(<Popup />);
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://www.instagram.com/p/abc123/')).toBeDefined();
    });

    const fetchButton = screen.getByText('Fetch Media');
    await user.click(fetchButton);

    await waitFor(() => {
      expect(screen.getByText('No downloadable media found.')).toBeDefined();
    });
  });

  it('shows "Select All" checkbox when media items are loaded', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      media: [
        { url: 'https://instagram.com/img1.jpg', type: 'image', filenameHint: 'abc123' },
        { url: 'https://instagram.com/img2.jpg', type: 'image', filenameHint: 'def456' },
      ],
      error: undefined,
    });

    await act(async () => {
      render(<Popup />);
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://www.instagram.com/p/abc123/')).toBeDefined();
    });

    const fetchButton = screen.getByText('Fetch Media');
    await user.click(fetchButton);

    await waitFor(() => {
      expect(screen.getByLabelText('Select all')).toBeDefined();
    });
  });

  it('selects all items when clicking "Select All"', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      media: [
        { url: 'https://instagram.com/img1.jpg', type: 'image', filenameHint: 'abc123' },
        { url: 'https://instagram.com/img2.jpg', type: 'image', filenameHint: 'def456' },
      ],
      error: undefined,
    });

    await act(async () => {
      render(<Popup />);
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://www.instagram.com/p/abc123/')).toBeDefined();
    });

    const fetchButton = screen.getByText('Fetch Media');
    await user.click(fetchButton);

    await waitFor(() => {
      expect(screen.getByText(/Download 2 Selected/)).toBeDefined();
    });

    const selectAllCheckbox = screen.getByLabelText('Select all');
    await user.click(selectAllCheckbox);

    await waitFor(() => {
      expect(screen.getByLabelText('Select all')).toBeDefined();
    });
  });

  it('deselects all items when clicking "Select All" again', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      media: [
        { url: 'https://instagram.com/img1.jpg', type: 'image', filenameHint: 'abc123' },
        { url: 'https://instagram.com/img2.jpg', type: 'image', filenameHint: 'def456' },
      ],
      error: undefined,
    });

    await act(async () => {
      render(<Popup />);
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://www.instagram.com/p/abc123/')).toBeDefined();
    });

    const fetchButton = screen.getByText('Fetch Media');
    await user.click(fetchButton);

    await waitFor(() => {
      expect(screen.getByText(/Download 2 Selected/)).toBeDefined();
    });

    const selectAllCheckbox = screen.getByLabelText('Select all');
    await user.click(selectAllCheckbox);

    await waitFor(() => {
      expect(screen.getByText('Download Selected')).toBeDefined();
    });
  });

  it('retries only the failed operation with its captured request and filename', async () => {
    const user = userEvent.setup();
    let downloadCalls = 0;
    const submissions: { operationId: string; requestId: string; filename: string }[][] = [];
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message: {
        type: string;
        operations?: { operationId: string; requestId: string; filename: string }[];
      }) => {
        if (message.type === 'FETCH_MEDIA')
          return {
            media: [
              { url: 'https://instagram.com/a.jpg', type: 'image', filenameHint: 'first' },
              { url: 'https://instagram.com/b.jpg', type: 'image', filenameHint: 'second' },
            ],
          };
        if (message.type !== 'DOWNLOAD_MEDIA') return {};
        const operations = message.operations ?? [];
        submissions.push(operations);
        downloadCalls++;
        return {
          results: operations.map((operation, index) =>
            downloadCalls === 1 && index === 1
              ? {
                  operationId: operation.operationId,
                  requestId: operation.requestId,
                  status: 'failed',
                  failure: {
                    code: 'MEDIA_NETWORK_FAILED',
                    phase: 'media-transfer',
                    scope: 'item',
                  },
                }
              : {
                  operationId: operation.operationId,
                  requestId: operation.requestId,
                  status: 'started',
                }
          ),
        };
      }
    );
    await act(async () => {
      render(<Popup />);
    });
    await user.click(screen.getByText('Fetch Media'));
    await user.click(screen.getByText('Download 2 Selected'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry 1 failed' })).toBeDefined()
    );
    expect(screen.getByText('MEDIA_NETWORK_FAILED')).toBeDefined();
    const firstSubmission = submissions[0]!;
    await user.click(screen.getByRole('button', { name: 'Retry 1 failed' }));
    await waitFor(() => expect(screen.getByText(/2 started, 0 failed/)).toBeDefined());
    expect(submissions).toHaveLength(2);
    expect(submissions[1]?.[0]?.operationId).toBe(firstSubmission[1]?.operationId);
    expect(submissions[1]?.[0]?.requestId).not.toBe(firstSubmission[1]?.requestId);
    expect(submissions[1]?.[0]?.filename).toBe(firstSubmission[1]?.filename);
  });

  it('offers the same failed-item retry in the workspace surface', async () => {
    window.history.replaceState(
      {},
      '',
      '/popup.html?surface=workspace&source=https%3A%2F%2Fwww.instagram.com%2Fp%2Fabc123%2F'
    );
    const user = userEvent.setup();
    let attempts = 0;
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message: {
        type: string;
        operations?: { operationId: string; requestId: string }[];
      }) => {
        if (message.type === 'FETCH_MEDIA')
          return {
            media: [{ url: 'https://instagram.com/a.jpg', type: 'image', filenameHint: 'first' }],
          };
        if (message.type === 'DOWNLOAD_MEDIA') {
          attempts++;
          const operation = message.operations?.[0];
          if (!operation) return { results: [] };
          return {
            results: [
              attempts === 1
                ? {
                    operationId: operation.operationId,
                    requestId: operation.requestId,
                    status: 'failed',
                    failure: {
                      code: 'MEDIA_NETWORK_FAILED',
                      phase: 'media-transfer',
                      scope: 'item',
                    },
                  }
                : {
                    operationId: operation.operationId,
                    requestId: operation.requestId,
                    status: 'started',
                  },
            ],
          };
        }
        return {};
      }
    );
    await act(async () => {
      render(<Popup />);
    });
    await user.click(screen.getByText('Fetch Media'));
    await user.click(screen.getByRole('button', { name: 'Download selected' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry 1 failed' })).toBeDefined()
    );
    await user.click(screen.getByRole('button', { name: 'Retry 1 failed' }));
    await waitFor(() => expect(screen.getByText(/1 started, 0 failed/)).toBeDefined());
    window.history.replaceState({}, '', '/popup.html');
  });

  it('renders a batch storage prerequisite failure and downloads not-attempted originals', async () => {
    window.history.replaceState(
      {},
      '',
      '/popup.html?surface=workspace&source=https%3A%2F%2Fwww.instagram.com%2Fp%2Fabc123%2F'
    );
    class IdleWorker {
      addEventListener(): void {}
      terminate(): void {}
    }
    vi.stubGlobal('Worker', IdleWorker);
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message: {
        type: string;
        operations?: { operationId: string; requestId: string }[];
      }) => {
        if (message.type === 'FETCH_MEDIA')
          return {
            media: [
              { url: 'https://instagram.com/video.mp4', type: 'video', filenameHint: 'clip' },
            ],
          };
        if (message.type === 'DOWNLOAD_MEDIA') {
          const operation = message.operations?.[0];
          return operation
            ? {
                results: [
                  {
                    operationId: operation.operationId,
                    requestId: operation.requestId,
                    status: 'started',
                  },
                ],
              }
            : { results: [] };
        }
        return {};
      }
    );
    const user = userEvent.setup();
    await act(async () => render(<Popup />));
    await user.click(screen.getByText('Fetch Media'));
    await user.click(screen.getByLabelText('Remove audio'));
    await user.click(screen.getByRole('button', { name: 'Download selected' }));
    await waitFor(() => {
      expect(screen.getByText('SILENT_STORAGE_UNAVAILABLE')).toBeDefined();
      expect(screen.getAllByText(/1 not attempted/)).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Download original' })).toBeDefined();
    });
    await user.click(screen.getByRole('button', { name: 'Download original' }));
    await waitFor(() => expect(screen.getByText(/1 started, 0 failed/)).toBeDefined());
    window.history.replaceState({}, '', '/popup.html');
  });

  it('previews diagnostics before copying and restores focus to the trigger', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message: {
        type: string;
        operations?: { operationId: string; requestId: string }[];
      }) => {
        if (message.type === 'FETCH_MEDIA')
          return {
            media: [{ url: 'https://instagram.com/a.jpg', type: 'image', filenameHint: 'a' }],
          };
        const operation = message.operations?.[0];
        return operation
          ? {
              results: [
                {
                  operationId: operation.operationId,
                  requestId: operation.requestId,
                  status: 'failed',
                  failure: {
                    code: 'DOWNLOAD_UNEXPECTED_FAILURE',
                    phase: 'browser-download',
                    scope: 'item',
                    cause: { message: 'technical detail' },
                  },
                },
              ],
            }
          : {};
      }
    );
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    await act(async () => render(<Popup />));
    await user.click(screen.getByText('Fetch Media'));
    await user.click(screen.getByText('Download 1 Selected'));
    const trigger = await screen.findByRole('button', { name: 'Copy diagnostics' });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Diagnostics preview' })).toBeDefined();
    expect(screen.getByText(/technical detail/)).toBeDefined();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.click(trigger);
    const copyButtons = screen.getAllByRole('button', { name: 'Copy diagnostics' });
    const copyButton = copyButtons.at(-1);
    if (!copyButton) throw new Error('Expected the diagnostics copy button.');
    await user.click(copyButton);
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(expect.any(String)));
  });

  it('toggles video selection when its preview is clicked without toggling Frame', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      media: [{ url: 'https://instagram.com/video.mp4', type: 'video', filenameHint: 'clip' }],
      error: undefined,
    });

    await act(async () => {
      render(<Popup />);
    });
    await user.click(screen.getByText('Fetch Media'));

    await waitFor(() => {
      expect(screen.getByText('Frame')).toBeDefined();
    });

    const row = screen.getByText('clip').closest('.media-item');
    const preview = row?.querySelector('video');
    const frameCheckbox = screen.getByLabelText('Frame') as HTMLInputElement;
    const selectionCheckbox = row?.querySelector('.item-checkbox') as HTMLInputElement;

    expect(preview).not.toBeNull();
    expect(frameCheckbox.checked).toBe(false);
    expect(selectionCheckbox.checked).toBe(true);

    await user.click(preview!);

    expect(frameCheckbox.checked).toBe(false);
    expect(selectionCheckbox.checked).toBe(false);
  });

  it('uses an accessible, timestamped frame selector for video exports', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      media: [{ url: 'https://instagram.com/video.mp4', type: 'video', filenameHint: 'clip' }],
      error: undefined,
    });
    await act(async () => {
      render(<Popup />);
    });
    await user.click(screen.getByText('Fetch Media'));
    const preview = document.querySelector('video')!;
    Object.defineProperty(preview, 'duration', { configurable: true, value: 12 });
    await user.click(screen.getByLabelText('Frame'));

    const slider = screen.getByRole('slider', { name: 'Frame timestamp for item 01' });
    expect(slider.getAttribute('aria-valuetext')).toBe('5 seconds');
    expect(screen.getByText('00:05')).toBeDefined();
    fireEvent.change(slider, { target: { value: '6' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('6 seconds');
    fireEvent.change(slider, { target: { value: '0' } });
    await user.click(screen.getByLabelText('Frame'));
    await user.click(screen.getByLabelText('Frame'));
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('0 seconds');
  });
});
