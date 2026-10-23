import { release } from 'node:os';
import serializeAddon from '@xterm/addon-serialize';
import type { SerializeAddon } from '@xterm/addon-serialize';
import unicode11Addon from '@xterm/addon-unicode11';
import xtermHeadless from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import { answerColourQueries } from './colour-queries.js';
import { Listeners } from './log.js';
import { NOTIFY_OSC, NOTIFY_OSC_URXVT, parseOsc777, parseOsc9 } from './notify-osc.js';
import type { Notice } from './notify-osc.js';
import { CWD_OSC } from './shells.js';

/** A directory report from a shell's prompt hook; see shells.ts. */
export interface CwdReport {
  nonce: string;
  path: string;
}

export interface MirrorOptions {
  cols: number;
  rows: number;
  scrollback: number;
}

const WINDOWS_BUILD = Number(release().split('.')[2] ?? 0);

/**
 * Headless xterm copy of a session's screen: it answers terminal queries,
 * serializes snapshots and tracks title and current directory.
 */
export class ScreenMirror {
  private readonly terminal: Terminal;
  private readonly serializer: SerializeAddon;
  private readonly replies = new Listeners<string>('mirror reply');
  private readonly titles = new Listeners<string>('mirror title');
  private readonly cwds = new Listeners<CwdReport>('mirror cwd');
  private readonly notices = new Listeners<Notice>('mirror notice');

  constructor(options: MirrorOptions) {
    this.terminal = new xtermHeadless.Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
      allowProposedApi: true,
      // The same ConPTY handling and width table as the browser, so snapshots line up with what it shows.
      ...(process.platform === 'win32' ? { windowsPty: { backend: 'conpty' as const, buildNumber: WINDOWS_BUILD } } : {}),
    });
    this.serializer = new serializeAddon.SerializeAddon();
    this.terminal.loadAddon(this.serializer);
    this.terminal.loadAddon(new unicode11Addon.Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    this.terminal.onData((reply) => this.replies.emit(reply));
    this.terminal.onTitleChange((title) => this.titles.emit(title));
    answerColourQueries(this.terminal.parser, (reply) => this.replies.emit(reply));
    this.terminal.parser.registerOscHandler(CWD_OSC, (data) => this.handleCwd(data));
    this.terminal.parser.registerOscHandler(NOTIFY_OSC, (data) => this.handleNotice(parseOsc9(data)));
    this.terminal.parser.registerOscHandler(NOTIFY_OSC_URXVT, (data) => this.handleNotice(parseOsc777(data)));
  }

  get cols(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  /** Whether a full-screen program has switched to the alternate buffer. */
  get alternateScreen(): boolean {
    return this.terminal.buffer.active.type === 'alternate';
  }

  /** Cursor position in the visible screen (0-based), as of everything parsed so far. */
  get cursor(): { x: number; y: number } {
    const buffer = this.terminal.buffer.active;
    return { x: buffer.cursorX, y: buffer.cursorY };
  }

  /** Replies to terminal queries found in the output; with no listener they are dropped. */
  onReply(listener: (reply: string) => void): () => void {
    return this.replies.add(listener);
  }

  onTitle(listener: (title: string) => void): () => void {
    return this.titles.add(listener);
  }

  onCwd(listener: (report: CwdReport) => void): () => void {
    return this.cwds.add(listener);
  }

  /** Desktop notifications the program asked for (OSC 9 and OSC 777), already cleaned; see notify-osc.ts. */
  onNotice(listener: (notice: Notice) => void): () => void {
    return this.notices.add(listener);
  }

  /** Parses asynchronously; parsed() runs once these bytes and everything before them are applied. */
  write(data: string | Uint8Array, parsed?: () => void): void {
    this.terminal.write(data, parsed);
  }

  flush(): Promise<void> {
    return new Promise((resolve) => this.terminal.write('', resolve));
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  /** Screen and scrollback as escape sequences, as of everything parsed so far. */
  serialize(): string {
    return this.serializer.serialize();
  }

  /** Visible rows as plain text, trailing blanks trimmed. */
  screenText(): string {
    return this.visibleLines().join('\n').trimEnd();
  }

  /** Index of the last visible row with any text, or -1 for a blank screen. */
  lastUsedRow(): number {
    const lines = this.visibleLines();
    for (let row = lines.length - 1; row >= 0; row--) if (lines[row] !== '') return row;
    return -1;
  }

  dispose(): void {
    this.replies.clear();
    this.titles.clear();
    this.cwds.clear();
    this.notices.clear();
    this.terminal.dispose();
  }

  /** Visible rows with trailing blanks removed; ConPTY paints empty rows with real spaces. */
  private visibleLines(): string[] {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.terminal.rows; row++) {
      lines.push((buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').trimEnd());
    }
    return lines;
  }

  /** `cwd;<nonce>;<path>`: the path may itself contain semicolons. */
  private handleCwd(data: string): boolean {
    const match = /^cwd;([A-Za-z0-9_-]+);(.+)$/s.exec(data);
    if (!match) return false;
    this.cwds.emit({ nonce: match[1]!, path: match[2]! });
    return true;
  }

  private handleNotice(notice: Notice | undefined): boolean {
    if (!notice) return false;
    this.notices.emit(notice);
    return true;
  }
}
