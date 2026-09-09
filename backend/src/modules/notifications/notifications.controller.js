'use strict';

const service = require('./notifications.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

/**
 * The inbox, with the unread badge beside it.
 *
 * The count is returned on every page rather than from a route of its own, because it is what a
 * client renders next to the list and a second round trip to learn it would be one this module
 * chose to require.
 */
async function list(req, res) {
  const pagination = getPagination(req);
  const [result, unread] = await Promise.all([
    service.list(req, req.query, pagination),
    service.unreadCount(req),
  ]);
  return ApiResponse.paginated(res, result, pagination, { meta: { unread } });
}

async function show(req, res) {
  const row = await service.findById(req, req.params.id);
  return ApiResponse.ok(res, { notification: service.present(row) });
}

/**
 * Marking one read is not written to the activity trail.
 *
 * §24's trail records what a user did *to the school's data*. Reading your own notification is not
 * that, and a class of thirty students opening a homework notice would put thirty rows in
 * `activity_logs` for every one row in `homework`. The retry below **is** recorded, because it is an
 * administrator acting on a delivery.
 */
async function markRead(req, res) {
  const row = await service.markRead(req, req.params.id);
  return ApiResponse.ok(res, { notification: service.present(row) }, { message: 'Notification marked read' });
}

async function markAllRead(req, res) {
  const result = await service.markAllRead(req, req.body);
  return ApiResponse.ok(res, result, { message: `${result.updated} marked read` });
}

async function retry(req, res) {
  const { row, sent } = await service.retry(req, req.params.id);
  describeActivity(req, {
    entityId: row.id,
    description: sent
      ? `Re-sent a failed ${row.type} notification`
      : `Retried a failed ${row.type} notification, which failed again`,
    /* What was retried and whether it worked — never the address or the transport's message. */
    metadata: { type: row.type, channel: row.channel, sent },
  });
  return ApiResponse.ok(
    res,
    { notification: service.present(row), sent },
    { message: sent ? 'Notification re-sent' : 'Delivery failed again' }
  );
}

module.exports = { list, show, markRead, markAllRead, retry };
