#!/usr/bin/env bash
# Union every panel lens's verdict and gate on unanimous approval — the merge gate's
# decision. Fails CLOSED: exits non-zero if any lens rejected, produced a non-APPROVE or
# malformed verdict, is missing, or if a verdict ran for a lens OUTSIDE the gated set
# (matrix/aggregator drift). PANEL_LENSES overrides the lens set when set (tests use
# this); in production it is unset, so the hardcoded default applies. Extracted from the
# workflow so the gate's decision logic is unit-testable.
set -euo pipefail

dir="${1:?usage: aggregate.sh <verdicts-dir>}"
lenses="${PANEL_LENSES-correctness security testing docs resilience}"

if [ -z "${lenses//[[:space:]]/}" ]; then
  echo "::error title=No panel lenses::The lens set is empty — refusing to pass a gate that checked nothing. Failing closed."
  exit 1
fi
# Only bare [a-z0-9-] tokens, space-separated: blocks glob expansion, path traversal, and
# workflow-command injection via a crafted PANEL_LENSES before it is split and used in paths.
case "$lenses" in
  *[!a-z0-9\ -]*)
    echo "::error title=Invalid lens set::PANEL_LENSES may contain only [a-z0-9-] tokens. Failing closed."
    exit 1
    ;;
esac

# Neutralise GHA workflow-command injection in anything echoed from a verdict (which
# a prompt-injected panelist controls): strip CR (a literal \r acts as a line
# terminator to the runner, letting '::cmd' open a line sed's ^ never sees), %-encode
# (kills %0D/%0A escape smuggling), then indent any line-start '::'.
safe() { tr -d '\r' | sed -e 's/%/%25/g' -e 's/^::/ ::/'; }

# Bound every jq parse of untrusted panelist JSON: a pathological-but-under-1MB payload
# must fail this one lens closed, not hold the aggregator to the job envelope. The bound
# is env-overridable so tests can exercise the timeout actually firing.
# (Guarded — dev machines may lack coreutils timeout; CI runners always have it.)
if command -v timeout >/dev/null 2>&1; then jq_bounded() { timeout "${JQ_BOUNDED_TIMEOUT:-10}" jq "$@"; }; else jq_bounded() { jq "$@"; }; fi

ok=1
echo "## Antagonistic panel — verdict by lens"
for lens in $lenses; do
  f="$dir/verdict-$lens/verdict.json"
  if [ ! -f "$f" ]; then
    echo "::error title=Missing verdict::Panelist '$lens' produced no verdict — it did not run to completion. Failing closed."
    ok=0
    continue
  fi
  # A verdict is a small JSON object; anything over 1MB is a model-written path gone wrong
  # (or an injection attempt). The read itself is capped at 1MB+1 — size is decided
  # without ever consuming an unbounded stream.
  if [ "$(head -c 1000001 "$f" | wc -c)" -gt 1000000 ]; then
    echo "::error title=Oversize verdict::Panelist '$lens' produced a verdict over 1MB — refusing to parse. Failing closed."
    ok=0
    continue
  fi
  v="$(jq_bounded -r '.verdict // empty' "$f" 2>/dev/null || echo '')"
  {
    echo ""
    echo "### ${lens} — ${v:-none}"
    jq_bounded -r '.summary // ""' "$f" 2>/dev/null || true
    jq_bounded -r '.findings[]? | "  - " + .' "$f" 2>/dev/null || true
  } | safe
  [ "$v" = "APPROVE" ] || ok=0
done

# Drift guard: a verdict that ran for a lens OUTSIDE the gated set (e.g. a lens added to
# the workflow matrix but not here) must fail closed, not be silently ignored.
for d in "$dir"/verdict-*/; do
  [ -e "$d" ] || continue
  got="$(basename "$d")"
  got="${got#verdict-}"
  case " $lenses " in
    *" $got "*) : ;;
    *)
      # $got is a directory name, not verdict JSON, so it bypasses safe(); reduce it to
      # the lens alphabet before embedding it in a workflow command (a crafted name with
      # a newline could otherwise emit a line-starting `::` command of its own).
      # LC_ALL=C pins tr's a-z range to ASCII bytes — POSIX allows locale collation to
      # widen ranges, and this filter must never widen.
      got="$(printf '%s' "$got" | LC_ALL=C tr -cd 'a-z0-9-')"
      echo "::error title=Unexpected lens::'$got' produced a verdict but is not in the gated set — matrix/aggregator drift. Failing closed."
      ok=0
      ;;
  esac
done

echo ""
if [ "$ok" -ne 1 ]; then
  echo "::error title=Change rejected::At least one lens rejected or failed to produce a verdict. The gate fails CLOSED."
  exit 1
fi
echo "Every lens APPROVED — the gate is green."
