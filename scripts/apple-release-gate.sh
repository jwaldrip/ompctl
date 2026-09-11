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

cancel_wait_seconds="${OMPD_CANCEL_WAIT_SECONDS:-180}"
cancel_poll_seconds="${OMPD_CANCEL_POLL_SECONDS:-2}"
if ! [[ "$cancel_wait_seconds" =~ ^[0-9]+$ && "$cancel_poll_seconds" =~ ^[0-9]+$ ]]; then
  echo "::error::Apple release cancellation intervals must be non-negative integers"
  exit 1
fi

while IFS= read -r run_id; do
  [[ -z "$run_id" ]] && continue
  if ! gh api --method POST "/repos/$GITHUB_REPOSITORY/actions/runs/$run_id/cancel" >/dev/null; then
    if ! status="$(gh api "/repos/$GITHUB_REPOSITORY/actions/runs/$run_id" --jq .status)"; then
      echo "::error::Could not confirm superseded release run $run_id after cancellation failed"
      exit 1
    fi
    if [[ "$status" == "completed" ]]; then
      continue
    fi
    echo "::error::Could not cancel superseded release run $run_id; it remains $status"
    exit 1
  fi
  echo "requested cancellation of superseded release run $run_id"
  deadline=$((SECONDS + cancel_wait_seconds))
  while true; do
    if ! status="$(gh api "/repos/$GITHUB_REPOSITORY/actions/runs/$run_id" --jq .status)"; then
      echo "::error::Could not read superseded release run $run_id after requesting cancellation"
      exit 1
    fi
    if [[ "$status" == "completed" ]]; then
      echo "superseded release run $run_id stopped"
      break
    fi
    if ((SECONDS >= deadline)); then
      echo "::error::Superseded release run $run_id did not stop after cancellation"
      exit 1
    fi
    sleep "$cancel_poll_seconds"
  done
done <<< "$earlier"

if ! head_sha="$(gh api "/repos/$GITHUB_REPOSITORY/commits/main" --jq .sha)"; then
  echo "::error::Could not re-read the current main commit after release cancellation"
  exit 1
fi
if [[ "$GITHUB_SHA" != "$head_sha" ]]; then
  echo "release=false" >> "$GITHUB_OUTPUT"
  echo "release $GITHUB_SHA lost the main tip during cancellation to $head_sha"
  exit 0
fi

echo "release=true" >> "$GITHUB_OUTPUT"
echo "release $GITHUB_SHA is the current main commit"
