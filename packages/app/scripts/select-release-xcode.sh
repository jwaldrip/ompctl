#!/usr/bin/env bash
set -euo pipefail

MIN_MAJOR="${OMPD_MIN_XCODE_MAJOR:-26}"
APPLICATIONS_ROOT="${OMPD_XCODE_APPLICATIONS_ROOT:-/Applications}"
SELECTED=""
VERSION=""
BEST_KEY=""

for candidate in "$APPLICATIONS_ROOT/Xcode.app" "$APPLICATIONS_ROOT"/Xcode_26*.app; do
  if [[ ! -d "$candidate/Contents/Developer" ]]; then
    continue
  fi
  candidate_output="$("$candidate/Contents/Developer/usr/bin/xcodebuild" -version)"
  candidate_version="$(awk '$1 == "Xcode" { print $2 }' <<< "$candidate_output")"
  if [[ ! "$candidate_version" =~ ^([0-9]+)(\.([0-9]+))?(\.([0-9]+))? ]]; then
    continue
  fi
  candidate_major="${BASH_REMATCH[1]}"
  candidate_minor="${BASH_REMATCH[3]:-0}"
  candidate_patch="${BASH_REMATCH[5]:-0}"
  if [[ "$candidate_major" -lt "$MIN_MAJOR" ]]; then
    continue
  fi
  printf -v candidate_key '%08d%08d%08d' "$candidate_major" "$candidate_minor" "$candidate_patch"
  if [[ -z "$BEST_KEY" || "$candidate_key" > "$BEST_KEY" ]]; then
    SELECTED="$candidate/Contents/Developer"
    VERSION="$candidate_version"
    BEST_KEY="$candidate_key"
  fi
done

if [[ -z "$SELECTED" ]]; then
  echo "No Xcode $MIN_MAJOR+ installation is available" >&2
  exit 1
fi

if [[ "$(xcode-select -p)" != "$SELECTED" ]]; then
  sudo xcode-select -s "$SELECTED"
fi

if [[ "${OMPD_REQUIRE_IOS_SDK:-0}" == "1" ]]; then
  SDK_VERSION="$(xcrun --sdk iphoneos --show-sdk-version)"
  SDK_MAJOR="${SDK_VERSION%%.*}"
  if [[ ! "$SDK_MAJOR" =~ ^[0-9]+$ || "$SDK_MAJOR" -lt "$MIN_MAJOR" ]]; then
    echo "Selected Xcode $VERSION has iOS SDK $SDK_VERSION; iOS SDK $MIN_MAJOR+ is required" >&2
    exit 1
  fi
  echo "release_xcode_ready version=$VERSION ios_sdk=$SDK_VERSION"
else
  echo "release_xcode_ready version=$VERSION"
fi
