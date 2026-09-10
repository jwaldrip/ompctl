#!/usr/bin/env bash
# Central version resolution for all ompctl app packages.
#
# Provides a single monotonic source of truth for:
#   - OMPD_BUILD_NUMBER (integer build count, e.g. 771)
#   - OMPD_VERSION_CODE (identical to OMPD_BUILD_NUMBER for Android)
#   - OMPD_VERSION_NAME (marketing version, e.g. 0.1.0 or 1.0)
#   - OMPD_WINDOWS_VERSION (four-part MSIX version, e.g. 0.1.771.0)
#
# Resolution precedence:
#   1. Explicit environment variables (OMPD_BUILD_NUMBER or OMPD_VERSION_CODE).
#   2. Full-history Git commit count (git rev-list --count HEAD).
# Resolution fails rather than reuse a guessed build number.
#
# Marketing version precedence:
#   1. Explicit OMPD_VERSION_NAME environment variable.
#   2. packages/app/package.json "version" field.
#
# Windows version mapping:
#   Windows MSIX Identity requires a 4-part quad-integer (Major.Minor.Build.Revision).
#   Each part must be 0-65535.
#   - Major: marketing version major (default 0)
#   - Minor: marketing version minor (default 1)
#   - Build: OMPD_BUILD_NUMBER (e.g. 771, fitting within 16-bit range)
#   - Revision: marketing version patch (default 0)
#   Result: 0.1.771.0

set -euo pipefail

ompd_version__find_app_root() {
  local dir="${1:-$(pwd)}"
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    if [[ -f "$dir/packages/app/package.json" ]]; then
      printf '%s/packages/app' "$dir"
      return 0
    elif [[ -f "$dir/package.json" && -d "$dir/ios" && -d "$dir/android" ]]; then
      printf '%s' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

ompd_version__resolve() {
  # 1. Resolve Build Number
  local build_num="${OMPD_BUILD_NUMBER:-${OMPD_VERSION_CODE:-}}"
  if [[ -z "$build_num" ]]; then
    if ! command -v git >/dev/null 2>&1; then
      echo "Cannot resolve build number: git is unavailable and no explicit build number was provided" >&2
      return 1
    fi
    if ! build_num="$(git rev-list --count HEAD 2>/dev/null)"; then
      echo "Cannot resolve build number from Git history" >&2
      return 1
    fi
  fi

  if [[ ! "$build_num" =~ ^[0-9]+$ || "$build_num" -le 0 ]]; then
    echo "Build number must be a positive integer" >&2
    return 1
  fi

  # 2. Resolve Marketing Version Name
  local ver_name="${OMPD_VERSION_NAME:-${MARKETING_VERSION:-}}"
  if [[ -z "$ver_name" ]]; then
    local app_root=""
    if app_root="$(ompd_version__find_app_root "${BASH_SOURCE[0]:-$(pwd)}")"; then
      if [[ -f "$app_root/package.json" ]]; then
        ver_name="$(grep -m1 '"version":' "$app_root/package.json" | sed -E 's/.*"version":[[:space:]]*"([^"]+)".*/\1/' || true)"
      fi
    fi
  fi

  if [[ -z "$ver_name" ]]; then
    echo "Cannot resolve marketing version from environment or package.json" >&2
    return 1
  fi

  # 3. Resolve Windows 4-part Version (Major.Minor.Build.Revision)
  local major=0
  local minor=1
  local patch=0
  if [[ "$ver_name" =~ ^([0-9]+)\.([0-9]+)\.?([0-9]+)? ]]; then
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    patch="${BASH_REMATCH[3]:-0}"
  fi

  local win_ver="${major}.${minor}.${build_num}.${patch}"

  export OMPD_BUILD_NUMBER="$build_num"
  export OMPD_VERSION_CODE="$build_num"
  export OMPD_VERSION_NAME="$ver_name"
  export OMPD_WINDOWS_VERSION="$win_ver"
}

# If executed directly as a command
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  ompd_version__resolve

  case "${1:-}" in
    --build-number|--code)
      printf '%s\n' "$OMPD_BUILD_NUMBER"
      ;;
    --version-name|--name)
      printf '%s\n' "$OMPD_VERSION_NAME"
      ;;
    --windows|--msix)
      printf '%s\n' "$OMPD_WINDOWS_VERSION"
      ;;
    --env)
      cat <<ENV
OMPD_BUILD_NUMBER=$OMPD_BUILD_NUMBER
OMPD_VERSION_CODE=$OMPD_VERSION_CODE
OMPD_VERSION_NAME=$OMPD_VERSION_NAME
OMPD_WINDOWS_VERSION=$OMPD_WINDOWS_VERSION
ENV
      ;;
    --json)
      printf '{"buildNumber":%d,"versionCode":%d,"versionName":"%s","windowsVersion":"%s"}\n' \
        "$OMPD_BUILD_NUMBER" "$OMPD_VERSION_CODE" "$OMPD_VERSION_NAME" "$OMPD_WINDOWS_VERSION"
      ;;
    *)
      cat <<OUT
build_number:    $OMPD_BUILD_NUMBER
version_code:    $OMPD_VERSION_CODE
version_name:    $OMPD_VERSION_NAME
windows_version: $OMPD_WINDOWS_VERSION
OUT
      ;;
  esac
fi
