#!/bin/bash
# Runs during the release job: verifies the built APK is what the update path needs.
#
#   tools/android-release-notes.sh <apk> <expected versionCode> <previous versionCode or empty>
#
# Fails if the APK would not install as an update over the previously published one:
#   * a different package name (the player would end up with two apps);
#   * versionCode not strictly greater (Android: INSTALL_FAILED_VERSION_DOWNGRADE);
#   * a different signing certificate (Android: INSTALL_FAILED_UPDATE_INCOMPATIBLE).
# The previous release's certificate is read from the APK in the latest GitHub release, when there is one.
set -euo pipefail
APK="$1"
CODE="$2"
PREV="${3:-}"

fail() { echo "release check failed: $*" >&2; exit 1; }

BUILD_TOOLS="$(ls -d "${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$BUILD_TOOLS" ] || fail "no Android build-tools found"

PKG="$("$BUILD_TOOLS/aapt2" dump badging "$APK" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
GOT_CODE="$("$BUILD_TOOLS/aapt2" dump badging "$APK" | sed -n "s/^package:.*versionCode='\([0-9]*\)'.*/\1/p")"
echo "package=$PKG versionCode=$GOT_CODE expected=$CODE"
[ "$PKG" = "org.shrek2.launcher" ] || fail "package is $PKG, expected org.shrek2.launcher"
[ "$GOT_CODE" = "$CODE" ] || fail "versionCode is $GOT_CODE, expected $CODE"
if [ -n "$PREV" ] && [ "$CODE" -le "$PREV" ]; then
  fail "versionCode $CODE is not greater than the published $PREV (the update would be rejected)"
fi

"$BUILD_TOOLS/apksigner" verify --print-certs "$APK" | tee /tmp/certs.txt >/dev/null
grep -q "Signer #1 certificate SHA-256 digest" /tmp/certs.txt || fail "the APK is not signed"
CERT="$(sed -n 's/^Signer #1 certificate SHA-256 digest: //p' /tmp/certs.txt | head -1)"
echo "signer SHA-256: $CERT"

# Compare with the certificate of the last published release, if one exists.
PREV_APK_URL="$(gh release view --json assets --jq '.assets[] | select(.name | endswith(".apk")) | .url' 2>/dev/null | head -1 || true)"
if [ -n "$PREV_APK_URL" ]; then
  echo "comparing with the previous release: $PREV_APK_URL"
  PREV_APK="$(mktemp)"
  trap 'rm -f "$PREV_APK"' EXIT
  gh api "$PREV_APK_URL" -H "Accept: application/vnd.github.raw" > "$PREV_APK"
  "$BUILD_TOOLS/apksigner" verify --print-certs "$PREV_APK" > /tmp/prev-certs.txt
  PREV_CERT="$(sed -n 's/^Signer #1 certificate SHA-256 digest: //p' /tmp/prev-certs.txt | head -1)"
  if [ -n "$PREV_CERT" ] && [ "$PREV_CERT" != "$CERT" ]; then
    fail "signing key changed: $PREV_CERT -> $CERT. An update signed with a new key cannot be installed; the player would have to uninstall and lose the install and saves."
  fi
  echo "signing key matches the published release"
else
  echo "no previous release APK found; skipped the certificate comparison"
fi

echo "ok: this APK installs as an update"
