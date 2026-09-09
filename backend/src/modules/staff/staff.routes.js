'use strict';

/**
 * Staff routes — mounted at `/api/v1/staff`.
 *
 * | SRS   | FR           | Route        | Guards                                        |
 * |-------|--------------|--------------|-----------------------------------------------|
 * | §15.4 | FR-STAFF-001 | `GET /`      | `staff` module · `staff.view`                 |
 * | §15.4 | FR-STAFF-001 | `POST /`     | `staff` module · `staff.manage` · limit       |
 * | §15.4 | FR-STAFF-001 | `GET /:id`   | `staff` module · `staff.view`                 |
 * | §15.4 | FR-STAFF-001 | `PATCH /:id` | `staff` module · `staff.manage`               |
 *
 * The smallest of the four §15 modules, and deliberately so: FR-STAFF-001 says only "creates/manages
 * staff records under the categories Receptionist, Accountant, Librarian, and Other Staff". There is
 * **no dashboard** — §15.3 and §15.2 each name one and §15.4 does not — and no lifecycle operations,
 * which §15.1 has and this does not. Adding either would be inventing a requirement.
 *
 * `requireModule(MODULES.STAFF)` is mounted router-level, as in the other three Phase 3.J modules:
 * the `module` field on a permission is metadata that nothing in the request path reads, so the guard
 * has to be explicit or a school on a plan without the Staff module would still reach every route.
 *
 * `POST /` carries `enforceLimit('staff_limit')`. That guard only sees creation, and `staff_limit`
 * counts `is_active: true` — so `staff.service.update()` asserts the same ceiling on the
 * **re-activation** transition. `teachers/` shipped without that second check and it became §5a
 * defect 21; it is here from the start.
 *
 * There is no literal route to collide with `GET /:id`, so no ordering constraint applies — unlike
 * `/teachers/dashboard` and `/sessions/current`. No DELETE: §15.4 names none.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireModule,
  enforceLimit,
} = require('../../middlewares');
const { MODULES, LIMITS } = require('../../config/constants');

const controller = require('./staff.controller');
const { schemas } = require('./staff.validation');

const router = createRouter();

router.use(requireModule(MODULES.STAFF));

router.get(
  '/',
  requirePermission('staff.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

router.post(
  '/',
  requirePermission('staff.manage'),
  validate({ body: schemas.create }),
  /*
   * The increment follows the flag the headcount counts, not the fact of a row existing.
   *
   * `staff_limit` counts `is_active: true` (`usageService.js`), and the module already asserts the
   * ceiling on the *re-activation* transition for that reason — but `POST` charged a flat 1 whatever
   * the body said. A record created **inactive** therefore consumed an allowance it was not counted
   * in, and a school at its ceiling could not enter someone who had already left. It failed closed,
   * so there was no bypass; the cost was a record that could not be entered until an active one was
   * deactivated.
   *
   * Known Issue #22's recorded action said to change all three headcount modules together. Two:
   * `students` refuses `status` on create outright (`students.validation.js:80`, "set by promote /
   * transfer / leave, not by this request"), so a student cannot be created inactive and its flat 1
   * is already correct. Branching there would be dead code on a field the schema rejects.
   */
  enforceLimit(LIMITS.STAFF_LIMIT, {
    increment: (req) => (req.body && req.body.is_active === false ? 0 : 1),
  }),
  logActivity({ action: 'create', entityType: 'staff', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id',
  requirePermission('staff.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePermission('staff.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'staff', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

module.exports = router;
