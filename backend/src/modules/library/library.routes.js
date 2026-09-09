'use strict';

/**
 * Library routes — mounted at `/api/v1/library`.
 *
 * | SRS  | FR         | Route                            | Permission       |
 * |------|------------|----------------------------------|------------------|
 * | 20.4 | FR-LIB-001 | `GET /books`                     | `library.view`   |
 * | 20.4 | FR-LIB-001 | `POST /books`                    | `library.manage` |
 * | 20.4 | FR-LIB-001 | `GET /books/:id`                 | `library.view`   |
 * | 20.4 | FR-LIB-001 | `PATCH /books/:id`               | `library.manage` |
 * | 20.4 | FR-LIB-002 | `GET /transactions`              | `library.view`   |
 * | 20.4 | FR-LIB-002 | `GET /transactions/:id`          | `library.view`   |
 * | 20.4 | FR-LIB-002 | `POST /transactions`             | `library.issue`  |
 * | 20.4 | FR-LIB-002 | `PATCH /transactions/:id/return` | `library.issue`  |
 * | 20.4 | FR-LIB-002 | `PATCH /transactions/:id/fine`   | `library.issue`  |
 *
 * `requireModule(MODULES.LIBRARY)` router-level. **No `enforceLimit`** — §11.2's eight limits contain
 * nothing library-shaped, and neither a book nor a loan is a headcount. Asserted by reading the router's
 * source with comments stripped, not by a handler name.
 *
 * Every path is prefixed by a literal collection, so unlike §20.3 nothing here depends on declaration
 * order. Said because the adjacent module's does.
 *
 * ## The three permissions map onto the two FRs
 *
 * `library.manage` is FR-LIB-001's — *"Librarian creates/manages Book records"* — and `library.issue` is
 * FR-LIB-002's — *"Librarian issues a book… records a book return… System calculates/records a Fine"*.
 * Both reach **Librarian**, the actor both FRs name, plus Principal, School Admin and Super Admin.
 *
 * `library.view` additionally reaches **Student**, and nobody else outside that set. This is the module
 * where the difference between a *borrower* and a *caller* matters: a book may be issued to a student, a
 * teacher or a staff member, but a **Teacher holds no library permission at all** and neither does a
 * Parent. So a teacher can borrow a book and cannot look up the loan. That is a property of the fixed
 * catalogue (§29/§35), it is asserted against the catalogue itself, and it is stated here so the gap
 * reads as a decision that was checked rather than one that was missed.
 *
 * A student's **catalogue** is not narrowed — FR-LIB-001's outcome is that the catalogue "is available",
 * and a catalogue nobody may browse is not one. A student's **transactions** are narrowed to their own,
 * on the read by id as well as the list, for the reason §20.3 narrowed submissions by student.
 *
 * ## Why the fine has its own route
 *
 * Calculating a fine and settling one are separate events: the system calculates it when the book comes
 * back, and the borrower pays it — or the librarian waives it — whenever that happens. Folding the two
 * into the return would make an unpaid fine unrecordable, which is most of what "manages associated
 * fines" is about.
 *
 * ## No DELETE, and no upload
 *
 * §20.4 names neither. A book is retired with `is_active: false`, which also stops it being issued;
 * deleting one would cascade its loan history away with it. `books.cover_path` exists as a column but
 * §20.4 names no cover and `upload.js` has no profile for one, so it is `forbidden()` in both book
 * schemas rather than becoming Known Issues #26's sixth caller-supplied path.
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

const controller = require('./library.controller');
const { schemas } = require('./library.validation');

const router = createRouter();

router.use(requireModule(MODULES.LIBRARY));

/* ── FR-LIB-001 — the catalogue ── */

router.get(
  '/books',
  requirePermission('library.view'),
  validate({ query: schemas.listBooks }),
  asyncHandler(controller.listBooks)
);

router.post(
  '/books',
  requirePermission('library.manage'),
  validate({ body: schemas.createBook }),
  logActivity({ action: 'create', entityType: 'books', onlyOnSuccess: true }),
  asyncHandler(controller.createBook)
);

router.get(
  '/books/:id',
  requirePermission('library.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.showBook)
);

router.patch(
  '/books/:id',
  requirePermission('library.manage'),
  validate({ params: schemas.idParam, body: schemas.updateBook }),
  logActivity({ action: 'update', entityType: 'books', onlyOnSuccess: true }),
  asyncHandler(controller.updateBook)
);

/* ── FR-LIB-002 — issue, return, fine ── */

router.get(
  '/transactions',
  requirePermission('library.view'),
  validate({ query: schemas.listTransactions }),
  asyncHandler(controller.listTransactions)
);

router.get(
  '/transactions/:id',
  requirePermission('library.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.showTransaction)
);

router.post(
  '/transactions',
  requirePermission('library.issue'),
  validate({ body: schemas.issue }),
  logActivity({ action: 'create', entityType: 'library_transactions', onlyOnSuccess: true }),
  asyncHandler(controller.issue)
);

router.patch(
  '/transactions/:id/return',
  requirePermission('library.issue'),
  validate({ params: schemas.idParam, body: schemas.returnBook }),
  logActivity({ action: 'update', entityType: 'library_transactions', onlyOnSuccess: true }),
  asyncHandler(controller.returnLoan)
);

router.patch(
  '/transactions/:id/fine',
  requirePermission('library.issue'),
  validate({ params: schemas.idParam, body: schemas.settleFine }),
  logActivity({ action: 'update', entityType: 'library_transactions', onlyOnSuccess: true }),
  asyncHandler(controller.settleFine)
);

module.exports = router;
