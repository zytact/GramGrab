<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GramGrab architecture</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #172033;
        --muted: #58657d;
        --line: #d9dfeb;
        --paper: #f7f9fc;
        --card: #ffffff;
        --blue: #315de8;
        --blue-soft: #edf2ff;
        --teal: #147d77;
        --teal-soft: #e9f7f5;
        --amber: #9a5b13;
        --amber-soft: #fff4df;
        --rose: #a23b55;
        --rose-soft: #fff0f3;
        --shadow: 0 16px 42px rgba(33, 53, 91, 0.08);
      }
      * { box-sizing: border-box; }
      body { margin: 0; color: var(--ink); background: var(--paper); font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      a { color: var(--blue); }
      code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      code { color: #173f90; font-size: 0.92em; }
      .shell { max-width: 1220px; margin: 0 auto; padding: 32px 22px 72px; }
      .hero { padding: 38px; border: 1px solid #cbd6ef; border-radius: 26px; background: linear-gradient(135deg, #eef3ff 0%, #fff 57%, #eaf8f5 100%); box-shadow: var(--shadow); }
      .eyebrow { margin: 0 0 10px; color: var(--blue); font-size: 0.78rem; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
      h1, h2, h3 { line-height: 1.18; }
      h1 { max-width: 820px; margin: 0; font-size: clamp(2.2rem, 5vw, 4.6rem); letter-spacing: -0.055em; }
      .lede { max-width: 820px; margin: 18px 0 0; color: #44516a; font-size: 1.12rem; }
      .meta { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 25px; }
      .pill { display: inline-flex; align-items: center; padding: 5px 11px; border: 1px solid #c9d5ee; border-radius: 999px; background: rgba(255,255,255,.8); color: #33456c; font-size: .8rem; font-weight: 700; }
      .layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 26px; margin-top: 26px; }
      nav { position: sticky; top: 18px; align-self: start; padding: 18px; border: 1px solid var(--line); border-radius: 18px; background: var(--card); box-shadow: 0 8px 24px rgba(33,53,91,.05); }
      nav strong { display: block; margin-bottom: 12px; font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; }
      nav a { display: block; padding: 7px 0; color: var(--muted); font-size: .9rem; text-decoration: none; }
      nav a:hover { color: var(--blue); }
      main { min-width: 0; }
      section { margin-bottom: 24px; padding: 30px; border: 1px solid var(--line); border-radius: 22px; background: var(--card); box-shadow: 0 8px 26px rgba(33,53,91,.04); }
      section > h2 { margin: 0 0 18px; color: #263c72; font-size: .9rem; letter-spacing: .14em; text-transform: uppercase; }
      h3 { margin: 22px 0 8px; font-size: 1.17rem; }
      p { margin: 10px 0; }
      .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px; }
      .grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 15px; }
      .card { padding: 18px; border: 1px solid var(--line); border-radius: 15px; background: #fbfcff; }
      .card h3 { margin-top: 0; }
      .card p:last-child { margin-bottom: 0; }
      .callout { margin: 18px 0; padding: 16px 18px; border-left: 4px solid var(--blue); border-radius: 10px; background: var(--blue-soft); }
      .callout.teal { border-color: var(--teal); background: var(--teal-soft); }
      .callout.amber { border-color: var(--amber); background: var(--amber-soft); }
      .callout.rose { border-color: var(--rose); background: var(--rose-soft); }
      .label { color: var(--muted); font-size: .77rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
      .diagram { overflow-x: auto; margin: 20px 0 5px; padding: 12px; border: 1px solid var(--line); border-radius: 16px; background: #fbfcff; }
      svg { display: block; width: 100%; min-width: 720px; height: auto; }
      .node { fill: #fff; stroke: #9fb0d2; stroke-width: 1.5; }
      .node-blue { fill: var(--blue-soft); stroke: #7e9ce9; }
      .node-teal { fill: var(--teal-soft); stroke: #71bcb6; }
      .node-amber { fill: var(--amber-soft); stroke: #d9ad70; }
      .svg-title { fill: var(--ink); font: 700 15px ui-sans-serif, system-ui, sans-serif; }
      .svg-sub { fill: var(--muted); font: 12px ui-sans-serif, system-ui, sans-serif; }
      .arrow { fill: none; stroke: #7285aa; stroke-width: 2; marker-end: url(#arrow); }
      table { width: 100%; border-collapse: collapse; margin: 14px 0 4px; font-size: .94rem; }
      th, td { padding: 11px 12px; border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; }
      th { color: #354a7d; background: #f5f7fc; font-size: .78rem; letter-spacing: .07em; text-transform: uppercase; }
      tr:last-child td { border-bottom: 0; }
      pre { overflow-x: auto; margin: 14px 0 4px; padding: 16px; border-radius: 13px; background: #172033; color: #e8eefc; font-size: .82rem; line-height: 1.55; }
      .path { display: inline-block; margin-top: 4px; padding: 2px 7px; border-radius: 5px; background: #eef1f8; color: #314367; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .84rem; }
      .sequence { display: grid; grid-template-columns: 112px 1fr; gap: 0 15px; margin-top: 15px; }
      .sequence > div { padding: 11px 0; border-bottom: 1px solid var(--line); }
      .sequence .actor { color: #3659b2; font-weight: 800; }
      footer { margin-top: 28px; color: var(--muted); font-size: .88rem; }
      @media (max-width: 850px) {
        .layout { grid-template-columns: 1fr; }
        nav { position: static; }
        .grid-2, .grid-3 { grid-template-columns: 1fr; }
        .hero, section { padding: 23px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="hero">
        <p class="eyebrow">GramGrab / internal reference</p>
        <h1>Architecture that follows the extension's real runtime boundaries.</h1>
        <p class="lede">GramGrab is a Manifest V3 browser extension with a React popup, a background worker, strict Instagram response decoding, and explicit workflows for downloads, history, workspace handoff, and media transformation.</p>
        <div class="meta">
          <span class="pill">TOP LEVEL last updated: 2026-07-17</span>
          <span class="pill">Chrome + Firefox MV3</span>
          <span class="pill">No content scripts</span>
          <span class="pill">Effect schemas at the network boundary</span>
        </div>
      </header>

      <div class="layout">
        <nav aria-label="Architecture sections">
          <strong>On this page</strong>
          <a href="#what-it-is">WHAT IT IS</a>
          <a href="#how-it-works">HOW IT WORKS</a>
          <a href="#why">WHY IT WAS BUILT THIS WAY</a>
          <a href="#data-shapes">DATA SHAPES</a>
          <a href="#dependencies">DEPENDENCIES AND ASSUMPTIONS</a>
          <a href="#failure-modes">FAILURE MODES</a>
          <a href="#tests">TESTS AND EVALUATIONS</a>
        </nav>

        <main>
          <section id="what-it-is">
            <h2>WHAT IT IS</h2>
            <p>GramGrab turns an Instagram URL into normalized media items and then into browser download operations. The extension has one UI bundle and one background bundle. The UI runs in the popup or in a dedicated workspace tab; the worker owns network access, browser downloads, context menus, and durable storage.</p>
            <div class="grid-3">
              <article class="card">
                <p class="label">UI entry</p>
                <h3><span class="path">templates/popup.html</span></h3>
                <p>Loads <span class="path">templates/popup.tsx</span>, which mounts <span class="path">src/popup.tsx</span>. The same React surface detects popup versus workspace mode from the URL.</p>
              </article>
              <article class="card">
                <p class="label">Worker entry</p>
                <h3><span class="path">src/background.ts</span></h3>
                <p>Bundled directly as <span class="path">js/background.js</span>. It registers context-menu and message listeners synchronously as the worker module starts.</p>
              </article>
              <article class="card">
                <p class="label">Build boundary</p>
                <h3><span class="path">scripts/postbuild.mjs</span></h3>
                <p>Creates browser-specific manifests. Chromium receives a module <code>service_worker</code>; Firefox receives module <code>scripts</code> plus Gecko metadata.</p>
              </article>
            </div>
            <div class="callout teal"><strong>Trust boundary.</strong> There is no content script and no application backend. The worker makes requests to Instagram and its media CDN using the extension's host permissions and the browser session. Durable local data is limited to validated history and short-lived workspace transfer state.</div>
          </section>

          <section id="how-it-works">
            <h2>HOW IT WORKS</h2>
            <p>The normal path is a message-driven pipeline. URL canonicalization happens before a request is made, API responses cross an Effect Schema boundary, and downloads are tracked as operations so accepted, failed, skipped, and not-attempted outcomes remain distinct.</p>
            <figure class="diagram">
              <svg viewBox="0 0 980 300" role="img" aria-labelledby="flow-title flow-desc">
                <title id="flow-title">GramGrab runtime flow</title>
                <desc id="flow-desc">The popup or context menu sends a message to the background dispatcher. The dispatcher canonicalizes an Instagram target, fetches and decodes data, normalizes media, and returns it to the UI. Download operations then flow to browser downloads and local history.</desc>
                <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#7285aa" /></marker></defs>
                <rect class="node node-blue" x="20" y="106" width="160" height="70" rx="13" />
                <text class="svg-title" x="100" y="136" text-anchor="middle">Popup / workspace</text>
                <text class="svg-sub" x="100" y="157" text-anchor="middle">src/popup.tsx</text>
                <rect class="node" x="220" y="106" width="174" height="70" rx="13" />
                <text class="svg-title" x="307" y="136" text-anchor="middle">Message dispatcher</text>
                <text class="svg-sub" x="307" y="157" text-anchor="middle">background.ts</text>
                <rect class="node node-teal" x="438" y="32" width="174" height="70" rx="13" />
                <text class="svg-title" x="525" y="62" text-anchor="middle">Canonicalize target</text>
                <text class="svg-sub" x="525" y="83" text-anchor="middle">workspace/contracts.ts</text>
                <rect class="node node-teal" x="438" y="136" width="174" height="70" rx="13" />
                <text class="svg-title" x="525" y="166" text-anchor="middle">Fetch + decode</text>
                <text class="svg-sub" x="525" y="187" text-anchor="middle">Effect + strict schemas</text>
                <rect class="node node-teal" x="438" y="240" width="174" height="45" rx="13" />
                <text class="svg-title" x="525" y="268" text-anchor="middle">Normalize media</text>
                <rect class="node node-amber" x="660" y="68" width="145" height="70" rx="13" />
                <text class="svg-title" x="732" y="98" text-anchor="middle">Downloads API</text>
                <text class="svg-sub" x="732" y="119" text-anchor="middle">max 3 concurrent</text>
                <rect class="node node-amber" x="660" y="174" width="145" height="70" rx="13" />
                <text class="svg-title" x="732" y="204" text-anchor="middle">Local history</text>
                <text class="svg-sub" x="732" y="225" text-anchor="middle">accepted only</text>
                <rect class="node" x="853" y="121" width="107" height="70" rx="13" />
                <text class="svg-title" x="906" y="151" text-anchor="middle">Recovery UI</text>
                <text class="svg-sub" x="906" y="172" text-anchor="middle">typed actions</text>
                <path class="arrow" d="M180 141 H220" /><path class="arrow" d="M394 141 H438" />
                <path class="arrow" d="M525 106 V136" /><path class="arrow" d="M525 206 V240" />
                <path class="arrow" d="M612 163 H660 V103" /><path class="arrow" d="M612 163 H660 V209" />
                <path class="arrow" d="M805 103 H853 V140" /><path class="arrow" d="M805 209 H853 V172" />
                <path class="arrow" d="M438 262 H394 V176" />
              </svg>
              <figcaption>One dispatcher coordinates the request path. The UI receives normalized values and operation results, not raw Instagram response objects.</figcaption>
            </figure>

            <h3>Request and response lifecycle</h3>
            <div class="sequence">
              <div class="actor">UI</div><div>Canonicalizes and sends <code>FETCH_MEDIA</code> with a candidate Instagram URL. Active-tab detection and context-menu commands use the same canonical URL rules.</div>
              <div class="actor">Worker</div><div>Routes by message type. For media fetches, it selects the target-specific configured protocol requests, retries supported transient failures, decodes through the matching strict schema, and normalizes known media variants.</div>
              <div class="actor">Worker</div><div>Reads history to attach per-item markers. The response contains stable indexes, optional media IDs, safe filename hints, preview URLs, dimensions, and a typed failure when recovery is possible.</div>
              <div class="actor">UI</div><div>Renders previews and selection controls. Frame export fetches a video blob and extracts a JPEG in the UI; silent-video export moves the batch into a workspace when it needs the worker-backed media pipeline.</div>
              <div class="actor">Worker</div><div>Receives direct operations, caps browser download concurrency at three, records only accepted downloads, and returns a correlated result for every operation.</div>
            </div>

            <h3>Message surface</h3>
            <table>
              <thead><tr><th>Message</th><th>Owner</th><th>Purpose</th></tr></thead>
              <tbody>
                <tr><td><code>FETCH_MEDIA</code></td><td>Worker</td><td>Fetch and normalize post, reel, story, highlight, or profile media.</td></tr>
                <tr><td><code>GET_PREVIEW_URL</code></td><td>Worker</td><td>Fetch a fallback data URL when a CDN preview cannot load directly.</td></tr>
                <tr><td><code>FETCH_VIDEO_BLOB</code></td><td>Worker</td><td>Fetch a service-worker-safe data URL for frame metadata and extraction.</td></tr>
                <tr><td><code>DOWNLOAD_MEDIA</code></td><td>Worker</td><td>Start direct browser downloads and append accepted history records.</td></tr>
                <tr><td>History messages</td><td>Worker + storage</td><td>Read, redownload, delete, and clear local history.</td></tr>
                <tr><td>Export messages</td><td>Worker + UI</td><td>Record frame or silent exports after the derived file is created.</td></tr>
                <tr><td>Diagnostics messages</td><td>Worker + UI</td><td>Fetch a raw shape for debugging and download a user-approved JSON diagnostic.</td></tr>
              </tbody>
            </table>
          </section>

          <section id="why">
            <h2>WHY IT WAS BUILT THIS WAY</h2>
            <p>These decisions are visible in the implementation and tests. They reduce browser variance and keep Instagram's undocumented response shape at one explicit boundary.</p>
            <div class="grid-2">
              <article class="card"><h3>No content scripts</h3><p>The extension uses the active-tab URL, context-menu metadata, and host-permission requests. It does not inject code into Instagram pages, which keeps the permission and lifecycle model smaller and avoids a second message boundary.</p></article>
              <article class="card"><h3>Synchronous listener registration</h3><p><span class="path">src/background.ts</span> registers all listeners during module evaluation. This matters for MV3 workers, which can be started on demand and must expose their handlers immediately.</p></article>
              <article class="card"><h3><code>sendResponse</code> plus <code>return true</code></h3><p>The dispatcher uses the callback response contract instead of returning a Promise. This preserves the cross-browser behavior documented in the source and keeps the worker alive while asynchronous work completes.</p></article>
              <article class="card"><h3>Strict schemas, tolerant typenames</h3><p>Known variants require their required fields and fail loudly as <code>ResponseShapeUnknown</code> when the shape changes. Unknown <code>__typename</code> values pass through so a partial Instagram rollout does not discard every other usable item.</p></article>
              <article class="card"><h3>Effect at external boundaries</h3><p>Network, HTTP, GraphQL, rate-limit, and schema failures are typed Effects. The worker converts them at the edge into the operation failure registry, while tests can exercise the same behavior without a live Instagram session.</p></article>
              <article class="card"><h3>Operation identity and reconciliation</h3><p>Every download has an immutable operation ID and a fresh request ID on retry. History stores accepted outcomes only, and redownload reconciliation prefers stable media IDs before falling back to an item index and media type.</p></article>
            </div>
            <div class="callout amber"><strong>Rejected shortcut.</strong> Raw casts at the Instagram boundary would make upstream changes look like successful empty results. The schema posture intentionally trades a visible update-required failure for silent corruption or a misleading download.</div>
          </section>

          <section id="data-shapes">
            <h2>DATA SHAPES</h2>
            <p>External data is decoded before it enters the application model. Durable data has separate contracts and is sanitized before storage.</p>
            <table>
              <thead><tr><th>Shape</th><th>Defined in</th><th>Important invariants</th></tr></thead>
              <tbody>
                <tr><td><code>CanonicalInstagramUrl</code></td><td><span class="path">src/workspace/contracts.ts</span></td><td>HTTPS <code>www.instagram.com</code>, supported target, normalized path, no fragment, and only the supported carousel query.</td></tr>
                <tr><td><code>MediaItem</code></td><td><span class="path">src/background.ts</span></td><td>Normalized image or video URL, stable item index, filename hint, optional media identity, preview, dimensions, and capture timestamp.</td></tr>
                <tr><td><code>WorkspaceSnapshot</code></td><td><span class="path">src/workspace/contracts.ts</span></td><td>Versioned, expiring handoff containing source, settled status, selected media, frame settings, and silent-export indexes. Data URLs are removed before storage.</td></tr>
                <tr><td><code>DownloadHistoryEntry</code></td><td><span class="path">src/history/contracts.ts</span></td><td>Canonical source and item identity plus filename/export metadata and an accepted timestamp. No media or preview URL. Capped at 1,000 records.</td></tr>
                <tr><td><code>OperationFailure</code></td><td><span class="path">src/errors/contracts.ts</span></td><td>Stable code, phase, and scope. Presentation maps codes to recovery actions; diagnostic causes are kept out of ordinary UI copy.</td></tr>
              </tbody>
            </table>
            <h3>Versioned workspace handoff</h3>
            <pre><code>popup state

-&gt; sanitizeSnapshot()
-&gt; browser.storage.local[workspace-transfer-v1]
-&gt; workspace tab claims and removes the transfer
-&gt; upgradeWorkspaceSnapshot() accepts versions 1, 2, and 3
-&gt; React state resumes the source, results, and export settings</code></pre>

<p>The transfer is intentionally temporary. <code>WORKSPACE_TRANSFER_TTL_MS</code> is 60 seconds, and the status heartbeat is removed when the workspace tab closes or leaves workspace mode.</p>
</section>

          <section id="dependencies">
            <h2>DEPENDENCIES AND ASSUMPTIONS</h2>
            <div class="grid-2">
              <article class="card"><h3>Browser platform</h3><p>The <span class="path">src/lib/browser.ts</span> shim resolves Firefox's native <code>browser</code> first, then wraps Chromium's callback APIs, then falls back to a no-op test shim. Production behavior assumes MV3 downloads, storage, tabs, windows, and context-menu APIs are available.</p></article>
              <article class="card"><h3>Instagram session</h3><p>Stories, highlights, private content, and some profile data depend on an authenticated browser session. Instagram's internal endpoints, identifiers, headers, and response shapes are undocumented and may change independently of the extension.</p></article>
              <article class="card"><h3>Media delivery</h3><p>CDN URLs are temporary and are passed to browser downloads only while they are usable. Preview fallback and video-blob fetches use the worker because service workers do not provide every DOM URL API.</p></article>
              <article class="card"><h3>Build and release</h3><p><span class="path">templates/</span> is the Vite root. <span class="path">scripts/postbuild.mjs</span> writes browser manifests. Vite+ is the repository's workflow surface for builds, checks, tests, and packaging.</p></article>
            </div>
            <div class="callout"><strong>Permission model.</strong> The generated manifests request <code>downloads</code>, <code>storage</code>, <code>activeTab</code>, <code>tabs</code>, and <code>contextMenus</code>, plus host permissions for <code>https://*.instagram.com/*</code> and <code>https://*.fbcdn.net/*</code>. The source of truth is <span class="path">scripts/manifest.mjs</span>; the README permission table mirrors it.</div>
          </section>

          <section id="failure-modes">
            <h2>FAILURE MODES</h2>
            <table>
              <thead><tr><th>Failure class</th><th>Where it is detected</th><th>Recovery posture</th></tr></thead>
              <tbody>
                <tr><td>Invalid or unsupported URL</td><td>Canonicalization and history source validation</td><td>Return an input-scoped failure before making a network request.</td></tr>
                <tr><td>Network, HTTP, auth, or rate limit</td><td>Effect request helpers</td><td>Retry supported transient failures, preserve rate-limit semantics, and present a typed action such as refetch or open Instagram.</td></tr>
                <tr><td>Unknown Instagram response shape</td><td>Effect Schema decode</td><td>Return <code>ResponseShapeUnknown</code> with the endpoint context. Update protocol configuration, sanitized fixtures, and schemas together.</td></tr>
                <tr><td>Browser download rejection</td><td>Worker download operation</td><td>Return a correlated failed result without exposing the raw cause as ordinary UI copy. The UI can retry the failed operation or download originals where supported.</td></tr>
                <tr><td>History storage failure or newer version</td><td>History repository and handlers</td><td>Keep the download outcome visible, add a warning when history could not be saved, and refuse destructive writes for an unknown future store version.</td></tr>
                <tr><td>Frame extraction failure</td><td>DOM video/canvas extraction</td><td>Classify no-duration, no-frame, no-canvas, no-blob, and timeout cases. A timeout gets one retry; the UI offers original-download recovery.</td></tr>
                <tr><td>Silent-video worker failure</td><td>OPFS and worker batch</td><td>Retain the input artifact where a later retry needs it, remove failed generated output, and preserve the failure kind through the correlated batch result.</td></tr>
              </tbody>
            </table>
            <div class="callout rose"><strong>Diagnostics are opt-in.</strong> Diagnostics can include the source URL, temporary media URLs, filenames, operation IDs, technical messages, and stacks. The UI previews the payload before copying it and warns the user to share it only with someone trusted.</div>
          </section>

          <section id="tests">
            <h2>TESTS AND EVALUATIONS</h2>
            <p>The test suite mirrors the architecture boundaries instead of relying on one end-to-end happy path.</p>
            <div class="grid-3">
              <article class="card"><h3>Boundary contracts</h3><p><span class="path">src/effect/schemas.fixtures.test.ts</span> decodes sanitized captures. <span class="path">src/effect/schemas.test.ts</span> covers missing required fields, null variants, union dispatch, and unknown typename passthrough.</p></article>
              <article class="card"><h3>Worker behavior</h3><p><span class="path">src/background.test.ts</span> verifies synchronous listener registration, async response behavior, context menus, shortcode fallback, download concurrency, correlated failures, history, and diagnostics.</p></article>
              <article class="card"><h3>Stateful workflows</h3><p>Download attempt, history reconciliation, workspace transfer, frame extraction, OPFS cleanup, silent-video processing, and browser shim tests exercise identity, retries, expiry, and cleanup rules.</p></article>
            </div>
            <h3>Repository validation</h3>
            <table>
              <thead><tr><th>Check</th><th>What it protects</th></tr></thead>
              <tbody>
                <tr><td><code>vp check</code></td><td>Formatting, lint rules, and TypeScript correctness.</td></tr>
                <tr><td><code>vp test run</code></td><td>Focused unit, integration, fixture, browser-shim, and media-processing behavior.</td></tr>
                <tr><td><code>vp run build:chromium</code> and <code>vp run build:firefox</code></td><td>Browser-specific output, manifests, icons, and background entry wiring.</td></tr>
                <tr><td><code>vp run fallow</code></td><td>Dead code, dependency, cycle, duplication, and complexity signals.</td></tr>
              </tbody>
            </table>
            <p>When Instagram changes, the supported maintenance loop is: capture in DevTools, sanitize the complete fixture set, decode with the fixture tests, update the schema or protocol configuration, and rerun the repository checks before shipping.</p>
          </section>
        </main>
      </div>
      <footer>Source entry points: <span class="path">templates/popup.html</span>, <span class="path">templates/popup.tsx</span>, <span class="path">src/popup.tsx</span>, <span class="path">src/background.ts</span>, and <span class="path">scripts/manifest.mjs</span>.</footer>
    </div>

  </body>
</html>
