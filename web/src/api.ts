import type { ApiProblem } from './types';

export class ApiError extends Error {
  constructor(message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError('本地 API 未返回 JSON，请确认漫画服务已启动。', `HTTP_${response.status}`);
  }
  const data = await response.json();
  if (!response.ok) {
    throw new ApiError(data.error?.message ?? `请求失败（HTTP ${response.status}）`, data.error?.code, data.error?.details);
  }
  return data as T;
}

export function send<T>(path: string, method: 'POST' | 'PUT', body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function problem(error: unknown): ApiProblem {
  if (error instanceof ApiError) return { message: error.message, code: error.code, details: error.details };
  return { message: error instanceof Error ? `无法完成请求：${error.message}` : '无法连接本地服务。' };
}

export function projectUrl(id: string): string {
  return `/api/projects/${encodeURIComponent(id)}`;
}

export function fileUrl(id: string, path: string): string {
  return `${projectUrl(id)}/files/${path.split('/').map(encodeURIComponent).join('/')}`;
}
