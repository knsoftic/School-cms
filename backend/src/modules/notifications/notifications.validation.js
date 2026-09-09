'use strict';

/**
 * Notification schemas — SRS §23, FR-NOTIF-001.
 *
 * §23 has **one requirement and no human author**. Its actor is *System*, and its nine types are
 * dispatched by the sweeps in `notifications.service.js`, not by a request. So this file describes a
 * *reading* surface almost entirely: what a recipient may filter their own inbox by, and nothing that
 * would let a caller compose a notification, choose who receives one, or backdate a delivery.
 *
 * ## Why there is a forbidden map on routes that take no body
 *
 * Three of the five routes accept no body at all, so in principle a forbidden map is redundant —
 * Express would hand the service an object nobody reads. It is written out anyway, and used as the
 * body schema for `read` and `retry`, because *"the route ignores it"* and *"the route refuses it"*
 * are different guarantees and only the second is observable. A caller who sends
 * `{"status":"sent"}` to `POST /:id/retry` is told which column they may not write and why, rather
 * than receiving a 200 that quietly did something else.
 *
 * This also avoids the trap recorded in Known Issues: a schema whose only content is a forbidden map
 * must **not** end in `.min(1)`, or an empty body is rejected for being empty and the refusal of the
 * forbidden key proves nothing. These schemas allow `{}` and refuse the named keys, so a deliberate
 * regression on either half fails for the right reason.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const {
  NOTIFICATION_TYPE_LIST,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUS,
} = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

/**
 * Every column of `notifications` is written by the engine. There is no subset a caller may set, so
 * the map covers the table rather than a chosen few — this is the first module in the application
 * where that is true of *all* of it.
 */
const owned = Object.freeze({
  id: forbiddenField('"id" is allocated by the system'),
  school_id: forbiddenField('"school_id" is taken from the event that raised the notification'),
  organization_id: forbiddenField('"organization_id" is taken from the event'),
  user_id: forbiddenField('"user_id" is the recipient the engine resolved; it is not caller-supplied'),
  type: forbiddenField('"type" is one of SRS §23\'s nine types, chosen by the dispatching sweep'),
  channel: forbiddenField('"channel" is chosen by the engine, not by the reader'),
  title: forbiddenField('"title" is composed by the engine — §23 has no human author'),
  message: forbiddenField('"message" is composed by the engine — §23 has no human author'),
  action_url: forbiddenField('"action_url" is composed by the engine'),
  reference_type: forbiddenField('"reference_type" names the row that triggered the notification'),
  reference_id: forbiddenField('"reference_id" names the row that triggered the notification'),
  status: forbiddenField('"status" is set by delivery; use POST /:id/read or POST /:id/retry'),
  sent_at: forbiddenField('"sent_at" is stamped at delivery'),
  read_at: forbiddenField('"read_at" is stamped by POST /:id/read, never from a body'),
  error_message: forbiddenField('"error_message" is written from the delivery failure itself'),
  metadata: forbiddenField('"metadata" is written by the dispatching sweep'),
});

const fields = {
  type: Joi.string().valid(...NOTIFICATION_TYPE_LIST),
  channel: Joi.string().valid(...Object.values(NOTIFICATION_CHANNELS)),
  status: Joi.string().valid(...Object.values(NOTIFICATION_STATUS)),
  unread: Joi.boolean(),
};

/**
 * The inbox.
 *
 * `channel` defaults to nothing here rather than to `in_app`, because the default belongs in the
 * service: a reader who passes no channel gets their inbox, and the service is the one place that
 * decides what an inbox is. Putting the default in the schema would make `GET /?channel=in_app` and
 * `GET /` provably identical while hiding *why* — and would leave the service's own branch untested.
 */
const list = listQuery(
  Joi.object({
    type: fields.type,
    channel: fields.channel,
    status: fields.status,
    unread: fields.unread,
  }),
  commonSchemas.dateRange
);

const idParam = commonSchemas.idParam;

/** `POST /:id/read` and `POST /:id/retry` take no input beyond the id. See the header. */
const empty = Joi.object({ ...owned });

/**
 * `POST /read-all` may be narrowed to one type, which is the only body §23 has a reader for.
 *
 * `type` is **lifted out** of the forbidden map rather than re-declared after it. Spreading `owned`
 * last would silently shadow the one key this route exists to accept — the defect recorded twice
 * already, as §20.3's `review` losing `marks_obtained` and §20.4's `returnBook` losing
 * `return_date`. It happened a third time here and the suite caught it on the first run. Lifting is
 * the fix rather than reordering, because reordering leaves the same landmine for the next key.
 */
const ownedExceptType = Object.fromEntries(
  Object.entries(owned).filter(([key]) => key !== 'type')
);

const readAll = Joi.object({ type: fields.type, ...ownedExceptType });

module.exports = {
  schemas: { list, idParam, empty, readAll },
  fields,
  owned,
  ownedExceptType,
};
