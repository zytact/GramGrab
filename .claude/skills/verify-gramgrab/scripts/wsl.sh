# Windows Helium support for launch.sh, cleanup.sh and signin.sh on WSL.
# Sourced only when WSL_DISTRO_NAME is set, never run, after the caller sets
# $repo. ../wsl.md explains the design.
#
# The browser runs on Windows so it uses Windows memory and never takes focus
# through WSLg. Everything else stays in WSL: the build, the native host, its
# socket, the CLI and the drive scripts.

# Windows tools print UNC warnings or fail when started from a WSL directory.
win() { (cd /mnt/c && "$@"); }

local_app_data="$(wslpath "$(win cmd.exe /d /c 'echo %LOCALAPPDATA%' | tr -d '\r')")"
wsl_root="$local_app_data/gramgrab-verify"
# Each checkout gets its own profile, extension copy and downloads, so sessions
# in different worktrees never share browser state.
wsl_dir="$wsl_root/$(cd "$repo" && pwd -P | sha256sum | cut -c1-12)"
wsl_seed="$wsl_root/seed"
wsl_helium="${GRAMGRAB_BROWSER:-$local_app_data/imput/Helium/Application/chrome.exe}"
wsl_daily_profile="$local_app_data/imput/Helium/User Data"
wsl_host_key='HKCU\Software\Chromium\NativeMessagingHosts\dev.zytact.gramgrab'

# Prints the IDs of Helium browser processes for which the PowerShell condition
# $1 holds, with $c bound to the process command line.
wsl_browser_pids() {
  win powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" |
    Where-Object { \$c = \$_.CommandLine; \$c -notmatch '--type=' -and ($1) } |
    ForEach-Object { \$_.ProcessId }" | tr -d '\r'
}

wsl_profile_pids() { wsl_browser_pids "\$c.Contains('$1')"; }

# The person's own Helium, which is every Helium not on a verification profile.
wsl_daily_helium_pids() { wsl_browser_pids "-not \$c.Contains('$(wslpath -w "$wsl_root")\\')"; }

# Copies only what carries the Instagram and WhatsApp Web sessions from profile
# $1 to $2. The rest of a profile is gigabytes of cache and unrelated sites.
wsl_copy_signins() {
  local source=$1 target=$2
  rm -rf "$target"
  mkdir -p "$target/Default/IndexedDB"
  cp "$source/Local State" "$target/"
  (
    cd "$source/Default"
    cp Preferences "Secure Preferences" "$target/Default/"
    cp -r Network "Local Storage" "Session Storage" "$target/Default/"
    cp -r IndexedDB/https_web.whatsapp.com_0.indexeddb.* IndexedDB/https_www.instagram.com_0.indexeddb.* \
      "$target/Default/IndexedDB/" 2>/dev/null || true
  )
}

wsl_add_host_key() {
  win reg.exe add "$wsl_host_key" /ve /t REG_SZ /d "$(wslpath -w "$wsl_root/host/dev.zytact.gramgrab.json")" /f >/dev/null
}

# Writes $2 to file $1 only when it differs, so a host another session is
# running from is never rewritten under it.
wsl_write_if_changed() {
  [ -f "$1" ] && [ "$(cat "$1")" = "$2" ] || printf '%s' "$2" > "$1"
}

# Registers this session's native host. The registry key is per user, not per
# profile, so every Helium sees the same generic batch file. It serves only a
# browser launched with GRAMGRAB_IPC_PATH and GRAMGRAB_WSL_DISTRO, and runs
# "$GRAMGRAB_IPC_PATH.host", the launcher this writes next to that session's
# socket. The person's own Helium has neither variable and is turned away.
#
# The session marker goes down before the key, which wsl_unregister_host relies on.
wsl_register_host() {
  local ipc_path=$1 host="$wsl_root/host"
  mkdir -p "$wsl_dir" "$host"
  printf '%s\n' "$repo" > "$wsl_dir/checkout"
  : > "$wsl_dir/session"
  printf '#!/usr/bin/env bash\ncd %q && exec %q apps/native-host/bin/gramgrab-native-host.mjs "$@"\n' \
    "$repo" "$(command -v node)" > "$ipc_path.host"
  chmod 700 "$ipc_path.host"
  wsl_write_if_changed "$host/gramgrab.bat" "$(printf '%s\r\n' \
    '@echo off' \
    'rem GramGrab verification host. Only a verify browser sets GRAMGRAB_IPC_PATH.' \
    'if not defined GRAMGRAB_IPC_PATH exit /b 1' \
    'if not defined GRAMGRAB_WSL_DISTRO exit /b 1' \
    'wsl.exe -d %GRAMGRAB_WSL_DISTRO% -e "%GRAMGRAB_IPC_PATH%.host" %*')"
  wsl_write_if_changed "$host/dev.zytact.gramgrab.json" "$(node -e '
    const { readFileSync } = require("node:fs");
    const [template, bat] = process.argv.slice(1);
    const manifest = JSON.parse(readFileSync(template, "utf8"));
    process.stdout.write(JSON.stringify({ ...manifest, path: bat }, null, 2));
  ' "$repo/apps/native-host/manifests/chromium.json" "$(wslpath -w "$host/gramgrab.bat")")"
  wsl_add_host_key
}

# True while a session runs in a checkout that still exists. A deleted worktree
# that never ran cleanup leaves a marker, and it must not pin the key forever.
wsl_sessions_remain() {
  local marker
  for marker in "$wsl_root"/*/session; do
    [ -f "$marker" ] && [ -d "$(cat "${marker%session}checkout" 2>/dev/null)" ] && return 0
  done
  return 1
}

# Removes the registry key once no session in any checkout remains, so it stops
# hiding a real Windows install of the host that docs/cli-setup.md registers
# under Google\Chrome. A launch elsewhere writes its marker before the key, so
# the second check gives back a key this removal raced with.
wsl_unregister_host() {
  rm -f "$wsl_dir/session"
  wsl_sessions_remain && return
  win reg.exe delete "$wsl_host_key" /f >/dev/null 2>&1 || true
  if wsl_sessions_remain; then wsl_add_host_key; fi
}

# Starts the CDP relay on a free local port and prints "<port> <pid>". WSL
# cannot reach Windows 127.0.0.1 without mirrored networking.
wsl_start_relay() {
  local windows_port=$1 log=$2 port pid
  port="$(node -e '
    const s = require("node:net").createServer();
    s.listen(0, "127.0.0.1", () => { process.stdout.write(String(s.address().port)); s.close(); });
  ')"
  nohup node "$(dirname "${BASH_SOURCE[0]}")/cdp-relay.mjs" "$windows_port" "$port" >>"$log" 2>&1 &
  pid=$!
  echo "$port $pid"
}
