// Collections the app can sync: Swell API path and event root (`order.created` → `order`)
export const COLLECTIONS: Record<string, { path: string; event: string; label: string }> = {
  orders: { path: '/orders', event: 'order', label: 'Orders' },
  accounts: { path: '/accounts', event: 'account', label: 'Customers' },
  products: { path: '/products', event: 'product', label: 'Products' },
  subscriptions: { path: '/subscriptions', event: 'subscription', label: 'Subscriptions' },
  payments: { path: '/payments', event: 'payment', label: 'Payments' },
  refunds: { path: '/payments:refunds', event: 'payment.refund', label: 'Refunds' },
  invoices: { path: '/invoices', event: 'invoice', label: 'Invoices' },
  carts: { path: '/carts', event: 'cart', label: 'Carts' },
  coupons: { path: '/coupons', event: 'coupon', label: 'Coupons' },
  promotions: { path: '/promotions', event: 'promotion', label: 'Promotions' },
  categories: { path: '/categories', event: 'category', label: 'Categories' },
};

export const DEFAULT_COLLECTIONS = ['orders', 'accounts', 'products'];
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_SIGNATURE_HEADER = 'X-Fivetran-Signature-256';

export const ACTIVE_STATUSES = ['pending', 'running'];

export type RowEvent = 'created' | 'updated' | 'deleted' | 'backfill' | 'test';

export interface FivetranSettings {
  webhook_url?: string;
  signing_secret?: string;
  signature_header?: string;
  signature_encoding?: 'hex' | 'base64';
  collections?: string[];
  send_deletes?: boolean;
  backfill_page_size?: number;
  enabled?: boolean;
}

export interface FivetranRow {
  event_id: string;
  store_id: string;
  collection: string;
  event: RowEvent;
  record_id: string | null;
  sent_at: string;
  data: Record<string, any> | null;
}

export class FivetranError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function getFivetranSettings(swell: SwellAPI): Promise<FivetranSettings> {
  const all = await swell.settings();
  return all?.fivetran || {};
}

export function isConfigured(settings: FivetranSettings): boolean {
  const url = settings.webhook_url?.trim();
  if (!url) {
    return false;
  }
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function syncedCollections(settings: FivetranSettings): string[] {
  const selected = Array.isArray(settings.collections) ? settings.collections : DEFAULT_COLLECTIONS;
  return selected.filter((id) => id in COLLECTIONS);
}

export function pageSize(settings: FivetranSettings): number {
  const size = Math.floor(Number(settings.backfill_page_size));
  if (!size || size < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(size, MAX_PAGE_SIZE);
}

// `payment.refund.updated` → { collection: 'refunds', action: 'updated' }
export function parseEventType(type?: string): { collection: string; action: string } | null {
  if (!type) {
    return null;
  }
  const dot = type.lastIndexOf('.');
  if (dot < 1) {
    return null;
  }
  const root = type.slice(0, dot);
  const action = type.slice(dot + 1);
  const collection = Object.keys(COLLECTIONS).find((id) => COLLECTIONS[id].event === root);
  return collection ? { collection, action } : null;
}

export function buildRow(
  storeId: string,
  collection: string,
  event: RowEvent,
  data: Record<string, any> | null,
  eventId: string,
): FivetranRow {
  return {
    event_id: eventId,
    store_id: storeId,
    collection,
    event,
    record_id: data?.id ?? null,
    sent_at: new Date().toISOString(),
    data,
  };
}

export function buildTestRow(storeId: string): FivetranRow {
  return buildRow(storeId, 'test', 'test', { message: 'Test event from the Swell Fivetran app' }, `test:${Date.now()}`);
}

export async function sign(body: string, secret: string, encoding: 'hex' | 'base64' = 'hex'): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  if (encoding === 'base64') {
    return btoa(String.fromCharCode(...bytes));
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// POSTs one row as an object, or several as an array (Fivetran stores one row per array element)
export async function postRows(settings: FivetranSettings, rows: FivetranRow[]): Promise<number> {
  if (!isConfigured(settings)) {
    throw new FivetranError('Fivetran webhook URL is not set or is not an https URL', 400);
  }
  if (!rows.length) {
    return 0;
  }

  const body = JSON.stringify(rows.length === 1 ? rows[0] : rows);
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  const secret = settings.signing_secret?.trim();
  if (secret) {
    const header = settings.signature_header?.trim() || DEFAULT_SIGNATURE_HEADER;
    headers[header] = await sign(body, secret, settings.signature_encoding === 'base64' ? 'base64' : 'hex');
  }

  const res = await fetch(settings.webhook_url!.trim(), { method: 'POST', headers, body });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new FivetranError(`Fivetran ${res.status}: ${text.slice(0, 300) || res.statusText}`, res.status);
  }
  return res.status;
}

// 4xx other than timeout/rate limit means the URL, secret or payload is wrong; retrying won't help
export function isRetryable(err: unknown): boolean {
  if (err instanceof FivetranError) {
    return err.status >= 500 || err.status === 408 || err.status === 429;
  }
  return true;
}

export function errorMessage(err: unknown): string {
  return (err as any)?.message || String(err);
}
