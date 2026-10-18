// A stand-in for Claude Code in tests: reads the --settings Vesper injects and posts its
// hooks the way Claude does, driven by lines typed into the terminal.
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const settings = JSON.parse(after('--settings') ?? '{"hooks":{}}');
const url = settings.hooks.Stop?.[0]?.hooks?.[0]?.url;
const sessionId = after('--session-id') ?? after('--resume');

const post = (body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sessionId, ...body }) });

console.log(`fake agent ready ${after('--resume') ? 'resumed' : 'new'} ${sessionId}`);
await post({ hook_event_name: 'SessionStart', source: after('--resume') ? 'resume' : 'startup' });
for await (const line of createInterface({ input: process.stdin })) {
  if (line.includes('ask')) {
    await post({ hook_event_name: 'UserPromptSubmit' });
    await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    console.log('asked');
  } else if (line.includes('finish')) {
    await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    await post({ hook_event_name: 'Stop' });
    console.log('finished');
  }
}
