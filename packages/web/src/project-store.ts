import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { pathsFor } from './platform.js';
import { inTransaction } from './web-db.js';

export interface Project {
  id: string;
  name: string;
  /** Absolute directory, normalized with this server's path rules. */
  path: string;
  position: number;
  createdAt: number;
}

export type ProjectErrorCode = 'bad_name' | 'bad_path' | 'duplicate' | 'not_found' | 'bad_order';

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const MAX_NAME = 100;
const MAX_PATH = 32_767;
const DRIVE_PATH = /^[A-Za-z]:\\/;
const CONTROL = /[\u{0}-\u{1f}\u{7f}]/u;
const COLUMNS = 'id, name, path, position, created_at AS createdAt';

/** Projects: named folders that group tabs. Removing one never touches the folder itself. */
export class ProjectStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  list(): Project[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM projects ORDER BY position, created_at`).all() as unknown as Project[];
  }

  get(id: string): Project | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM projects WHERE id = ?`).get(id) as Project | undefined;
  }

  create(name: string, path: string): Project {
    const project: Project = {
      id: randomBytes(12).toString('base64url'),
      name: projectName(name),
      path: projectPath(path, this.platform),
      position: 0,
      createdAt: this.now(),
    };
    return inTransaction(this.db, () => {
      const collation = this.platform === 'win32' ? 'NOCASE' : 'BINARY';
      if (this.db.prepare(`SELECT 1 FROM projects WHERE path = ? COLLATE ${collation}`).get(project.path)) throw new ProjectError('duplicate', 'this folder is already a project');
      const { next } = this.db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM projects').get() as { next: number };
      const created = { ...project, position: next };
      this.db.prepare('INSERT INTO projects (id, name, path, position, created_at) VALUES (?, ?, ?, ?, ?)').run(created.id, created.name, created.path, created.position, created.createdAt);
      return created;
    });
  }

  rename(id: string, name: string): Project {
    const result = this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(projectName(name), id);
    if (result.changes === 0) throw new ProjectError('not_found', 'no such project');
    return this.get(id)!;
  }

  /** `ids` must list every project exactly once, in the new order. */
  reorder(ids: readonly string[]): void {
    inTransaction(this.db, () => {
      const known = new Set(this.list().map((project) => project.id));
      if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
        throw new ProjectError('bad_order', 'the order must list every project once');
      }
      const update = this.db.prepare('UPDATE projects SET position = ? WHERE id = ?');
      ids.forEach((id, position) => update.run(position, id));
    });
  }

  /** Forgets the project and its tabs; the folder and the sessions are left to the caller. */
  remove(id: string): void {
    if (this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes === 0) throw new ProjectError('not_found', 'no such project');
  }

  /** The project whose folder is the deepest one containing `directory`. */
  forDirectory(directory: string): Project | undefined {
    const windows = this.platform === 'win32';
    const canonical = (path: string) => windows ? path.toLowerCase() : path;
    const wanted = canonical(normalized(directory, this.platform));
    const separator = pathsFor(this.platform).sep;
    let best: Project | undefined;
    for (const project of this.list()) {
      const base = canonical(project.path);
      const inside = wanted === base || wanted.startsWith(base.endsWith(separator) ? base : `${base}${separator}`);
      if (inside && (!best || project.path.length > best.path.length)) best = project;
    }
    return best;
  }
}

function projectName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '' || [...trimmed].length > MAX_NAME || CONTROL.test(trimmed)) throw new ProjectError('bad_name', `a project name needs 1 to ${MAX_NAME} characters`);
  return trimmed;
}

function projectPath(path: string, platform: NodeJS.Platform): string {
  const absolute = platform === 'win32' ? DRIVE_PATH.test(path) && !path.includes(':', 2) : path.startsWith('/');
  if (path.length > MAX_PATH || !absolute || CONTROL.test(path)) throw new ProjectError('bad_path', 'not an absolute local path');
  return normalized(path, platform);
}

/** Resolves `..` and drops trailing separators, keeping the root's separator. */
function normalized(path: string, platform: NodeJS.Platform): string {
  const paths = pathsFor(platform);
  const resolved = paths.resolve(path);
  return resolved === paths.parse(resolved).root ? resolved : resolved.replace(platform === 'win32' ? /\\+$/ : /\/+$/, '');
}
