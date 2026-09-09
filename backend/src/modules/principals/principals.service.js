'use strict';

/**
 * Principal accounts — SRS §9.3 and FR-SADMIN-009.
 *
 * ## Three values the caller does not supply
 *
 *  - **`role_id`** — resolved from the `principal` slug. The endpoint's name is the role; accepting an
 *    id would let a Super Admin create a `super_admin` through the Principals screen.
 *  - **`organization_id`** — copied from the school. SRS §5 makes the school's organization the
 *    account's organization by construction, and a mismatch between `users.organization_id` and
 *    `schools.organization_id` would make `resolveTenant` and `tenantWhere` disagree about which tenant
 *    the person belongs to.
 *  - **`must_change_password`** — always true. §9.3 has the Super Admin type the Principal's password
 *    into a form, so somebody other than the account holder knows it; `enforcePasswordChange` exists
 *    for exactly this case and its own header records the reasoning. Not an SRS requirement, and not
 *    presented as one — it is the safest reading consistent with FR-AUTH-004.
 *
 * ## Why the verification email cannot fail the request
 *
 * `authService.sendVerificationEmail()` writes the token columns and hands the message to
 * `mailService`. If SMTP is unreachable, the account has already been created and committed — throwing
 * at that point would return a 500 for a Principal who exists, and the Super Admin would create them a
 * second time. So the send is attempted, a failure is logged, and the response reports
 * `verificationEmailSent: false` so the operator knows to use the resend endpoint (FR-AUTH-006) rather
 * than guessing.
 */

const db = require('../../models');
const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');
const authService = require('../auth/auth.service');
const schoolsService = require('../schools/schools.service');
const usersService = require('../users/users.service');
const { hashPassword } = require('../../utils/tokens');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { ROLES } = require('../../config/constants');

const { tenantWhere } = db;

const SORTABLE = Object.freeze(['id', 'name', 'email', 'username', 'status', 'created_at', 'updated_at']);

/**
 * The columns an audit row for a user may carry.
 *
 * Defined in `users.service` — `users` is the table, so the allow-list is the table's, and two copies
 * would diverge the moment either module gained a column. Re-exported here for existing importers. Its
 * own header explains why it is an allow-list and not `snapshot(user)`: a full snapshot would copy
 * `password_hash` and the four token hashes into `audit_logs.new_values`.
 */
const AUDIT_FIELDS = usersService.AUDIT_FIELDS;

const ROLE_INCLUDE = Object.freeze({
  model: db.Role,
  as: 'role',
  attributes: ['id', 'slug', 'name', 'is_platform_role', 'is_school_role'],
});

const SCHOOL_INCLUDE = Object.freeze({
  model: db.School,
  as: 'school',
  attributes: ['id', 'name', 'code', 'status', 'organization_id'],
});

/**
 * The `principal` role row.
 *
 * A missing row is a seeding failure, not a client error, so it throws rather than returning a 4xx —
 * `roles` is seeded from `ROLE_LIST` and cannot legitimately be short one entry.
 *
 * @returns {Promise<object>}
 */
async function principalRole() {
  const role = await db.Role.findOne({ where: { slug: ROLES.PRINCIPAL } });
  if (!role) {
    throw new Error(
      `The '${ROLES.PRINCIPAL}' role is missing from the roles table — run the role seeder before creating Principals.`
    );
  }
  return role;
}

/**
 * FR-SADMIN-009's precondition — *"School record exists"* — checked inside the caller's tenant scope.
 *
 * `schoolsService.scopeFor()` is reused rather than re-derived so there is one definition of which
 * schools a caller can reach. The error is a 422 rather than the service's own 404 because the school
 * arrives as a *field in a body*, and a 404 on `POST /principals` reads as "this endpoint does not
 * exist".
 *
 * @param {object} tenant  `req.tenant`
 * @param {number} schoolId
 * @returns {Promise<object>}
 */
async function requireSchool(tenant, schoolId) {
  const school = await db.School.findOne({
    where: { ...schoolsService.scopeFor(tenant), id: schoolId },
  });

  if (!school) {
    throw ApiError.validation('The referenced school does not exist', {
      school_id: 'No school was found with this id',
    });
  }
  return school;
}

/**
 * A unique-index collision on `users`, named by the column that collided.
 *
 * Delegated to `users.service.rethrowUniqueViolation()` so there is one definition of what a `users`
 * collision means, rather than one per module that writes the table. Its header explains why the
 * message has to name the column: `users` carries two unique indexes, and an unqualified "already
 * exists" leaves the operator changing the wrong field.
 *
 * @param {Error} err
 * @param {object} payload
 */
function rethrow(err, payload) {
  return usersService.rethrowUniqueViolation(err, payload);
}

/**
 * The client-facing shape: `publicUser` plus the school the Principal belongs to.
 *
 * `publicUser` publishes an explicit field list and deliberately says nothing about associations, so the
 * school is attached here rather than by widening that list — FR-SADMIN-007's assignment screen needs
 * the school's name next to each candidate, and `school_id` alone does not give it.
 *
 * @param {object} user  a `User` instance, ideally with `role` and `school` included
 * @returns {object}
 */
function present(user) {
  const payload = authService.publicUser(user);

  if (user.school) {
    payload.school = {
      id: user.school.id,
      name: user.school.name,
      code: user.school.code,
      status: user.school.status,
    };
  }

  return payload;
}

/**
 * One page of Principals.
 *
 * `tenantWhere()` *is* the right helper here — unlike `organizations` and `schools`, the `users` table
 * carries both `school_id` and `organization_id`, which is exactly what it scopes on.
 *
 * @param {object} tenant
 * @param {object} query  validated `req.query`
 * @param {{page: number, limit: number, offset: number}} pagination
 * @param {import('express').Request} req
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function list(tenant, query, pagination, req) {
  const role = await principalRole();

  const where = tenantWhere(tenant, { role_id: role.id }, { allowPlatformWide: true });

  if (query.status) where.status = query.status;

  if (query.school_id) {
    /* A filter on top of the scope. If the scope already pins a school, a request for another one must
     * come back empty rather than widen it. */
    if (where.school_id && Number(where.school_id) !== Number(query.school_id)) {
      return { rows: [], count: 0 };
    }
    where.school_id = query.school_id;
  }

  if (query.q) {
    where[db.Op.or] = [
      { name: { [db.Op.like]: `%${query.q}%` } },
      { email: { [db.Op.like]: `%${query.q}%` } },
      { username: { [db.Op.like]: `%${query.q}%` } },
    ];
  }

  return paginateQuery(
    db.User,
    {
      where,
      order: getSort(req, SORTABLE),
      include: [ROLE_INCLUDE, SCHOOL_INCLUDE],
      subQuery: false,
    },
    pagination
  );
}

/**
 * One Principal, or a 404.
 *
 * @param {object} tenant
 * @param {number|string} id
 * @returns {Promise<object>}
 */
async function findById(tenant, id) {
  const role = await principalRole();

  const user = await db.User.findOne({
    where: tenantWhere(tenant, { id, role_id: role.id }, { allowPlatformWide: true }),
    include: [ROLE_INCLUDE, SCHOOL_INCLUDE],
  });

  if (!user) throw ApiError.notFound('Principal not found', { code: 'PRINCIPAL_NOT_FOUND' });
  return user;
}

/**
 * FR-SADMIN-009 — create a Principal account linked to a school.
 *
 * @param {import('express').Request} req
 * @param {object} payload  validated body — the seven §9.3 fields
 * @returns {Promise<{user: object, verificationEmailSent: boolean}>}
 */
async function create(req, payload) {
  const school = await requireSchool(req.tenant, payload.school_id);
  const role = await principalRole();

  let user;
  try {
    user = await db.User.create({
      role_id: role.id,
      school_id: school.id,
      /* Derived, never supplied — see the file header. */
      organization_id: school.organization_id,
      name: payload.name,
      email: payload.email,
      username: payload.username,
      phone: payload.phone ?? null,
      password_hash: await hashPassword(payload.password),
      /* FR-SADMIN-009: "creates the Principal account with the submitted status". Absent, the column's
       * own default applies — which is why `status` is only set when it was actually submitted. */
      ...(payload.status ? { status: payload.status } : {}),
      must_change_password: true,
    });
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'users',
    recordId: user.id,
    event: 'create',
    after: snapshot(user, AUDIT_FIELDS),
    reason: `Principal created for school ${school.code}`,
  });

  /* FR-AUTH-006's verification, issued at creation. See the header for why a failure is not fatal. */
  let verificationEmailSent = false;
  try {
    const result = await authService.sendVerificationEmail(user);
    verificationEmailSent = Boolean(result && result.issued);
  } catch (err) {
    logger.error('Principal created but the verification email could not be sent', {
      requestId: req.id,
      userId: user.id,
      error: err.message,
    });
  }

  return { user: await findById(req.tenant, user.id), verificationEmailSent };
}

module.exports = {
  list,
  findById,
  create,
  present,
  requireSchool,
  principalRole,
  SORTABLE,
  AUDIT_FIELDS,
};
