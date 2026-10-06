import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { config } from "../../functions/test-connection";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, jsonResponse, sentBody, settingsMock } from "../helpers/fixtures";

function setup(settings: Record<string, any> = SETTINGS) {
  return createMockRequest({
    data: { $action: { id: "test_connection", source: "settings" } } as any,
    store: { id: "store_1" },
    swell: { settings: settingsMock(settings) },
  });
}

describe("test-connection", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is an action function", () => {
    expect((config as any).action).toBe(true);
  });

  it("sends a test row and reports success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));
    const result: any = await handler(setup());

    expect(result.message).toContain("Fivetran accepted the test event (HTTP 200)");
    expect(sentBody(fetchMock)).toMatchObject({
      store_id: "store_1",
      collection: "test",
      event: "test",
      data: { message: "Test event from the Swell Fivetran app" },
    });
  });

  it("reports Fivetran's error", async () => {
    fetchMock.mockResolvedValue(new Response("signature mismatch", { status: 401 }));
    await expect(handler(setup())).rejects.toThrow("Fivetran rejected the test event: Fivetran 401: signature mismatch");
  });

  it("requires an https webhook URL", async () => {
    await expect(handler(setup({ webhook_url: "http://insecure" }))).rejects.toThrow("Enter an https webhook URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
