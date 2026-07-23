# CLI setup and compatibility

The GramGrab CLI talks only to the browser extension. The browser starts the native host, and the
native host exposes a per-user local endpoint to the CLI. Instagram credentials and media fetching
remain inside the browser extension.

## Compatibility targets

| Operating system | Chromium                        | Firefox                         | Local endpoint                                               |
| ---------------- | ------------------------------- | ------------------------------- | ------------------------------------------------------------ |
| Linux            | Implemented, manual run pending | Implemented, manual run pending | `$XDG_RUNTIME_DIR/gramgrab-UID.sock`, falling back to `/tmp` |
| macOS            | Implemented, manual run pending | Implemented, manual run pending | `/tmp/gramgrab-UID.sock`                                     |
| Windows          | Implemented, manual run pending | Implemented, manual run pending | `\\.\pipe\gramgrab`                                          |

Node.js 22 or newer is required. The extension, CLI, and native host must use the same protocol
version.

## Portable artifacts

Run `vp run package-tools` to create the self-contained Node.js distribution under `artifacts/`.
The directory contains the `gramgrab.mjs` CLI, the `gramgrab-native-host.mjs` host, their shared
hashed bundle, native-host manifest templates, and `SHA256SUMS`. Copy the entire directory because
both entry points import the shared bundle. CI builds and launches this distribution on Linux,
macOS, and Windows and publishes one workflow artifact per operating system.

On Windows, use `gramgrab.cmd` and point the native-host manifest at
`gramgrab-native-host.cmd`. On Linux and macOS, use the executable `.mjs` entry points. If an
archive tool discarded Unix permissions, restore them with
`chmod 755 gramgrab.mjs gramgrab-native-host.mjs`.

## Manual native-host registration

1. Install dependencies with `vp install`.
2. Replace `__GRAMGRAB_NATIVE_HOST_PATH__` in the matching template under `artifacts/` with the
   absolute path to `artifacts/gramgrab-native-host.mjs`, or
   `artifacts/gramgrab-native-host.cmd` on Windows. When running from source, use the templates and
   host entry point under `apps/native-host` instead.
3. For Chromium, also replace `__GRAMGRAB_EXTENSION_ID__` with the ID shown for the unpacked
   extension.
4. Register the completed manifest using the browser and operating-system location below.
5. Reload the extension, then run `artifacts/gramgrab.mjs status`.

Automatic registration is intentionally not performed. Registration locations and policy differ
between browser channels and managed devices, so installation remains an explicit administrator or
user action.

### Registration locations

| System  | Chromium                                                                                                                             | Firefox                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Linux   | `~/.config/google-chrome/NativeMessagingHosts/dev.zytact.gramgrab.json`                                                              | `~/.mozilla/native-messaging-hosts/dev.zytact.gramgrab.json`                                                                  |
| macOS   | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.zytact.gramgrab.json`                                          | `~/Library/Application Support/Mozilla/NativeMessagingHosts/dev.zytact.gramgrab.json`                                         |
| Windows | Set the default value of `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.zytact.gramgrab` to the manifest's absolute path | Set the default value of `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\dev.zytact.gramgrab` to the manifest's absolute path |

Chromium derivatives use vendor-specific directories or registry roots. Use that browser's native
messaging documentation for channels other than Google Chrome.

## Protocol migration policy

Protocol versions are exact compatibility boundaries. A participant must reject an unsupported
version with `PROTOCOL_VERSION_UNSUPPORTED`; it must not guess, silently downgrade, or partially
decode a newer command. Additive and breaking wire changes both require a new protocol version,
updated participant decoders, shared compatibility fixtures, and an extension/native-host/CLI
release produced from the same revision.

## Troubleshooting

- `IPC_UNAVAILABLE` or a connection error means no browser-started native host owns the endpoint.
  Confirm registration, keep the extension enabled, and reload the browser.
- `Another GramGrab native host already owns ...` means another browser profile is active. Close
  the other profile before starting this one. The host never deletes a live profile's socket.
- `PROTOCOL_VERSION_UNSUPPORTED` means the installed pieces came from different releases. Update
  the extension, CLI, and native host together.
- A five-second timeout applies while waiting for the extension to accept a request, and a
  30-minute deadline bounds accepted work. Ctrl+C, process termination, client disconnect, and the
  terminal deadline propagate correlated cancellation to the extension. Runner-backed work closes
  its runner surface and worker. A browser download that was already accepted by the browser cannot
  be recalled.
- On Unix, stale socket files are removed only after a connection probe proves that no host is
  listening. The live socket is owner-only (`0600`) and is removed during normal shutdown.

Set `GRAMGRAB_IPC_PATH` only for development or isolated tests when a non-default endpoint is
required.
