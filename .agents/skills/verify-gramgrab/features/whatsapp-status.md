# WhatsApp Visible Status

Capturing the one Status currently open in the WhatsApp Web viewer and handing
the bytes to an edit session that exports like any other media.

Read `docs/whatsapp-privacy.md`, ADRs 0001, 0002 and 0010, and
`docs/whatsapp-live-verification.md` before driving anything here.
`docs/whatsapp-boundary-coverage.md` maps each boundary to the synthetic test
that owns it. Synthetic tests stay authoritative; a live run establishes what
current WhatsApp Web and the browser actually do.

## Sub-features

- Eligibility: the panel offers capture only when the active tab is WhatsApp
  Web. Otherwise it shows `Open WhatsApp Web`.
- Capture: one `scripting.executeScript` injection of
  `js/whatsapp-controller.js` into the top frame, isolated world, under
  `activeTab`, then a bounded chunk protocol over a `tabs.connect` port.
- Edit session: a single hero item held until download or popup close. Frame
  and Remove audio work the same as elsewhere.
- Receipts: history gains a receipt with no name and no re-download.
- Diagnostics: a structural-only type that cannot hold a URL, name, or
  identifier.

## How to get to it (user POV)

Open WhatsApp Web, open a Status in the viewer, then open the GramGrab popup on
that tab and switch to `WhatsApp Status` in the platform navigation.

The verification profile keeps its WhatsApp Web link across runs once someone
has linked a device through `scripts/signin.sh`.

## Driving it with the harness

The whole flow is scriptable. Do not ask the person to post test cards or to
click anything.

```bash
cd "$(git rev-parse --show-toplevel)" && . ./.local/verify/session.env
D=.agents/skills/verify-gramgrab/scripts/drive.mjs

node $D open "https://web.whatsapp.com/"
node $D activate "web.whatsapp.com"
node $D eval "web.whatsapp.com" "!!document.querySelector('#side')"   # poll until true
node $D eval "web.whatsapp.com" "document.querySelector('[aria-label=\"Status\"]').click()"
```

WhatsApp Web can sit on its loading screen for a minute after launch. Poll for
`#side` instead of reading the page early.

Pick a Status as `docs/whatsapp-live-verification.md` says: reposted or public
content, nothing showing someone from the account owner's own life. Open one by
clicking its row, pause it, and look before capturing:

```bash
node $D eval "web.whatsapp.com" "document.querySelector('[aria-label=\"Pause\"]')?.click()"
node $D shot "web.whatsapp.com" "$EV/viewer.png"   # read it, skip the Status if it shows a private person
node $D eval "web.whatsapp.com" "document.querySelector('[aria-label=\"Next\"]')?.click()"   # or move on
```

Then open the real toolbar popup on that tab and capture:

```bash
node $D action "web.whatsapp.com"
node $D eval "popup.html" "[...document.querySelectorAll('nav[aria-label=\"Download platform\"] button')].find(b => /WhatsApp/.test(b.textContent)).click()"
node $D eval "popup.html" "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Continue')?.click()"   # first run only
node $D click "popup.html" "#whatsapp-capture-title ~ button"
node $D wait "popup.html" "Visible Status captured"
```

`action` calls CDP `Extensions.triggerAction` on the tab target, which opens
the same popup a toolbar click opens and grants `activeTab` the same way. A
popup opened with `open` is its own active tab and only ever shows `Open
WhatsApp Web`, which is still the way to capture the ineligible state.

Opening a contact's Status sends WhatsApp's normal view receipt.

When a capture fails, read its structural diagnostics instead of guessing:

```bash
node $D eval "popup.html" "(async () => { let copied; navigator.clipboard.writeText = t => { copied = t; return Promise.resolve(); }; [...document.querySelectorAll('button')].find(b => /diagnostics/i.test(b.textContent))?.click(); await new Promise(r => setTimeout(r, 800)); return copied; })()"
```

## What proves it works

- Ineligible: a popup opened with `open` shows `Open WhatsApp Web` and offers
  no capture control.
- Captured: the panel shows `Visible Status captured` and the hero renders a
  photo as an image and an MP4 as a video, never a poster-only fallback.
- Export: the saved file lands in `$GRAMGRAB_VERIFY_DOWNLOADS` with a
  name-free filename, and History gains a receipt with no re-download.
- Advancement race: advancing the viewer mid-capture yields either the originally
  guarded item or `WHATSAPP_STATUS_CHANGED`. Never the next Status.

## Gotchas

- Do not add a WhatsApp host permission, persistent or optional, to make driving
  easier. `apps/extension/scripts/verify-whatsapp-package.mjs` fails the build,
  and `vp run verify:whatsapp-packages` is part of the verification order.
- Do not reach for MAIN-world injection or the workspace to capture bytes.
  ADR 0001 excludes both. `action` is the supported way in.
- Screenshots of a contact's Status stay in `.local/verify-evidence/`. Never
  put contact names in a commit, PR, or issue, and check a screenshot before it
  leaves the machine.
