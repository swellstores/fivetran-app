import { buildTestRow, errorMessage, getFivetranSettings, isConfigured, postRows } from './lib/fivetran';

export const config: SwellConfig = {
  description: 'Send a test event to Fivetran',
  action: true,
};

export default async function (req: SwellRequest) {
  const { swell, store } = req;
  const settings = await getFivetranSettings(swell);

  if (!isConfigured(settings)) {
    throw new SwellError('Enter an https webhook URL and save the settings first', { status: 400 });
  }

  try {
    const status = await postRows(settings, [buildTestRow(store.id)]);
    return { message: `Fivetran accepted the test event (HTTP ${status}). It appears in your destination after the next sync.` };
  } catch (err) {
    throw new SwellError(`Fivetran rejected the test event: ${errorMessage(err)}`, { status: 400 });
  }
}
