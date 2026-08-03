import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Shape regression tests for the verdict-surface step of the antagonistic-review
// workflow. Its behaviour lives inline in the YAML (not an extractable script like
// resolve-merge-base.sh / aggregate.sh), so these pin the text shape that must hold —
// zero-dependency, same approach as guardrails' antagonistic-review-gate tests.
// Regexes match whitespace-collapsed text so the YAML's line-wrapping never matters.

const yml = readFileSync(
  fileURLToPath(new URL('../.github/workflows/antagonistic-review.yml', import.meta.url)),
  'utf8'
);
const flat = yml.replace(/\s+/g, ' ');

describe('antagonistic-review.yml — the lens-verdict surface step', () => {
  it('exists, always runs, and is budgeted', () => {
    // if: always() is load-bearing: the review action may exit non-zero on a REJECT,
    // and the skip-on-failure default would suppress the step in exactly the case it
    // exists to show.
    expect(flat).toMatch(
      /name: Surface this lens's verdict as the job conclusion if: always\(\) timeout-minutes: 2/
    );
  });

  it('extracts the verdict via jq with a fail-closed fallback (empty, never APPROVE)', () => {
    // On jq failure `v` becomes EMPTY (≠ APPROVE → reject). "Fixing" it to
    // `|| echo 'APPROVE'` would turn a parse failure into a silent approve.
    expect(flat).toMatch(
      /v="\$\(timeout 10 jq -r '\.verdict \/\/ empty' "\$f" 2>\/dev\/null \|\| echo ''\)"/
    );
  });

  it('fails the job legibly when the panelist wrote no verdict file', () => {
    expect(flat).toMatch(/if \[ ! -f "\$f" \]; then[^]{0,250}produced no verdict[^]{0,250}exit 1/);
  });

  it('bounds the summary jq parse too (not just the verdict parse)', () => {
    // A pathological .summary payload must not hang the step; the summary parse carries
    // the same timeout 10 as the verdict parse. A suffix-only pin (from `head -1`) would
    // pass even if this timeout were reverted, so assert the bound explicitly.
    expect(flat).toMatch(/summary="\$\(timeout 10 jq -r '\.summary \/\/ ""'/);
  });

  it('sanitises the summary: strip CR, %25-encode, then neutralise a line-starting ::', () => {
    // Order is load-bearing and mirrors aggregate.sh's safe(): a literal \r is a runner
    // line terminator (so '\r::set-env' would open a command the ^:: sed never sees) —
    // strip it FIRST; then %-encode before embedding (a %0A/%0D escape would decode
    // inside the `::` value into a newline + fresh command); then neutralise line-start
    // ::. First line only, capped at 300 chars.
    expect(flat).toMatch(
      /head -1 \| cut -c1-300 \| tr -d '\\r' \| sed -e 's\/%\/%25\/g' -e 's\/\^::\/ ::\/'/
    );
  });

  it('surfaces the sanitised summary in the reject ::error', () => {
    expect(flat).toMatch(/rejected::\$\{summary\}/);
  });

  it('keeps the APPROVE echo as the terminal statement (after the last exit 1)', () => {
    // An accidental exit after the APPROVE echo would start blocking every merge.
    const stepAt = yml.indexOf("name: Surface this lens's verdict as the job conclusion");
    expect(stepAt).toBeGreaterThanOrEqual(0);
    const stepBody = yml.slice(stepAt, yml.indexOf('antagonistic-review:', stepAt));
    const approveAt = stepBody.indexOf('echo "${{ matrix.lens }} — APPROVE"');
    expect(approveAt).toBeGreaterThanOrEqual(0);
    expect(approveAt).toBeGreaterThan(stepBody.lastIndexOf('exit 1'));
  });

  it('guards the review job to same-repo heads (fork PRs never reach the panel)', () => {
    // The load-bearing fork control: panelists + org secrets only run for a head in
    // this repo. Dropping this if: would expose the secrets to fork-authored diffs.
    expect(flat).toMatch(
      /review: name: review[^]{0,400}if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository/
    );
  });
});

// The PR-head extract. Same rationale as the block above — the behaviour is inline
// YAML shell, so its shape is what there is to pin. Each case below is written to
// FAIL if the specific protection it names is deleted, because every one of them is
// silent when absent: an unstripped symlink still reviews fine, a missing pipefail
// still exits 0, a lost HEAD_ROOT export just sends the lens back to reading base.
// Nothing at runtime would go red — only these would.
describe('antagonistic-review.yml — the PR-head extract the lenses read', () => {
  const stepAt = yml.indexOf('name: Materialize the PR head read-only');
  const step = yml.slice(stepAt, yml.indexOf('- name:', stepAt + 10));
  const stepFlat = step.replace(/\s+/g, ' ');
  // Ordering assertions index into the COMMANDS only. The step's comments name the
  // very commands they warn about ("a failing `git archive` still yields exit 0"),
  // so indexing the raw text finds the prose, not the line that runs.
  const code = step
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('exists and is budgeted', () => {
    expect(stepAt).toBeGreaterThanOrEqual(0);
    expect(stepFlat).toMatch(/timeout-minutes: 2/);
  });

  it('extracts the head SHA — never the checked-out tree, which is BASE', () => {
    // The whole point of the step. The panel checks out base (gate config must come
    // from base), so post-change content has to come from an explicit head extract.
    expect(stepFlat).toMatch(/HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha/);
    expect(stepFlat).toMatch(/git archive "\$HEAD_SHA" \| tar -x -C "\$HEAD_ROOT"/);
  });

  it('sets pipefail BEFORE the archive pipeline (a failed archive must not exit 0)', () => {
    // The runner shell is `bash -e`, not `-o pipefail`: without this, a failing
    // `git archive` still yields exit 0 because `tar` succeeds on empty input, and
    // the step passes having extracted nothing. Position is the assertion — a
    // pipefail set after the pipeline protects nothing.
    expect(stepFlat).toMatch(/set -o pipefail/);
    expect(code.indexOf('set -o pipefail')).toBeLessThan(code.indexOf('git archive'));
  });

  it('fails closed on an empty extract rather than letting a lens review nothing', () => {
    // Belt-and-braces behind pipefail: a lens handed an empty tree either approves
    // work it never saw or invents "file missing" findings. Both are worse than red.
    expect(stepFlat).toMatch(/if \[ -z "\$\(ls -A "\$HEAD_ROOT"\)" \]; then[^]{0,300}exit 1/);
  });

  it('strips symlinks, and does so before the tree is made unwritable', () => {
    // `git archive` faithfully reproduces author-committed links, so
    // `notes.md -> /proc/self/environ` would let a lens told to read $HEAD_ROOT/<path>
    // read the RUNNER filesystem — including this job's secrets. The ordering half is
    // load-bearing too: chmod a-w first would block the delete.
    expect(stepFlat).toMatch(/find "\$HEAD_ROOT" -type l -delete/);
    expect(code.indexOf('-type l -delete')).toBeLessThan(code.indexOf('chmod -R a-w'));
  });

  it('makes the extract read-only so a lens cannot mutate what it is judging', () => {
    expect(stepFlat).toMatch(/chmod -R a-w "\$HEAD_ROOT"/);
  });

  it('exports HEAD_ROOT and wires it into the review step (an unexported path is unusable)', () => {
    expect(stepFlat).toMatch(/echo "HEAD_ROOT=\$HEAD_ROOT" >> "\$GITHUB_ENV"/);
    expect(flat).toMatch(/HEAD_ROOT: \$\{\{ env\.HEAD_ROOT \}\}/);
  });

  it('points the lens prompt at $HEAD_ROOT and forbids the base-reading git show', () => {
    // The extract only helps if the prompt sends the lens to it. `git show HEAD:` is
    // the exact instruction that produced the false findings this step fixes, so its
    // prohibition is pinned rather than merely commented.
    expect(flat).toMatch(/POST-CHANGE content from `\$HEAD_ROOT\/<path>`/);
    expect(flat).toMatch(/NEVER use `git show HEAD:<path>` or the working tree/);
  });

  it('treats $HEAD_ROOT as author-controlled in the untrusted-input rules', () => {
    // It is a verbatim extract of the author's branch: its file contents and comments
    // are exactly as attacker-controlled as the diff. A lens that trusts it as
    // "repo content" would follow instructions committed into it.
    expect(flat).toMatch(/\$HEAD_ROOT are written by the change author/);
  });

  it('carries no surviving instruction to read the head "via git"', () => {
    // A prohibition elsewhere in the prompt does not help if a later sentence still
    // sends the lens back to git for head content — the panelist follows whichever it
    // reads, and the contradiction is invisible to every test that only asserts the
    // presence of the right instruction. This one is here because exactly that
    // survived the port and the docs lens caught it: "Review the HEAD via git."
    expect(flat).not.toMatch(/Review the HEAD via git/);
    expect(flat).not.toMatch(/reads the HEAD only through git/);
    expect(flat).toMatch(/Review the HEAD through the diff and \$HEAD_ROOT/);
  });
});
