'use strict';

/**
 * User accounts — SRS §33 "Users", with FR-AUTH-006 (email verification) and FR-AUTH-007 (account
 * status) supplying the only functional behaviour the source states for a user record.
 *
 * `users.validation.js` records which columns this module will and will not accept and why. This file
 * carries the rules that cannot be expressed as a schema.
 *
 * ## Who can see whom
 *
 * `tenantWhere()` alone, with no role filter — this is the one module whose subject *is* the `users`
 * table, so every role is in scope and the tenant columns do the narrowing:
 *
 *   • Super Admin      no tenant column pinned → every user, including other platform users
 *   • Organization Admin  `organization_id = theirs` → their organization's schools' users
 *   • School user      `school_id = theirs` → their school only
 *
 * A Super Admin's row carries `organization_id: null` and `school_id: null`, so it does not match an
 * organization- or school-scoped WHERE at all: platform accounts are invisible to tenant callers as a
 * consequence of the schema, not because of a special case here.
 *
 * ## Three refusals that are safety properties, not source requirements
 *
 * The source does not describe them; they are recorded here as decisions, the way
 * `principals.service` records `must_change_password`, and are not presented as SRS requirements.
 *
 *  1. **You may not edit your own status.** The only super_admin suspending themselves would leave the
 *     platform with no way back in — `03-role-permissions.js` makes the same argument about revoking
 *     `roles.manage`. FR-AUTH-007's actors are administrators acting *on accounts*, not on their own.
 *  2. **You may not edit your own permission overrides.** Same lockout in the deny direction, and it
 *     removes the question of whether a caller can bootstrap themselves upward.
 *  3. **You may only grant permissions you hold yourself.** Without it, `users.manage` becomes the
 *     highest privilege in the system: a Principal could write `subscriptions.manage` into a teacher's
 *     `extra_permissions` and operate the platform through them. Revocation is unrestricted, because
 *     taking a permission away cannot escalate anything.
 *
 * ## Why a suspension needs no extra write
 *
 * Setting `status` to anything outside `LOGIN_ALLOWED_STATUSES` takes effect on the next request
 * without clearing the session columns: `authenticate` checks the status on every authenticated
 * request, and `authService.assertUsableAccount()` checks it again on both login and refresh — its own
 * header explains that a suspension has to stop a refresh too. So there is deliberately no
 * `refresh_token_hash = null` here; it would be a second mechanism for something already enforced in
 * one place.
 */

const db = require('../../models');
const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');
const authService = require('../auth/auth.service');
const permissionService = require('../../services/permissionService');
const usageService = require('../../services/usageService');
const { hashPassword } = require('../../utils/tokens');
const { resolveSchool } = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { PERMISSION_KEY_SET, PERMISSIONS } = require('../../config/permissions');
const { ROLES, STAFF_CATEGORIES, LIMITS, USER_STATUS } = require('../../config/constants');

const { tenantWhere, Op } = db;

const SORTABLE = Object.freeze([
  'id',
  'name',
  'email',
  'username',
  'status',
  'last_login_at',
  'created_at',
  'updated_at',
]);

/**
 * The columns an audit row for a user may carry.
 *
 * An explicit allow-list, not `snapshot(user)`. A full snapshot would copy `password_hash` and the four
 * single-use token hashes into `audit_logs.new_values`, which turns the audit table into a second place
 * those secrets live — and one with a longer retention than the row they came from.
 *
 * Defined here and imported by `principals.service`: `users` is the table, so this is the table's list,
 * and two copies would drift the moment either module gained a column.
 */
const AUDIT_FIELDS = Object.freeze([
  'id',
  'role_id',
  'organization_id',
  'school_id',
  'name',
  'email',
  'username',
  'phone',
  'status',
  'locale',
  'must_change_password',
]);

/** Audit allow-list for a permission-override write — the two columns and nothing else. */
const PERMISSION_AUDIT_FIELDS = Object.freeze(['id', 'extra_permissions', 'denied_permissions']);

const ROLE_INCLUDE = Object.freeze({
  model: db.Role,
  as: 'role',
  attributes: ['id', 'slug', 'name', 'is_platform_role', 'is_school_role'],
});

const SCHOOL_INCLUDE = Object.freeze({
  model: db.School,
  as: 'school',
  attributes: ['id', 'name', 'code', 'status', 'organization_id'],
  required: false,
});

const ORGANIZATION_INCLUDE = Object.freeze({
  model: db.Organization,
  as: 'organization',
  attributes: ['id', 'name', 'code', 'status'],
  required: false,
});

/**
 * A unique-index collision on `users`, named by the column that collided.
 *
 * `users` carries two unique indexes — `users_email_unique` and `users_username_unique` — so an
 * unqualified "already exists" would leave the operator changing the wrong field. Sequelize reports
 * the offending columns in `err.fields`.
 *
 * Exported because `principals.service` needs exactly this when creating an account: one definition of
 * what a `users` collision means, rather than one per module that writes the table.
 *
 * @param {Error} err
 * @param {object} payload  the submitted values, for the error details
 * @throws {ApiError|Error}
 */
function rethrowUniqueViolation(err, payload) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    const columns = Object.keys(err.fields || {});
    const onUsername = columns.some((column) => column.includes('username'));

    throw ApiError.conflict(
      onUsername ? 'This username is already taken' : 'This email address is already registered',
      {
        code: onUsername ? 'USERNAME_TAKEN' : 'EMAIL_TAKEN',
        details: onUsername ? { username: payload.username } : { email: payload.email },
      }
    );
  }
  throw err;
}

/**
 * The client-facing shape: `publicUser` plus the tenant rows a Users list has to name.
 *
 * `publicUser` publishes an explicit field list and says nothing about associations — its header notes
 * that adding a `users` column must not silently add a response field — so the school, organization and
 * role are attached here rather than by widening that list. A list of accounts that shows `school_id: 7`
 * instead of a school name is not a usable screen.
 *
 * @param {object} user  a `User` instance, ideally with `role`, `school` and `organization` included
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

  if (user.organization) {
    payload.organization = {
      id: user.organization.id,
      name: user.organization.name,
      code: user.organization.code,
      status: user.organization.status,
    };
  }

  return payload;
}

/**
 * The detail shape: `present()` plus the permission picture behind FR-AUTH-009.
 *
 * The two override arrays are excluded from `publicUser` on purpose, so they are added explicitly and
 * only here — on the single-user read, where an administrator is looking at one account's access. The
 * effective set is resolved rather than inferred client-side: `role_permissions ∪ extra − denied` is
 * the server's rule, and a screen that recomputed it would be a second implementation free to disagree.
 *
 * @param {object} user
 * @returns {Promise<object>}
 */
async function presentWithPermissions(user) {
  const payload = present(user);
  const effective = await permissionService.getEffectivePermissions(user);

  payload.permissions = {
    role: (await permissionService.getRolePermissions(user.role_id)).slice().sort(),
    extra: Array.isArray(user.extra_permissions) ? user.extra_permissions.slice().sort() : [],
    denied: Array.isArray(user.denied_permissions) ? user.denied_permissions.slice().sort() : [],
    effective: [...effective].sort(),
  };

  return payload;
}

/**
 * One page of users.
 *
 * @param {object} tenant  `req.tenant`
 * @param {object} query   validated `req.query`
 * @param {{page: number, limit: number, offset: number}} pagination
 * @param {import('express').Request} req
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function list(tenant, query, pagination, req) {
  const where = tenantWhere(tenant, {}, { allowPlatformWide: true });

  if (query.status) where.status = query.status;

  if (query.role) {
    const role = await db.Role.findOne({ where: { slug: query.role }, attributes: ['id'] });
    /* A role that is absent from `roles` matches no user. Returning empty is the truthful answer; a
     * 404 would claim the *endpoint* was wrong when the filter simply selected nobody. */
    if (!role) return { rows: [], count: 0 };
    where.role_id = role.id;
  }

  /*
   * Filters layered on top of the scope, never widening it. If the scope already pins a tenant, a
   * request for a different one must come back empty — the same rule `principals.service` applies to
   * `?school_id=`, and the reason `enforceTenant` is not the only line of defence.
   */
  for (const column of ['school_id', 'organization_id']) {
    if (!query[column]) continue;
    if (where[column] && Number(where[column]) !== Number(query[column])) {
      return { rows: [], count: 0 };
    }
    where[column] = query[column];
  }

  if (query.q) {
    where[Op.or] = [
      { name: { [Op.like]: `%${query.q}%` } },
      { email: { [Op.like]: `%${query.q}%` } },
      { username: { [Op.like]: `%${query.q}%` } },
    ];
  }

  return paginateQuery(
    db.User,
    {
      where,
      order: getSort(req, SORTABLE),
      include: [ROLE_INCLUDE, SCHOOL_INCLUDE, ORGANIZATION_INCLUDE],
      subQuery: false,
    },
    pagination
  );
}

/**
 * One user, or a 404.
 *
 * @param {object} tenant
 * @param {number|string} id
 * @returns {Promise<object>}
 */
async function findById(tenant, id) {
  const user = await db.User.findOne({
    where: tenantWhere(tenant, { id }, { allowPlatformWide: true }),
    include: [ROLE_INCLUDE, SCHOOL_INCLUDE, ORGANIZATION_INCLUDE],
  });

  if (!user) throw ApiError.notFound('User not found', { code: 'USER_NOT_FOUND' });
  return user;
}

/**
 * Refuse an operation a caller is aiming at their own account.
 *
 * @param {import('express').Request} req
 * @param {object} target
 * @param {string} what  named in the message
 */
function assertNotSelf(req, target, what) {
  if (req.user && Number(req.user.id) === Number(target.id)) {
    throw ApiError.forbidden(`You cannot change your own ${what}.`, {
      code: 'SELF_MODIFICATION_DENIED',
      details: { field: what },
    });
  }
}

/**
 * SRS §33 Users — edit an account. FR-AUTH-007 for the `status` field specifically.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} payload  validated body
 * @returns {Promise<{user: object, verificationEmailSent: boolean|null}>}
 */
async function update(req, id, payload) {
  const user = await findById(req.tenant, id);
  const before = snapshot(user, AUDIT_FIELDS);

  if (payload.status !== undefined && payload.status !== user.status) {
    assertNotSelf(req, user, 'account status');
  }

  /*
   * FR-AUTH-006 — *"User email addresses are verified as part of account management."* A changed
   * address has not been verified, whatever the old one's state was, so the column is cleared and a
   * fresh verification is issued below. Leaving `email_verified_at` set would have the system assert
   * it had confirmed an address nobody ever answered.
   */
  const emailChanged = payload.email !== undefined && payload.email !== user.email;

  try {
    await user.update({
      ...payload,
      ...(emailChanged ? { email_verified_at: null } : {}),
    });
  } catch (err) {
    rethrowUniqueViolation(err, payload);
  }

  await recordAudit(req, {
    tableName: 'users',
    recordId: user.id,
    event: 'update',
    before,
    after: snapshot(user, AUDIT_FIELDS),
    reason: emailChanged ? 'User updated; email address changed and must be re-verified' : 'User updated',
  });

  /*
   * `null` means "not applicable to this request" — the field was not touched — as against `false`,
   * which means the send was attempted and failed. A failure is logged and not thrown for the reason
   * `principals.service` records: the update is already committed, and a 500 would report a change
   * that actually happened as one that did not.
   */
  let verificationEmailSent = null;
  if (emailChanged) {
    verificationEmailSent = false;
    try {
      const result = await authService.sendVerificationEmail(user);
      verificationEmailSent = Boolean(result && result.issued);
    } catch (err) {
      logger.error('User email changed but the verification email could not be sent', {
        requestId: req.id,
        userId: user.id,
        error: err.message,
      });
    }
  }

  return { user: await findById(req.tenant, user.id), verificationEmailSent };
}

/* ────────────── Creating a login — the owner's decision D1 in docs/OWNER-DECISIONS.md ────────────── */

/**
 * The profile each creatable role is a login *for*. FR-TEACHER-002's precondition is "Teacher account
 * exists" and nothing in the source creates it — only a Principal (FR-SADMIN-009) and a Parent
 * (FR-PARENT-001) had a creation path, so no teacher, staff member or student could ever sign in. D1
 * gives the school that path. The profile tables already carried a nullable `user_id` for exactly
 * this — "a school records someone who has no portal login yet" — so a login is created and linked in
 * one step, and a staff member's role follows their §15.4 category rather than the caller's choice.
 */
const PROFILE_FOR_ROLE = Object.freeze({
  [ROLES.TEACHER]: { model: 'Teacher', label: 'teacher' },
  [ROLES.ACCOUNTANT]: { model: 'Staff', label: 'staff member', category: STAFF_CATEGORIES.ACCOUNTANT },
  [ROLES.RECEPTIONIST]: { model: 'Staff', label: 'staff member', category: STAFF_CATEGORIES.RECEPTIONIST },
  [ROLES.LIBRARIAN]: { model: 'Staff', label: 'staff member', category: STAFF_CATEGORIES.LIBRARIAN },
  [ROLES.STAFF]: { model: 'Staff', label: 'staff member', category: STAFF_CATEGORIES.OTHER_STAFF },
  [ROLES.STUDENT]: { model: 'Student', label: 'student' },
});

/**
 * Create a login for a school person — `POST /users`.
 *
 * In one transaction: the School Admin headcount is reserved when that is the role (the owner's
 * decision D2 — `admin_limit`, counted as `usageService` already counts it, Principals and School
 * Admins together), the account is created with a temporary password and `must_change_password`, and
 * the profile it is for is linked under a row lock, so two requests cannot hand one teacher two
 * logins. The verification email follows the commit, and its failure is logged rather than thrown, as
 * `principals.service` does: the account exists either way.
 *
 * @param {import('express').Request} req
 * @param {object} payload  validated body
 * @returns {Promise<{user: object, verificationEmailSent: boolean, profile: object|null}>}
 */
async function create(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  const role = await db.Role.findOne({ where: { slug: payload.role } });
  if (!role) {
    throw new ApiError(500, `The ${payload.role} role is missing — run the seeders`, { code: 'ROLE_MISSING' });
  }
  const profileRule = PROFILE_FOR_ROLE[payload.role] || null;
  const passwordHash = await hashPassword(payload.password);

  let created;
  try {
    created = await db.sequelize.transaction(async (transaction) => {
      if (payload.role === ROLES.SCHOOL_ADMIN) {
        await usageService.reserveHeadcount(school.id, LIMITS.ADMIN_LIMIT, 1, transaction);
      }

      let profile = null;
      if (profileRule) {
        profile = await db[profileRule.model].findOne({
          where: { id: payload.profile_id, school_id: school.id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!profile) {
          throw ApiError.validation(`No ${profileRule.label} with that id in this school`, [
            { field: 'profile_id', message: `Name a ${profileRule.label} of this school` },
          ]);
        }
        if (profile.user_id) {
          throw ApiError.conflict(`This ${profileRule.label} already has a login`, {
            code: 'PROFILE_ALREADY_HAS_LOGIN',
            details: { profile_id: profile.id, user_id: profile.user_id },
          });
        }
        if (profileRule.category && profile.category !== profileRule.category) {
          throw ApiError.validation(`A ${payload.role} login is for a staff member in that category`, [
            {
              field: 'role',
              message: `This staff member is recorded as ${profile.category}, so their login's role follows that`,
            },
          ]);
        }
      }

      const profileName = profile ? [profile.first_name, profile.last_name].filter(Boolean).join(' ') : null;
      const user = await db.User.create(
        {
          role_id: role.id,
          school_id: school.id,
          organization_id: school.organization_id,
          name: payload.name || profileName,
          email: payload.email,
          username: payload.username,
          phone: payload.phone ?? null,
          password_hash: passwordHash,
          status: USER_STATUS.ACTIVE,
          must_change_password: true,
        },
        { transaction }
      );
      if (profile) await profile.update({ user_id: user.id }, { transaction });

      return { user, profile };
    });
  } catch (err) {
    rethrowUniqueViolation(err, payload);
  }

  await recordAudit(req, {
    tableName: 'users',
    recordId: created.user.id,
    event: 'create',
    after: snapshot(created.user, AUDIT_FIELDS),
    reason: payload.reason || `${role.name} login created for school ${school.code}`,
  });
  if (created.profile) {
    await recordAudit(req, {
      tableName: created.profile.constructor.getTableName(),
      recordId: created.profile.id,
      event: 'update',
      before: { user_id: null },
      after: { user_id: created.user.id },
      reason: 'Linked to the login created for them',
    });
  }

  let verificationEmailSent = false;
  try {
    const result = await authService.sendVerificationEmail(created.user);
    verificationEmailSent = Boolean(result && result.issued);
  } catch (err) {
    logger.error('Login created but the verification email could not be sent', {
      requestId: req.id,
      userId: created.user.id,
      error: err.message,
    });
  }

  return {
    user: await findById(req.tenant, created.user.id),
    verificationEmailSent,
    profile: created.profile ? { type: PROFILE_FOR_ROLE[payload.role].model.toLowerCase(), id: created.profile.id } : null,
  };
}

/**
 * Reject permission keys that are not in the catalogue.
 *
 * A key absent from `src/config/permissions.js` can never grant or deny anything —
 * `permissionService.normalizeOverrides()` silently drops it on read — so accepting it would store a
 * value that looks like access and is not. Naming the unknown keys is the difference between a message
 * an administrator can act on and "validation failed".
 *
 * @param {Record<string, string[]>} groups  `{ extra_permissions: [...], denied_permissions: [...] }`
 */
function assertKnownKeys(groups) {
  const details = {};
  for (const [field, keys] of Object.entries(groups)) {
    const unknown = keys.filter((key) => !PERMISSION_KEY_SET.has(key));
    if (unknown.length) details[field] = `Unknown permission key(s): ${unknown.join(', ')}`;
  }

  if (Object.keys(details).length) {
    throw ApiError.validation('One or more permission keys do not exist', details);
  }
}

/**
 * Safety property 3 — a caller may only grant what they hold themselves.
 *
 * @param {import('express').Request} req
 * @param {string[]} keys  the requested `extra_permissions`
 */
async function assertGrantable(req, keys) {
  if (!keys.length) return;

  const held = await permissionService.getEffectivePermissions(req.user);
  const beyond = keys.filter((key) => !held.has(key));

  if (beyond.length) {
    throw ApiError.forbidden('You cannot grant a permission you do not hold yourself.', {
      code: 'PERMISSION_GRANT_EXCEEDS_OWN',
      details: { extra_permissions: beyond },
    });
  }
}

/**
 * Replace a user's per-user permission overrides.
 *
 * Deliberately a whole-set write; `users.validation.js` explains why a patch would let two
 * administrators overwrite each other silently.
 *
 * No cache invalidation is needed and none is performed: `permissionService` caches *role* grants
 * only, and reads both override columns straight off the `users` row that `authenticate` has already
 * loaded. The change therefore applies to the target's very next request.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {{extra_permissions?: string[], denied_permissions?: string[]}} payload
 * @returns {Promise<object>}
 */
async function setPermissions(req, id, payload) {
  const user = await findById(req.tenant, id);

  assertNotSelf(req, user, 'permissions');

  /* Absent means "leave this side alone", which is why the current value is the fallback rather than
   * an empty array — `[]` is how a caller asks for the set to be cleared, and the two must differ. */
  const extra = payload.extra_permissions ?? (Array.isArray(user.extra_permissions) ? user.extra_permissions : []);
  const denied =
    payload.denied_permissions ?? (Array.isArray(user.denied_permissions) ? user.denied_permissions : []);

  assertKnownKeys({ extra_permissions: extra, denied_permissions: denied });
  await assertGrantable(req, extra);

  /*
   * A key in both columns is a contradiction the caller can see and fix now. `getEffectivePermissions`
   * would resolve it — deny is applied last and wins — but storing it means the screen shows a granted
   * permission that does not apply, and the next administrator to read it has no way to tell which
   * entry was the intended one.
   */
  const both = extra.filter((key) => denied.includes(key));
  if (both.length) {
    throw ApiError.validation('A permission cannot be granted and denied at the same time', {
      extra_permissions: `Also listed in denied_permissions: ${both.join(', ')}`,
    });
  }

  const before = snapshot(user, PERMISSION_AUDIT_FIELDS);
  await user.update({ extra_permissions: extra, denied_permissions: denied });

  await recordAudit(req, {
    tableName: 'users',
    recordId: user.id,
    event: 'update',
    before,
    after: snapshot(user, PERMISSION_AUDIT_FIELDS),
    reason: 'Per-user permission overrides replaced',
  });

  return findById(req.tenant, user.id);
}

/**
 * The permission catalogue, grouped for the matrix screen.
 *
 * Read from `src/config/permissions.js` rather than the `permissions` table: the file is the source
 * the seeder writes from, so a key present in the database but absent from the catalogue is a stale row
 * that nothing can enforce — `permissionService` drops it on read. Publishing the file's view keeps the
 * screen and the guard agreeing about what exists.
 *
 * @returns {Array<{group: string, permissions: Array<{key: string, name: string, module: string|null}>}>}
 */
function permissionCatalogue() {
  const byGroup = new Map();

  for (const permission of PERMISSIONS) {
    if (!byGroup.has(permission.group)) byGroup.set(permission.group, []);
    byGroup.get(permission.group).push({
      key: permission.key,
      name: permission.name,
      module: permission.module || null,
    });
  }

  return [...byGroup.entries()].map(([group, permissions]) => ({ group, permissions }));
}

module.exports = {
  list,
  findById,
  create,
  update,
  setPermissions,
  present,
  presentWithPermissions,
  permissionCatalogue,
  rethrowUniqueViolation,
  assertNotSelf,
  SORTABLE,
  AUDIT_FIELDS,
  PERMISSION_AUDIT_FIELDS,
};
