/**
 * Single fetch wrapper.
 *
 * - Base URL controlled via VITE_API_BASE (defaults to "/api" so nginx proxies).
 * - Throws ApiError with .status so the query client can decide whether to retry.
 * - Treats 501 (NotImplemented) as a typed soft-error so pages can render
 *   "Backend incomplete" placeholders gracefully.
 */
import axios, { AxiosError, type AxiosRequestConfig } from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

export const http = axios.create({
  baseURL: API_BASE,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

export class ApiError extends Error {
  status: number;
  body: unknown;
  notImplemented: boolean;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
    this.notImplemented = status === 501;
  }
}

http.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    const status = err.response?.status ?? 0;
    const body = err.response?.data;
    const message =
      (body as { message?: string })?.message ??
      err.message ??
      `HTTP ${status}`;
    return Promise.reject(new ApiError(message, status, body));
  },
);

export async function apiGet<T>(path: string, config?: AxiosRequestConfig): Promise<T> {
  const r = await http.get<T>(path, config);
  return r.data;
}

export async function apiPost<T>(
  path: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const r = await http.post<T>(path, body, config);
  return r.data;
}

export async function apiPatch<T>(
  path: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const r = await http.patch<T>(path, body, config);
  return r.data;
}

export async function apiDelete<T = void>(
  path: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const r = await http.delete<T>(path, config);
  return r.data;
}

/**
 * Wraps an API call so 501 returns `null` instead of throwing.
 * Lets pages render "Backend incomplete" UI gracefully.
 */
export async function softFetch<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.notImplemented) return null;
    throw e;
  }
}
