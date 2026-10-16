/** What the vesper CLI needs to manage the login password (`@vesper/web/auth`). */
export { AuthStore } from './auth-store.js';
export { DEFAULT_COST, hashPassword, passwordProblem, verifyPassword, type ScryptCost } from './password.js';
export { openWebDatabase, webDatabasePath } from './web-db.js';
