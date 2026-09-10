'use strict';

/**
 * School data access — SRS §9.2, FR-SADMIN-002 … FR-SADMIN-008.
 *
 * ## Why `tenantWhere()` is not used here either
 *
 * The same argument as `organizations.service.js`: `schools` has no `school_id` column — a school's
 * identity is its primary key — so `tenantWhere()`'s school-first precedence has nothing correct to
 * write. The scope is spelled out in `scopeFor()` where it can be checked by reading it. Every *other*
 * table (students, subscriptions, invoices) does carry both tenant columns and should use
 * `tenantWhere()`.
 *
 * ## Cache invalidation is not optional
 *
 * `resolveTenant` decides whether a school may be used at all from `tenantService`'s cached copy.
 * FR-SADMIN-005's *"suspended schools' access is restricted"* is only true if the suspension reaches
 * that cache immediately, so every write in this file ends with `invalidateSchool()`. A write that
 * skipped it would leave a suspended school fully operational until a TTL lapsed.
 *
 * ## FR-SADMIN-006 is two operations, not one
 *
 * *"Super Admin deletes or archives a school record"* — the source offers both, so both exist:
 *
 *  - **Archive** sets `status = 'archived'` and stamps `archived_at`. The row stays, `resolveTenant`
 *    refuses it, and it can be reversed by Activate.
 *  - **Delete** is a soft delete (`schools` is paranoid). The row leaves every default query — so
 *    `tenantService.getSchool()` stops finding it and access ends — while the `school_id` on students,
 *    invoices and payments still resolves for historical reporting. A hard delete would cascade
 *    through the tenant tables and destroy the financial record SRS §13 requires be keepable.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const tenantService = require('../../services/tenantService');
const usageService = require('../../services/usageService');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { SCHOOL_STATUS, ROLES } = require('../../config/constants');

const SORTABLE = Object.freeze([
  'id',
  'name',
  'code',
  'status',
  'organization_id',
  'created_at',
  'updated_at',
]);

/**
 * The related rows a school detail view needs.
 *
 * FR-SADMIN-007's outcome is *"School has an assigned Principal on record"*, which is only observable
 * if the record shows it — hence the principal include. Attributes are listed explicitly rather than
 * left to the model's `defaultScope`: the scope is the right safety net, but a route should say what it
 * publishes.
 */
const DETAIL_INCLUDE = Object.freeze([
  {
    model: db.Organization,
    as: 'organization',
    attributes: ['id', 'name', 'code', 'status'],
  },
  {
    model: db.User,
    as: 'principal',
    attributes: ['id', 'name', 'email', 'username', 'phone', 'status'],
  },
]);

/**
 * Which schools this caller may see.
 *
 * @param {{isPlatform: boolean, organizationId: number|null, schoolId: number|null}} tenant
 * @returns {object} a Sequelize `where` fragment
 */
function scopeFor(tenant) {
  if (!tenant) throw new Error('schools.service: req.tenant is missing — resolveTenant did not run');

  /* Super Admin — FR-SADMIN-001 and -004 are platform-wide by definition. */
  if (tenant.isPlatform) return {};

  /* An organization admin sees the schools in their organization (SRS §5's second level). */
  if (tenant.organizationId) return { organization_id: tenant.organizationId };

  /*
   * A school-scoped caller sees one row: their own. Unreachable today — `DEFAULT_ROLE_PERMISSIONS`
   * gives `SCHOOL_LEADERSHIP` neither `schools.view` nor `schools.manage`, which is why the schools
   * list is a platform and organization surface — but correct if a role is ever granted the key.
   */
  if (tenant.schoolId) return { id: tenant.schoolId };

  throw ApiError.forbidden('This account is not scoped to a school or organization', {
    code: 'TENANT_SCOPE_REQUIRED',
  });
}

/**
 * A unique-index collision reported as a 409.
 *
 * `schools_org_code_unique` spans `(organization_id, code)` — a code is unique *within* an organization,
 * not globally — so the message has to say so or it reads as a false conflict to whoever hit it.
 *
 * @param {Error} err
 * @param {object} payload
 * @param {number|string} [organizationId]
 */
function rethrow(err, payload, organizationId) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    throw ApiError.conflict('A school with this code already exists in this organization', {
      code: 'SCHOOL_CODE_TAKEN',
      details: { code: payload.code, organization_id: organizationId ?? payload.organization_id },
    });
  }
  throw err;
}

/**
 * The organization a new school is being placed in — FR-SADMIN-002's precondition, enforced.
 *
 * A suspended or archived organization still *exists*, which is all the source's precondition asks, so
 * it is accepted: the Super Admin may be preparing a school ahead of the organization's activation, and
 * `resolveTenant` already refuses the school's own traffic while the organization is not active. No
 * further precondition is invented here.
 *
 * The non-platform branch is defence in depth rather than a live path: `POST /schools` carries
 * `requirePlatformScope()`, so only the Super Admin reaches this function today. It is written anyway
 * because the check belongs with the reference it validates, not with the route that happens to be the
 * only caller.
 *
 * @param {object} tenant
 * @param {number} organizationId
 * @returns {Promise<object>}
 */
async function requireOrganization(tenant, organizationId) {
  const where = { id: organizationId };

  /* An organization admin may only create inside their own organization. */
  if (!tenant.isPlatform) {
    if (!tenant.organizationId || Number(tenant.organizationId) !== Number(organizationId)) {
      throw ApiError.forbidden('Schools may only be created inside your own organization', {
        code: 'CROSS_TENANT_REFERENCE',
      });
    }
  }

  const organization = await db.Organization.findOne({ where });
  if (!organization) {
    throw ApiError.validation('The referenced organization does not exist', {
      organization_id: 'No organization was found with this id',
    });
  }
  return organization;
}

/**
 * One page of schools.
 *
 * @param {object} tenant
 * @param {object} query  validated `req.query`
 * @param {{page: number, limit: number, offset: number}} pagination
 * @param {import('express').Request} req
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function list(tenant, query, pagination, req) {
  const where = scopeFor(tenant);

  if (query.status) where.status = query.status;

  if (query.organization_id) {
    /*
     * A filter, not a scope. If the caller is already confined to one organization, `scopeFor` has set
     * `organization_id` and a request for a different one must return nothing rather than override it —
     * so the filter is only applied when it agrees with the scope.
     */
    if (where.organization_id && Number(where.organization_id) !== Number(query.organization_id)) {
      return { rows: [], count: 0 };
    }
    where.organization_id = query.organization_id;
  }

  if (query.q) {
    where[Op.or] = [
      { name: { [Op.like]: `%${query.q}%` } },
      { code: { [Op.like]: `%${query.q}%` } },
      { city: { [Op.like]: `%${query.q}%` } },
    ];
  }

  return paginateQuery(
    db.School,
    {
      where,
      order: getSort(req, SORTABLE),
      include: DETAIL_INCLUDE,
      /*
       * Both includes are `belongsTo`, so the join cannot multiply rows and the count stays honest.
       * `subQuery: false` keeps LIMIT on the outer query, which is what makes the page size mean rows.
       */
      subQuery: false,
    },
    pagination
  );
}

/**
 * One school, or a 404 — FR-SADMIN-004.
 *
 * The scope is part of the `where`, so a caller outside it is told "not found" rather than handed a row
 * they may not see. `enforceTenant` has already refused an out-of-tenant `/schools/:id` from the global
 * mount; this is the second of the two independent checks.
 *
 * @param {object} tenant
 * @param {number|string} id
 * @param {{detail?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function findById(tenant, id, options = {}) {
  const school = await db.School.findOne({
    where: { ...scopeFor(tenant), id },
    include: options.detail === false ? undefined : DETAIL_INCLUDE,
  });
  if (!school) throw ApiError.notFound('School not found', { code: 'SCHOOL_NOT_FOUND' });
  return school;
}

/**
 * FR-SADMIN-002 — create a school inside an organization.
 *
 * @param {import('express').Request} req
 * @param {object} payload  validated body
 * @returns {Promise<object>}
 */
async function create(req, payload) {
  await requireOrganization(req.tenant, payload.organization_id);

  let school;
  try {
    school = await db.School.create(payload);
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'schools',
    recordId: school.id,
    event: 'create',
    after: snapshot(school),
  });

  await tenantService.invalidateSchool(school.id);

  return findById(req.tenant, school.id);
}

/**
 * FR-SADMIN-003 — edit a school's details. Status and organization are not reachable from here; see
 * the validation module's header for why.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function update(req, id, payload) {
  const school = await findById(req.tenant, id, { detail: false });
  const before = snapshot(school);

  try {
    await school.update(payload);
  } catch (err) {
    rethrow(err, payload, school.organization_id);
  }

  await recordAudit(req, {
    tableName: 'schools',
    recordId: school.id,
    event: 'update',
    before,
    after: snapshot(school),
  });

  await tenantService.invalidateSchool(school.id);

  return findById(req.tenant, school.id);
}

/**
 * The columns each status transition owns.
 *
 * Written as data rather than as three near-identical functions so that the invariant is visible: a
 * school's status and its two timestamps can never disagree. An `active` school carrying an
 * `archived_at` — the state a hand-written activate would leave behind if it forgot one line — would
 * read as archived to every report that filters on the timestamp instead of the status.
 */
const TRANSITIONS = Object.freeze({
  [SCHOOL_STATUS.ACTIVE]: {
    columns: () => ({
      status: SCHOOL_STATUS.ACTIVE,
      suspended_at: null,
      suspension_reason: null,
      archived_at: null,
    }),
    verb: 'Activated',
  },
  [SCHOOL_STATUS.SUSPENDED]: {
    columns: (reason) => ({
      status: SCHOOL_STATUS.SUSPENDED,
      suspended_at: new Date(),
      suspension_reason: reason || null,
      archived_at: null,
    }),
    verb: 'Suspended',
  },
  [SCHOOL_STATUS.ARCHIVED]: {
    columns: () => ({
      status: SCHOOL_STATUS.ARCHIVED,
      archived_at: new Date(),
    }),
    verb: 'Archived',
  },
});

/**
 * FR-SADMIN-005 (Activate / Suspend) and FR-SADMIN-006 (Archive).
 *
 * Activate clears `archived_at` as well as the suspension columns, which is what makes archiving
 * reversible: FR-SADMIN-005 says *"System updates the school's status accordingly"* and `archived` is
 * one of the three values `status` can hold, so activating an archived school is a status transition
 * like any other.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {string} status  one of `SCHOOL_STATUS`
 * @param {string} [reason]
 * @returns {Promise<{school: object, previousStatus: string, verb: string}>}
 */
async function setStatus(req, id, status, reason) {
  const transition = TRANSITIONS[status];
  if (!transition) {
    /* Boot-level mistake, not a client one — the routes pass literals from `SCHOOL_STATUS`. */
    throw new Error(`schools.service.setStatus(): unsupported status '${status}'`);
  }

  const school = await findById(req.tenant, id, { detail: false });
  const previousStatus = school.status;
  const before = snapshot(school);

  await school.update(transition.columns(reason));

  await recordAudit(req, {
    tableName: 'schools',
    recordId: school.id,
    event: 'update',
    before,
    after: snapshot(school),
    /* `audit_logs.reason` is where an archive reason lives — SRS §29 gives `schools` no column for it. */
    reason: reason || null,
  });

  /* The whole point of FR-SADMIN-005: the next request must see this, not a cached copy. */
  await tenantService.invalidateSchool(school.id);

  return { school: await findById(req.tenant, school.id), previousStatus, verb: transition.verb };
}

/**
 * FR-SADMIN-006, the delete half — a soft delete. See the file header for why it is not a hard one.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @returns {Promise<{id: number, name: string, code: string}>}
 */
async function remove(req, id) {
  const school = await findById(req.tenant, id, { detail: false });
  const before = snapshot(school);
  const identity = { id: school.id, name: school.name, code: school.code };

  await school.destroy();

  await recordAudit(req, {
    tableName: 'schools',
    recordId: identity.id,
    event: 'delete',
    before,
  });

  await tenantService.invalidateSchool(identity.id);

  return identity;
}

/**
 * FR-SADMIN-007 — assign a Principal, or replace the one on record.
 *
 * Three conditions, each of which would otherwise produce a school whose Principal cannot act as one:
 *
 *  1. **The user exists.** The source's precondition — *"School record and Principal account exist"*.
 *  2. **The user holds the `principal` role.** "Selects a Principal" is not "selects a user"; linking a
 *     teacher into `schools.principal_id` would put a name on the record with none of the authority.
 *  3. **The user already belongs to this school.** A user's own `school_id` is what scopes every request
 *     they make, so a principal of school A named as principal of school B would be on record here
 *     while operating there. A Principal's tenancy never moves — the owner's decision D3 in
 *     `docs/OWNER-DECISIONS.md` — so the way to give school B a Principal is to create one for it
 *     (FR-SADMIN-009), which is what the refusal says.
 *
 * A suspended or inactive Principal *is* accepted: `users.status` governs whether they can sign in, and
 * the source treats the assignment as a record of who holds the post, not as a grant of access.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {number} userId
 * @returns {Promise<{school: object, previous: object|null, principal: object}>}
 */
async function assignPrincipal(req, id, userId) {
  const school = await findById(req.tenant, id, { detail: false });

  const user = await db.User.findByPk(userId, {
    include: [{ model: db.Role, as: 'role', attributes: ['id', 'slug', 'name'] }],
  });

  if (!user) {
    throw ApiError.validation('The referenced user does not exist', {
      user_id: 'No user was found with this id',
    });
  }

  if (!user.role || user.role.slug !== ROLES.PRINCIPAL) {
    throw ApiError.validation('The selected user is not a Principal', {
      user_id: `Expected a user whose role is '${ROLES.PRINCIPAL}'`,
    });
  }

  if (Number(user.school_id) !== Number(school.id)) {
    throw ApiError.validation('The selected Principal does not belong to this school', {
      user_id: 'Create a Principal account for this school instead — an account never moves between schools',
    });
  }

  const previousId = school.principal_id;
  const before = snapshot(school);

  await school.update({ principal_id: user.id });

  await recordAudit(req, {
    tableName: 'schools',
    recordId: school.id,
    event: 'update',
    before,
    after: snapshot(school),
    reason: previousId ? `Principal changed from user ${previousId}` : 'Principal assigned',
  });

  await tenantService.invalidateSchool(school.id);

  /* Who was replaced — FR-SADMIN-007's "replacing any prior assignment" is only auditable if named. */
  const previous =
    previousId && Number(previousId) !== Number(user.id)
      ? await db.User.findByPk(previousId, { attributes: ['id', 'name', 'email'] })
      : null;

  return { school: await findById(req.tenant, school.id), previous, principal: user };
}

/**
 * FR-SADMIN-008 — the school's usage.
 *
 * `usageService.getUsageSummary()` is the single source for this: it returns every plan limit's
 * standing (allowed, used, remaining, whether unlimited, whether an overage is permitted) resolved
 * through the school's own subscription, plan, add-ons and overrides. Reading the counters directly
 * here would reimplement SRS §11.2's resolution order and drift from it.
 *
 * The school is fetched first, through `findById`, so a caller outside the tenant gets a 404 from the
 * scope rather than a usage report.
 *
 * @param {object} tenant
 * @param {number|string} id
 * @returns {Promise<{school: object, usage: object[]}>}
 */
async function usage(tenant, id) {
  const school = await findById(tenant, id, { detail: false });
  const summary = await usageService.getUsageSummary(school.id);

  return {
    school: {
      id: school.id,
      name: school.name,
      code: school.code,
      status: school.status,
      subscription_state: school.subscription_state,
    },
    usage: summary,
  };
}

module.exports = {
  list,
  findById,
  create,
  update,
  setStatus,
  remove,
  assignPrincipal,
  usage,
  scopeFor,
  requireOrganization,
  SORTABLE,
  DETAIL_INCLUDE,
  TRANSITIONS,
};
