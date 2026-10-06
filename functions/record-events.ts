import {
  COLLECTIONS,
  buildRow,
  errorMessage,
  getFivetranSettings,
  isConfigured,
  isRetryable,
  parseEventType,
  postRows,
  syncedCollections,
} from './lib/fivetran';

export const config: SwellConfig = {
  description: 'Send record changes to Fivetran',
  model: {
    events: [
      'order.created', 'order.updated', 'order.deleted',
      'account.created', 'account.updated', 'account.deleted',
      'product.created', 'product.updated', 'product.deleted',
      'subscription.created', 'subscription.updated', 'subscription.deleted',
      'payment.succeeded', 'payment.failed', 'payment.voided',
      'payment.refund.created', 'payment.refund.updated', 'payment.refund.deleted',
      'invoice.created', 'invoice.updated', 'invoice.deleted',
      'cart.created', 'cart.updated', 'cart.deleted',
      'coupon.created', 'coupon.updated', 'coupon.deleted',
      'promotion.created', 'promotion.updated', 'promotion.deleted',
      'category.created', 'category.updated', 'category.deleted',
    ],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data, store } = req;
  const event = data.$event;
  const parsed = parseEventType(event?.type);

  if (!parsed) {
    return;
  }

  const { collection } = parsed;
  // Other events (payment.succeeded, ...) are state changes of an existing record
  const action = ['created', 'deleted'].includes(parsed.action) ? parsed.action : 'updated';
  // deleted events carry the record only in $event.data
  const id: string | undefined = data.id || event?.data?.id;
  const settings = await getFivetranSettings(swell);

  if (settings.enabled === false || !syncedCollections(settings).includes(collection)) {
    return;
  }
  if (action === 'deleted' && settings.send_deletes === false) {
    return;
  }
  if (!isConfigured(settings)) {
    console.error('Fivetran: webhook URL is not set');
    return;
  }

  // `updated` events carry only changed fields, so send the full current record
  let record: Record<string, any> | null = event?.data || null;
  if (action === 'updated') {
    record = await swell.get(`${COLLECTIONS[collection].path}/${id}`);
    if (!record) {
      return; // deleted since; the delete event covers it
    }
  }

  const row = buildRow(store.id, collection, action as 'created' | 'updated' | 'deleted', record, event?.id || '');

  try {
    await postRows(settings, [row]);
  } catch (err) {
    const message = errorMessage(err);
    console.error(`Fivetran: failed to send ${event?.type} ${id} - ${message}`);
    throw new SwellError(message, { status: 502, retry: isRetryable(err) });
  }
}
