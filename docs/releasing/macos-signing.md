# macOS Developer ID Signing

This release workflow signs and notarizes the Tauri desktop app for macOS
outside the App Store. It uses a Developer ID Application certificate, imports it
into a temporary GitHub Actions keychain, and lets Tauri notarize the generated
macOS bundles with Apple credentials. The same certificate also signs the
standalone server's macOS executables (see [Standalone Server](#standalone-server)).

References:

- Tauri macOS code signing: https://v2.tauri.app/distribute/sign/macos/
- Apple Developer ID: https://developer.apple.com/support/developer-id/

## Required GitHub Secrets

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 contents of the exported `.p12` certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` |
| `KEYCHAIN_PASSWORD` | Random password for the temporary CI keychain |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | Apple app-specific password |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

The existing `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets are still required for Tauri updater
signatures. They are separate from Apple code signing.

## Generate The Certificate Secret

1. On a Mac, open Keychain Access.
2. Create a Certificate Signing Request:
   `Keychain Access > Certificate Assistant > Request a Certificate From a
   Certificate Authority`.
3. In Apple Developer, open Certificates, IDs & Profiles and create a
   `Developer ID Application` certificate. This is the certificate type for
   distribution outside the App Store.
4. Download the `.cer` file and double-click it to install it into the login
   keychain.
5. In Keychain Access, open `login > My Certificates`, expand the Developer ID
   Application certificate, right-click its private key, and export it as a
   `.p12` file. Set a strong export password.
6. From the repo root, convert the `.p12` and generate the CI keychain password:

```bash
scripts/prepare-macos-signing-secrets.sh /path/to/DeveloperIDApplication.p12
```

Then run the `gh secret set ...` commands printed by the script.

## Generate Apple Notarization Secrets

Set the notarization secrets:

```bash
gh secret set APPLE_ID --body "you@example.com"
gh secret set APPLE_PASSWORD --body "xxxx-xxxx-xxxx-xxxx"
gh secret set APPLE_TEAM_ID --body "TEAMID1234"
```

`APPLE_PASSWORD` must be an Apple app-specific password, not the normal Apple ID
password. Create it from the Apple ID account security page.

Find `APPLE_TEAM_ID` in Apple Developer membership details.

## Verify Locally

After installing the certificate locally, this should show a Developer ID
Application identity:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

For a local notarized DMG build:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID1234)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID1234"
pnpm tauri build --bundles dmg
```

Validate the output:

```bash
xcrun stapler validate src-tauri/target/release/bundle/dmg/*.dmg
spctl -a -vvv -t install src-tauri/target/release/bundle/dmg/*.dmg
```

## CI Behavior

On tag releases, the macOS build matrix imports the `.p12` into a temporary
keychain, resolves the `Developer ID Application` signing identity, and passes
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` to
Tauri. Missing secrets fail the macOS job before the build starts.

macOS signing and notarization are a release gate. If the Apple secrets are
missing or notarization fails, the draft release is left unpublished even if the
Linux, Windows, server, and Docker jobs produced artifacts. This avoids
publishing a release with unsigned or unnotarized macOS desktop packages.

The Apple keychain setup only runs for the `*-apple-darwin` matrix entries of the
desktop and standalone server jobs. The Linux and Windows desktop and server
builds and the Docker build do not depend on the Apple certificate, and only the
desktop's macOS entries use the notarization secrets.

## Standalone Server

The standalone server's macOS archives (`codeg-server-darwin-arm64` and
`codeg-server-darwin-x64`) are signed with the same Developer ID but are not
notarized. macOS keeps the privacy permissions a person grants the server, Full
Disk Access among them, against the executable's designated requirement. An
ad-hoc (linker-signed) build's requirement is its own cdhash, so every update
would take the grant back. Signed with the Developer ID under a fixed
identifier, the requirement stays the same from release to release:

```text
identifier "codeg-server" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "TEAMID1234"
```

Once everything is built, the server job's macOS entries import the certificate
into a temporary keychain and sign `codeg-server`, `codeg-mcp` and `codeg-cli`.
Each is signed under its file name as its identifier, with the hardened runtime,
a secure timestamp and no entitlements, then checked against that requirement.
The keychain is deleted before the bundle is archived and the archive is signed
for the updater. These entries need `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD` and `APPLE_TEAM_ID`, and fail
when one is missing.

`codeg-computer-helper` stays ad-hoc signed in the server archive. A helper that
carries a Team ID refuses to start unless codeg's designated requirement was
compiled into it, and the server build pins none.

A server updated from an ad-hoc build to its first Developer ID build needs its
permissions granted once more, since the old grant names the old cdhash. Later
updates keep them.
