/**
 * Admin API client. The dashboard only ever talks to `/v1/admin/*` with the operator token (PRD §19, plan §4):
 * it never touches Midnight, never sees an API key secret after creation, and keeps the token in sessionStorage
 * so closing the tab logs the operator out.
 */
const TOKEN_KEY = 'aetherdust.admin-token';
const BASE_KEY = 'aetherdust.api-base';

/** Same-origin by default (nginx proxies /v1 to the api); overridable at build time and by the operator at login. */
export const defaultBase = (): string =>
  (import.meta.env.VITE_AETHERDUST_API_URL as string | undefined)?.replace(/\/$/, '')
  ?? localStorage.getItem(BASE_KEY)
  ?? window.location.origin;

export const getBase = (): string => localStorage.getItem(BASE_KEY) ?? defaultBase();
export const setBase = (base: string): void => { localStorage.setItem(BASE_KEY, base.replace(/\/$/, '')); };
export const getToken = (): string | null => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (token: string | null): void => {
  if (token) sessionStorage.setItem(TOKEN_KEY, token); else sessionStorage.removeItem(TOKEN_KEY);
};

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
  get isAuth(): boolean { return this.status === 401; }
}

export const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${getBase()}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch (e) {
    throw new ApiError(0, 'NETWORK', `cannot reach ${getBase()}: ${(e as Error).message}`);
  }
  const text = await res.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : null;
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(res.status, err.code ?? `HTTP_${res.status}`, err.message ?? res.statusText, err.details);
  }
  return body as T;
};

export const api = {
  overview: (q: { hours: number; bucket: 'hour' | 'day'; recent?: number }) =>
    request<Overview>(`/v1/admin/overview?hours=${q.hours}&bucket=${q.bucket}&recent=${q.recent ?? 20}`),
  applications: () => request<Application[]>('/v1/admin/applications'),
  application: (id: string) => request<ApplicationDetail>(`/v1/admin/applications/${id}`),
  setApplicationStatus: (id: string, status: 'active' | 'suspended') =>
    request<Application>(`/v1/admin/applications/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  createApplication: (name: string) => request<Application>('/v1/admin/applications', { method: 'POST', body: JSON.stringify({ name }) }),
  createApiKey: (id: string, env: 'live' | 'test', label?: string) =>
    request<{ key: ApiKey; token: string }>(`/v1/admin/applications/${id}/api-keys`, { method: 'POST', body: JSON.stringify({ env, label }) }),
  revokeApiKey: (keyId: string) => request<{ revoked: boolean }>(`/v1/admin/api-keys/${keyId}`, { method: 'DELETE' }),
  policy: (id: string) => request<PolicyResponse>(`/v1/admin/applications/${id}/policy`),
  putPolicy: (id: string, document: unknown) =>
    request<{ version: number; document: unknown }>(`/v1/admin/applications/${id}/policy`, { method: 'PUT', body: JSON.stringify(document) }),
  dryRunPolicy: (id: string, document: unknown, limit = 100) =>
    request<DryRun>(`/v1/admin/applications/${id}/policy/dry-run?limit=${limit}`, { method: 'POST', body: JSON.stringify(document) }),
  requests: (id: string, q: { status?: string; user_id?: string; limit?: number }) => {
    const p = new URLSearchParams();
    if (q.status) p.set('status', q.status);
    if (q.user_id) p.set('user_id', q.user_id);
    p.set('limit', String(q.limit ?? 100));
    return request<SponsorshipRequest[]>(`/v1/admin/applications/${id}/requests?${p}`);
  },
  requestDetail: (id: string) => request<SponsorshipRequest & { events: RequestEvent[] }>(`/v1/admin/requests/${id}`),
  usage: (id: string, q: { from?: string; to?: string; bucket: 'hour' | 'day' }) => {
    const p = new URLSearchParams({ bucket: q.bucket });
    if (q.from) p.set('from', q.from);
    if (q.to) p.set('to', q.to);
    return request<Usage>(`/v1/admin/applications/${id}/usage?${p}`);
  },
  wallet: () => request<WalletResponse>('/v1/admin/wallet'),
};

// ---- wire types (snake_case, exactly as the API returns them) ----
export interface Application { id: string; name: string; status: 'active' | 'suspended'; created_at?: string; createdAt?: string }
export interface ApiKey { id: string; keyId?: string; key_id?: string; env: string; label: string | null; status: string; createdAt?: string; lastUsedAt?: string | null }
export interface ApplicationDetail extends Application {
  policy: { version: number; document: Record<string, unknown> } | null;
  keys: ApiKey[];
  counts: Record<string, number>;
  current_period: { start: string; limit_dust: string; settled_dust: string; reserved_dust: string } | null;
}
export interface PolicyResponse {
  active: { version: number; document: Record<string, unknown>; created_at: string } | null;
  versions: { version: number; created_at: string }[];
}
export interface SponsorshipRequest {
  id: string; request_id: string; status: string; internal_status: string; user_id: string;
  contract: string | null; entry_point: string | null; calls: { contract: string; entry_point: string }[];
  transaction_id: string | null; transaction_hash: string | null; user_transaction_hash: string;
  estimated_fee_dust: string | null; reserved_dust: string; sponsored_dust: string | null;
  block_height: number | null; error: { code: string; message: string } | null;
  policy_version: number | null; attempts: number;
  created_at: string; updated_at: string; submitted_at: string | null; confirmed_at: string | null;
}
export interface RequestEvent { id: number; from: string | null; to: string; reason_code: string | null; details: unknown; at: string }
export interface WalletDto {
  adapter: string; network: string; synced: boolean; healthy: boolean;
  dust_balance_dust: string; dust_cap_dust: string | null; night: string | null;
  dust_coins: number; dust_coins_in_flight: number; max_in_flight?: number; detail?: unknown; taken_at?: string;
}
export interface WalletResponse { live: WalletDto | null; snapshot: WalletDto | null }
export interface Overview {
  generated_at: string; adapter: string; network: string;
  window: { from: string; to: string; bucket: 'hour' | 'day' };
  wallet: WalletResponse;
  totals: { applications: number; sponsored_dust: string; confirmed: number; rejected: number; failed: number; pending: number };
  confirmation_latency: { count: number; avg_seconds: number | null; p50_seconds: number | null; p95_seconds: number | null; max_seconds: number | null };
  applications: OverviewApp[];
  rejections: { code: string; count: number }[];
  series: { bucket: string; sponsored_dust: string; count: number }[];
  recent_requests: SponsorshipRequest[];
}
export interface OverviewApp {
  id: string; name: string; status: string; created_at: string;
  policy: { version: number; enabled: boolean; contracts: number } | null;
  period: { kind: string; start: string; end: string } | null;
  budget: { limit_dust: string; settled_dust: string; reserved_dust: string; remaining_dust: string; users: number } | null;
  counts: Record<string, number>;
  sponsored_dust: string;
  confirmed_total: number;
}
export interface Usage {
  window: { from: string; to: string; bucket: 'hour' | 'day' };
  totals: { sponsored_dust: string; confirmed: number; rejected: number; failed: number; pending: number };
  by_contract: { contract: string; sponsored_dust: string; count: number }[];
  by_entry_point: { key: string; sponsored_dust: string; count: number }[];
  by_user: { user_id: string; sponsored_dust: string; count: number }[];
  rejections: { code: string; count: number }[];
  series: { bucket: string; sponsored_dust: string; count: number }[];
}
export interface DryRun {
  evaluated_at: string; sampled: number;
  summary: { would_allow: number; would_reject: number; newly_rejected: number; newly_allowed: number };
  by_reason: { code: string; count: number }[];
  requests: {
    id: string; request_id: string; user_id: string; created_at: string; contract: string | null; entry_point: string | null;
    fee_dust: string | null; was: { status: string; allowed: boolean; code: string | null };
    would: { allowed: boolean; code: string | null; rule: string | null; message: string | null }; changed: boolean;
  }[];
}
