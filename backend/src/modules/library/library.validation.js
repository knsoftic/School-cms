'use strict';

/**
 * Library schemas — SRS §20.4, FR-LIB-001 and FR-LIB-002.
 *
 * Two tables, so two families of schema. FR-LIB-001 is the catalogue — *"Books, Authors, Categories, and
 * Quantity"* — and FR-LIB-002 is the loan — *"Librarian issues a book… records a book return… System
 * calculates/records a Fine where applicable."*
 *
 * ## Authors and categories are columns, not tables
 *
 * §20.4 lists "Authors" and "Categories" beside "Books", which reads like three entities. §29 fixes the
 * schema at 64 tables and lists neither, and `books` carries `author STRING(255)` and
 * `category STRING(120)` instead. §35 forbids a 65th table, so the free-text columns are what these
 * schemas validate, and the SRS is satisfied: the catalogue records an author and a category per book.
 *
 * ## `available_quantity` is never written by a caller
 *
 * It is `quantity` minus the copies currently out, and the two must agree or the model's
 * `availableWithinQuantity` validator refuses the row. A caller who could set it directly could make a
 * book look available while every copy was on loan. The service moves it — by ±1 on issue and return,
 * and by the same delta as `quantity` when the catalogue quantity is edited.
 *
 * ## `cover_path` is refused, and does not become Known Issues #26's sixth column
 *
 * `books.cover_path` is a stored filesystem path, and there is no book-cover upload profile — §20.4
 * names no cover. Known Issues #26 records five columns elsewhere that still accept a caller-supplied
 * path from a request body, contradicting the doctrine `fees` and `finance` enforce. This module refuses
 * it rather than adding a sixth.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { LIBRARY_TRANSACTION_STATUS, LIBRARY_BORROWER_TYPES } = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

/**
 * `DECIMAL(12,2)` money, the shape `finance` and `plans` settled: `.precision(2)` **rounds** under
 * `convert: true` rather than rejecting, and `validate.js` reassigns the converted body, so the value
 * the service stores is the value the caller is answered with.
 */
const moneyField = Joi.number().min(0).max(9999999999.99).precision(2);

const book = {
  school_id: Joi.number().integer().min(1),
  title: Joi.string().trim().min(1).max(255),
  author: Joi.string().trim().max(255).empty('').allow(null),
  category: Joi.string().trim().max(120).empty('').allow(null),
  isbn: Joi.string().trim().max(40).empty('').allow(null),
  publisher: Joi.string().trim().max(180).empty('').allow(null),
  edition: Joi.string().trim().max(60).empty('').allow(null),
  language: Joi.string().trim().max(60).empty('').allow(null),
  rack_number: Joi.string().trim().max(60).empty('').allow(null),
  description: Joi.string().trim().max(5000).empty('').allow(null),
  /* INTEGER UNSIGNED. A catalogue entry for zero copies is legitimate — a title on order. */
  quantity: Joi.number().integer().min(0).max(4294967295),
  price: moneyField.allow(null),
  fine_per_day: moneyField,
  /* INTEGER UNSIGNED, default 14. Zero would make every loan overdue on the day it was issued. */
  loan_days: Joi.number().integer().min(1).max(3650),
  is_active: Joi.boolean(),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const bookOwned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
  available_quantity: forbiddenField(
    '"available_quantity" is derived from the copies on loan; change "quantity" instead'
  ),
  cover_path: forbiddenField('"cover_path" would be written from an uploaded file, never from a request body'),
};

const createBook = Joi.object({
  school_id: book.school_id,
  title: book.title.required(),
  author: book.author,
  category: book.category,
  isbn: book.isbn,
  publisher: book.publisher,
  edition: book.edition,
  language: book.language,
  rack_number: book.rack_number,
  description: book.description,
  quantity: book.quantity,
  price: book.price,
  fine_per_day: book.fine_per_day,
  loan_days: book.loan_days,
  is_active: book.is_active,
  reason: book.reason,
  ...bookOwned,
});

const updateBook = Joi.object({
  school_id: book.school_id,
  title: book.title,
  author: book.author,
  category: book.category,
  isbn: book.isbn,
  publisher: book.publisher,
  edition: book.edition,
  language: book.language,
  rack_number: book.rack_number,
  description: book.description,
  quantity: book.quantity,
  price: book.price,
  fine_per_day: book.fine_per_day,
  loan_days: book.loan_days,
  is_active: book.is_active,
  reason: book.reason,
  ...bookOwned,
}).min(1);

const listBooks = listQuery(
  Joi.object({
    school_id: book.school_id,
    category: book.category,
    author: book.author,
    is_active: Joi.boolean(),
    /* FR-LIB-002's precondition is availability, so the catalogue can be filtered by it directly. */
    available: Joi.boolean(),
  })
);

/* ── FR-LIB-002 — the loan ── */

const transaction = {
  school_id: Joi.number().integer().min(1),
  book_id: Joi.number().integer().min(1),
  borrower_type: Joi.string().valid(...Object.values(LIBRARY_BORROWER_TYPES)),
  student_id: Joi.number().integer().min(1),
  teacher_id: Joi.number().integer().min(1),
  staff_id: Joi.number().integer().min(1),
  issue_date: Joi.date().iso(),
  due_date: Joi.date().iso(),
  remarks: Joi.string().trim().max(255).empty('').allow(null),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const transactionOwned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
  status: forbiddenField('"status" moves through the issue and return routes'),
  return_date: forbiddenField('"return_date" is recorded by the return route'),
  fine_amount: forbiddenField('"fine_amount" is calculated from the book\'s fine_per_day and the days overdue'),
  issued_by: forbiddenField('"issued_by" is taken from the authenticated user'),
  received_by: forbiddenField('"received_by" is taken from the authenticated user'),
  currency: forbiddenField('"currency" is taken from the school'),
};

/**
 * FR-LIB-002, step one — issue.
 *
 * `borrower_type` and the three id columns are validated as a set: the named type must carry its own id
 * and **must not carry either of the others**. The model's `borrowerMatchesType` validator only checks
 * that the matching id is present, so a row naming a student while also carrying a teacher id would
 * pass it — the exclusivity is enforced here, where a caller can be told which field was wrong.
 */
const issue = Joi.object({
  school_id: transaction.school_id,
  book_id: transaction.book_id.required(),
  borrower_type: transaction.borrower_type.required(),
  student_id: transaction.student_id.when('borrower_type', {
    is: LIBRARY_BORROWER_TYPES.STUDENT,
    then: Joi.required(),
    otherwise: Joi.forbidden().messages({
      'any.unknown': '"student_id" belongs to a student loan; borrower_type says otherwise',
    }),
  }),
  teacher_id: transaction.teacher_id.when('borrower_type', {
    is: LIBRARY_BORROWER_TYPES.TEACHER,
    then: Joi.required(),
    otherwise: Joi.forbidden().messages({
      'any.unknown': '"teacher_id" belongs to a teacher loan; borrower_type says otherwise',
    }),
  }),
  staff_id: transaction.staff_id.when('borrower_type', {
    is: LIBRARY_BORROWER_TYPES.STAFF,
    then: Joi.required(),
    otherwise: Joi.forbidden().messages({
      'any.unknown': '"staff_id" belongs to a staff loan; borrower_type says otherwise',
    }),
  }),
  issue_date: transaction.issue_date,
  /* Defaults to `issue_date` plus the book's own `loan_days`; a caller may still name one. */
  due_date: transaction.due_date,
  remarks: transaction.remarks,
  reason: transaction.reason,
  ...transactionOwned,
  fine_paid: forbiddenField('"fine_paid" is recorded when a fine is settled, not when a book is issued'),
  fine_waived: forbiddenField('"fine_waived" is recorded when a fine is settled, not when a book is issued'),
});

/**
 * FR-LIB-002, step two — return.
 *
 * `outcome` is `returned` or `lost`. §20.4 names only Issue, Return and Fine, and `lost` is offered
 * because `LIBRARY_TRANSACTION_STATUS` carries it and a copy that never comes back otherwise has no
 * terminal state — the alternatives are a loan that stays open for ever or one falsely marked returned.
 * Nothing further is inferred from it: no price is charged and `quantity` is not adjusted, because the
 * SRS says nothing about either.
 */
/**
 * `return_date` is the one column of `transactionOwned` this route legitimately writes, so it is lifted
 * out of the map rather than left to be shadowed by the order of a spread. Spreading `transactionOwned`
 * last silently overwrote it with its `forbidden()` version and made every dated return a 422 — the
 * identical mistake §20.3's `review` schema made, caught here by the same kind of positive assertion.
 */
const ownedExceptReturnDate = Object.fromEntries(
  Object.entries(transactionOwned).filter(([key]) => key !== 'return_date')
);

const returnBook = Joi.object({
  school_id: transaction.school_id,
  return_date: transaction.due_date,
  outcome: Joi.string().valid(LIBRARY_TRANSACTION_STATUS.RETURNED, LIBRARY_TRANSACTION_STATUS.LOST),
  remarks: transaction.remarks,
  reason: transaction.reason,
  ...ownedExceptReturnDate,
  book_id: forbiddenField('a return cannot change which book was borrowed'),
  borrower_type: forbiddenField('a return cannot change who borrowed the book'),
  student_id: forbiddenField('a return cannot change who borrowed the book'),
  teacher_id: forbiddenField('a return cannot change who borrowed the book'),
  staff_id: forbiddenField('a return cannot change who borrowed the book'),
  issue_date: forbiddenField('a return cannot change when the book was issued'),
  due_date: forbiddenField('a return cannot move the due date the fine is measured from'),
  fine_paid: forbiddenField('settle the fine on the fine route, so the calculation and the payment stay separate'),
  fine_waived: forbiddenField('settle the fine on the fine route, so the calculation and the payment stay separate'),
});

/**
 * FR-LIB-002, the fine half of *"manages associated fines"*.
 *
 * Separate from the return because the two are separate events: the fine is **calculated** when the
 * book comes back and **settled** whenever the borrower pays or the librarian waives it. Folding them
 * into one route would make an unpaid fine unrecordable.
 */
const settleFine = Joi.object({
  school_id: transaction.school_id,
  fine_paid: moneyField,
  fine_waived: Joi.boolean(),
  remarks: transaction.remarks,
  reason: transaction.reason,
  ...transactionOwned,
}).min(1);

const listTransactions = listQuery(
  Joi.object({
    school_id: transaction.school_id,
    book_id: transaction.book_id,
    borrower_type: transaction.borrower_type,
    student_id: transaction.student_id,
    teacher_id: transaction.teacher_id,
    staff_id: transaction.staff_id,
    status: Joi.string().valid(...Object.values(LIBRARY_TRANSACTION_STATUS)),
    issued_from: transaction.issue_date,
    issued_to: transaction.issue_date.when('issued_from', {
      is: Joi.exist(),
      then: transaction.issue_date.min(Joi.ref('issued_from')),
    }),
    /* Outstanding fines, which is the question "manages associated fines" actually asks. */
    fine_outstanding: Joi.boolean(),
  })
);

const showQuery = Joi.object({ school_id: transaction.school_id });

module.exports = {
  schemas: {
    createBook,
    updateBook,
    listBooks,
    issue,
    returnBook,
    settleFine,
    listTransactions,
    showQuery,
    idParam: commonSchemas.idParam,
  },
  moneyField,
};
