const BASE = (import.meta.env.VITE_WORKER_URL || 'http://localhost:8787').replace(/\/$/, '');
const TOKEN_KEY = 'ff_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}

export const login = (email, password) =>
  request('/auth/login', { method: 'POST', body: { email, password }, auth: false });

export const me = () => request('/auth/me');

export const changePassword = (current_password, new_password) =>
  request('/auth/password', { method: 'POST', body: { current_password, new_password } });

export function listings(filters) {
  const p = new URLSearchParams();
  if (filters.source && filters.source !== 'all') p.set('source', filters.source);
  if (filters.categories?.length) p.set('categories', filters.categories.join(','));
  if (filters.minProfit !== '') p.set('min_profit', filters.minProfit);
  if (filters.minRoi !== '') p.set('min_roi', filters.minRoi);
  if (filters.minConfidence !== '') p.set('min_confidence', filters.minConfidence);
  if (filters.maxDistance !== '') p.set('max_distance', filters.maxDistance);
  return request(`/listings?${p}`);
}

export function captured({ source, q } = {}) {
  const p = new URLSearchParams();
  if (source && source !== 'all') p.set('source', source);
  if (q) p.set('q', q);
  const qs = p.toString();
  return request(`/captured${qs ? `?${qs}` : ''}`);
}

export const watchlist = () => request('/watchlist');

export const watch = (listing_id, note) =>
  request('/watchlist', { method: 'POST', body: { listing_id, note } });

export const unwatch = (listing_id) =>
  request('/watchlist', { method: 'POST', body: { listing_id, remove: true } });

export const categories = (source) =>
  request(`/categories${source && source !== 'all' ? `?source=${source}` : ''}`);

export const inventory = () => request('/inventory');
export const calibration = () => request('/calibration');
export const acquire = (payload) => request('/acquisitions', { method: 'POST', body: payload });
export const recordSale = (payload) => request('/sales', { method: 'POST', body: payload });
