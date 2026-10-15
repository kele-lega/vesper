import { describe, expect, test } from 'vitest';
import { SizeArbiter } from '../src/sizing.js';

const desk = { cols: 200, rows: 50 };
const laptop = { cols: 120, rows: 30 };
const phone = { cols: 50, rows: 20 };

describe('SizeArbiter', () => {
  test('the first device to attach drives the size', () => {
    const arbiter = new SizeArbiter<string>();
    expect(arbiter.attach('desk', desk)).toEqual(desk);
    expect(arbiter.driver).toBe('desk');
  });

  test('a later device does not take over just by attaching', () => {
    const arbiter = new SizeArbiter<string>();
    arbiter.attach('desk', desk);
    expect(arbiter.attach('laptop', laptop)).toBeUndefined();
    expect(arbiter.driver).toBe('desk');
  });

  test('only the driver resizes the session; others are remembered', () => {
    const arbiter = new SizeArbiter<string>();
    arbiter.attach('desk', desk);
    arbiter.attach('laptop', laptop);
    expect(arbiter.resize('laptop', phone)).toBeUndefined();
    expect(arbiter.resize('desk', laptop)).toEqual(laptop);
  });

  test('typing on another device makes it the driver with its own size', () => {
    const arbiter = new SizeArbiter<string>();
    arbiter.attach('desk', desk);
    arbiter.attach('laptop', laptop);
    expect(arbiter.input('desk')).toBeUndefined();
    expect(arbiter.input('laptop')).toEqual(laptop);
    expect(arbiter.driver).toBe('laptop');
    expect(arbiter.input('laptop')).toBeUndefined();
  });

  test('a device that never reported a size takes over without resizing', () => {
    const arbiter = new SizeArbiter<string>();
    arbiter.attach('desk', desk);
    arbiter.attach('script', undefined);
    expect(arbiter.input('script')).toBeUndefined();
    expect(arbiter.driver).toBe('script');
  });

  test('when the driver leaves, whoever typed last drives next', () => {
    const arbiter = new SizeArbiter<string>();
    arbiter.attach('desk', desk);
    arbiter.attach('laptop', laptop);
    arbiter.attach('phone', phone);
    arbiter.input('laptop');
    arbiter.input('desk');
    arbiter.detach('desk');
    expect(arbiter.driver).toBe('laptop');
  });

  test('a driver promoted by a detach gets its size on its first keystroke, then not again', () => {
    const arbiter = new SizeArbiter<string>();
    arbiter.attach('phone', phone);
    arbiter.attach('desk', desk);
    arbiter.detach('phone');
    expect(arbiter.driver).toBe('desk');
    expect(arbiter.input('desk')).toEqual(desk);
    expect(arbiter.input('desk')).toBeUndefined();
  });

  test('a driver promoted by a detach also gets its size when its window resizes', () => {
    const arbiter = new SizeArbiter<string>();
    arbiter.attach('phone', phone);
    arbiter.attach('desk', desk);
    arbiter.detach('phone');
    expect(arbiter.resize('desk', laptop)).toEqual(laptop);
    expect(arbiter.input('desk')).toBeUndefined();
  });

  test('without any typing, the most recent device drives next', () => {
    const arbiter = new SizeArbiter<string>();
    arbiter.attach('desk', desk);
    arbiter.attach('laptop', laptop);
    arbiter.attach('phone', phone);
    arbiter.detach('desk');
    expect(arbiter.driver).toBe('phone');
  });

  test('the last device leaving clears the driver; the next to attach drives', () => {
    const arbiter = new SizeArbiter<string>();
    arbiter.attach('desk', desk);
    arbiter.detach('desk');
    expect(arbiter.driver).toBeUndefined();
    expect(arbiter.attach('laptop', laptop)).toEqual(laptop);
  });

  test('ignores unknown devices and non-driver departures', () => {
    const arbiter = new SizeArbiter<string>();
    arbiter.attach('desk', desk);
    arbiter.attach('laptop', laptop);
    expect(arbiter.resize('ghost', phone)).toBeUndefined();
    expect(arbiter.input('ghost')).toBeUndefined();
    arbiter.detach('laptop');
    arbiter.detach('ghost');
    expect(arbiter.driver).toBe('desk');
  });
});
