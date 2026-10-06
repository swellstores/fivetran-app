Send your Swell store data to your data warehouse through Fivetran. The app streams changes to orders, customers, products and more to a Fivetran Webhooks connector, and Fivetran loads them into your destination, such as Snowflake, BigQuery, Redshift or Databricks.

Connect your Webhooks connector with its URL, choose the collections to send and save. From then on, each change to those records is sent to Fivetran as it happens, and you can backfill the records you already have.

- **Eleven collections.** Orders, customers, products, subscriptions, payments, refunds, invoices, carts, coupons, promotions and categories, each with its own checkbox.
- **Full records.** Creates and updates send the whole current record, not just the fields that changed, and deletions can be sent too.
- **Backfill your history.** Send the existing records of one collection, or of every collection in one click, optionally only those created after a date. Each backfill shows the records sent and any error, and can be canceled and resumed where it stopped.
- **Signed requests.** With a signing secret, every request carries an HMAC SHA-256 signature that the connector verifies.
- **An event log in your warehouse.** Each change is one row with the full record, so you can build history or current-state tables.
- **Retries when Fivetran is busy.** If Fivetran is down or rate-limits the app, Swell sends the change again later.

Setup takes a few minutes. In Fivetran, add a Webhooks connector and copy its webhook URL. Paste it in the app settings, choose the collections to send and save. Then open Fivetran in the dashboard sidebar, create a backfill with collection Connection test to check the connection, and start backfills to send your existing records.
