# Releasing

Releases are automatic. Merge PRs with conventional commit titles into `main`, and
[release-please](https://github.com/googleapis/release-please) keeps one open release PR that bumps
the root `package.json` version and writes `CHANGELOG.md`. Merging that PR tags `vX.Y.Z`, creates
the GitHub release, and `.github/workflows/release.yml` attaches:

| Asset                   | What it is                                                           |
| ----------------------- | -------------------------------------------------------------------- |
| `gramgrab.crx`          | Chromium extension, signed with the release key                      |
| `gramgrab.xpi`          | Firefox extension, signed by AMO on the unlisted channel             |
| `gramgrab-tools.tar.gz` | CLI and native host, the `artifacts/` directory from `package-tools` |
| `updates.xml`           | Chromium update manifest for this version                            |
| `updates.json`          | Firefox update manifest for this version, with the XPI's SHA-256     |
| `SHA256SUMS`            | Checksums of every asset above                                       |

The bundled Firefox build is minified, so the workflow also uploads the tagged source (without
the vendored `.repos/`) to AMO, as Mozilla requires. README's "Building from Source" section is the
build instructions reviewers follow: `vp install`, then `vp run build:firefox`.

`fix:` bumps the patch version, `feat:` the minor version, and a `!` or `BREAKING CHANGE` footer the
major version. Never edit `CHANGELOG.md` or the version by hand.

## Chromium release key

The CRX signing key pins the Chromium extension ID (`jimjajkoinlnejbiekiaifojpnonfnff`). Its public
half is `CHROMIUM_PUBLIC_KEY` in `apps/extension/scripts/release.mjs` and goes into the manifest as
`key`, so unpacked builds get the same ID. Losing the private key means a new ID and a reinstall for
everyone, so keep a backup.

`vp run package:chromium` reads the key from `CHROMIUM_CRX_KEY_FILE`, defaulting to
`~/.config/gramgrab-release/chromium.pem`, and refuses to sign with any other key.

## One-time repository setup

| Setting                                                                                 | Value                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Secret `CHROMIUM_CRX_KEY`                                                               | Contents of the release key PEM                               |
| Secret `AMO_JWT_ISSUER`                                                                 | JWT issuer from addons.mozilla.org → Developer Hub → API keys |
| Secret `AMO_JWT_SECRET`                                                                 | JWT secret from the same page                                 |
| Settings → Actions → General → Allow GitHub Actions to create and approve pull requests | Enabled, so release-please can open its PR                    |
