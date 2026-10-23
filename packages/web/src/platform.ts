import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** Only Windows uses drive letters, case-folded paths and restricted-token elevation. */
export function pathsFor(platform: NodeJS.Platform = process.platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Search absolute PATH entries only: never accidentally discover an agent in web's current folder. */
export function findExecutable(
  name: string,
  path: string,
  platform: NodeJS.Platform = process.platform,
  executable: (path: string) => boolean = isExecutable,
): string | undefined {
  const paths = pathsFor(platform);
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const entry of path.split(platform === 'win32' ? ';' : ':')) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (!paths.isAbsolute(directory)) continue;
    for (const suffix of suffixes) {
      const candidate = paths.join(directory, `${name}${suffix}`);
      if (executable(candidate)) return candidate;
    }
  }
  return undefined;
}
