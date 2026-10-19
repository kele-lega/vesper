import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { claudeSessionsDir, isIdle, listExternalClaude, lookupProcesses, terminateAndWait, type ProcessFacts } from '../src/external-sessions.js';

describe('external Claude sessions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vesper-ext-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const record = (pid: number, extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(dir, `${pid}.json`),
      JSON.stringify({ pid, sessionId: `sess-${pid}`, cwd: 'D:\\code\\x', procStart: `start-${pid}`, status: 'idle', name: `n${pid}`, startedAt: pid, kind: 'interactive', ...extra }),
    );
  const lookup = (facts: Record<number, ProcessFacts>) => async () => new Map(Object.entries(facts).map(([pid, value]) => [Number(pid), value]));

  test('keeps live Claude processes whose start time matches', async () => {
    record(1);
    const sessions = await listExternalClaude(dir, lookup({ 1: { start: 'start-1', name: 'claude.exe' } }));
    expect(sessions).toEqual([{ pid: 1, sessionId: 'sess-1', cwd: 'D:\\code\\x', status: 'idle', name: 'n1', startedAt: 1 }]);
  });

  test('drops dead processes, reused pids, other programs, and records that do not fit', async () => {
    record(1); // dead
    record(2); // pid reused: another start time
    record(3); // not claude
    record(4, { sessionId: '../evil' });
    record(5, { kind: 'headless' });
    record(9, { sessionId: '--dangerously-skip-permissions' }); // would read as a flag after --resume
    record(11); // only named like Claude
    writeFileSync(join(dir, '6.json'), '{not json');
    writeFileSync(join(dir, '7.json'), JSON.stringify({ pid: 8, sessionId: 'x', cwd: 'C:\\', procStart: 's' })); // name and pid disagree
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const exe = 'claude.exe';
    const sessions = await listExternalClaude(
      dir,
      lookup({
        2: { start: 'other', name: exe },
        3: { start: 'start-3', name: 'node.exe' },
        4: { start: 'start-4', name: exe },
        5: { start: 'start-5', name: exe },
        8: { start: 's', name: exe },
        9: { start: 'start-9', name: exe },
        11: { start: 'start-11', name: 'claude.exe.evil.exe' },
      }),
    );
    expect(sessions).toEqual([]);
  });

  test('lists oldest first and treats a missing folder as empty', async () => {
    record(20);
    record(10);
    const facts = { 10: { start: 'start-10', name: 'Claude.EXE' }, 20: { start: 'start-20', name: 'claude.exe.old.1792340000000' } };
    expect((await listExternalClaude(dir, lookup(facts))).map((entry) => entry.pid)).toEqual([10, 20]);
    expect(await listExternalClaude(join(dir, 'missing'), lookup({}))).toEqual([]);
  });

  test('only an idle session can be taken over', () => {
    expect(isIdle({ status: 'idle' })).toBe(true);
    expect(isIdle({ status: 'busy' })).toBe(false);
  });

  test('finds the folder from CLAUDE_CONFIG_DIR or the home folder', () => {
    expect(claudeSessionsDir({ CLAUDE_CONFIG_DIR: 'D:\\cfg' }, 'C:\\Users\\u')).toBe(join('D:\\cfg', 'sessions'));
    expect(claudeSessionsDir({}, 'C:\\Users\\u')).toBe(join('C:\\Users\\u', '.claude', 'sessions'));
  });

  test.runIf(process.platform === 'win32')('reads a live process through Win32: FILETIME start and image name', async () => {
    const facts = await lookupProcesses([process.pid, 0x7fff_fff0]);
    const self = facts.get(process.pid)!;
    expect(self.name.toLowerCase()).toBe('node.exe');
    // A FILETIME counts 100 ns from 1601; this process started within the last hour.
    const startMs = Number(BigInt(self.start) / 10_000n) - 11_644_473_600_000;
    expect(Math.abs(startMs - (Date.now() - process.uptime() * 1000))).toBeLessThan(60_000);
    expect(facts.has(0x7fff_fff0)).toBe(false);
  });

  test('terminateAndWait reports whether the process went', async () => {
    let alive = true;
    const killed: number[] = [];
    const ok = await terminateAndWait(9, { kill: (pid) => killed.push(pid), alive: () => alive, sleep: async () => void (alive = false) });
    expect(ok).toBe(true);
    expect(killed).toEqual([9]);
    expect(await terminateAndWait(9, { timeoutMs: 300, kill: () => undefined, alive: () => true, sleep: async () => undefined })).toBe(false);
  });
});
