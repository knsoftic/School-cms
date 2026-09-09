'use strict';

/**
 * Library controllers — SRS §20.4, FR-LIB-001 and FR-LIB-002.
 *
 * Every handler returns `service.presentBook()` or `service.presentTransaction()`, so a book's
 * `cover_path` cannot leak through a response and a loan always carries its derived overdue fields.
 */

const service = require('./library.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

/* ── FR-LIB-001 — the catalogue ── */

async function listBooks(req, res) {
  const pagination = getPagination(req);
  const result = await service.listBooks(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function showBook(req, res) {
  const row = await service.findBookById(req, req.params.id);
  return ApiResponse.ok(res, { book: service.presentBook(row) });
}

async function createBook(req, res) {
  const row = await service.createBook(req, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: `Added "${row.title}" to the library catalogue (${row.quantity} cop${row.quantity === 1 ? 'y' : 'ies'})`,
    metadata: {
      school_id: row.school_id,
      author: row.author,
      category: row.category,
      quantity: row.quantity,
    },
  });
  return ApiResponse.created(res, { book: service.presentBook(row) }, { message: 'Book added' });
}

async function updateBook(req, res) {
  const row = await service.updateBook(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: `Updated the catalogue entry for "${row.title}"`,
    metadata: {
      school_id: row.school_id,
      quantity: row.quantity,
      available_quantity: row.available_quantity,
      fields: Object.keys(req.body),
    },
  });
  return ApiResponse.ok(res, { book: service.presentBook(row) }, { message: 'Book updated' });
}

/* ── FR-LIB-002 — issue, return, fine ── */

async function listTransactions(req, res) {
  const pagination = getPagination(req);
  const result = await service.listTransactions(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function showTransaction(req, res) {
  const row = await service.findTransactionById(req, req.params.id);
  return ApiResponse.ok(res, { transaction: service.presentTransaction(row) });
}

async function issue(req, res) {
  const row = await service.issue(req, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: `Issued book ${row.book_id} to ${row.borrower_type} ${row[service.BORROWER_COLUMN[row.borrower_type]]}, due ${row.due_date}`,
    metadata: {
      school_id: row.school_id,
      book_id: row.book_id,
      borrower_type: row.borrower_type,
      due_date: row.due_date,
    },
  });
  return ApiResponse.created(res, { transaction: service.presentTransaction(row) }, { message: 'Book issued' });
}

async function returnLoan(req, res) {
  const row = await service.returnLoan(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: `Recorded book ${row.book_id} as "${row.status}" on ${row.return_date}${
      Number(row.fine_amount) > 0 ? ` with a fine of ${row.fine_amount}` : ''
    }`,
    metadata: {
      school_id: row.school_id,
      book_id: row.book_id,
      status: row.status,
      return_date: row.return_date,
      fine_amount: row.fine_amount,
    },
  });
  return ApiResponse.ok(res, { transaction: service.presentTransaction(row) }, { message: 'Return recorded' });
}

async function settleFine(req, res) {
  const row = await service.settleFine(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: row.fine_waived
      ? `Waived the fine on library transaction ${row.id}`
      : `Recorded a fine payment of ${row.fine_paid} on library transaction ${row.id}`,
    metadata: {
      school_id: row.school_id,
      fine_amount: row.fine_amount,
      fine_paid: row.fine_paid,
      fine_waived: row.fine_waived,
    },
  });
  return ApiResponse.ok(res, { transaction: service.presentTransaction(row) }, { message: 'Fine updated' });
}

module.exports = {
  listBooks,
  showBook,
  createBook,
  updateBook,
  listTransactions,
  showTransaction,
  issue,
  returnLoan,
  settleFine,
};
