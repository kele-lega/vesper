import { createRoot } from 'react-dom/client';
import { App } from './app/App.js';
import './app/app.css';

/** xterm measures the cell size when a terminal opens, so the font must be ready first. */
const FONT = '16px "Cascadia Mono"';

void document.fonts
  .load(FONT)
  .catch(() => undefined)
  .then(() => createRoot(document.getElementById('root')!).render(<App />));
