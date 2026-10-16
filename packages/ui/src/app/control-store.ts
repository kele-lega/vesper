import { CONTROL_SOCKET_PATH, WS_TICKET_PREFIX, type ControlMessage, type ControlState, type NoticeInfo } from '@vesper/protocol';
import { UnauthorizedError, wsTicket } from '../api.js';
import { reconnectDelay } from '../stream.js';
import { applyControl } from './control-state.js';

const WS_PROTOCOL = 'vesper.v1';

export type ControlStatus = 'connecting' | 'online' | 'offline' | 'unauthorized';

export interface ControlView {
  state: ControlState | undefined;
  status: ControlStatus;
}

/**
 * The page's link to /ws/control: the server pushes a snapshot of projects, tabs,
 * sessions and profiles, then every change. Reconnects on its own; each new
 * connection starts with a fresh snapshot. Shaped for React's useSyncExternalStore.
 */
export class ControlStore {
  private view: ControlView = { state: undefined, status: 'connecting' };
  private socket: WebSocket | undefined;
  private attempt = 0;
  private stopped = false;
  private readonly listeners = new Set<() => void>();
  private readonly notices = new Set<(notice: NoticeInfo) => void>();

  readonly getSnapshot = (): ControlView => this.view;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onNotice(listener: (notice: NoticeInfo) => void): () => void {
    this.notices.add(listener);
    return () => this.notices.delete(listener);
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket) return;
    let ticket: string;
    try {
      ticket = await wsTicket();
    } catch (error) {
      if (error instanceof UnauthorizedError) return this.update({ status: 'unauthorized' });
      return this.retry();
    }
    if (this.stopped || this.socket) return;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}${CONTROL_SOCKET_PATH}`, [WS_PROTOCOL, WS_TICKET_PREFIX + ticket]);
    this.socket = ws;
    ws.onmessage = (event) => {
      if (this.socket !== ws || typeof event.data !== 'string') return;
      this.receive(event.data);
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.retry();
    };
  }

  private receive(text: string): void {
    let message: ControlMessage;
    try {
      message = JSON.parse(text) as ControlMessage;
    } catch {
      console.warn('ignoring a malformed control message');
      return;
    }
    if (message.type === 'notice') for (const listener of this.notices) listener(message.notice);
    const state = applyControl(this.view.state, message);
    if (message.type === 'snapshot') this.attempt = 0;
    this.update({ state, status: state ? 'online' : this.view.status });
  }

  private retry(): void {
    if (this.stopped) return;
    this.update({ status: 'offline' });
    setTimeout(() => void this.connect(), reconnectDelay(this.attempt++));
  }

  private update(changes: Partial<ControlView>): void {
    this.view = { ...this.view, ...changes };
    for (const listener of this.listeners) listener();
  }
}
