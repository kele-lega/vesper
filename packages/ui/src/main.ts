import { captureToken, token } from './api.js';
import { showPicker, showTokenHelp } from './picker.js';
import { showTerminal } from './terminal-page.js';
import './style.css';

const SESSION_PAGE = /^\/s\/([A-Za-z0-9_-]{1,64})$/;

captureToken();
const sessionId = SESSION_PAGE.exec(location.pathname)?.[1];
if (!token()) showTokenHelp();
else if (sessionId) void showTerminal(sessionId);
else void showPicker();
