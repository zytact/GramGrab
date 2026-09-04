# Instagram acquisition

Turning an Instagram location into a list of media items a person can look at
and pick from. Everything downstream (selection, export modes, history) starts
here.

## Sub-features

- Source acquisition: a post, reel, story, highlight, or profile URL. A bare
  username targets that account's active Stories. A profile URL resolves the
  account avatar.
- URL canonicalisation on blur, and auto-detection from the active tab, which
  pre-fills the field and shows `Instagram URL detected - ready to fetch.`
- Instants: the signed-in account's own feed, fetched without a URL. Reads the
  Instagram CSRF cookie, which is why the manifest asks for `cookies`.
- Failure presentation: every failure renders a title, an explanation, and its
  symbolic code, plus whichever recovery actions apply (`Fetch source again`,
  `Open in Instagram`, `Copy diagnostics`). `docs/error-model.md` is the registry.

## How to get to it (user POV)

Two entry points render the same React root, and both must be considered:

- **Popup**: click the toolbar icon. Paste a URL, press Enter or click
  `FETCH MEDIA`. `LOAD INSTANTS` fetches the feed instead.
- **Workspace**: click `Open in tab` in the popup header, which opens
  `popup.html?surface=workspace` as a full tab and hands over the current
  session. The button becomes `Go to tab` once one exists.

The CLI is a third entry point: `gramgrab inspect SOURCE`.

## Driving it with the harness

The toolbar popup closes on focus loss, so open the same document as a tab. Use
`?surface=workspace` for the workspace entry point and plain `popup.html` for
the popup one; both need driving when a change touches shared UI.

```bash
cd /home/arnab/Projects/GramGrab && . ./.local/verify/session.env
D=.agents/skills/verify-gramgrab/scripts/drive.mjs

node $D open "chrome-extension://$GRAMGRAB_EXT_ID/popup.html?surface=workspace"
node $D wait "popup.html?surface" "FETCH MEDIA"
node $D shot "popup.html?surface" "$EV/before-fetch.png"

# type into the real field and click the real button
node $D type "popup.html?surface" "#source-url" "https://www.instagram.com/p/SHORTCODE/"
node $D click "popup.html?surface" ".fetch-row button"
node $D wait "popup.html?surface" "selected" 60000
node $D shot "popup.html?surface" "$EV/after-fetch.png"
```

Setting `.value` through the prototype setter before dispatching `input` is what
makes React see the change. Assigning `i.value` alone does nothing.

The same acquisition over the CLI:

```bash
node apps/cli/bin/gramgrab.mjs inspect https://www.instagram.com/p/SHORTCODE/ --json
node apps/cli/bin/gramgrab.mjs instants inspect --json
```

## What proves it works

- The media list replaces `No media yet.` with one card per item, the count
  label reports the number found, and `SELECT ALL` becomes meaningful.
- `inspect --json` exits 0 and prints an `InspectResult` whose `items` carry an
  `itemNumber` and a `mediaIdentity`.
- On failure, the UI shows the code from `docs/error-model.md` in
  `.download-attempt-summary code` and offers only the recoveries that failure
  allows. Capture the code, not a paraphrase of the message.

## Gotchas

- Story, highlight, and Instants requests need a session. Against a profile
  that was never signed in they fail, or sit on `resolving` until the acceptance
  window and then the terminal deadline apply. Run `scripts/signin.sh` once
  before calling any of this verified, and check `document.cookie` on
  instagram.com if a run starts failing the way a logged-out one would.
- Do not use the developer's real Instagram account for a scripted run that
  downloads. Fetching is a read; treat account choice as the user's call.
- `inspect` and `export` hit real Instagram. Rate limits are a real outcome and
  a real failure code, not a flaky test. `docs/instagram-protocol.md` covers
  what to do when the request shape itself stopped working.
- Instagram answers `web_profile_info` with 429 for an ordinary signed-in
  session, so a story or profile username is resolved through `topsearch`
  instead (#164). A story run that fails at `SOURCE_USERNAME_UNRESOLVED` for an
  account that plainly exists means both lookups are refusing; check them by
  hand from the service worker before treating it as a code bug.
- `ResponseShapeUnknown` means Instagram changed a payload. That is a fixture
  and schema task (`vp run generate:ig-fixtures`), not something to work around
  in the harness.
