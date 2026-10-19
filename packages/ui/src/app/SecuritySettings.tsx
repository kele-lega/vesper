import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';

interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  lastIp: string;
}

interface AuditEntry {
  id: number;
  at: number;
  kind: string;
  device: string | null;
  ip: string;
  detail: string;
}

const KIND_LABELS: Record<string, string> = {
  login: '登录',
  login_failed: '登录失败',
  logout: '退出登录',
  device_revoked: '注销设备',
  session_created: '新建会话',
  session_closed: '关闭会话',
  session_taken_over: '接管会话',
};

const time = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false });
const message = (failure: unknown) => (failure instanceof ApiError ? failure.message : '操作失败');

/** The logged-in devices (each can be signed out) and the audit log. */
export function SecuritySettings() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [current, setCurrent] = useState('');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState('');

  const loadDevices = () =>
    api<{ current: string; devices: Device[] }>('GET', '/api/devices').then(
      (reply) => {
        setDevices(reply.devices);
        setCurrent(reply.current);
      },
      (failure: unknown) => setError(message(failure)),
    );
  useEffect(() => void loadDevices(), []);
  useEffect(() => {
    if (showLog) void api<{ entries: AuditEntry[] }>('GET', '/api/audit').then((reply) => setEntries(reply.entries), (failure: unknown) => setError(message(failure)));
  }, [showLog]);

  const names = new Map(devices.map((device) => [device.id, device.name]));
  const revoke = (device: Device) => {
    if (!confirm(`注销“${device.name}”（${device.lastIp}）？它需要重新输入密码才能登录。`)) return;
    setError('');
    void api('DELETE', `/api/devices/${encodeURIComponent(device.id)}`).then(loadDevices, (failure: unknown) => setError(message(failure)));
  };

  return (
    <section>
      <h2>已登录的设备</h2>
      <ul className="profile-list">
        {devices.map((device) => (
          <li key={device.id}>
            <span className="profile-name">
              {device.name}
              {device.id === current && <span className="badge">这台设备</span>}
            </span>
            <span className="muted">
              {device.lastIp} · 最近使用 {time(device.lastSeenAt)} · 登录于 {time(device.createdAt)}
            </span>
            <span className="spacer" />
            {device.id !== current && (
              <button type="button" onClick={() => revoke(device)}>
                注销
              </button>
            )}
          </li>
        ))}
      </ul>
      <h2>审计日志</h2>
      <button type="button" onClick={() => setShowLog(!showLog)}>
        {showLog ? '收起' : '查看最近 200 条'}
      </button>
      {showLog && (
        <table className="audit">
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="mono">{time(entry.at)}</td>
                <td>{KIND_LABELS[entry.kind] ?? entry.kind}</td>
                <td className="mono">{entry.ip}</td>
                <td>{entry.device ? (names.get(entry.device) ?? entry.device) : ''}</td>
                <td className="mono">{entry.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="error" role="alert">
        {error}
      </p>
    </section>
  );
}
