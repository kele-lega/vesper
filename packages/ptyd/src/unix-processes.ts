import { readdirSync, readFileSync, statSync } from 'node:fs';
import { log } from './log.js';

export interface ProcStat {
  pid: number;
  ppid: number;
  group: number;
  session: number;
  /** Kernel start ticks, kept as text to avoid losing integer precision. */
  start: string;
}

/** comm can contain spaces and parentheses; the fields begin after its final ')'. */
export function parseProcStat(text: string): ProcStat | undefined {
  const end = text.lastIndexOf(')');
  if (end < 0) return undefined;
  const pid = Number(text.slice(0, text.indexOf(' ')));
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const group = Number(fields[2]);
  const session = Number(fields[3]);
  const start = fields[19];
  if (![pid, group, session].every((value) => Number.isSafeInteger(value) && value > 0) || !Number.isSafeInteger(ppid) || ppid < 0 || !start || !/^\d+$/.test(start)) return undefined;
  return { pid, ppid, group, session, start };
}

function readProcess(pid: number): ProcStat | undefined {
  try {
    if (statSync(`/proc/${pid}`).uid !== process.getuid!()) return undefined;
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return undefined; // processes regularly exit while /proc is enumerated
  }
}

export interface UnixSession {
  terminate(): void;
}

/** forkpty creates a new session. Job-control children have different groups but the same SID. */
export function trackUnixSession(pid: number): UnixSession | undefined {
  if (process.platform !== 'linux') return undefined;
  const leader = readProcess(pid);
  if (!leader) return undefined;
  return {
    terminate(): void {
      const current = readProcess(pid);
      // forkpty's child can briefly still have its parent's SID when spawn returns.
      if (current && (current.start !== leader.start || current.session !== pid)) return;
      let names: string[];
      try {
        names = readdirSync('/proc');
      } catch (error) {
        log.warn(`could not enumerate terminal session ${pid}`, error);
        return;
      }
      for (let pass = 0; pass < 3; pass++) {
        const members = names.filter((name) => /^\d+$/.test(name)).map((name) => readProcess(Number(name)))
          .filter((item): item is ProcStat => item !== undefined && item.session === pid);
        if (members.length === 0) return;
        // Stop the leader last; most shells reap children on their own exit.
        for (const member of [...members.filter((item) => item.pid !== pid), ...members.filter((item) => item.pid === pid)]) {
          const live = readProcess(member.pid);
          if (!live || live.start !== member.start || live.session !== pid) continue;
          try {
            process.kill(member.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') log.warn(`could not end terminal process ${member.pid}`, error);
          }
        }
        try {
          names = readdirSync('/proc'); // include jobs forked during the first pass
        } catch (error) {
          log.warn(`could not rescan terminal session ${pid}`, error);
          return;
        }
      }
    },
  };
}
