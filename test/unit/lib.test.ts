import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  COLLECTIONS,
  DEFAULT_COLLECTIONS,
  DEFAULT_PAGE_SIZE,
  FivetranError,
  MAX_PAGE_SIZE,
  buildRow,
  buildTestRow,
  errorMessage,
  getFivetranSettings,
  isConfigured,
  isRetryable,
  pageSize,
  parseEventType,
  postRows,
  sign,
  syncedCollections,
} from "../../functions/lib/fivetran";
import { SETTINGS, WEBHOOK_URL, jsonResponse, sentBody } from "../helpers/fixtures";

describe("getFivetranSettings", () => {
  it("returns the fivetran settings group", async () => {
    const swell = { settings: vi.fn().mockResolvedValue({ fivetran: { webhook_url: "x" } }) } as any;
    expect(await getFivetranSettings(swell)).toEqual({ webhook_url: "x" });
  });

  it("returns an empty object when settings are missing", async () => {
    const swell = { settings: vi.fn().mockResolvedValue(null) } as any;
    expect(await getFivetranSettings(swell)).toEqual({});
  });
});

describe("isConfigured", () => {
  it("accepts an https URL", () => {
    expect(isConfigured({ webhook_url: ` ${WEBHOOK_URL} ` })).toBe(true);
  });

  it.each([undefined, "", "   ", "not a url", "http://webhooks.fivetran.com/x"])("rejects %s", (url) => {
    expect(isConfigured({ webhook_url: url })).toBe(false);
  });
});

describe("syncedCollections", () => {
  it("defaults to orders, accounts and products", () => {
    expect(syncedCollections({})).toEqual(DEFAULT_COLLECTIONS);
  });

  it("drops unknown collections", () => {
    expect(syncedCollections({ collections: ["orders", "bogus", "refunds"] })).toEqual(["orders", "refunds"]);
  });

  it("allows an empty selection", () => {
    expect(syncedCollections({ collections: [] })).toEqual([]);
  });
});

describe("pageSize", () => {
  it("defaults when unset or invalid", () => {
    expect(pageSize({})).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSize({ backfill_page_size: 0 })).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSize({ backfill_page_size: -5 })).toBe(DEFAULT_PAGE_SIZE);
  });

  it("caps at the maximum and floors decimals", () => {
    expect(pageSize({ backfill_page_size: 10000 })).toBe(MAX_PAGE_SIZE);
    expect(pageSize({ backfill_page_size: 25.7 })).toBe(25);
  });
});

describe("parseEventType", () => {
  it("parses standard events", () => {
    expect(parseEventType("order.updated")).toEqual({ collection: "orders", action: "updated" });
    expect(parseEventType("category.deleted")).toEqual({ collection: "categories", action: "deleted" });
  });

  it("parses child collection events", () => {
    expect(parseEventType("payment.refund.created")).toEqual({ collection: "refunds", action: "created" });
  });

  it("parses custom events", () => {
    expect(parseEventType("payment.succeeded")).toEqual({ collection: "payments", action: "succeeded" });
  });

  it.each([undefined, "", "order", ".created", "review.created"])("returns null for %s", (type) => {
    expect(parseEventType(type)).toBeNull();
  });

  it("maps every collection's event root back to it", () => {
    for (const [id, def] of Object.entries(COLLECTIONS)) {
      expect(parseEventType(`${def.event}.created`)?.collection).toBe(id);
    }
  });
});

describe("buildRow", () => {
  it("builds the envelope", () => {
    const row = buildRow("store_1", "orders", "created", { id: "o1", number: "1001" }, "evt_1");
    expect(row).toMatchObject({
      event_id: "evt_1",
      store_id: "store_1",
      collection: "orders",
      event: "created",
      record_id: "o1",
      data: { id: "o1", number: "1001" },
    });
    expect(new Date(row.sent_at).toString()).not.toBe("Invalid Date");
  });

  it("allows a null record", () => {
    expect(buildRow("s", "test", "test", null, "e").record_id).toBeNull();
  });
});

describe("buildTestRow", () => {
  it("builds a test row", () => {
    const row = buildTestRow("store_1");
    expect(row).toMatchObject({
      store_id: "store_1",
      collection: "test",
      event: "test",
      record_id: null,
      data: { message: "Test event from the Swell Fivetran app" },
    });
    expect(row.event_id).toMatch(/^test:\d+$/);
  });
});

describe("sign", () => {
  // RFC 4231 test case 2
  it("computes HMAC SHA-256 as hex", async () => {
    expect(await sign("what do ya want for nothing?", "Jefe")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("computes HMAC SHA-256 as base64", async () => {
    expect(await sign("what do ya want for nothing?", "Jefe", "base64")).toBe(
      "W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=",
    );
  });
});

describe("postRows", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const row = buildRow("s", "orders", "created", { id: "o1" }, "e1");

  it("posts a single row as an object", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));
    expect(await postRows(SETTINGS as any, [row])).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(sentBody(fetchMock)).toMatchObject({ event_id: "e1" });
  });

  it("posts several rows as an array", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await postRows(SETTINGS as any, [row, { ...row, event_id: "e2" }]);
    expect(sentBody(fetchMock)).toHaveLength(2);
  });

  it("does not call Fivetran for no rows", async () => {
    expect(await postRows(SETTINGS as any, [])).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not sign without a secret", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await postRows(SETTINGS as any, [row]);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Fivetran-Signature-256"]).toBeUndefined();
  });

  it("signs the exact body with the configured header and encoding", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await postRows(
      { ...SETTINGS, signing_secret: " s3cret ", signature_header: "X-Sig", signature_encoding: "base64" } as any,
      [row],
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Sig"]).toBe(await sign(init.body as string, "s3cret", "base64"));
  });

  it("uses the default header and hex when not set", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await postRows({ webhook_url: WEBHOOK_URL, signing_secret: "k" }, [row]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Fivetran-Signature-256"]).toBe(
      await sign(init.body as string, "k", "hex"),
    );
  });

  it("throws FivetranError with the status on non-2xx", async () => {
    fetchMock.mockResolvedValue(new Response("bad signature", { status: 401 }));
    const err = await postRows(SETTINGS as any, [row]).catch((e) => e);
    expect(err).toBeInstanceOf(FivetranError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("Fivetran 401: bad signature");
  });

  it("throws when the URL is not configured", async () => {
    await expect(postRows({}, [row])).rejects.toThrow("webhook URL is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isRetryable", () => {
  it.each([
    [500, true],
    [503, true],
    [408, true],
    [429, true],
    [400, false],
    [401, false],
    [404, false],
  ])("status %i is retryable: %s", (status, expected) => {
    expect(isRetryable(new FivetranError("x", status))).toBe(expected);
  });

  it("retries network errors", () => {
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("errorMessage", () => {
  it("reads Error messages and stringifies the rest", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
  });
});
