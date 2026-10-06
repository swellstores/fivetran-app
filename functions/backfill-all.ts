import { ACTIVE_STATUSES, COLLECTIONS, getFivetranSettings, isConfigured } from './lib/fivetran';

export const config: SwellConfig = {
  description: 'Start backfills for every collection',
  action: true,
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const settings = await getFivetranSettings(swell);

  if (!isConfigured(settings)) {
    throw new SwellError('Set the Fivetran webhook URL in the app settings first', { status: 400 });
  }

  // Every supported collection, regardless of which ones send live events
  const collections = Object.keys(COLLECTIONS);

  const active: any = await swell.get('/backfills', {
    where: { status: { $in: ACTIVE_STATUSES } },
    fields: 'collection',
    limit: 100,
  });
  const busy = new Set((active?.results || []).map((job: any) => job.collection));

  const started: string[] = [];
  const skipped: string[] = [];
  for (const collection of collections) {
    if (busy.has(collection)) {
      skipped.push(COLLECTIONS[collection].label);
      continue;
    }
    await swell.post('/backfills', {
      collection,
      status: 'pending',
      ...(data.date_from ? { date_from: data.date_from } : {}),
    });
    started.push(COLLECTIONS[collection].label);
  }

  const parts = [];
  if (started.length) {
    parts.push(`Started backfills for ${started.join(', ')}.`);
  }
  if (skipped.length) {
    parts.push(`Already running: ${skipped.join(', ')}.`);
  }
  return { message: parts.join(' ') };
}
