#!/bin/bash
# Creates the release signing key -- once, ever.
#
# The key is what makes an APK an *update* instead of a different app: Android only replaces an
# installed package whose signature matches, and refuses a lower versionCode. Lose or rotate the key and
# every player has to uninstall (losing their install and saves) before they can install the new build.
#
#   tools/android-keygen.sh [--out android/release.jks]
#
# Then either keep the generated android/keystore.properties (git-ignored, for local builds) or copy the
# values into the repository's Actions secrets (see the printed instructions / android/README.md).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/android/release.jks"
ALIAS="${SHREK2_KEY_ALIAS:-shrek2}"
CN="${SHREK2_KEY_CN:-Shrek 2 Team Action}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v keytool >/dev/null || { echo "keytool (a JDK) is required" >&2; exit 1; }
if [ -f "$OUT" ]; then
  echo "$OUT already exists. A second key would break every installed copy; refusing to overwrite." >&2
  echo "If it must be replaced on purpose: delete it, and expect players to reinstall." >&2
  exit 1
fi

# 10k days: the key has to outlive every release that players might update from.
PASS="${SHREK2_KEYSTORE_PASSWORD:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)}"
mkdir -p "$(dirname "$OUT")"
keytool -genkeypair -v \
  -keystore "$OUT" -storetype PKCS12 \
  -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" \
  -dname "CN=$CN, O=Shrek 2 Team Action, C=RU"

cat > "$ROOT/android/keystore.properties" <<PROPS
storeFile=release.jks
storePassword=$PASS
keyAlias=$ALIAS
keyPassword=$PASS
PROPS
chmod 600 "$ROOT/android/keystore.properties" "$OUT"

echo
echo "Created $OUT and android/keystore.properties (both git-ignored)."
echo "For GitHub Actions, add these repository secrets:"
echo "  SHREK2_KEYSTORE_BASE64    = $(base64 -w0 "$OUT" | head -c 40)...   (base64 of the .jks)"
echo "  SHREK2_KEYSTORE_PASSWORD  = $PASS"
echo "  SHREK2_KEY_ALIAS          = $ALIAS"
echo "  SHREK2_KEY_PASSWORD       = $PASS"
echo
echo "Back the keystore up somewhere safe: it cannot be regenerated."
