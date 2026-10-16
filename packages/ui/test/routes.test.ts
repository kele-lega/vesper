import { describe, expect, test } from 'vitest';
import { parseRoute, projectPath } from '../src/app/routes.js';

describe('routes', () => {
  test.each([
    ['/', '', { page: 'home' }],
    ['/p/abc', '', { page: 'project', projectId: 'abc' }],
    ['/p/unsorted', '?tab=s1', { page: 'project', projectId: null, sessionId: 's1' }],
    ['/p/abc', '?tab=bad.id', { page: 'project', projectId: 'abc' }],
    ['/s/s1', '', { page: 'session', sessionId: 's1' }],
    ['/p/abc/extra', '', { page: 'home' }],
    ['/p/bad.id', '', { page: 'home' }],
    ['/x/abc', '', { page: 'home' }],
  ])('%s%s', (pathname, search, route) => {
    expect(parseRoute(pathname, search)).toEqual(route);
  });

  test('projectPath round-trips', () => {
    expect(projectPath(null, 's1')).toBe('/p/unsorted?tab=s1');
    expect(parseRoute('/p/p1', '')).toEqual({ page: 'project', projectId: 'p1' });
    expect(projectPath('p1')).toBe('/p/p1');
  });
});
