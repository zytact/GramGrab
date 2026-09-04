# Release artifacts

Building what people install. The live harness runs unpacked Chromium, so this
entry owns the browser and CLI packages that path does not exercise.

## Coverage

- Chromium and Firefox extension builds.
- Manifest policy checks for both outputs.
- Chromium CRX and Firefox XPI packaging.
- CLI and native-host bundles under `artifacts/`.
- Package contents and source-tree cleanliness.

## Driving it

```bash
vp run build
vp run verify:whatsapp-packages
vp run package:chromium
vp run package:firefox
vp run package:tools
```

Inspect `extension/chromium/gramgrab.crx`, `extension/firefox/gramgrab.xpi`, and
the files under `artifacts/`; confirm each is non-empty. The browser packages
must contain their manifest, popup, runner, background worker, controller,
icons, license, and third-party notices. Run the packaged CLI against the
verification session rather than using the source entry point for this check:

```bash
node artifacts/gramgrab.mjs help
node artifacts/gramgrab.mjs status --json
(cd artifacts && sha256sum --check SHA256SUMS)
```

## What proves it works

- All five commands exit 0.
- Chromium and Firefox manifests select the correct background form and version.
- `verify:whatsapp-packages` confirms there is no content script or WhatsApp
  host permission in either build.
- The packaged CLI prints help and completes a compatible status round trip.
- `git status --short` contains no generated artifact outside ignored output
  directories and no unexpected source changes.

## Environment boundary

A Linux run proves the Linux native-host registration used by `launch.sh`. It
does not prove Windows registry installation, macOS manifest placement, Firefox
native messaging, store installation, or browser signing. Record those as
environment-specific release checks when they matter. A successful local build
is not evidence that another operating system installed the host.
