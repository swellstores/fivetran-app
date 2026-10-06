import { vi } from "vitest";

export const WEBHOOK_URL = "https://webhooks.fivetran.com/webhooks/abc-123";

export const SETTINGS = {
  webhook_url: WEBHOOK_URL,
  signature_header: "X-Fivetran-Signature-256",
  signature_encoding: "hex",
  collections: ["orders", "accounts", "products", "payments", "refunds"],
  send_deletes: true,
  backfill_page_size: 2,
  enabled: true,
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// swell.get mock that resolves by exact URL; unknown URLs resolve null
export function routeGet(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => (url in routes ? routes[url] : null));
}

export function settingsMock(settings: Record<string, any> = SETTINGS) {
  return vi.fn().mockResolvedValue({ fivetran: settings });
}

// Parses the JSON body of the nth fetch call
export function sentBody(fetchMock: { mock: { calls: any[][] } }, n = 0) {
  return JSON.parse((fetchMock.mock.calls[n][1] as RequestInit).body as string);
}
