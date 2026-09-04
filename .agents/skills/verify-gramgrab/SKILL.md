---
name: verify-gramgrab
description: Launch GramGrab for real and prove a change works. Starts a dedicated Chromium with the unpacked MV3 extension loaded, its own native-messaging registration, and its own IPC socket, then drives the popup/workspace surface over CDP and the gramgrab CLI over the local socket. Use when asked to run the extension, screenshot the popup or workspace, confirm a fix in the real app, or verify the CLI bridge end to end.
---

# Verify GramGrab

GramGrab has two user-facing surfaces over one shared core: the MV3 extension
(popup and workspace) and the `gramgrab` CLI, which reaches the extension
through a native host over a Unix socket. This skill starts both against a
dedicated browser profile so a verification run never touches the developer's
own browser, socket, or `~/Downloads`.

Read `features/README.md` before deciding what a run has to cover. A proof that
drives one entry point is incomplete when the map lists others.

This skill lives twice, byte-identical, at `.agents/skills/verify-gramgrab/` and
`.claude/skills/verify-gramgrab/`, matching how `fallow` and `effect-ts` are
already carried in this repo. Commands below name the `.agents` path; the
scripts locate the repo root from their own location, so either copy runs.
**Edit one and copy it over the other in the same commit.** Two copies that
disagree about how to verify the app are worse than one.

## Launch

```bash
.agents/skills/verify-gramgrab/scripts/launch.sh
```

It builds `extension/chromium`, writes a native-messaging manifest pointing at
`apps/native-host/bin/gramgrab-native-host.mjs`, and starts the browser with a
free CDP port and a session-local `GRAMGRAB_IPC_PATH`.

Three directories, and the differences matter:

- `.local/verify-profile/` is the **browser profile, and it persists**. Sign-ins
  live here. Cleanup leaves it alone.
- `.local/verify/` is **run state**: the socket, the log, the session
  environment, and this run's downloads. Cleanup deletes all of it.
- `.local/verify-evidence/` holds **proofs, and nothing deletes them**.

Everything this skill writes goes under `.local/`, which `.gitignore` already
ignores as a whole. A verification run therefore leaves `git status` clean, and
no path here needs its own ignore rule.

Keep it that way. `.local/verify-profile/` contains live Instagram and WhatsApp
session cookies, so committing it would publish working credentials. If that
directory ever shows up in `git status`, something removed the ignore rule;
restore it rather than reaching for `git add -f` or a narrower pattern.

Readiness is the native host socket appearing at `$GRAMGRAB_IPC_PATH`. The
extension's service worker calls `connectNative` on startup, so the socket
existing proves the extension loaded and native messaging is wired. The script
waits for it and fails loudly after 30 seconds.

Every later command needs the session variables:

```bash
cd /home/arnab/Projects/GramGrab && . ./.local/verify/session.env
```

That exports `GRAMGRAB_CDP_PORT`, `GRAMGRAB_EXT_ID`, `GRAMGRAB_IPC_PATH`,
`GRAMGRAB_VERIFY_DOWNLOADS`, and the browser PID.

### Browser choice

`launch.sh` resolves `GRAMGRAB_BROWSER` first, then `helium`, `chromium`,
`google-chrome`. **Google Chrome 137 and newer ignore `--load-extension`**, so
the script refuses to start it and tells you to pick another binary. Helium is a
Chromium fork and honours the switch; it is the working default on this machine.

```bash
GRAMGRAB_BROWSER=chromium .agents/skills/verify-gramgrab/scripts/launch.sh
```

### Signing in

Instagram acquisition needs a session, and WhatsApp capture needs a linked
WhatsApp Web. Both are one-time human steps against the persistent profile:

```bash
.agents/skills/verify-gramgrab/scripts/signin.sh
# sign in to Instagram, link WhatsApp Web, then:
.agents/skills/verify-gramgrab/scripts/cleanup.sh
```

Every later `launch.sh` reuses those sessions. Instagram's `sessionid` is
long-lived, so this holds for weeks until Instagram expires it, you log out, or
an account checkpoint fires. Then run `signin.sh` again.

Verified: a cookie written seconds before teardown is on disk after
`cleanup.sh` and readable by the page after the next `launch.sh`.

`GRAMGRAB_PROFILE=<dir>` points at a different profile, which is how you keep a
second account. Never point it at the developer's real browser profile:
Chromium refuses to open a profile a running browser already holds, and a second
instance driving a live session is worse than not verifying.

## Doctor

```bash
node .agents/skills/verify-gramgrab/scripts/doctor.mjs
```

Read-only. Six checks, non-zero exit if any fails:

- session file present
- launched PID still alive
- CDP port answering, with the browser build string
- the extension is loaded and `ENABLED`, at the version `scripts/manifest.mjs`
  generates (catches driving a stale `extension/chromium`)
- the socket exists and is owner-only `0600`
- `gramgrab status` round trips and reports `compatible: true`

Run it first whenever anything looks off. The last check is the whole chain in
one line: CLI, socket, native host, native messaging, service worker.

## Drive

### The extension UI

`scripts/drive.mjs` is a dependency-free CDP client. It reads
`GRAMGRAB_CDP_PORT` from the environment, or takes `--port` first.

```bash
D=.agents/skills/verify-gramgrab/scripts/drive.mjs

node $D targets                                   # every debuggable target
node $D open "chrome-extension://$GRAMGRAB_EXT_ID/popup.html?surface=workspace"
node $D text  "popup.html"                        # innerText of the first match
node $D wait  "popup.html" "No media yet." 15000  # poll until text appears
node $D eval  "popup.html" "document.querySelector('.url-input').value"
node $D shot  "popup.html" .local/verify-evidence/run/workspace.png
```

The toolbar popup itself closes as soon as focus moves, so drive `popup.html`
as an ordinary tab instead. Opened plain it is the popup surface; opened with
`?surface=workspace` the same React root turns on workspace behaviour, which
`src/workspace/use-workspace-surface.ts` reads from that parameter. Match the
target on `popup.html?surface` when both tabs are open, since `popup.html` alone
matches whichever came first.

CSS uppercases much of the chrome. `drive.mjs text` and `wait` read `innerText`,
so they see `HISTORY` and `FETCH MEDIA`, while `textContent` in an `eval`
selector still reads `History`. Select on `textContent`, wait on the uppercase
form.

Prefer these handles, which the source owns and tests already depend on:

| Target               | Handle                                             |
| -------------------- | -------------------------------------------------- |
| Instagram URL field  | `aria-label="Instagram source URL"`, `#source-url` |
| Fetch button         | `.fetch-row button`                                |
| Instants button      | `.instants-btn`                                    |
| Platform switch      | `nav[aria-label="Download platform"] button`       |
| History toggle       | button text `History` / `Results`                  |
| Failure code readout | `.download-attempt-summary code`                   |
| Diagnostics dialog   | `#diagnostics-dialog-title`                        |
| WhatsApp panel       | `#whatsapp-title`, `#whatsapp-capture-title`       |

One limit worth knowing before planning a run: anything gated on the _active
tab_ cannot be driven this way. A popup opened as a tab is itself the active
tab, so `tabs.query({active: true, currentWindow: true})` from a driven popup
returns the popup. WhatsApp eligibility is the feature this blocks; see
`features/whatsapp-status.md`.

The service worker is a drivable target too, which is the fastest way to read
browser state the UI does not show:

```bash
node $D eval "background.js" \
  "new Promise(r=>chrome.downloads.search({},d=>r(JSON.stringify(d.map(x=>({f:x.filename,s:x.state}))))))"
```

### The CLI

Run the CLI from source so it reflects the working tree, with the session socket
in the environment:

```bash
. ./.local/verify/session.env
node apps/cli/bin/gramgrab.mjs status
node apps/cli/bin/gramgrab.mjs history list
node apps/cli/bin/gramgrab.mjs debug get
node apps/cli/bin/gramgrab.mjs inspect https://www.instagram.com/p/SHORTCODE/ --json
```

Exit codes carry meaning: 0 full success, 1 rejection or a partial item failure,
2 invalid input or transport failure. `--json` puts newline-delimited progress on
stderr and one terminal JSON object on stdout.

## Evidence

Write proofs to `.local/verify-evidence/<UTC timestamp>/` and name the directory
in your report. Cleanup never touches it, and `.gitignore` covers it, so
evidence stays local: it outlives the run without ever becoming a commit.

That cuts both ways. Screenshots of a signed-in session show real account
content, so quote a filename, a failure code, or a number in a PR rather than
attaching the image. If a proof has to travel, copy that one file out
deliberately and look at what is in frame first.

```bash
EV=.local/verify-evidence/$(date -u +%Y%m%dT%H%M%SZ) && mkdir -p "$EV"
node $D shot "popup.html" "$EV/workspace.png"
node apps/cli/bin/gramgrab.mjs status > "$EV/cli-status.json"
node .agents/skills/verify-gramgrab/scripts/doctor.mjs > "$EV/doctor.txt"
```

Proof standards for this repo:

- Drive the real user path. Type into `#source-url` and click the fetch button;
  do not call a React setter or post a message the UI would never send.
- Capture the action and the resulting state, not only the end screen. A
  screenshot before and after the click beats one screenshot.
- Check side effects next to what is visible. Accepted downloads land in
  `$GRAMGRAB_VERIFY_DOWNLOADS`; confirm the file exists, its size, and its
  filename, since filename construction is real logic with its own regressions.
  History is state: `gramgrab history list` after a download.
- Do not mock Instagram. The extension already isolates the network at
  `src/effect/`; a fixture proves the decoder, and `vp test run` covers that.
  This skill exists for what fixtures cannot show.
- `gramgrab debug export` opens a native Save As dialog (`saveAs: true` in
  `background.ts`) and parks the download `in_progress` until a human answers.
  Use `debug get` in a scripted run. Every media download uses `saveAs: false`
  and completes on its own.

Downloads are isolated by writing `download.default_directory` into the
profile's `Preferences` on every launch, not only the first, because Chromium
rewrites that file on exit. Do not reach for CDP
`Browser.setDownloadBehavior`: it renames files to `download.<ext>` and destroys
exactly the filename evidence worth capturing.

## Cleanup

```bash
.agents/skills/verify-gramgrab/scripts/cleanup.sh
```

Closes the browser over CDP, then removes `.local/verify/` with the socket, log,
and this run's downloads. The profile at `.local/verify-profile/` and the
evidence under `.local/verify-evidence/` both survive.

Teardown asks the browser to close rather than signalling it, because Chromium
batches cookie writes and only flushes them on a real exit. A `kill` here
silently discards a sign-in made in the last half minute, which was measured,
not assumed. Signals stay as the fallback for a wedged process, and that path
warns when it fires.

Run cleanup after a failed attempt too, so a broken run does not strand a
browser or a socket. `launch.sh` refuses to start while a session file exists.

To throw the sign-ins away and start clean:

```bash
.agents/skills/verify-gramgrab/scripts/cleanup.sh --reset-profile
```

That only ever deletes the default `.local/verify-profile/`. A directory named
through `GRAMGRAB_PROFILE` belongs to whoever named it and is never removed.

One side effect worth knowing: `launch.sh` rebuilds `extension/chromium`, and
any other browser that loaded that same directory unpacked will pick up the new
build. That is a rebuild, not a data change, but it can surprise someone using
the extension in another window.

## Helpers

All are executable and take no arguments beyond what is shown above.

| Script               | Purpose                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `scripts/launch.sh`  | Build, register the native host, start the browser                     |
| `scripts/signin.sh`  | Launch with Instagram and WhatsApp Web open for a one-time sign-in     |
| `scripts/doctor.mjs` | Six read-only health checks, non-zero exit on any failure              |
| `scripts/drive.mjs`  | CDP client: `targets`, `open`, `eval`, `text`, `wait`, `shot`, `close` |
| `scripts/cleanup.sh` | Close the browser, remove run state, keep the profile and evidence     |
