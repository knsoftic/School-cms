'use strict';

/**
 * Activity and audit logging — SRS §26 "Activity Logs" (FR-LOG-001) and §29 `audit_logs`.
 *
 * Two tables, two questions. `activity_logs` answers "who did what, from where, and did it work" —
 * one row per meaningful action. `audit_logs` answers "which columns changed, from what to what" —
 * one row per mutated record. SRS §29 lists both, so both exist and neither substitutes for the other.
 *
 * ## Not one row per request
 *
 * FR-LOG-001 asks for user and system *actions*, not for a transcript of HTTP traffic. A row per
 * request would bury the twelve interesting events of a school day under ten thousand dashboard polls,
 * and SRS §26's retention requirement would then be a retention problem. So a route opts in with
 * `logActivity()`, or a service records directly, and only two things are recorded whether or not
 * anyone asked:
 *
 *  - `req.tenantViolation`, set by `enforceTenant` — an attempt to reach another school's data is the
 *    single event this system most needs to have kept (SRS §31's isolation test case). Recorded as
 *    `access_denied`.
 *  - `req.sanitized`, set by `sanitizeRequest` — a request that arrived carrying script or forbidden
 *    keys. Folded into the metadata of whatever row is written, because SRS §26 fixes the set of
 *    actions and none of them means "hostile input"; `sanitizeRequest` logs it in its own right.
 *
 * ## Writes never fail the request
 *
 * The row is written on `res.on('finish')`, after the response has gone. A logging insert that threw
 * would otherwise turn a successful save into a 500, and a log is not worth a lost transaction. A
 * failed insert is reported to the error log and the request stands.
 *
 * The consequence is deliberate and worth stating: this is a log, not a ledger. Anything that must be
 * durable — a payment, an approval — belongs in its own table inside the same transaction as the
 * change it describes, with the activity row as a convenience on top.
 */

const db = require('../models');
const logger = require('../config/logger');
const { elapsedMs } = require('./requestContext');
const { ACTIVITY_ACTIONS } = require('../config/constants');

/** Column widths from the model, so a long path or user-agent is trimmed rather than rejected. */
const WIDTHS = Object.freeze({
  entityType: 80,
  description: 500,
  method: 10,
  path: 255,
  ip: 60,
  userAgent: 255,
  requestId: 60,
  email: 180,
  roleSlug: 60,
  tableName: 80,
  reason: 255,
});

/** What an unlabelled action means, inferred from the method. */
const METHOD_ACTIONS = Object.freeze({
  POST: ACTIVITY_ACTIONS.CREATE,
  PUT: ACTIVITY_ACTIONS.UPDATE,
  PATCH: ACTIVITY_ACTIONS.UPDATE,
  DELETE: ACTIVITY_ACTIONS.DELETE,
  GET: ACTIVITY_ACTIONS.VIEW,
  HEAD: ACTIVITY_ACTIONS.VIEW,
});

/**
 * @param {any} value
 * @param {number} max
 * @returns {string|null}
 */
function trim(value, max) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** A positive integer id, or null. Ids arrive from params as strings and from BIGINT as strings. */
function toId(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * The parts of a row that come from the request rather than from the action.
 *
 * @param {import('express').Request} req
 */
function requestFields(req) {
  const tenant = req.tenant || {};
  const user = req.user || null;

  return {
    school_id: toId(tenant.schoolId),
    organization_id: toId(tenant.organizationId),
    user_id: user ? toId(user.id) : null,
    /* Kept even though `user_id` is set: the row has to stay readable after the user is deleted. */
    user_email: user ? trim(user.email, WIDTHS.email) : null,
    role_slug: trim(tenant.roleSlug, WIDTHS.roleSlug),
    method: trim(req.method, WIDTHS.method),
    path: trim(req.originalUrl, WIDTHS.path),
    ip_address: trim(req.ip, WIDTHS.ip),
    user_agent: trim(req.get && req.get('user-agent'), WIDTHS.userAgent),
    request_id: trim(req.id, WIDTHS.requestId),
  };
}

/**
 * Resolve a field that a route may have given as a literal or as a function of the request.
 *
 * The function form exists because the interesting values — the id of the record just created, the
 * name of the pupil just deleted — are only known once the handler has run.
 *
 * @param {any} value
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function resolveField(value, req, res) {
  if (typeof value !== 'function') return value;
  try {
    return value(req, res);
  } catch (err) {
    /* A throwing describer must not cost the row its other fields. */
    logger.warn('Activity log field could not be resolved', {
      requestId: req.id,
      error: err.message,
    });
    return null;
  }
}

/**
 * Write one `activity_logs` row.
 *
 * Exported for callers with no request in hand — a scheduled job, a queue worker (SRS §25) — which
 * pass the tenant fields themselves.
 *
 * @param {object} fields  column values; unknown keys are ignored by Sequelize
 * @returns {Promise<void>}
 */
async function recordActivity(fields) {
  try {
    await db.ActivityLog.create(fields);
  } catch (err) {
    /*
     * Swallowed on purpose — see the header. Logged at error because a log table that has quietly
     * stopped accepting rows is a compliance problem, not a nuisance.
     */
    logger.error('Could not write activity log', {
      requestId: fields.request_id || null,
      action: fields.action || null,
      error: err.message,
    });
  }
}

/**
 * Add to (or start) what this request will record.
 *
 * Controllers and services use this once they know what happened: the id of the row they created, a
 * description worth reading, an action that is not implied by the method (`approve`, `export`,
 * `login_failed`). Called more than once, later fields win.
 *
 * @param {import('express').Request} req
 * @param {object} fields  `{action, entityType, entityId, description, metadata, actor}`
 * @returns {void}
 */
function describeActivity(req, fields = {}) {
  const current = req.activity || {};
  req.activity = {
    ...current,
    ...fields,
    metadata: { ...(current.metadata || {}), ...(fields.metadata || {}) },
  };
}

/**
 * Declare that a route's requests are worth recording.
 *
 * @param {object} [options]
 * @param {string} [options.action]       one of `ACTIVITY_ACTIONS`; inferred from the method if absent
 * @param {string} [options.entityType]   `'student'`, `'invoice'`, …
 * @param {number|string|((req, res) => any)} [options.entityId]
 *        defaults to `req.params.id` when the route has one
 * @param {string|((req, res) => any)} [options.description]
 * @param {object|((req, res) => any)} [options.metadata]
 * @param {object|((req, res) => any)} [options.actor]
 *        attribution for a route mounted above the authentication boundary — see `attributionFrom`
 * @param {boolean} [options.onlyOnSuccess]  skip the row when the response was a 4xx/5xx
 * @returns {import('express').RequestHandler}
 */
function logActivity(options = {}) {
  if (options.action && !Object.values(ACTIVITY_ACTIONS).includes(options.action)) {
    /* Boot-time: `activity_logs.action` is an ENUM, so a typo would fail at insert on a live path. */
    throw new Error(
      `logActivity(): unknown action '${options.action}'. Expected one of ${Object.values(
        ACTIVITY_ACTIONS
      ).join(', ')}`
    );
  }

  return function activityDeclaration(req, res, next) {
    describeActivity(req, options);
    next();
  };
}

/**
 * Attribution supplied by a handler for a request that was never authenticated.
 *
 * `requestFields` reads `req.user` and `req.tenant`, which only exist below the authentication
 * boundary. Three of the most security-relevant events in the system happen *above* it — a successful
 * sign-in, a password reset from an emailed link, and an email confirmation — so without this the
 * `login`, reset and verification rows carry no user id, no address and no role, which are exactly the
 * three columns an administrator filters on when asking what happened to an account.
 *
 * Only the fields actually supplied are overlaid, so passing an actor on an authenticated route cannot
 * blank out what `requestFields` already derived.
 *
 * @param {{id?: any, email?: string, roleSlug?: string, schoolId?: any, organizationId?: any}|null} actor
 * @returns {object}
 */
function attributionFrom(actor) {
  if (!actor || typeof actor !== 'object') return {};

  const fields = {};
  if (actor.id !== undefined && actor.id !== null) fields.user_id = toId(actor.id);
  if (actor.email) fields.user_email = trim(actor.email, WIDTHS.email);
  if (actor.roleSlug) fields.role_slug = trim(actor.roleSlug, WIDTHS.roleSlug);
  if (actor.schoolId !== undefined && actor.schoolId !== null) {
    fields.school_id = toId(actor.schoolId);
  }
  if (actor.organizationId !== undefined && actor.organizationId !== null) {
    fields.organization_id = toId(actor.organizationId);
  }
  return fields;
}

/**
 * Register the writer. Mount once, on the API root, before the routes.
 *
 * @returns {import('express').RequestHandler}
 */
function activityAudit() {
  return function activityAuditHook(req, res, next) {
    res.on('finish', () => {
      const declared = req.activity || null;
      const violation = req.tenantViolation || null;

      /* Nothing asked to be recorded and nothing security-relevant happened. */
      if (!declared && !violation) return;

      if (declared && declared.onlyOnSuccess && res.statusCode >= 400 && !violation) return;

      const action = violation
        ? ACTIVITY_ACTIONS.ACCESS_DENIED
        : (declared && declared.action) || METHOD_ACTIONS[req.method] || ACTIVITY_ACTIONS.VIEW;

      const entityId =
        declared && declared.entityId !== undefined
          ? toId(resolveField(declared.entityId, req, res))
          : toId(req.params && req.params.id);

      const metadata = {
        durationMs: elapsedMs(req),
        ...(declared ? resolveField(declared.metadata, req, res) || {} : {}),
      };

      /* Both are attached whenever they happened, whatever the row's action turned out to be. */
      if (violation) metadata.violation = violation;
      if (req.sanitized) metadata.sanitized = req.sanitized;

      const description = violation
        ? `Refused access to ${violation.attempted.kind} ${violation.attempted.value}`
        : resolveField(declared.description, req, res);

      /*
       * Not awaited. `finish` has already fired, so there is nobody left to wait for the insert, and
       * `recordActivity` reports its own failures.
       */
      recordActivity({
        ...requestFields(req),
        /*
         * Overlaid after the derived fields, so a public route that knows who the caller turned out to
         * be can say so. See `attributionFrom`.
         */
        ...attributionFrom(declared && resolveField(declared.actor, req, res)),
        action,
        entity_type: trim(declared && declared.entityType, WIDTHS.entityType),
        entity_id: entityId,
        description: trim(description, WIDTHS.description),
        status_code: res.statusCode,
        metadata,
      });
    });

    next();
  };
}

/* ───────────────────────────── audit_logs (SRS §29) ───────────────────────────── */

/**
 * A model instance's stored column values.
 *
 * `getDataValue` is used rather than property access on purpose. A model may define a getter that
 * derives a value (a formatted name, a computed total) or that parses one — `installJsonGetters`
 * adds exactly that for MariaDB's JSON columns — and an audit row has to record what is in the
 * column, not a view of it. Reading through the getters would also make the row's shape depend on
 * model code that can change after the fact.
 *
 * @param {object} instance  a Sequelize instance
 * @param {string[]} [fields]  restrict to these attributes
 * @returns {object}
 */
function snapshot(instance, fields) {
  if (!instance || typeof instance.getDataValue !== 'function') return {};

  const attributes = instance.constructor.rawAttributes || instance.rawAttributes || {};
  const names = fields && fields.length ? fields : Object.keys(attributes);

  return names.reduce((values, name) => {
    const value = instance.getDataValue(name);
    return value === undefined ? values : { ...values, [name]: value };
  }, {});
}

/**
 * Which columns differ, and how.
 *
 * Only changed columns are kept — SRS §29's `changed_fields` — because storing the whole row twice per
 * update turns the audit table into a copy of the database.
 *
 * @param {object} before
 * @param {object} after
 * @returns {{changed: string[], old: object, new: object}}
 */
function diff(before = {}, after = {}) {
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  const oldValues = {};
  const newValues = {};

  for (const name of names) {
    const from = before ? before[name] : undefined;
    const to = after ? after[name] : undefined;

    /*
     * Compared by serialised form. Dates, decimals arriving from mysql2 as strings, and JSON objects
     * all compare wrongly with `===`, and a false positive would report a change that never happened.
     */
    if (JSON.stringify(from === undefined ? null : from) === JSON.stringify(to === undefined ? null : to)) {
      continue;
    }

    changed.push(name);
    oldValues[name] = from === undefined ? null : from;
    newValues[name] = to === undefined ? null : to;
  }

  return { changed, old: oldValues, new: newValues };
}

/**
 * Write one `audit_logs` row.
 *
 * Called by the service that made the change, which is the only place that holds both sides of it.
 * An update whose columns all match is not recorded — an audit trail of no-ops hides the real ones.
 *
 * @param {import('express').Request|null} req  for tenant/user/request context; may be null in a job
 * @param {object} entry
 * @param {string} entry.tableName
 * @param {number|string} [entry.recordId]
 * @param {'create'|'update'|'delete'|'restore'} entry.event
 * @param {object} [entry.before]  from `snapshot()`
 * @param {object} [entry.after]   from `snapshot()`
 * @param {string} [entry.reason]
 * @param {number} [entry.schoolId]        the tenant the change belongs to, when the request cannot say
 * @param {number} [entry.organizationId]  — a sweep has no request, and an emailed-link request has
 * @param {number} [entry.userId]          no signed-in user; the request's own values win when present
 * @returns {Promise<void>}
 */
async function recordAudit(req, entry = {}) {
  const { tableName, recordId, event, before, after, reason } = entry;

  if (!tableName || !event) {
    throw new Error('recordAudit() requires tableName and event');
  }

  const changes = diff(before, after);

  if (event === 'update' && !changes.changed.length) return;

  const context = req ? requestFields(req) : {};

  /*
   * A change made with no tenant in the request context — the lifecycle sweep, a scheduled invoice, a
   * password reset through an emailed link — still belongs to a school. Without these the row carried
   * no school, organization or user: invisible to the tenant it is about, and outside every
   * tenant-scoped cleanup (`school_id` and `organization_id` cascade from their tables; nothing else does).
   */
  try {
    await db.AuditLog.create({
      school_id: context.school_id || toId(entry.schoolId) || null,
      organization_id: context.organization_id || toId(entry.organizationId) || null,
      user_id: context.user_id || toId(entry.userId) || null,
      table_name: trim(tableName, WIDTHS.tableName),
      record_id: toId(recordId),
      event,
      old_values: event === 'create' ? null : changes.old,
      new_values: event === 'delete' ? null : changes.new,
      changed_fields: changes.changed,
      ip_address: context.ip_address || null,
      request_id: context.request_id || null,
      reason: trim(reason, WIDTHS.reason),
    });
  } catch (err) {
    logger.error('Could not write audit log', {
      requestId: context.request_id || null,
      table: tableName,
      event,
      error: err.message,
    });
  }
}

module.exports = {
  activityAudit,
  logActivity,
  describeActivity,
  recordActivity,
  recordAudit,
  snapshot,
  diff,
  METHOD_ACTIONS,
};
