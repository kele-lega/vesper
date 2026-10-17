import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { win32 } from 'node:path';
import { HostApiError, HOST_PROTOCOL_VERSION, isRecord, SESSION_ID_PATTERN, type FolderListing, type WebSettings } from '@vesper/protocol';
import { log } from '@vesper/ptyd/client';
import type { ControlHub } from './control-hub.js';
import { FolderError, listFolders, localDrives, localFolder, type FolderErrorCode } from './folders.js';
import type { NoticeStore } from './notice-store.js';
import { fromDetail, ProfileInputError, toDetail } from './profile-edit.js';
import type { ProfileStore } from './profile-store.js';
import { ProjectError, type ProjectErrorCode, type ProjectStore } from './project-store.js';
import type { SettingsStore } from './settings-store.js';
import type { HostSupervisor } from './supervisor.js';
import { TabError, type TabStore } from './tab-store.js';

/**
 * The REST API behind the login: projects, tabs (each a ptyd session), the folder
 * picker and the current state. Every change is also pushed to /ws/control.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RouteDeps {
  settings: SettingsStore;
  supervisor: Pick<HostSupervisor, 'control'>;
  hub: ControlHub;
  projects: ProjectStore;
  tabs: TabStore;
  profiles: ProfileStore;
  notices: NoticeStore;
  /** The local drives; replaced in tests. */
  drives?: () => string[];
}

export interface RouteRequest {
  body: () => Promise<unknown>;
  query: URLSearchParams;
}

export type Reply = [number, unknown];
type Handle = (deps: RouteDeps, request: RouteRequest, params: string[]) => Promise<Reply> | Reply;

const MAX_FOLDER_NAME = 100;
const MAX_IDS = 1000;
/** Names Windows reserves for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const PROJECT_STATUS: Record<ProjectErrorCode, number> = { bad_name: 400, bad_path: 400, bad_order: 400, duplicate: 409, not_found: 404 };
const FOLDER_STATUS: Record<FolderErrorCode, number> = { bad_path: 400, not_found: 404, denied: 403 };

/** A folder name for a new project, or undefined when the name cannot be one. */
export function folderName(name: string): string | undefined {
  const folder = name
    .trim()
    .replace(/[<>:"/\\|?*\u{0}-\u{1f}]/gu, '_')
    .replace(/[. ]+$/, '');
  if (folder === '' || [...folder].length > MAX_FOLDER_NAME || RESERVED.test(folder)) return undefined;
  return folder;
}

const ROUTES: [string, RegExp, Handle][] = [
  ['GET', /^\/api\/config$/, (deps) => [200, { defaultCwd: deps.settings.defaultCwd(), protocol: HOST_PROTOCOL_VERSION }]],
  ['GET', /^\/api\/state$/, (deps) => [200, deps.hub.state()]],
  ['GET', /^\/api\/sessions$/, async (deps) => [200, { sessions: await (await deps.supervisor.control()).list() }]],
  ['GET', /^\/api\/sessions\/([^/]+)$/, getSession],
  ['GET', /^\/api\/folders$/, folders],
  ['POST', /^\/api\/projects$/, createProject],
  ['PUT', /^\/api\/projects\/order$/, reorderProjects],
  ['PATCH', /^\/api\/projects\/([^/]+)$/, renameProject],
  ['DELETE', /^\/api\/projects\/([^/]+)$/, removeProject],
  ['POST', /^\/api\/tabs$/, createTab],
  ['PUT', /^\/api\/tabs\/order$/, reorderTabs],
  ['PATCH', /^\/api\/tabs\/([^/]+)$/, renameTab],
  ['POST', /^\/api\/tabs\/([^/]+)\/restart$/, restartTab],
  ['DELETE', /^\/api\/tabs\/([^/]+)$/, closeTab],
  ['POST', /^\/api\/notices\/read$/, readNotices],
  ['GET', /^\/api\/profiles$/, (deps) => [200, { profiles: deps.profiles.list().map(toDetail) }]],
  ['POST', /^\/api\/profiles$/, createProfile],
  ['PUT', /^\/api\/profiles\/order$/, reorderProfiles],
  ['PATCH', /^\/api\/profiles\/([^/]+)$/, updateProfile],
  ['DELETE', /^\/api\/profiles\/([^/]+)$/, removeProfile],
  ['GET', /^\/api\/settings$/, (deps) => [200, { defaultCwd: deps.settings.defaultCwd() } satisfies WebSettings]],
  ['PATCH', /^\/api\/settings$/, updateSettings],
];

/** The reply for an API path, or undefined when no route has it. */
export async function route(deps: RouteDeps, method: string, path: string, request: RouteRequest): Promise<Reply | undefined> {
  let known = false;
  for (const [wanted, pattern, handle] of ROUTES) {
    const match = pattern.exec(path);
    if (!match) continue;
    known = true;
    if (wanted === method) return handle(deps, request, match.slice(1).map(id));
  }
  if (known) throw new HttpError(405, 'method not allowed');
  return undefined;
}

/** HTTP status and message for an error a route threw; undefined for errors this module does not own. */
export function routeErrorStatus(error: unknown): [number, string] | undefined {
  if (error instanceof HttpError) return [error.status, error.message];
  if (error instanceof ProfileInputError) return [400, error.message];
  if (error instanceof ProjectError) return [PROJECT_STATUS[error.code], error.message];
  if (error instanceof TabError) return [error.code === 'not_found' ? 404 : 400, error.message];
  if (error instanceof FolderError) return [FOLDER_STATUS[error.code], error.message];
  return undefined;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) throw new HttpError(400, 'invalid id');
  return value;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS) throw new HttpError(400, 'expected a list of ids');
  return value.map(id);
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be text`);
  return value;
}

async function object(request: RouteRequest): Promise<Record<string, unknown>> {
  const body = await request.body();
  if (!isRecord(body)) throw new HttpError(400, 'expected a JSON object');
  return body;
}

function drivesOf(deps: RouteDeps): string[] {
  return (deps.drives ?? localDrives)();
}

async function getSession(deps: RouteDeps, _: RouteRequest, [sessionId]: string[]): Promise<Reply> {
  const session = (await (await deps.supervisor.control()).list()).find((entry) => entry.id === sessionId);
  if (!session) throw new HttpError(404, 'no such session');
  return [200, { session }];
}

async function folders(deps: RouteDeps, request: RouteRequest): Promise<Reply> {
  const path = request.query.get('path');
  const drives = drivesOf(deps);
  if (path === null || path === '') {
    const listing: FolderListing = { path: null, parent: null, folders: drives.map((drive) => ({ name: drive, path: drive })), truncated: false };
    return [200, listing];
  }
  return [200, await listFolders(path, drives)];
}

async function createProject(deps: RouteDeps, request: RouteRequest): Promise<Reply> {
  const body = await object(request);
  const name = text(body.name, 'name');
  if (body.path !== undefined) {
    const path = text(body.path, 'path');
    if (!(await localFolder(path, drivesOf(deps)))) throw new HttpError(400, '不是本机磁盘上的文件夹');
    return created(deps, deps.projects.create(name, path));
  }
  const folder = folderName(name);
  if (!folder) throw new HttpError(400, '这个名字不能用作文件夹名');
  const path = win32.join(deps.settings.defaultCwd(), folder);
  if (existsSync(path)) throw new HttpError(409, `文件夹 ${path} 已经存在，请选择“已有文件夹”`);
  mkdirSync(path);
  try {
    return created(deps, deps.projects.create(name, path));
  } catch (error) {
    rmdirSync(path); // still empty: it was made just now
    throw error;
  }
}

function created(deps: RouteDeps, project: ReturnType<ProjectStore['create']>): Reply {
  deps.hub.projectsChanged();
  return [201, { project }];
}

async function reorderProjects(deps: RouteDeps, request: RouteRequest): Promise<Reply> {
  deps.projects.reorder(ids((await object(request)).ids));
  deps.hub.projectsChanged();
  return [200, {}];
}

async function renameProject(deps: RouteDeps, request: RouteRequest, [projectId]: string[]): Promise<Reply> {
  const project = deps.projects.rename(projectId!, text((await object(request)).name, 'name'));
  deps.hub.projectsChanged();
  return [200, { project }];
}

/** Closes the project's sessions, then forgets the project; its folder stays. */
async function removeProject(deps: RouteDeps, _: RouteRequest, [projectId]: string[]): Promise<Reply> {
  if (!deps.projects.get(projectId!)) throw new HttpError(404, 'no such project');
  const control = await deps.supervisor.control();
  for (const tab of deps.tabs.list().filter((entry) => entry.projectId === projectId)) {
    await control.remove(tab.sessionId).catch((error: unknown) => {
      if (!(error instanceof HostApiError && error.code === 'not_found')) throw error;
    });
  }
  deps.projects.remove(projectId!);
  deps.hub.projectsChanged();
  deps.hub.tabsChanged();
  return [200, {}];
}

async function createTab(deps: RouteDeps, request: RouteRequest): Promise<Reply> {
  const body = await object(request);
  const projectId = body.projectId === null ? null : id(body.projectId);
  const project = projectId === null ? undefined : deps.projects.get(projectId);
  if (projectId !== null && !project) throw new HttpError(404, 'no such project');
  const profileId = id(body.profileId);
  const options = deps.profiles.createOptions(profileId);
  if (!options) throw new HttpError(404, 'no such profile, or it cannot start');
  const session = await (await deps.supervisor.control()).create({ ...options, cwd: project?.path ?? deps.settings.defaultCwd() });
  deps.tabs.place(session.id, projectId, profileId);
  deps.hub.tabsChanged();
  log.info(`opened ${options && 'shell' in options ? options.shell : 'a command'} tab ${session.id}`);
  return [201, { session }];
}

async function reorderTabs(deps: RouteDeps, request: RouteRequest): Promise<Reply> {
  const body = await object(request);
  deps.tabs.reorder(body.projectId === null ? null : id(body.projectId), ids(body.sessionIds));
  deps.hub.tabsChanged();
  return [200, {}];
}

async function renameTab(deps: RouteDeps, request: RouteRequest, [sessionId]: string[]): Promise<Reply> {
  const tab = deps.tabs.rename(sessionId!, text((await object(request)).name, 'name'));
  deps.hub.tabsChanged();
  return [200, { tab }];
}

async function restartTab(deps: RouteDeps, _: RouteRequest, [sessionId]: string[]): Promise<Reply> {
  return [200, { session: await (await deps.supervisor.control()).restart(sessionId!) }];
}

/** Ends the session and closes its tab; a tab whose session is already gone just closes. */
async function closeTab(deps: RouteDeps, _: RouteRequest, [sessionId]: string[]): Promise<Reply> {
  try {
    await (await deps.supervisor.control()).remove(sessionId!);
  } catch (error) {
    if (!(error instanceof HostApiError && error.code === 'not_found')) throw error;
    deps.tabs.remove(sessionId!);
    deps.hub.tabsChanged();
  }
  return [200, {}];
}

async function createProfile(deps: RouteDeps, request: RouteRequest): Promise<Reply> {
  const profile = deps.profiles.add({ ...fromDetail(await request.body()), source: 'user', wtGuid: null });
  deps.hub.profilesChanged();
  return [201, { profile: toDetail(profile) }];
}

async function updateProfile(deps: RouteDeps, request: RouteRequest, [profileId]: string[]): Promise<Reply> {
  const before = deps.profiles.get(profileId!);
  if (!before) throw new HttpError(404, 'no such profile');
  const profile = deps.profiles.update(profileId!, fromDetail(await request.body(), before));
  deps.hub.profilesChanged();
  return [200, { profile: profile && toDetail(profile) }];
}

async function removeProfile(deps: RouteDeps, _: RouteRequest, [profileId]: string[]): Promise<Reply> {
  if (!deps.profiles.remove(profileId!)) throw new HttpError(404, 'no such profile');
  deps.hub.profilesChanged();
  return [200, {}];
}

async function reorderProfiles(deps: RouteDeps, request: RouteRequest): Promise<Reply> {
  if (!deps.profiles.reorder(ids((await object(request)).ids))) throw new HttpError(400, 'the order must list every profile once');
  deps.hub.profilesChanged();
  return [200, {}];
}

async function updateSettings(deps: RouteDeps, request: RouteRequest): Promise<Reply> {
  const body = await object(request);
  if (body.defaultCwd !== undefined) {
    const folder = await localFolder(text(body.defaultCwd, 'defaultCwd'), drivesOf(deps));
    if (!folder) throw new HttpError(400, '不是本机磁盘上的文件夹');
    deps.settings.setDefaultCwd(folder);
  }
  return [200, { defaultCwd: deps.settings.defaultCwd() } satisfies WebSettings];
}

/** Body: {ids: number[]}, {session}, or {all: true}. Read on one device is read on all. */
async function readNotices(deps: RouteDeps, request: RouteRequest): Promise<Reply> {
  const body = await object(request);
  let selector: Parameters<NoticeStore['markRead']>[0];
  if (body.all === true) selector = { all: true };
  else if (body.session !== undefined) selector = { session: id(body.session) };
  else if (Array.isArray(body.ids) && body.ids.length <= MAX_IDS && body.ids.every((entry) => Number.isSafeInteger(entry))) {
    selector = { ids: body.ids as number[] };
  } else throw new HttpError(400, 'expected ids, a session or all');
  if (deps.notices.markRead(selector)) deps.hub.noticesChanged();
  return [200, {}];
}
