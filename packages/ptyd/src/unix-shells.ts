import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShellKind } from '@vesper/protocol';
import type { LaunchSpec, ShellOptions, ShellPaths } from './shells.js';

const NONCE_ENV = 'VESPER_CWD_NONCE';

// The nonce is never written to a startup file or left in the exported environment.
const BASH_RC = `__vesper_cwd_nonce=$VESPER_CWD_NONCE
unset VESPER_CWD_NONCE
export -n __vesper_cwd_nonce
if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
elif [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"
fi
__vesper_report_cwd() {
  local __vesper_status=$?
  builtin printf '\\033]7690;cwd;%s;%s\\007' "$__vesper_cwd_nonce" "$PWD"
  return "$__vesper_status"
}
PROMPT_COMMAND+=(__vesper_report_cwd)
`;

const ZSH_ENV = `typeset -g __vesper_cwd_nonce=$VESPER_CWD_NONCE
unset VESPER_CWD_NONCE
typeset +x __vesper_cwd_nonce
typeset -g __vesper_integration_dir=$ZDOTDIR
if [[ $VESPER_ZDOTDIR_SET == 1 ]]; then
  export ZDOTDIR=$VESPER_USER_ZDOTDIR
else
  unset ZDOTDIR
fi
unset VESPER_USER_ZDOTDIR VESPER_ZDOTDIR_SET
if [[ -r \${ZDOTDIR-$HOME}/.zshenv ]]; then source "\${ZDOTDIR-$HOME}/.zshenv"; fi
typeset -g __vesper_user_zdotdir=\${ZDOTDIR-$HOME}
typeset -g __vesper_user_zdotdir_set=\${+ZDOTDIR}
export ZDOTDIR=$__vesper_integration_dir
`;

const ZSH_RC = `if (( __vesper_user_zdotdir_set )); then
  export ZDOTDIR=$__vesper_user_zdotdir
else
  unset ZDOTDIR
fi
if [[ -r \${ZDOTDIR-$HOME}/.zshrc ]]; then source "\${ZDOTDIR-$HOME}/.zshrc"; fi
function __vesper_report_cwd() {
  builtin printf '\\033]7690;cwd;%s;%s\\007' "$__vesper_cwd_nonce" "$PWD"
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __vesper_report_cwd
unset __vesper_integration_dir __vesper_user_zdotdir __vesper_user_zdotdir_set
`;

const FISH_INIT = `set -g -u __vesper_cwd_nonce $VESPER_CWD_NONCE
set -e VESPER_CWD_NONCE
function __vesper_report_cwd --on-event fish_prompt
  builtin printf '\\033]7690;cwd;%s;%s\\007' "$__vesper_cwd_nonce" "$PWD"
end`;

/** Startup files live in the private session directory; user startup files are never changed. */
export function unixShellLaunchSpec(kind: ShellKind, paths: ShellPaths, options: ShellOptions): LaunchSpec {
  const env = { [NONCE_ENV]: options.cwdNonce };
  const file = paths.unix?.[kind as keyof NonNullable<ShellPaths['unix']>] ?? (kind === 'sh' ? '/bin/sh' : kind);
  if (kind === 'sh') return { file, args: ['-i'], env: {} };
  if (kind === 'fish') return { file, args: ['-i', '--init-command', FISH_INIT], env };
  const dir = options.integrationDir;
  if (!dir) throw new Error(`${kind} needs a shell integration directory`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (kind === 'bash') {
    const rc = join(dir, 'bashrc');
    writeFileSync(rc, BASH_RC, { mode: 0o600 });
    return { file, args: ['--rcfile', rc, '-i'], env };
  }
  writeFileSync(join(dir, '.zshenv'), ZSH_ENV, { mode: 0o600 });
  writeFileSync(join(dir, '.zshrc'), ZSH_RC, { mode: 0o600 });
  const original = (options.inherited ?? process.env)['ZDOTDIR'];
  return {
    file,
    args: ['-i'],
    env: { ...env, ZDOTDIR: dir, VESPER_USER_ZDOTDIR: original ?? '', VESPER_ZDOTDIR_SET: original === undefined ? '0' : '1' },
  };
}
