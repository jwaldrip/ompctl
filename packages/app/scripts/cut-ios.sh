#!/usr/bin/env bash
# Cut a signed iOS release archive and IPA for TestFlight.
#
# Resolves the build number from packages/app/scripts/lib/version.sh,
# builds the release xcarchive, exports the signed IPA using the App Store
# distribution profile, and verifies the resulting bundle before upload.
#
# Required local credentials (not committed to version control):
#   1. Apple Distribution Certificate in macOS Keychain:
#      "Apple Distribution: Jason Waldrip (8H7HVPHS87)"
#   2. App Store Connect API Key:
#      OMPD_ASC_KEY_PATH (default: ~/.private_keys/AuthKey_CKYD83GHF3.p8)
#      OMPD_ASC_KEY_ID (default: CKYD83GHF3)
#      OMPD_ASC_ISSUER_ID (default: content of ~/.private_keys/asc_issuer_id)
#   3. iOS App Store Provisioning Profile:
#      OMPD_IOS_PROVISIONING_PROFILE (default: ~/.private_keys/ompctl_ios_appstore.mobileprovision)
#      UUID: d37caa29-88ad-453d-b98c-c7696603faee

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

source "$ROOT/scripts/lib/version.sh"
ompd_version__resolve

OUT="${OMPD_IOS_BUILD_DIR:-$ROOT/build/ios}"
mkdir -p "$OUT"

TEAM_ID="${OMPD_APPLE_TEAM_ID:-8H7HVPHS87}"
KEY_ID="${OMPD_ASC_KEY_ID:-CKYD83GHF3}"
PROFILE_BUNDLE_ID="${OMPD_IOS_BUNDLE_ID:-ai.ompctl.app}"
SIGNING_CERTIFICATE="${OMPD_IOS_SIGNING_CERTIFICATE:-Apple Distribution}"
PLIST_BUDDY="${OMPD_PLIST_BUDDY:-/usr/libexec/PlistBuddy}"

# 1. Validate ASC Key
KEY_PATH="${OMPD_ASC_KEY_PATH:-}"
if [[ -z "$KEY_PATH" ]]; then
  for candidate in "$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8" "$HOME/.private_keys/AuthKey_${KEY_ID}.p8"; do
    if [[ -f "$candidate" ]]; then
      KEY_PATH="$candidate"
      break
    fi
  done
fi

if [[ -z "$KEY_PATH" || ! -f "$KEY_PATH" ]]; then
  echo "cut-ios: missing ASC API key AuthKey_${KEY_ID}.p8" >&2
  echo "Set OMPD_ASC_KEY_PATH or place key in ~/.private_keys/AuthKey_${KEY_ID}.p8" >&2
  exit 1
fi

# 2. Validate ASC Issuer ID
ISSUER_ID="${OMPD_ASC_ISSUER_ID:-}"
if [[ -z "$ISSUER_ID" && -f "$HOME/.private_keys/asc_issuer_id" ]]; then
  ISSUER_ID="$(cat "$HOME/.private_keys/asc_issuer_id" | tr -d '[:space:]')"
fi

if [[ -z "$ISSUER_ID" ]]; then
  echo "cut-ios: missing ASC issuer ID. Set OMPD_ASC_ISSUER_ID or ~/.private_keys/asc_issuer_id" >&2
  exit 1
fi

# 3. Validate Mobileprovision Profile
PROFILE_SRC="${OMPD_IOS_PROVISIONING_PROFILE:-$HOME/.private_keys/ompctl_ios_appstore.mobileprovision}"
if [[ ! -f "$PROFILE_SRC" ]]; then
  echo "cut-ios: missing mobileprovision profile at $PROFILE_SRC" >&2
  echo "Set OMPD_IOS_PROVISIONING_PROFILE or place in ~/.private_keys/ompctl_ios_appstore.mobileprovision" >&2
  exit 1
fi

PROFILE_PLIST="$OUT/ios-profile.plist"
security cms -D -i "$PROFILE_SRC" > "$PROFILE_PLIST"
PROFILE_NAME="$("$PLIST_BUDDY" -c 'Print :Name' "$PROFILE_PLIST")"
PROFILE_UUID="$("$PLIST_BUDDY" -c 'Print :UUID' "$PROFILE_PLIST")"
PROFILE_TEAM="$("$PLIST_BUDDY" -c 'Print :TeamIdentifier:0' "$PROFILE_PLIST")"
PROFILE_APP_ID="$("$PLIST_BUDDY" -c 'Print :Entitlements:application-identifier' "$PROFILE_PLIST")"
PROFILE_PLATFORM="$("$PLIST_BUDDY" -c 'Print :Platform:0' "$PROFILE_PLIST")"
if [[ "$PROFILE_TEAM" != "$TEAM_ID" || "$PROFILE_APP_ID" != "$TEAM_ID.$PROFILE_BUNDLE_ID" || "$PROFILE_PLATFORM" != "iOS" ]]; then
  echo "cut-ios: provisioning profile does not match platform, team, and bundle id" >&2
  exit 1
fi

PROV_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$PROV_DIR"
cp "$PROFILE_SRC" "$PROV_DIR/$PROFILE_UUID.mobileprovision"
echo "== profile: name=$PROFILE_NAME uuid=$PROFILE_UUID"

echo "== version: build=$OMPD_BUILD_NUMBER marketing=$OMPD_VERSION_NAME"
echo "== source:  $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo 'n/a')"

echo "== pods"
cd "$ROOT/ios"
if [[ ! -d Pods ]]; then
  pod install
fi

echo "== archive"
xcodebuild \
  -workspace ompd.xcworkspace \
  -scheme ompd \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$OUT/ompd.xcarchive" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  PRODUCT_BUNDLE_IDENTIFIER="$PROFILE_BUNDLE_ID" \
  CODE_SIGN_STYLE=Manual \
  "CODE_SIGN_IDENTITY=$SIGNING_CERTIFICATE" \
  "PROVISIONING_PROFILE_SPECIFIER=$PROFILE_NAME" \
  CURRENT_PROJECT_VERSION="$OMPD_BUILD_NUMBER" \
  MARKETING_VERSION="$OMPD_VERSION_NAME" \
  -quiet archive
echo "archive ok"

echo "== export (manual signing)"
cat >"$OUT/ExportOptions-manual.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>manual</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>provisioningProfiles</key><dict><key>$PROFILE_BUNDLE_ID</key><string>$PROFILE_NAME</string></dict>
  <key>signingCertificate</key><string>$SIGNING_CERTIFICATE</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

rm -rf "$OUT/ipa"
xcodebuild -exportArchive \
  -archivePath "$OUT/ompd.xcarchive" \
  -exportPath "$OUT/ipa" \
  -exportOptionsPlist "$OUT/ExportOptions-manual.plist" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$KEY_ID" \
  -authenticationKeyIssuerID "$ISSUER_ID" \
  -quiet
echo "export ok"

echo "== verify ipa"
IPA="$(ls -1 "$OUT"/ipa/*.ipa 2>/dev/null | head -1 || true)"
if [[ -z "$IPA" || ! -f "$IPA" ]]; then
  echo "cut-ios: no IPA found under $OUT/ipa" >&2
  exit 1
fi

rm -rf "$OUT/ipa-verify" && mkdir -p "$OUT/ipa-verify"
unzip -q "$IPA" -d "$OUT/ipa-verify"
APPDIR="$(find "$OUT/ipa-verify" -type d -name '*.app' -print -quit)"

codesign --verify --deep --strict "$APPDIR" && echo "codesign ok"
echo "team:      $(codesign -dvv "$APPDIR" 2>&1 | awk -F= '/TeamIdentifier/{print $2}')"
echo "nonexempt: $(plutil -extract ITSAppUsesNonExemptEncryption raw "$APPDIR/Info.plist" 2>/dev/null || echo 'false')"
echo "build:     $(plutil -extract CFBundleVersion raw "$APPDIR/Info.plist")"
echo "IPA=$IPA"
