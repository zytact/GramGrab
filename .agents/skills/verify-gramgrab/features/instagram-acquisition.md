# Instagram acquisition

Turning an Instagram location into a list of media items a person can look at
and pick from. Everything downstream (selection, export modes, history) starts
here.

## Sub-features

- Source acquisition: a post, reel, story, highlight, or profile URL. The popup
  and workspace require a URL. The CLI also accepts a bare username for that
  account's active Stories. A profile URL resolves its Avatar and Highlight covers.
- [Story expiry](./story-expiry.md): relative time on Story results and an
  absolute UTC `expiresAt` in CLI inspection.
- URL canonicalisation on blur, and auto-detection from the active tab, which
  pre-fills the field and shows `Instagram URL detected - ready to fetch.`
- Instants: the signed-in account's own feed, fetched without a URL from
  `i.instagram.com/graphql_www`, because the web GraphQL host answers it with
  `null` (#295). Reads the Instagram CSRF cookie, which is why the manifest asks
  for `cookies`.
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
cd "$(git rev-parse --show-toplevel)" && . ./.local/verify/session.env
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

A profile URL is its own path, so drive it on its own. It spends three or four
requests: the account's first Posts page, its profile page when it has no Posts,
then the ID-keyed profile for the Avatar and the Highlights tray together. A
Story URL spends the same lookup, then the Story request.

```bash
node apps/cli/bin/gramgrab.mjs inspect https://www.instagram.com/instagram/ --json
```

## What proves it works

- The media list replaces `No media yet.` with one card per item, the count
  label reports the number found, and `SELECT ALL` becomes meaningful.
- `inspect --json` exits 0 and prints an `InspectResult` whose `items` carry an
  `itemNumber` and a `mediaIdentity`.
- `LOAD INSTANTS` in the workspace replaces `No media yet.` with `N ITEMS FOUND`,
  and `instants inspect --json` exits 0 with the same count.
  `IG_RESPONSE_SHAPE_UNKNOWN` here is the #295 failure, so read the request the
  worker sent before blaming the schema. Quote the count and code in a PR, not a
  screenshot: Instant cards show other accounts' usernames.
- A profile URL exits 0 with the Avatar as item 1, `mediaIdentity.mediaId`
  `profile-avatar:<username>` and `filenameHint` `<username>_profile`, then one
  item per Highlight cover. The workspace reads `1 ITEM FOUND` for an Avatar
  alone. Zero items is
  a failure of this path, not an account with nothing to show. An Avatar with no
  covers means Instagram refused the tray; see the gotcha below before calling
  it a regression.
- On failure, the UI shows the code from `docs/error-model.md` in
  `.download-attempt-summary code` and offers only the recoveries that failure
  allows. Capture the code, not a paraphrase of the message.

## Gotchas

- Story, highlight, profile, and Instants requests need a session. Against a profile
  that was never signed in they fail, or sit on `resolving` until the acceptance
  window and then the terminal deadline apply. Run `scripts/signin.sh` once
  before calling any of this verified, and check `document.cookie` on
  instagram.com if a run starts failing the way a logged-out one would.
- Do not use the developer's real Instagram account for a scripted run that
  downloads. Fetching is a read; treat account choice as the user's call.
- `inspect` and `export` hit real Instagram. Rate limits are a real outcome and
  a real failure code, not a flaky test. `docs/instagram-protocol.md` covers
  what to do when the request shape itself stopped working.
- Read _Known server behavior_ in `docs/instagram-protocol.md` before calling
  an Instagram failure a bug. It covers the retired REST username lookups
  (#301), the Highlights tray 403, and the Instants query on the web host. A
  person's 429 never pauses Watches; see [Watches](./watches.md#rate-limit-pause).
- `SOURCE_USERNAME_UNRESOLVED` for an account that plainly exists means neither
  its Posts page nor its profile page named it. Check both by hand from the
  service worker before treating it as a code bug.
- On a profile run, read `instagram-requests` from the worker before and after:
  three new `attempts` and one item is the tray's 403 refusal, not a bug in the
  lookup. Covers stay unproven live until the tray answers again.

  ```bash
  node $D eval "background.js" \
    "new Promise(r=>chrome.storage.local.get(['instagram-requests'],v=>r(JSON.stringify(v))))"
  ```

- Image thumbnails are `loading="lazy"` and can sit unloaded in a driven tab for
  the whole wait, with `img.complete` false and no failure placeholder, even
  while `document.visibilityState` reads `visible`. Run
  `node $D activate "popup.html?surface"` right before the `shot`; that pair
  captured the loaded thumbnail where a bare `shot` captured a blank one. A
  blank thumbnail without `.thumb-placeholder` is this, not a failed preview.
- `ResponseShapeUnknown` means Instagram changed a payload. That is a fixture
  and schema task (`vp run generate:ig-fixtures`), not something to work around
  in the harness.
