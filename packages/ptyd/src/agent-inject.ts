/**
 * What Vesper adds to an agent CLI's launch so it reports its state (design.md §7.1), and how
 * its hooks and window title read back as tracker signals. Everything applies to this launch
 * only; the user's own settings and hooks keep working alongside.
 */
import { randomUUID } from 'node:crypto';
import type { AgentKind, LaunchCommand } from '@vesper/protocol';
import type { AgentSignal } from './agent-state.js';
import { quoteArgument, quotePosixArgument } from './shells.js';

export interface Injection {
  command: LaunchCommand;
  /** The agent's session id when Vesper chose it (Claude, Gemini); Codex reports its own. */
  sessionId: string | null;
  /** A file to write before starting (Gemini's system defaults), and remove when the session ends. */
  file?: { path: string; content: string };
}

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure'];
const GEMINI_EVENTS = ['SessionStart', 'BeforeAgent', 'AfterAgent', 'AfterTool', 'Notification'];
/** Tools whose call is a question to the user, not work. */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const HOOK_TIMEOUT_S = 2;

/** Adds arguments: to `args` for a program file, at the end of a command line otherwise. */
function withArgs(command: LaunchCommand, extra: string[], platform: NodeJS.Platform): LaunchCommand {
  if ('file' in command) return { ...command, args: [...command.args, ...extra] };
  const quote = platform === 'win32' ? quoteArgument : quotePosixArgument;
  return { ...command, commandLine: `${command.commandLine} ${extra.map(quote).join(' ')}` };
}

/**
 * The launch with hooks pointing at `hookUrl`. `resumeId` (from an earlier run) continues
 * that conversation; `systemRoot` locates curl.exe, which ships with Windows 10 and later.
 */
export function injectAgent(
  command: LaunchCommand,
  kind: AgentKind,
  options: { hookUrl?: string; resumeId: string | null; systemRoot: string; scratchFile: string; platform?: NodeJS.Platform },
): Injection {
  const platform = options.platform ?? process.platform;
  if (!options.hookUrl) {
    const extra = options.resumeId ? [kind === 'codex' ? 'resume' : '--resume', options.resumeId] : [];
    return { command: withArgs(command, extra, platform), sessionId: options.resumeId };
  }
  const curl = platform === 'win32' ? `${options.systemRoot.replace(/\\/g, '/')}/System32/curl.exe` : 'curl';
  if (kind === 'claude') {
    const hooks = Object.fromEntries(CLAUDE_EVENTS.map((event) => [event, [{ hooks: [{ type: 'http', url: options.hookUrl, timeout: HOOK_TIMEOUT_S }] }]]));
    const sessionId = options.resumeId ?? randomUUID();
    const session = options.resumeId ? ['--resume', sessionId] : ['--session-id', sessionId];
    return { command: withArgs(command, ['--settings', JSON.stringify({ hooks }), ...session], platform), sessionId };
  }
  if (kind === 'codex') {
    // Codex appends the notification JSON as the last argument: it becomes curl's -d body.
    const notify = [curl, '-s', '-m', String(HOOK_TIMEOUT_S), '-H', 'content-type: application/json', options.hookUrl, '-d'];
    const extra = ['-c', `notify=${JSON.stringify(notify)}`, '-c', 'tui.notifications=true', '-c', 'tui.notification_method="osc9"'];
    return { command: withArgs(command, options.resumeId ? [...extra, 'resume', options.resumeId] : extra, platform), sessionId: options.resumeId };
  }
  const sessionId = options.resumeId ?? randomUUID();
  const hook = `${platform === 'win32' ? `"${curl}"` : quotePosixArgument(curl)} -s -m ${HOOK_TIMEOUT_S} -H "content-type: application/json" --data-binary @- ${options.hookUrl}`;
  const hooks = Object.fromEntries(GEMINI_EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command: hook, timeout: HOOK_TIMEOUT_S * 1000 }] }]]));
  const env = { ...command.env, GEMINI_CLI_NO_RELAUNCH: 'true', GEMINI_CLI_SYSTEM_DEFAULTS_PATH: options.scratchFile };
  const session = options.resumeId ? ['--resume', sessionId] : ['--session-id', sessionId];
  return {
    command: { ...withArgs(command, session, platform), env },
    sessionId,
    file: { path: options.scratchFile, content: JSON.stringify({ general: { enableAutoUpdate: false }, hooks }) },
  };
}

export interface HookReading {
  signal?: AgentSignal;
  sessionId?: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length <= 256 ? value : undefined);

/** What one hook post means. Unknown events read as nothing. */
export function readHook(kind: AgentKind, payload: unknown): HookReading {
  if (typeof payload !== 'object' || payload === null) return {};
  const body = payload as Record<string, unknown>;
  if (kind === 'codex') {
    return body['type'] === 'agent-turn-complete' ? { signal: 'done', ...optional(text(body['thread-id'])) } : {};
  }
  const sessionId = optional(text(body['session_id']));
  switch (body['hook_event_name']) {
    case 'SessionStart':
      return sessionId;
    case 'UserPromptSubmit':
    case 'BeforeAgent':
    case 'PostToolUse':
    case 'AfterTool':
      return { signal: 'working', ...sessionId };
    case 'PreToolUse':
      return { signal: ASKING_TOOLS.has(text(body['tool_name']) ?? '') ? 'waiting' : 'working', ...sessionId };
    case 'PermissionRequest':
      return { signal: 'waiting', ...sessionId };
    case 'Notification': {
      const type = text(body['notification_type']);
      return type === 'permission_prompt' || type === 'ToolPermission' ? { signal: 'waiting', ...sessionId } : sessionId;
    }
    case 'Stop':
    case 'StopFailure':
    case 'AfterAgent':
      return { signal: 'done', ...sessionId };
    default:
      return {};
  }
}

function optional(sessionId: string | undefined): { sessionId?: string } {
  return sessionId === undefined ? {} : { sessionId };
}

/** Claude ◐/◑ and Codex's braille spinner: working. Gemini ✦ working, ✋ needs the user, ◇ ready; Claude ✳ ready. */
export function readTitle(kind: AgentKind, title: string): AgentSignal | undefined {
  const first = title.trimStart().codePointAt(0);
  if (first === undefined) return undefined;
  if (kind === 'codex') return first >= 0x2800 && first <= 0x28ff ? 'working' : undefined;
  if (first === 0x25d0 || first === 0x25d1 || first === 0x2726) return 'working';
  if (first === 0x270b) return 'waiting';
  if (first === 0x2733 || first === 0x25c7) return 'idle';
  return undefined;
}
