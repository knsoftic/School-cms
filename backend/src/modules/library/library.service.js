'use strict';

/**
 * Library — SRS §20.4, FR-LIB-001 (catalogue) and FR-LIB-002 (issue, return, fine).
 *
 * Two tables, `books` and `library_transactions`, both carrying `school_id` **and** `organization_id`,
 * so `tenantWhere()` is safe on both. Neither has a unique index and neither wants one: a school may
 * legitimately hold two catalogue entries for the same title, and a borrower may hold two copies.
 *
 * ## `available_quantity` is the first shared counter in this project
 *
 * Every other module's writes are independent rows. Here two librarians issuing the last copy of a book
 * are contending for **one number**, and a plain read-then-write loses one of the decrements: both read
 * `available_quantity = 1`, both write `0`, and two copies leave the building.
 *
 * So `issue()`, `returnLoan()` and the quantity half of `updateBook()` all run inside a transaction with
 * a **locking read** on the book row — `fees.pay()`'s posture, which the §5a record shows is the one that
 * works, rather than `fees.alreadyAssigned()`'s, which is the one that does not. Every caller locks the
 * same single row, so there is nothing to deadlock against.
 *
 * The invariant the whole module maintains is:
 *
 *     quantity - available_quantity === the number of copies currently on loan
 *
 * which is why editing `quantity` moves `available_quantity` by the same delta rather than leaving it,
 * and why an edit that would drive it negative is refused. The model's `availableWithinQuantity`
 * validator catches only the other direction.
 *
 * ## Overdue is derived, never stored
 *
 * `LIBRARY_TRANSACTION_STATUS` carries an `overdue` value and nothing writes it. Storing it would need a
 * scheduled sweep that §20.4 does not ask for, and a stored flag is **wrong every day between the due
 * date and the next sweep**. So `present()` derives `is_overdue` and `days_overdue` from `due_date` and
 * today, and a `status=overdue` filter is translated into "issued, and past due". The stored column
 * therefore only ever holds `issued`, `returned` or `lost` — recorded rather than left to be discovered.
 *
 * ## The fine
 *
 * FR-LIB-002 says *"System calculates/records a Fine where applicable"*, so the fine is **computed, not
 * entered**: `fine_per_day` from the book times whole days past `due_date`, through `utils/money.js`
 * integer-minor-unit arithmetic rather than by hand. Calculating it and settling it are separate routes,
 * because they are separate events — a fine that could only be recorded at the moment of payment could
 * not be recorded at all for a borrower who has not paid yet.
 *
 * ## Who may see what
 *
 * `library.manage` (FR-LIB-001's actor) and `library.issue` (FR-LIB-002's) both reach Librarian,
 * Principal, School Admin and Super Admin. `library.view` additionally reaches **Student** — and no
 * other borrower: a Teacher holds no library permission at all, which makes the point that a *borrower*
 * is not a *caller* here.
 *
 * A student's catalogue is not narrowed — FR-LIB-001's outcome is that the catalogue "is available",
 * and a catalogue nobody may browse is not one. Their **transactions** are narrowed to their own, for
 * the reason §20.3 narrowed submissions by student: the alternative discloses who borrowed what.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const dates = require('../../utils/dates');
const money = require('../../utils/money');
const { resolveSchool } = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { LIBRARY_TRANSACTION_STATUS, LIBRARY_BORROWER_TYPES } = require('../../config/constants');

const BOOK_SORTABLE = Object.freeze(['id', 'title', 'author', 'category', 'quantity', 'created_at']);
const TXN_SORTABLE = Object.freeze(['id', 'issue_date', 'due_date', 'return_date', 'created_at']);

const BOOK_EDITABLE = Object.freeze([
  'title', 'author', 'category', 'isbn', 'publisher', 'edition', 'language',
  'rack_number', 'description', 'quantity', 'price', 'fine_per_day', 'loan_days', 'is_active',
]);

/** The borrower column each `borrower_type` uses, so the mapping is written once. */
const BORROWER_COLUMN = Object.freeze({
  [LIBRARY_BORROWER_TYPES.STUDENT]: 'student_id',
  [LIBRARY_BORROWER_TYPES.TEACHER]: 'teacher_id',
  [LIBRARY_BORROWER_TYPES.STAFF]: 'staff_id',
});

const BORROWER_MODEL = Object.freeze({
  [LIBRARY_BORROWER_TYPES.STUDENT]: 'Student',
  [LIBRARY_BORROWER_TYPES.TEACHER]: 'Teacher',
  [LIBRARY_BORROWER_TYPES.STAFF]: 'Staff',
});

function pick(payload, allowed) {
  const next = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) next[key] = payload[key];
  }
  return next;
}

function dateOnly(value) {
  return value === undefined || value === null || value === '' ? value : dates.toDateOnly(value);
}

/**
 * A book as a caller sees it.
 *
 * `cover_path` is removed for the reason every stored path is removed in this codebase: a path in a
 * response is a directory layout in a response, and there is nothing to fetch it with. `on_loan` is
 * added because it is the number a librarian actually wants and the one the invariant is about.
 */
function presentBook(row) {
  const json = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
  delete json.cover_path;
  return {
    ...json,
    on_loan: Number(row.quantity) - Number(row.available_quantity),
    is_available: Number(row.available_quantity) > 0,
  };
}

/** Whole days a loan is past its due date, at `at`; never negative. */
function daysOverdue(dueDate, at = new Date()) {
  if (!dueDate) return 0;
  const days = dates.daysBetween(dueDate, dateOnly(at));
  return days > 0 ? days : 0;
}

/**
 * A transaction as a caller sees it.
 *
 * `is_overdue` and `days_overdue` are derived here rather than stored — see the file header. An open
 * loan is overdue when today is past its due date; a closed one never is, however late it came back,
 * because the fine already records that.
 */
function presentTransaction(row) {
  const json = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
  const open = row.status === LIBRARY_TRANSACTION_STATUS.ISSUED;
  const overdue = open ? daysOverdue(row.due_date) : 0;
  const outstanding = row.fine_waived
    ? 0
    : money.clampNonNegative(money.subtract(row.fine_amount || 0, row.fine_paid || 0));
  return {
    ...json,
    is_overdue: open && overdue > 0,
    days_overdue: overdue,
    fine_outstanding: outstanding,
  };
}

function rethrow(err) {
  if (err instanceof db.Sequelize.ValidationError) {
    /* `availableWithinQuantity`, `borrowerMatchesType` and `dueNotBeforeIssue` live on the models. */
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  if (err instanceof db.Sequelize.ForeignKeyConstraintError) {
    throw ApiError.validation('A referenced record does not exist', [
      { field: 'body', message: 'One of the records this row refers to no longer exists' },
    ]);
  }
  throw err;
}

async function narrowSchool(req, namedSchoolId, where) {
  if (namedSchoolId) {
    const school = await resolveSchool(req, namedSchoolId);
    where.school_id = school.id;
  }
  return where;
}

/**
 * The student a self-service caller is, or `null` for a caller who is not one.
 *
 * Only students are considered, because only Student holds `library.view` among the non-staff roles —
 * Parent holds no library permission at all, and neither does Teacher. Checked against the catalogue in
 * the suite so this reads as a fact about the seeded grants rather than an oversight.
 */
async function selfScopeStudent(req) {
  if (!req.user || !req.user.id) return null;
  return db.Student.findOne({ where: tenantWhere(req.tenant, { user_id: req.user.id }) });
}

/* ══════════════════ FR-LIB-001 — the catalogue ══════════════════ */

async function findBookById(req, id, namedSchoolId = undefined, options = {}) {
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;
  const where = await narrowSchool(req, named, tenantWhere(req.tenant, { id }));
  const row = await db.Book.findOne({
    where,
    transaction: options.transaction,
    ...(options.lock ? { lock: options.transaction.LOCK.UPDATE } : {}),
  });
  if (!row) throw ApiError.notFound('Book not found', { code: 'BOOK_NOT_FOUND' });
  return row;
}

async function listBooks(req, query, pagination) {
  const where = await narrowSchool(req, query.school_id, tenantWhere(req.tenant, {}));
  for (const field of ['category', 'author', 'is_active']) {
    if (query[field] !== undefined) where[field] = query[field];
  }
  if (query.available !== undefined) {
    where.available_quantity = query.available ? { [Op.gt]: 0 } : 0;
  }
  if (query.q) {
    where[Op.or] = [
      { title: { [Op.like]: `%${query.q}%` } },
      { author: { [Op.like]: `%${query.q}%` } },
      { isbn: { [Op.like]: `%${query.q}%` } },
    ];
  }

  const result = await paginateQuery(
    db.Book,
    { where, order: getSort({ query }, BOOK_SORTABLE, ['title', 'ASC']) },
    pagination
  );
  return { rows: result.rows.map(presentBook), count: result.count };
}

/** FR-LIB-001 — the librarian creates a book record with author, category and quantity. */
async function createBook(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  const next = pick(payload, BOOK_EDITABLE);
  /*
   * A brand-new catalogue entry has no copies on loan, so every copy is available. Deriving it here
   * rather than accepting it keeps the invariant true from the first row.
   */
  const quantity = next.quantity !== undefined ? Number(next.quantity) : 1;

  try {
    const row = await db.Book.create({
      school_id: school.id,
      organization_id: school.organization_id,
      ...next,
      quantity,
      available_quantity: quantity,
    });
    await recordAudit(req, {
      tableName: 'books',
      recordId: row.id,
      event: 'create',
      before: null,
      after: snapshot(row),
      reason: payload.reason || null,
    });
    return row;
  } catch (err) {
    return rethrow(err);
  }
}

/**
 * FR-LIB-001 — the librarian edits a book record.
 *
 * A `quantity` change moves `available_quantity` by the **same delta**, so the copies on loan stay what
 * they are. Setting quantity to fewer than the copies currently out is refused: the alternative is a
 * negative available count that the column (INTEGER UNSIGNED) cannot even hold, and a catalogue whose
 * arithmetic no longer describes the shelf.
 *
 * The whole edit takes a locking read, because a concurrent issue would otherwise change
 * `available_quantity` between the delta being computed and being written.
 */
async function updateBook(req, id, payload) {
  let result;
  try {
    result = await db.sequelize.transaction(async (transaction) => {
      const row = await findBookById(req, id, payload.school_id, { transaction, lock: true });
      const before = snapshot(row);
      const next = pick(payload, BOOK_EDITABLE);
      if (!Object.keys(next).length) {
        throw ApiError.validation('No book fields to update', [
          { field: 'body', message: 'Send at least one field' },
        ]);
      }

      if (next.quantity !== undefined) {
        const onLoan = Number(row.quantity) - Number(row.available_quantity);
        const nextQuantity = Number(next.quantity);
        if (nextQuantity < onLoan) {
          throw ApiError.conflict(
            `That book has ${onLoan} cop${onLoan === 1 ? 'y' : 'ies'} on loan, so its quantity cannot go below ${onLoan}`,
            { code: 'QUANTITY_BELOW_LOANS' }
          );
        }
        next.available_quantity = nextQuantity - onLoan;
      }

      row.set(next);
      await row.save({ transaction });
      return { row, before };
    });
  } catch (err) {
    return rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'books',
    recordId: result.row.id,
    event: 'update',
    before: result.before,
    after: snapshot(result.row),
    reason: payload.reason || null,
  });
  return result.row;
}

/* ══════════════════ FR-LIB-002 — issue, return, fine ══════════════════ */

async function findTransactionById(req, id, namedSchoolId = undefined, options = {}) {
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;
  const where = await narrowSchool(req, named, tenantWhere(req.tenant, { id }));
  const row = await db.LibraryTransaction.findOne({ where, transaction: options.transaction });
  if (!row) throw ApiError.notFound('Library transaction not found', { code: 'LIBRARY_TRANSACTION_NOT_FOUND' });

  /*
   * A student is confined on a read by id as well as on the list. A narrowing that applied only to the
   * list would be a courtesy any caller could step around by guessing an id — §20.2's lesson, and
   * §20.3's.
   */
  const student = await selfScopeStudent(req);
  if (student && Number(row.student_id) !== Number(student.id)) {
    throw ApiError.notFound('Library transaction not found', { code: 'LIBRARY_TRANSACTION_NOT_FOUND' });
  }
  return row;
}

async function listTransactions(req, query, pagination) {
  const where = await narrowSchool(req, query.school_id, tenantWhere(req.tenant, {}));
  for (const field of ['book_id', 'borrower_type', 'student_id', 'teacher_id', 'staff_id']) {
    if (query[field] !== undefined) where[field] = query[field];
  }
  if (query.issued_from || query.issued_to) {
    where.issue_date = {
      ...(query.issued_from ? { [Op.gte]: dateOnly(query.issued_from) } : {}),
      ...(query.issued_to ? { [Op.lte]: dateOnly(query.issued_to) } : {}),
    };
  }
  if (query.status !== undefined) {
    if (query.status === LIBRARY_TRANSACTION_STATUS.OVERDUE) {
      /* Derived, because nothing writes the stored value — see the file header. */
      where.status = LIBRARY_TRANSACTION_STATUS.ISSUED;
      where.due_date = { [Op.lt]: dates.toDateOnly(new Date()) };
    } else {
      where.status = query.status;
    }
  }
  if (query.fine_outstanding !== undefined) {
    /*
     * A column-to-column comparison, because "outstanding" is `fine_amount > fine_paid` and neither
     * side is a constant. A waived fine is settled whatever the two numbers say, which is the point of
     * the flag.
     */
    const paid = db.Sequelize.col('fine_paid');
    Object.assign(
      where,
      query.fine_outstanding
        ? { fine_waived: false, fine_amount: { [Op.gt]: paid } }
        : { [Op.or]: [{ fine_waived: true }, { fine_amount: { [Op.lte]: paid } }] }
    );
  }

  const student = await selfScopeStudent(req);
  if (student) {
    /*
     * By borrower, not by school. A student holding `library.view` would otherwise read the whole
     * school's borrowing history, which is a disclosure §20.4 never asks for. A `student_id` filter
     * naming somebody else resolves to nothing rather than overriding this.
     */
    where.student_id = query.student_id !== undefined && Number(query.student_id) !== Number(student.id)
      ? { [Op.in]: [0] }
      : student.id;
  }

  const result = await paginateQuery(
    db.LibraryTransaction,
    {
      where,
      /*
       * The borrower is included as well as the book, because a loans register that cannot say who
       * has the book is not a register. The three associations already exist on the model; only one
       * of them is ever populated, decided by `borrower_type`, and the other two come back null —
       * which is what the column branches on.
       *
       * Narrow attributes on purpose: a name and the school's own identifier, nothing else. The
       * borrower rows carry guardian phone numbers, addresses and photo paths, and none of that
       * belongs in a list of who has which book.
       */
      include: [
        { model: db.Book, as: 'book', attributes: ['id', 'title', 'author', 'isbn', 'fine_per_day'] },
        { model: db.Student, as: 'student', attributes: ['id', 'student_id', 'first_name', 'last_name'] },
        { model: db.Teacher, as: 'teacher', attributes: ['id', 'employee_id', 'first_name', 'last_name'] },
        { model: db.Staff, as: 'staff', attributes: ['id', 'employee_id', 'first_name', 'last_name'] },
      ],
      order: getSort({ query }, TXN_SORTABLE, ['issue_date', 'DESC']),
    },
    pagination
  );
  return { rows: result.rows.map(presentTransaction), count: result.count };
}

/** The borrower named by `borrower_type` must exist in the same school. */
async function assertBorrower(payload, schoolId, transaction) {
  const column = BORROWER_COLUMN[payload.borrower_type];
  const model = BORROWER_MODEL[payload.borrower_type];
  const borrower = await db[model].findOne({
    where: { id: payload[column], school_id: schoolId },
    transaction,
  });
  if (!borrower) {
    throw ApiError.validation(`That ${payload.borrower_type} is not in this school`, [
      { field: column, message: `Unknown ${payload.borrower_type} for this school` },
    ]);
  }
  return borrower;
}

/**
 * FR-LIB-002, step one — the librarian issues a book.
 *
 * The FR's stated precondition is the *only* one enforced: *"Book exists in catalog and is available"*.
 * A borrower already holding a copy of the same title may take another, because §20.4 says nothing
 * against it and availability is what the requirement makes the gate. Recorded so the absence reads as
 * a decision rather than a missing check.
 */
async function issue(req, payload) {
  let result;
  try {
    result = await db.sequelize.transaction(async (transaction) => {
      const school = await resolveSchool(req, payload.school_id);

      /*
       * The locking read is the whole of the concurrency answer: a second issue of the same book waits
       * here until this transaction commits, then re-reads `available_quantity` and sees this loan.
       * Without it two librarians both read 1, both write 0, and two copies leave the building.
       */
      const book = await db.Book.findOne({
        where: { id: payload.book_id, school_id: school.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!book) {
        throw ApiError.validation('That book is not in this school', [
          { field: 'book_id', message: 'Unknown book for this school' },
        ]);
      }
      if (!book.is_active) {
        throw ApiError.conflict('That book has been retired from the catalogue', { code: 'BOOK_INACTIVE' });
      }
      if (Number(book.available_quantity) < 1) {
        throw ApiError.conflict('Every copy of that book is already on loan', { code: 'BOOK_UNAVAILABLE' });
      }

      await assertBorrower(payload, school.id, transaction);

      const issueDate = dateOnly(payload.issue_date) || dates.toDateOnly(new Date());
      /* §20.4 puts `loan_days` on the book, so the due date comes from the book unless one is named. */
      const dueDate = payload.due_date
        ? dateOnly(payload.due_date)
        : dates.toDateOnly(dates.addDays(issueDate, Number(book.loan_days)));

      const row = await db.LibraryTransaction.create(
        {
          school_id: school.id,
          organization_id: school.organization_id,
          book_id: book.id,
          borrower_type: payload.borrower_type,
          student_id: payload.student_id || null,
          teacher_id: payload.teacher_id || null,
          staff_id: payload.staff_id || null,
          issue_date: issueDate,
          due_date: dueDate,
          status: LIBRARY_TRANSACTION_STATUS.ISSUED,
          issued_by: req.user ? req.user.id : null,
          remarks: payload.remarks || null,
        },
        { transaction }
      );

      book.set({ available_quantity: Number(book.available_quantity) - 1 });
      await book.save({ transaction });

      return { row, book };
    });
  } catch (err) {
    return rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'library_transactions',
    recordId: result.row.id,
    event: 'create',
    before: null,
    after: snapshot(result.row),
    reason: payload.reason || null,
  });
  return result.row;
}

/**
 * FR-LIB-002, step two — the librarian records a return, and the system calculates the fine.
 *
 * The fine is `fine_per_day` × whole days past `due_date`, in integer minor units. It is computed from
 * the **book's** rate at the moment of return rather than copied onto the loan at issue: §20.4 puts
 * `fine_per_day` on the book, so that is where the rate lives, and a library that changes its rate
 * changes it for the returns that follow.
 */
async function returnLoan(req, id, payload) {
  let result;
  try {
    result = await db.sequelize.transaction(async (transaction) => {
      const row = await findTransactionById(req, id, payload.school_id, { transaction });
      if (row.status !== LIBRARY_TRANSACTION_STATUS.ISSUED) {
        throw ApiError.conflict(`That loan is already "${row.status}" and cannot be returned again`, {
          code: 'LOAN_NOT_OPEN',
        });
      }

      const book = await db.Book.findOne({
        where: { id: row.book_id, school_id: row.school_id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      const returnDate = dateOnly(payload.return_date) || dates.toDateOnly(new Date());
      if (String(returnDate) < String(row.issue_date)) {
        throw ApiError.validation('The return date is before the issue date', [
          { field: 'return_date', message: 'return_date cannot be earlier than issue_date' },
        ]);
      }

      const late = daysOverdue(row.due_date, returnDate);
      const fine = late > 0 && book ? money.multiply(book.fine_per_day || 0, late) : 0;
      const outcome = payload.outcome || LIBRARY_TRANSACTION_STATUS.RETURNED;

      const before = snapshot(row);
      row.set({
        return_date: returnDate,
        status: outcome,
        fine_amount: fine,
        received_by: req.user ? req.user.id : null,
        ...(payload.remarks !== undefined ? { remarks: payload.remarks } : {}),
      });
      await row.save({ transaction });

      /*
       * A lost copy does not come back to the shelf, so `available_quantity` stays where it is and the
       * gap against `quantity` is what records the loss. §20.4 says nothing about adjusting `quantity`
       * or charging the price, so neither is inferred.
       */
      if (outcome === LIBRARY_TRANSACTION_STATUS.RETURNED && book) {
        book.set({ available_quantity: Number(book.available_quantity) + 1 });
        await book.save({ transaction });
      }

      return { row, before, days: late, fine };
    });
  } catch (err) {
    return rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'library_transactions',
    recordId: result.row.id,
    event: 'update',
    before: result.before,
    after: snapshot(result.row),
    reason: payload.reason || null,
  });
  return result.row;
}

/**
 * FR-LIB-002 — *"manages associated fines"*.
 *
 * Settling is separate from calculating because they are separate events. A payment may not exceed the
 * fine that was calculated: accepting more would make `fine_outstanding` negative and turn the ledger
 * into a credit note, which §20.4 describes nothing of.
 */
async function settleFine(req, id, payload) {
  const row = await findTransactionById(req, id, payload.school_id);

  const amount = Number(row.fine_amount || 0);
  if (amount <= 0 && (payload.fine_paid || payload.fine_waived)) {
    throw ApiError.conflict('That loan carries no fine to settle', { code: 'NO_FINE_TO_SETTLE' });
  }
  if (payload.fine_paid !== undefined && Number(payload.fine_paid) > amount) {
    throw ApiError.validation('The payment is more than the fine', [
      { field: 'fine_paid', message: `fine_paid cannot exceed fine_amount (${amount})` },
    ]);
  }

  const before = snapshot(row);
  row.set({
    ...(payload.fine_paid !== undefined ? { fine_paid: payload.fine_paid } : {}),
    ...(payload.fine_waived !== undefined ? { fine_waived: payload.fine_waived } : {}),
    ...(payload.remarks !== undefined ? { remarks: payload.remarks } : {}),
  });

  try {
    await row.save();
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'library_transactions',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });
  return row;
}

module.exports = {
  listBooks,
  findBookById,
  createBook,
  updateBook,
  listTransactions,
  findTransactionById,
  issue,
  returnLoan,
  settleFine,
  presentBook,
  presentTransaction,
  selfScopeStudent,
  daysOverdue,
  BOOK_EDITABLE,
  BOOK_SORTABLE,
  TXN_SORTABLE,
  BORROWER_COLUMN,
};
