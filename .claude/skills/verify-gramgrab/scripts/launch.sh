#!/usr/bin/env bash
# Build GramGrab, register a native-messaging host, and start a dedicated
# Chromium that loads the unpacked extension. Prints the session environment,
# which is also written to .local/verify/session.env.
#
# The profile persists across runs at .local/verify-profile/ so a hand-made
# Instagram and WhatsApp Web sign-in survives. Only the run state under
# .local/verify/ is throwaway. On WSL the browser is Windows Helium instead;
# ../wsl.md covers that path.
#
#   GRAMGRAB_BROWSER   browser binary or name (default: helium, chromium, Chrome
#                      for Testing in ~/.cache/gramgrab-verify-browser)
#   GRAMGRAB_PROFILE   use a different profile directory, e.g. a second account
#   GRAMGRAB_HEADLESS  1 or 0 (default: 1 on WSL or without a display)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo"

session_dir="$repo/.local/verify"
ext_dir="$repo/extension/chromium"
restart=no
case "${1:-}" in
  "") ;;
  --restart) restart=yes ;;
  *) echo "Usage: $0 [--restart]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "Usage: $0 [--restart]" >&2; exit 2; }

if [ -f "$session_dir/session.env" ]; then
  echo "A session already exists at $session_dir/session.env." >&2
  echo "Run scripts/cleanup.sh before launching another one." >&2
  exit 2
fi

wsl=no
if [ -n "${WSL_DISTRO_NAME:-}" ]; then
  wsl=yes
  # shellcheck source=wsl.sh
  . "$(dirname "${BASH_SOURCE[0]}")/wsl.sh"
fi

browser=""
if [ "$wsl" = yes ]; then
  [ -x "$wsl_helium" ] || { echo "No Windows Helium at $wsl_helium. Set GRAMGRAB_BROWSER to its chrome.exe." >&2; exit 2; }
  browser="$wsl_helium"
else
  downloaded="$(ls -d "$HOME"/.cache/gramgrab-verify-browser/chrome/linux-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -n 1 || true)"
  for candidate in "${GRAMGRAB_BROWSER:-}" helium chromium "$downloaded" google-chrome google-chrome-stable; do
    [ -n "$candidate" ] || continue
    if [ -x "$candidate" ]; then browser="$candidate"; break; fi
    if resolved="$(command -v "$candidate" 2>/dev/null)"; then browser="$resolved"; break; fi
  done
  [ -n "$browser" ] || { echo "No Chromium browser found. Set GRAMGRAB_BROWSER." >&2; exit 2; }

  # A downloaded browser starts without its system libraries and only says so in
  # browser.log after the CDP wait times out, so name them up front.
  missing="$(ldd "$browser" 2>/dev/null | awk '/not found/ {print $1}' || true)"
  if [ -n "$missing" ]; then
    echo "$browser is missing shared libraries:" $missing >&2
    echo "On Ubuntu, sudo apt install libnss3 provides the usual ones." >&2
    exit 2
  fi

  # Google Chrome 137+ ignores --load-extension unless enterprise policy allows it.
  # Helium, Chromium and Chrome for Testing still honour it. Say so before burning
  # a minute on a launch that cannot work.
  case "$("$browser" --version 2>/dev/null)" in
    "Google Chrome for Testing"*) ;;
    "Google Chrome"*)
      echo "Google Chrome ignores --load-extension since 137, so the extension will not load." >&2
      echo "Use Helium, Chromium or Chrome for Testing: GRAMGRAB_BROWSER=helium $0" >&2
      exit 2
      ;;
  esac
fi

# On WSL a window would take focus from whatever the person is doing, so the
# Windows browser runs headless unless someone asks for a window.
headless="${GRAMGRAB_HEADLESS:-}"
if [ -z "$headless" ]; then
  if [ "$wsl" = yes ] || [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then headless=1; else headless=0; fi
fi
headless_flag=()
[ "$headless" = 1 ] && headless_flag=(--headless --window-size=1280,900)

if [ "$restart" = no ]; then vp run build:chromium >/dev/null; fi
build_fingerprint="$(rg --files "$ext_dir" -0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"

mkdir -p "$session_dir"
if [ "$wsl" = yes ]; then
  profile="${GRAMGRAB_PROFILE:-$wsl_dir/profile}"
  downloads="$wsl_dir/downloads"
  # A new checkout starts from the sign-ins signin.sh last copied, so only the
  # first checkout on a machine has to close the person's Helium.
  if [ ! -f "$profile/Local State" ] && [ -z "${GRAMGRAB_PROFILE:-}" ] && [ -f "$wsl_seed/Local State" ]; then
    wsl_copy_signins "$wsl_seed" "$profile"
  fi
  [ -f "$profile/Local State" ] || {
    echo "No verification profile at $profile." >&2
    echo "Ask the person to close Helium. Once they confirm, run scripts/signin.sh yourself." >&2
    exit 2
  }
  if [ -n "$(wsl_profile_pids "$(wslpath -w "$profile")")" ]; then
    echo "Profile $profile is in use by another Helium." >&2
    echo "Run scripts/cleanup.sh, or wait for that run to end." >&2
    exit 2
  fi
  mkdir -p "$profile/Default" "$downloads"
else
  profile="${GRAMGRAB_PROFILE:-$repo/.local/verify-profile}"
  downloads="$session_dir/downloads"

  # A running browser that holds the profile takes the launch over and never opens
  # this run's CDP port, so fail with the owner instead of a port timeout.
  lock_pid="$(readlink "$profile/SingletonLock" 2>/dev/null | sed 's/.*-//' || true)"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "Profile $profile is in use by browser pid $lock_pid." >&2
    echo "Copy it and set GRAMGRAB_PROFILE to the copy, or wait for that run to end." >&2
    exit 2
  fi
  mkdir -p "$profile/NativeMessagingHosts" "$profile/Default" "$downloads"
fi

# Force the download directory on every launch, not only the first. Chromium
# rewrites Preferences on exit, and a profile that arrived any other way would
# otherwise send accepted downloads to the real ~/Downloads with no warning.
node -e '
  const {readFileSync,writeFileSync,existsSync}=require("node:fs");
  const [file,dir]=process.argv.slice(1);
  let prefs={};
  if (existsSync(file)) {
    try { prefs=JSON.parse(readFileSync(file,"utf8")); } catch { prefs={}; }
  }
  prefs.download={...prefs.download,default_directory:dir,prompt_for_download:false};
  prefs.savefile={...prefs.savefile,default_directory:dir};
  writeFileSync(file,JSON.stringify(prefs));
' "$profile/Default/Preferences" "$([ "$wsl" = yes ] && wslpath -w "$downloads" || echo "$downloads")"

# Chromium caches the extension's service worker script per profile and does not
# re-read it just because the unpacked directory changed. A rebuilt extension
# would then run the previous worker, which reads as "the fix does not work"
# when the fix was never loaded. Dropping the registration forces a re-read.
#
# This costs no sign-in: Instagram's session lives in Default/Cookies and the
# WhatsApp Web link lives in Default/IndexedDB. Only Database and ScriptCache
# live here, and both are rebuilt on demand. Removing ScriptCache alone leaves
# a registration pointing at a script that is gone, which fails to start at all.
if [ "$restart" = yes ]; then
  [ -f "$profile/.gramgrab-verification-build" ] &&
    [ "$(cat "$profile/.gramgrab-verification-build")" = "$build_fingerprint" ] || {
      echo "Restart requires the unchanged build from a successful fresh launch." >&2
      exit 2
    }
else
  rm -rf "$profile/Default/Service Worker"
fi

# The manifest `key` pins the extension ID, so unpacked builds share the release ID.
ext_id="$(node --input-type=module -e '
  const { CHROMIUM_EXTENSION_ID } = await import(process.argv[1]);
  process.stdout.write(CHROMIUM_EXTENSION_ID);
' "$repo/apps/extension/scripts/release.mjs")"

ipc_path="$session_dir/gramgrab.sock"
if [ "${#ipc_path}" -gt 107 ]; then
  echo "Socket path $ipc_path exceeds the 107-byte Unix socket limit. Launch from a shorter checkout path or a symlink to it." >&2
  exit 1
fi

relay_pid=""
if [ "$wsl" = yes ]; then
  # Windows Helium cannot load an extension or profile from the WSL filesystem,
  # so the build is copied next to the profile.
  rm -rf "$wsl_dir/ext"
  cp -r "$ext_dir" "$wsl_dir/ext"
  wsl_register_host "$ipc_path"

  # Helium picks its own CDP port and prints it, since WSL cannot test which
  # Windows ports are free. WSLENV carries the socket path through Helium into
  # the host batch file, which is what tells it this is a verify browser and
  # which session it serves.
  GRAMGRAB_IPC_PATH="$ipc_path" \
    WSLENV="${WSLENV:+$WSLENV:}GRAMGRAB_IPC_PATH" nohup "$browser" \
    --user-data-dir="$(wslpath -w "$profile")" \
    --load-extension="$(wslpath -w "$wsl_dir/ext")" \
    --remote-debugging-port=0 \
    --no-first-run \
    --no-default-browser-check \
    "${headless_flag[@]}" \
    about:blank \
    >"$session_dir/browser.log" 2>&1 &
  pid=$!
  windows_port=""
  for _ in $(seq 1 60); do
    windows_port="$(sed -n 's#^DevTools listening on ws://127.0.0.1:\([0-9]*\)/.*#\1#p' "$session_dir/browser.log" 2>/dev/null || true)"
    [ -n "$windows_port" ] && break
    sleep 0.5
  done
  port=0
  [ -n "$windows_port" ] && read -r port relay_pid < <(wsl_start_relay "$windows_port" "$session_dir/relay.log")
else
  port="$(node -e '
    const net=require("node:net");const s=net.createServer();
    s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});
  ')"
  sed -e "s#__GRAMGRAB_NATIVE_HOST_PATH__#$repo/apps/native-host/bin/gramgrab-native-host.mjs#" \
      "$repo/apps/native-host/manifests/chromium.json" \
      > "$profile/NativeMessagingHosts/dev.zytact.gramgrab.json"

  GRAMGRAB_IPC_PATH="$ipc_path" nohup "$browser" \
    --user-data-dir="$profile" \
    --load-extension="$ext_dir" \
    --remote-debugging-port="$port" \
    --no-first-run \
    --no-default-browser-check \
    "${headless_flag[@]}" \
    about:blank \
    >"$session_dir/browser.log" 2>&1 &
  pid=$!
fi

cat > "$session_dir/session.env" <<ENV
export GRAMGRAB_VERIFY_PID=$pid
export GRAMGRAB_VERIFY_BROWSER=$browser
export GRAMGRAB_CDP_PORT=$port
export GRAMGRAB_EXT_ID=$ext_id
export GRAMGRAB_IPC_PATH=$ipc_path
export GRAMGRAB_VERIFY_DIR=$session_dir
export GRAMGRAB_VERIFY_PROFILE=$profile
export GRAMGRAB_VERIFY_DOWNLOADS=$downloads
export GRAMGRAB_VERIFY_HEADLESS=$headless
export GRAMGRAB_VERIFY_RELAY_PID=$relay_pid
ENV

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 || {
  echo "The browser never opened a CDP port. See $session_dir/browser.log" >&2
  exit 1
}

# The extension's service worker connects to the native host on startup, so the
# socket appearing proves the extension loaded and native messaging is wired.
for _ in $(seq 1 60); do
  [ -S "$ipc_path" ] && break
  sleep 0.5
done
[ -S "$ipc_path" ] || {
  echo "No native host socket at $ipc_path after 30s." >&2
  echo "Run scripts/doctor.mjs to see whether the extension loaded at all." >&2
  exit 1
}

printf '%s\n' "$build_fingerprint" > "$profile/.gramgrab-verification-build"
cat "$session_dir/session.env"
