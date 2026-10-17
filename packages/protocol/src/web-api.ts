/**
 * What vesper-web and the browser exchange besides terminal frames: the REST
 * bodies and the /ws/control push stream that keeps every page up to date.
 */
import type { SessionInfo, ShellKind } from './host-api.js';

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  position: number;
  createdAt: number;
}

export interface TabInfo {
  sessionId: string;
  /** null: not sorted into a project yet. */
  projectId: string | null;
  profileId: string | null;
  /** The user's name for the tab; empty shows the session title. */
  name: string;
  position: number;
}

/** A profile as pages see it. Its command line and environment stay on the server: they may hold secrets. */
export interface ProfileInfo {
  id: string;
  name: string;
  shell: ShellKind | null;
  agent: 'claude' | 'codex' | 'gemini' | null;
  elevation: 'admin' | 'normal';
}

/** osc: the program asked for it (OSC 9 / 777); exit: the program ended. */
export type NoticeKind = 'osc' | 'exit';

export interface NoticeInfo {
  id: number;
  session: string;
  kind: NoticeKind;
  title: string;
  body: string;
  at: number;
}

export interface ControlState {
  projects: ProjectInfo[];
  tabs: TabInfo[];
  sessions: SessionInfo[];
  profiles: ProfileInfo[];
  /** Unread notices, newest first. */
  notices: NoticeInfo[];
  /** Whether vesper-ptyd answers; sessions are stale while it does not. */
  hostOnline: boolean;
}

/** Server-to-page messages on /ws/control: a full state first, then changes. */
export type ControlMessage =
  | ({ type: 'snapshot' } & ControlState)
  | { type: 'projects'; projects: ProjectInfo[] }
  | { type: 'tabs'; tabs: TabInfo[] }
  | { type: 'profiles'; profiles: ProfileInfo[] }
  | { type: 'session'; session: SessionInfo }
  | { type: 'removed'; session: string }
  /** A new notice; pages alert for these. */
  | { type: 'notice'; notice: NoticeInfo }
  /** The unread list after some were read, on any device. */
  | { type: 'notices'; notices: NoticeInfo[] }
  | { type: 'host'; online: boolean };

/**
 * A profile as the settings page edits it (GET/POST/PATCH /api/profiles). Environment values are
 * never sent back; null in an update keeps the stored value.
 */
export interface ProfileDetail {
  id?: string;
  name: string;
  launch: { shell: ShellKind } | { file: string; args: string[] } | { commandLine: string };
  env: Record<string, string | null>;
  agent: ProfileInfo['agent'];
  elevation: ProfileInfo['elevation'];
}

/** GET/PATCH /api/settings. */
export interface WebSettings {
  /** Where new project folders are made, and where tabs outside a project start. */
  defaultCwd: string;
}

/** Folder picker listing (GET /api/folders?path=); without a path, the local drives. */
export interface FolderListing {
  path: string | null;
  parent: string | null;
  folders: { name: string; path: string }[];
  truncated: boolean;
}

/** The control socket path, and the WebSocket subprotocol prefix a one-time ticket travels in. */
export const CONTROL_SOCKET_PATH = '/ws/control';
export const WS_TICKET_PREFIX = 'vesper.ticket.';
