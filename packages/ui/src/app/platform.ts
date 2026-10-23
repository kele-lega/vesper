import { createContext } from 'react';

export interface ServerConfig {
  platform: string;
  defaultCwd: string;
  protocol: number;
}

/** Server platform, not the browser's OS. Undefined keeps platform-specific controls hidden. */
export const ServerPlatform = createContext<string | undefined>(undefined);

export function folderBasename(path: string, platform: string | undefined): string {
  const separator = platform === 'win32' ? /\\+/ : /\/+/;
  return path.split(separator).filter(Boolean).at(-1) || path;
}
