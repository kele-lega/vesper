import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { compileLauncher } from '@vesper/ptyd/client';
import { createWorktree, isGitRepository, removeWorktree, validName, WorktreeError, worktreePath } from '../src/worktree.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });

describe('worktree', () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'vesper-wt-')));
    project = join(root, 'proj');
    mkdirSync(project);
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.email', 't@example.com');
    git(project, 'config', 'user.name', 't');
    writeFileSync(join(project, 'a.txt'), 'a');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('accepts plain names and refuses ones git or Windows would misread', () => {
    expect(['fix-1', 'a.b_c', 'A1'].every(validName)).toBe(true);
    expect(['', '-rf', '.x', 'a..b', 'a.lock', 'a b', 'a/b', 'a\\b', 'x.', 'con:'].some(validName)).toBe(false);
  });

  test('puts the worktree beside the project folder', () => {
    expect(worktreePath('D:\\work\\proj', 'x', 'win32')).toBe('D:\\work\\proj-worktrees\\x');
  });

  test('knows a repository from a plain folder', async () => {
    expect(await isGitRepository(project)).toBe(true);
    expect(await isGitRepository(root)).toBe(false);
  });

  test('creates a worktree on its own branch and removes both when clean', async () => {
    const made = await createWorktree(project, 'one');
    expect(existsSync(join(made.path, 'a.txt'))).toBe(true);
    expect(made.branch).toBe('vesper/one');
    expect(await removeWorktree(project, made)).toEqual({ worktreeRemoved: true, branchRemoved: true, note: '' });
    expect(existsSync(made.path)).toBe(false);
    expect(git(project, 'branch', '--list', 'vesper/one').trim()).toBe('');
  });

  test('keeps the branch when it has unmerged commits', async () => {
    const made = await createWorktree(project, 'two');
    writeFileSync(join(made.path, 'b.txt'), 'b');
    git(made.path, 'add', '.');
    git(made.path, 'commit', '-q', '-m', 'work');
    const result = await removeWorktree(project, made);
    expect(result).toMatchObject({ worktreeRemoved: true, branchRemoved: false });
    expect(git(project, 'branch', '--list', 'vesper/two')).toContain('vesper/two');
  });

  test('keeps a worktree with uncommitted changes', async () => {
    const made = await createWorktree(project, 'three');
    writeFileSync(join(made.path, 'a.txt'), 'changed');
    const result = await removeWorktree(project, made);
    expect(result).toMatchObject({ worktreeRemoved: false, branchRemoved: false });
    expect(existsSync(made.path)).toBe(true);
  });

  test.runIf(process.platform === 'win32')('runs git through vesper-launch: arguments and output survive the hop', { timeout: 60_000 }, async () => {
    const launcher = compileLauncher(join(root, 'bin'), process.env['SystemRoot'] ?? 'C:\\Windows');
    const through = () => launcher;
    expect(await isGitRepository(project, through)).toBe(true);
    const made = await createWorktree(project, 'via-launcher', through);
    expect(existsSync(join(made.path, 'a.txt'))).toBe(true);
    expect(await removeWorktree(project, made, through)).toEqual({ worktreeRemoved: true, branchRemoved: true, note: '' });
  });

  test('an elevated web that cannot drop privileges refuses git outright', async () => {
    const blocked = () => {
      throw new Error('normal-privilege sessions are disabled');
    };
    await expect(createWorktree(project, 'x', blocked)).rejects.toThrow(/普通权限/);
    expect(existsSync(worktreePath(project, 'x'))).toBe(false);
  });

  test('refuses a bad name, a non-repository and a name already used', async () => {
    await expect(createWorktree(project, '-x')).rejects.toBeInstanceOf(WorktreeError);
    await expect(createWorktree(root, 'x')).rejects.toBeInstanceOf(WorktreeError);
    await createWorktree(project, 'dup');
    await expect(createWorktree(project, 'dup')).rejects.toBeInstanceOf(WorktreeError);
  });
});
