'use strict';

/**
 * Parents — SRS §15.2, FR-PARENT-001 (parent account & multiple-children linking) and
 * FR-PARENT-002 (parent dashboard).
 *
 * ## Why this module creates a user, and its two siblings do not
 *
 * `parents.user_id` is **NOT NULL**. `teachers.user_id` and `students.user_id` are nullable, so those
 * modules accept an optional link to an account someone else made; a parent row simply cannot exist
 * without one. FR-PARENT-001 says so directly — "System creates a Parent Account" — so `create()`
 * writes the `users` row and the `parents` row together, and `authService.sendVerificationEmail()`
 * is called afterwards exactly as `principals/` does it.
 *
 * The mail failure is **not** fatal, and that is deliberate rather than sloppy: the account already
 * exists and the token columns are already written, so failing the request would leave a created
 * parent behind a 500 and no way to tell the caller which. `principals.service.js` made the same
 * call for the same reason; the response carries `verificationEmailSent` so the caller knows.
 *
 * ## `parent_students` has no `organization_id`
 *
 * It carries `school_id` alone — like `class_subjects` and `teacher_subjects`, and unlike every other
 * table this phase touches. `tenantWhere()` is model-agnostic and writes `organization_id` for a
 * caller with an organization but no school in scope, which MariaDB answers with
 * `Unknown column 'ParentStudent.organization_id' in 'where clause'` — a 500. That defect has already
 * shipped twice in this project (§5a defect 16). So the join table is scoped by its
 * already-tenant-verified parent, never by `tenantWhere()`, and `childScope()` below is the only way
 * this module queries it.
 *
 * ## One account per parent is enforced by the database here
 *
 * `parents_user_unique` is a real unique index on `user_id` — the only one of the three people tables
 * that has it. `teachers/` and `students/` had to enforce the same rule in their services because
 * their indexes are plain (§5a defects 23 and 29). Here the constraint is mapped rather than
 * duplicated: a pre-check alone would still race, and the index cannot.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const { hashPassword } = require('../../utils/tokens');
const { resolveSchool } = require('../../utils/schoolScope');
const { canManage, withoutFields } = require('../../utils/recordView');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const authService = require('../auth/auth.service');
const usersService = require('../users/users.service');
const { ROLES, STUDENT_STATUS, USER_STATUS } = require('../../config/constants');

const SORTABLE = Object.freeze(['id', 'name', 'relation', 'is_active', 'created_at']);

/** Profile columns a body may set. The account's own fields are not among them — see the schema. */
const EDITABLE = Object.freeze([
  'name',
  'relation',
  'phone',
  'occupation',
  'address',
  'national_id',
  /*
   * `photo_path` is deliberately absent — Known Issues #26. SRS §15.2 names no photo for
   * a parent, so the column has no writer at all and `pickEditable()` must never copy one
   * off a request body.
   */
  'is_active',
]);

/**
 * The `users` audit allow-list is **the table's**, not this module's.
 *
 * A local copy was written first and had already lost `phone`, `locale` and `must_change_password` —
 * two of which are columns this module sets at creation, so the audit row could not show that the
 * account was made with a typed password it must replace. `principals/` re-exports the shared list
 * for exactly this reason: two copies diverge the moment either module gains a column.
 */
const USER_AUDIT_FIELDS = usersService.AUDIT_FIELDS;

/**
 * Scope a `parent_students` query by its already-resolved parent.
 *
 * See the header: the table has `school_id` and no `organization_id`, so `tenantWhere()` cannot be
 * used on it. This is not a weaker check — `parent` reached the caller through `findById()`, which is
 * itself `tenantWhere`-confined against `parents` (a table that does carry both columns).
 */
function childScope(parent, where) {
  return { ...where, school_id: parent.school_id };
}

function pickEditable(payload) {
  const next = {};
  for (const key of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) next[key] = payload[key];
  }
  /* The profile's contact address is `parents.email`; the account's is `users.email`. */
  if (Object.prototype.hasOwnProperty.call(payload, 'contact_email')) {
    next.email = payload.contact_email;
  }
  return next;
}

/**
 * Four unique indexes can surface here, and the key in `err.fields` is the **index name**, not the
 * column. Read off the live schema rather than assumed, because the names are what the matching
 * depends on: `users_email_unique`, `users_username_unique`, `parents_user_unique`,
 * `parent_students_unique`.
 *
 * The tests are therefore **prefix**-matched, not `includes()`. A first revision used
 * `name.includes('user')` for the parent branch, which also matches `users_username_unique` and
 * `users_email_unique` — so a duplicate account email came back as `PARENT_USER_TAKEN`, a code about
 * an entirely different constraint. Substring matching against a namespace where one name is a
 * substring of another is a coin flip.
 *
 * The two account-side violations are handed to `usersService.rethrowUniqueViolation`, the mapper
 * `principals/` already uses. Restating them here would be a second copy of a message and a code the
 * §33 Users screen also emits, free to drift from it.
 */
function rethrow(err, payload) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    const indexes = Object.keys(err.fields || {});

    /* `parents_user_unique` — one parent per account, enforced by the database rather than a
       pre-check, because a pre-check alone would still race. */
    if (indexes.some((name) => name.startsWith('parents_user'))) {
      throw ApiError.conflict('That account already belongs to a parent', {
        code: 'PARENT_USER_TAKEN',
        details: {},
      });
    }
    /* `parent_students_unique` — normally caught by the explicit lookup in `linkChild`, so reaching
       here means two concurrent links won the same race. */
    if (indexes.some((name) => name.startsWith('parent_students'))) {
      throw ApiError.conflict('This child is already linked to this parent', {
        code: 'PARENT_CHILD_LINKED',
        details: { student_id: payload && payload.student_id },
      });
    }

    return usersService.rethrowUniqueViolation(err, payload);
  }
  if (err instanceof db.Sequelize.ValidationError) {
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  throw err;
}

async function parentRole() {
  const role = await db.Role.findOne({ where: { slug: ROLES.PARENT } });
  if (!role) {
    /* Boot-level: the seeded catalogue fixes the eleven roles (§29). */
    throw new Error("parents.service: the seeded 'parent' role is missing");
  }
  return role;
}

/**
 * A `student_id` may only name a student of the same school.
 *
 * FR-PARENT-001's precondition is "Student Profile(s) exist"; it does not say they may belong to
 * anyone else's school. Without this a parent of school A could be linked to school B's children and
 * the dashboard would then answer for them, which is the whole authorization boundary FR-PARENT-002
 * rests on.
 */
async function loadStudentInSchool(studentId, schoolId) {
  const student = await db.Student.findOne({ where: { id: studentId, school_id: schoolId } });
  if (!student) {
    throw ApiError.validation('student_id must name a student of this school', [
      { field: 'student_id', message: 'Name a students row of the same school' },
    ]);
  }
  return student;
}

async function findById(req, id, namedSchoolId = undefined) {
  const where = tenantWhere(req.tenant, { id });
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;

  /*
   * Keep the record and the entitlement guard on the same school — §5a defect 22.
   *
   * The platform caller is deliberately **not** excluded. `named` is only truthy when the caller named
   * a school themselves and `resolveSchool()` already handles all three scopes, so the exclusion
   * relaxed nothing — it discarded the one scope declaration a Super Admin can make, letting a request
   * that named school A read or write a row belonging to school B instead of answering 404.
   */
  if (named) {
    const school = await resolveSchool(req, named);
    where.school_id = school.id;
  }

  const row = await db.Parent.findOne({ where });
  if (!row) throw ApiError.notFound('Parent not found', { code: 'PARENT_NOT_FOUND' });
  return row;
}

/**
 * What a caller without `parents.manage` is not shown of a parent: identity documents and where they
 * live. A Teacher holds `parents.view` to reach a child's family, and read every parent's national ID
 * and address through it — and could search the school by national ID. See `utils/recordView.js`.
 */
const REGISTRY_ONLY = Object.freeze(['national_id', 'address', 'occupation']);

/** `GET /:id` — the parent as this caller may see them. */
async function findForView(req, id) {
  const row = await findById(req, id);
  return (await canManage(req, 'parents.manage')) ? row : withoutFields(row, REGISTRY_ONLY);
}

async function list(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  const full = await canManage(req, 'parents.manage');
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.is_active !== undefined) where.is_active = query.is_active;
  if (query.q) {
    where[Op.or] = [
      { name: { [Op.like]: `%${query.q}%` } },
      { phone: { [Op.like]: `%${query.q}%` } },
      /* Searchable by national ID only by those who may see it. */
      ...(full ? [{ national_id: { [Op.like]: `%${query.q}%` } }] : []),
    ];
  }

  /*
   * `?student_id=` — "who are this child's parents". A join rather than a second round trip, and
   * scoped by the same `school_id` the outer where already carries.
   */
  const options = {
    where,
    ...(full ? {} : { attributes: { exclude: [...REGISTRY_ONLY] } }),
    order: getSort({ query }, SORTABLE, ['name', 'ASC']),
  };
  if (query.student_id) {
    options.include = [
      {
        model: db.ParentStudent,
        as: 'links',
        attributes: [],
        required: true,
        where: { student_id: query.student_id },
      },
    ];
  }

  return paginateQuery(db.Parent, options, pagination);
}

/** FR-PARENT-001 — the account, the profile, and any children named at creation. */
async function create(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  const role = await parentRole();

  /* Checked before the transaction opens, so a bad child id does not roll back a created account. */
  const children = payload.children || [];
  for (const child of children) {
    // eslint-disable-next-line no-await-in-loop
    await loadStudentInSchool(child.student_id, school.id);
  }

  const password_hash = await hashPassword(payload.password);

  let created;
  try {
    created = await db.sequelize.transaction(async (t) => {
      const user = await db.User.create(
        {
          role_id: role.id,
          school_id: school.id,
          organization_id: school.organization_id,
          name: payload.name,
          email: payload.email,
          username: payload.username,
          phone: payload.phone ?? null,
          password_hash,
          /* An account created for an already-inactive parent must not be usable — see update(). */
          status: payload.is_active === false ? USER_STATUS.INACTIVE : USER_STATUS.ACTIVE,
          must_change_password: true,
        },
        { transaction: t }
      );

      const parent = await db.Parent.create(
        {
          school_id: school.id,
          organization_id: school.organization_id,
          user_id: user.id,
          name: payload.name,
          ...pickEditable(payload),
          is_active: payload.is_active !== undefined ? payload.is_active : true,
        },
        { transaction: t }
      );

      for (const child of children) {
        // eslint-disable-next-line no-await-in-loop
        await db.ParentStudent.create(
          {
            school_id: school.id,
            parent_id: parent.id,
            student_id: child.student_id,
            relation: child.relation ?? payload.relation ?? null,
            is_primary_guardian: child.is_primary_guardian === undefined ? false : child.is_primary_guardian,
          },
          { transaction: t }
        );
      }

      return { user, parent };
    });
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'users',
    recordId: created.user.id,
    event: 'create',
    before: null,
    after: snapshot(created.user, USER_AUDIT_FIELDS),
    reason: `Parent account created for school ${school.code}`,
  });
  await recordAudit(req, {
    tableName: 'parents',
    recordId: created.parent.id,
    event: 'create',
    before: null,
    after: snapshot(created.parent),
    reason: payload.reason || null,
  });

  /* §9.3 / §15 — issued at creation. A mail failure is logged, not fatal; see the header. */
  let verificationEmailSent = false;
  try {
    const result = await authService.sendVerificationEmail(created.user);
    verificationEmailSent = Boolean(result && result.issued);
  } catch (err) {
    logger.error('Parent created but the verification email could not be sent', {
      requestId: req.id,
      userId: created.user.id,
      error: err.message,
    });
  }

  return { parent: created.parent, verificationEmailSent };
}

async function update(req, id, payload) {
  const row = await findById(req, id, payload.school_id);

  const before = snapshot(row);
  const next = pickEditable(payload);
  if (!Object.keys(next).length) {
    throw ApiError.validation('No parent fields to update', [
      { field: 'body', message: 'Send at least one profile field' },
    ]);
  }

  /*
   * `is_active` has to reach the account, not just the profile.
   *
   * `parents.routes.js` says a parent who leaves is deactivated through this route — and for a while
   * that was a claim the code did not honour. This is the one people module that *owns* the `users`
   * row (it created it), so flipping a profile flag while leaving `users.status` at `active` meant a
   * "deactivated" parent kept signing in and kept reading their children through the dashboard. The
   * analogy to `teachers/` does not hold there: that module never creates an account, so it has none
   * to revoke.
   *
   * The two rows move together, in one transaction, and the account change is audited as its own
   * `users` row the way `create()` audits it.
   */
  const activeChanged =
    Object.prototype.hasOwnProperty.call(next, 'is_active') && Boolean(next.is_active) !== Boolean(row.is_active);

  let account = null;
  let accountBefore = null;
  try {
    await db.sequelize.transaction(async (t) => {
      if (activeChanged) {
        account = await db.User.findByPk(row.user_id, { transaction: t });
        if (account) {
          accountBefore = snapshot(account, USER_AUDIT_FIELDS);
          account.status = next.is_active ? USER_STATUS.ACTIVE : USER_STATUS.INACTIVE;
          await account.save({ transaction: t });
        }
      }
      row.set(next);
      await row.save({ transaction: t });
    });
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'parents',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  if (activeChanged && account) {
    await recordAudit(req, {
      tableName: 'users',
      recordId: account.id,
      event: 'update',
      before: accountBefore,
      after: snapshot(account, USER_AUDIT_FIELDS),
      reason: `Parent ${next.is_active ? 'reactivated' : 'deactivated'}`,
    });
  }

  return row;
}

/* ── FR-PARENT-001's second half: multiple children ── */

async function listChildren(req, id) {
  const parent = await findById(req, id);
  const rows = await db.ParentStudent.findAll({
    where: childScope(parent, { parent_id: parent.id }),
    include: [
      {
        model: db.Student,
        as: 'student',
        attributes: ['id', 'student_id', 'roll_number', 'first_name', 'last_name', 'class_id', 'section_id', 'status'],
      },
    ],
    order: [['id', 'ASC']],
  });
  return { parent, rows };
}

async function linkChild(req, id, payload) {
  const parent = await findById(req, id, payload.school_id);
  await loadStudentInSchool(payload.student_id, parent.school_id);

  const existing = await db.ParentStudent.findOne({
    where: childScope(parent, { parent_id: parent.id, student_id: payload.student_id }),
  });
  if (existing) {
    throw ApiError.conflict('This child is already linked to this parent', {
      code: 'PARENT_CHILD_LINKED',
      details: { parent_id: parent.id, student_id: payload.student_id },
    });
  }

  let row;
  try {
    row = await db.ParentStudent.create({
      school_id: parent.school_id,
      parent_id: parent.id,
      student_id: payload.student_id,
      relation: payload.relation ?? parent.relation ?? null,
      is_primary_guardian: payload.is_primary_guardian === undefined ? false : payload.is_primary_guardian,
    });
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'parent_students',
    recordId: row.id,
    event: 'create',
    before: null,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  return row;
}

async function unlinkChild(req, id, linkId) {
  const parent = await findById(req, id);
  const row = await db.ParentStudent.findOne({
    where: childScope(parent, { id: linkId, parent_id: parent.id }),
  });
  if (!row) throw ApiError.notFound('Child link not found', { code: 'PARENT_CHILD_NOT_FOUND' });

  const before = snapshot(row);
  await row.destroy();
  await recordAudit(req, {
    tableName: 'parent_students',
    recordId: row.id,
    event: 'delete',
    before,
    after: null,
  });
  return row;
}

/**
 * FR-PARENT-002 — the dashboard, for the *authenticated* parent.
 *
 * Resolved from `req.user.id`, never from a path id: `parents.dashboard.view` is a key every parent
 * holds, so a path id would let one parent read another's children by changing a number. The same
 * reasoning as `teachers.dashboard`.
 *
 * FR-PARENT-002's precondition is "Parent Account exists **and is linked to at least one student**",
 * so a parent with no children is a legitimate 200 with an empty list rather than an error — the
 * precondition describes when the dashboard is useful, not when it is permitted.
 */
async function dashboard(req) {
  if (!req.user || !req.user.id) {
    throw ApiError.unauthenticated('This dashboard is for a signed-in parent');
  }

  const parent = await db.Parent.findOne({ where: tenantWhere(req.tenant, { user_id: req.user.id }) });
  if (!parent) {
    throw ApiError.notFound('No parent profile is linked to this account', {
      code: 'PARENT_PROFILE_MISSING',
      details: { user_id: req.user.id },
    });
  }

  /* Defence in depth. Deactivating a parent disables the account, so this should be unreachable —
     but the dashboard is the one route that serves another person's children, and it should not
     depend on a second table's column having been updated correctly. */
  if (!parent.is_active) {
    throw ApiError.forbidden('This parent account is no longer active', {
      code: 'PARENT_INACTIVE',
      details: { parent_id: parent.id },
    });
  }

  const links = await db.ParentStudent.findAll({
    where: childScope(parent, { parent_id: parent.id }),
    include: [
      {
        model: db.Student,
        as: 'student',
        attributes: ['id', 'student_id', 'roll_number', 'first_name', 'last_name', 'class_id', 'section_id', 'status'],
        /*
         * The class and section by name. A parent holds no `classes.view`, so the two ids alone left the
         * dashboard unable to say which class a child is in — SRS:842, "relevant information for their
         * children".
         */
        include: [
          { model: db.Class, as: 'class', attributes: ['id', 'name'] },
          { model: db.Section, as: 'section', attributes: ['id', 'name'] },
        ],
      },
    ],
    order: [['id', 'ASC']],
  });

  const students = links.map((l) => l.student).filter(Boolean);

  return {
    parent,
    counts: {
      children: links.length,
      activeChildren: students.filter((s) => s.status === STUDENT_STATUS.ACTIVE).length,
    },
    children: links,
  };
}

module.exports = {
  list,
  findById,
  findForView,
  REGISTRY_ONLY,
  create,
  update,
  listChildren,
  linkChild,
  unlinkChild,
  dashboard,
  EDITABLE,
};
