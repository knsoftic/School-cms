'use strict';

/**
 * Fees — SRS §17, FR-FEE-001 (structure) and FR-FEE-002 (collection & partial payment).
 *
 * The first **school-side** module that handles money. §13's billing modules already do it for the
 * platform, and this follows their arithmetic rather than inventing a second one: every figure goes
 * through `utils/money.js`, and every comparison is made in integer minor units (`money.toMinor`)
 * rather than on floats, because `0.1 + 0.2 !== 0.3` is exactly the class of defect §5a's billing
 * entries record.
 *
 * ## The balance is recomputed, never incremented
 *
 * `applyPayment()` re-derives `paid_amount` from a **SUM over this fee's payments inside the same
 * transaction**, with a locking read on the `student_fees` row — the shape
 * `invoices.applyPayment()` uses for the same reason. Incrementing a running total is the
 * check-then-write race in its most expensive form: two receptionists taking money at the same
 * counter would both read the same pending figure and one payment would vanish from the balance.
 * A SUM cannot lose a row.
 *
 * ## The ledger arithmetic, stated once
 *
 *   net_amount     = amount − discount_amount + fine_amount
 *   paid_amount    = Σ(fee_payments.amount) for this student_fee
 *   pending_amount = max(0, net_amount − paid_amount)
 *
 * `pending` is clamped at zero: an overpayment settles the fee rather than making the balance
 * negative, which is the same reading `invoices` takes ("an invoice holding more money than it asked
 * for is not still owing"). The status follows from the same two numbers, compared in minor units.
 *
 * ## What §17 does not name, and is therefore not built
 *
 *  - **No automatic fine accrual.** `fine_type` includes `per_day`, but §17 says only that a user
 *    *may configure* Fine and Discount — it describes no clock-driven process that grows one, and
 *    FR-FEE-002 does not mention accrual either. Inventing a scheduled job would be a behaviour the
 *    source does not describe. A fine is therefore configured on the structure and, if it applies,
 *    set explicitly on the assignment; `fee_payments.fine_paid` records how much of a payment settled
 *    it. When §17's fine policy is specified, the accrual belongs in the Phase 5 scheduler beside
 *    `invoices.markOverdue()`, not here.
 *  - **No waiver.** `student_fees.status` has a `waived` value and the columns to go with it, and §17
 *    names no waiving operation. Left unwritten rather than guessed at.
 *
 * ## The discount, which §17 leaves half-specified
 *
 * §17 names a Discount without saying how it is expressed, and the column offers both: `fixed` (an
 * amount) and `percentage` (of the fee). Both are honoured, which is the reading that invents
 * nothing — the structure says which it means, and `none` leaves the fee whole.
 *
 * `fee_payments.discount_given` is a **different column and is deliberately inert**: it is recorded on
 * the receipt and does **not** move the balance. §17 puts the Discount on the fee structure, and letting
 * a collector knock money off at the counter would be a second, undocumented discount mechanism that
 * silently settles a fee nobody paid. The balance moves only on `fee_payments.amount`. This is asserted
 * in the suite so the inertness reads as the decision it is rather than as an oversight; the way to
 * reduce what a family owes is `discount_amount` on the assignment, which is FR-FEE-001's half.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const money = require('../../utils/money');
const dates = require('../../utils/dates');
const documentNumber = require('../../utils/documentNumber');
const { resolveSchool, loadClassInSchool, loadSessionInSchool } = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { STUDENT_FEE_STATUS } = require('../../config/constants');

const STRUCTURE_SORTABLE = Object.freeze(['id', 'name', 'component', 'amount', 'is_active', 'created_at']);
const LEDGER_SORTABLE = Object.freeze(['id', 'due_date', 'status', 'net_amount', 'pending_amount', 'created_at']);
const PAYMENT_SORTABLE = Object.freeze(['id', 'paid_at', 'amount', 'receipt_number', 'created_at']);

const STRUCTURE_EDITABLE = Object.freeze([
  'name',
  'component',
  'amount',
  'academic_session_id',
  'class_id',
  'currency',
  'is_recurring',
  'due_day',
  'fine_amount',
  'fine_type',
  'fine_grace_days',
  'discount_amount',
  'discount_type',
  'is_active',
  'description',
]);

function dateOnly(value) {
  return value === undefined || value === null || value === '' ? value : dates.toDateOnly(value);
}

function pickStructure(payload) {
  const next = {};
  for (const key of STRUCTURE_EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) next[key] = payload[key];
  }
  return next;
}

/**
 * What a discount takes off, given how the structure expresses it.
 *
 * `percentage` is of the fee amount; `fixed` is the amount itself; `none` is nothing. Clamped to the
 * fee, because a discount larger than the fee would otherwise make `net_amount` negative and every
 * downstream comparison meaningless.
 */
function discountFor(structure, amount) {
  const type = structure.discount_type || 'none';
  if (type === 'none') return 0;
  const raw =
    type === 'percentage'
      ? money.percentageOf(amount, money.toNumber(structure.discount_amount))
      : money.round(structure.discount_amount);
  return Math.min(money.toMinor(raw), money.toMinor(amount)) / 100;
}

/** net = amount − discount + fine, never below zero. */
function netOf(amount, discount, fine) {
  return money.clampNonNegative(money.sum(money.subtract(amount, discount), fine));
}

function rethrow(err) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    /* `fee_payments_school_receipt_unique` is the only unique index across the three tables. */
    throw ApiError.conflict('That receipt number is already used at this school', {
      code: 'RECEIPT_NUMBER_TAKEN',
      details: {},
    });
  }
  if (err instanceof db.Sequelize.ValidationError) {
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  throw err;
}

/* ── FR-FEE-001 — the structure ── */

async function findStructure(req, id, namedSchoolId = undefined) {
  const where = tenantWhere(req.tenant, { id });
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;
  /*
   * Keep the record and the entitlement guard on the same school — §5a defect 22.
   *
   * The platform caller is deliberately **not** excluded: `named` is only truthy when the caller named
   * a school, `resolveSchool()` already handles all three scopes, and excluding them discarded the one
   * scope declaration a Super Admin can make — so a `PATCH` naming school A could edit school B's
   * structure instead of answering 404. Same reasoning as `finance.findEntry()`.
   */
  if (named) {
    const school = await resolveSchool(req, named);
    where.school_id = school.id;
  }
  const row = await db.FeeStructure.findOne({ where });
  if (!row) throw ApiError.notFound('Fee structure not found', { code: 'FEE_STRUCTURE_NOT_FOUND' });
  return row;
}

async function listStructures(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.component) where.component = query.component;
  if (query.class_id) where.class_id = query.class_id;
  if (query.academic_session_id) where.academic_session_id = query.academic_session_id;
  if (query.is_active !== undefined) where.is_active = query.is_active;

  /*
   * `q` was accepted and then ignored, which is worse than refusing it.
   *
   * `listQuery()` concatenates `commonSchemas.search`, so `?q=Transport` validated cleanly and this
   * function never read it — the screen's "Name or component…" box returned **every** structure with
   * 200 OK. A silent wrong answer: the user sees a filtered-looking list that was never filtered.
   *
   * The columns are the two the placeholder names, plus `description`, matching the shape
   * `finance.service.js:312-318` already uses for the same parameter.
   */
  if (query.q) {
    where[Op.or] = [
      { name: { [Op.like]: `%${query.q}%` } },
      { component: { [Op.like]: `%${query.q}%` } },
      { description: { [Op.like]: `%${query.q}%` } },
    ];
  }

  /*
   * The class is included so the list can name it. `FeeStructure.belongsTo(Class, { as: 'class' })`
   * already exists and this query had no `include` at all, so the screen's Class column fell back to
   * `class #12` on every class-scoped structure — an id an administrator cannot look up. Narrow
   * attributes, and `listLedger()` below already includes its Student the same way.
   *
   * A structure with a null `class_id` applies to every class; the association comes back null and
   * the column says so.
   */
  return paginateQuery(
    db.FeeStructure,
    {
      where,
      include: [{ model: db.Class, as: 'class', attributes: ['id', 'name'] }],
      order: getSort({ query }, STRUCTURE_SORTABLE, ['component', 'ASC']),
    },
    pagination
  );
}

async function createStructure(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  if (payload.class_id) await loadClassInSchool(payload.class_id, school.id);
  if (payload.academic_session_id) await loadSessionInSchool(payload.academic_session_id, school.id);

  let row;
  try {
    row = await db.FeeStructure.create({
      school_id: school.id,
      organization_id: school.organization_id,
      ...pickStructure(payload),
    });
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'fee_structures',
    recordId: row.id,
    event: 'create',
    before: null,
    after: snapshot(row),
    reason: payload.reason || null,
  });
  return row;
}

async function updateStructure(req, id, payload) {
  const row = await findStructure(req, id, payload.school_id);
  if (payload.class_id) await loadClassInSchool(payload.class_id, row.school_id);
  if (payload.academic_session_id) await loadSessionInSchool(payload.academic_session_id, row.school_id);

  const before = snapshot(row);
  const next = pickStructure(payload);
  if (!Object.keys(next).length) {
    throw ApiError.validation('No fee structure fields to update', [
      { field: 'body', message: 'Send at least one field' },
    ]);
  }

  row.set(next);
  try {
    await row.save();
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'fee_structures',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  /*
   * Deliberately no re-pricing of assigned fees. A `student_fees` row is what a family was told they
   * owe; editing the catalogue afterwards must not silently change a bill already issued — the same
   * reasoning that makes `invoices` denormalise `coupon_code` beside the id (§2 billing).
   */
  return row;
}

/* ── the bridge: assignment ── */

/**
 * Which of these students already carry this fee for this period?
 *
 * The double-billing guard, and it exists for the same reason `invoices.alreadyBilled()` does: the §29
 * schema gives `student_fees` **no unique index** — only a plain lookup index on
 * `(student_id, component, period_month)` — and §35 forbids adding one. Without a check here, a
 * double-clicked "Assign" charges a family May's tuition twice, and nothing in the database says no.
 *
 * Matched on the schema's own triple rather than on `fee_structure_id`, because that triple is what the
 * index says identifies a fee: two *different* structures both charging `monthly_fee` for May are the
 * same double-bill, and matching the structure id would let one through.
 *
 * A `waived` fee does not count — the school decided not to collect it, so charging the period again is
 * a deliberate act rather than an accident. That mirrors `alreadyBilled()` ignoring a cancelled invoice.
 *
 * **What this does not close:** it is a check-then-insert, so two simultaneous requests can both pass
 * it. Running inside the assignment's transaction narrows the window to that transaction's lifetime,
 * which is what `invoices` settles for and for the same reason — the index that would close it outright
 * cannot be added. Stated rather than papered over.
 *
 * ## With no month, the fee structure is part of the identity — the owner's decision D12
 *
 * `period_month` is optional (`fees.validation.js`, no `.required()`) and is normalised to `null`. With
 * only the triple, a missing month degenerated it to `(student, component)`, so a school that assigned a
 * period-less `exam_fee` for the mid-term was refused when it assigned one for the final. §17 never says
 * what tells two such fees apart, and every repair was a business rule — so it was put to the owner
 * (`docs/SRS-TRIAGE-VERDICTS.md` finding 20), whose answer is D12 in `docs/OWNER-DECISIONS.md`: **when no
 * month is named, a different fee structure is a different fee.** "Mid-term exam fee" and "Final exam
 * fee" are two structures and both assign; the same structure twice is still the double-click
 * double-bill and is still refused.
 *
 * The paragraph above still holds wherever a month *is* named: two different structures both charging
 * `monthly_fee` for May are one double-bill, so a dated fee is matched on the triple alone.
 *
 * @param {number} schoolId
 * @param {number[]} studentIds
 * @param {string} component
 * @param {string|null} periodMonth
 * @param {number} structureId  consulted only when `periodMonth` is empty
 * @param {object} transaction
 * @returns {Promise<number[]>}  the students who already carry it
 */
async function alreadyAssigned(schoolId, studentIds, component, periodMonth, structureId, transaction) {
  const identity = periodMonth
    ? { component, period_month: periodMonth }
    : { component, period_month: null, fee_structure_id: structureId };
  const rows = await db.StudentFee.findAll({
    where: {
      school_id: schoolId,
      student_id: { [Op.in]: studentIds },
      ...identity,
      status: { [Op.ne]: STUDENT_FEE_STATUS.WAIVED },
    },
    attributes: ['student_id'],
    transaction,
  });
  return [...new Set(rows.map((r) => Number(r.student_id)))];
}

async function assign(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  const structure = await findStructure(req, payload.fee_structure_id, payload.school_id);

  /*
   * `findStructure()` scopes by the caller's tenant, which for a **platform** caller is no scope at
   * all — so without this, a Super Admin naming school A could assign school B's structure to school
   * A's children, and the fee would carry B's component and amount under A's school_id. The students
   * are filtered by `school.id` below; this is the same check for the other half of the pair.
   */
  if (Number(structure.school_id) !== Number(school.id)) {
    throw ApiError.validation('The fee structure must belong to the school being assigned', [
      { field: 'fee_structure_id', message: 'That structure belongs to another school' },
    ]);
  }

  const unique = [...new Set(payload.student_ids.map(Number))];
  if (unique.length !== payload.student_ids.length) {
    throw ApiError.validation('The same student may not be assigned twice in one request', [
      { field: 'student_ids', message: 'Remove the repeated ids' },
    ]);
  }

  /* One query, not one per student — the shape `attendance` uses for the same reason. */
  const students = await db.Student.findAll({
    where: { id: { [Op.in]: unique }, school_id: school.id },
    attributes: ['id', 'class_id', 'academic_session_id'],
  });
  const found = new Set(students.map((s) => Number(s.id)));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) {
    throw ApiError.validation('Every student must belong to this school', [
      { field: 'student_ids', message: `Not in this school: ${missing.join(', ')}` },
    ]);
  }

  const amount = money.round(
    Object.prototype.hasOwnProperty.call(payload, 'amount') ? payload.amount : structure.amount
  );
  const discount = Object.prototype.hasOwnProperty.call(payload, 'discount_amount')
    ? money.round(payload.discount_amount)
    : discountFor(structure, amount);
  const fine = money.round(payload.fine_amount ?? 0);
  const net = netOf(amount, discount, fine);

  const rows = students.map((student) => ({
    school_id: school.id,
    organization_id: school.organization_id,
    academic_session_id: student.academic_session_id || structure.academic_session_id || null,
    student_id: student.id,
    fee_structure_id: structure.id,
    class_id: student.class_id || structure.class_id || null,
    component: structure.component,
    title: payload.title || structure.name,
    period_month: dateOnly(payload.period_month) || null,
    currency: structure.currency,
    amount,
    discount_amount: discount,
    fine_amount: fine,
    net_amount: net,
    paid_amount: 0,
    pending_amount: net,
    due_date: dateOnly(payload.due_date),
    status: money.toMinor(net) === 0 ? STUDENT_FEE_STATUS.PAID : STUDENT_FEE_STATUS.UNPAID,
    remarks: payload.remarks ?? null,
    created_by: req.user ? req.user.id : null,
  }));

  /*
   * The check and the insert share a transaction, so the window in which a second request can slip
   * between them is that transaction's rather than the whole round trip's — see `alreadyAssigned()`
   * for why it cannot be closed outright.
   *
   * The insert is one statement, and the ids come back on it: Sequelize back-fills the auto-increment
   * key onto each returned instance on MariaDB (verified against this database, not assumed — an
   * assignment whose response carried `id: undefined` would give the collector nothing to pay against).
   * `validate: true` because `bulkCreate` skips the model's validators by default.
   */
  let created;
  try {
    created = await db.sequelize.transaction(async (transaction) => {
      const duplicates = await alreadyAssigned(
        school.id,
        unique,
        structure.component,
        rows[0].period_month,
        structure.id,
        transaction
      );
      if (duplicates.length) {
        const message = rows[0].period_month
          ? 'Those students already carry this fee for this period'
          : 'Those students already carry this fee structure with no month named — name a month, or use a different fee structure';
        throw ApiError.conflict(message, {
          code: 'FEE_PERIOD_ALREADY_ASSIGNED',
          details: {
            student_ids: duplicates,
            component: structure.component,
            period_month: rows[0].period_month,
            fee_structure_id: structure.id,
          },
        });
      }
      return db.StudentFee.bulkCreate(rows, { validate: true, transaction });
    });
  } catch (err) {
    rethrow(err);
  }

  for (const row of created) {
    // eslint-disable-next-line no-await-in-loop
    await recordAudit(req, {
      tableName: 'student_fees',
      recordId: row.id,
      event: 'create',
      before: null,
      after: snapshot(row),
      reason: payload.reason || null,
    });
  }

  return { structure, rows: created };
}

async function listLedger(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.student_id) where.student_id = query.student_id;
  if (query.class_id) where.class_id = query.class_id;
  if (query.component) where.component = query.component;
  if (query.academic_session_id) where.academic_session_id = query.academic_session_id;
  if (query.status) where.status = query.status;
  if (query.due_from || query.due_to) {
    where.due_date = {
      ...(query.due_from ? { [Op.gte]: dateOnly(query.due_from) } : {}),
      ...(query.due_to ? { [Op.lte]: dateOnly(query.due_to) } : {}),
    };
  }

  return paginateQuery(
    db.StudentFee,
    {
      where,
      include: [
        {
          model: db.Student,
          as: 'student',
          attributes: ['id', 'student_id', 'roll_number', 'first_name', 'last_name'],
        },
      ],
      order: getSort({ query }, LEDGER_SORTABLE, ['due_date', 'ASC']),
    },
    pagination
  );
}

/* ── FR-FEE-002 — collection ── */

/**
 * Re-derive the fee's paid and pending figures from its payments.
 *
 * Must run inside the payment's transaction, against a row already locked by the caller — the two
 * together are what make a second concurrent payment wait rather than read a stale balance.
 */
async function applyPayment(studentFee, transaction) {
  if (!transaction) throw new Error('applyPayment() must run inside the payment transaction');

  const paid = await db.FeePayment.sum('amount', {
    where: { student_fee_id: studentFee.id },
    transaction,
  });

  const paidAmount = money.clampNonNegative(paid || 0);
  const pending = money.clampNonNegative(money.subtract(studentFee.net_amount, paidAmount));

  /* Compared in minor units — a float equality on money is how a cent goes missing. */
  let status = STUDENT_FEE_STATUS.UNPAID;
  if (money.toMinor(paidAmount) >= money.toMinor(studentFee.net_amount)) {
    status = STUDENT_FEE_STATUS.PAID;
  } else if (money.toMinor(paidAmount) > 0) {
    status = STUDENT_FEE_STATUS.PARTIALLY_PAID;
  }

  studentFee.set({
    paid_amount: paidAmount,
    pending_amount: pending,
    status,
    paid_at: status === STUDENT_FEE_STATUS.PAID ? studentFee.paid_at || new Date() : null,
  });
  await studentFee.save({ transaction });
  return studentFee;
}

async function pay(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  const amount = money.round(payload.amount);
  if (money.toMinor(amount) <= 0) {
    throw ApiError.validation('A payment must be for more than zero', [
      { field: 'amount', message: 'Send a positive amount' },
    ]);
  }

  /*
   * `fee_payments.fine_paid` is documented on its own column as *"Portion of this payment that settled
   * the fine"* — and a portion cannot exceed the whole. Enforcing that is reading the schema, not
   * inventing a rule: a receipt saying 100 was taken of which 150 went to the fine is not a receipt any
   * reader could reconcile.
   */
  const finePaid = money.round(payload.fine_paid ?? 0);
  if (money.toMinor(finePaid) > money.toMinor(amount)) {
    throw ApiError.validation('The fine settled cannot exceed the payment it came out of', [
      { field: 'fine_paid', message: 'fine_paid is a portion of amount, not an addition to it' },
    ]);
  }

  const paidAt = payload.paid_at ? new Date(payload.paid_at) : new Date();

  let result;
  try {
    /*
     * `withRetry` wraps the *transaction*, not something inside it — a lost receipt-number race leaves
     * a transaction that has to roll back before a new number can be read (`documentNumber`'s header,
     * point 3).
     *
     * It is given the **index** name rather than the column. `isDuplicateNumber()` substring-matches
     * what MySQL reports, which is the index — and billing gets away with passing `'invoice_number'`
     * only because its indexes are auto-named after their column. This one is
     * `fee_payments_school_receipt_unique`, which does *not* contain the string `receipt_number`, so
     * passing the column name would silently disable the retry: the same substring trap §5a records
     * from the parents module, pointing the other way.
     */
    result = await documentNumber.withRetry(
      () =>
        db.sequelize.transaction(async (transaction) => {
          /*
           * The locking read is the whole of the concurrency answer: a second payment against the same
           * fee waits here until this transaction commits, then re-sums and sees this row.
           */
          const studentFee = await db.StudentFee.findOne({
            where: tenantWhere(req.tenant, { id: payload.student_fee_id, school_id: school.id }),
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (!studentFee) {
            throw ApiError.notFound('Student fee not found', { code: 'STUDENT_FEE_NOT_FOUND' });
          }
          if (studentFee.status === STUDENT_FEE_STATUS.WAIVED) {
            throw ApiError.conflict('A waived fee cannot take a payment', {
              code: 'STUDENT_FEE_WAIVED',
              details: { id: studentFee.id },
            });
          }

          const receiptNumber = await documentNumber.nextNumber(db.FeePayment, {
            column: 'receipt_number',
            prefix: documentNumber.PREFIXES.FEE_RECEIPT,
            at: paidAt,
            /* Per school — the unique index is `(school_id, receipt_number)`, not the column alone. */
            scope: { school_id: school.id },
            transaction,
          });

          const payment = await db.FeePayment.create(
            {
              school_id: school.id,
              organization_id: school.organization_id,
              student_fee_id: studentFee.id,
              student_id: studentFee.student_id,
              receipt_number: receiptNumber,
              currency: studentFee.currency,
              amount,
              fine_paid: finePaid,
              discount_given: money.round(payload.discount_given ?? 0),
              method: payload.method,
              reference: payload.reference ?? null,
              paid_at: paidAt,
              collected_by: req.user ? req.user.id : null,
              remarks: payload.remarks ?? null,
            },
            { transaction }
          );

          const before = snapshot(studentFee);
          await applyPayment(studentFee, transaction);
          return { payment, studentFee, before };
        }),
      { column: 'fee_payments_school_receipt_unique' }
    );
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'fee_payments',
    recordId: result.payment.id,
    event: 'create',
    before: null,
    after: snapshot(result.payment),
    reason: payload.reason || null,
  });
  await recordAudit(req, {
    tableName: 'student_fees',
    recordId: result.studentFee.id,
    event: 'update',
    before: result.before,
    after: snapshot(result.studentFee),
    reason: payload.reason || null,
  });

  return { payment: result.payment, studentFee: result.studentFee };
}

async function listPayments(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.student_id) where.student_id = query.student_id;
  if (query.student_fee_id) where.student_fee_id = query.student_fee_id;
  if (query.method) where.method = query.method;
  if (query.receipt_number) where.receipt_number = query.receipt_number;

  /*
   * Same gap as `listStructures()`: `q` validated and was discarded, so the "Receipt number or
   * reference…" box returned every payment. `receipt_number` above is an exact-match filter and a
   * different thing — a partial receipt number matched nothing there and everything here.
   */
  if (query.q) {
    where[Op.or] = [
      { receipt_number: { [Op.like]: `%${query.q}%` } },
      { reference: { [Op.like]: `%${query.q}%` } },
    ];
  }

  if (query.from || query.to) {
    where.paid_at = {
      ...(query.from ? { [Op.gte]: new Date(query.from) } : {}),
      ...(query.to ? { [Op.lte]: new Date(query.to) } : {}),
    };
  }

  /*
   * The student is included for the same reason, and it matters more here: a receipt list that
   * cannot say whose receipt it is answers nothing. Same attributes as `listLedger()`, so the two
   * tabs of the Fees screen name a student identically.
   */
  return paginateQuery(
    db.FeePayment,
    {
      where,
      include: [
        {
          model: db.Student,
          as: 'student',
          attributes: ['id', 'student_id', 'roll_number', 'first_name', 'last_name'],
        },
      ],
      order: getSort({ query }, PAYMENT_SORTABLE, ['paid_at', 'DESC']),
    },
    pagination
  );
}

module.exports = {
  listStructures,
  findStructure,
  createStructure,
  updateStructure,
  assign,
  listLedger,
  pay,
  listPayments,
  discountFor,
  netOf,
  STRUCTURE_EDITABLE,
};
