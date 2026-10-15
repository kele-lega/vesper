/** Windows Terminal's default Campbell scheme, using xterm.js theme key names (magenta = WT "purple"). */
export const CAMPBELL = {
  background: '#0C0C0C',
  foreground: '#CCCCCC',
  cursor: '#FFFFFF',
  cursorAccent: '#0C0C0C',
  selectionBackground: '#FFFFFF',
  selectionForeground: '#0C0C0C',
  black: '#0C0C0C',
  red: '#C50F1F',
  green: '#13A10E',
  yellow: '#C19C00',
  blue: '#0037DA',
  magenta: '#881798',
  cyan: '#3A96DD',
  white: '#CCCCCC',
  brightBlack: '#767676',
  brightRed: '#E74856',
  brightGreen: '#16C60C',
  brightYellow: '#F9F1A5',
  brightBlue: '#3B78FF',
  brightMagenta: '#B4009E',
  brightCyan: '#61D6D6',
  brightWhite: '#F2F2F2',
} as const;

const ANSI_ORDER = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;
const CUBE_LEVELS = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];

/** The 256-colour palette as xterm builds it: Campbell's 16 colours, a 6x6x6 cube and a 24-step grey ramp. */
export function palette256(): string[] {
  const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  const rgb = (r: number, g: number, b: number) => `#${hex(r)}${hex(g)}${hex(b)}`;
  const palette: string[] = ANSI_ORDER.map((name) => CAMPBELL[name]);
  for (let i = 0; i < 216; i++) {
    palette.push(rgb(CUBE_LEVELS[Math.floor(i / 36)] ?? 0, CUBE_LEVELS[Math.floor(i / 6) % 6] ?? 0, CUBE_LEVELS[i % 6] ?? 0));
  }
  for (let i = 0; i < 24; i++) {
    const level = 8 + i * 10;
    palette.push(rgb(level, level, level));
  }
  return palette;
}

/** Formats '#RRGGBB' the way xterm answers colour queries: rgb:rrrr/gggg/bbbb. */
export function xtermRgb(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`invalid colour ${hex}`);
  return `rgb:${match.slice(1).map((channel) => channel.toLowerCase().repeat(2)).join('/')}`;
}
