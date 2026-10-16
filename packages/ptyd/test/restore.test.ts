import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ScreenMirror } from '../src/mirror.js';
import { SessionFiles } from '../src/persistence.js';
import { appendEndMarker, appendRestoreMarker, loadScreen } from '../src/restore.js';

const fallback = { cols: 40, rows: 5, inc: 7 };
const bytes = (text: string) => Buffer.from(text, 'utf8');

describe('loadScreen', () => {
  const dirs: string[] = [];
  const mirrors: ScreenMirror[] = [];
  const files = (): SessionFiles => {
    const dir = mkdtempSync(join(tmpdir(), 'vesper-restore-'));
    dirs.push(dir);
    return new SessionFiles(dir);
  };
  const load = async (source: SessionFiles) => {
    const screen = await loadScreen(source, fallback, 100);
    mirrors.push(screen.mirror);
    return screen;
  };

  afterEach(() => {
    for (const mirror of mirrors.splice(0)) mirror.dispose();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('gives an empty screen for a session that saved nothing', async () => {
    const screen = await load(files());
    expect(screen).toMatchObject({ inc: 7, seq: 0, hasHistory: false });
    expect([screen.mirror.cols, screen.mirror.rows]).toEqual([40, 5]);
  });

  test('replays the checkpoint and then the output logged after it', async () => {
    const source = files();
    const original = new ScreenMirror({ cols: 30, rows: 4, scrollback: 100 });
    mirrors.push(original);
    original.write('first\r\n');
    await original.flush();
    source.append(2, 0, bytes('first\r\n'), { cols: 30, rows: 4 });
    source.writeCheckpoint({ inc: 2, seq: 7, cols: 30, rows: 4, data: original.serialize(), savedAt: 1 });
    source.append(2, 7, bytes('second'), { cols: 30, rows: 4 });
    source.flush();
    const screen = await load(source);
    expect(screen).toMatchObject({ inc: 2, seq: 13, hasHistory: true });
    expect([screen.mirror.cols, screen.mirror.rows]).toEqual([30, 4]);
    expect(screen.mirror.screenText()).toBe('first\nsecond');
  });

  test('prefers a newer incarnation in the log over an older checkpoint', async () => {
    const source = files();
    source.writeCheckpoint({ inc: 1, seq: 0, cols: 30, rows: 4, data: 'old screen', savedAt: 1 });
    source.append(2, 0, bytes('new output'), { cols: 30, rows: 4 });
    source.flush();
    const screen = await load(source);
    expect(screen).toMatchObject({ inc: 2, seq: 10, hasHistory: true });
    expect(screen.mirror.screenText()).toBe('new output');
  });

  test('resizes at the offset where the size changed', async () => {
    const source = files();
    source.append(1, 0, bytes('x'.repeat(15)), { cols: 20, rows: 3 });
    source.append(1, 15, bytes(`\r\n${'y'.repeat(12)}`), { cols: 10, rows: 3 });
    source.flush();
    const screen = await load(source);
    expect([screen.mirror.cols, screen.mirror.rows]).toEqual([10, 3]);
    // The y's were written at 10 columns, so they wrap; written at 20 they would be one row.
    expect(screen.mirror.screenText().split('\n').slice(1)).toEqual(['y'.repeat(10), 'yy']);
  });

  test('replays a log that has no checkpoint from its oldest byte', async () => {
    const source = files();
    source.append(3, 100, bytes('kept'), { cols: 40, rows: 5 });
    source.flush();
    expect(await load(source)).toMatchObject({ inc: 3, seq: 104, hasHistory: true });
  });
});

describe('appendRestoreMarker', () => {
  const mirrors: ScreenMirror[] = [];
  const create = () => {
    const mirror = new ScreenMirror({ cols: 40, rows: 5, scrollback: 50 });
    mirrors.push(mirror);
    return mirror;
  };

  afterEach(() => {
    for (const mirror of mirrors.splice(0)) mirror.dispose();
  });

  test('moves the history and a dated separator into scrollback', async () => {
    const mirror = create();
    mirror.write('line1\r\nline2\r\n');
    await mirror.flush();
    await appendRestoreMarker(mirror, new Date(2026, 9, 15, 9, 5));
    expect(mirror.screenText()).toBe('');
    expect(mirror.serialize()).toMatch(/line1[\s\S]*line2[\s\S]*已恢复历史 · 2026-10-15 09:05/);
    mirror.write('PS> ');
    await mirror.flush();
    expect(mirror.screenText()).toBe('PS>');
  });

  test('leaves a full-screen program and its modes behind', async () => {
    const mirror = create();
    mirror.write('shell\r\n\x1b[?1049h\x1b[?2004h\x1b[5;20rvim screen');
    await mirror.flush();
    await appendRestoreMarker(mirror, new Date());
    expect(mirror.alternateScreen).toBe(false);
    const all = mirror.serialize();
    expect(all).toContain('shell');
    expect(all).not.toContain('vim screen');
    mirror.write('a\r\nb\r\nc\r\nd\r\ne\r\nf');
    await mirror.flush();
    expect(mirror.screenText()).toBe('b\nc\nd\ne\nf');
  });

  test('can say why instead of when', async () => {
    const mirror = create();
    mirror.write('line1');
    await mirror.flush();
    await appendRestoreMarker(mirror, '重新启动');
    expect(mirror.serialize()).toMatch(/line1[\s\S]*─ 重新启动 ─/);
  });
});

describe('appendEndMarker', () => {
  test('marks the end below the last line and keeps the screen', async () => {
    const mirror = new ScreenMirror({ cols: 40, rows: 5, scrollback: 50 });
    try {
      mirror.write('claude\r\n\x1b[?1049hfull screen');
      await mirror.flush();
      await appendEndMarker(mirror, 'Vesper 重启，程序已结束');
      expect(mirror.alternateScreen).toBe(false);
      expect(mirror.screenText()).toBe('claude\n──── Vesper 重启，程序已结束 ────');
    } finally {
      mirror.dispose();
    }
  });
});
