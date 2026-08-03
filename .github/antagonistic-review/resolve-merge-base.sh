#!/usr/bin/env bash
# Resolve the PR's true divergence point — the merge base of the LIVE base ref and the
# PR head — so the panel reviews exactly the change a merge would introduce. The frozen
# event sha is only a fallback: a base frozen at PR creation makes the panel judge
# content that has since landed on the base branch (the wrong-diff failure this script
# exists to prevent; it hit #14/#15's reviews here and context#26/#28's). Runs from the
# BASE checkout, so a PR cannot alter its own gate.
#
# Also the vacuous-pass guard (formerly diff-guard.sh): merge-base == HEAD means there
# is nothing of the PR's own to review — a manual workflow_dispatch run, missing PR
# context, or a head already contained in the base branch. A panelist shown that empty
# diff would trivially APPROVE — a vacuous pass on a REQUIRED check. Fails CLOSED. A PR
# that merged main in but has its own commits has a distinct merge-base and passes.
#
# Env in: BASE_REF (live base branch), BASE_SHA (frozen event sha, fallback only),
# HEAD_SHA. GITHUB_ENV (the file MERGE_BASE is exported into) is the standard var the
# GHA runner injects — the workflow step relies on that; a non-GHA caller (e.g. the test
# harness) must point it at a writable file itself. Inputs are validated before use
# rather than trusting the caller. Fails closed (non-zero) on any invalid input, when no
# merge base exists, or when the diff would be empty.
set -euo pipefail

: "${BASE_REF:?}" "${BASE_SHA:?}" "${HEAD_SHA:?}" "${GITHUB_ENV:?}"

# Only bare commit shas (abbreviated or full lowercase hex) — validated before they are
# echoed or handed to git.
for sha in "$BASE_SHA" "$HEAD_SHA"; do
  case "$sha" in *[!0-9a-f]*) bad=1 ;; *) bad=0 ;; esac
  if [ "$bad" -eq 1 ] || [ "${#sha}" -lt 7 ] || [ "${#sha}" -gt 40 ]; then
    echo "::error title=Invalid sha::BASE_SHA and HEAD_SHA must each be a bare lowercase hex commit sha (7-40 chars). Failing closed."
    exit 1
  fi
done
# Branch-name shape only — no option-injection (leading '-') and none of git's
# forbidden characters. GitHub enforces this upstream; the guard is defence-in-depth.
case "$BASE_REF" in
  -* | *[!A-Za-z0-9._/-]*)
    echo "::error title=Invalid base ref::BASE_REF must be a plain branch name ([A-Za-z0-9._/-], no leading '-'). Failing closed."
    exit 1
    ;;
esac

# CI runners always have coreutils timeout; dev machines running the tests may not.
if command -v timeout >/dev/null 2>&1; then bounded() { timeout "$@"; }; else bounded() { shift; "$@"; }; fi

# Local git ops (merge-base, rev-parse) are near-instant; bound them anyway, but small
# enough that their sum with the 60s network fetch (60 + 10 + 10 + 10 = 90s) stays under
# the workflow step's 2-minute envelope, so each per-call bound actually binds before the
# step timeout does. Env-overridable so a test can shrink it and drive a slow-git shim.
GIT_OP_TIMEOUT="${GIT_OP_TIMEOUT:-10}"

# The fetch must not fail the script (set -e): a deleted/renamed base ref is exactly
# the case the frozen-sha fallback below exists for.
bounded 60 git fetch --no-tags origin "$BASE_REF" \
  || echo "base ref '$BASE_REF' not fetchable — falling back to the frozen event sha"
mb="$(bounded "$GIT_OP_TIMEOUT" git merge-base "origin/$BASE_REF" "$HEAD_SHA" 2>/dev/null \
  || bounded "$GIT_OP_TIMEOUT" git merge-base "$BASE_SHA" "$HEAD_SHA" 2>/dev/null || true)"
if [ -z "$mb" ]; then
  echo "::error title=No merge base::Neither the live base ref nor the frozen event sha yields a merge base with HEAD — the diff range cannot be established. Failing closed."
  exit 1
fi
# git merge-base emits a FULL 40-char sha; HEAD_SHA may be abbreviated (validation admits
# 7-40 chars). Canonicalise the head to a full sha before the vacuous-pass comparison, or
# an abbreviated head would never compare equal and the guard would fail OPEN. A
# successful merge-base above already resolved HEAD_SHA, so this cannot fail in the normal
# flow — but fail CLOSED rather than fall back to the raw input, which would re-open the
# very gap this canonicalisation closes.
head_full="$(bounded "$GIT_OP_TIMEOUT" git rev-parse --verify --quiet "${HEAD_SHA}^{commit}" || true)"
if [ -z "$head_full" ]; then
  echo "::error title=Unresolvable head::HEAD_SHA did not resolve to a commit even though a merge base was found — refusing to compare. Failing closed."
  exit 1
fi
if [ "$mb" = "$head_full" ]; then
  echo "::error title=No reviewable diff::The merge base and HEAD are the same commit — there is no pull-request diff of the PR's own to review. Refusing a vacuous pass on a REQUIRED check. Failing closed."
  exit 1
fi
echo "MERGE_BASE=$mb" >>"$GITHUB_ENV"
echo "merge base: $mb (divergence point of live '$BASE_REF' and head)"
