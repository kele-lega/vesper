import { AuthStore, DEFAULT_COST, hashPassword, openWebDatabase, passwordProblem, type ScryptCost } from '@vesper/web/auth';

export interface Outcome {
  ok: boolean;
  /** For the user; never contains the password. */
  message: string;
}

export type Ask = (prompt: string) => Promise<string>;

/** Asks for the new password twice and stores its hash; every logged-in device has to log in again. */
export async function setPassword(dbPath: string, ask: Ask, cost: ScryptCost = DEFAULT_COST): Promise<Outcome> {
  const password = await ask('新密码：');
  const problem = passwordProblem(password);
  if (problem) return { ok: false, message: problem };
  if ((await ask('再输一次：')) !== password) return { ok: false, message: '两次输入的密码不一致' };
  const hash = await hashPassword(password, cost);
  const db = openWebDatabase(dbPath);
  try {
    new AuthStore(db).setPasswordHash(hash);
  } finally {
    db.close();
  }
  return { ok: true, message: '密码已设置。已登录的设备需要重新登录。' };
}
