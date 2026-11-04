#!/bin/bash
# Runs the workflow's jobs locally, step by step, exactly as the runner would.
#
# GitHub only runs a workflow when it lands; a wrong Python version, a missing npm script or a
# `node aot/cli.ts` flag that does not exist surfaces as a red run minutes later. This executes the
# same commands in the same order so the failure shows up here first.
#
#   tools/ci-local.sh            # the `checks` job, plus whatever else this machine can do
#   tools/ci-local.sh checks     # one job: checks | apk
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOB="${1:-checks}"
fails=0
step() { # step <name> <command...>
  local name="$1"; shift
  printf '\n=== %s\n' "$name"
  if "$@"; then
    printf 'PASS  %s\n' "$name"
  else
    printf 'FAIL  %s (exit %d)\n' "$name" "$?"
    fails=$((fails + 1))
  fi
}
cd "$ROOT" || exit 1

case "$JOB" in
  checks)
    step "Install dependencies (npm ci)" npm ci
    step "Python deps" python3 -c "import unicorn, capstone; print('unicorn', unicorn.__version__ if hasattr(unicorn,'__version__') else 'ok')" 2>/dev/null \
      || python3 -m pip install --break-system-packages -q unicorn capstone
    step "Encoder tests" node aot/test/enc.test.mjs
    step "Code generator tests" node aot/test/arch.test.mjs
    step "Module loader tests" node aot/test/module.test.mjs
    step "Optimiser tests" node aot/test/opt.test.mjs
    step "DXT -> ETC2" tools/etc2-test.sh
    step "Native syntax check" tools/android-check.sh
    step "Release rules" tools/release-test.sh
    step "Workflow schema" node tools/check-workflows.mjs
    step "Version numbers" bash -c '
      set -e
      out="$(tools/android-version.sh)"; echo "version: $out"
      code="${out%% *}"
      [[ "$code" =~ ^[0-9]+$ ]] || { echo "versionCode is not numeric: $code"; exit 1; }
      [ "$code" -gt 0 ] || { echo "versionCode must be positive"; exit 1; }
      tagged="$(tools/android-version.sh v1.2.3)"
      [ "${tagged%% *}" = "10203" ] || { echo "tag version scheme is wrong: $tagged"; exit 1; }
    '
    if command -v shellcheck >/dev/null; then
      step "Shellcheck" shellcheck -S warning tools/build-apk.sh tools/build-android.sh \
        tools/android-version.sh tools/android-check.sh tools/android-release-notes.sh \
        tools/release-test.sh tools/android-keygen.sh tools/etc2-test.sh \
        tools/build-ffmpeg-android.sh .github/scripts/fetch-ffmpeg-android.sh
    else
      echo; echo "SKIP  Shellcheck (not installed: apt-get install shellcheck)"
    fi
    ;;
  apk)
    step "Version" bash -c 'read -r code name <<<"$(tools/android-version.sh "${GITHUB_REF_NAME:-}")"; echo "building $name ($code)"'
    if [ -x android/gradlew ] || command -v gradle >/dev/null; then
      step "Assemble" bash -c 'cd android && { [ -x ./gradlew ] && ./gradlew --no-daemon assembleRelease || gradle --no-daemon assembleRelease; }'
      step "Inspect the APK" tools/build-apk.sh --no-image
    else
      echo; echo "SKIP  Assemble (no Gradle/JDK on this machine; input validation only)"
      step "build-apk.sh input validation" bash -c 'tools/build-apk.sh --help >/dev/null && bash -n tools/build-apk.sh'
    fi
    ;;
  *)
    echo "unknown job: $JOB (use checks or apk)" >&2
    exit 2
    ;;
esac

echo
if [ "$fails" -eq 0 ]; then
  echo "ok: job '$JOB' passed locally ($fails failures)"
  exit 0
fi
echo "FAILED: job '$JOB' ($fails failing step(s))"
exit 1
