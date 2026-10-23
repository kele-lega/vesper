import type { PointerEvent } from 'react';
import type { TerminalKey } from '../input.js';

interface Props {
  disabled: boolean;
  onKey: (key: TerminalKey) => void;
  onKeyboard: () => void;
}

const KEYS: readonly [TerminalKey, string, string][] = [
  ['Escape', 'Esc', 'Esc：退出当前模式'],
  ['Tab', 'Tab', 'Tab：补全或缩进'],
  ['Ctrl+C', 'Ctrl+C', 'Ctrl+C：中断程序'],
  ['Ctrl+D', 'Ctrl+D', 'Ctrl+D：发送 EOF，可能退出 shell'],
  ['Ctrl+Z', 'Ctrl+Z', 'Ctrl+Z：挂起程序'],
  ['Ctrl+L', 'Ctrl+L', 'Ctrl+L：清屏'],
  ['ArrowLeft', '←', '方向键：左'],
  ['ArrowDown', '↓', '方向键：下'],
  ['ArrowUp', '↑', '方向键：上'],
  ['ArrowRight', '→', '方向键：右'],
];

/** A pointer tap must not blur xterm and dismiss the on-screen keyboard. Keyboard clicks remain native. */
function keepFocus(event: PointerEvent<HTMLButtonElement>): void {
  if (event.isPrimary && event.button === 0) event.preventDefault();
}

export function TerminalKeys({ disabled, onKey, onKeyboard }: Props) {
  return (
    <div className="terminal-keys" role="group" aria-label="终端快捷键">
      {KEYS.map(([key, label, description]) => (
        <button type="button" key={key} disabled={disabled} aria-label={description} title={description} onPointerDown={keepFocus} onClick={() => onKey(key)}>
          {label}
        </button>
      ))}
      <button type="button" className="terminal-keyboard" disabled={disabled} aria-label="打开终端键盘" title="打开终端键盘" onPointerDown={keepFocus} onClick={onKeyboard}>
        键盘
      </button>
    </div>
  );
}
