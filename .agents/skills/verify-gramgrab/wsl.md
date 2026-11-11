# Verifying from WSL

On WSL, `launch.sh`, `signin.sh`, `cleanup.sh` and `drive.mjs` drive Helium on
Windows, not a browser inside WSL. The browser then uses Windows memory instead
of the WSL VM's, and it never opens a WSLg window. The build, the native host,
its socket, the CLI and `doctor.mjs` all stay in WSL and work as written in
SKILL.md. `scripts/wsl.sh` holds the Windows-specific parts.

Never connect to, drive, or read the `DevToolsActivePort` of the person's own
Helium. Every run uses a separate profile, so it is a separate Helium process.

## Where things live

| What | Where |
| --- | --- |
| Browser | `%LOCALAPPDATA%\imput\Helium\Application\chrome.exe`, or `GRAMGRAB_BROWSER` |
| Profile | `%LOCALAPPDATA%\gramgrab-verify\profile`, kept across runs |
| Extension | `%LOCALAPPDATA%\gramgrab-verify\ext`, copied from `extension/chromium` on every launch |
| Downloads | `%LOCALAPPDATA%\gramgrab-verify\downloads`, removed by cleanup |
| Native host | `%LOCALAPPDATA%\gramgrab-verify\host` and one registry key, removed by cleanup |

`GRAMGRAB_VERIFY_PROFILE` and `GRAMGRAB_VERIFY_DOWNLOADS` in `session.env` hold
the `/mnt/c` form of those paths. `--reset-profile` deletes the Windows profile.

The profile cannot live under `.local/`. Helium opened from `\\wsl.localhost`
fails with `LockFileEx: Incorrect function` and `database is locked`, then exits.

## Sign-in is a copy

`signin.sh` copies the Instagram and WhatsApp Web sessions from the person's
own Helium (`Default` profile) instead of opening a window to sign in. It copies
`Local State`, `Preferences`, `Secure Preferences`, `Network` (cookies),
`Local Storage`, `Session Storage`, and the Instagram and WhatsApp IndexedDB
folders. That comes to about 100 MB of the profile's several gigabytes.

Helium locks its cookie file while it runs, and no flag lifts that lock, so the
copy needs every Helium window closed. When `launch.sh` reports no profile, or a
run fails at Instagram authentication, ask the person to close Helium, then run
`signin.sh`. They can reopen Helium as soon as it prints `Copied`. The copy
lasts until Instagram expires that session.

The copy includes the person's WhatsApp Web link. Live capture is still a human
checkpoint as described in `features/whatsapp-status.md`, and the evidence rules
in `docs/whatsapp-live-verification.md` still apply: no screenshots of Status
content.

## Native messaging

On Windows, Helium finds native hosts only through the registry, never in the
profile. `launch.sh` sets
`HKCU\Software\Chromium\NativeMessagingHosts\dev.zytact.gramgrab` to a manifest
whose host is `gramgrab.bat`. That batch file runs
`wsl.exe -d <distro> ... node apps/native-host/bin/gramgrab-native-host.mjs`,
so the host and its Unix socket stay in WSL.

The key is per user, so the person's own Helium sees it too, and their
installed GramGrab connects to it. The batch file serves only a browser
started with `GRAMGRAB_IPC_PATH` in its environment, which `launch.sh` passes
through `WSLENV`, and it turns every other caller away. Plain
`WSLENV=GRAMGRAB_IPC_PATH` works here, while the `/u` flag silently drops the
variable.

Helium reads the `Chromium` key before `Google\Chrome`. While a session runs, it
therefore hides a real Windows install of the GramGrab host, which
`docs/cli-setup.md` registers under `Google\Chrome`.

## CDP

WSL in NAT mode cannot reach Windows `127.0.0.1`. Helium picks its own debugging
port and prints it to `browser.log`. `launch.sh` then starts
`scripts/cdp-relay.mjs`, which forwards a local port through one `powershell.exe`
per connection, and records that local port as `GRAMGRAB_CDP_PORT`. Each
`drive.mjs` command takes about a second longer than on Linux.

## Windows and focus

The browser runs headless by default on WSL, because a Helium window takes focus
from whatever the person is doing. Headless covers everything except human
checkpoints. For those, tell the person a window is about to open, then launch
with `GRAMGRAB_HEADLESS=0`.

## When something fails

- `Profile ... is in use by another Helium`: an earlier run is still up. Run
  `cleanup.sh`, and if its browser was wedged, cleanup stops it with `taskkill`.
- `Helium is running` from `signin.sh`: the person's own Helium is open. Ask
  them to close it. Do not stop it yourself.
- No native host socket: check the registry key with
  `reg.exe query 'HKCU\Software\Chromium\NativeMessagingHosts\dev.zytact.gramgrab'`
  from `/mnt/c`, and confirm the distro in `host\gramgrab.bat` matches
  `$WSL_DISTRO_NAME`.
- `drive.mjs upload` converts its file argument with `wslpath -w`, so give it a
  WSL path as usual.
