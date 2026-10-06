import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { shouldRun } from "../../functions/backfill-run";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, jsonResponse, sentBody, settingsMock } from "../helpers/fixtures";

const JOB = { id: "job_1", collection: "orders", status: "pending", pages: 0, sent: 0 };

function setup({
  job = JOB as Record<string, any> | null,
  current = undefined as Record<string, any> | null | undefined,
  page = { count: 3, results: [{ id: "a1" }, { id: "a2" }] } as any,
  settings = SETTINGS as Record<string, any>,
  event = { type: "backfill.created", data: {} } as Record<string, any>,
} = {}) {
  let jobReads = 0;
  const get = vi.fn(async (url: string) => {
    if (url === "/backfills/job_1") {
      jobReads++;
      return jobReads === 1 ? job : current === undefined ? job : current;
    }
    return page;
  });
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: { id: "job_1", $event: event } as any,
    store: { id: "store_1" },
    swell: { settings: settingsMock(settings), get, put },
  });
  return { req, get, put };
}

describe("shouldRun", () => {
  it("runs on create", () => {
    expect(shouldRun({ $event: { type: "backfill.created", data: {} } } as any)).toBe(true);
  });

  it("runs when a page was recorded or the job was set to pending", () => {
    expect(shouldRun({ $event: { type: "backfill.updated", data: { pages: 2 } } } as any)).toBe(true);
    expect(shouldRun({ $event: { type: "backfill.updated", data: { status: "pending" } } } as any)).toBe(true);
  });

  it("does not run for other edits", () => {
    expect(shouldRun({ $event: { type: "backfill.updated", data: { date_from: "2026-01-01" } } } as any)).toBe(false);
    expect(shouldRun({ $event: { type: "backfill.updated", data: { status: "canceled" } } } as any)).toBe(false);
    expect(shouldRun({} as any)).toBe(false);
  });
});

describe("backfill-run", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the first page and records progress", async () => {
    const { req, get, put } = setup();
    await handler(req);

    expect(get).toHaveBeenCalledWith("/orders", { where: {}, sort: "id asc", limit: 2 });
    const rows = sentBody(fetchMock);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      event_id: "backfill:job_1:a1",
      collection: "orders",
      event: "backfill",
      record_id: "a1",
      store_id: "store_1",
    });

    expect(put).toHaveBeenCalledWith(
      "/backfills/job_1",
      expect.objectContaining({ status: "running", last_id: "a2", pages: 1, sent: 2, total: 3, last_error: null }),
    );
    expect(put.mock.calls[0][1].date_started).toBeTypeOf("string");
    expect(put.mock.calls[0][1].date_completed).toBeUndefined();
  });

  it("continues after last_id and applies date_from", async () => {
    const job = { ...JOB, status: "running", last_id: "a2", pages: 1, sent: 2, total: 3, date_started: "x", date_from: "2026-01-01" };
    const { req, get, put } = setup({ job, page: { count: 1, results: [{ id: "a3" }] } });
    await handler(req);

    expect(get).toHaveBeenCalledWith("/orders", {
      where: { id: { $gt: "a2" }, date_created: { $gte: "2026-01-01" } },
      sort: "id asc",
      limit: 2,
    });
    const update = put.mock.calls[0][1];
    expect(update).toMatchObject({ status: "completed", last_id: "a3", pages: 2, sent: 3 });
    expect(update.total).toBeUndefined(); // counted on the first page only
    expect(update.date_started).toBeUndefined();
    expect(update.date_completed).toBeTypeOf("string");
  });

  it("completes without calling Fivetran when the page is empty", async () => {
    const job = { ...JOB, status: "running", last_id: "a3", pages: 2, sent: 3 };
    const { req, put } = setup({ job, page: { count: 0, results: [] } });
    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put.mock.calls[0][1]).toMatchObject({ status: "completed", last_id: "a3", pages: 3, sent: 3 });
  });

  it("keeps a cancel made while the page was sending", async () => {
    const { req, put } = setup({ current: { ...JOB, status: "canceled" } });
    await handler(req);

    const update = put.mock.calls[0][1];
    expect(update.status).toBeUndefined();
    expect(update).toMatchObject({ pages: 1, sent: 2 });
  });

  it("does nothing for inactive or missing jobs", async () => {
    for (const job of [{ ...JOB, status: "completed" }, null]) {
      const { req, put } = setup({ job });
      await handler(req);
      expect(put).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing for unrelated edits", async () => {
    const { req, get } = setup({ event: { type: "backfill.updated", data: { date_from: "x" } } });
    await handler(req);
    expect(get).not.toHaveBeenCalled();
  });

  it("fails the job when the app is turned off", async () => {
    const { req, put } = setup({ settings: { ...SETTINGS, enabled: false } });
    await handler(req);
    expect(put.mock.calls[0][1]).toMatchObject({ status: "failed", last_error: "The Fivetran app is turned off in settings" });
  });

  it("fails the job when the webhook URL is missing", async () => {
    const { req, put } = setup({ settings: { ...SETTINGS, webhook_url: "" } });
    await handler(req);
    expect(put.mock.calls[0][1]).toMatchObject({ status: "failed", last_error: "Fivetran webhook URL is not set" });
  });

  it("fails the job for an unknown collection", async () => {
    const { req, put } = setup({ job: { ...JOB, collection: "bogus" } });
    await handler(req);
    expect(put.mock.calls[0][1]).toMatchObject({ status: "failed", last_error: "Unknown collection: bogus" });
  });

  it("fails the job with Fivetran's error and keeps progress", async () => {
    fetchMock.mockResolvedValue(new Response("too large", { status: 413 }));
    const { req, put } = setup();
    await handler(req);

    expect(put).toHaveBeenCalledTimes(1);
    const update = put.mock.calls[0][1];
    expect(update).toMatchObject({ status: "failed", last_error: "Fivetran 413: too large" });
    expect(update.last_id).toBeUndefined();
  });

  it("sends one test row for a connection test job", async () => {
    const { req, get, put } = setup({ job: { ...JOB, collection: "test" } });
    await handler(req);

    expect(get).not.toHaveBeenCalledWith("/test", expect.anything());
    expect(sentBody(fetchMock)).toMatchObject({ collection: "test", event: "test", store_id: "store_1" });
    expect(put.mock.calls[0][1]).toMatchObject({ status: "completed", sent: 1, total: 1, last_error: null });
  });

  it("fails a connection test job with Fivetran's error", async () => {
    fetchMock.mockResolvedValue(new Response("signature mismatch", { status: 401 }));
    const { req, put } = setup({ job: { ...JOB, collection: "test" } });
    await handler(req);
    expect(put.mock.calls[0][1]).toMatchObject({ status: "failed", last_error: "Fivetran 401: signature mismatch" });
  });

  it("uses the refunds child collection path", async () => {
    const { req, get } = setup({ job: { ...JOB, collection: "refunds" } });
    await handler(req);
    expect(get).toHaveBeenCalledWith("/payments:refunds", expect.any(Object));
  });
});
