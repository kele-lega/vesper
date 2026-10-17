import type { ControlState, NoticeInfo } from '@vesper/protocol';
import { api } from '../api.js';
import { navigate } from './router.js';
import { projectPath } from './routes.js';

const SOUND_KEY = 'vesper-sound';
const BEEP_HZ = 880;
const BEEP_S = 0.12;

/** Where a notice leads, and what to call its tab; undefined once the tab is gone. */
export function noticeTarget(state: ControlState, notice: NoticeInfo): { path: string; place: string } | undefined {
  const tab = state.tabs.find((entry) => entry.sessionId === notice.session);
  if (!tab) return undefined;
  const project = state.projects.find((entry) => entry.id === tab.projectId);
  const session = state.sessions.find((entry) => entry.id === notice.session);
  const title = tab.name || session?.title || '';
  return { path: projectPath(tab.projectId, tab.sessionId), place: `${project?.name ?? '未归类'} · ${title}` };
}

export function markRead(selector: { ids: number[] } | { session: string } | { all: true }): void {
  void api('POST', '/api/notices/read', selector).catch(() => undefined);
}

/** Read it and open its tab. */
export function openNotice(state: ControlState, notice: NoticeInfo): void {
  markRead({ ids: [notice.id] });
  const target = noticeTarget(state, notice);
  if (target) navigate(target.path);
}

/** The page title with the unread count in front, as chat apps do. */
export function titled(title: string, unread: number): string {
  return unread > 0 ? `(${unread}) ${title}` : title;
}

export function soundOn(): boolean {
  return localStorage.getItem(SOUND_KEY) !== 'off';
}

export function setSound(on: boolean): void {
  localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
}

let audio: AudioContext | undefined;

function beep(): void {
  try {
    audio ??= new AudioContext();
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.frequency.value = BEEP_HZ;
    gain.gain.setValueAtTime(0.15, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + BEEP_S);
    tone.connect(gain).connect(audio.destination);
    tone.start();
    tone.stop(audio.currentTime + BEEP_S);
  } catch {
    // no audio device, or the browser has not allowed sound yet
  }
}

/** Asks once, from a click (browsers allow the prompt only then). */
export function askNotificationPermission(): void {
  if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
}

/**
 * Alerts for one new notice: a sound and, while the page is not in view, a system notification.
 * A notice from the tab in front of a visible page is already seen and reads itself instead.
 */
export function alertNotice(state: ControlState, notice: NoticeInfo, activeSession: string | undefined): void {
  const seen = document.visibilityState === 'visible' && document.hasFocus() && notice.session === activeSession;
  if (seen) return markRead({ ids: [notice.id] });
  if (soundOn()) beep();
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  const target = noticeTarget(state, notice);
  const shown = new Notification(notice.title || target?.place || 'Vesper', { body: notice.body, tag: `vesper-${notice.id}` });
  shown.onclick = () => {
    window.focus();
    openNotice(state, notice);
    shown.close();
  };
}

/** The installed app's icon badge, where supported. */
export function setBadge(unread: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  void (unread > 0 ? nav.setAppBadge?.(unread) : nav.clearAppBadge?.())?.catch(() => undefined);
}
