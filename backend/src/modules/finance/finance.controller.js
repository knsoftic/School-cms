'use strict';

const service = require('./finance.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

async function listExpenses(req, res) {
  const pagination = getPagination(req);
  const result = await service.expenses.list(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function showExpense(req, res) {
  const expense = await service.expenses.findById(req, req.params.id);
  return ApiResponse.ok(res, { expense });
}

async function createExpense(req, res) {
  const expense = await service.expenses.create(req, req.body);
  describeActivity(req, {
    entityId: expense.id,
    description: `Recorded ${expense.category} expense "${expense.title}" of ${expense.currency} ${expense.amount}`,
    metadata: {
      school_id: expense.school_id,
      category: expense.category,
      amount: expense.amount,
      expense_date: expense.expense_date,
    },
  });
  return ApiResponse.created(res, { expense }, { message: 'Expense recorded' });
}

async function updateExpense(req, res) {
  const expense = await service.expenses.update(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: expense.id,
    description: `Corrected expense "${expense.title}"`,
    metadata: { school_id: expense.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { expense }, { message: 'Expense updated' });
}

async function listIncomes(req, res) {
  const pagination = getPagination(req);
  const result = await service.incomes.list(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function showIncome(req, res) {
  const income = await service.incomes.findById(req, req.params.id);
  return ApiResponse.ok(res, { income });
}

async function createIncome(req, res) {
  const income = await service.incomes.create(req, req.body);
  describeActivity(req, {
    entityId: income.id,
    description: `Recorded ${income.category} income "${income.title}" of ${income.currency} ${income.amount}`,
    metadata: {
      school_id: income.school_id,
      category: income.category,
      amount: income.amount,
      income_date: income.income_date,
    },
  });
  return ApiResponse.created(res, { income }, { message: 'Income recorded' });
}

async function updateIncome(req, res) {
  const income = await service.incomes.update(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: income.id,
    description: `Corrected income "${income.title}"`,
    metadata: { school_id: income.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { income }, { message: 'Income updated' });
}

/** FR-FIN-002 and FR-FIN-003 in one read — the net balance is a field of the report, not a route. */
async function report(req, res) {
  const data = await service.report(req, req.query);
  return ApiResponse.ok(res, { report: data });
}

module.exports = {
  listExpenses,
  showExpense,
  createExpense,
  updateExpense,
  listIncomes,
  showIncome,
  createIncome,
  updateIncome,
  report,
};
