# Export modes

How a selected item becomes a file. Three modes, and two of them need DOM and
media APIs a service worker does not have, so the background worker opens
`runner.html` in a minimized popup window and sends it a `RUN_EXPORT` message.

## Sub-features

- **Direct**: download the original media. The default.
- **Frame**: export a still from a video. `--at` defaults to 5 seconds and
  clamps to the duration. In the UI a per-item timestamp field, labelled
  `Frame timestamp for item NN`, drives the same thing, and the preview seeks to
  the timestamp being exported.
- **Silent**: strip the audio track. `--reencode forbid` permits stream copy
  only, `allow` permits re-encoding when needed, `require` always permits it.
  The UI asks through the `Some videos require re-encoding` dialog instead;
  `--json` never prompts.
- Batch selection: `SELECT ALL` and `DOWNLOAD SELECTED` across mixed modes.
- Plans: `gramgrab export SOURCE --plan FILE|-` replays protocol
  `ExportOperation` objects with stable operation IDs, which is how a retry
  keeps its identity.

## How to get to it (user POV)

Fetch media first, then per item toggle `Frame` or `Remove audio` and press
`DOWNLOAD SELECTED`. From the terminal, `gramgrab export SOURCE --item N --mode
frame --at 5`. Repeating `--item` starts another operation and may use a
different mode.

## Driving it with the harness

```bash
cd /home/arnab/Projects/GramGrab && . ./.local/verify/session.env
EV=.local/verify-evidence/$(date -u +%Y%m%dT%H%M%SZ) && mkdir -p "$EV"

node apps/cli/bin/gramgrab.mjs export https://www.instagram.com/p/SHORTCODE/ \
  --item 1 --mode frame --at 3 --json > "$EV/frame-export.json"

ls -l "$GRAMGRAB_VERIFY_DOWNLOADS"
```

Watch the runner appear while an export runs, which is the only visible sign
that the second document is doing the work:

```bash
node .agents/skills/verify-gramgrab/scripts/drive.mjs targets | grep runner.html
```

## What proves it works

- A file exists in `$GRAMGRAB_VERIFY_DOWNLOADS` with the extension's own
  filename, not `download.jpg`. Filename construction is real logic with its own
  regression history, so record the exact name.
- The file is non-empty and the right kind: a frame export is a JPEG, a silent
  export is an MP4.
- A silent export has a video track and no audio track. Check it, do not infer
  it from the mode name. This must print `video` and nothing else:

  ```bash
  ffprobe -v error -show_entries stream=codec_type -of csv=p=0 FILE
  ```

- A frame export shows the timestamp that was requested, not frame zero. The
  preview shown in the UI and the saved frame must match.
- `export --json` exits 0 when every outcome is `ItemSucceeded`, and exits 1
  when any item failed, with the failure codes in the terminal JSON.

## Gotchas

- Direct downloads use `saveAs: false` and complete on their own. Only
  `debug export` prompts.
- The runner window is minimized, not hidden. It appears in the window list
  during an export and closes afterwards; do not treat it as a stray window and
  kill it mid-run.
- Cancellation closes the runner surface and its worker, but a download the
  browser already accepted cannot be recalled. Expect a partial file on disk
  after cancelling late.
- `--reencode` is required for `--mode silent`; omitting it is a parse error
  before anything reaches the browser.
- Re-encoding is CPU-bound and can outlast a short timeout. The terminal
  deadline is 30 minutes for a reason.
