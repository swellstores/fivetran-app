import { describe, it, expect, vi } from "vitest";
import handler, { config } from "../../functions/backfill-all";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, settingsMock } from "../helpers/fixtures";
import { COLLECTIONS } from "../../functions/lib/fivetran";

function setup({
  settings = { ...SETTINGS, collections: ["orders", "accounts", "refunds"] } as Record<string, any>,
  active = [] as { collection: string }[],
  data = {} as Record<string, any>,
} = {}) {
  const get = vi.fn().mockResolvedValue({ results: active });
  const post = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: { ...data, $action: { id: "backfill_all", source: "list" } } as any,
    swell: { settings: settingsMock(settings), get, post },
  });
  return { req, get, post };
}

describe("backfill-all", () => {
  it("is an action function", () => {
    expect((config as any).action).toBe(true);
  });

  it("starts a backfill for all collections, not only those selected in settings", async () => {
    const { req, get, post } = setup();
    const result = await handler(req);

    expect(get).toHaveBeenCalledWith("/backfills", {
      where: { status: { $in: ["pending", "running"] } },
      fields: "collection",
      limit: 100,
    });
    expect(post.mock.calls.map((c) => c[1].collection)).toEqual(Object.keys(COLLECTIONS));
    expect(post).toHaveBeenCalledTimes(11);
    expect(post.mock.calls[0][1]).toEqual({ collection: "orders", status: "pending" });
    expect(result).toEqual({
      message:
        "Started backfills for Orders, Customers, Products, Subscriptions, Payments, Refunds, Invoices, Carts, Coupons, Promotions, Categories.",
    });
  });

  it("ignores an empty collection selection", async () => {
    const { req, post } = setup({ settings: { ...SETTINGS, collections: [] } });
    await handler(req);
    expect(post).toHaveBeenCalledTimes(11);
  });

  it("passes date_from from the modal", async () => {
    const { req, post } = setup({ data: { date_from: "2026-01-01T00:00:00.000Z" } });
    await handler(req);
    expect(post.mock.calls[0][1]).toEqual({ collection: "orders", status: "pending", date_from: "2026-01-01T00:00:00.000Z" });
  });

  it("skips collections with an active backfill", async () => {
    const { req, post } = setup({ active: [{ collection: "accounts" }, { collection: "carts" }] });
    const result = await handler(req);

    expect(post).toHaveBeenCalledTimes(9);
    expect(post.mock.calls.map((c) => c[1].collection)).not.toContain("accounts");
    expect(result.message).toMatch(/ Already running: Customers, Carts\.$/);
  });

  it("reports when everything is already running", async () => {
    const { req, post } = setup({ active: Object.keys(COLLECTIONS).map((collection) => ({ collection })) });
    expect(await handler(req)).toEqual({
      message:
        "Already running: Orders, Customers, Products, Subscriptions, Payments, Refunds, Invoices, Carts, Coupons, Promotions, Categories.",
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("requires a webhook URL", async () => {
    const { req } = setup({ settings: { ...SETTINGS, webhook_url: "" } });
    await expect(handler(req)).rejects.toThrow("Set the Fivetran webhook URL");
  });
});
