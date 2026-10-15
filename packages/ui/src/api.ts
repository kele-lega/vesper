const TOKEN_KEY = 'vesper-token';

export class UnauthorizedError extends Error {
  override name = 'UnauthorizedError';
}

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Takes the token from a #token=... link once, keeps it in this browser and clears it from the address bar. */
export function captureToken(): void {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!match?.[1]) return;
  localStorage.setItem(TOKEN_KEY, match[1]);
  history.replaceState(null, '', location.pathname + location.search);
}

export function token(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401) throw new UnauthorizedError('需要访问令牌');
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string }).error ?? response.statusText);
  return data as T;
}
