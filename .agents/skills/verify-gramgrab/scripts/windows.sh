# Windows Helium support for launch.sh, cleanup.sh and signin.sh, from WSL or
# from Git Bash on Windows. Sourced, never run, after the caller sets $repo and
# platform=linux. Sets $platform to wsl or native, and in Git Bash rewrites
# $repo to its C:/ form. ../windows.md explains the design.
#
# The browser always runs on Windows. From WSL it uses Windows memory and never
# takes focus through WSLg, while the build, the native host, its socket, the
# CLI and the drive scripts stay in WSL.

if [ -n "${WSL_DISTRO_NAME:-}" ]; then
  platform=wsl
  # Windows tools print UNC warnings or fail when started from a WSL directory.
  win() { (cd /mnt/c && "$@"); }
  win_path() { wslpath -w "$1"; }
  shell_path() { wslpath -u "$1"; }
  local_app_data="$(wslpath "$(win cmd.exe /d /c 'echo %LOCALAPPDATA%' | tr -d '\r')")"
  checkout_key="$(cd "$repo" && pwd -P)"
else
  platform=native
  # Git Bash rewrites arguments such as /f into paths before Windows tools see them.
  win() { MSYS_NO_PATHCONV=1 "$@"; }
  win_path() { cygpath -w "$1"; }
  # Node and Windows tools read the C:/ form, and Git Bash accepts it too.
  shell_path() { cygpath -m "$1"; }
  repo="$(cygpath -m "$repo")"
  local_app_data="$(cygpath -m "$LOCALAPPDATA")"
  # Git Bash keeps the case a path was typed in, and Windows ignores it.
  checkout_key="${repo,,}"
fi

win_root="$local_app_data/gramgrab-verify"
# Each checkout gets its own profile, extension copy and downloads, so sessions
# in different worktrees never share browser state.
win_id="$(printf '%s\n' "$checkout_key" | sha256sum | cut -c1-12)"
win_dir="$win_root/$win_id"
win_seed="$win_root/seed"
win_helium="${GRAMGRAB_BROWSER:-$local_app_data/imput/Helium/Application/chrome.exe}"
win_daily_profile="$local_app_data/imput/Helium/User Data"
win_host_key='HKCU\Software\Chromium\NativeMessagingHosts\dev.zytact.gramgrab'
# What the shared batch file runs for this checkout's session.
win_launcher="$repo/.local/verify/native-host"
[ "$platform" = native ] && win_launcher="$win_launcher.cmd"

# Prints the IDs of Helium browser processes for which the PowerShell condition
# $1 holds, with $c bound to the process command line and $a to the text $2.
# $2 travels as an environment variable, so no quote in a path can break the
# command. An exiting process has no command line, so $c falls back to "".
win_browser_pids() {
  win env GRAMGRAB_PS_ARG="$2" WSLENV="${WSLENV:+$WSLENV:}GRAMGRAB_PS_ARG" \
    powershell.exe -NoProfile -Command "\$a = \$env:GRAMGRAB_PS_ARG
    Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" |
    Where-Object { \$c = [string]\$_.CommandLine; \$c -notmatch '--type=' -and ($1) } |
    ForEach-Object { \$_.ProcessId }" | tr -d '\r'
}

# Browsers on profile $1, where the path ends at a quote, a space or the end, so
# a profile never matches another whose name only starts the same way.
win_profile_pids() { win_browser_pids "\$c -match ([regex]::Escape(\$a) + '(\"|\\s|\$)')" "$1"; }

# The person's own Helium, which is every Helium not on a verification profile.
win_daily_helium_pids() { win_browser_pids "-not \$c.Contains(\$a)" "$(win_path "$win_root")\\"; }

# Copies only what carries the Instagram and WhatsApp Web sessions from profile
# $1 to $2. The rest of a profile is gigabytes of cache and unrelated sites.
# The copy lands under a temporary name and moves into place once complete, so
# an interrupted copy never leaves a profile that launch.sh would accept.
win_copy_signins() {
  local source=$1 target=$2 partial="$2.partial"
  rm -rf "$partial"
  mkdir -p "$partial/Default/IndexedDB"
  cp "$source/Local State" "$partial/"
  (
    cd "$source/Default"
    cp Preferences "Secure Preferences" "$partial/Default/"
    cp -r Network "Local Storage" "Session Storage" "$partial/Default/"
    cp -r IndexedDB/https_web.whatsapp.com_0.indexeddb.* IndexedDB/https_www.instagram.com_0.indexeddb.* \
      "$partial/Default/IndexedDB/" 2>/dev/null || true
  )
  rm -rf "$target.old"
  [ ! -e "$target" ] || mv "$target" "$target.old"
  mv "$partial" "$target"
  rm -rf "$target.old"
}

win_add_host_key() {
  win reg.exe add "$win_host_key" /ve /t REG_SZ /d "$(win_path "$win_root/host/dev.zytact.gramgrab.json")" /f >/dev/null
}

# Writes $2 to file $1 only when it differs, so a host another session is
# running from is never rewritten under it.
win_write_if_changed() {
  [ -f "$1" ] && [ "$(cat "$1")" = "$2" ] || printf '%s' "$2" > "$1"
}

# Registers this session's native host. The registry key is per user, not per
# profile, so every Helium sees the same batch file. It serves only a browser
# launched with GRAMGRAB_VERIFY_HOST, and runs that session's $win_launcher,
# through wsl.exe when GRAMGRAB_VERIFY_DISTRO names a distro. The person's own
# Helium has neither variable and is turned away.
#
# The checkout file and the launcher go down before the key, and cleanup.sh
# removes the launcher before win_unregister_host. win_sessions_remain relies on both.
win_register_host() {
  local host="$win_root/host" node
  mkdir -p "$win_dir" "$host"
  win_path "$repo" > "$win_dir/checkout"
  node="$(node -p process.execPath)"
  if [ "$platform" = wsl ]; then
    printf '#!/usr/bin/env bash\ncd %q && exec %q apps/native-host/bin/gramgrab-native-host.mjs "$@"\n' \
      "$repo" "$node" > "$win_launcher"
    chmod 700 "$win_launcher"
  else
    printf '%s\r\n' '@echo off' "cd /d \"$(win_path "$repo")\"" \
      "\"$node\" apps\\native-host\\bin\\gramgrab-native-host.mjs %*" > "$win_launcher"
  fi
  win_write_if_changed "$host/gramgrab.bat" "$(printf '%s\r\n' \
    '@echo off' \
    'rem GramGrab verification host. Only a verify browser sets GRAMGRAB_VERIFY_HOST.' \
    'if not defined GRAMGRAB_VERIFY_HOST exit /b 1' \
    'if defined GRAMGRAB_VERIFY_DISTRO (' \
    '  wsl.exe -d %GRAMGRAB_VERIFY_DISTRO% -e "%GRAMGRAB_VERIFY_HOST%" %*' \
    ') else (' \
    '  "%GRAMGRAB_VERIFY_HOST%" %*' \
    ')')"
  win_write_if_changed "$host/dev.zytact.gramgrab.json" "$(node -e '
    const { readFileSync } = require("node:fs");
    const [template, bat] = process.argv.slice(1);
    const manifest = JSON.parse(readFileSync(template, "utf8"));
    process.stdout.write(JSON.stringify({ ...manifest, path: bat }, null, 2));
  ' "$repo/apps/native-host/manifests/chromium.json" "$(win_path "$host/gramgrab.bat")")"
  win_add_host_key
}

# True while a session runs in a checkout that still exists, from WSL or Git
# Bash. A deleted worktree that never ran cleanup leaves its directory here, and
# it must not pin the key. A launch that failed before registering never wrote
# the launcher.
win_sessions_remain() {
  local checkout dir
  for checkout in "$win_root"/*/checkout; do
    [ -f "$checkout" ] || continue
    dir="$(shell_path "$(tr -d '\r\n' < "$checkout")" 2>/dev/null)" || continue
    [ -f "$dir/.local/verify/native-host" ] || [ -f "$dir/.local/verify/native-host.cmd" ] && return 0
  done
  return 1
}

# Removes the registry key once no session in any checkout remains, so it stops
# hiding a real Windows install of the host that docs/cli-setup.md registers
# under Google\Chrome. A launch elsewhere writes its launcher before the key, so
# the second check gives back a key this removal raced with.
win_unregister_host() {
  win_sessions_remain && return
  win reg.exe delete "$win_host_key" /f >/dev/null 2>&1 || true
  if win_sessions_remain; then win_add_host_key; fi
}
