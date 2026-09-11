#!/usr/bin/env bash
set -euo pipefail

mode="${1:?mode is required}"
label="${2:-release}"
case "$mode" in
  select | current) ;;
  *)
    echo "::error::Unknown Apple release gate mode: $mode"
    exit 1
    ;;
esac
if [[ "$GITHUB_EVENT_NAME" != "push" ]]; then
  echo "release=true" >> "$GITHUB_OUTPUT"
  echo "explicit release selected"
  exit 0
fi

if ! head_sha="$(gh api "/repos/$GITHUB_REPOSITORY/commits/main" --jq .sha)"; then
  echo "::error::Could not read the current main commit before $label"
  exit 1
fi

if [[ "$GITHUB_SHA" != "$head_sha" ]]; then
  echo "release=false" >> "$GITHUB_OUTPUT"
  echo "$label skipped; $GITHUB_SHA is superseded by $head_sha"
  exit 0
fi

if [[ "$mode" == "current" ]]; then
  echo "release=true" >> "$GITHUB_OUTPUT"
  exit 0
fi


endpoint="/repos/$GITHUB_REPOSITORY/actions/workflows/app-store-distribute.yml/runs?branch=main&event=push&per_page=100"
if ! earlier="$(gh api --paginate "$endpoint" --jq ".workflow_runs[] | select(.id < $GITHUB_RUN_ID and .status != \"completed\") | .id")"; then
  echo "::error::Could not read superseded release runs"
  exit 1
fi

while IFS= read -r run_id; do
  [[ -z "$run_id" ]] && continue
  if gh api --method POST "/repos/$GITHUB_REPOSITORY/actions/runs/$run_id/cancel" >/dev/null; then
    echo "cancelled superseded release run $run_id"
    continue
  fi
  if ! status="$(gh api "/repos/$GITHUB_REPOSITORY/actions/runs/$run_id" --jq .status)"; then
    echo "::error::Could not confirm superseded release run $run_id after cancellation failed"
    exit 1
  fi
  if [[ "$status" != "completed" ]]; then
    echo "::error::Superseded release run $run_id remains $status"
    exit 1
  fi
done <<< "$earlier"

echo "release=true" >> "$GITHUB_OUTPUT"
echo "release $GITHUB_SHA is the current main commit"
