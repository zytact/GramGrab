# WhatsApp Visible Status

Capturing the one Status currently open in the WhatsApp Web viewer and handing
the bytes to a short-lived edit session. This is the most constrained path in
the app: privacy rules bind verification as tightly as they bind code.

Read `docs/whatsapp-privacy.md` and ADRs 0001 to 0004 before driving anything
here. `docs/whatsapp-live-verification.md` is the human-run procedure, and
`docs/whatsapp-boundary-coverage.md` maps each boundary to the synthetic test
that owns it. Synthetic tests stay authoritative; a live run only establishes
what current WhatsApp Web and the browser actually do.

## Sub-features

- Eligibility: the panel offers capture only when the active tab is WhatsApp
  Web. Otherwise it shows `Open WhatsApp Web`.
- Capture: one `scripting.executeScript` injection of
  `js/whatsapp-controller.js` into the top frame, isolated world, under
  `activeTab`, then a bounded chunk protocol over a `tabs.connect` port.
- Edit session: a single hero item, a flat 10-minute lease from
  capture-complete. Interaction never extends it. Frame and Remove audio work
  the same as elsewhere, pre-flight checked against the remaining lease.
- Expiry and re-capture: `Editing session expired`, then
  `Capture Visible Status again`.
- Receipts: history gains a receipt with no name and no re-download.
- Diagnostics: a structural-only type that cannot hold a URL, name, or
  identifier.

## How to get to it (user POV)

Open WhatsApp Web, open a Status in the viewer, then open the GramGrab popup on
that tab and switch to `WhatsApp Status` in the platform navigation.

The verification profile keeps its WhatsApp Web link across runs once someone
has linked a device through `scripts/signin.sh`, so the viewer is reachable
without re-scanning a code every time.

## Driving it with the harness

Only the ineligible state is safely scriptable, and it is worth capturing:

```bash
cd /home/arnab/Projects/GramGrab && . ./.local/verify/session.env
D=.agents/skills/verify-gramgrab/scripts/drive.mjs

node $D open "chrome-extension://$GRAMGRAB_EXT_ID/popup.html"
node $D eval "popup.html" \
  "document.querySelector('nav[aria-label=\"Download platform\"] button:nth-of-type(2)').click(), 'switched'"
node $D wait "popup.html" "Open WhatsApp Web"
node $D shot "popup.html" "\$EV/whatsapp-ineligible.png"
```

**The eligible state is not reachable from the harness at all**, and this was
measured rather than assumed. The panel decides eligibility from
`tabs.query({active: true, currentWindow: true})`, and a popup opened as a tab
is itself the active tab. Querying from a driven popup returns its own
`chrome-extension://.../popup.html`, never the WhatsApp tab, no matter which
window holds what. So a scripted run can only ever photograph `Open WhatsApp
Web`. Capture needs the real toolbar popup, opened by a person, on a real
WhatsApp tab. That is `activeTab` working as ADR 0001 intends, not an obstacle
to route around.

Follow `docs/whatsapp-live-verification.md` for the rest: dedicated QA accounts,
a dedicated profile, two purpose-made generic test cards, and the fixed evidence
schema in `docs/whatsapp-live-verification-evidence.md`. A signed-in personal
WhatsApp is the wrong account for this. Capturing a real contact's Status to
prove a code path violates the same privacy contract the code is written to
honour.

## What proves it works

- Ineligible: the panel shows `Open WhatsApp Web` and offers no capture control.
- Captured: the panel shows `Visible Status captured` and the hero renders a
  photo as an image and an MP4 as a video, never a poster-only fallback.
- Expiry: after ten minutes the panel shows `Editing session expired` with the
  exact copy in the live-verification matrix, and re-capture produces a new hero.
- Advancement race: advancing the viewer mid-capture yields either the originally
  guarded item or `WHATSAPP_STATUS_CHANGED`. Never the next Status.
- Cleanup: captured bytes and any extension-created blob URL are released after
  an accepted download, and after cancellation or failure.

## Gotchas

- Do not add a WhatsApp host permission, persistent or optional, to make driving
  easier. `apps/extension/scripts/verify-whatsapp-package.mjs` fails the build,
  and `vp run verify:whatsapp-packages` is part of the verification order.
- Do not reach for MAIN-world injection, DevTools, persistent storage, the
  workspace, or a service-worker workaround to capture bytes. Each one is
  excluded by an ADR.
- Captured bytes are memory-only. There is no file to inspect mid-session, and
  the absence of one is a property to verify rather than a limitation.
- The lease is flat and starts at capture-complete. A slow scripted run can
  expire it mid-drive and look like a bug.
- The evidence file takes only the fixed schema: pass or fail, plus a symbolic
  failure code the extension actually presented. No prose observations, no
  screenshots of real Status content.
