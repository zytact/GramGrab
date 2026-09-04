# CLI bridge

The `gramgrab` terminal command reaching the same operations as the extension.
The browser starts a native host, the host owns a per-user Unix socket, and the
CLI connects to that socket. Instagram credentials and media fetching stay
inside the extension; the CLI only asks.

## Sub-features

- `status`: version and protocol compatibility across CLI, host, and extension.
- `history list | remove | clear | redownload`: the extension's download history.
- `debug get`: the structural-only diagnostics report as JSON on stdout.
- `debug export`: the same report as a browser download.
- `inspect SOURCE`, `export SOURCE`, `instants inspect | export`: acquisition,
  covered in the Instagram and export-mode entries.
- Refusals that never reach the browser: `web.whatsapp.com` and `wa.me` sources,
  bare hosts, and usernames outside `[A-Za-z0-9._]{1,30}`.
- Cancellation: Ctrl+C, SIGTERM, and client disconnect propagate to the
  extension. A five-second acceptance timeout and a 30-minute terminal deadline
  bound a request.

## How to get to it (user POV)

Install the extension, register the native host manifest for the browser
(`docs/cli-setup.md` lists the per-OS paths), reload the browser, then run
`gramgrab` in a terminal. Nothing in the browser UI has to be open: the service
worker connects to the host on startup.

## Driving it with the harness

```bash
cd /home/arnab/Projects/GramGrab && . ./.local/verify/session.env

node apps/cli/bin/gramgrab.mjs status
node apps/cli/bin/gramgrab.mjs history list
node apps/cli/bin/gramgrab.mjs debug get
node apps/cli/bin/gramgrab.mjs help

# refusals, which must not reach the browser at all
node apps/cli/bin/gramgrab.mjs inspect https://web.whatsapp.com/ ; echo "exit=$?"
node apps/cli/bin/gramgrab.mjs inspect "not a source"            ; echo "exit=$?"
```

To prove the socket really is the transport rather than something ambient,
point the CLI somewhere empty and watch it refuse:

```bash
GRAMGRAB_IPC_PATH=/tmp/gramgrab-nope.sock node apps/cli/bin/gramgrab.mjs status
```

## What proves it works

- `status` prints `"compatible": true` with `extensionVersion` matching
  `createManifest('chromium').version` and `protocolVersion` matching
  `PROTOCOL_VERSION`, exit 0.
- `history list` prints a `HistoryListResult`, exit 0. `debug get` prints a
  `DebugGetResult` whose `report` is JSON with `diagnosticsVersion: 2` and a
  `browser.majorVersion` matching the browser doctor reported.
- The WhatsApp source refuses with
  `WhatsApp Status downloads are only available in the browser extension.` and
  exit 2, with no request crossing the socket.
- The bogus endpoint fails with `IPC_UNAVAILABLE` and exit 2.

## Gotchas

- `gramgrab debug export` sets `saveAs: true`, so it opens a native Save As
  dialog and leaves the download `in_progress` with an empty filename until a
  human answers. It will look like a hang in a scripted run. Use `debug get`,
  and if you already triggered it, cancel with
  `chrome.downloads.search({state:'in_progress'})` plus `cancel` through the
  service worker target.
- Subcommands are separate argv entries. `gramgrab "history list"` is one
  argument and fails with `Unknown command: history list`, exit 2. Pass
  `history list` as two words. Piping the CLI into `head` hides this, because
  `$?` then belongs to `head`.
- The CLI resolves its endpoint at import time from `GRAMGRAB_IPC_PATH`, then
  `$XDG_RUNTIME_DIR/gramgrab-$UID.sock`. Source `session.env` in the same shell
  or you will silently talk to the developer's real browser.
- The native host refuses to steal a live socket, so two browser profiles cannot
  share one endpoint. That is why the launcher gives each session its own path.
