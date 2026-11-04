#!/bin/bash
# Prints the versionCode and versionName for a build, from the git history.
#
# The rule that matters for updates: **versionCode must strictly increase** with every released APK.
# Android refuses to install an APK with a versionCode lower than or equal to the installed one, so a
# constant versionCode silently turns every "update" into "app not installed".
#
#   tools/android-version.sh                -> "CODE NAME" for the current commit
#   tools/android-version.sh v1.2.0         -> "CODE NAME" for a tag (CI passes GITHUB_REF_NAME)
#   SHREK2_VERSION_CODE / SHREK2_VERSION_NAME override the result, for a build that must reuse an
#   already-published version (a rebuild of the same release) or for CI's manual dispatch.
#
# Code = 10000*major + 100*minor + patch for tags (v1.2.3 -> 10203). Untagged commits use the same
# scheme offset from the last tag: 0.0.N with N = total commit count, so every CI run is installable
# over the previous one. The counters are capped so the value always grows and always fits in an int.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -n "${SHREK2_VERSION_CODE:-}" ] && [ -n "${SHREK2_VERSION_NAME:-}" ]; then
  echo "$SHREK2_VERSION_CODE $SHREK2_VERSION_NAME"
  exit 0
fi

tag="${1:-}"
if [ -z "$tag" ]; then
  tag="$(git describe --tags --match 'v*' --abbrev=1 2>/dev/null || true)"
fi

if [[ "$tag" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"; patch="${BASH_REMATCH[3]}"
  code=$((10000 * major + 100 * minor + patch))
  echo "$code $major.$minor.$patch"
  exit 0
fi

# Untagged: 0.0.N with N = commits since the first release tag (or since the start of history).
if [[ "$tag" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)-([0-9]+)-g[0-9a-f]+$ ]]; then
  major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"; patch="${BASH_REMATCH[3]}"; ahead="${BASH_REMATCH[4]}"
  commits="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
  # Past the last release: keep the release's numbers and add the distance, saturating at 99 so a
  # long series of dev builds cannot run into the next minor version.
  extra=$((ahead > 99 ? 99 : ahead))
  code=$((10000 * major + 100 * minor + patch + extra))
  echo "$code ${major}.${minor}.${patch}-dev${ahead}.${commits}"
  exit 0
fi

commits="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
sha="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
# Untagged history: 0.0.<commits> stays monotonic; the code is the commit count itself, capped to the
# range Android accepts (it must fit in a signed 32-bit int, and stay well below the tag scheme).
code=$((commits > 2000000000 ? 2000000000 : commits))
echo "$code 0.0.$commits-dev.$sha"
