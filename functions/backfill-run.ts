import {
  ACTIVE_STATUSES,
  COLLECTIONS,
  buildRow,
  buildTestRow,
  errorMessage,
  getFivetranSettings,
  isConfigured,
  pageSize,
  postRows,
} from './lib/fivetran';

export const config: SwellConfig = {
  description: 'Send one page of a backfill to Fivetran',
  model: {
    events: ['backfill.created', 'backfill.updated'],
    conditions: { status: { $in: ['pending', 'running'] } },
  },
};

// Each page update re-triggers this function for the next page. Edits to other fields don't.
export function shouldRun(data: SwellRequest['data']): boolean {
  const event = data.$event;
  if (event?.type === 'backfill.created') {
    return true;
  }
  const changed = event?.data || {};
  return 'pages' in changed || changed.status === 'pending';
}

export default async function (req: SwellRequest) {
  const { swell, data, store } = req;

  if (!shouldRun(data)) {
    return;
  }

  const job: Record<string, any> | null = await swell.get(`/backfills/${data.id}`);
  if (!job || !ACTIVE_STATUSES.includes(job.status)) {
    return;
  }

  const fail = (error: string) =>
    swell.put(`/backfills/${job.id}`, { status: 'failed', last_error: error, date_completed: new Date().toISOString() });

  const settings = await getFivetranSettings(swell);
  if (settings.enabled === false) {
    return fail('The Fivetran app is turned off in settings');
  }
  if (!isConfigured(settings)) {
    return fail('Fivetran webhook URL is not set');
  }

  // "Connection test" job: one test row instead of a collection
  if (job.collection === 'test') {
    try {
      await postRows(settings, [buildTestRow(store.id)]);
    } catch (err) {
      return fail(errorMessage(err));
    }
    const now = new Date().toISOString();
    return swell.put(`/backfills/${job.id}`, {
      status: 'completed',
      pages: 1,
      sent: 1,
      total: 1,
      last_error: null,
      date_started: now,
      date_completed: now,
    });
  }

  const target = COLLECTIONS[job.collection];
  if (!target) {
    return fail(`Unknown collection: ${job.collection}`);
  }

  const limit = pageSize(settings);
  const where: Record<string, any> = {};
  if (job.last_id) {
    where.id = { $gt: job.last_id };
  }
  if (job.date_from) {
    where.date_created = { $gte: job.date_from };
  }

  try {
    const page: any = await swell.get(target.path, { where, sort: 'id asc', limit });
    const records: Record<string, any>[] = page?.results || [];

    if (records.length) {
      await postRows(
        settings,
        records.map((record) => buildRow(store.id, job.collection, 'backfill', record, `backfill:${job.id}:${record.id}`)),
      );
    }

    const done = records.length < limit;
    const now = new Date().toISOString();
    const update: Record<string, any> = {
      last_id: records.length ? records[records.length - 1].id : job.last_id,
      pages: (job.pages || 0) + 1,
      sent: (job.sent || 0) + records.length,
      last_error: null,
    };
    if (!job.last_id && typeof page?.count === 'number') {
      update.total = page.count;
    }
    if (!job.date_started) {
      update.date_started = now;
    }

    // Keep a cancel that happened while this page was being sent
    const current: Record<string, any> | null = await swell.get(`/backfills/${job.id}`);
    if (current && ACTIVE_STATUSES.includes(current.status)) {
      update.status = done ? 'completed' : 'running';
      if (done) {
        update.date_completed = now;
      }
    }

    await swell.put(`/backfills/${job.id}`, update);
  } catch (err) {
    const message = errorMessage(err);
    console.error(`Fivetran: backfill ${job.id} (${job.collection}) failed - ${message}`);
    await fail(message);
  }
}
