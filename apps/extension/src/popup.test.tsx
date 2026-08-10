import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Popup from './popup';
import * as whatsappCapture from './whatsapp/capture';
import * as whatsappFrameExport from './whatsapp/export';
import { DownloadAcceptedResult } from './download/contracts';

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
  sessionStorage: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
};

globalThis.browser = mockBrowser as typeof globalThis.browser;

describe('Popup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowser.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://www.instagram.com/p/abc123/', active: true, currentWindow: true },
    ]);
    mockBrowser.storage.get.mockResolvedValue({});
    window.history.replaceState({}, '', '/popup.html');
  });

  it('renders main elements', async () => {
    await act(async () => {
      render(<Popup />);
    });
    expect(screen.getByPlaceholderText(/Paste an Instagram URL/i)).toBeDefined();
    expect(screen.getByText('Fetch Media')).toBeDefined();
  });

  it('shows and persists the one-time WhatsApp view-receipt disclosure without capturing', async () => {
    mockBrowser.tabs.query.mockResolvedValueOnce([
      { id: 1, url: 'https://web.whatsapp.com/status', active: true, currentWindow: true },
    ]);
    mockBrowser.storage.get.mockResolvedValueOnce({});
    const user = userEvent.setup();
    await act(async () => render(<Popup />));

    expect(
      await screen.findByText(
        'WhatsApp controls view receipts. GramGrab does not provide anonymous viewing.'
      )
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Capture Visible Status' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(mockBrowser.storage.set).toHaveBeenCalledWith({
        'whatsapp-view-receipt-acknowledged': true,
      })
    );
    expect(screen.getByRole('button', { name: 'Capture Visible Status' })).toBeDefined();
    expect(mockBrowser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('auto-selects WhatsApp only for the exact WhatsApp Web origin', async () => {
    mockBrowser.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://web.whatsapp.com/status', active: true, currentWindow: true },
    ]);
    mockBrowser.storage.get.mockResolvedValue({ 'whatsapp-view-receipt-acknowledged': true });
    await act(async () => render(<Popup />));

    expect(
      (await screen.findByRole('button', { name: 'WhatsApp Status' })).getAttribute('aria-current')
    ).toBe('page');
    expect(screen.queryByText(/Active tab.*WhatsApp Web/i)).toBeNull();
  });

  it('shows WhatsApp Web guidance when WhatsApp Status is selected on another origin', async () => {
    mockBrowser.tabs.query.mockResolvedValue([
      {
        id: 1,
        url: 'https://web.whatsapp.com.evil.example/status',
        active: true,
        currentWindow: true,
      },
    ]);
    const user = userEvent.setup();
    await act(async () => render(<Popup />));

    expect(screen.getByRole('button', { name: 'Instagram' }).getAttribute('aria-current')).toBe(
      'page'
    );
    await user.click(screen.getByRole('button', { name: 'WhatsApp Status' }));

    expect(screen.getByRole('heading', { name: 'Open WhatsApp Web' })).toBeDefined();
    expect(screen.getByText(/Open web\.whatsapp\.com/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Capture Visible Status' })).toBeNull();
    expect(screen.queryByRole('button', { name: /check again/i })).toBeNull();
  });

  it('does not show the acknowledged WhatsApp disclosure again', async () => {
    mockBrowser.tabs.query.mockResolvedValueOnce([
      { id: 1, url: 'https://web.whatsapp.com/status', active: true, currentWindow: true },
    ]);
    mockBrowser.storage.get.mockResolvedValueOnce({ 'whatsapp-view-receipt-acknowledged': true });
    await act(async () => render(<Popup />));

    expect(await screen.findByRole('button', { name: 'Capture Visible Status' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('reuses the media-item UI after capture without silent export or workspace actions', async () => {
    mockBrowser.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://web.whatsapp.com/status', active: true, currentWindow: true },
    ]);
    mockBrowser.storage.get.mockResolvedValue({ 'whatsapp-view-receipt-acknowledged': true });
    const download = vi.fn().mockResolvedValue({
      downloadId: 1,
      filename: 'whatsapp-visible-status-20260101T000000Z.mp4',
    });
    const release = vi.fn();
    const capture = vi.spyOn(whatsappCapture, 'captureWhatsAppVisibleStatus').mockResolvedValue({
      descriptor: {
        captureId: '123e4567-e89b-42d3-a456-426614174000',
        kind: 'video',
        mimeType: 'video/mp4',
        byteLength: 1,
        width: 640,
        height: 480,
        durationMs: 1_000,
        capturedAt: 1,
        retentionDeadline: 60_001,
      },
      snapshot: { objectUrl: () => 'blob:visible-status' },
      filename: 'whatsapp-visible-status-20260101T000000Z.mp4',
      download,
      release,
    } as never);
    const user = userEvent.setup();
    await act(async () => render(<Popup />));

    await user.click(await screen.findByRole('button', { name: 'Capture Visible Status' }));

    expect(await screen.findByRole('heading', { name: 'Visible Status captured' })).toBeDefined();
    expect(screen.getByText(/one photo or video that was visible/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Capture Visible Status' })).toBeNull();
    expect(screen.queryByLabelText('Remove audio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open in tab' })).toBeNull();
    expect(
      document.querySelector('.whatsapp-result-list img, .whatsapp-result-list video')
    ).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Download Visible Status' }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    capture.mockRestore();
  });

  it('keeps the capture operation pending through frame export and starts it on acceptance', async () => {
    mockBrowser.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://web.whatsapp.com/status', active: true, currentWindow: true },
    ]);
    mockBrowser.storage.get.mockResolvedValue({ 'whatsapp-view-receipt-acknowledged': true });
    const capture = vi.spyOn(whatsappCapture, 'captureWhatsAppVisibleStatus').mockResolvedValue({
      descriptor: {
        captureId: '123e4567-e89b-42d3-a456-426614174000',
        kind: 'video',
        mimeType: 'video/mp4',
        byteLength: 1,
        width: 640,
        height: 480,
        durationMs: 1_000,
        capturedAt: 1,
        retentionDeadline: 60_001,
      },
      snapshot: { objectUrl: () => 'blob:visible-status' },
      filename: 'whatsapp-visible-status-20260101T000000Z.mp4',
      download: vi.fn(),
      release: vi.fn(),
    } as never);
    let resolveExport: (() => void) | undefined;
    const frameExport = vi
      .spyOn(whatsappFrameExport, 'exportWhatsAppFrame')
      .mockImplementation(async (_handle, operation) => {
        await new Promise<void>(resolve => {
          resolveExport = resolve;
        });
        return DownloadAcceptedResult.make({
          operationId: operation.operationId,
          requestId: operation.requestId,
          status: 'started',
        });
      });
    const user = userEvent.setup();
    await act(async () => render(<Popup />));

    await user.click(await screen.findByRole('button', { name: 'Capture Visible Status' }));
    await user.click(screen.getByLabelText('Frame'));
    await user.click(screen.getByRole('button', { name: 'Download Visible Status' }));

    await waitFor(() => expect(frameExport).toHaveBeenCalledOnce());
    const captureOptions = capture.mock.calls[0]?.[0];
    const exportOperation = frameExport.mock.calls[0]?.[1];
    expect(exportOperation?.operationId).toBe(captureOptions?.operationId);
    expect(exportOperation?.requestId).toBe(captureOptions?.requestId);
    expect(screen.getByRole('button', { name: /Downloading/i }).getAttribute('aria-busy')).toBe(
      'true'
    );

    if (!resolveExport) throw new Error('Expected frame export to be pending.');
    resolveExport();
    expect(await screen.findByRole('button', { name: 'Download started' })).toBeDefined();
    frameExport.mockRestore();
    capture.mockRestore();
  });

  it.each([
    ['not-visible', 'WHATSAPP_STATUS_NOT_VISIBLE'],
    ['unsupported', 'WHATSAPP_STATUS_UNSUPPORTED'],
  ] as const)(
    'renders %s instructions without a passive check-again action',
    async (reason, code) => {
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, url: 'https://web.whatsapp.com/status', active: true, currentWindow: true },
      ]);
      mockBrowser.storage.get.mockResolvedValue({ 'whatsapp-view-receipt-acknowledged': true });
      const capture = vi
        .spyOn(whatsappCapture, 'captureWhatsAppVisibleStatus')
        .mockRejectedValue(new whatsappCapture.WhatsAppCaptureError(reason));
      const user = userEvent.setup();
      await act(async () => render(<Popup />));

      await user.click(await screen.findByRole('button', { name: 'Capture Visible Status' }));

      expect(await screen.findByText(code)).toBeDefined();
      expect(
        screen.getByText(/Open a photo or video Status|Open a supported photo or video Status/)
      ).toBeDefined();
      expect(screen.getByRole('button', { name: 'Capture Visible Status again' })).toBeDefined();
      expect(screen.queryByRole('button', { name: /check again/i })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Open in Instagram' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Fetch source again' })).toBeNull();
      capture.mockRestore();
    }
  );

  it('dismisses the WhatsApp disclosure without starting an operation or writing History', async () => {
    mockBrowser.tabs.query.mockResolvedValueOnce([
      { id: 1, url: 'https://web.whatsapp.com/status', active: true, currentWindow: true },
    ]);
    mockBrowser.storage.get.mockResolvedValueOnce({});
    const user = userEvent.setup();
    await act(async () => render(<Popup />));

    await user.click(await screen.findByRole('button', { name: 'Not now' }));

    expect(screen.getByRole('button', { name: 'Review notice' })).toBeDefined();
    expect(mockBrowser.storage.set).not.toHaveBeenCalled();
    expect(mockBrowser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('renders a WhatsApp History receipt without a source link or re-download action', async () => {
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message: { type: string }) =>
        message.type === 'GET_DOWNLOAD_HISTORY'
          ? {
              entries: [
                {
                  source: 'whatsapp',
                  mediaKind: 'photo',
                  timestamp: 1,
                  savedFilename: 'whatsapp-visible-status-20260101T000000Z.jpg',
                  outcome: 'accepted',
                },
              ],
            }
          : {}
    );
    const user = userEvent.setup();
    await act(async () => render(<Popup />));
    await user.click(screen.getByRole('button', { name: 'History' }));

    const receipt = await screen.findByText('whatsapp-visible-status-20260101T000000Z.jpg');
    const entry = receipt.closest('.history-entry');
    if (!(entry instanceof HTMLElement)) throw new Error('Expected WhatsApp History entry.');
    expect(within(entry).getByText('WhatsApp')).toBeDefined();
    expect(within(entry).getByText('photo')).toBeDefined();
    expect(within(entry).getByText('accepted')).toBeDefined();
    expect(entry.querySelector('time')).not.toBeNull();
    expect(within(entry).queryByRole('link')).toBeNull();
    expect(within(entry).queryByRole('button', { name: /re-download/i })).toBeNull();
    expect(entry.querySelector('img')).toBeNull();
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

  it('announces history loading errors while the history view is open', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message: { type: string }) =>
        message.type === 'GET_DOWNLOAD_HISTORY' ? { error: 'History is unavailable.' } : {}
    );
    await act(async () => render(<Popup />));

    await user.click(screen.getByRole('button', { name: 'History' }));

    expect((await screen.findByRole('status')).textContent).toBe('History is unavailable.');
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
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('1 item found'));

    const input = screen.getByPlaceholderText(/Paste an Instagram URL/i);
    await user.clear(input);
    await user.type(input, 'https://www.instagram.com/p/new-source/');
    await user.click(screen.getByRole('button', { name: 'Open in tab' }));

    await waitFor(() => {
      expect(mockBrowser.sessionStorage.set).toHaveBeenLastCalledWith(
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

  it('switches to Instants, replaces URL results, and renders attributed media', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        media: [{ url: 'https://media.example/source.jpg', type: 'image', filenameHint: 'source' }],
      })
      .mockResolvedValueOnce({
        acquisition: 'instants',
        media: [
          {
            url: 'https://media.example/instant.jpg',
            type: 'image',
            filenameHint: 'creator_instant_1',
            creatorUsername: 'creator',
          },
        ],
      });
    await act(async () => render(<Popup />));
    await user.click(screen.getByText('Fetch Media'));
    await screen.findByText('source');

    await user.click(screen.getByRole('button', { name: 'Load Instants' }));
    expect(screen.queryByText('source')).toBeNull();

    await waitFor(() => {
      expect(mockBrowser.runtime.sendMessage).toHaveBeenCalledWith({ type: 'FETCH_INSTANTS' });
      expect(screen.getByText('@creator')).toBeDefined();
    });
  });

  it('renders an empty active Instants feed as a successful empty state', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      acquisition: 'instants',
      media: [],
    });
    await act(async () => render(<Popup />));
    await user.click(screen.getByRole('button', { name: 'Load Instants' }));
    expect(await screen.findByText('No active Instants.')).toBeDefined();
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

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('2 items found'));
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
    expect(screen.getByText(/structural media URL metadata/)).toBeDefined();
    expect(screen.queryByText(/schema detail/)).toBeNull();
  });

  it('shows an animated spinner while fetching media', async () => {
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

    const loadingButton = screen.getByRole('button', { name: 'Fetching…' });
    expect(loadingButton.getAttribute('aria-busy')).toBe('true');
    expect(loadingButton.querySelector('.btn-spinner')).not.toBeNull();

    await act(async () => {
      resolveFetch!({ media: [], error: undefined });
    });
  });

  it('shows an animated spinner while downloading media', async () => {
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (message: { type: string }) => {
        if (message.type === 'FETCH_MEDIA')
          return Promise.resolve({
            media: [{ url: 'https://instagram.com/a.jpg', type: 'image', filenameHint: 'first' }],
          });
        if (message.type === 'DOWNLOAD_MEDIA') return new Promise(() => {});
        return Promise.resolve({});
      }
    );

    await act(async () => render(<Popup />));
    await user.click(screen.getByRole('button', { name: 'Fetch Media' }));
    await user.click(await screen.findByRole('button', { name: 'Download 1 Selected' }));

    const loadingButton = screen.getByRole('button', { name: 'Downloading…' });
    expect(loadingButton.getAttribute('aria-busy')).toBe('true');
    expect(loadingButton.querySelector('.btn-spinner')).not.toBeNull();
  });

  it('shows a spinner in the workspace download action', async () => {
    window.history.replaceState(
      {},
      '',
      '/popup.html?surface=workspace&source=https%3A%2F%2Fwww.instagram.com%2Fp%2Fabc123%2F'
    );
    const user = userEvent.setup();
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (message: { type: string }) => {
        if (message.type === 'FETCH_MEDIA')
          return Promise.resolve({
            media: [{ url: 'https://instagram.com/a.jpg', type: 'image', filenameHint: 'first' }],
          });
        if (message.type === 'DOWNLOAD_MEDIA') return new Promise(() => {});
        return Promise.resolve({});
      }
    );

    await act(async () => render(<Popup />));
    await user.click(screen.getByRole('button', { name: 'Fetch Media' }));
    await user.click(await screen.findByRole('button', { name: 'Download selected' }));

    const loadingButton = document.querySelector('.workspace-download');
    expect(loadingButton?.getAttribute('aria-busy')).toBe('true');
    expect(loadingButton?.querySelector('.btn-spinner')).not.toBeNull();
    window.history.replaceState({}, '', '/popup.html');
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

  it('refreshes an expired Instant by media identity before retrying its download', async () => {
    const user = userEvent.setup();
    let instantFetches = 0;
    const submissions: { itemIndex: number; mediaId?: string; url: string }[][] = [];
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message: {
        type: string;
        operations?: {
          operationId: string;
          requestId: string;
          itemIndex: number;
          mediaId?: string;
          url: string;
        }[];
      }) => {
        if (message.type === 'FETCH_INSTANTS') {
          instantFetches++;
          return {
            acquisition: 'instants',
            media:
              instantFetches === 1
                ? [
                    {
                      itemIndex: 0,
                      mediaId: 'instant-1',
                      url: 'https://instagram.com/stale.jpg',
                      type: 'image',
                      filenameHint: 'creator_instant-1',
                    },
                  ]
                : [
                    {
                      itemIndex: 0,
                      mediaId: 'other',
                      url: 'https://instagram.com/other.jpg',
                      type: 'image',
                      filenameHint: 'other',
                    },
                    {
                      itemIndex: 1,
                      mediaId: 'instant-1',
                      url: 'https://instagram.com/fresh.jpg',
                      type: 'image',
                      filenameHint: 'creator_instant-1',
                    },
                  ],
          };
        }
        if (message.type !== 'DOWNLOAD_MEDIA') return {};
        const operations = message.operations ?? [];
        submissions.push(operations);
        return {
          results: operations.map(operation => ({
            operationId: operation.operationId,
            requestId: operation.requestId,
            status: submissions.length === 1 ? 'failed' : 'started',
            ...(submissions.length === 1
              ? {
                  failure: {
                    code: 'BROWSER_DOWNLOAD_NETWORK_FAILED',
                    phase: 'browser-download',
                    scope: 'item',
                  },
                }
              : {}),
          })),
        };
      }
    );

    await act(async () => render(<Popup />));
    await user.click(screen.getByRole('button', { name: 'Load Instants' }));
    await user.click(screen.getByRole('button', { name: 'Download 1 Selected' }));
    await user.click(screen.getByRole('button', { name: 'Refresh feed and retry' }));

    await waitFor(() => expect(screen.getByText(/1 started, 0 failed/)).toBeDefined());
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual([
      expect.objectContaining({
        itemIndex: 1,
        mediaId: 'instant-1',
        url: 'https://instagram.com/fresh.jpg',
      }),
    ]);
  });

  it('announces an Instant refresh error without clearing the existing results', async () => {
    const user = userEvent.setup();
    let instantFetches = 0;
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message: {
        type: string;
        operations?: { operationId: string; requestId: string }[];
      }) => {
        if (message.type === 'FETCH_INSTANTS') {
          instantFetches++;
          return instantFetches === 1
            ? {
                media: [
                  {
                    itemIndex: 0,
                    mediaId: 'instant-1',
                    url: 'https://instagram.com/stale.jpg',
                    type: 'image',
                    filenameHint: 'creator_instant-1',
                  },
                ],
              }
            : { error: 'offline' };
        }
        if (message.type !== 'DOWNLOAD_MEDIA') return {};
        const operation = message.operations?.[0];
        return operation
          ? {
              results: [
                {
                  operationId: operation.operationId,
                  requestId: operation.requestId,
                  status: 'failed',
                  failure: {
                    code: 'BROWSER_DOWNLOAD_NETWORK_FAILED',
                    phase: 'browser-download',
                    scope: 'item',
                  },
                },
              ],
            }
          : { results: [] };
      }
    );

    await act(async () => render(<Popup />));
    await user.click(screen.getByRole('button', { name: 'Load Instants' }));
    await user.click(screen.getByRole('button', { name: 'Download 1 Selected' }));
    await user.click(screen.getByRole('button', { name: 'Refresh feed and retry' }));

    expect(await screen.findByText('GramGrab could not refresh active Instants.')).toBeDefined();
    expect(screen.getByText('creator_instant-1')).toBeDefined();
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

  it('runs a transferred auto-start download only once', async () => {
    const now = Date.now();
    window.history.replaceState({}, '', '/popup.html?surface=workspace');
    mockBrowser.sessionStorage.get.mockResolvedValueOnce({
      'workspace-transfer-v1': {
        version: 3,
        createdAt: now,
        expiresAt: now + 60_000,
        url: 'https://www.instagram.com/p/abc123/',
        fetchedUrl: 'https://www.instagram.com/p/abc123/',
        status: 'done',
        message: 'Ready',
        mediaItems: [
          {
            index: 0,
            type: 'image',
            url: 'https://instagram.com/image.jpg',
            filenameHint: 'image',
            selected: true,
          },
        ],
        frameExportSettings: {},
        removeAudioIndexes: [],
        autoStartDownload: true,
      },
    });
    let downloadCalls = 0;
    (mockBrowser.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (message: {
        type: string;
        operations?: { operationId: string; requestId: string }[];
      }) => {
        if (message.type !== 'DOWNLOAD_MEDIA') return {};
        downloadCalls++;
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
    );

    await act(async () => render(<Popup />));

    await waitFor(() => expect(screen.getByText(/1 started, 0 failed/)).toBeDefined());
    expect(downloadCalls).toBe(1);
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
    expect(screen.getByText(/structural media URL metadata/)).toBeDefined();
    expect(screen.queryByText(/technical detail/)).toBeNull();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.click(trigger);
    const copyButtons = screen.getAllByRole('button', { name: 'Copy diagnostics' });
    const copyButton = copyButtons.at(-1);
    if (!copyButton) throw new Error('Expected the diagnostics copy button.');
    await user.click(copyButton);
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(expect.any(String)));
    const copied = clipboard.writeText.mock.calls.at(-1)?.[0];
    expect(copied).toContain('"diagnosticsVersion": 2');
    expect(copied).not.toContain('technical detail');
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
