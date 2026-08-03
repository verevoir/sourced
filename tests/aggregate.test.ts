import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(
  new URL('../.github/antagonistic-review/aggregate.sh', import.meta.url)
);

/** A verdict.json body. `null` as a file body means "make the lens dir but no verdict
 * file" (the directory-exists-but-file-absent case). */
const verdict = (v: string, findings: string[] = [], summary = 's') =>
  JSON.stringify({ verdict: v, summary, findings });

/** Lay out `verdict-<lens>/verdict.json` files in a throwaway dir and run the aggregator
 * over a chosen lens set (default two lenses a, b), returning exit code + stdout. The
 * subprocess is bounded generously so a genuinely-hung script fails legibly rather than
 * hanging the suite, without flaking on a loaded CI runner. */
async function aggregate(
  files: Record<string, string | null>,
  lenses: string | false = 'a b'
): Promise<{ code: number; stdout: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'agg-'));
  try {
    for (const [lens, body] of Object.entries(files)) {
      const d = join(dir, `verdict-${lens}`);
      await mkdir(d, { recursive: true });
      if (body !== null) await writeFile(join(d, 'verdict.json'), body);
    }
    // `lenses === false` leaves PANEL_LENSES unset, so the script uses its hardcoded
    // production default — the actual configuration the gate ships with.
    const env = { ...process.env } as NodeJS.ProcessEnv;
    if (lenses === false) delete env.PANEL_LENSES;
    else env.PANEL_LENSES = lenses;
    try {
      const { stdout } = await run('bash', [SCRIPT, dir], { env, timeout: 20000 });
      return { code: 0, stdout };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; killed?: boolean; signal?: string };
      // A timed-out-and-killed subprocess must fail the test loudly — reading it as a
      // plain non-zero exit would let a hung script pass every fail-closed assertion.
      if (err.killed || err.signal) {
        throw new Error(
          `aggregate.sh was killed (${err.signal ?? 'timeout'}) — hung, not rejected`
        );
      }
      return { code: err.code ?? 1, stdout: err.stdout ?? '' };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** True if any output line begins with the given GitHub Actions `::command`, proving
 * `safe()` FAILED to neutralise (space-prefix) a command smuggled through a
 * model-controlled verdict field. Tests inject commands the script never emits itself
 * (e.g. ::add-mask, ::set-output), so a hit is unambiguously a leak — not the
 * aggregator's own `::error` annotations. */
const leaks = (stdout: string, command: string) =>
  // split on \r as a line terminator too — the GHA runner treats a raw CR as one,
  // so a command after a CR is at "line start" for the runner even mid-\n-line
  stdout.split(/\r?\n|\r/).some((l) => l.startsWith(command));

describe('aggregate.sh — union the panel and gate on unanimous approval', () => {
  it('exits 0 and reports success when every lens APPROVES', async () => {
    const { code, stdout } = await aggregate({ a: verdict('APPROVE'), b: verdict('APPROVE') });
    expect(code).toBe(0);
    expect(stdout).toContain('Every lens APPROVED');
  });

  it('fails closed when one lens REJECTS', async () => {
    expect((await aggregate({ a: verdict('APPROVE'), b: verdict('REJECT') })).code).toBe(1);
  });

  it('fails closed when every lens REJECTS', async () => {
    expect((await aggregate({ a: verdict('REJECT'), b: verdict('REJECT') })).code).toBe(1);
  });

  it('fails closed on an unexpected non-APPROVE verdict string', async () => {
    expect((await aggregate({ a: verdict('APPROVE'), b: verdict('MAYBE') })).code).toBe(1);
  });

  it('fails closed, naming the panelist, when a verdict is missing entirely', async () => {
    const { code, stdout } = await aggregate({ a: verdict('APPROVE') }); // b never produced a verdict
    expect(code).toBe(1);
    expect(stdout).toContain("Panelist 'b' produced no verdict");
  });

  it('fails closed when the lens directory exists but the verdict file is absent', async () => {
    const { code, stdout } = await aggregate({ a: verdict('APPROVE'), b: null });
    expect(code).toBe(1);
    // the failure must come from the missing-verdict guard, naming the lens
    expect(stdout).toContain("Missing verdict::Panelist 'b'");
  });

  it('fails closed on a malformed verdict json', async () => {
    expect((await aggregate({ a: verdict('APPROVE'), b: '{ not json' })).code).toBe(1);
  });

  it('fails closed when the verdict key is absent', async () => {
    expect(
      (await aggregate({ a: verdict('APPROVE'), b: JSON.stringify({ summary: 'x' }) })).code
    ).toBe(1);
  });

  it('fails closed rather than passing vacuously when the lens set is empty', async () => {
    const { code, stdout } = await aggregate({}, '');
    expect(code).toBe(1);
    expect(stdout).toContain('checked nothing');
  });

  it('fails closed on a lens set containing anything but [a-z0-9-] tokens', async () => {
    const { code, stdout } = await aggregate({}, '../evil');
    expect(code).toBe(1);
    expect(stdout).toContain('only [a-z0-9-]');
  });

  it('fails closed on matrix/aggregator drift — a verdict for a lens outside the gated set', async () => {
    const { code, stdout } = await aggregate(
      { a: verdict('APPROVE'), b: verdict('APPROVE'), extra: verdict('APPROVE') },
      'a b'
    );
    expect(code).toBe(1);
    expect(stdout).toContain("'extra' produced a verdict but is not in the gated set");
  });

  it('fails with a usage error when called with no verdicts directory', async () => {
    await expect(
      run('bash', [SCRIPT], { env: { ...process.env, PANEL_LENSES: 'a b' }, timeout: 20000 })
    ).rejects.toThrow(/usage/);
  });

  it('approves the real production lens set (PANEL_LENSES unset) when all five APPROVE', async () => {
    const lenses = ['correctness', 'security', 'testing', 'docs', 'resilience'];
    const files = Object.fromEntries(lenses.map((l) => [l, verdict('APPROVE')]));
    const { code } = await aggregate(files, false);
    expect(code).toBe(0);
  });

  it('fails closed on an oversize verdict file, refusing to parse untrusted bulk', async () => {
    const huge = JSON.stringify({
      verdict: 'APPROVE',
      summary: 'x'.repeat(1_100_000),
      findings: [],
    });
    const { code, stdout } = await aggregate({ a: verdict('APPROVE'), b: huge });
    expect(code).toBe(1);
    // the failure must come from the oversize guard, not some other path
    expect(stdout).toContain("Oversize verdict::Panelist 'b'");
  });

  it('draws the oversize boundary exactly: 1,000,000 bytes parses, one byte more refuses', async () => {
    // all-ASCII JSON, so bytes == chars; pad the summary to hit the exact total
    const exact = (total: number) => {
      const scaffold = JSON.stringify({ verdict: 'APPROVE', summary: '', findings: [] }).length;
      return JSON.stringify({
        verdict: 'APPROVE',
        summary: 'x'.repeat(total - scaffold),
        findings: [],
      });
    };
    const atCap = await aggregate({ a: verdict('APPROVE'), b: exact(1_000_000) });
    expect(atCap.code).toBe(0);
    const overCap = await aggregate({ a: verdict('APPROVE'), b: exact(1_000_001) });
    expect(overCap.code).toBe(1);
    expect(overCap.stdout).toContain("Oversize verdict::Panelist 'b'");
  });

  it('prints each lens, its verdict, and its findings', async () => {
    const { stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: verdict('REJECT', ['first problem', 'second problem']),
    });
    expect(stdout).toContain('### a — APPROVE');
    expect(stdout).toContain('### b — REJECT');
    expect(stdout).toContain('  - first problem');
    expect(stdout).toContain('  - second problem');
  });

  it('handles a verdict with an empty summary without crashing', async () => {
    expect(
      (await aggregate({ a: verdict('APPROVE', [], ''), b: verdict('APPROVE', [], '') })).code
    ).toBe(0);
  });

  it('neutralises an injected command in the verdict field AND still fails closed', async () => {
    const { code, stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: JSON.stringify({ verdict: 'APPROVE\n::add-mask::X', summary: 's', findings: [] }),
    });
    expect(leaks(stdout, '::add-mask')).toBe(false);
    // Diagnostic, not just negative: the smuggled line must still APPEAR, space-prefixed
    // by safe() — silently dropping the content would also satisfy the leak check.
    expect(stdout).toContain(' ::add-mask::X');
    // A verdict carrying a smuggled newline is not exactly "APPROVE": jq renders the
    // JSON `\n` escape as a REAL newline in the extracted value, so the string
    // comparison in aggregate.sh fails and the gate must not pass. The failure is the
    // comparison's strictness, not the sanitiser — safe() only neutralises the echo.
    expect(code).toBe(1);
  });

  it('neutralises an injected command in a finding (a different command) and fails closed', async () => {
    const { code, stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: verdict('REJECT', ['first line\n::set-output::name=evil']),
    });
    expect(leaks(stdout, '::set-output')).toBe(false);
    expect(stdout).toContain(' ::set-output::name=evil'); // neutralised, not dropped
    expect(code).toBe(1);
  });

  it('neutralises an injected command in the summary without altering the verdict', async () => {
    // Summary flows through safe() too, but a neutralised summary must not change the
    // gate's decision: both lenses genuinely APPROVE, so this passes (code 0).
    const { code, stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: JSON.stringify({
        verdict: 'APPROVE',
        summary: 'looks fine\n::save-state::k=v',
        findings: [],
      }),
    });
    expect(leaks(stdout, '::save-state')).toBe(false);
    expect(stdout).toContain(' ::save-state::k=v'); // neutralised, not dropped
    expect(code).toBe(0);
  });

  it('neutralises an injected command in a REJECTING lens summary and still fails closed', async () => {
    // The complementary path: a sanitised summary must not soften a REJECT either.
    const { code, stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: JSON.stringify({
        verdict: 'REJECT',
        summary: 'bad change\n::save-state::k=v',
        findings: ['a real finding'],
      }),
    });
    expect(leaks(stdout, '::save-state')).toBe(false);
    expect(stdout).toContain(' ::save-state::k=v');
    expect(code).toBe(1);
  });

  it('fails closed on the real production lens set (PANEL_LENSES unset) when one lens REJECTS', async () => {
    const lenses = ['correctness', 'security', 'testing', 'docs', 'resilience'];
    const files = Object.fromEntries(
      lenses.map((l) => [l, verdict(l === 'resilience' ? 'REJECT' : 'APPROVE')])
    );
    const { code, stdout } = await aggregate(files, false);
    expect(code).toBe(1);
    expect(stdout).toContain('### resilience — REJECT');
  });

  it('sanitises a crafted verdict directory name so the drift error cannot leak a command', async () => {
    // The drift error embeds the stray directory's basename — a name smuggling a
    // newline + `::` command bypasses safe(), so the script reduces it to the lens
    // alphabet before echoing. Still fails closed on the drift itself.
    const { code, stdout } = await aggregate(
      {
        a: verdict('APPROVE'),
        b: verdict('APPROVE'),
        'evil\n::stop-commands::tok': verdict('APPROVE'),
      },
      'a b'
    );
    expect(code).toBe(1);
    expect(leaks(stdout, '::stop-commands')).toBe(false);
    // Diagnostic, not just negative (matching the other injection tests): the name's
    // lens-alphabet remainder must still APPEAR in the drift error — sanitised to
    // nothing would also satisfy the leak check.
    expect(stdout).toContain(
      "'evilstop-commandstok' produced a verdict but is not in the gated set"
    );
  });

  it('neutralises a workflow-command smuggled through a carriage return — \\r is a runner line terminator sed alone never sees', async () => {
    const { code, stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: verdict('REJECT', ['benign\r::set-env name=X::pwned']),
    });
    expect(code).toBe(1);
    expect(leaks(stdout, '::set-env')).toBe(false);
    expect(stdout).not.toContain('\r::');
    // Diagnostic, matching the other injection tests: the CR is STRIPPED, welding the
    // command mid-line where the runner never parses it — neutralised, not dropped.
    expect(stdout).toContain('benign::set-env name=X::pwned');
  });

  it('neutralises a CR smuggled through the VERDICT VALUE field (the heading echo)', async () => {
    // the `### <lens> — ${v}` heading echoes the model-controlled verdict value inside
    // the safe() pipe; a CR in .verdict must be stripped there too
    const { code, stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: JSON.stringify({ verdict: 'REJECT\r::set-env name=Z::pwned', summary: 's', findings: [] }),
    });
    expect(code).toBe(1);
    expect(leaks(stdout, '::set-env')).toBe(false);
    expect(stdout).not.toContain('\r::');
  });

  it('neutralises a CR smuggled through the SUMMARY field too (also piped through safe())', async () => {
    const { code, stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: JSON.stringify({
        verdict: 'REJECT',
        summary: 'ok\r::set-env name=Y::pwned',
        findings: [],
      }),
    });
    expect(code).toBe(1);
    expect(leaks(stdout, '::set-env')).toBe(false);
    expect(stdout).not.toContain('\r::');
  });

  it('percent-encodes panelist text so %0D/%0A escape smuggling dies at the source', async () => {
    const { code, stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: verdict('REJECT', ['try %0D::add-mask::Z smuggle', 'and %0A::stop-commands::t too']),
    });
    expect(code).toBe(1); // the encoding pass must not mutate the gate's decision
    expect(stdout).toContain('%250D');
    expect(stdout).toContain('%250A');
    expect(leaks(stdout, '::add-mask')).toBe(false);
    expect(leaks(stdout, '::stop-commands')).toBe(false);
  });

  it('percent-encodes %0D/%0A in the SUMMARY field too', async () => {
    const { stdout } = await aggregate({
      a: verdict('APPROVE'),
      b: JSON.stringify({
        verdict: 'REJECT',
        summary: 'pre %0D::add-mask::Q post',
        findings: [],
      }),
    });
    expect(stdout).toContain('%250D');
    expect(leaks(stdout, '::add-mask')).toBe(false);
  });

  it('fails the lens closed when a jq parse exceeds the bound (a hung jq is a REJECT, not a hang)', async () => {
    // A PATH sandbox whose `jq` sleeps past the (test-shrunk) bound: the timeout
    // kills the parse, the verdict extracts empty, and the gate fails closed.
    const bin = await mkdtemp(join(tmpdir(), 'slowjq-'));
    const dir = await mkdtemp(join(tmpdir(), 'aggslow-'));
    try {
      for (const tool of ['bash', 'sed', 'tr', 'head', 'wc', 'basename', 'timeout', 'sleep']) {
        const { stdout: p } = await run('which', [tool]);
        await symlink(p.trim(), join(bin, tool));
      }
      const { stdout: realJq } = await run('which', ['jq']);
      await writeFile(
        join(bin, 'jq'),
        `#!/usr/bin/env bash\nsleep 3\nexec ${realJq.trim()} "$@"\n`,
        {
          mode: 0o755,
        }
      );
      const d = join(dir, 'verdict-a');
      await mkdir(d, { recursive: true });
      await writeFile(join(d, 'verdict.json'), verdict('APPROVE'));
      try {
        await run('bash', [SCRIPT, dir], {
          env: { PATH: bin, PANEL_LENSES: 'a', JQ_BOUNDED_TIMEOUT: '1' },
          timeout: 20000,
        });
        expect.unreachable('a timed-out parse must fail the gate');
      } catch (e) {
        const err = e as { code?: number; stdout?: string; killed?: boolean };
        expect(err.killed).toBeFalsy(); // the SCRIPT finished — only jq was killed
        expect(err.code).toBe(1);
        expect(err.stdout).toContain('### a — none'); // empty verdict, not APPROVE
      }
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still parses (the timeout wrapper is transparent) when coreutils timeout is absent from PATH', async () => {
    // Exercise jq_bounded's fallback branch: run the script with a PATH that carries
    // every external command aggregate.sh needs EXCEPT timeout.
    const bin = await mkdtemp(join(tmpdir(), 'nobin-'));
    const dir = await mkdtemp(join(tmpdir(), 'aggnt-'));
    try {
      for (const tool of ['bash', 'jq', 'sed', 'tr', 'head', 'wc', 'basename']) {
        const { stdout: p } = await run('which', [tool]);
        await symlink(p.trim(), join(bin, tool));
      }
      const d = join(dir, 'verdict-a');
      await mkdir(d, { recursive: true });
      await writeFile(join(d, 'verdict.json'), verdict('APPROVE'));
      const { stdout } = await run('bash', [SCRIPT, dir], {
        env: { PATH: bin, PANEL_LENSES: 'a' },
        timeout: 20000,
      });
      expect(stdout).toContain('Every lens APPROVED');
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});
