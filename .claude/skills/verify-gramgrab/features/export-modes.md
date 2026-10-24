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
- Crop: an Export modifier next to rotation. The workspace `Crop` button opens a
  selector on the preview with corner handles, `Free`, `1:1`, `4:5`, `9:16`,
  `Reset`, and `Done`. An image crop re-encodes a JPEG, a frame export crops the
  still, and a video crop re-encodes H.264 through the silent-video processor
  after the `Some videos require re-encoding` dialog. A direct video crop keeps
  its audio; a silent one drops it. Plans carry `crop` as fractions of the
  turned frame.
- Batch selection: `SELECT ALL` and `DOWNLOAD SELECTED` across mixed modes.
- Plans: `gramgrab export SOURCE --plan FILE|-` replays protocol
  `ExportOperation` objects with stable operation IDs, which is how a retry
  keeps its identity.

## How to get to it (user POV)

Fetch media first, then per item toggle `Frame` or `Remove audio` and press
`DOWNLOAD SELECTED`. From the terminal, `gramgrab export SOURCE --item N --mode
frame --at 5`. Repeating `--item` starts another operation and may use a
different mode.

The Watches inbox uses these same media cards after `Fetch media`. Its selection
addresses recorded children, and download reacquires those exact identities.
Follow [Watches inbox preview](./watches.md#inbox-preview) for isolation,
unavailable reasons and Avatar's Original-only restriction.

## Driving it with the harness

```bash
cd "$(git rev-parse --show-toplevel)" && . ./.local/verify/session.env
EV=.local/verify-evidence/$(date -u +%Y%m%dT%H%M%SZ) && mkdir -p "$EV"

node apps/cli/bin/gramgrab.mjs export https://www.instagram.com/p/SHORTCODE/ \
  --item 1 --mode frame --at 3 --json > "$EV/frame-export.json"

node apps/cli/bin/gramgrab.mjs export https://www.instagram.com/p/SHORTCODE/ \
  --item 1 --mode direct --json > "$EV/direct-export.json"

node apps/cli/bin/gramgrab.mjs export https://www.instagram.com/reel/SHORTCODE/ \
  --item 1 --mode silent --reencode allow --json > "$EV/silent-export.json"

node apps/cli/bin/gramgrab.mjs instants export \
  --item 1 --mode direct --json > "$EV/instant-export.json"

ls -l "$GRAMGRAB_VERIFY_DOWNLOADS"
```

For a mixed workspace batch, fetch a multi-item fixture, clear the selection,
then select three rows. Leave one direct, enable `Frame` on one video, set its
`Frame timestamp for item NN` slider above zero, and enable `Remove audio` on a
different video. Click `.workspace-download`. If the quality dialog opens,
capture it and exercise `Skip affected videos`; repeat the batch and exercise
`Re-encode affected videos`.

For plan replay, inspect first and copy the chosen item's `itemNumber` and
`mediaIdentity`. Write an array in this shape, using a real UUID:

```json
[
  {
    "operationId": "00000000-0000-4000-8000-000000000001",
    "itemNumber": 1,
    "mediaIdentity": { "itemIndex": 0, "mediaId": "COPY_FROM_INSPECT" },
    "mode": { "_tag": "FrameExport", "timestampSeconds": 3 }
  }
]
```

Run it twice and require the same operation ID in both results:

```bash
node apps/cli/bin/gramgrab.mjs export "$GG_VIDEO_URL" --plan "$EV/plan.json" --json
node apps/cli/bin/gramgrab.mjs export "$GG_VIDEO_URL" --plan "$EV/plan.json" --json
```

Exercise `--reencode forbid`, `allow`, and `require` against the same video.
`forbid` must never re-encode. If stream copy is unavailable it may skip the
item. `allow` and `require` may re-encode, but every successful result must pass
the no-audio stream check below. Also run one export with no `--item`; its
terminal result must contain one outcome for every inspected item. Run one
command with repeated `--item` flags and different modes to prove mixed CLI
batches preserve each requested mode.

Watch the runner appear while an export runs, which is the only visible sign
that the second document is doing the work:

```bash
node .agents/skills/verify-gramgrab/scripts/drive.mjs targets | grep runner.html
```

### Crop

Fetch one image and one video with audio into the workspace. `instagram`'s
Avatar (`https://www.instagram.com/instagram/`) is a 1080x1080 image and its
Reels are 9:16 videos, which keeps every crop proof on Instagram's own account.
A preset that matches the frame, such as `1:1` on that square Avatar, covers
the whole frame and is dropped as no crop, so pick another preset there.

```bash
D=.agents/skills/verify-gramgrab/scripts/drive.mjs; W="popup.html?surface"
node $D click "$W" 'button[aria-label^="Crop item 01"]'
node $D drag  "$W" ".crop-handle.se" -70 -40      # free-form resize from a corner
node $D eval  "$W" "document.querySelector('[role=group][aria-label^=\"Crop area\"]').focus()"
node $D key   "$W" ArrowLeft                      # moves the area; shift+ArrowUp resizes it
node $D eval  "$W" "[...document.querySelectorAll('.crop-toolbar button')].find(b=>b.textContent.trim()==='4:5').click()"
node $D eval  "$W" "JSON.stringify(document.querySelector('.crop-rect').style.cssText)"
```

Click `Done` the same way and shoot the card: the area outside the crop is
dimmed. Rotate the item once; the selector stays open and the crop turns with
its subject. On the video, crop with `1:1`, leave it direct, download, and
accept `Re-encode affected videos`. The dialog reads `Cropping a video
re-encodes it.` and the item line `Cropping needs a re-encode`; it can take a
few seconds to appear after the click. Repeat with `Frame` enabled to crop a
still. Then open History and press `Re-download` on the cropped image's entry,
which is not always the first; it must arrive cropped again.

From the plain popup, `Crop item NN` hands the whole batch to the workspace and
opens that item's selector. With a workspace open, it asks
`Replace the current workspace session to crop this item?` first. That is a
`window.confirm`, which blocks a CDP eval, so close the workspace tab before
driving the hand-off.

A plan carries the same crop. Copy `itemNumber` and `mediaIdentity` from
`inspect` and add `"crop": { "x": 0.25, "y": 0.1, "width": 0.5, "height": 0.8 }`
to a `DirectExport` operation; on the 1080x1080 Avatar it saves a 540x864 JPEG.

```bash
file "$GRAMGRAB_VERIFY_DOWNLOADS"/*.jpg   # prints each JPEG's width x height
ffprobe -v error -show_entries stream=codec_type,width,height -of csv=p=0 FILE.mp4
```

On the Avatar, `4:5` saves 864x1080 and the same crop turned once saves
1080x864. A `1:1` crop of a 720x1280 Reel saves a 720x720 still, and its
re-encoded video prints `video,720,720` and `audio`.

## What proves it works

- A file exists in `$GRAMGRAB_VERIFY_DOWNLOADS` with the extension's own
  filename, not `download.jpg`. Filename construction is real logic with its own
  regression history, so record the exact name.
- The file is non-empty and the right kind: a frame export is a JPEG, a silent
  export is an MP4.
- A silent export has a video track and no audio track. Check it, do not infer
  it from the mode name. `ffprobe` ships with `ffmpeg`, which a fresh Ubuntu or
  WSL install lacks. This must print `video` and nothing else:

  ```bash
  ffprobe -v error -show_entries stream=codec_type -of csv=p=0 FILE
  ```

- A frame export shows the timestamp that was requested, not frame zero. The
  preview shown in the UI and the saved frame must match.
- A mixed batch reports one terminal outcome for every selected item and keeps
  each mode attached to the intended item.
- A cropped output has the cropped size: a `1:1` image crop is square, a
  cropped video's width and height are even and match the selected region of
  the turned frame, and a direct video crop still prints `video` and `audio`.
- Plan results retain the supplied operation ID across retries.
- `export --json` exits 0 when every outcome is `ItemSucceeded`, and exits 1
  when any item failed, with the failure codes in the terminal JSON.

## Gotchas

- Direct downloads use `saveAs: false` and complete on their own. Only
  `debug export` prompts.
- Frame export needs a headed browser. Under `GRAMGRAB_HEADLESS=1` the
  minimized runner counts as hidden, its video never loads, and every frame
  export fails with `FRAME_TIMEOUT`. Direct and silent exports work headless.
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
