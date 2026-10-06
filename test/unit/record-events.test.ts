import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { config } from "../../functions/record-events";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, jsonResponse, routeGet, sentBody, settingsMock } from "../helpers/fixtures";

const ORDER = { id: "order_1", number: "1001", status: "pending", grand_total: 10 };

function setup({
  type = "order.created",
  eventData = ORDER as Record<string, any>,
  topLevel = { id: "order_1" } as Record<string, any>,
  settings = SETTINGS as Record<string, any>,
  routes = { "/orders/order_1": { ...ORDER, status: "complete" } } as Record<string, unknown>,
} = {}) {
  const get = routeGet(routes);
  const req = createMockRequest({
    data: { ...topLevel, $event: { id: "evt_1", type, data: eventData } } as any,
    store: { id: "store_1" },
    swell: { settings: settingsMock(settings), get },
  });
  return { req, get };
}

describe("record-events", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subscribes to every collection's events", () => {
    const events = (config as any).model.events as string[];
    expect(events).toContain("payment.refund.deleted");
    expect(events).toContain("payment.succeeded");
    expect(events).not.toContain("payment.created");
    expect(events).toHaveLength(33);
  });

  it("sends created records from the event snapshot", async () => {
    const { req, get } = setup();
    await handler(req);

    expect(get).not.toHaveBeenCalled();
    expect(sentBody(fetchMock)).toMatchObject({
      event_id: "evt_1",
      store_id: "store_1",
      collection: "orders",
      event: "created",
      record_id: "order_1",
      data: ORDER,
    });
  });

  it("re-fetches the full record on update", async () => {
    const { req, get } = setup({ type: "order.updated", eventData: { id: "order_1", status: "complete" } });
    await handler(req);

    expect(get).toHaveBeenCalledWith("/orders/order_1");
    expect(sentBody(fetchMock)).toMatchObject({ event: "updated", data: { number: "1001", status: "complete" } });
  });

  it("skips an update when the record no longer exists", async () => {
    const { req } = setup({ type: "order.updated", routes: {} });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends custom payment events as updates of the full payment", async () => {
    const payment = { id: "pay_1", amount: 5, success: true };
    const { req, get } = setup({
      type: "payment.succeeded",
      eventData: { id: "pay_1", success: true },
      topLevel: { id: "pay_1" },
      routes: { "/payments/pay_1": payment },
    });
    await handler(req);

    expect(get).toHaveBeenCalledWith("/payments/pay_1");
    expect(sentBody(fetchMock)).toMatchObject({ collection: "payments", event: "updated", data: payment });
  });

  it("fetches refunds from the payments child collection", async () => {
    const { req, get } = setup({
      type: "payment.refund.updated",
      eventData: { id: "ref_1" },
      topLevel: { id: "ref_1" },
      routes: { "/payments:refunds/ref_1": { id: "ref_1", amount: 3 } },
    });
    await handler(req);

    expect(get).toHaveBeenCalledWith("/payments:refunds/ref_1");
    expect(sentBody(fetchMock)).toMatchObject({ collection: "refunds", record_id: "ref_1" });
  });

  it("sends deletes using the id from the event snapshot", async () => {
    const { req } = setup({ type: "order.deleted", topLevel: {} });
    await handler(req);
    expect(sentBody(fetchMock)).toMatchObject({ event: "deleted", record_id: "order_1", data: ORDER });
  });

  it("skips deletes when turned off", async () => {
    const { req } = setup({ type: "order.deleted", settings: { ...SETTINGS, send_deletes: false } });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends deletes when the setting was never saved", async () => {
    const { send_deletes, ...rest } = SETTINGS;
    const { req } = setup({ type: "order.deleted", settings: rest });
    await handler(req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips collections that are not synced", async () => {
    const { req } = setup({ type: "cart.created", eventData: { id: "cart_1" } });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips when the app is turned off", async () => {
    const { req } = setup({ settings: { ...SETTINGS, enabled: false } });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips and logs when the webhook URL is missing", async () => {
    const { req } = setup({ settings: { ...SETTINGS, webhook_url: "" } });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("ignores unknown event types", async () => {
    const { req } = setup({ type: "review.created" });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a retryable error when Fivetran is down", async () => {
    fetchMock.mockResolvedValue(new Response("down", { status: 503 }));
    const { req } = setup();
    const err: any = await handler(req).catch((e) => e);
    expect(err.name).toBe("SwellError");
    expect(err.message).toBe("Fivetran 503: down");
    expect(err.retry).toBe(true);
  });

  it("throws a non-retryable error on a client error", async () => {
    fetchMock.mockResolvedValue(new Response("bad signature", { status: 401 }));
    const { req } = setup();
    const err: any = await handler(req).catch((e) => e);
    expect(err.retry).toBe(false);
  });
});
