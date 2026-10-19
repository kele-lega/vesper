import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseOrigin, runtimePackages, startScript, taskXml, type PackageManifest } from '../src/deploy-plan.js';

const DUMP = 'For Each entry In env : WScript.Echo entry : Next';

describe('deploy plan', () => {
  test('accepts an https origin and refuses anything that could break the start script', () => {
    expect(parseOrigin(' https://vesper.example.com/ ')).toBe('https://vesper.example.com');
    expect(parseOrigin('https://a.b:8443')).toBe('https://a.b:8443');
    for (const bad of ['http://a.b', 'https://a.b/path', 'https://a"b', 'https://a.b,https://c.d', '']) expect(() => parseOrigin(bad)).toThrow();
  });

  test('follows dependencies from the hoisted node_modules, skipping nested ones and the UI bundle', () => {
    const root = 'R';
    const tree: Record<string, PackageManifest> = {
      [join(root, 'node_modules', '@vesper/web')]: { dependencies: { '@vesper/ptyd': '0', ws: '1' } },
      [join(root, 'node_modules', '@vesper/cli')]: { dependencies: { '@vesper/web': '0' } },
      [join(root, 'node_modules', '@vesper/ui')]: { dependencies: { react: '19' } },
      [join(root, 'node_modules', '@vesper/ptyd')]: { dependencies: { 'node-pty': '1' }, optionalDependencies: { koffi: '3' } },
      [join(root, 'node_modules', 'ws')]: {},
      [join(root, 'node_modules', 'koffi')]: {},
      [join(root, 'node_modules', 'node-pty')]: { dependencies: { 'node-addon-api': '7' } },
      [join(root, 'node_modules', 'node-pty', 'node_modules', 'node-addon-api')]: {},
    };
    expect(runtimePackages(root, (dir) => tree[dir])).toEqual(['@vesper/cli', '@vesper/ptyd', '@vesper/ui', '@vesper/web', 'koffi', 'node-pty', 'ws']);
    // An optional dependency npm did not install (another platform's binary) is skipped.
    delete tree[join(root, 'node_modules', 'koffi')];
    expect(runtimePackages(root, (dir) => tree[dir])).not.toContain('koffi');
    delete tree[join(root, 'node_modules', 'ws')];
    expect(() => runtimePackages(root, (dir) => tree[dir])).toThrow(/ws/);
  });

  test('the start script runs node hidden with the home, origins and log file', () => {
    const script = startScript({ installDir: 'C:\\Program Files\\Vesper', node: 'C:\\Program Files\\nodejs\\node.exe', home: 'C:\\Users\\u\\.vesper', origins: ['https://a.b'] });
    expect(script).toContain('env("VESPER_ORIGINS") = "https://a.b"');
    expect(script).toContain('env("VESPER_LOG_FILE") = "C:\\Users\\u\\.vesper\\logs\\web.log"');
    expect(script).toContain('shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Program Files\\Vesper\\node_modules\\@vesper\\web\\dist\\main.js""", 0, False');
  });

  test.runIf(process.platform === 'win32')('the start script scrubs what a normal session could plant, then sets its own values', { timeout: 20_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'vesper-vbs-'));
    try {
      // The real script with its last line swapped for a dump of the environment it would start node with.
      const script = startScript({ installDir: dir, node: 'C:\\n\\node.exe', home: 'C:\\h', origins: ['https://a.b'] }).replace(/shell\.Run .*/, DUMP);
      writeFileSync(join(dir, 'start.vbs'), script);
      const planted = { NODE_OPTIONS: '--require C:\\evil.js', node_path: 'C:\\evil', VESPER_UI_DIST: 'C:\\evil', SystemRoot: 'C:\\evil', ComSpec: 'C:\\evil\\cmd.exe', KEEP_ME: 'yes' };
      const out = execFileSync('cscript.exe', ['//Nologo', join(dir, 'start.vbs')], { env: { ...process.env, ...planted }, encoding: 'utf8', windowsHide: true });
      const env = new Map(out.split(/\r?\n/).filter(Boolean).map((line) => [line.slice(0, line.indexOf('=', 1)).toUpperCase(), line.slice(line.indexOf('=', 1) + 1)]));
      expect(env.has('NODE_OPTIONS') || env.has('NODE_PATH') || env.has('VESPER_UI_DIST')).toBe(false);
      expect(env.get('SYSTEMROOT')).toMatch(/^[A-Z]:\\Windows$/i);
      expect(env.get('COMSPEC')).toMatch(/^[A-Z]:\\Windows\\System32\\cmd\.exe$/i);
      expect(env.get('WS_NO_BUFFER_UTIL')).toBe('1');
      expect(env.get('VESPER_ORIGINS')).toBe('https://a.b');
      expect(env.get('KEEP_ME')).toBe('yes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the task XML escapes the user and script path', () => {
    const task = taskXml('PC\\a&b', 'C:\\Windows\\System32\\wscript.exe', 'C:\\V\\start.vbs');
    expect(task).toContain('<UserId>PC\\a&amp;b</UserId>');
    expect(task).toContain('<Arguments>//B //Nologo &quot;C:\\V\\start.vbs&quot;</Arguments>');
    expect(task).toContain('<RunLevel>HighestAvailable</RunLevel>');
    expect(task).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
  });
});
