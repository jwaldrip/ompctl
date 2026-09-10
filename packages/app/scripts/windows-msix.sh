#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib/version.sh"
ompd_version__resolve

MANIFEST_FILES=(
  "$ROOT/windows/ompd.Package/Package.appxmanifest"
  "$ROOT/windows/ompd/Package.appxmanifest"
)

# Restore $(PackageVersion) placeholder on exit so the checkout remains clean
restore_manifests() {
  for mf in "${MANIFEST_FILES[@]}"; do
    if [[ -f "$mf" ]]; then
      sed -i.bak -E 's/Version="[^"]*"/Version="\$(PackageVersion)"/' "$mf"
      rm -f "${mf}.bak"
    fi
  done
}
trap restore_manifests EXIT

# Inject resolved 4-part quad version for MSBuild / MakeAppx schema compliance
for mf in "${MANIFEST_FILES[@]}"; do
  if [[ -f "$mf" ]]; then
    sed -i.bak -E "s/Version=\"[^\"]*\"/Version=\"$OMPD_WINDOWS_VERSION\"/" "$mf"
    rm -f "${mf}.bak"
  fi
done
cd "$ROOT"
CONFIG="${OMPD_WINDOWS_CONFIG:-Release}"
PLATFORM="${OMPD_WINDOWS_PLATFORM:-x64}"

if command -v msbuild.exe >/dev/null 2>&1; then
  MSBUILD=(msbuild.exe)
elif [[ -n "${MSBUILD_PATH:-}" ]]; then
  MSBUILD=("$MSBUILD_PATH")
else
  echo "MSBuild not found; set MSBUILD_PATH" >&2
  exit 1
fi

"${MSBUILD[@]}" windows/ompd.sln \
  -p:Configuration="$CONFIG" \
  -p:Platform="$PLATFORM" \
  -p:AppxBundle=Always \
  -p:AppxBundlePlatforms="$PLATFORM" \
  -p:AppxPackageSigningEnabled=false \
  -p:PackageVersion="$OMPD_WINDOWS_VERSION" \
  -t:ompd_Package

echo "Look for Appx/MSIX under windows/ompd.Package/AppPackages"
find windows -name '*.msix' -o -name '*.appx' -o -name '*.msixbundle' 2>/dev/null | head
