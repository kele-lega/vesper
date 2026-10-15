/**
 * Stops the browser terminal from answering terminal queries.
 *
 * The pty host's headless mirror is the only party that answers them. With several
 * browsers attached, each would otherwise send its own reply, and the shell would read
 * the duplicates as typed input.
 */

interface Disposable {
  dispose(): void;
}

interface FunctionId {
  prefix?: string;
  intermediates?: string;
  final: string;
}

/** The parser API shared by the browser and headless builds of xterm.js. */
export interface QueryParser {
  registerCsiHandler(id: FunctionId, handler: (params: (number | number[])[]) => boolean): Disposable;
  registerDcsHandler(id: FunctionId, handler: (data: string, params: (number | number[])[]) => boolean): Disposable;
  registerOscHandler(ident: number, handler: (data: string) => boolean): Disposable;
}

const swallow = () => true;
const DSR_QUERIES = new Set([5, 6]);
const DYNAMIC_COLOUR_OSCS = [10, 11, 12];

/** Returns a function that removes the guard. */
export function guardTerminalQueries(parser: QueryParser): () => void {
  const disposables = [
    parser.registerCsiHandler({ final: 'c' }, swallow), // DA1
    parser.registerCsiHandler({ prefix: '>', final: 'c' }, swallow), // DA2
    parser.registerCsiHandler({ final: 'n' }, (params) => DSR_QUERIES.has(Number(params[0] ?? 0))), // DSR
    parser.registerCsiHandler({ prefix: '?', final: 'n' }, swallow), // DEC DSR
    parser.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow), // DECRQM, ANSI modes
    parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow), // DECRQM, DEC modes
    parser.registerCsiHandler({ prefix: '>', final: 'q' }, swallow), // XTVERSION
    parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow), // DECRQSS
    ...DYNAMIC_COLOUR_OSCS.map((ident) => parser.registerOscHandler(ident, (data) => data.split(';').every((part) => part === '?'))),
    parser.registerOscHandler(4, isPaletteQuery),
  ];
  return () => {
    for (const disposable of disposables) disposable.dispose();
  };
}

/** True when every index;spec pair of an OSC 4 payload asks for a colour instead of setting one. */
function isPaletteQuery(data: string): boolean {
  const parts = data.split(';');
  if (parts.length < 2 || parts.length % 2 !== 0) return false;
  return parts.every((part, i) => (i % 2 === 0 ? /^\d+$/.test(part) : part === '?'));
}
