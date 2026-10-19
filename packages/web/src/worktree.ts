import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { LAUNCH_CWD_ENV } from '@vesper/ptyd/client';

/**
 * Git worktrees for agent tabs (design.md §7.5): `<project parent>/<project>-worktrees/<name>` on
 * branch `vesper/<name>`, so the project folder itself gains nothing. Arguments are passed as an
 * array (no shell), and a name always starts with a letter or digit so git cannot read it as an option.
 */

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const BRANCH_PREFIX = 'vesper/';

export class WorktreeError extends Error {}

export interface Worktree {
  path: string;
  branch: string;
}

export interface WorktreeRemoval {
  /** False when git refused (uncommitted changes, or the folder is in use); the worktree is then left alone. */
  worktreeRemoved: boolean;
  /** False when the branch has commits that are not merged, or the worktree stayed; the branch is then kept. */
  branchRemoved: boolean;
  /** Why something was kept; empty when both went. */
  note: string;
}

/**
 * The restricted-token launcher (vesper-launch) git runs through, or undefined to run git with
 * web's own token, which is right when web is not elevated. Elevated, git would run hooks,
 * fsmonitor and filter drivers from the repository's .git, which normal-privilege agents can write.
 * It throws when an elevated web cannot provide the launcher; git then does not run at all.
 */
export type GitLauncher = () => string | undefined;
export const OWN_TOKEN: GitLauncher = () => undefined;

export function validName(name: string): boolean {
  return NAME.test(name) && !name.includes('..') && !name.endsWith('.') && !name.endsWith('.lock');
}

export function worktreePath(projectPath: string, name: string): string {
  const parent = win32.dirname(projectPath);
  return win32.join(parent, `${win32.basename(projectPath)}-worktrees`, name);
}

async function git(launcher: GitLauncher, cwd: string, args: string[]): Promise<string> {
  try {
    const exe = launcher();
    const argv = ['-C', cwd, ...args];
    // vesper-launch starts in its own protected folder, so no DLL planted in the project loads into
    // it, and hands the rest of its command line to the child unchanged.
    const { stdout } = exe
      ? await run(exe, ['git', ...argv], { cwd: win32.dirname(exe), env: { ...process.env, [LAUNCH_CWD_ENV]: cwd }, timeout: GIT_TIMEOUT_MS, windowsHide: true })
      : await run('git', argv, { timeout: GIT_TIMEOUT_MS, windowsHide: true });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : error instanceof Error ? error.message : 'git failed';
    throw new WorktreeError(detail);
  }
}

/** Whether `path` is inside a git work tree. */
export async function isGitRepository(path: string, launcher: GitLauncher = OWN_TOKEN): Promise<boolean> {
  try {
    return (await git(launcher, path, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

/** Makes the worktree and its branch for `name`; fails (leaving nothing behind) when either exists already. */
export async function createWorktree(projectPath: string, name: string, launcher: GitLauncher = OWN_TOKEN): Promise<Worktree> {
  if (!validName(name)) throw new WorktreeError('worktree 名称只能用字母、数字、点、下划线和连字符，并以字母或数字开头');
  try {
    launcher(); // an elevated web that cannot drop privileges says so here, not as "not a repository"
  } catch (error) {
    throw new WorktreeError(`无法以普通权限运行 git：${(error as Error).message}`);
  }
  if (!(await isGitRepository(projectPath, launcher))) throw new WorktreeError('这个项目文件夹不是 git 仓库');
  const path = worktreePath(projectPath, name);
  const branch = `${BRANCH_PREFIX}${name}`;
  await git(launcher, projectPath, ['worktree', 'add', path, '-b', branch]);
  return { path, branch };
}

/**
 * Removes the worktree, then its branch. Neither is forced: uncommitted changes keep the worktree,
 * and commits not merged into the project's current branch keep the branch.
 */
export async function removeWorktree(projectPath: string, worktree: Worktree, launcher: GitLauncher = OWN_TOKEN): Promise<WorktreeRemoval> {
  try {
    await git(launcher, projectPath, ['worktree', 'remove', worktree.path]);
  } catch (error) {
    return { worktreeRemoved: false, branchRemoved: false, note: `worktree 没有删除：${(error as Error).message}` };
  }
  try {
    await git(launcher, projectPath, ['branch', '-d', worktree.branch]);
  } catch {
    return { worktreeRemoved: true, branchRemoved: false, note: `分支 ${worktree.branch} 有未合并的提交，已保留` };
  }
  return { worktreeRemoved: true, branchRemoved: true, note: '' };
}
