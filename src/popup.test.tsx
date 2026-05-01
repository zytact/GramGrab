import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
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
  },
  runtime: {
    sendMessage: vi.fn(),
  },
};

global.browser = mockBrowser;

describe('Popup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders main elements', async () => {
    await act(async () => {
      render(<Popup />);
    });
    expect(screen.getByPlaceholderText(/Paste Instagram URL/i)).toBeDefined();
    expect(screen.getByText('Fetch Media')).toBeDefined();
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
      error: 'Could not resolve username',
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
      expect(screen.getByText('Could not resolve username')).toBeDefined();
    });
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
});
