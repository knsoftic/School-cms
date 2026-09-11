'use strict';

/**
 * The activity and audit trails, read — SRS §26: "Errors and activity are auditable via logs"
 * (SRS:1344).
 *
 * Both tables have been written since §26 was built (`middlewares/activityLog.js`) and nothing could
 * read them without direct database access, although the catalogue has granted `logs.view` ("View
 * activity & audit logs") to school leadership, the Organization Admin and the Super Admin from the
 * start. These two reads are that key's routes.
 *
 * Confinement is the tenant layer's, as everywhere: `tenantWhere()` narrows a school caller to its
 * school's rows and an Organization Admin to its organization's, and leaves a Super Admin the whole
 * platform — the platform's own rows (`school_id` null) included. A `school_id` filter narrows through
 * `resolveSchool()`, which refuses a school that is not the caller's. Nothing here writes, and the audit
 * rows carry only what `recordAudit()` was allowed to snapshot — `users.service.AUDIT_FIELDS` keeps
 * password and token hashes out of them.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { resolveSchool } = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');

const { tenantWhere } = db;

const ACTIVITY_SORTABLE = Object.freeze(['id', 'created_at', 'action', 'entity_type', 'status_code']);
const AUDIT_SORTABLE = Object.freeze(['id', 'created_at', 'table_name', 'event']);

/** The tenant's rows, narrowed to a school when one is named, and to a window when one is given. */
async function scoped(req, query) {
  const where = tenantWhere(req.tenant, {}, { allowPlatformWide: true });
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.user_id) where.user_id = query.user_id;
  if (query.from || query.to) {
    where.created_at = {
      ...(query.from ? { [Op.gte]: new Date(query.from) } : {}),
      ...(query.to ? { [Op.lte]: new Date(query.to) } : {}),
    };
  }
  return where;
}

async function listActivity(req, query, pagination) {
  const where = await scoped(req, query);
  if (query.action) where.action = query.action;
  if (query.entity_type) where.entity_type = query.entity_type;
  if (query.q) {
    where[Op.or] = [
      { description: { [Op.like]: `%${query.q}%` } },
      { user_email: { [Op.like]: `%${query.q}%` } },
      { path: { [Op.like]: `%${query.q}%` } },
    ];
  }
  return paginateQuery(
    db.ActivityLog,
    { where, order: getSort({ query }, ACTIVITY_SORTABLE, ['id', 'DESC']) },
    pagination
  );
}

async function listAudit(req, query, pagination) {
  const where = await scoped(req, query);
  if (query.table_name) where.table_name = query.table_name;
  if (query.record_id) where.record_id = query.record_id;
  if (query.event) where.event = query.event;
  return paginateQuery(
    db.AuditLog,
    { where, order: getSort({ query }, AUDIT_SORTABLE, ['id', 'DESC']) },
    pagination
  );
}

module.exports = { listActivity, listAudit, ACTIVITY_SORTABLE, AUDIT_SORTABLE };
