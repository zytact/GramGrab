#!/bin/sh
# Installs or updates the GramGrab CLI and native host from a GitHub release.
# Set GRAMGRAB_RELEASE_URL to a release's download URL to install that release instead of the latest.
set -eu

release_url="${GRAMGRAB_RELEASE_URL:-https://github.com/zytact/GramGrab/releases/latest/download}"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gramgrab"
bin_dir="$HOME/.local/bin"

fail() {
  echo "gramgrab: $1" >&2
  exit 1
}

for tool in node curl tar; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done
if command -v sha256sum >/dev/null 2>&1; then
  sha256='sha256sum'
else
  sha256='shasum -a 256'
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$release_url/gramgrab-tools.tar.gz" -o "$tmp/gramgrab-tools.tar.gz"
curl -fsSL "$release_url/SHA256SUMS" -o "$tmp/SHA256SUMS"
(cd "$tmp" && grep '  gramgrab-tools.tar.gz$' SHA256SUMS | $sha256 -c - >/dev/null 2>&1) ||
  fail 'gramgrab-tools.tar.gz does not match the release checksum'

mkdir "$tmp/tools"
tar -xzf "$tmp/gramgrab-tools.tar.gz" -C "$tmp/tools"
version="$(node "$tmp/tools/gramgrab.mjs" --version || true)"
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
  fail "this release needs Node.js 22.18+ or 24.2+, but node is $(node --version)"

previous="$(readlink "$data_dir/current" 2>/dev/null || true)"
if [ "$previous" = "versions/$version" ]; then
  echo "GramGrab $version is already up to date."
  exit 0
fi

mkdir -p "$data_dir/versions" "$bin_dir"
[ -d "$data_dir/versions/$version" ] || mv "$tmp/tools" "$data_dir/versions/$version"
ln -sfn "versions/$version" "$data_dir/current"
ln -sfn "$data_dir/current/gramgrab.mjs" "$bin_dir/gramgrab"
for browser in chromium firefox; do
  node -e '
    const fs = require("node:fs");
    const [template, output, host] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(template, "utf8"));
    fs.writeFileSync(output, JSON.stringify({ ...manifest, path: host }, undefined, 2) + "\n");
  ' "$data_dir/current/$browser.json" "$data_dir/$browser.json" \
    "$data_dir/current/gramgrab-native-host.mjs"
done

# Keep the new version and the one it replaced.
for dir in "$data_dir"/versions/*; do
  name="versions/$(basename "$dir")"
  [ "$name" = "versions/$version" ] || [ "$name" = "$previous" ] || rm -rf "$dir"
done

echo "GramGrab $version installed."
if [ -n "$previous" ]; then
  echo 'Restart the browser so it starts the new native host.'
  exit 0
fi

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to PATH to run gramgrab." ;;
esac
cat <<EOF

Register the native host once. Updates keep these paths, so it stays registered.
  Chromium browsers: $data_dir/chromium.json
  Firefox:           $data_dir/firefox.json
Link the one for your browser into its NativeMessagingHosts directory as dev.zytact.gramgrab.json.
For Helium on Linux:
  mkdir -p ~/.config/net.imput.helium/NativeMessagingHosts
  ln -sf "$data_dir/chromium.json" ~/.config/net.imput.helium/NativeMessagingHosts/dev.zytact.gramgrab.json
EOF
