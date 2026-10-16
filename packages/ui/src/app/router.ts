import { useSyncExternalStore } from 'react';
import { parseRoute, type Route } from './routes.js';

const listeners = new Set<() => void>();
window.addEventListener('popstate', () => listeners.forEach((listener) => listener()));

export function navigate(path: string, replace = false): void {
  if (`${location.pathname}${location.search}` === path) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const current = () => `${location.pathname}${location.search}`;

export function useRoute(): Route {
  const url = new URL(useSyncExternalStore(subscribe, current), location.origin);
  return parseRoute(url.pathname, url.search);
}
