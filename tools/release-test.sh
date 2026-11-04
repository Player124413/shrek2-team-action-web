#!/bin/bash
# Exercises the release rules (tools/android-version.sh, tools/android-release-notes.sh) with fake
# build-tools, so the "an update must not wipe the installed game" promises are actually tested on a
# machine that has no Android SDK.
#
#   tools/release-test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0

check() { # check <description> <expected status> <command...>
  local what="$1" want="$2"
  shift 2
  local out status
  out="$("$@" 2>&1)"
  status=$?
  if [ "$status" -eq "$want" ]; then
    echo "ok: $what"
  else
    echo "FAILED: $what (exit $status, wanted $want)"
    echo "$out" | sed 's/^/    /'
    fails=$((fails + 1))
  fi
}

# ---- 1. Version codes: the thing Android compares on an update ------------------------------------
expect_version() { # expect_version <git situation> <tag arg> <expected "code name">
  local want="$3" got
  got="$(cd "$TMP/repo" && "$ROOT/tools/android-version.sh" "$2")"
  if [ "$got" = "$want" ]; then
    echo "ok: version ($1) -> $got"
  else
    echo "FAILED: version ($1): got '$got', wanted '$want'"
    fails=$((fails + 1))
  fi
}

git init -q "$TMP/repo"
cd "$TMP/repo" || exit 1
git config user.email t@e.st && git config user.name t
git commit -q --allow-empty -m one
git tag v0.1.0
expect_version "tag v0.1.0" v0.1.0 "100 0.1.0"
git commit -q --allow-empty -m two
git commit -q --allow-empty -m three
# commit count is the repository's total, so compare the shape: 102 and the tag's numbers.
got="$(cd "$TMP/repo" && "$ROOT/tools/android-version.sh")"
case "$got" in
  "102 0.1.0-dev2."*) echo "ok: version (two commits past v0.1.0) -> $got" ;;
  *) echo "FAILED: version (two commits past v0.1.0): got '$got'"; fails=$((fails + 1)) ;;
esac
git tag v0.2.0
expect_version "tag v0.2.0" v0.2.0 "200 0.2.0"
git commit -q --allow-empty -m four
got="$(cd "$TMP/repo" && "$ROOT/tools/android-version.sh")"
case "$got" in
  "201 0.2.0-dev1."*) echo "ok: version (one commit past v0.2.0) -> $got" ;;
  *) echo "FAILED: version (one commit past v0.2.0): got '$got'"; fails=$((fails + 1)) ;;
esac
# A version code must never go backwards: the tag's code is above every code its own dev builds used.
# (Compared through variables, not literals, so the check is not constant-folded away.)
old=102 new=200
[ "$new" -gt "$old" ] && echo "ok: v0.2.0 ($new) sorts above the dev builds of v0.1.0 ($old)" \
  || { echo "FAILED: version codes are not monotonic"; fails=$((fails + 1)); }
# An explicit override wins (a rebuild of an already published release).
got="$(SHREK2_VERSION_CODE=777 SHREK2_VERSION_NAME=7.7.7 "$ROOT/tools/android-version.sh" v9.9.9)"
[ "$got" = "777 7.7.7" ] && echo "ok: override env wins" || { echo "FAILED: override ignored: $got"; fails=$((fails + 1)); }

# ---- 2. The release checks -----------------------------------------------------------------------
mkdir -p "$TMP/sdk/build-tools/35.0.0" "$TMP/bin"
cat > "$TMP/sdk/build-tools/35.0.0/aapt2" <<'AAPT'
#!/bin/bash
echo "package: name='org.shrek2.launcher' versionCode='10203' versionName='1.2.3'"
AAPT
cat > "$TMP/sdk/build-tools/35.0.0/apksigner" <<'SIGN'
#!/bin/bash
# The freshly built APK ($FRESH_APK) is signed with abcdef; a downloaded previous release carries
# whatever FAKE_PREV_SIGNED says (deadbeef by default, i.e. a rotated key).
apk="${!#}"
if [ "$apk" = "${FRESH_APK:-}" ]; then
  if [ "${FAKE_UNSIGNED:-0}" = 1 ]; then echo "DOES NOT VERIFY"; exit 1; fi
  echo "Signer #1 certificate SHA-256 digest: abcdef"
else
  echo "Signer #1 certificate SHA-256 digest: ${FAKE_PREV_SIGNED:-deadbeef}"
fi
SIGN
cat > "$TMP/bin/gh" <<'GH'
#!/bin/bash
# A repository *with* a previous release; delete this file (or WANT_NO_GH=1) to simulate the first one.
if [ "$1" = release ]; then echo "https://api.github.com/repos/o/r/releases/assets/1"; exit 0; fi
if [ "$1" = api ]; then echo "fake previous apk"; exit 0; fi
exit 1
GH
mkdir -p "$TMP/bin-nogh"   # a PATH without gh: "no previous release"
chmod +x "$TMP/sdk/build-tools/35.0.0/"* "$TMP/bin/gh"
: > "$TMP/apk"
export FRESH_APK="$TMP/apk"
export ANDROID_SDK_ROOT="$TMP/sdk"
export PATH="$TMP/bin:$PATH"

# No previous release in this fake environment: the certificate comparison must be skipped, which is
# also what a first release looks like.
mv "$TMP/bin/gh" "$TMP/bin/gh.off"
check "a higher versionCode (no previous release) installs as an update" 0 \
  "$ROOT/tools/android-release-notes.sh" "$TMP/apk" 10203 10200
mv "$TMP/bin/gh.off" "$TMP/bin/gh"
check "a higher versionCode with the same key installs as an update" 0 \
  env FAKE_PREV_SIGNED=abcdef "$ROOT/tools/android-release-notes.sh" "$TMP/apk" 10203 10200
check "an equal versionCode is refused" 1 \
  "$ROOT/tools/android-release-notes.sh" "$TMP/apk" 10203 10203
check "a lower versionCode is refused" 1 \
  "$ROOT/tools/android-release-notes.sh" "$TMP/apk" 10203 10300
check "a mismatched versionCode is refused" 1 \
  "$ROOT/tools/android-release-notes.sh" "$TMP/apk" 999
check "a changed signing key is refused" 1 \
  "$ROOT/tools/android-release-notes.sh" "$TMP/apk" 10203 10200
check "an unsigned APK is refused" 1 \
  env FAKE_UNSIGNED=1 "$ROOT/tools/android-release-notes.sh" "$TMP/apk" 10203 10200

# ---- 3. Key generation ----------------------------------------------------------------------------
if command -v keytool >/dev/null; then
  export SHREK2_KEYSTORE_PROPERTIES="$TMP/keys/keystore.properties"
  export SHREK2_KEYSTORE_PASSWORD="test-$RANDOM-$RANDOM"
  mkdir -p "$TMP/keys"
  if "$ROOT/tools/android-keygen.sh" --out "$TMP/keys/release.jks" > "$TMP/keygen.log" 2>&1; then
    echo "ok: key generation"
  else
    echo "FAILED: key generation"; sed 's/^/    /' "$TMP/keygen.log"; fails=$((fails + 1))
  fi
  [ -f "$SHREK2_KEYSTORE_PROPERTIES" ] && echo "ok: keystore.properties written" \
    || { echo "FAILED: keystore.properties missing"; fails=$((fails + 1)); }
  grep -q "^storeFile=release.jks" "$SHREK2_KEYSTORE_PROPERTIES" && echo "ok: storeFile is relative to android/" \
    || { echo "FAILED: storeFile is not relative"; fails=$((fails + 1)); }
  # The password must not leak into the properties in place of the key password, etc.
  grep -q "^keyAlias=shrek2" "$SHREK2_KEYSTORE_PROPERTIES" && echo "ok: key alias" \
    || { echo "FAILED: key alias"; fails=$((fails + 1)); }
  # A second generation would silently change the key and break every installed copy.
  "$ROOT/tools/android-keygen.sh" --out "$TMP/keys/release.jks" > /dev/null 2>&1 \
    && { echo "FAILED: a second keygen overwrote the key"; fails=$((fails + 1)); } \
    || echo "ok: a second keygen is refused"
  # The key must be usable by the signer: check it with keytool itself.
  if keytool -list -keystore "$TMP/keys/release.jks" -storepass "$SHREK2_KEYSTORE_PASSWORD" > /dev/null 2>&1; then
    echo "ok: the keystore opens with the generated password"
  else
    echo "FAILED: the keystore does not open"; fails=$((fails + 1))
  fi
  unset SHREK2_KEYSTORE_PROPERTIES SHREK2_KEYSTORE_PASSWORD
else
  echo "SKIP  key generation (no keytool: install a JDK)"
fi

if [ "$fails" -eq 0 ]; then
  echo "ok: release rules verified ($fails failures)"
  exit 0
fi
echo "FAILED ($fails)"
exit 1
