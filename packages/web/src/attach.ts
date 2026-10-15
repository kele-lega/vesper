/**
 * Attaches one client connection to a session: the screen snapshot first, then exactly the
 * output the snapshot does not contain (by byte offset), and the exit frame last.
 */
import type { Frame } from '@vesper/protocol';

export interface AttachableSession {
  onOutput(listener: (chunk: { seq: number; data: Uint8Array }) => void): () => void;
  /** Calls the listener once with the exit code, also when the session has already exited. */
  onExit(listener: (code: number) => void): () => void;
  snapshot(): Promise<{ seq: number; cols: number; rows: number; data: string }>;
}

export interface AttachPeer {
  send(frame: Frame): void;
  /** Ends the connection after the exit frame, so a reconnect cannot silently start a new shell. */
  close(): void;
}

const encoder = new TextEncoder();

/** Returns a function that detaches the client; nothing is sent after it is called. */
export function attachClient(session: AttachableSession, peer: AttachPeer): () => void {
  let attached = true;
  let liveFrom: number | undefined;
  const early: { seq: number; data: Uint8Array }[] = [];
  let exitCode: number | undefined;

  const sendExit = (code: number) => {
    peer.send({ type: 'exit', code });
    peer.close();
  };

  // Listen before taking the snapshot so no output falls between the two.
  const stopOutput = session.onOutput((chunk) => {
    if (liveFrom === undefined) early.push(chunk);
    else if (chunk.seq >= liveFrom) peer.send({ type: 'output', ...chunk });
  });
  const stopExit = session.onExit((code) => {
    if (liveFrom === undefined) exitCode = code;
    else sendExit(code);
  });

  void session.snapshot().then((snapshot) => {
    if (!attached) return;
    peer.send({ type: 'snapshot', seq: snapshot.seq, cols: snapshot.cols, rows: snapshot.rows, data: encoder.encode(snapshot.data) });
    liveFrom = snapshot.seq;
    for (const chunk of early.splice(0)) if (chunk.seq >= snapshot.seq) peer.send({ type: 'output', ...chunk });
    if (exitCode !== undefined) sendExit(exitCode);
  });

  return () => {
    attached = false;
    early.length = 0;
    stopOutput();
    stopExit();
  };
}
