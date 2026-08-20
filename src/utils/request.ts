import axios from 'axios';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import { readJson, writeJson } from './storage';

interface ApiResponse<T> {
  code: number;
  msg?: string;
  data: T;
}

const configuredBaseUrl = String(import.meta.env.VITE_API_BASE_URL ?? '').trim();
const configuredTimeout = Number(import.meta.env.VITE_API_TIMEOUT ?? 5000);

export const isRemoteApiEnabled = configuredBaseUrl.length > 0;

const service: AxiosInstance = axios.create({
  baseURL: configuredBaseUrl || undefined,
  timeout: Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 5000,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const unwrapResponse = <T>(payload: unknown): T => {
  if (isRecord(payload) && typeof payload.code === 'number' && 'data' in payload) {
    const response = payload as unknown as ApiResponse<T>;
    if (response.code !== 200) {
      throw new Error(response.msg || `API request failed with code ${response.code}`);
    }
    return response.data;
  }

  return payload as T;
};

/**
 * Makes a remote request only when VITE_API_BASE_URL is configured.
 * Callers that require offline fallback should normally use tryRemoteRequest.
 */
export async function requestRemote<T>(config: AxiosRequestConfig): Promise<T> {
  if (!isRemoteApiEnabled) {
    throw new Error('Remote API is disabled because VITE_API_BASE_URL is not configured.');
  }

  const response = await service.request<unknown>(config);
  return unwrapResponse<T>(response.data);
}

/** Remote failures are represented by `undefined` so local-first callers never roll back. */
export async function tryRemoteRequest<T>(
  config: AxiosRequestConfig,
): Promise<T | undefined> {
  if (!isRemoteApiEnabled) return undefined;

  try {
    return await requestRemote<T>(config);
  } catch {
    return undefined;
  }
}

/**
 * Compatibility helper for read requests: successful remote data refreshes the
 * canonical cache; otherwise the safely parsed cached value is returned.
 */
export async function requestWithFallback<T>(
  config: AxiosRequestConfig,
  storageKey: string,
  validate?: (value: unknown) => value is T,
): Promise<T> {
  const remote = await tryRemoteRequest<unknown>(config);
  if (remote !== undefined && (!validate || validate(remote))) {
    writeJson(storageKey, remote);
    return remote as T;
  }

  const cached = readJson<unknown>(storageKey, undefined);
  if (cached !== undefined && (!validate || validate(cached))) {
    return cached as T;
  }

  throw new Error(`No valid remote or cached data is available for ${storageKey}.`);
}

export default service;
