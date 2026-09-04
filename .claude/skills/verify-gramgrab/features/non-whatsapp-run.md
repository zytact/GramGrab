# Full non-WhatsApp run

Use this run for a release, a broad refactor, or a request to verify everything
except WhatsApp. Narrow changes should use the affected feature files instead.

This run is exhaustive across current non-WhatsApp user behavior. It combines
live Chromium proof, the real CLI bridge, build validation, and focused tests
for branches that cannot be induced safely in a live account.

## Inputs

Use purpose-made Instagram fixtures whose owners consent to repeated fetching.
Set one source for every acquisition kind and one video that has audio:

```bash
export GG_POST_URL='https://www.instagram.com/p/.../'
export GG_REEL_URL='https://www.instagram.com/reel/.../'
export GG_STORY_URL='https://www.instagram.com/stories/user/.../'
export GG_HIGHLIGHT_URL='https://www.instagram.com/stories/highlights/.../'
export GG_PROFILE_URL='https://www.instagram.com/user/'
export GG_STORIES_USERNAME='user'
export GG_VIDEO_URL="$GG_REEL_URL"
```

Do not substitute personal or disappearing content. If any fixture is missing,
mark that source kind unverified rather than silently shrinking the run.

## Start and evidence

```bash
.agents/skills/verify-gramgrab/scripts/launch.sh
. ./.local/verify/session.env
node .agents/skills/verify-gramgrab/scripts/doctor.mjs

D=.agents/skills/verify-gramgrab/scripts/drive.mjs
CLI='node apps/cli/bin/gramgrab.mjs'
EV=.local/verify-evidence/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$EV"
```

Keep a `results.md` in `$EV` with one row per check below. Record the command,
exit code, evidence filename, and exact failure code when a check fails. A
failure is a result. Preserve its first evidence before rerunning the check.

## 1. Health and CLI boundary

Run the bridge checks in [CLI bridge](./cli-bridge.md), including `help`,
`status`, `history list`, `debug get`, local input refusals, and a missing
socket. Save stdout and stderr separately when exit status is part of the
proof.

Run `debug export` as a human checkpoint. Accept its native Save As dialog into
`$GRAMGRAB_VERIFY_DOWNLOADS`, then require a non-empty JSON file with
`diagnosticsVersion: 2`. The command result must name the same file and report
`status: started`.

For cancellation, start a frame or silent export large enough to remain active,
wait until JSON stderr emits a progress event, then send SIGINT to that CLI
process. It must print `Request cancelled.`, exit 2, and leave `gramgrab status`
healthy. The focused CLI and native-host tests prove that the cancellation frame
keeps the accepted request ID and that disconnect cancels every remaining
request:

```bash
vp test run apps/cli/src/index.test.ts apps/native-host/src/index.test.ts
```

The five-second acceptance timeout and 30-minute terminal timeout are tested
with injected clocks. Do not wait 30 minutes in a live run.

## 2. Every Instagram source

Inspect each source through the CLI and save the terminal JSON:

```bash
$CLI inspect "$GG_POST_URL" --json > "$EV/post.json" 2> "$EV/post.progress.jsonl"
$CLI inspect "$GG_REEL_URL" --json > "$EV/reel.json" 2> "$EV/reel.progress.jsonl"
$CLI inspect "$GG_STORY_URL" --json > "$EV/story.json" 2> "$EV/story.progress.jsonl"
$CLI inspect "$GG_HIGHLIGHT_URL" --json > "$EV/highlight.json" 2> "$EV/highlight.progress.jsonl"
$CLI inspect "$GG_PROFILE_URL" --json > "$EV/profile-avatar.json" 2> "$EV/profile-avatar.progress.jsonl"
$CLI inspect "$GG_STORIES_USERNAME" --json > "$EV/username-stories.json" 2> "$EV/username-stories.progress.jsonl"
$CLI instants inspect --json > "$EV/instants.json" 2> "$EV/instants.progress.jsonl"
```

Every command must exit 0 with at least one item. Check that `itemNumber` starts
at 1, `mediaIdentity.itemIndex` starts at 0, and profile inspection returns the
avatar rather than active Stories.

Drive both React surfaces with the post fixture, then drive Instants in the
workspace:

```bash
node "$D" open "chrome-extension://$GRAMGRAB_EXT_ID/popup.html"
node "$D" type 'popup.html' '#source-url' "$GG_POST_URL"
node "$D" click 'popup.html' '.fetch-row button'
node "$D" wait 'popup.html' 'FOUND' 60000
node "$D" shot 'popup.html' "$EV/popup-post.png"

node "$D" open "chrome-extension://$GRAMGRAB_EXT_ID/popup.html?surface=workspace"
node "$D" type 'popup.html?surface' '#source-url' "$GG_POST_URL"
node "$D" click 'popup.html?surface' '.fetch-row button'
node "$D" wait 'popup.html?surface' 'FOUND' 60000
node "$D" click 'popup.html?surface' '.instants-btn'
node "$D" wait 'popup.html?surface' 'FOUND' 60000
node "$D" shot 'popup.html?surface' "$EV/workspace-instants.png"
```

For URL normalization, type the post URL with `http`, query parameters, and a
fragment, then blur the field. Read `#source-url` back with `eval`; it must equal
the canonical HTTPS URL.

The actual toolbar popup and active-tab detection need a human checkpoint. Bring
the post fixture to the front, click GramGrab in the browser toolbar, and verify
that the field is prefilled and `Instagram URL detected - ready to fetch.` is
visible. Click `Open in tab`; the workspace must inherit the URL and results.
Open the toolbar popup again and verify the control now says `Go to tab` and
focuses the existing workspace. Save screenshots before and after the handoff.

Exercise one known failure supplied by the change under test. Record its code
from `.download-attempt-summary code` and verify the visible recovery controls
against `docs/error-model.md`. The focused presentation tests own the complete
failure-code matrix:

```bash
vp test run apps/extension/src/errors/contracts.test.ts apps/extension/src/popup.test.tsx
```

## 3. Workspace and context menus

Follow [Workspace and context menus](./workspace.md). Prove popup handoff,
single-workspace focus, replacement confirmation, state transfer, and the busy
guard. Complete the human context-menu matrix for page targets, link targets,
Open, Fetch, and hidden unsupported targets.

## 4. Every export mode

Follow [Export modes](./export-modes.md) for direct, frame, and silent exports.
Run each mode from the CLI. Run a mixed batch from the workspace with one direct
item, one frame item at a non-zero timestamp, and one silent item. Exercise both
choices in the re-encode dialog when the fixture requires re-encoding.

Also replay one CLI export as a plan. Copy its `itemNumber` and `mediaIdentity`
from inspection, assign a UUID operation ID, and use the tagged mode shape from
`packages/protocol/src/index.ts`. Run the same plan twice. Both results must
carry the plan's operation ID, proving retry identity is stable.

For every accepted export, record the exact filename and byte size. Use
`file` for type, `ffprobe` for stream kinds, and compare the saved JPEG with the
UI preview at the requested frame timestamp. Confirm the runner target appears
during frame and silent work and disappears when the batch finishes.

## 5. History lifecycle

Start from the entries created above. Follow [Download history](./download-history.md)
and prove the same entries appear in the popup and CLI. Then:

1. Re-download one source entry through the UI and one through the CLI. Confirm
   both new files and the updated history marker.
2. Remove one known entry and confirm every other entry remains.
3. Clear the scratch profile's history and confirm both surfaces update.
4. Write a malformed version-4 history entry through the service-worker target,
   run `history list --json`, and require `repaired: true` with the malformed
   entry removed. Restore the valid store saved before this check.
5. Write `{version: 999, entries: []}`. The UI must show
   `HISTORY_VERSION_UNSUPPORTED`; `history list --json` must reject with
   `Unsupported history version.` Restore the saved store.

Storage mutation is allowed only in the dedicated verification profile. Never
run these two corruption checks against the developer's regular browser.

## 6. Build and delivery

Follow [Release artifacts](./release-artifacts.md). This phase builds both
browser targets, enforces the WhatsApp manifest policy, packages CRX, XPI, CLI,
and native host artifacts, and records what this Linux run cannot prove about
other operating systems.

## Finish

Run the repository validation commands, compare the two skill copies, and clean
up even after failure:

```bash
vp check
vp test run
vp run fallow
diff -qr .agents/skills/verify-gramgrab .claude/skills/verify-gramgrab
.agents/skills/verify-gramgrab/scripts/cleanup.sh
```

The run is complete only when every row has a result and every skipped row names
the missing fixture or environment. Report the evidence directory and skipped
rows. Do not summarize a partial matrix as full verification.
