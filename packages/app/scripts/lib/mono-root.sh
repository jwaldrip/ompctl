#!/usr/bin/env bash
# Locate the monorepo root, where bun hoists node_modules, and export NODE_PATH.
#
# Source this rather than computing a fixed number of `..` hops. The Android
# scripts previously used "$ROOT/../../.." which was correct when this tree lived
# at oh-my-pi/control-plane/packages/app. After the subtree extraction to
# ompctl/packages/app that is one level too high, so NODE_PATH pointed at a
# directory containing no node_modules at all.
#
# Nothing failed visibly, which is the dangerous part: the Android unit and
# instrumentation jobs pass with a bogus NODE_PATH because Gradle and the React
# Native plugin resolve packages their own way. It only becomes a problem for
# anything that actually consults NODE_PATH, and then it looks like a missing
# dependency rather than a wrong path.
#
# Walking up for a real marker is robust to the tree moving again, and failing
# loudly when there is no marker beats exporting a path that does not exist.
#
# Expects: ROOT set to packages/app. Exports: MONO, NODE_PATH.

if [[ -z "${ROOT:-}" ]]; then
  echo "mono-root.sh: ROOT must be set before sourcing" >&2
  exit 1
fi

mono_root__find() {
  local dir="$1"
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    if [[ -d "$dir/node_modules/react-native" ]]; then
      printf '%s' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

if ! MONO="$(mono_root__find "$ROOT")"; then
  echo "mono-root.sh: could not find node_modules/react-native at or above $ROOT" >&2
  echo "mono-root.sh: run 'bun install' at the repository root first" >&2
  exit 1
fi

export MONO
export NODE_PATH="$MONO/node_modules${NODE_PATH:+:$NODE_PATH}"
