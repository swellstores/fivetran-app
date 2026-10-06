import { describe, it, expect } from "vitest";
import { createSwellClient } from "../helpers/swell-client";
import { COLLECTIONS } from "../../functions/lib/fivetran";

// Read-only checks against the logged-in test store (uses swell-cli auth). Run `swell app push` first.
describe("store data the app depends on", () => {
  const swell = createSwellClient();

  it("reads the app settings", async () => {
    const settings = await swell.settings("fivetran");
    expect(settings).toBeTypeOf("object");
  });

  it("reads the backfills collection", async () => {
    const result = await swell.get("/apps/fivetran/backfills", { limit: 1 });
    expect(Array.isArray(result?.results)).toBe(true);
  });

  it.each(Object.keys(COLLECTIONS))("pages %s by id cursor", async (collection) => {
    const { path } = COLLECTIONS[collection];
    const first = await swell.get(path, { sort: "id asc", limit: 1, fields: "id" });
    expect(Array.isArray(first?.results)).toBe(true);

    const lastId = first.results[0]?.id;
    if (lastId) {
      const next = await swell.get(path, { where: { id: { $gt: lastId } }, sort: "id asc", limit: 1, fields: "id" });
      expect(next.results.every((r: any) => r.id > lastId)).toBe(true);
    }
  });
});
