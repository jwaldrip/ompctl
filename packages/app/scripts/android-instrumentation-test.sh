#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/mono-root.sh
source "$ROOT/scripts/lib/mono-root.sh"
cleanup() {
  bash "$ROOT/scripts/stop-metro.sh" || true
  adb reverse --remove-all >/dev/null 2>&1 || true
}
trap cleanup EXIT

bash "$ROOT/scripts/start-metro.sh"

# Emulator reaches host Metro via adb reverse (10.0.2.2 also works for cleartext,
# but reverse is the reliable path on GHA emulator-runner).
adb wait-for-device
adb reverse tcp:8081 tcp:8081
adb reverse --list || true

cd "$ROOT/android"
chmod +x ./gradlew
# Named explicitly rather than running the whole source set. `DetoxTest` also
# lives in androidTest, and it blocks waiting for a Detox server that only
# exists when `detox test` launched it, so an unfiltered run would hang and then
# fail. Naming the class keeps this job doing exactly what it did before and
# makes it immune to test classes added later.
./gradlew :app:connectedDebugAndroidTest --console=plain \
  -Pandroid.testInstrumentationRunnerArguments.class=ai.ompctl.app.LaunchSmokeTest
