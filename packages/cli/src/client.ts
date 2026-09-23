import type { CliIo } from './types.js';

/** server 错误响应统一是 { error: string }；网络层失败由调用方兜住 */
export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * 薄壳请求：拼 base + path、带 Bearer（PANEFLOW_TOKEN，R4.1 远程模式用）、
 * 默认超时 15s（慢端点按调用方显式放宽）；非 2xx 时把 server 的 error 字段原样抛出——CLI 不自造判据。
 */
export async function request<T = unknown>(
  io: CliIo,
  baseUrl: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  timeoutMs = 15_000,
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const token = io.env.PANEFLOW_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await io.fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    const msg = (parsed as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new ApiError(`${method} ${path} → ${res.status}: ${msg}`, res.status);
  }
  return { status: res.status, body: parsed as T };
}
