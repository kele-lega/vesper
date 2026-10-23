import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepareHome: vi.fn(),
  vesperHome: vi.fn(() => '/home/me/.local/share/vesper'),
  setPassword: vi.fn(async () => ({ ok: true, message: 'password stored' })),
  readHidden: vi.fn(),
}));

vi.mock('@vesper/ptyd/client', () => ({ prepareHome: mocks.prepareHome, vesperHome: mocks.vesperHome }));
vi.mock('@vesper/web/auth', () => ({ webDatabasePath: (home: string) => `${home}/web/vesper.db` }));
vi.mock('../src/deploy.js', () => ({ deploy: vi.fn(), parseDeployArgs: vi.fn(), undeploy: vi.fn() }));
vi.mock('../src/set-password.js', () => ({ setPassword: mocks.setPassword }));
vi.mock('../src/tty-prompt.js', () => ({ readHidden: mocks.readHidden }));

afterEach(() => vi.restoreAllMocks());

test('protects the data home before the first password database is created', async () => {
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'vesper', 'set-password']);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  await import('../src/main.js');

  expect(mocks.prepareHome).toHaveBeenCalledWith('/home/me/.local/share/vesper');
  expect(mocks.setPassword).toHaveBeenCalledWith('/home/me/.local/share/vesper/web/vesper.db', expect.any(Function));
  expect(mocks.prepareHome.mock.invocationCallOrder[0]).toBeLessThan(mocks.setPassword.mock.invocationCallOrder[0]!);
});
