import { describe, it, expect, vi } from "vitest";
import handler, { config } from "../../functions/backfill-control";
import { createMockRequest } from "../helpers/mock-request";

const ID = "6ac384f3765195001228ed44";

function setup(actionId: string, job: Record<string, any> | null, recordId: string | undefined = ID) {
  const get = vi.fn().mockResolvedValue(job);
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: { $action: { id: actionId, source: "record", record_id: recordId } } as any,
    swell: { get, put },
  });
  return { req, get, put };
}

describe("backfill-control", () => {
  it("is an action function", () => {
    expect((config as any).action).toBe(true);
  });

  it("cancels an active backfill", async () => {
    const { req, get, put } = setup("cancel", { id: ID, status: "running" });
    expect(await handler(req)).toEqual({ message: "Backfill canceled." });

    expect(get).toHaveBeenCalledWith(`/backfills/${ID}`);
    expect(put).toHaveBeenCalledWith(`/backfills/${ID}`, expect.objectContaining({ status: "canceled" }));
    expect(put.mock.calls[0][1].date_completed).toBeTypeOf("string");
  });

  it("does not cancel a finished backfill", async () => {
    const { req, put } = setup("cancel", { id: ID, status: "completed" });
    expect(await handler(req)).toEqual({ message: "This backfill is already completed." });
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["failed", "canceled"])("resumes a %s backfill", async (status) => {
    const { req, put } = setup("resume", { id: ID, status, last_error: "x" });
    expect(await handler(req)).toEqual({ message: "Backfill resumed." });
    expect(put).toHaveBeenCalledWith(`/backfills/${ID}`, { status: "pending", last_error: null, date_completed: null });
  });

  it("does not resume a running backfill", async () => {
    const { req, put } = setup("resume", { id: ID, status: "running" });
    const result: any = await handler(req);
    expect(result.message).toContain("This one is running");
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["", "../settings", "abc"])("rejects record id %s", async (recordId) => {
    const { req, get } = setup("cancel", { id: ID, status: "running" }, recordId);
    await expect(handler(req)).rejects.toThrow("Open a backfill");
    expect(get).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing backfill", async () => {
    const { req } = setup("cancel", null);
    await expect(handler(req)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects unknown actions", async () => {
    const { req } = setup("explode", { id: ID, status: "running" });
    await expect(handler(req)).rejects.toThrow("Unknown action: explode");
  });
});
