'use strict';

/**
 * Fee routes — mounted at `/api/v1/fees`.
 *
 * | SRS | FR         | Route                    | Permission     |
 * |-----|------------|--------------------------|----------------|
 * | §17 | FR-FEE-001 | `GET  /structures`       | `fees.view`    |
 * | §17 | FR-FEE-001 | `POST /structures`       | `fees.manage`  |
 * | §17 | FR-FEE-001 | `GET  /structures/:id`   | `fees.view`    |
 * | §17 | FR-FEE-001 | `PATCH /structures/:id`  | `fees.manage`  |
 * | §17 | FR-FEE-001 | `POST /assignments`      | `fees.manage`  |
 * | §17 | FR-FEE-002 | `GET  /ledger`           | `fees.view`    |
 * | §17 | FR-FEE-002 | `POST /payments`         | `fees.collect` |
 * | §17 | FR-FEE-002 | `GET  /payments`         | `fees.view`    |
 *
 * ## The permission split is the SRS's two actor lists, and it is already in the seeded catalogue
 *
 * FR-FEE-001's actors are Principal / School Admin / Accountant, and `fees.manage` is granted to
 * exactly those three (plus Super Admin). FR-FEE-002's are Accountant / Receptionist, and
 * `fees.collect` reaches both — plus Principal and School Admin, which is **wider** than FR-FEE-002's
 * list. That widening is the seeded catalogue's, not this module's: the 109 permissions and their
 * default grants are fixed by §29/§30 and a Principal who runs the school being able to take a payment
 * is not a reading this router is licensed to narrow. It is written down here rather than left to be
 * rediscovered, and the suite asserts the receptionist's shape — `collect` **but not** `manage` — since
 * that is the one place the two lists genuinely differ.
 *
 * `fees.self.view` is mounted on `GET /mine` — the owner's decision D17, with `students.self.view` and
 * `attendance.self.view` beside it in their own routers. It had no endpoint while §17 was read as
 * naming no self-service view; SRS:105 and SRS:835 settled it once D17 was decided.
 *
 * ## Why `/assignments` exists
 *
 * FR-FEE-001's Expected Outcome is "Fee Structure is available for **assignment** to students" and
 * FR-FEE-002's precondition is "Fee Structure **is assigned** to the student". The source names the
 * operation at both ends without giving it its own FR, so it is implemented as the bridge between the
 * two rather than invented: without it FR-FEE-002 has no precondition it could ever satisfy.
 *
 * It is `fees.manage`, not `fees.collect` — assigning a fee decides what a family owes, which is the
 * FR-FEE-001 half of the module. A receptionist may take money against a fee; they may not create one.
 *
 * ## No DELETE, on any of the three tables
 *
 * §17 names none, and each would destroy a financial record: deleting a `fee_payments` row would erase
 * a receipt already handed to a parent and silently raise the balance again, and deleting a
 * `student_fees` row cascades into its payments (`onDelete: 'CASCADE'` in `models/finance.js`). A fee
 * that should not be collected is `waived` — a status the schema has and §17 does not describe an
 * operation for, so it is not implemented either (see the service header). `PATCH /structures/:id` with
 * `is_active: false` is how a school retires a component it no longer charges.
 *
 * `requireModule(MODULES.FEES)` is mounted router-level, as in every module since Phase 3.J. **No
 * `enforceLimit`**: §11.2's eight limits contain nothing fee-shaped, and neither a structure nor a
 * ledger row is a headcount. Asserted in the suite so a later reader does not add one.
 *
 * `/structures/:id` is declared after the literal `/structures`, and `/assignments`, `/ledger` and
 * `/payments` are separate paths — no parameter can shadow them.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireModule,
} = require('../../middlewares');
const { MODULES } = require('../../config/constants');

const controller = require('./fees.controller');
const { schemas } = require('./fees.validation');

const router = createRouter();

router.use(requireModule(MODULES.FEES));

/*
 * The owner's decision D17 — a student's own fees, or each linked child's for a parent, on
 * `fees.self.view` ("View own / child fees"), which the catalogue granted both and nothing mounted.
 */
router.get(
  '/mine',
  requirePermission('fees.self.view'),
  validate({ query: schemas.mine }),
  asyncHandler(controller.mine)
);

/* ── FR-FEE-001 ── */

router.get(
  '/structures',
  requirePermission('fees.view'),
  validate({ query: schemas.listStructures }),
  asyncHandler(controller.listStructures)
);

router.post(
  '/structures',
  requirePermission('fees.manage'),
  validate({ body: schemas.createStructure }),
  logActivity({ action: 'create', entityType: 'fee_structure', onlyOnSuccess: true }),
  asyncHandler(controller.createStructure)
);

router.get(
  '/structures/:id',
  requirePermission('fees.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.showStructure)
);

router.patch(
  '/structures/:id',
  requirePermission('fees.manage'),
  validate({ params: schemas.idParam, body: schemas.updateStructure }),
  logActivity({ action: 'update', entityType: 'fee_structure', onlyOnSuccess: true }),
  asyncHandler(controller.updateStructure)
);

router.post(
  '/assignments',
  requirePermission('fees.manage'),
  validate({ body: schemas.assign }),
  logActivity({ action: 'create', entityType: 'student_fee', onlyOnSuccess: true }),
  asyncHandler(controller.assign)
);

/* ── FR-FEE-002 ── */

router.get(
  '/ledger',
  requirePermission('fees.view'),
  validate({ query: schemas.listLedger }),
  asyncHandler(controller.listLedger)
);

router.post(
  '/payments',
  requirePermission('fees.collect'),
  validate({ body: schemas.pay }),
  logActivity({ action: 'create', entityType: 'fee_payment', onlyOnSuccess: true }),
  asyncHandler(controller.pay)
);

router.get(
  '/payments',
  requirePermission('fees.view'),
  validate({ query: schemas.listPayments }),
  asyncHandler(controller.listPayments)
);

module.exports = router;
