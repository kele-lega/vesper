import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.js';

interface Props {
  passwordSet: boolean;
  onLoggedIn: () => void;
}

export function Login({ passwordSet, onLoggedIn }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = '登录 · Vesper';
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', '/api/login', { password });
      onLoggedIn();
    } catch (failure) {
      setPassword('');
      const retry = failure instanceof ApiError && failure.retryAfterS ? `（${failure.retryAfterS} 秒后再试）` : '';
      setError(failure instanceof ApiError ? `${failure.message}${retry}` : '连不上服务器');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <h1>Vesper</h1>
        {passwordSet ? (
          <>
            <label htmlFor="password">密码</label>
            <input id="password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
            <button type="submit" disabled={busy || password === ''}>
              登录
            </button>
          </>
        ) : (
          <p>还没有设置密码。请在运行 Vesper 的电脑上执行 <code>npm run set-password</code>，然后刷新本页。</p>
        )}
        <p className="error" role="alert">
          {error}
        </p>
      </form>
    </main>
  );
}
