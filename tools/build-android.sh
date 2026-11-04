#!/bin/bash
# Deprecated alias for tools/build-apk.sh, kept so existing commands keep working.
#   tools/build-android.sh [--exe <exe>] [--meta <json>] [--debug]
echo "tools/build-android.sh is now tools/build-apk.sh" >&2
exec "$(cd "$(dirname "$0")" && pwd)/build-apk.sh" "$@"
