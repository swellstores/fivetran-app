# Fivetran for Swell

Stream your Swell store data to your warehouse through [Fivetran](https://www.fivetran.com). The app sends record changes to a Fivetran **Webhooks connector** as they happen, and backfills existing records on demand. Fivetran loads each row into your destination (Snowflake, BigQuery, Redshift, Databricks, ...).

## Features

- **Live sync:** when a record in a collection selected in settings is created, updated or deleted, the app sends it to Fivetran as one row. Updates send the full current record, not just the changed fields.
- **Collections:** orders, customers (`accounts`), products, subscriptions, payments, refunds, invoices, carts, coupons, promotions and categories. Pick which ones in settings.
- **Backfills:** a **Fivetran** page in the dashboard sidebar lists backfill jobs. Start one per collection with **New fivetran backfill** (optionally only records created after a date), or all collections at once with **Backfill all collections**. Each job shows its status, records sent, total and the last error.
- **Cancel and resume:** an active backfill can be canceled. A failed or canceled one can be resumed. It continues after the last record sent.
- **Request signing:** with a signing secret, every request carries an HMAC SHA-256 signature that the connector can verify.
- **Connection test:** **Test connection** in the app settings sends one test row and shows Fivetran's answer. A backfill with collection **Connection test** does the same as a job, which shows `completed`, or `failed` with Fivetran's error.

## Settings

All credentials and options are app settings (`settings/fivetran.json`). Nothing is hard-coded.

| Setting | Required | Default | Description |
|---|---|---|---|
| Webhook URL | yes | | URL of your Fivetran Webhooks connector. Must be `https`. |
| Signing secret | no | | Signs each request body with HMAC SHA-256. Use the same secret in the connector's signature validation. |
| Signature header | no | `X-Fivetran-Signature-256` | Header the signature is sent in. Must match the header key in the connector. |
| Signature encoding | no | Hexadecimal | `Hexadecimal` or `Base64`. Must match the connector. |
| Collections to send events for | no | None | Collections whose changes are sent live. None are checked at first. **Backfill all collections** always covers all collections. |
| Send deletions | no | on | Send a row with `event: "deleted"` when a record is deleted. |
| Backfill page size | no | 100 | Records per request during a backfill (1–500). Lower it if Fivetran rejects requests as too large. |
| Enabled | no | on | Turns off all sending without uninstalling the app. Running backfills fail with a message. |

## Setup

1. In Fivetran, add a connector of type **Webhooks** and choose the destination schema and table name. Copy the **webhook URL** from the setup form.
2. Optional: in the connector's signature validation, choose algorithm **SHA-256**, encoding hex or base64, a header key (e.g. `X-Fivetran-Signature-256`) and a secret.
3. Install the app in Swell and open its settings. Paste the **Webhook URL**. If you set up signing, enter the same secret, header and encoding. Pick the collections to send events for and save.
4. Choose **Test connection** in the app settings. It sends one test row and says whether Fivetran accepted it, or why not (unknown connector URL, signature mismatch, ...).
5. Start backfills to send existing records: **Backfill all collections**, or **New fivetran backfill** with one collection.
6. After the connector's next sync, the rows are in your destination.

## Data in the warehouse

Every row has the same shape. Live events send one JSON object per request and backfills send a JSON array (Fivetran stores one row per element):

```json
{
  "event_id": "6ac3852fa5f3cb001236a55b",
  "store_id": "my-store",
  "collection": "orders",
  "event": "updated",
  "record_id": "6ac38528c0fbb00012ac7cf0",
  "sent_at": "2026-10-05T11:08:32.545Z",
  "data": { "id": "6ac38528c0fbb00012ac7cf0", "number": "1001", "...": "..." }
}
```

| Field | Description |
|---|---|
| `event_id` | Swell event id for live rows, `backfill:<job id>:<record id>` for backfill rows, `test:<timestamp>` for test rows. |
| `store_id` | Swell store id. |
| `collection` | One of the collection ids above, or `test`. |
| `event` | `created`, `updated`, `deleted`, `backfill` or `test`. |
| `record_id` | Id of the Swell record. |
| `sent_at` | When the app sent the row. |
| `data` | The full Swell record as returned by the Backend API. For `deleted`, the record as it was before deletion. |

Fivetran adds its own columns (`_created`, `_id`, `_index`, ...). Depending on the connector's setting, `data` is unpacked into columns or kept as JSON.

The table is an **event log**, not a mirror: every change adds a row. To get the current state of a record, take the latest row per `collection` + `record_id` by `sent_at`, and drop records whose latest row is `deleted`.

## How it works

| File | Trigger | What it does |
|---|---|---|
| `functions/record-events.ts` | `created`/`updated`/`deleted` events of every supported collection; `payment.succeeded`/`failed`/`voided` for payments | Checks the settings, re-reads the full record on updates and sends one row. |
| `functions/backfill-run.ts` | `backfill.created`, `backfill.updated` (status `pending` or `running`) | For a **Connection test** job, sends one test row. Otherwise sends one page of the collection (sorted by id, after `last_id`) and saves progress. Saving the page triggers the next run, so each page gets its own 10-second function run. |
| `functions/backfill-all.ts` | Action: **Backfill all collections** (backfills list) | Creates a pending backfill for each collection that has no active one. |
| `functions/backfill-control.ts` | Actions: **Cancel backfill**, **Resume backfill** (backfill page) | Sets the job to `canceled`, or back to `pending`. |
| `functions/test-connection.ts` | Action (**Test connection** in the settings) | Sends one `test` row and returns the result, naming the connector's host. |
| `functions/lib/fivetran.ts` | Shared | Collection map, row builder, HMAC signing, Fivetran client, settings helpers. |

Backfill jobs are stored in the app collection `apps/fivetran/backfills` (`models/backfills.json`): `collection` (a collection id, or `test` for a connection test), `status` (`pending`, `running`, `completed`, `failed`, `canceled`), `date_from`, `last_id`, `pages`, `sent`, `total`, `last_error`, `date_started`, `date_completed`. The dashboard views are in `content/backfills.json`.

**Errors and retries:**
- **Live events:** if Fivetran returns 5xx, 408 or 429, or the request fails, the function throws and Swell retries the event with backoff. Other 4xx errors (bad URL or signature) are logged and not retried.
- **Backfills:** any error stops the backfill with status `failed` and the error in `last_error`. Fix the cause, then **Resume backfill**.

## Limits

- **Freshness:** data reaches the warehouse on the connector's sync schedule, not instantly.
- **Payments:** Swell has no `created`/`updated` events for payments. A payment is sent live when it succeeds, fails or is voided. Use a backfill to pick up the rest.
- **Order and duplicates:** rows can arrive out of order, and retries or overlapping backfills can send the same record more than once. Deduplicate by `record_id` and `sent_at`.
- **Backfill and live overlap:** records changed while a backfill runs are sent by both.
- **Backfill totals:** `total` is counted when the backfill starts. Records created during the backfill are still sent, so `sent` can end up higher than `total`.
- **Cancel:** a cancel takes effect after the page that is being sent.
- **Payload size:** Fivetran doesn't document a size limit for webhook requests. If a backfill fails with a size error (e.g. HTTP 413), lower **Backfill page size** and resume.
- **Sensitive data:** records are sent as the Backend API returns them, including customer contact details and payment card metadata (brand, last 4, gateway token). Secure your destination accordingly.
- **Invocations:** the event function subscribes to every supported collection and returns early for those not selected. High-volume collections like carts send a row on every change when selected.
- **Persistent failures:** if Fivetran keeps failing for about 4 days, Swell turns off the event function. Fix the cause and re-push or reinstall the app to turn it back on.
- **No REST API control:** the app doesn't use Fivetran's REST API. It doesn't trigger connector syncs or show connector status.

## Development

Needs the [Swell CLI](https://developers.swell.is/cli) (`swell login`) and Node 20+.

```bash
npm install
npm test               # vitest: unit tests + read-only integration tests
npm run typecheck
swell app push         # deploy to the store's test environment
swell inspect functions --app=.
swell logs --type function -s record-events
swell logs --type function -s backfill-run
```

- **Unit tests** (`test/unit/`) mock Swell and Fivetran (`fetch`) and cover every function and the shared library.
- **Integration tests** (`test/integration/`) are read-only and use your `swell login` session against the test store. They check the app settings and backfills collection, and that every collection pages by an id cursor. Run `swell app push` first.
- **Trying it without Fivetran:** set the webhook URL to an echo endpoint (e.g. `https://httpbin.org/post`) in the test environment, limit the collections to non-personal data such as categories, and start a backfill. `https://httpbin.org/status/400` tests the failure path. Clear the URL afterwards: it's required in the UI, so remove it through the API with `swell api put /settings/<app record id> --body '{"$unset":"fivetran.webhook_url"}'`.
- **Actions** (`action: true` functions) run from the dashboard. With admin credentials they can also be called as `swell api post /functions/fivetran/<name> --body '{...}'` (pass `$action` yourself), and without credentials they return 404. The CLI's local validator (`swell schema function`) doesn't know the `action` trigger yet and reports "Config must specify one of: route, model, cron". `swell app push` accepts them. After a re-push, the function record also carries empty `model`/`route` objects, so `swell inspect functions` may list an action function as `route`. That's cosmetic.
- **Event payloads:** on `deleted` events, the record id is only in `$event.data`. `req.data.id` is missing.
- **Test scaffold:** `test/tsconfig.json` adds the `webworker.iterable` lib so the scaffolded `mock-request.ts` typechecks.

Listing assets: `assets/icon.png` (Fivetran's mark, 512×512), `assets/image.png` (the 1200×630 social card) and the four App Store images in `assets/images/` (3200×1800), referenced from `images` in `swell.json`.
