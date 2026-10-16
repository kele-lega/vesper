const ENTER = new Set(['\r', '\n']);
const CTRL_C = '\u{3}';
const BACKSPACE = new Set(['\u{7f}', '\b']);

/** Reads one line from the terminal without showing what is typed. */
export function readHidden(prompt: string, input = process.stdin, output = process.stdout): Promise<string> {
  if (!input.isTTY) return Promise.reject(new Error('请在终端窗口里运行：密码需要不回显地输入'));
  output.write(prompt);
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  return new Promise((resolve, reject) => {
    let typed = '';
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(typed);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (ENTER.has(char)) return finish();
        if (char === CTRL_C) return finish(new Error('已取消'));
        typed = BACKSPACE.has(char) ? [...typed].slice(0, -1).join('') : typed + char;
      }
    };
    input.on('data', onData);
  });
}
