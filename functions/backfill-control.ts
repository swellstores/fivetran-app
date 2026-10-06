import { ACTIVE_STATUSES } from './lib/fivetran';

export const config: SwellConfig = {
  description: 'Cancel or resume a backfill',
  action: true,
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const action = data.$action;
  const id = action?.record_id;

  if (!id || !/^[0-9a-f]{24}$/i.test(id)) {
    throw new SwellError('Open a backfill to run this action', { status: 400 });
  }

  const job: Record<string, any> | null = await swell.get(`/backfills/${id}`);
  if (!job) {
    throw new SwellError('Backfill not found', { status: 404 });
  }

  if (action?.id === 'cancel') {
    if (!ACTIVE_STATUSES.includes(job.status)) {
      return { message: `This backfill is already ${job.status}.` };
    }
    await swell.put(`/backfills/${id}`, { status: 'canceled', date_completed: new Date().toISOString() });
    return { message: 'Backfill canceled.' };
  }

  if (action?.id === 'resume') {
    if (!['failed', 'canceled'].includes(job.status)) {
      return { message: `Only failed or canceled backfills can be resumed. This one is ${job.status}.` };
    }
    // Picks up after `last_id`, so records already sent aren't sent again
    await swell.put(`/backfills/${id}`, { status: 'pending', last_error: null, date_completed: null });
    return { message: 'Backfill resumed.' };
  }

  throw new SwellError(`Unknown action: ${action?.id}`, { status: 400 });
}
