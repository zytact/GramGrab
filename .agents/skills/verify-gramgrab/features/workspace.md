# Workspace and context menus

Moving a popup session into one long-lived tab and opening Instagram sources
from the browser context menu.

## Sub-features

- `Open in tab` creates one workspace and transfers the current source,
  acquisition kind, results, selection, and export settings.
- `Go to tab` focuses the existing workspace without creating a duplicate.
- `Replace tab session` asks before replacing the workspace with newer popup
  state. Cancel keeps the old state; Replace transfers the new state.
- A busy popup cannot open or replace the workspace. A busy workspace refuses
  an automatic silent-batch replacement.
- The GramGrab context submenu appears for supported Instagram pages and links.
  `Open in GramGrab` fills the workspace without fetching; `Fetch with GramGrab`
  starts acquisition. Unsupported pages and links hide the root menu.

## Driving it

Fetch a multi-item source in plain `popup.html`, change selection and one frame
setting, then click `.workspace-launch`. Wait for the new
`popup.html?surface=workspace` target. Its source, results, selected rows, and
frame setting must match the popup.

Open plain `popup.html` again. It must say `Go to tab`. Count workspace targets,
click `.workspace-launch`, and count again. The existing workspace comes to the
front and the count stays one.

Fetch a different source in the popup. Click `Replace tab session`, capture the
`Replace workspace session` dialog, and choose Cancel. The workspace keeps its
old source. Repeat and choose Replace; the same workspace target reloads with
the new source and session state. Start a download before attempting the action
once more and require the open or replace control to stay disabled.

Browser context menus need a human checkpoint because CDP does not expose the
native menu. Check these paths in the dedicated browser:

1. Right-click a supported Instagram page. The GramGrab submenu has `Open in
   GramGrab` and `Fetch with GramGrab`.
2. Choose Open. One workspace opens with the canonical source and does not
   fetch until requested.
3. Choose Fetch on another supported Instagram page or link. The same workspace
   is replaced and begins fetching.
4. Right-click a non-Instagram page and unsupported Instagram route. GramGrab
   is absent.
5. On a non-Instagram page, right-click a supported Instagram link. GramGrab is
   present and uses the link target rather than the page URL.

Run the focused coordinator and background routing tests too:

```bash
vp test run apps/extension/src/workspace/coordinator.test.ts apps/extension/src/workspace/contracts.test.ts apps/extension/src/background.test.ts
```

## What proves it works

- There is never more than one workspace tab.
- A transfer preserves all visible session state and consumes its one-minute
  offer without stale state appearing on a later workspace.
- Cancel and Replace affect the existing workspace exactly as labelled.
- Open and Fetch use the canonical context target, including a supported link
  on an unrelated page.
- Unsupported targets expose no actionable GramGrab context menu.
