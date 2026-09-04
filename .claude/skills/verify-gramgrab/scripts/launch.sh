#!/usr/bin/env bash
# Build GramGrab, register a native-messaging host, and start a dedicated
# Chromium that loads the unpacked extension. Prints the session environment,
# which is also written to .local/verify/session.env.
#
# The profile persists across runs at .local/verify-profile/ so a hand-made
# Instagram and WhatsApp Web sign-in survives. Only the run state under
# .local/verify/ is throwaway.
#
#   GRAMGRAB_BROWSER   browser binary or name (default: helium, chromium, google-chrome)
#   GRAMGRAB_PROFILE   use a different profile directory, e.g. a second account
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo"

session_dir="$repo/.local/verify"
ext_dir="$repo/extension/chromium"

if [ -f "$session_dir/session.env" ]; then
  echo "A session already exists at $session_dir/session.env." >&2
  echo "Run scripts/cleanup.sh before launching another one." >&2
  exit 2
fi

browser=""
for candidate in "${GRAMGRAB_BROWSER:-}" helium chromium google-chrome google-chrome-stable; do
  [ -n "$candidate" ] || continue
  if [ -x "$candidate" ]; then browser="$candidate"; break; fi
  if resolved="$(command -v "$candidate" 2>/dev/null)"; then browser="$resolved"; break; fi
done
[ -n "$browser" ] || { echo "No Chromium browser found. Set GRAMGRAB_BROWSER." >&2; exit 2; }

# Google Chrome 137+ ignores --load-extension unless enterprise policy allows it.
# Helium and plain Chromium still honour it. Say so before burning a minute on a
# launch that cannot work.
case "$("$browser" --version 2>/dev/null)" in
  "Google Chrome"*)
    echo "Google Chrome ignores --load-extension since 137, so the extension will not load." >&2
    echo "Use Helium or Chromium: GRAMGRAB_BROWSER=helium $0" >&2
    exit 2
    ;;
esac

vp run build:chromium >/dev/null

mkdir -p "$session_dir"
profile="${GRAMGRAB_PROFILE:-$repo/.local/verify-profile}"
downloads="$session_dir/downloads"
mkdir -p "$profile/NativeMessagingHosts" "$profile/Default" "$downloads"

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
' "$profile/Default/Preferences" "$downloads"

# Chromium caches the extension's service worker script per profile and does not
# re-read it just because the unpacked directory changed. A rebuilt extension
# would then run the previous worker, which reads as "the fix does not work"
# when the fix was never loaded. Dropping the registration forces a re-read.
#
# This costs no sign-in: Instagram's session lives in Default/Cookies and the
# WhatsApp Web link lives in Default/IndexedDB. Only Database and ScriptCache
# live here, and both are rebuilt on demand. Removing ScriptCache alone leaves
# a registration pointing at a script that is gone, which fails to start at all.
rm -rf "$profile/Default/Service Worker"

# Chromium derives an unpacked extension's ID from the absolute directory path.
ext_id="$(node -e '
  const {createHash}=require("node:crypto");
  const hex=createHash("sha256").update(process.argv[1]).digest("hex").slice(0,32);
  process.stdout.write([...hex].map(d=>String.fromCharCode(97+parseInt(d,16))).join(""));
' "$ext_dir")"

port="$(node -e '
  const net=require("node:net");const s=net.createServer();
  s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});
')"

ipc_path="$session_dir/gramgrab.sock"

sed -e "s#__GRAMGRAB_NATIVE_HOST_PATH__#$repo/apps/native-host/bin/gramgrab-native-host.mjs#" \
    -e "s#__GRAMGRAB_EXTENSION_ID__#$ext_id#" \
    "$repo/apps/native-host/manifests/chromium.json" \
    > "$profile/NativeMessagingHosts/dev.zytact.gramgrab.json"

GRAMGRAB_IPC_PATH="$ipc_path" nohup "$browser" \
  --user-data-dir="$profile" \
  --load-extension="$ext_dir" \
  --remote-debugging-port="$port" \
  --no-first-run \
  --no-default-browser-check \
  about:blank \
  >"$session_dir/browser.log" 2>&1 &
pid=$!

cat > "$session_dir/session.env" <<ENV
export GRAMGRAB_VERIFY_PID=$pid
export GRAMGRAB_VERIFY_BROWSER=$browser
export GRAMGRAB_CDP_PORT=$port
export GRAMGRAB_EXT_ID=$ext_id
export GRAMGRAB_IPC_PATH=$ipc_path
export GRAMGRAB_VERIFY_DIR=$session_dir
export GRAMGRAB_VERIFY_PROFILE=$profile
export GRAMGRAB_VERIFY_DOWNLOADS=$downloads
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

cat "$session_dir/session.env"
