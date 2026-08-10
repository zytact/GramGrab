# Reach WhatsApp Web through `activeTab`, not a host permission

GramGrab needs in-page execution on `https://web.whatsapp.com/` to acquire a Visible Status, which is the first feature in the extension that touches a page at all - Instagram acquisition goes to the API and needs no page access. We take `activeTab` plus `scripting` rather than declaring `https://web.whatsapp.com/*` in `host_permissions`.

## Considered options

A persistent `host_permissions` entry is simpler to reason about and survives reloads. An optional host permission keeps it off the install-time prompt while still being persistent once granted.

Both were rejected because they give GramGrab standing read access to a private messenger whenever that tab exists, whether or not anyone invoked the extension. `activeTab` makes "GramGrab can only see WhatsApp when you click it" verifiable from the manifest instead of being a promise about code, which matters for Chrome Web Store and Firefox review and sets the baseline every later WhatsApp decision inherits.

## Consequences

- Neither option was free: `scripting` is not in the manifest today, so both paths cost a new permission. The UX is identical either way.
- Platform-aware popup UI does not depend on the grant. The existing `tabs` permission already exposes `tab.url`, so the popup can detect a WhatsApp tab before any page access exists.
- `activeTab` is granted on both invocation surfaces GramGrab uses, toolbar and context menu, in Chromium and Firefox. It expires on navigation, but WhatsApp Web is a single-page app, so a capture-time grant is stable for the life of a capture.
- WhatsApp acquisition is therefore bound to the tab the person is looking at. The GramGrab workspace runs in its own tab and cannot be a WhatsApp capture surface.
