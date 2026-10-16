import { describe, expect, test } from 'vitest';
import { parseWtProfiles } from '../src/wt-import.js';

const SETTINGS = String.raw`// Windows Terminal settings, trimmed
{
  "$schema": "https://aka.ms/terminal-profiles-schema",
  "defaultProfile": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}",
  "profiles": {
    "defaults": { "font": { "face": "Cascadia Mono" } },
    "list": [
      { "guid": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}", "name": "Windows PowerShell", "commandline": "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "hidden": false },
      { "guid": "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}", "name": "命令提示符", "commandline": "%SystemRoot%\\System32\\cmd.exe", "hidden": false },
      /* a script launcher: its script is never opened */
      { "guid": "{11111111-2222-3333-4444-555555555555}", "name": "ccswitch-codex-fanren-grok", "commandline": "powershell.exe -NoExit -File \"C:\\Users\\me\\scripts\\ccswitch.ps1\" codex", },
      { "name": "Spaced", "commandline": "\"C:\\Program Files\\Tool\\tool.exe\" --flag" },
      { "guid": "{b453ae62-4e3d-5e58-b989-0a998ec441b8}", "hidden": false, "name": "Azure Cloud Shell", "source": "Windows.Terminal.Azure" },
      { "name": "Hidden one", "commandline": "cmd.exe", "hidden": true },
      { "commandline": "cmd.exe" },
      { "name": "Broken", "commandline": "cmd.exe\r\ndel x" },
    ],
  },
}`;

describe('parseWtProfiles', () => {
  test('imports visible profiles with a command line; plain shells become shells', () => {
    expect(parseWtProfiles(SETTINGS)).toEqual([
      { name: 'Windows PowerShell', guid: '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}', launch: { shell: 'powershell' } },
      { name: '命令提示符', guid: '{0caa0dad-35be-5f56-a8ff-afceeeaa6101}', launch: { shell: 'cmd' } },
      {
        name: 'ccswitch-codex-fanren-grok',
        guid: '{11111111-2222-3333-4444-555555555555}',
        launch: { commandLine: 'powershell.exe -NoExit -File "C:\\Users\\me\\scripts\\ccswitch.ps1" codex' },
      },
      { name: 'Spaced', launch: { commandLine: '"C:\\Program Files\\Tool\\tool.exe" --flag' } },
    ]);
  });

  test('accepts the older form where profiles is a plain list', () => {
    expect(parseWtProfiles('{ "profiles": [ { "name": "cmd", "commandline": "\\"cmd\\"" } ] }')).toEqual([{ name: 'cmd', launch: { shell: 'cmd' } }]);
  });

  test.each(['', 'not json', '[1, 2]', '{ "profiles": 3 }', '{ "profiles": { "list": {} } }'])('returns nothing for %j', (text) => {
    expect(parseWtProfiles(text)).toEqual([]);
  });

  test('bounds what it takes from a profile', () => {
    const long = JSON.stringify({ profiles: [{ name: 'x'.repeat(300), commandline: 'cmd.exe' }, { name: 'y', commandline: `a ${'b'.repeat(9000)}` }] });
    expect(parseWtProfiles(long)).toEqual([{ name: 'x'.repeat(256), launch: { shell: 'cmd' } }]);
  });

  test('does not cut a name inside a surrogate pair', () => {
    const name = `${'x'.repeat(255)}\u{1f600}`;
    expect(parseWtProfiles(JSON.stringify({ profiles: [{ name, commandline: 'cmd.exe' }] }))[0]!.name).toBe('x'.repeat(255));
  });
});
