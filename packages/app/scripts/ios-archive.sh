#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib/version.sh"
ompd_version__resolve
cd "$ROOT/ios"
TEAM_ID="${OMPD_APPLE_TEAM_ID:?OMPD_APPLE_TEAM_ID is required}"
OUT="${OMPD_IOS_ARCHIVE_DIR:-$ROOT/build/ios}"
mkdir -p "$OUT"
BUNDLE_ID="${OMPD_IOS_BUNDLE_ID:-ai.ompctl.app}"
PROFILE_PATH="${OMPD_IOS_PROFILE_PATH:?OMPD_IOS_PROFILE_PATH is required for App Store export}"
SIGNING_CERTIFICATE="${OMPD_IOS_SIGNING_CERTIFICATE:-Apple Distribution}"
PLIST_BUDDY="${OMPD_PLIST_BUDDY:-/usr/libexec/PlistBuddy}"
if [[ ! -f "$PROFILE_PATH" ]]; then
  echo "iOS provisioning profile not found: $PROFILE_PATH" >&2
  exit 1
fi
PROFILE_PLIST="$OUT/ios-profile.plist"
security cms -D -i "$PROFILE_PATH" > "$PROFILE_PLIST"
PROFILE_NAME="$("$PLIST_BUDDY" -c 'Print :Name' "$PROFILE_PLIST")"
PROFILE_UUID="$("$PLIST_BUDDY" -c 'Print :UUID' "$PROFILE_PLIST")"
PROFILE_TEAM="$("$PLIST_BUDDY" -c 'Print :TeamIdentifier:0' "$PROFILE_PLIST")"
PROFILE_APP_ID="$("$PLIST_BUDDY" -c 'Print :Entitlements:application-identifier' "$PROFILE_PLIST")"
PROFILE_PLATFORM="$("$PLIST_BUDDY" -c 'Print :Platform:0' "$PROFILE_PLIST")"
if [[ "$PROFILE_TEAM" != "$TEAM_ID" || "$PROFILE_APP_ID" != "$TEAM_ID.$BUNDLE_ID" || "$PROFILE_PLATFORM" != "iOS" ]]; then
  echo "iOS provisioning profile does not match platform, team, and bundle id" >&2
  exit 1
fi
PROFILE_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$PROFILE_DIR"
cp "$PROFILE_PATH" "$PROFILE_DIR/$PROFILE_UUID.mobileprovision"
echo "ios_profile_ready name=$PROFILE_NAME uuid=$PROFILE_UUID"

if [[ ! -d Pods ]]; then
  if command -v bundle >/dev/null 2>&1 && [[ -f ../Gemfile ]]; then
    (cd .. && bundle install --quiet && bundle exec pod install)
  else
    pod install
  fi
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
  -workspace ompd.xcworkspace \
  -scheme ompd \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$OUT/ompd.xcarchive" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  CODE_SIGN_STYLE=Manual \
  "CODE_SIGN_IDENTITY=$SIGNING_CERTIFICATE" \
  "PROVISIONING_PROFILE_SPECIFIER=$PROFILE_NAME" \
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
  <string>app-store-connect</string>
  <key>destination</key>
  <string>export</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>${TEAM_ID}</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>${BUNDLE_ID}</key>
    <string>${PROFILE_NAME}</string>
  </dict>
  <key>signingCertificate</key>
  <string>${SIGNING_CERTIFICATE}</string>
  <key>uploadSymbols</key>
  <true/>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
</dict>
</plist>
PLIST

rm -rf "$OUT/ipa"

xcodebuild \
  -exportArchive \
  -archivePath "$OUT/ompd.xcarchive" \
  -exportPath "$OUT/ipa" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  "${AUTH_ARGS[@]}"

# Prove the IPA carries a distribution signature before upload.
IPA_FILE="$(ls -1 "$OUT/ipa"/*.ipa | head -1)"
test -f "$IPA_FILE"
TMP_EXTRACT="$OUT/ipa-verify"
rm -rf "$TMP_EXTRACT"
mkdir -p "$TMP_EXTRACT"
unzip -q "$IPA_FILE" -d "$TMP_EXTRACT"
APP_PATH="$(find "$TMP_EXTRACT" -type d -name '*.app' -print -quit | head -1)"
test -n "$APP_PATH"
test -d "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
CODESIGN_TEAM="$(codesign -dvv "$APP_PATH" 2>&1 | awk -F= '/TeamIdentifier/{print $2}' | tr -d '[:space:]')"
echo "ipa_team $CODESIGN_TEAM"
if [[ -n "$TEAM_ID" && "$CODESIGN_TEAM" != "$TEAM_ID" ]]; then
  echo "IPA TeamIdentifier $CODESIGN_TEAM does not match OMPD_APPLE_TEAM_ID $TEAM_ID" >&2
  exit 1
fi
echo "IPA_PATH=$IPA_FILE"

echo "IPA_DIR=$OUT/ipa"
ls -la "$OUT/ipa"
