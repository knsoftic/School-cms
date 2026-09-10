'use strict';

/**
 * User routes — mounted at `/api/v1/users`.
 *
 * ## Scope of this module
 *
 * SRS §33 lists **"Users"** among the Super Admin MVP screens. That single line is all the source says:
 * there is no `FR-USER-nnn`, and §9's requirements end at FR-SADMIN-009. The routes below are therefore
 * held to the two requirements that do describe behaviour on a user record — FR-AUTH-007 (account
 * status) and FR-AUTH-009 (permission middleware) — plus the §29 `users` columns:
 *
 *  - `GET /`                  the screen itself.
 *  - `GET /permissions`       the assignable vocabulary, so the overrides below can be chosen from a
 *                             list rather than typed.
 *  - `POST /`                 a login for a school person — the owner's decision D1.
 *  - `GET /:id`               one account, with its role grant, overrides and effective set.
 *  - `PATCH /:id`             edit. FR-AUTH-007's `status` is one of the six accepted columns.
 *  - `PUT /:id/permissions`   the per-user overrides FR-AUTH-009 resolves against.
 *
 * ## `POST /` — and why this header once said there would be none
 *
 * It used to argue that every role already had a creation path — "§9.3 / FR-SADMIN-009 for a
 * Principal, §15 for Teacher, Staff, Student and Parent" — and that was false for all but the first
 * and last: §15 creates a teacher's, staff member's or student's *profile*, and only a Parent's comes
 * with an account. FR-TEACHER-002's precondition is "Teacher account exists" and nothing created it,
 * so no teacher, staff member or student could sign in. The owner's decision D1
 * (`docs/OWNER-DECISIONS.md`) gave the school that path: `users.manage` — already "Create / edit
 * users" in the catalogue and already the school leadership's — creates a login for someone on record
 * and links it to their profile, or a School Admin login, capped by `admin_limit` (D2). A Principal and
 * a Parent keep their own paths and are refused here, so no role has two.
 *
 * ## No DELETE
 *
 * **No `DELETE /users/:id`.** FR-SADMIN-006 specifies delete/archive for a *school*; nothing in the
 * source deletes a person. FR-AUTH-007's status column is the specified way to stop an account being
 * used, and `authenticate` enforces it on every request. Deleting a user who owns marks, attendance and
 * fee rows is also a decision with consequences the source never authorises anyone to make.
 *
 * ## Guards
 *
 * `GET /permissions` takes `requireAnyPermission('users.manage', 'roles.view')` rather than
 * `roles.view` alone. `SCHOOL_LEADERSHIP` in `config/permissions.js` grants Principal and School Admin
 * `users.manage` but deliberately not `roles.view` — only `super_admin` holds that — so requiring
 * `roles.view` would let a Principal write an override while forbidding them to read the list of keys
 * they may choose from.
 *
 * `PUT /:id/permissions` takes `users.manage`, **not** `roles.manage`. It writes the `users` row, which
 * is tenant-scoped, so a Principal adjusting one teacher's access affects nobody else's school; and
 * `users.service.assertGrantable()` bounds it to permissions the caller holds themselves. Editing a
 * *role* is the platform-wide operation and lives in the roles module, which is why that one is
 * `roles.manage` and platform-only.
 *
 * None of these carry `requirePlatformScope()`. `users.view` is held by Organization Admin and
 * `users.manage` by school leadership, both by design, and the tenant columns confine each caller —
 * `tenantWhere()` in the service, with `enforceTenant` already above at router level.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireAnyPermission,
} = require('../../middlewares');

const controller = require('./users.controller');
const { schemas } = require('./users.validation');

const router = createRouter();

router.get(
  '/',
  requirePermission('users.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

/*
 * Declared before `/:id`. Express matches in definition order, so the literal path wins; reversed, the
 * request would reach the id route and be refused as a non-numeric id — a 422 that would look like a
 * client mistake rather than a routing one.
 */
router.get(
  '/permissions',
  requireAnyPermission('users.manage', 'roles.view'),
  asyncHandler(controller.catalogue)
);

router.post(
  '/',
  requirePermission('users.manage'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'user', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id',
  requirePermission('users.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePermission('users.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'user', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

/* ───────────────── FR-AUTH-009 — per-user permission overrides ────────────────── */

router.put(
  '/:id/permissions',
  requirePermission('users.manage'),
  validate({ params: schemas.idParam, body: schemas.setPermissions }),
  logActivity({ action: 'update', entityType: 'user', onlyOnSuccess: true }),
  asyncHandler(controller.setPermissions)
);

module.exports = router;
