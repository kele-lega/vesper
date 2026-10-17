import type { ControlMessage, ControlState, HostEvent, NoticeInfo, ProfileInfo, SessionInfo, TabInfo } from '@vesper/protocol';
import { log, type ControlClient } from '@vesper/ptyd/client';
import type { WebSocket } from 'ws';
import type { NoticeStore } from './notice-store.js';
import type { ProfileStore } from './profile-store.js';
import type { ProjectStore } from './project-store.js';
import type { TabStore } from './tab-store.js';

/** A page that leaves this much unread is dropped; it reconnects and starts from a snapshot. */
const MAX_BUFFERED = 8 << 20;
const OPEN = 1;
const CLOSE_POLICY = 1008;

/** Every socket opened under a login, so logging out (or a new password) closes them all. */
export class DeviceSockets {
  private readonly sockets = new Map<WebSocket, string>();

  get size(): number {
    return this.sockets.size;
  }

  track(ws: WebSocket, device: string): void {
    this.sockets.set(ws, device);
    ws.once('close', () => this.sockets.delete(ws));
  }

  closeDevice(device: string): void {
    this.closeUnless((other) => other !== device);
  }

  /** Closes every socket whose device fails `stillLoggedIn`. */
  closeUnless(stillLoggedIn: (device: string) => boolean): void {
    for (const [ws, device] of [...this.sockets]) {
      if (stillLoggedIn(device)) continue;
      this.sockets.delete(ws);
      ws.close(CLOSE_POLICY, 'logged out');
    }
  }
}

export interface HubStores {
  projects: ProjectStore;
  tabs: TabStore;
  profiles: ProfileStore;
  notices: NoticeStore;
}

/**
 * /ws/control: every page gets a snapshot of projects, tabs, sessions and profiles,
 * then each change. Sessions come from vesper-ptyd's events; a new connection to
 * the host lists them again and gives any session without a tab one (in the
 * project its directory belongs to), so sessions made in M1 or elsewhere appear.
 */
export class ControlHub {
  private readonly pages = new Set<WebSocket>();
  private sessions = new Map<string, SessionInfo>();
  private hostOnline = false;

  constructor(private readonly stores: HubStores) {}

  /** Follows a new connection to the host: lists its sessions and then its events. */
  async adopt(client: ControlClient): Promise<void> {
    const early: HostEvent[] = [];
    let listed = false;
    client.onEvent((event) => (listed ? this.hostEvent(event) : early.push(event)));
    client.onClose(() => this.setHost(false));
    const sessions = await client.list();
    // Events that raced the list are applied after it; the window is the list's round trip.
    this.sessions = new Map(sessions.map((entry) => [entry.id, entry]));
    this.stores.tabs.sync(sessions, (cwd) => this.stores.projects.forDirectory(cwd)?.id);
    listed = true;
    for (const event of early) this.hostEvent(event);
    this.hostOnline = true;
    this.broadcast(this.snapshot());
  }

  accept(ws: WebSocket): void {
    this.pages.add(ws);
    ws.on('close', () => this.pages.delete(ws));
    ws.on('error', () => ws.terminate());
    ws.on('message', () => undefined); // pages only listen; changes go through the REST API
    this.send(ws, this.snapshot());
  }

  projectsChanged(): void {
    this.broadcast({ type: 'projects', projects: this.stores.projects.list() });
  }

  tabsChanged(): void {
    this.broadcast({ type: 'tabs', tabs: this.tabInfos() });
  }

  profilesChanged(): void {
    this.broadcast({ type: 'profiles', profiles: this.profileInfos() });
  }

  session(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  noticesChanged(): void {
    this.broadcast({ type: 'notices', notices: this.stores.notices.unread() });
  }

  private notify(notice: Omit<NoticeInfo, 'id'>): void {
    this.broadcast({ type: 'notice', notice: this.stores.notices.add(notice) });
  }

  private exitNotice(session: SessionInfo): void {
    const tab = this.stores.tabs.get(session.id);
    const name = tab?.name || session.title;
    const code = session.exitCode === null ? '' : `，退出码 ${session.exitCode}`;
    this.notify({ session: session.id, kind: 'exit', title: name, body: `程序已结束${code}`, at: Date.now() });
  }

  private hostEvent(event: HostEvent): void {
    switch (event.event) {
      case 'session': {
        const before = this.sessions.get(event.session.id);
        this.sessions.set(event.session.id, event.session);
        this.broadcast({ type: 'session', session: event.session });
        // Only a change seen live: sessions that ended while nobody watched were never "running" here.
        if (before?.status === 'running' && event.session.status === 'exited') this.exitNotice(event.session);
        return;
      }
      case 'removed':
        this.sessions.delete(event.session);
        this.stores.tabs.remove(event.session);
        this.stores.notices.forget(event.session);
        this.broadcast({ type: 'removed', session: event.session });
        this.tabsChanged();
        return this.noticesChanged();
      case 'notice': {
        const { session, title, body, at } = event;
        return this.notify({ session, kind: 'osc', title, body, at });
      }
    }
  }

  private setHost(online: boolean): void {
    if (this.hostOnline === online) return;
    this.hostOnline = online;
    this.broadcast({ type: 'host', online });
  }

  /** Everything a page is shown, as of now. */
  state(): ControlState {
    return {
      projects: this.stores.projects.list(),
      tabs: this.tabInfos(),
      sessions: [...this.sessions.values()],
      profiles: this.profileInfos(),
      notices: this.stores.notices.unread(),
      hostOnline: this.hostOnline,
    };
  }

  private snapshot(): ControlMessage {
    return { type: 'snapshot', ...this.state() };
  }

  private tabInfos(): TabInfo[] {
    return this.stores.tabs.list().map(({ sessionId, projectId, profileId, name, position }) => ({ sessionId, projectId, profileId, name, position }));
  }

  /** What pages may know about profiles: never the command line or environment, which may hold keys. */
  private profileInfos(): ProfileInfo[] {
    return this.stores.profiles.list().map(({ id, name, launch, agent, elevation }) => ({ id, name, shell: 'shell' in launch ? launch.shell : null, agent, elevation }));
  }

  private broadcast(message: ControlMessage): void {
    if (this.pages.size === 0) return;
    const text = JSON.stringify(message);
    for (const ws of this.pages) this.sendText(ws, text);
  }

  private send(ws: WebSocket, message: ControlMessage): void {
    this.sendText(ws, JSON.stringify(message));
  }

  private sendText(ws: WebSocket, text: string): void {
    if (ws.readyState !== OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      log.warn('dropping a control page that does not read');
      ws.terminate();
      return;
    }
    ws.send(text);
  }
}
