#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib/version.sh"
ompd_version__resolve
cd "$ROOT/macos"
TEAM_ID="${OMPD_APPLE_TEAM_ID:?OMPD_APPLE_TEAM_ID is required}"
OUT="${OMPD_MACOS_ARCHIVE_DIR:-$ROOT/build/macos}"
mkdir -p "$OUT"
METHOD="${OMPD_MACOS_EXPORT_METHOD:-app-store-connect}"
BUNDLE_ID="${OMPD_MACOS_BUNDLE_ID:-ai.ompctl.app}"
PROFILE_PATH="${OMPD_MACOS_PROFILE_PATH:-}"
SIGNING_CERTIFICATE="${OMPD_MACOS_SIGNING_CERTIFICATE:-Apple Distribution}"
INSTALLER_SIGNING_CERTIFICATE="${OMPD_MACOS_INSTALLER_SIGNING_CERTIFICATE:-3rd Party Mac Developer Installer}"
SIGNING_STYLE=automatic
PROFILE_NAME=""
SIGNING_ARGS=(CODE_SIGN_STYLE=Automatic)

if [[ "$METHOD" == "app-store-connect" ]]; then
  : "${PROFILE_PATH:?OMPD_MACOS_PROFILE_PATH is required for App Store export}"
  if [[ ! -f "$PROFILE_PATH" ]]; then
    echo "macOS provisioning profile not found: $PROFILE_PATH" >&2
    exit 1
  fi
  PROFILE_PLIST="$OUT/macos-profile.plist"
  security cms -D -i "$PROFILE_PATH" > "$PROFILE_PLIST"
  PROFILE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :Name' "$PROFILE_PLIST")"
  PROFILE_UUID="$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$PROFILE_PLIST")"
  PROFILE_TEAM="$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$PROFILE_PLIST")"
  PROFILE_APP_ID="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.application-identifier' "$PROFILE_PLIST")"
  if [[ "$PROFILE_TEAM" != "$TEAM_ID" || "$PROFILE_APP_ID" != "$TEAM_ID.$BUNDLE_ID" ]]; then
    echo "macOS provisioning profile does not match team and bundle id" >&2
    exit 1
  fi
  PROFILE_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
  mkdir -p "$PROFILE_DIR"
  cp "$PROFILE_PATH" "$PROFILE_DIR/$PROFILE_UUID.provisionprofile"
  SIGNING_STYLE=manual
  SIGNING_ARGS=(
    CODE_SIGN_STYLE=Manual
    "CODE_SIGN_IDENTITY=$SIGNING_CERTIFICATE"
    "PROVISIONING_PROFILE_SPECIFIER=$PROFILE_NAME"
  )
  echo "macos_profile_ready name=$PROFILE_NAME uuid=$PROFILE_UUID"
fi

if [[ ! -d ompd.xcworkspace && ! -d ompd.xcodeproj ]]; then
  echo "macos xcode project missing" >&2
  exit 1
fi

PROJECT_ARGS=()
if [[ -d ompd.xcworkspace ]]; then
  PROJECT_ARGS=(-workspace ompd.xcworkspace -scheme ompd-macOS)
else
  PROJECT_ARGS=(-project ompd.xcodeproj -scheme ompd-macOS)
fi

AUTH_ARGS=()
if [[ -n "${OMPD_ASC_KEY_PATH:-}" && -n "${OMPD_ASC_KEY_ID:-}" && -n "${OMPD_ASC_ISSUER_ID:-}" ]]; then
  AUTH_ARGS+=(
    -allowProvisioningUpdates
    -authenticationKeyPath "$OMPD_ASC_KEY_PATH"
    -authenticationKeyID "$OMPD_ASC_KEY_ID"
    -authenticationKeyIssuerID "$OMPD_ASC_ISSUER_ID"
  )
fi

xcodebuild \
  "${PROJECT_ARGS[@]}" \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  -archivePath "$OUT/ompd-mac.xcarchive" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  "${SIGNING_ARGS[@]}" \
  "${AUTH_ARGS[@]}" \
  CURRENT_PROJECT_VERSION="$OMPD_BUILD_NUMBER" \
  MARKETING_VERSION="$OMPD_VERSION_NAME" \
  archive

EXPORT_PLIST="$OUT/ExportOptions.plist"
cat >"$EXPORT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${METHOD}</string>
  <key>signingStyle</key>
  <string>${SIGNING_STYLE}</string>
  <key>teamID</key>
  <string>${TEAM_ID}</string>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
</dict>
</plist>
PLIST
if [[ "$SIGNING_STYLE" == "manual" ]]; then
  /usr/libexec/PlistBuddy -c 'Add :provisioningProfiles dict' "$EXPORT_PLIST"
  /usr/libexec/PlistBuddy -c "Add :provisioningProfiles:$BUNDLE_ID string $PROFILE_NAME" "$EXPORT_PLIST"
  /usr/libexec/PlistBuddy -c "Add :signingCertificate string $SIGNING_CERTIFICATE" "$EXPORT_PLIST"
  /usr/libexec/PlistBuddy -c "Add :installerSigningCertificate string $INSTALLER_SIGNING_CERTIFICATE" "$EXPORT_PLIST"
fi
rm -rf "$OUT/export"

xcodebuild -exportArchive \
  -archivePath "$OUT/ompd-mac.xcarchive" \
  -exportPath "$OUT/export" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  "${AUTH_ARGS[@]}"
echo "MAC_EXPORT=$OUT/export"
ls -la "$OUT/export"

# App Store export is typically a .pkg; Developer ID may yield .app / .dmg.
PKG_PATH="$(find "$OUT/export" -type f \( -name '*.pkg' -o -name '*.dmg' \) -print | head -1 || true)"
APP_PATH="$(find "$OUT/export" -type d -name '*.app' -print -quit | head -1 || true)"

if [[ -n "$APP_PATH" ]]; then
  codesign --verify --deep --strict --verbose=2 "$APP_PATH"
  codesign -dvv "$APP_PATH" 2>&1 | awk -F= '/TeamIdentifier/{print "mac_team",$2}'
elif [[ -n "$PKG_PATH" ]]; then
  echo "mac_export_package $PKG_PATH"
  # pkgutil validates structure without requiring an unpacked .app
  if [[ "$PKG_PATH" == *.pkg ]]; then
    pkgutil --check-signature "$PKG_PATH"
  fi
  # Also try to verify the app nested inside the archive used for export
  ARCH_APP="$(find "$OUT/ompd-mac.xcarchive/Products" -type d -name '*.app' -print -quit | head -1 || true)"
  if [[ -n "$ARCH_APP" ]]; then
    codesign --verify --deep --strict --verbose=2 "$ARCH_APP"
    codesign -dvv "$ARCH_APP" 2>&1 | awk -F= '/TeamIdentifier/{print "mac_archive_team",$2}'
  fi
else
  echo "No .pkg/.dmg/.app found under $OUT/export" >&2
  ls -laR "$OUT/export" || true
  exit 1
fi
