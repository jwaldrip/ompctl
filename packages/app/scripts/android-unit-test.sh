#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/mono-root.sh
source "$ROOT/scripts/lib/mono-root.sh"
cd "$ROOT/android"
chmod +x ./gradlew
./gradlew :app:testDebugUnitTest --console=plain
