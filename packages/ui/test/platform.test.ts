import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/app/router.js', () => ({ navigate: vi.fn() }));
import { ServerPlatform, folderBasename } from '../src/app/platform.js';
import { ProfileForm } from '../src/app/Settings.js';
import { TabBar } from '../src/app/TabBar.js';

const form = (platform: string) => renderToStaticMarkup(createElement(ServerPlatform.Provider, { value: platform }, createElement(ProfileForm, { profile: undefined, onClose: () => undefined, onSaved: () => undefined })));

describe('server platform UI', () => {
  test('Unix profile editor offers Unix shells and no Windows permission UI', () => {
    const html = form('linux');
    expect(html).toContain('value="bash"');
    expect(html).toContain('value="zsh"');
    expect(html).toContain('value="fish"');
    expect(html).toContain('value="sh"');
    expect(html).toContain('/bin/sh');
    expect(html).not.toMatch(/管理员|普通权限|cmd\.exe|powershell|Git Bash/);
  });

  test('Windows profile editor keeps its shells and elevation controls', () => {
    const html = form('win32');
    expect(html).toContain('Windows PowerShell');
    expect(html).toContain('cmd.exe');
    expect(html).toContain('管理员');
    expect(html).toContain('普通权限');
  });

  test('Linux profile menus hide even a legacy admin badge', () => {
    const html = renderToStaticMarkup(createElement(ServerPlatform.Provider, { value: 'linux' }, createElement(TabBar, {
      tabs: [], active: undefined, profiles: [{ id: 'p', name: 'Bash', shell: 'bash', agent: null, elevation: 'admin' }], status: '',
      onSelect: () => undefined, onClose: () => undefined, onRename: () => undefined, onReorder: () => undefined, onNew: () => undefined,
      canWorktree: false, onHome: () => undefined, bell: null,
    })));
    expect(html).not.toContain('管理员');
  });

  test('default project names respect server path separators, including POSIX backslashes', () => {
    expect(folderBasename('/home/me/my-project/', 'linux')).toBe('my-project');
    expect(folderBasename('/home/me/back\\slash', 'linux')).toBe('back\\slash');
    expect(folderBasename('D:\\code\\project\\', 'win32')).toBe('project');
  });
});
