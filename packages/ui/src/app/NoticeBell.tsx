import type { ControlState } from '@vesper/protocol';
import { useState } from 'react';
import { askNotificationPermission, markRead, noticeTarget, openNotice, setSound, soundOn } from './notices.js';

const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });

/** The bell at the top right: unread notices from every project, newest first. */
export function NoticeBell({ state }: { state: ControlState }) {
  const [open, setOpen] = useState(false);
  const [sound, setSoundState] = useState(soundOn);
  const unread = state.notices;

  const toggle = () => {
    askNotificationPermission();
    setOpen(!open);
  };
  const toggleSound = () => {
    setSound(!sound);
    setSoundState(!sound);
  };

  return (
    <div className="menu-anchor bell">
      <button type="button" className="bell-button" aria-haspopup="menu" aria-expanded={open} onClick={toggle} aria-label={`提醒，${unread.length} 条未读`}>
        🔔{unread.length > 0 && <span className="bell-count">{unread.length > 99 ? '99+' : unread.length}</span>}
      </button>
      {open && (
        <div className="menu notices" role="menu" onMouseLeave={() => setOpen(false)}>
          <div className="notices-head">
            <span>提醒</span>
            <span className="spacer" />
            <button type="button" onClick={toggleSound}>
              {sound ? '提示音：开' : '提示音：关'}
            </button>
            <button type="button" disabled={unread.length === 0} onClick={() => markRead({ all: true })}>
              全部已读
            </button>
          </div>
          {unread.length === 0 && <p className="muted notices-empty">没有未读提醒</p>}
          <ul>
            {unread.map((notice) => {
              const target = noticeTarget(state, notice);
              return (
                <li key={notice.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className="notice"
                    onClick={() => {
                      openNotice(state, notice);
                      setOpen(false);
                    }}
                  >
                    <span className="notice-place">{target?.place ?? '已关闭的标签'}</span>
                    <span className="notice-time muted">{time.format(notice.at)}</span>
                    <span className="notice-body">{[notice.title, notice.body].filter(Boolean).join(' — ')}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
