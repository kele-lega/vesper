import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { copyRuntime } from '../src/runtime-copy.js';
import { WORKSPACE_FILES } from '../src/deploy-plan.js';

function put(root: string, path: string, value: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

describe('Linux native runtime copying', () => {
  test('keeps node-pty build/Release, executable helper, nested deps and hoisted koffi optional binaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'vesper-copy-'));
    try {
      for (const [name, files] of Object.entries(WORKSPACE_FILES)) {
        const dependencies = name === '@vesper/web' ? { '@vesper/ptyd': '0' } : name === '@vesper/ptyd' ? { 'node-pty': '1.1.0', koffi: '3.3.3' } : {};
        put(root, `node_modules/${name}/package.json`, JSON.stringify({ dependencies }));
        for (const file of files.filter((name) => name !== 'package.json')) put(root, `node_modules/${name}/${file}/fixture.txt`, file);
        put(root, `node_modules/${name}/src/secret.ts`, 'not copied');
      }
      put(root, 'node_modules/node-pty/package.json', JSON.stringify({ dependencies: { 'node-addon-api': '7' } }));
      put(root, 'node_modules/node-pty/build/Release/pty.node', 'linux-native-pty');
      put(root, 'node_modules/node-pty/build/Release/spawn-helper', 'linux-helper');
      put(root, 'node_modules/node-pty/node_modules/node-addon-api/package.json', '{}');
      put(root, 'node_modules/koffi/package.json', JSON.stringify({ optionalDependencies: { '@koromix/koffi-linux-x64': '3.3.3', '@koromix/koffi-win32-x64': '3.3.3' } }));
      put(root, 'node_modules/koffi/build/koffi/linux_x64/koffi.node', 'source-build-fallback');
      put(root, 'node_modules/@koromix/koffi-linux-x64/package.json', '{}');
      put(root, 'node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node', 'linux-native-koffi');
      chmodSync(join(root, 'node_modules/node-pty/build/Release/spawn-helper'), 0o755);
      const target = join(root, 'runtime');
      const packages = copyRuntime(target, root);
      expect(packages).toContain('@koromix/koffi-linux-x64');
      expect(packages).not.toContain('@koromix/koffi-win32-x64');
      expect(packages).not.toContain('node-addon-api');
      expect(readFileSync(join(target, 'node_modules/node-pty/build/Release/pty.node'), 'utf8')).toBe('linux-native-pty');
      expect(readFileSync(join(target, 'node_modules/node-pty/build/Release/spawn-helper'), 'utf8')).toBe('linux-helper');
      expect(existsSync(join(target, 'node_modules/node-pty/node_modules/node-addon-api/package.json'))).toBe(true);
      expect(readFileSync(join(target, 'node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node'), 'utf8')).toBe('linux-native-koffi');
      expect(readFileSync(join(target, 'node_modules/koffi/build/koffi/linux_x64/koffi.node'), 'utf8')).toBe('source-build-fallback');
      expect(existsSync(join(target, 'node_modules/@vesper/web/src'))).toBe(false);
      if (process.platform !== 'win32') expect(statSync(join(target, 'node_modules/node-pty/build/Release/spawn-helper')).mode & 0o111).toBe(0o111);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
