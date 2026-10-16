/**
 * Desktop notifications a program asks the terminal for:
 *   OSC 9 ; <text> BEL                         iTerm2 style; Codex sends these
 *   OSC 777 ; notify ; <title> ; <body> BEL    urxvt style, also VTE and Ghostty
 * ConEmu uses OSC 9 for numbered subcommands (9;1 … 9;12, such as 9;4 progress);
 * those are not notifications.
 */
export const NOTIFY_OSC = 9;
export const NOTIFY_OSC_URXVT = 777;

const MAX_TEXT = 512;
/** Control and bidirectional-override characters: text from program output must not carry them into the UI. */
const UNSAFE = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;

export interface Notice {
  title: string;
  body: string;
}

export function safeText(text: string, max: number): string {
  return text.replace(UNSAFE, '').slice(0, max);
}

export function parseOsc9(data: string): Notice | undefined {
  if (/^\d+(?:;|$)/.test(data)) return undefined;
  const body = clean(data);
  return body === '' ? undefined : { title: '', body };
}

export function parseOsc777(data: string): Notice | undefined {
  const [kind, title = '', ...rest] = data.split(';');
  if (kind !== 'notify') return undefined;
  const notice = { title: clean(title), body: clean(rest.join(';')) };
  return notice.title === '' && notice.body === '' ? undefined : notice;
}

function clean(text: string): string {
  return safeText(text, MAX_TEXT).trim();
}

/** Token bucket: `burst` notices at once, then one per `intervalMs`, so a looping program cannot flood the UI. */
export class NoticeLimiter {
  private tokens: number;
  private refilledAt = 0;

  constructor(
    private readonly burst: number,
    private readonly intervalMs: number,
  ) {
    this.tokens = burst;
  }

  allow(now: number): boolean {
    const earned = Math.floor((now - this.refilledAt) / this.intervalMs);
    if (earned > 0) {
      this.tokens = Math.min(this.burst, this.tokens + earned);
      this.refilledAt += earned * this.intervalMs;
    }
    if (this.tokens === 0) return false;
    this.tokens--;
    return true;
  }
}
