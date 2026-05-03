# Instaext: Living Architecture Document

**Last Updated:** May 2, 2026  

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Core Architecture](#core-architecture)
3. [Module Reference](#module-reference)
4. [Message Flow & Data Shapes](#message-flow--data-shapes)
5. [Build System](#build-system)
6. [Testing Architecture](#testing-architecture)
7. [Design Decisions & Trade-offs](#design-decisions--trade-offs)

---

## System Overview

### What Instaext Is

Instaext is a Manifest V3 browser extension for Chrome and Firefox that downloads Instagram media (posts, reels, stories, highlights, profile pictures) to the user's device. It operates entirely within browser sandbox restrictions and does not require a backend server.

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser Extension (MV3)                   │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐              ┌──────────────────────────┐  │
│  │ Popup UI     │              │  Service Worker          │  │
│  │ (React)      │◄────────────►│  background.ts           │  │
│  │ popup.tsx    │   Messages   │  (694 lines)             │  │
│  │              │              │                          │  │
│  │ • URL input  │              │ • GraphQL queries        │  │
│  │ • Preview    │              │ • Media extraction       │  │
│  │ • Downloads  │              │ • Username resolution    │  │
│  └──────────────┘              │ • Download orchestration │  │
│                                 └──────────────────────────┘  │
│                                         │                     │
│                    ┌────────────────────┼────────────────────┐
│                    │                    │                    │
│         ┌──────────▼─────────┐ ┌────────▼──────┐  ┌────────▼──┐
│         │ Core Modules       │ │ Browser APIs  │  │ Instagram │
│         │ (lib/*.ts)         │ │               │  │ GraphQL   │
│         │                    │ │ • downloads   │  │           │
│         │ • browser.ts       │ │ • storage     │  │ • MEDIA_  │
│         │ • router.ts        │ │ • runtime     │  │   BY_     │
│         │ • graphql.ts       │ │ • tabs        │  │   SHORT   │
│         │ • normalizer.ts    │ │               │  │   CODE    │
│         │ • resolver.ts      │ └───────────────┘  │           │
│         │ • engine.ts        │                    │ • REELS   │
│         │ • config.ts        │                    │   MEDIA   │
│         │ • data-url.ts      │                    │           │
│         └────────────────────┘                    └───────────┘
│                                                                │
└─────────────────────────────────────────────────────────────┘
         │
         ├──► User's Download Folder (browser.downloads.download)
         │
         └──► Instagram.com API (fetch to graphql endpoint)
```

### Key Constraints & Assumptions

- **Manifest V3 only** — No background pages, no eval(), limited APIs
- **No persistent background** — Service worker can be terminated after inactivity
- **Cross-browser support** — Must work on Chrome and Firefox
- **Sandbox isolation** — Cannot access page DOM directly; relies on message passing
- **Instagram session** — Assumes user is logged into Instagram in the browser
- **Network calls** — Must go through browser's fetch API with session cookies

---

## Core Architecture

### Directory Structure

```
instaext/
├── templates/                          # ← Vite root (non-standard placement)
│   ├── popup.html                      # Popup entry point
│   ├── popup.tsx                       # Symlink to ../src/popup.tsx
│   └── background.html                 # Service worker wrapper
│
├── src/                                # Main source code (1,822 lines)
│   ├── background.ts                   # Service worker (694 lines)
│   ├── popup.tsx                       # Popup UI (332 lines)
│   ├── App.tsx                         # Legacy alt. UI (131 lines)
│   ├── styles.css                      # Styles (20 KB)
│   ├── test/
│   │   └── setup.ts                    # Vitest jsdom setup
│   └── lib/                            # Core module library
│       ├── browser.ts                  # Cross-browser API shim
│       ├── router.ts                   # Instagram URL parsing
│       ├── graphql.ts                  # GraphQL query execution
│       ├── normalizer.ts               # Response normalization
│       ├── resolver.ts                 # Username → ID resolution
│       ├── engine.ts                   # Download orchestration
│       ├── config.ts                   # API endpoints & headers
│       ├── data-url.ts                 # Blob/JSON conversion utils
│       ├── *.test.ts                   # Unit tests
│       └── *.test.tsx                  # Component tests
│
├── extension/                          # ← BUILD OUTPUT (git-ignored)
│   ├── chromium/                       # Chrome-specific build
│   ├── firefox/                        # Firefox-specific build
│   └── (both contain: manifest.json, js/, css/, icons/)
│
├── icons/                              # Extension icons
├── scripts/
│   └── postbuild.mjs                   # Post-build manifest generation
│
├── manifest.json                       # Template (static, overwritten)
├── vite.config.ts                      # Vite config (multi-entry)
├── tsconfig.json                       # TypeScript strict mode
├── vitest.config.ts                    # Test config (jsdom)
├── eslint.config.ts                    # Linting rules
└── prettier.config.ts                  # Code formatting rules
```

### Entrypoints

#### 1. Popup (popup.tsx)

**Type:** React component served in an iframe-like popup window  
**Triggered by:** User clicking the extension icon  
**Lifecycle:** Opens, closes, reopens (not persistent)  
**Responsibilities:**
- Accept Instagram URLs from user input or detect from active tab
- Send `FETCH_MEDIA` message to service worker
- Display media previews and metadata
- Allow batch selection
- Download selected items via `DOWNLOAD_MEDIA` message

**Entry flow:**
```
popup.html
  ├── <script type="module" src="./popup.tsx">
  └── Rendered by Vite + React as SPA
      └── ReactDOM.render(<Popup />, document.getElementById('root'))
```

#### 2. Service Worker (background.ts)

**Type:** Manifest V3 service worker (persistent, can be terminated)  
**Triggered by:** Browser startup, extension messages  
**Lifecycle:** Long-running, survives popup close  
**Responsibilities:**
- Listen for messages from popup and content scripts
- Execute GraphQL queries to Instagram
- Extract media metadata and URLs
- Orchestrate downloads
- Provide preview data URLs

**Entry flow:**
```
background.html (Manifest V3 wrapper)
  └── <script type="module" src="../src/background.ts">
      └── background.ts registers browser.runtime.onMessage.addListener()
```

---

## Module Reference

### browser.ts — Cross-Browser API Abstraction

**Purpose:** Unified interface for Chrome and Firefox APIs with fallback for tests.

**Why it exists:** Chrome and Firefox expose browser APIs differently:
- Firefox: Standard `window.browser` (promise-based)
- Chrome: `window.chrome` (callback-based)
- Tests: Neither available; need no-op shim

**How it works:**

```typescript
export const browser = new Proxy({} as BrowserShim, {
  get(_target, prop: string) {
    return (getActiveBrowser() as Record<string, unknown>)[prop];
  },
});

function getActiveBrowser(): BrowserShim {
  const nativeBrowser = globalThis['browser'];  // Firefox
  const chrome = globalThis['chrome'];          // Chrome
  return nativeBrowser ?? (chrome ? buildChromeShim(chrome) : noopShim);
}
```

**Key Features:**
- **Promise-based API** — Wraps Chrome callbacks into Promises
- **Lazy resolution** — Determines implementation at call-time
- **Test support** — Falls back to no-op implementations
- **Exports:**
  - `runtime.sendMessage(msg)` — Send message to service worker
  - `runtime.onMessage.addListener(callback)` — Listen for messages
  - `tabs.query(options)` — Get active tab
  - `downloads.download(options)` — Trigger download
  - `storage.get(keys)` / `storage.set(items)` — Persistent storage

**Data Types:**
```typescript
interface Tab {
  id?: number;
  url?: string;
  active?: boolean;
  windowId?: number;
}

interface DownloadOptions {
  url: string;
  filename?: string;
  saveAs?: boolean;
}
```

**Testing:** Imports in tests receive `noopShim` which stubs all operations.

---

### router.ts — Instagram URL Parsing

**Purpose:** Parse Instagram links and classify content type.

**Why it exists:** Instagram has multiple URL patterns:
- Posts: `instagram.com/p/{shortcode}/`
- Reels: `instagram.com/reel/{shortcode}/`
- Stories: `instagram.com/stories/{username}/`
- Highlights: `instagram.com/stories/highlights/{highlightId}/`
- Profiles: `instagram.com/{username}/`

Must route each to correct GraphQL operation.

**How it works:**

```typescript
export type ContentType = 'post' | 'reel' | 'story' | 'highlight' | 'profile';

export interface ParsedUrl {
  type: ContentType;
  shortcode?: string;       // For posts/reels
  username?: string;        // For stories/profiles
  highlightId?: string;     // For story highlights
  carouselIndex?: number;   // For multi-image posts (optional)
}

export function parseInstagramUrl(url: string): ParsedUrl | null {
  // Returns null if URL doesn't match Instagram domain
  // Extracts type and relevant identifiers via regex
}
```

**Examples:**

| URL | Output |
|-----|--------|
| `instagram.com/p/ABC123def/` | `{ type: 'post', shortcode: 'ABC123def' }` |
| `instagram.com/reel/XYZ789/` | `{ type: 'reel', shortcode: 'XYZ789' }` |
| `instagram.com/stories/jane_doe/` | `{ type: 'story', username: 'jane_doe' }` |
| `instagram.com/stories/highlights/999/` | `{ type: 'highlight', highlightId: '999' }` |
| `instagram.com/jane_doe/` | `{ type: 'profile', username: 'jane_doe' }` |

**Failure modes:**
- Non-Instagram URLs → returns `null`
- Malformed URLs → returns `null`
- Instagram URLs with query params → parsed correctly

**Tests:** `router.test.ts` covers all URL patterns and edge cases.

---

### graphql.ts — Instagram GraphQL Execution

**Purpose:** Execute GraphQL queries to Instagram and handle responses.

**Why it exists:** Instagram public API is not exposed; GraphQL queries are reverse-engineered from the web app.

**How it works:**

```typescript
// Core operations exposed to service worker:
export async function fetchMediaByShortcode(shortcode: string): Promise<MediaItem[]>
export async function fetchReelsMedia(params: {
  reel_ids?: string[];
  highlight_reel_ids?: string[];
}): Promise<MediaItem[]>
export async function fetchProfileInfo(username: string): Promise<Record<string, unknown>>

// Internal implementation:
async function graphqlFetch(
  operationName: string,
  variables: Record<string, unknown>,
  doc_id?: string,
  query_hash?: string
): Promise<unknown>
```

**Instagram API Details:**

```
Endpoint: https://www.instagram.com/graphql/query/

Required Headers:
  X-IG-App-ID: '936619743392459'
  X-Requested-With: XMLHttpRequest
  User-Agent: Mozilla/5.0 ... (Chrome/Firefox user agent string)

Operations:
  - MEDIA_BY_SHORTCODE (doc_id: 8845758582119845)
    - Input: { shortcode: string }
    - Returns: Post or Reel data
  
  - REELS_MEDIA (query_hash: 45246d3fe16ccc6577e0bd297a5db1ab)
    - Input: { reel_ids?: string[], highlight_reel_ids?: string[] }
    - Returns: Story or Highlight data

  - web_profile_info (REST API)
    - Input: ?username={username}
    - Returns: User profile info including profile picture
```

**Data Flow:**

```
parseInstagramUrl(url)
  ↓
Determine operation needed
  ├─ shortcode → MEDIA_BY_SHORTCODE
  └─ username → (resolve to user_id) → REELS_MEDIA
  ↓
graphqlFetch(operationName, variables)
  ↓
POST to https://www.instagram.com/graphql/query/
  ↓
Response: { data: { shortcode_media: { ... } } } or { data: { reels_media: { ... } } }
  ↓
Return to caller (normalizer will extract MediaItem[])
```

**Error Handling:**
- Network errors → thrown to caller
- 400 errors (malformed query) → thrown
- 403/401 (not logged in) → response contains error, handled by normalizer
- Not found (deleted post) → response is null or empty

**Caching:** Currently none; every request hits Instagram API. (Future opportunity: local cache in `browser.storage.local`)

---

### normalizer.ts — Response Normalization

**Purpose:** Transform Instagram API responses into standardized `MediaItem` format.

**Why it exists:** Instagram response structure varies by content type:
- Posts can be single image, video, or carousel (multiple images)
- Reels have different JSON structure
- Profile pictures have fallback hierarchy
- Image/video variants exist at different qualities

Normalizer abstracts these differences.

**Core Type:**

```typescript
export interface MediaItem {
  type: 'image' | 'video';
  url: string;              // Direct download URL
  width?: number;           // Pixels
  height?: number;          // Pixels
  takenAt?: number;         // Unix timestamp (ms)
  filenameHint: string;     // e.g. "ABC123def_GraphImage"
}
```

**Main Functions:**

```typescript
export function normalizeShortcodeMedia(data: unknown): MediaItem[] {
  // Handles posts and reels via shortcode
  // Processes:
  //   - Single images (GraphImage)
  //   - Videos (GraphVideo)
  //   - Carousels (XDTGraphSidecar with edge_media_to_children)
  // Returns highest quality variant for each item
}

export function normalizeReelsMedia(data: unknown): MediaItem[] {
  // Handles stories and highlights
  // Walks reels array within response
  // Extracts media URLs from reel_story_media
}

export function normalizeProfilePicture(
  data: unknown,
  username: string,
  hdUrl?: string
): MediaItem[] {
  // Extract profile picture with fallback chain:
  // 1. Full HD URL from logged-in response (hdUrl param)
  // 2. profile_pic_url_hd (320x320)
  // 3. profile_pic_url (compressed)
}
```

**Example Walkthrough: Post with Carousel**

```
Input response:
{
  data: {
    shortcode_media: {
      __typename: "XDTGraphSidecar",
      display_resources: [...],  // Ignored for sidecars
      edge_media_to_children: {
        edges: [
          { node: { __typename: "GraphImage", display_resources: [...] } },
          { node: { __typename: "GraphVideo", video_resources: [...] } }
        ]
      }
    }
  }
}

Processing:
1. Detect XDTGraphSidecar (carousel)
2. Iterate edge_media_to_children.edges
3. For each child:
   - If GraphImage: extract highest-res from display_resources
   - If GraphVideo: extract highest bitrate from video_resources
4. Return: [
   { type: 'image', url: 'https://...', width: 1080, height: 1350, ... },
   { type: 'video', url: 'https://...', width: 1080, height: 1350, ... }
]
```

**Quality Selection Strategy:**
- **Images:** Highest `width` in `display_resources` array
- **Videos:** Highest `bitrate` in `video_resources` array
- **Rationale:** Instagram serves multiple quality variants; we want the best available

**Filename Generation:**
```typescript
filenameHint = `${shortcode}_${nodeTypeName}`
// Example: "ABC123def_GraphImage"
// Used by download handler to create full filename with extension
```

**Failure Modes:**
- Response missing expected fields → returns `[]` (empty)
- Media already deleted → normalized as `[]`
- Not authenticated → falls back to lower-quality URLs
- Invalid data structure → logged and skipped

---

### resolver.ts — Username to User ID Resolution

**Purpose:** Convert Instagram username → user ID for story/highlight queries.

**Why it exists:** Story and highlight GraphQL queries require the user's numeric ID, not username. This module provides that translation.

**How it works:**

```typescript
export async function resolveUsernameToId(username: string): Promise<string | null> {
  // REST endpoint (not GraphQL):
  // GET https://www.instagram.com/api/v1/users/web_profile_info/?username={username}
  // 
  // Response shape:
  // { data: { user: { id: "123456789", username: "...", ... } } }
  //
  // Returns: user.id or null if user not found
}
```

**Used by:**
```typescript
// In background.ts message handler:
if (parsed.type === 'story' || parsed.type === 'highlight') {
  const userId = await resolveUsernameToId(parsed.username);
  // Then use userId in REELS_MEDIA GraphQL query
}
```

**Error Handling:**
- Network error → throws
- User not found → returns `null`
- Service worker must handle null gracefully

**Performance:** No caching; each request hits Instagram API. (Future: cache in `browser.storage.local`)

---

### engine.ts — Download Orchestration

**Purpose:** High-level API to convert Instagram URL → downloadable media tasks.

**Why it exists:** Coordinates multiple steps:
1. Parse URL
2. Resolve username to ID (if needed)
3. Query Instagram GraphQL
4. Normalize response
5. Return MediaItem[] for UI or download

**Core Function:**

```typescript
export async function buildDownloadTasks(
  url: string,
  carouselIndex?: number
): Promise<DownloadTask[]>

// Returns array of { type: 'image' | 'video', url: string, filename: string }
// carouselIndex: optional; if set, only return that carousel item (1-indexed)
```

**Workflow Example:**

```
buildDownloadTasks('https://instagram.com/p/ABC123def/')
  ↓
parseInstagramUrl('https://instagram.com/p/ABC123def/')
  → { type: 'post', shortcode: 'ABC123def' }
  ↓
fetchMediaByShortcode('ABC123def')
  → POST to graphql/query/ with MEDIA_BY_SHORTCODE operation
  ↓
normalizeShortcodeMedia(response)
  → [ { type: 'image', url: 'https://...', ... }, ... ]
  ↓
Return: [ { type: 'image', url: '...', filename: 'ABC123def_0.jpg' }, ... ]
```

**Responsibilities:**
- Error propagation (throws on network/API errors)
- Filename generation (based on content type, index, timestamp)
- Carousel handling (filter by carouselIndex if provided)

---

### config.ts — API Endpoints & Constants

**Purpose:** Centralize Instagram API constants and headers.

**Contents:**
```typescript
// GraphQL operation metadata
export const OPERATIONS = {
  MEDIA_BY_SHORTCODE: {
    doc_id: '8845758582119845',
    operationName: 'MediaByShortcodeQuery',
  },
  REELS_MEDIA: {
    query_hash: '45246d3fe16ccc6577e0bd297a5db1ab',
    operationName: 'ReelsMediaQuery',
  },
};

// HTTP headers required by Instagram
export const IG_HEADERS = {
  'X-IG-App-ID': '936619743392459',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 ... (browser-specific user agent)',
};

// API endpoints
export const ENDPOINTS = {
  GRAPHQL_QUERY: 'https://www.instagram.com/graphql/query/',
  WEB_PROFILE_INFO: 'https://www.instagram.com/api/v1/users/web_profile_info/',
};
```

**How it's used:**
- Imported by `graphql.ts` and `resolver.ts`
- Defines operation IDs (reverse-engineered from Instagram web app)
- Centralized for easy updates if Instagram changes API

**Maintenance:** If Instagram updates GraphQL operations or headers, update this file only.

---

### data-url.ts — Blob/JSON Conversion Utilities

**Purpose:** Convert media and JSON to data URLs for preview display and debug export.

**Why it exists:** Manifest V3 service workers cannot use `FileReader` API (restricted execution context). Data URLs must be generated using alternative methods.

**Functions:**

```typescript
export async function blobToDataUrl(blob: Blob): Promise<string> {
  // Input: Blob (e.g., from fetch(imageUrl).then(r => r.blob()))
  // Process:
  //   1. blob.arrayBuffer() → Uint8Array
  //   2. Uint8Array → base64 string via btoa()
  //   3. Create data URL: `data:${blob.type};base64,${base64}`
  // Output: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...'
  // Works in: service workers, documents, jsdom
}

export function jsonToDataUrl(value: unknown): string {
  // Input: any JSON-serializable object
  // Process:
  //   1. JSON.stringify(value)
  //   2. Escape as UTF-8 via encodeURIComponent + %uXXXX
  //   3. Create data URL: `data:application/json;base64,${base64}`
  // Output: 'data:application/json;base64,eyJkYXRhIjp7fX0='
  // Used for: debug JSON export
}
```

**Why not FileReader?**
- Manifest V3 service workers have restricted context
- FileReader not available
- Alternative: Uint8Array + btoa() works reliably

**Example Usage:**

```typescript
// In background.ts, GET_PREVIEW_URL handler:
const imageResponse = await fetch(imageUrl);
const blob = await imageResponse.blob();
const dataUrl = await blobToDataUrl(blob);
sendResponse(dataUrl);  // Send to popup for img src

// In popup, debug export:
const debugDataUrl = jsonToDataUrl(mediaItems);
browser.downloads.download({ url: debugDataUrl, filename: 'debug.json' });
```

---

### background.ts — Service Worker Main

**Purpose:** Central message handler and API orchestrator.

**Size:** 694 lines (largest module)

**Responsibilities:**
1. Register message listeners
2. Parse and validate incoming requests
3. Execute appropriate handlers
4. Catch and report errors

**Message Types Handled:**

```typescript
interface Message {
  type: string;
  [key: string]: unknown;
}

// FETCH_MEDIA
// Input: { type: 'FETCH_MEDIA', url: string }
// Process: parseInstagramUrl → graphqlFetch → normalize → return MediaItem[]
// Error: Try different GraphQL ops if first fails

// DOWNLOAD_MEDIA
// Input: { type: 'DOWNLOAD_MEDIA', urls: string[], filenames: string[] }
// Process: For each url/filename pair, call browser.downloads.download()
// Error: Log and continue (partial success OK)

// GET_PREVIEW_URL
// Input: { type: 'GET_PREVIEW_URL', imageUrl: string }
// Process: fetch(imageUrl) → blob → blobToDataUrl()
// Error: Throw (popup will handle)

// DOWNLOAD (legacy, single URL)
// Input: { type: 'DOWNLOAD', url: string, filename: string }
// Process: browser.downloads.download()

// DEBUG_SHAPE
// Input: { type: 'DEBUG_SHAPE', url: string }
// Process: parseInstagramUrl → graphqlFetch → return raw JSON (no normalize)

// DEBUG_SHAPE_JSON
// Input: { type: 'DEBUG_SHAPE_JSON', url: string }
// Process: Similar to DEBUG_SHAPE but export as JSON file
```

**Error Handling Strategy:**

```typescript
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const result = await dispatchMessage(message);
      sendResponse({ success: true, data: result });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return true;  // Allows async response
});
```

**Key Handler: FETCH_MEDIA**

```typescript
async function handleFetchMedia(url: string): Promise<MediaItem[]> {
  const parsed = parseInstagramUrl(url);
  if (!parsed) throw new Error('Invalid Instagram URL');

  switch (parsed.type) {
    case 'post':
    case 'reel':
      return fetchMediaByShortcode(parsed.shortcode!);
    
    case 'story':
    case 'highlight':
      const userId = await resolveUsernameToId(parsed.username!);
      if (!userId) throw new Error('User not found');
      return fetchReelsMedia({
        [parsed.type === 'story' ? 'reel_ids' : 'highlight_reel_ids']: [userId],
      });
    
    case 'profile':
      return normalizeProfilePicture(
        await fetchProfileInfo(parsed.username!),
        parsed.username!
      );
  }
}
```

**State Management:** None (stateless). Each message is independent.

**Performance Considerations:**
- No caching between requests
- Every URL fetch hits Instagram API
- Preview generation (blobToDataUrl) is synchronous but fast
- No request deduplication

---

### popup.tsx — Popup UI Component

**Purpose:** User interface for URL input, media preview, and download control.

**Size:** 332 lines

**State Management:**

```typescript
const [url, setUrl] = useState('');                 // Current URL input
const [status, setStatus] = useState<'idle' | 'fetching' | 'downloading' | 'done' | 'error'>('idle');
const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
const [message, setMessage] = useState('');         // User feedback
const [selectedIndices, setSelectedIndices] = useState(new Set<number>());
```

**Component Tree:**

```
<Popup />
  ├── <Header />
  │   ├── Logo/Title
  │   └── Version
  ├── <UrlInputSection />
  │   ├── <input type="text" value={url} onChange={...} />
  │   └── <button onClick={handleFetch}>Fetch</button>
  ├── <StatusBar status={status} message={message} />
  ├── <MediaListSection>
  │   ├── <Checkbox label="Select All" />
  │   └── {mediaItems.map((item, i) => (
  │       <MediaItemRow key={i}>
  │         <input type="checkbox" checked={selectedIndices.has(i)} />
  │         <img src={previewUrl} alt="preview" />
  │         <span>{item.type}</span>
  │         <span>{item.filenameHint}</span>
  │       </MediaItemRow>
  │     ))}
  ├── <DownloadButton disabled={selectedIndices.size === 0} onClick={handleDownload} />
  └── <Footer />
```

**Key Functions:**

```typescript
async function handleFetch() {
  setStatus('fetching');
  setMessage('Fetching media...');
  try {
    const response = await browser.runtime.sendMessage({
      type: 'FETCH_MEDIA',
      url,
    });
    if (!response.success) throw new Error(response.error);
    setMediaItems(response.data);
    setStatus('idle');
    setMessage(`Found ${response.data.length} media items`);
  } catch (error) {
    setStatus('error');
    setMessage(error.message);
  }
}

async function handleDownload() {
  setStatus('downloading');
  setMessage('Downloading...');
  const selected = mediaItems.filter((_, i) => selectedIndices.has(i));
  try {
    await browser.runtime.sendMessage({
      type: 'DOWNLOAD_MEDIA',
      urls: selected.map(m => m.url),
      filenames: selected.map((m, i) => generateFilename(m, i)),
    });
    setStatus('done');
    setMessage('Download complete!');
  } catch (error) {
    setStatus('error');
    setMessage(error.message);
  }
}

async function getPreviewUrl(imageUrl: string): Promise<string> {
  const response = await browser.runtime.sendMessage({
    type: 'GET_PREVIEW_URL',
    imageUrl,
  });
  return response.data;  // data URL for <img src>
}
```

**Auto-Detect Current Tab:**

On mount, queries active tab and auto-fills URL:
```typescript
useEffect(() => {
  (async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) setUrl(tabs[0].url);
  })();
}, []);
```

**Styling:** All CSS in `styles.css` (20 KB). Uses CSS Grid for layout, custom styling for media grid.

---

### styles.css — Styling

**Size:** 20 KB

**Key Sections:**
- Popup container (width: 600px, height: 800px typical)
- Header styling (logo, version badge)
- URL input styling (text input, button)
- Media grid (CSS Grid, 3 columns, responsive)
- Media item cards (image preview, checkboxes, type badges)
- Download button (prominent, disabled state)
- Status bar (success/error messaging)
- Scrollable container for media list

---

## Message Flow & Data Shapes

### Overall Message Flow Diagram

```
┌─────────────────────────────────────┐
│ User Action in Popup                │
│ (paste URL, click Fetch)            │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────┐
│ browser.runtime.sendMessage({                   │
│   type: 'FETCH_MEDIA',                          │
│   url: 'https://instagram.com/p/ABC123def/'   │
│ })                                              │
└────────────────┬────────────────────────────────┘
                 │
                 │ (sent across extension boundary)
                 │
                 ▼
┌────────────────────────────────────────────────────┐
│ Service Worker (background.ts)                     │
│ browser.runtime.onMessage.addListener(...)         │
│                                                     │
│ 1. Receive message                                 │
│ 2. Call parseInstagramUrl(url)                    │
│    → { type: 'post', shortcode: 'ABC123def' }   │
│ 3. Call fetchMediaByShortcode('ABC123def')       │
│    ↓                                               │
│    fetch('https://instagram.com/graphql/query/', │
│      {                                             │
│        method: 'POST',                            │
│        headers: { 'X-IG-App-ID': '...', ... },   │
│        body: JSON.stringify({                     │
│          variables: { shortcode: 'ABC123def' },  │
│          doc_id: '8845758582119845',             │
│        })                                          │
│      })                                            │
│    → Response: { data: { shortcode_media: {...} } }
│                                                     │
│ 4. Call normalizeShortcodeMedia(response.data)   │
│    → [ { type: 'image', url: '...', ... }, ... ]│
│ 5. Return result                                  │
└────────────────┬────────────────────────────────┘
                 │
                 │ sendResponse(data)
                 │
                 ▼
┌──────────────────────────────────────────────────┐
│ Popup receives response                          │
│ setMediaItems(response.data)                     │
│ Display previews, enable Download button         │
└──────────────────────────────────────────────────┘
```

### Data Shape Examples

#### Input: FETCH_MEDIA Message

```typescript
{
  type: 'FETCH_MEDIA',
  url: 'https://www.instagram.com/p/ABC123def/'
}
```

#### Output: Response Data

```typescript
[
  {
    type: 'image',
    url: 'https://scontent.cdninstagram.com/v/t51.2885-15/...',
    width: 1080,
    height: 1350,
    takenAt: 1704067200000,
    filenameHint: 'ABC123def_GraphImage'
  },
  {
    type: 'video',
    url: 'https://scontent.cdninstagram.com/v/t50.2886-16/...',
    width: 1080,
    height: 1920,
    takenAt: 1704067200000,
    filenameHint: 'ABC123def_GraphVideo'
  }
]
```

#### Input: GET_PREVIEW_URL Message

```typescript
{
  type: 'GET_PREVIEW_URL',
  imageUrl: 'https://scontent.cdninstagram.com/v/t51.2885-15/...'
}
```

#### Output: Preview Data URL

```
data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAIBAQIBAQICAgICAgICAwUDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwDAwwD...
```

#### GraphQL Query Example: MEDIA_BY_SHORTCODE

```json
{
  "operationName": "MediaByShortcodeQuery",
  "variables": {
    "shortcode": "ABC123def"
  },
  "doc_id": "8845758582119845"
}
```

#### GraphQL Response Example (simplified)

```json
{
  "data": {
    "shortcode_media": {
      "__typename": "GraphImage",
      "id": "18098749024567890",
      "display_resources": [
        {
          "src": "https://scontent.cdninstagram.com/...",
          "config_width": 320,
          "config_height": 400
        },
        {
          "src": "https://scontent.cdninstagram.com/...",
          "config_width": 1080,
          "config_height": 1350
        }
      ],
      "taken_at_timestamp": 1704067200
    }
  }
}
```

---

## Build System

### Vite Configuration

**Root:** `templates/` (non-standard, intentional)

**Why?** Popup HTML is in `templates/popup.html`. Vite's root option determines where HTML entry points are found.

**Multi-Entry Build:**

```typescript
// vite.config.ts
export default defineConfig({
  root: 'templates',
  build: {
    outDir: `../extension/${browser}`,  // browser var set by postbuild script
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'templates/popup.html'),
        background: resolve(__dirname, 'src/background.ts'),
      },
      output: {
        entryFileNames: 'js/[name].js',
        assetFileNames: '[ext]/[name].[ext]',
        manualChunks(id) {
          if (id.includes('/src/lib/')) return 'js/bundle';  // Shared code
          return undefined;
        },
      },
    },
  },
});
```

**Build Outputs:**

```
bun run build:chromium
  ↓
Vite runs with root: templates/, browser: chromium
  ├── Bundles templates/popup.html → extension/chromium/popup.html + js/popup.js
  ├── Bundles src/background.ts → extension/chromium/js/background.js
  ├── Extracts src/lib/* → extension/chromium/js/bundle.js
  └── Copies assets (styles.css) → extension/chromium/css/styles.css
  ↓
postbuild.mjs runs
  ├── Generates extension/chromium/manifest.json (Chrome MV3 variant)
  └── Copies icons/ → extension/chromium/icons/
```

### Manifest Generation (postbuild.mjs)

**Why?** Manifest.json must have browser-specific `background` and gecko settings:
- Chrome: `{ service_worker: 'js/background.js', type: 'module' }`
- Firefox: `{ scripts: ['js/background.js'], type: 'module' }` + `browser_specific_settings`

**Process:**

```javascript
const browser = process.env.BROWSER ?? 'chromium';
const outDir = `extension/${browser}`;

// Shared manifest fields
const baseManifest = {
  manifest_version: 3,
  name: 'Instaext',
  version: '1.0.0',
  // ... other fields
};

// Browser-specific background section
const background = browser === 'chromium'
  ? { service_worker: 'js/background.js', type: 'module' }
  : { scripts: ['js/background.js'], type: 'module' };

// Firefox-specific gecko settings
const geckoSettings = browser === 'firefox'
  ? { browser_specific_settings: { gecko: { id: 'instaext@zytact', strict_min_version: '109.0' } } }
  : {};

const manifest = { ...baseManifest, background, ...geckoSettings };

writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));

// Copy icons
mkdir(`${outDir}/icons`, { recursive: true });
copyFile('icons/icon-16.png', `${outDir}/icons/icon-16.png`);
copyFile('icons/icon-48.png', `${outDir}/icons/icon-48.png`);
copyFile('icons/icon-96.png', `${outDir}/icons/icon-96.png`);
```

**Result:**
- `extension/chromium/manifest.json` has Chromium MV3 format (service_worker)
- `extension/firefox/manifest.json` has Firefox MV3 format (scripts) + gecko ID for signed releases
- Both files are ready to load in respective browsers

### Firefox XPI Packaging (package-firefox.mjs)

**Purpose:** Package the built Firefox extension into an XPI file for distribution.

**Process:**

```javascript
const srcDir = 'extension/firefox';

// Verify the Firefox build exists
if (!existsSync(srcDir)) {
  console.error(`${srcDir} not found — run "bun run build:firefox" first`);
  process.exit(1);
}

// Create XPI by zipping the extension directory
execSync(`cd ${srcDir} && zip -r instaext.xpi .`, { stdio: 'inherit' });
```

**Result:** 
- `extension/firefox/instaext.xpi` — a signed or self-signed ZIP archive ready for Firefox installation
- Can be distributed to users or submitted to AMO (Mozilla Add-ons)

**Usage:**
```bash
bun run package:firefox  # Builds Firefox extension and packages as XPI
```

---

### NPM Scripts

```bash
bun run build           # Build both browsers
bun run build:chromium  # Build Chrome only (BROWSER=chromium)
bun run build:firefox   # Build Firefox only (BROWSER=firefox)
bun run dev            # Watch mode for chromium
bun run dev:firefox    # Watch mode for firefox
bun run package:firefox # Build Firefox and create instaext.xpi
bun run test           # Single run, coverage
bun run test:watch    # Watch mode
bun run lint           # Check code style
bun run lint:fix       # Auto-fix linting issues
bun run format         # Auto-format code
bun run format:check   # Check formatting without changing files
```

---

## Testing Architecture

### Vitest Setup

**Environment:** jsdom (DOM in Node.js)

**Test Files:** `src/**/*.test.ts` and `src/**/*.test.tsx`

**Setup:** `src/test/setup.ts` (runs before all tests)

**Configuration:**

```typescript
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
```

### Test Categories

#### Module Tests: router.test.ts

Tests URL parsing logic:
```typescript
describe('parseInstagramUrl', () => {
  it('parses post URLs', () => {
    const result = parseInstagramUrl('https://instagram.com/p/ABC123/');
    expect(result).toEqual({ type: 'post', shortcode: 'ABC123' });
  });

  it('parses reel URLs', () => {
    const result = parseInstagramUrl('https://instagram.com/reel/XYZ789/');
    expect(result).toEqual({ type: 'reel', shortcode: 'XYZ789' });
  });

  it('returns null for non-Instagram URLs', () => {
    const result = parseInstagramUrl('https://google.com');
    expect(result).toBeNull();
  });
});
```

#### Module Tests: data-url.test.ts

Tests blob and JSON conversion:
```typescript
describe('blobToDataUrl', () => {
  it('converts Blob to data URL', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' });
    const dataUrl = await blobToDataUrl(blob);
    expect(dataUrl).toMatch(/^data:text\/plain;base64,/);
  });
});

describe('jsonToDataUrl', () => {
  it('converts JSON to data URL', () => {
    const dataUrl = jsonToDataUrl({ key: 'value' });
    expect(dataUrl).toMatch(/^data:application\/json;base64,/);
  });
});
```

#### Component Tests: popup.test.tsx

Tests React component rendering and behavior:
```typescript
describe('Popup Component', () => {
  it('renders URL input field', () => {
    render(<Popup />);
    const input = screen.getByRole('textbox');
    expect(input).toBeInTheDocument();
  });

  it('fetches media on button click', async () => {
    render(<Popup />);
    const input = screen.getByRole('textbox');
    const fetchButton = screen.getByText('Fetch');
    
    await user.type(input, 'https://instagram.com/p/ABC123/');
    await user.click(fetchButton);
    
    expect(mockBrowserSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'FETCH_MEDIA' })
    );
  });
});
```

### Browser API Mocking

**Setup in `src/test/setup.ts`:**

```typescript
// Mock browser APIs for tests
globalThis.browser = noopShim; // All operations are no-ops
```

**Why:** Tests cannot access real Chrome/Firefox APIs. Mocking allows tests to run in Node.js + jsdom without errors.

---

## Design Decisions & Trade-offs

### 1. **No Backend Server**

**Decision:** Instaext operates entirely within the browser extension sandbox. No backend required.

**Rationale:**
- Users' data never leaves their device
- Simplifies deployment (no server to maintain)
- Works offline for download operations
- Reduces CORS complexity

**Trade-off:** Cannot cache across browsers/devices. Every URL fetch hits Instagram API.

---

### 2. **Proxy-Based Browser API Abstraction**

**Decision:** Use JavaScript Proxy to dynamically resolve browser API implementation.

**Rationale:**
```typescript
const browser = new Proxy({}, {
  get(_target, prop: string) {
    return (getActiveBrowser() as any)[prop];
  },
});
```

**Benefits:**
- Single import across popup and service worker
- Lazy resolution: Chrome vs Firefox detected at call-time
- Testable: Falls back to no-op shim in tests
- No if-statements at every call site

**Alternative Considered:** Separate `browser-chrome.ts` and `browser-firefox.ts` with conditional imports.
- **Rejected:** More imports, harder to test, no real benefit over Proxy.

---

### 3. **No FileReader in Service Worker**

**Decision:** Use `Uint8Array` + `btoa()` instead of FileReader for blob-to-dataURL conversion.

**Rationale:**
- Manifest V3 service workers have restricted execution context
- FileReader API not available
- Uint8Array + btoa() works reliably in all contexts (service workers, documents, jsdom)

**Code:**
```typescript
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(buffer);
  const base64 = btoa(String.fromCharCode(...uint8));
  return `data:${blob.type};base64,${base64}`;
}
```

**Alternative Considered:** Use FileReader (simpler API).
- **Rejected:** Not available in MV3 service workers.

---

### 4. **GraphQL Operations Hardcoded**

**Decision:** Doc IDs and query hashes are hardcoded in `config.ts`.

**Rationale:**
- Instagram doesn't expose a public GraphQL API schema
- Operation IDs are reverse-engineered from Instagram web app
- Hardcoding is the only reliable approach
- Centralized in one file for easy updates

**Trade-off:** If Instagram changes operation IDs, extension breaks until updated.

**Mitigation:** 
- Monitor Instagram web app changes
- Consider PR to publish new IDs when they change
- Could scrape operation IDs from Instagram HTML as fallback (future work)

---

### 5. **Synchronous Normalizer Functions**

**Decision:** `normalizeShortcodeMedia()`, `normalizeReelsMedia()`, etc. are synchronous.

**Rationale:**
- Normalization is pure data transformation, no I/O
- No reason to make it async
- Simpler call sites: `const items = normalize(data)` not `await normalize(data)`

**Data structures extracted are immutable** (no mutations during normalization).

---

### 6. **Vite Root in `templates/`**

**Decision:** Vite's root is `templates/` instead of project root.

**Rationale:**
- Popup HTML entry point lives in `templates/popup.html`
- Vite requires HTML entry points to be in root directory
- Alternatively could symlink popup.html to project root, but `templates/` is clearer

**Impact:**
- Import paths from popup use relative `../../src/lib`
- Scripts in `scripts/postbuild.mjs` must resolve paths relative to project root
- Configuration is explicit: `root: 'templates'` in vite.config.ts

---

### 7. **Per-Browser Manifest Generation**

**Decision:** Manifest.json is generated post-build with browser-specific fields.

**Rationale:**
- Chrome MV3 uses `service_worker` field
- Firefox MV3 uses `scripts` field
- Cannot use same manifest for both
- Post-build generation is cleanest approach

**Alternative Considered:** Conditional webpack loaders or separate manifest files.
- **Rejected:** Over-complicated; postbuild.mjs is simpler.

---

### 8. **No State Persistence**

**Decision:** No caching of usernames-to-IDs, media URLs, or other data between requests.

**Rationale:**
- Keeps service worker simple and stateless
- Avoids cache invalidation logic
- Reduces memory footprint
- Every fetch gets fresh data (important for frequently-updated profiles)

**Trade-off:** Every URL fetch hits Instagram API. Users cannot work offline after fetching.

**Future Improvement:** Cache usernames in `browser.storage.local` with expiration.

---

### 9. **Single-File Service Worker**

**Decision:** All service worker logic in one file (`background.ts`, 694 lines).

**Rationale:**
- Service workers should be small and focused
- Can be split later if grows beyond ~1000 lines
- Simpler mental model: one file, one `onMessage` listener

**Organization:** All message handlers in one file, delegated to lib modules.

---

### 10. **React for Popup UI**

**Decision:** Popup UI built with React (19.2.5).

**Rationale:**
- State management (media items, selected indices, status)
- Component reusability
- Testing support via React Testing Library
- Vite + React plugin provides fast dev experience

**Alternative Considered:** Plain HTML + vanilla JS.
- **Rejected:** Would need manual state sync, event binding, DOM updates. React abstracts this well.

---

## Failure Modes & Error Handling

### Network Errors

**Scenario:** Instagram API unreachable or returns 500.

**Handling:**
```typescript
try {
  const response = await graphqlFetch(...);
} catch (error) {
  // Thrown to background.ts message handler
  // Message handler catches and sends error response to popup
  sendResponse({ success: false, error: error.message });
  // Popup displays error in red message bar
}
```

**User sees:** "Failed to fetch media: Network error" or similar.

### User Not Authenticated

**Scenario:** User not logged into Instagram in the browser.

**Handling:**
- Instagram still allows queries but with lower-quality URLs
- Normalizer falls back through hierarchy:
  ```typescript
  1. profile_pic_url_hd (high-res)
  2. profile_pic_url (compressed)
  3. Empty URL or error
  ```

**User sees:** Preview images and videos, but may be lower quality.

### Invalid Instagram URL

**Scenario:** User pastes non-Instagram URL or malformed URL.

**Handling:**
```typescript
const parsed = parseInstagramUrl(url);
if (!parsed) throw new Error('Invalid Instagram URL');
```

**User sees:** Error message in red bar.

### Media Deleted

**Scenario:** Post/reel/story was deleted between fetch and download.

**Handling:**
```typescript
const media = normalizeShortcodeMedia(response);
if (media.length === 0) throw new Error('Media not found');
```

**User sees:** "Media not found" error.

### Carousel Out-of-Range

**Scenario:** User specifies `carouselIndex: 10` but carousel has only 3 images.

**Handling:**
```typescript
const mediaItems = normalizeShortcodeMedia(response);
if (carouselIndex && carouselIndex > mediaItems.length) {
  throw new Error(`Index ${carouselIndex} out of range`);
}
```

**User sees:** Error message.

### Service Worker Terminated

**Scenario:** Browser terminates service worker due to inactivity.

**Handling:**
- Manifest V3 allows this
- Next message to `browser.runtime.sendMessage()` will wake service worker
- No error to user (transparent)

**User sees:** Slight delay in fetching (service worker wake-up time).

### Download Failed

**Scenario:** `browser.downloads.download()` fails (disk full, permission denied, etc.).

**Handling:**
```typescript
try {
  await browser.downloads.download({ url, filename });
} catch (error) {
  // Continue downloading next item; user sees partial download success
}
```

**User sees:** Browser's download failure notification (OS-level).

---

## Performance Characteristics

### Time Complexity

- **URL parsing:** O(1) — regex match
- **GraphQL fetch:** O(1) — single network call
- **Response normalization:** O(n) where n = number of carousel items (typically 1-10)
- **Preview generation (blobToDataUrl):** O(n) where n = image byte size

### Memory Usage

- **Service worker:** Minimal (~1-2 MB) — no caching, short-lived objects
- **Popup:** ~5-10 MB — React component tree + media item array
- **Service worker service pack:** < 100 KB (minified + gzipped)
- **Popup bundle:** < 50 KB (minified + gzipped)

### Network Usage

- **Per fetch:** 1 GraphQL request (~5-10 KB response)
- **Per download:** 1 image/video (varies, typically 100 KB - 50 MB)

### Latency

- **Parse URL:** < 1 ms
- **Fetch media list:** 200-500 ms (network + Instagram processing)
- **Generate preview:** 50-200 ms (depends on image size)
- **Download media:** 1-30 sec (depends on file size and bandwidth)

---

## Development Workflow

### Local Setup

```bash
# Install dependencies
bun install

# Start dev server (watch mode, chromium)
bun run dev

# In browser:
# 1. Go to chrome://extensions/
# 2. Enable "Developer mode" (top right)
# 3. Click "Load unpacked"
# 4. Select /extension/chromium/
# 5. Open Instagram in browser, use extension popup
```

### Making Changes

```bash
# Watch mode rebuilds automatically
bun run dev

# Reload extension in browser (⊙ icon on extension card)
```

### Running Tests

```bash
# Single run
bun run test

# Watch mode
bun run test:watch

# Debugging
bun run test -- --inspect-brk
```

### Linting

```bash
# Check for issues
bun run lint

# Auto-fix
bun run lint:fix

# Format code
bun run format
```

### Committing

```bash
# Pre-commit hooks (via husky) auto-run linting
git add .
git commit -m "Add feature X"
# → husky runs lint-staged → eslint + prettier
# → If fails, fix and re-commit
```

---

## Debugging Tips

### Service Worker Debugging

```typescript
// In background.ts, add logging
console.log('Received message:', message);

// Inspect logs:
// 1. Go to chrome://extensions/
// 2. Find Instaext extension
// 3. Click "Inspect views" → "service worker"
// 4. Console tab shows logs
```

### GraphQL Response Inspection

```typescript
// Use DEBUG_SHAPE message type
await browser.runtime.sendMessage({
  type: 'DEBUG_SHAPE',
  url: 'https://instagram.com/p/ABC123/'
});

// Returns raw GraphQL response (no normalization)
// Log to console or export as JSON for inspection
```

### Network Inspection

```typescript
// Chromium DevTools (F12) → Network tab
// Filter by "instagram.com"
// Check GraphQL requests:
//   POST /graphql/query/
//   Headers: X-IG-App-ID, X-Requested-With
//   Response: JSON with media data
```

### Service Worker Lifecycle

```typescript
// Manifest V3 rules:
// - Service worker wakes on message, timeout after ~5 min inactivity
// - Each message gets fresh context (no persistent memory)
// - Can store data in browser.storage.* APIs (persists across wake/sleep)

// Check service worker state:
// chrome://extensions/ → Instaext → "Inspect views"
// See "Active" or "Inactive" status
```

---

