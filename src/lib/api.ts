export const API_BASE = '/api';
export const API_URL = API_BASE;

// Canonical message shown everywhere in the UI when the API server is not
// reachable. Kept in one place so every page/component fails the same way.
export const SERVER_DOWN_MESSAGE =
  "Can't reach the data server. The API server doesn't seem to be running — start it, then try again.";

export class ApiError extends Error {
  status?: number;
  unreachable: boolean;

  constructor(message: string, status?: number, unreachable = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.unreachable = unreachable;
  }
}

// Reads a response body, tolerating empty or non-JSON bodies (the dev proxy
// replies with empty/HTML error pages when the backend is down).
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The API always answers with JSON. A 502/503/504, or a 5xx without a JSON
// body, means the dev proxy could not reach the backend → server is down.
function isServerDown(res: Response, body: unknown): boolean {
  if (res.ok) return false;
  if (res.status === 502 || res.status === 503 || res.status === 504) return true;
  return res.status >= 500 && body === null;
}

// fetch() wrapper for the local API. Resolves parsed JSON, or throws an
// ApiError with a user-facing message (unreachable = true when the server
// is down, so callers can react specifically to that case).
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, init);
  } catch {
    throw new ApiError(SERVER_DOWN_MESSAGE, undefined, true);
  }

  const body = await readBody(res);

  if (isServerDown(res, body)) {
    throw new ApiError(SERVER_DOWN_MESSAGE, res.status, true);
  }

  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `Request failed (HTTP ${res.status})`;
    throw new ApiError(message, res.status, false);
  }

  return body as T;
}

// Quick liveness probe used by the global server-status banner.
export async function checkServerHealth(timeoutMs = 4000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${API_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    return (await readBody(res)) !== null;
  } catch {
    return false;
  }
}
