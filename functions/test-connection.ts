import { FivetranError, buildTestRow, errorMessage, getFivetranSettings, isConfigured, postRows } from './lib/fivetran';

export const config: SwellConfig = {
  description: 'Send a test event to Fivetran',
  action: true,
};

// A webhook has no read endpoint, so the only check is sending one `test` row.
export default async function (req: SwellRequest) {
  const { swell, store } = req;
  const settings = await getFivetranSettings(swell);

  if (!isConfigured(settings)) {
    throw new SwellError('Enter an https webhook URL and save the settings first', { status: 400 });
  }

  const host = new URL(settings.webhook_url!.trim()).host;
  try {
    const status = await postRows(settings, [buildTestRow(store.id)]);
    return {
      message: `Sent a test event to the Fivetran connector at ${host}, and Fivetran accepted it (HTTP ${status}). It appears in your destination as a row with event "test" after the next sync.`,
    };
  } catch (err) {
    if (!(err instanceof FivetranError)) {
      throw new SwellError(`Couldn't reach ${host}. Check the webhook URL and try again.`, { status: 400 });
    }
    if (err.status === 404) {
      throw new SwellError(`Fivetran has no Webhooks connector at this URL (${host}). Copy the URL from the connector setup form again.`, { status: 400 });
    }
    if ((err.status === 401 || err.status === 403) && settings.signing_secret?.trim()) {
      throw new SwellError(`Fivetran rejected the test event's signature: ${errorMessage(err)}. Check that the signing secret, header and encoding match the connector's signature validation.`, { status: 400 });
    }
    throw new SwellError(`Fivetran rejected the test event: ${errorMessage(err)}`, { status: 400 });
  }
}
