# Windows Helium support for launch.sh, cleanup.sh and signin.sh on WSL.
# Sourced only when WSL_DISTRO_NAME is set, never run. ../wsl.md explains the design.
#
# The browser runs on Windows so it uses Windows memory and never takes focus
# through WSLg. Everything else stays in WSL: the build, the native host, its
# socket, the CLI and the drive scripts.

# Windows tools print UNC warnings or fail when started from a WSL directory.
win() { (cd /mnt/c && "$@"); }

local_app_data="$(wslpath "$(win cmd.exe /d /c 'echo %LOCALAPPDATA%' | tr -d '\r')")"
wsl_root="$local_app_data/gramgrab-verify"
wsl_helium="${GRAMGRAB_BROWSER:-$local_app_data/imput/Helium/Application/chrome.exe}"
wsl_daily_profile="$local_app_data/imput/Helium/User Data"
wsl_host_key='HKCU\Software\Chromium\NativeMessagingHosts\dev.zytact.gramgrab'

# Prints the IDs of Helium browser processes whose command line contains $1.
wsl_helium_pids() {
  win powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" |
    Where-Object { \$_.CommandLine -notmatch '--type=' -and \$_.CommandLine.Contains('$1') } |
    ForEach-Object { \$_.ProcessId }" | tr -d '\r'
}

# Registers a native host that serves only browsers launched with
# GRAMGRAB_IPC_PATH set. The registry key is per user, not per profile, so the
# daily Helium sees it too, and the gate turns its connections away.
wsl_register_host() {
  local repo=$1 host="$wsl_root/host"
  mkdir -p "$host"
  printf '%s\r\n' \
    '@echo off' \
    'rem GramGrab verification host. Only the verify browser sets GRAMGRAB_IPC_PATH.' \
    'if not defined GRAMGRAB_IPC_PATH exit /b 1' \
    "wsl.exe -d $WSL_DISTRO_NAME --cd $repo -e $(command -v node) apps/native-host/bin/gramgrab-native-host.mjs %*" \
    > "$host/gramgrab.bat"
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const [template, target, bat] = process.argv.slice(1);
    const manifest = JSON.parse(readFileSync(template, "utf8"));
    writeFileSync(target, JSON.stringify({ ...manifest, path: bat }, null, 2));
  ' "$repo/apps/native-host/manifests/chromium.json" "$host/dev.zytact.gramgrab.json" "$(wslpath -w "$host/gramgrab.bat")"
  win reg.exe add "$wsl_host_key" /ve /t REG_SZ /d "$(wslpath -w "$host/dev.zytact.gramgrab.json")" /f >/dev/null
}

wsl_unregister_host() {
  win reg.exe delete "$wsl_host_key" /f >/dev/null 2>&1 || true
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
