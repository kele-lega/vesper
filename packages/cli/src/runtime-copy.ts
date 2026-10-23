import { cpSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePackages, WORKSPACE_FILES, type PackageManifest } from './deploy-plan.js';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function readManifest(dir: string): PackageManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageManifest;
  } catch {
    return undefined;
  }
}

/** Workspace allowlist only; third-party packages are copied WHOLE, including native binaries,
 * nested dependencies and executable spawn-helper. npm-selected optional platform packages are
 * included by runtimePackages; do not prune build/, prebuilds/, or @koromix/koffi-<platform>. */
export function copyRuntime(dir: string, root = REPO_ROOT): string[] {
  const packages = runtimePackages(root, readManifest);
  for (const name of packages) {
    const source = realpathSync(join(root, 'node_modules', name));
    const target = join(dir, 'node_modules', name);
    const files = WORKSPACE_FILES[name];
    if (!files) {
      cpSync(source, target, { recursive: true, dereference: true });
      continue;
    }
    for (const file of files) {
      if (!existsSync(join(source, file))) throw new Error(`${name} 缺少 ${file}：请先运行 npm run build`);
      cpSync(join(source, file), join(target, file), { recursive: true, dereference: true, filter: (path) => !path.endsWith('.tsbuildinfo') });
    }
  }
  return packages;
}
