'use strict';

/**
 * Documents — SRS §20.5, FR-DOC-001.
 *
 * One requirement covering seven documents. The table carries `school_id` **and** `organization_id`, so
 * `tenantWhere()` is safe on it.
 *
 * ## The entitlement gate is per document type, and that is new
 *
 * Every other module in this project mounts one `requireModule(MODULES.X)` on its router, because a
 * module has one subscribable key. §20.5 does not: `DOCUMENT_TYPE_MODULE` maps the seven types onto
 * **four different** modules —
 *
 *   student_id_card, teacher_id_card          → `id_cards`
 *   admission_form, character_certificate,
 *   leaving_certificate                       → `certificates`
 *   fee_receipt                               → `fees`
 *   result_card                               → `exams`
 *
 * — so the module cannot be known until the request names a type. The router therefore mounts
 * `requireActiveSubscription()` and the module check happens here, per request, through the same
 * `loadSnapshot` the router-level guard uses.
 *
 * A school subscribed to Certificates but not ID Cards can therefore issue a leaving certificate and not
 * a student ID card, which is what §11.1 sells.
 *
 * (`documents.view` and `documents.generate` are declared with `module: null`, and that is **not** the
 * evidence for any of this: 59 of the 109 seeded permissions are, and `app.js` records that the field is
 * metadata nothing in the request path reads. An earlier draft of this header claimed the two were
 * unique in the catalogue and was simply wrong. `DOCUMENT_TYPE_MODULE` is the evidence, and it is
 * enough.)
 *
 * Reads are **not** gated by type. A document already generated is the school's own record of something
 * it did, and §20.5 gives no reason for a later downgrade to hide it. Recorded as a decision.
 *
 * ## `owner_type` is derived, never supplied
 *
 * Each document is about exactly one kind of record, so the type decides the owner kind and the caller
 * supplies only the id. FR-DOC-001's precondition — *"Relevant underlying record exists"* — is enforced
 * by loading that record **in the caller's school** and refusing when it is absent.
 *
 * ## What `generation_payload` is for, and why it is the real deliverable here
 *
 * The column's own comment says *"Values merged into the template when generated, so it can be
 * reproduced."* So the service does not store a marker; it **reads the underlying records and assembles
 * the values** — the student's name, admission number, class and section; the teacher's employee id and
 * designation; the receipt number and amount actually paid; the exam and the marks. A row whose payload
 * were empty would satisfy no part of the requirement.
 *
 * ## What FR-DOC-001 does not get, stated plainly
 *
 * **No bytes.** Rendering a PDF is checklist row 5.4 (Phase 5.4) and is not built, so `file_path`,
 * `file_name`, `mime_type` and `file_size_bytes` stay null and `storage_limit` — a cumulative limit that
 * is incremented explicitly — is not incremented, because nothing was stored. Mounting
 * `enforceLimit(STORAGE_LIMIT)` here would be a guard that can never fire.
 *
 * **No download route.** There is still no file-serving anywhere in this application. FR-EXAM-005,
 * FR-HW-001 and FR-ASG-001 each recorded that they were waiting on it; so does this. What §20.5 delivers
 * is the record — which document was generated, for whom, by whom, when, and with exactly the values
 * that reproduce it — which is what Phase 5.4 will render from. Known Issues #26 still has to be closed
 * before any such route exists.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { renderDocument } = require('../../utils/pdf');
/*
 * §19 owns what an absent paper prints. Two documents show a result card — FR-EXAM-005's export
 * and §20.5's Result Card here — and a private copy of that rule in each would be a second source
 * of truth for it. Imported rather than duplicated; there is no cycle, exams referencing nothing
 * in this module.
 */
const { subjectRows } = require('../exams/exams.service');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const dates = require('../../utils/dates');
const { resolveSchool } = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { loadSnapshot, assertSubscriptionUsable } = require('../../middlewares/entitlement');
const {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_MODULE,
  DOCUMENT_OWNER_TYPES,
  MODULE_LABELS,
} = require('../../config/constants');

const SORTABLE = Object.freeze(['id', 'document_type', 'generated_at', 'created_at']);

/**
 * The kind of record each of the seven documents is about.
 *
 * Fixed by what the document *is*, not by configuration: an admission form is about an admission, which
 * is a student. `fee_receipt` owns a **`fee_payments`** row — §17's school-side receipt — and not §13's
 * subscription payment, which is the platform billing the school rather than the school receipting a
 * parent.
 */
const OWNER_OF = Object.freeze({
  [DOCUMENT_TYPES.STUDENT_ID_CARD]: DOCUMENT_OWNER_TYPES.STUDENT,
  [DOCUMENT_TYPES.TEACHER_ID_CARD]: DOCUMENT_OWNER_TYPES.TEACHER,
  [DOCUMENT_TYPES.ADMISSION_FORM]: DOCUMENT_OWNER_TYPES.STUDENT,
  [DOCUMENT_TYPES.FEE_RECEIPT]: DOCUMENT_OWNER_TYPES.PAYMENT,
  [DOCUMENT_TYPES.RESULT_CARD]: DOCUMENT_OWNER_TYPES.STUDENT,
  [DOCUMENT_TYPES.CHARACTER_CERTIFICATE]: DOCUMENT_OWNER_TYPES.STUDENT,
  [DOCUMENT_TYPES.LEAVING_CERTIFICATE]: DOCUMENT_OWNER_TYPES.STUDENT,
});

/** The human title each type gets when the caller names none. */
const TITLE_OF = Object.freeze({
  [DOCUMENT_TYPES.STUDENT_ID_CARD]: 'Student ID Card',
  [DOCUMENT_TYPES.TEACHER_ID_CARD]: 'Teacher ID Card',
  [DOCUMENT_TYPES.ADMISSION_FORM]: 'Admission Form',
  [DOCUMENT_TYPES.FEE_RECEIPT]: 'Fee Receipt',
  [DOCUMENT_TYPES.RESULT_CARD]: 'Result Card',
  [DOCUMENT_TYPES.CHARACTER_CERTIFICATE]: 'Character Certificate',
  [DOCUMENT_TYPES.LEAVING_CERTIFICATE]: 'Leaving Certificate',
});

const fullName = (row) => [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null;

/**
 * `file_path` never reaches a caller, for the reason every stored path is suppressed in this codebase.
 * It is always null today, and it will not be once Phase 5.4 renders something — suppressing it now
 * means the response shape does not change when that happens.
 */
function present(row) {
  const json = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
  delete json.file_path;
  return { ...json, has_file: Boolean(row.file_path) };
}

function rethrow(err) {
  if (err instanceof db.Sequelize.ValidationError) {
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  if (err instanceof db.Sequelize.ForeignKeyConstraintError) {
    throw ApiError.validation('A referenced record does not exist', [
      { field: 'body', message: 'One of the records this document refers to no longer exists' },
    ]);
  }
  throw err;
}

/**
 * The module check FR-DOC-001 needs, which no router-level guard can do.
 *
 * `requireModule()` takes its keys at mount time; here the key is a function of the request body. This
 * runs the same two steps that guard does — resolve the snapshot, then check state before module — so a
 * lapsed subscription is still reported as a lapsed subscription rather than as a missing module.
 *
 * Platform callers never reach it, for the same reason they never reach `requireModule`: every guard in
 * `entitlement.js` short-circuits on `req.tenant.isPlatform`, and this one does too.
 */
async function assertModuleForType(req, documentType) {
  if (req.tenant && req.tenant.isPlatform) return;

  const moduleKey = DOCUMENT_TYPE_MODULE[documentType];
  const snapshot = await loadSnapshot(req);
  assertSubscriptionUsable(req, snapshot);

  if (snapshot.modules[moduleKey] !== true) {
    const label = (MODULE_LABELS && MODULE_LABELS[moduleKey]) || moduleKey;
    throw ApiError.moduleNotSubscribed(`Your subscription does not include ${label}.`, {
      required: [moduleKey],
      missing: [moduleKey],
      documentType,
      planId: snapshot.plan ? snapshot.plan.id : null,
    });
  }
}

/* ─────────────────────────── the seven payload builders ─────────────────────────── */

/** School-level values every document carries, so a rendered page can be headed. */
async function schoolBlock(schoolId) {
  const school = await db.School.findByPk(schoolId, {
    attributes: ['id', 'name', 'code', 'email', 'phone', 'address', 'city'],
  });
  return school ? { id: school.id, name: school.name, code: school.code, city: school.city } : null;
}

/** A student, with the class and section named rather than left as ids a template cannot print. */
async function studentBlock(student) {
  const [klass, section, session] = await Promise.all([
    student.class_id ? db.Class.findByPk(student.class_id, { attributes: ['id', 'name'] }) : null,
    student.section_id ? db.Section.findByPk(student.section_id, { attributes: ['id', 'name'] }) : null,
    student.academic_session_id
      ? db.AcademicSession.findByPk(student.academic_session_id, { attributes: ['id', 'name'] })
      : null,
  ]);
  return {
    id: student.id,
    name: fullName(student),
    student_id: student.student_id,
    admission_number: student.admission_number,
    roll_number: student.roll_number,
    admission_date: student.admission_date,
    date_of_birth: student.date_of_birth,
    gender: student.gender,
    guardian_name: student.guardian_name,
    class: klass ? { id: klass.id, name: klass.name } : null,
    section: section ? { id: section.id, name: section.name } : null,
    academic_session: session ? { id: session.id, name: session.name } : null,
    status: student.status,
  };
}

/**
 * The values that reproduce each document.
 *
 * Each builder reads the records the document is actually about — that is what makes
 * `generation_payload` a reproduction rather than a label. A builder that returned `{}` would leave a
 * row satisfying no part of FR-DOC-001.
 */
const PAYLOAD = Object.freeze({
  async [DOCUMENT_TYPES.STUDENT_ID_CARD](student) {
    return { student: await studentBlock(student) };
  },

  async [DOCUMENT_TYPES.TEACHER_ID_CARD](teacher) {
    return {
      teacher: {
        id: teacher.id,
        name: fullName(teacher),
        employee_id: teacher.employee_id,
        designation: teacher.designation,
        qualification: teacher.qualification,
        joining_date: teacher.joining_date,
        phone: teacher.phone,
        email: teacher.email,
      },
    };
  },

  async [DOCUMENT_TYPES.ADMISSION_FORM](student) {
    const links = await db.ParentStudent.findAll({
      where: { student_id: student.id, school_id: student.school_id },
      attributes: ['parent_id', 'relation'],
    });
    const parents = links.length
      ? await db.Parent.findAll({
        where: { id: { [Op.in]: links.map((l) => l.parent_id) }, school_id: student.school_id },
        attributes: ['id', 'name', 'phone', 'occupation'],
      })
      : [];
    const relationOf = new Map(links.map((l) => [Number(l.parent_id), l.relation]));
    return {
      student: await studentBlock(student),
      /* §15.2 makes the parent a record of its own, and an admission form names the guardians. */
      parents: parents.map((p) => ({
        id: p.id, name: p.name, phone: p.phone, relation: relationOf.get(Number(p.id)) || null,
      })),
      address: student.address,
      city: student.city,
      admission_date: student.admission_date,
    };
  },

  async [DOCUMENT_TYPES.FEE_RECEIPT](payment) {
    const [student, studentFee] = await Promise.all([
      payment.student_id
        ? db.Student.findOne({ where: { id: payment.student_id, school_id: payment.school_id } })
        : null,
      payment.student_fee_id ? db.StudentFee.findByPk(payment.student_fee_id) : null,
    ]);
    return {
      payment: {
        id: payment.id,
        receipt_number: payment.receipt_number,
        amount: payment.amount,
        fine_paid: payment.fine_paid,
        discount_given: payment.discount_given,
        currency: payment.currency,
        method: payment.method,
        reference: payment.reference,
        paid_at: payment.paid_at,
      },
      /* What the payment was against, so the receipt says what was paid for. */
      fee: studentFee
        ? {
          id: studentFee.id,
          net_amount: studentFee.net_amount,
          paid_amount: studentFee.paid_amount,
          status: studentFee.status,
          due_date: studentFee.due_date,
        }
        : null,
      student: student ? await studentBlock(student) : null,
    };
  },

  async [DOCUMENT_TYPES.RESULT_CARD](student, { exam }) {
    const results = await db.Result.findAll({
      where: { exam_id: exam.id, student_id: student.id, school_id: student.school_id },
    });
    /*
     * §19 computes and stores the totals, so the card reports them rather than recomputing — a card
     * that disagreed with the merit list would be worse than one that could not be produced.
     *
     * The column names are §19's own and were got wrong on the first attempt: the totals are
     * `total_full_marks` / `total_marks_obtained`, the grade is `grade_name` (with `grade_point`
     * beside it) and pass/fail is `outcome`, not `is_pass`. Naming them by guess produced a payload
     * of nulls that a "was a payload assembled?" assertion would have accepted.
     *
     * `result_card_path` is deliberately **not** copied: it is a stored filesystem path, and this
     * module suppresses those rather than moving one into a JSON column where nothing would strip it.
     */
    const row = results[0] || null;
    return {
      student: await studentBlock(student),
      exam: {
        id: exam.id, name: exam.name, exam_type: exam.exam_type,
        start_date: exam.start_date, end_date: exam.end_date, status: exam.status,
      },
      result: row
        ? {
          id: row.id,
          total_full_marks: row.total_full_marks,
          total_marks_obtained: row.total_marks_obtained,
          percentage: row.percentage,
          grade_name: row.grade_name,
          grade_point: row.grade_point,
          outcome: row.outcome,
          position: row.position,
          position_out_of: row.position_out_of,
          subjects_count: row.subjects_count,
          subjects_failed: row.subjects_failed,
          /* §19 stores the per-subject rows on the result itself; a card is mostly this table. */
          subject_breakdown: row.subject_breakdown,
        }
        : null,
    };
  },

  async [DOCUMENT_TYPES.CHARACTER_CERTIFICATE](student) {
    return { student: await studentBlock(student) };
  },

  async [DOCUMENT_TYPES.LEAVING_CERTIFICATE](student) {
    return {
      student: await studentBlock(student),
      /* §15.1 makes leaving a status with its own columns; the certificate is about exactly those. */
      leaving: {
        status: student.status,
        left_at: student.left_at,
        leaving_reason: student.leaving_reason,
        transferred_at: student.transferred_at,
        transfer_to: student.transfer_to,
      },
    };
  },
});


/* ═══════════════════════ FR-DOC-001's PDF half — Phase 5.4 ═══════════════════════ */

/**
 * A pair, dropped when it has nothing to say.
 *
 * A blank `Roll number:` on an ID card is worse than no line at all — it reads as data the school
 * failed to record rather than a field this document does not use.
 */
const pair = (label, value) => (
  value === null || value === undefined || value === '' ? null : { label, value }
);

const pairs = (...entries) => entries.filter(Boolean);

/** `class` and `section` are objects on the payload; the document wants their names. */
const nameOf = (block) => (block && block.name ? block.name : null);

/**
 * One spec per document type — SRS §20.5's seven, and no others.
 *
 * Three shapes between them, which is why `utils/pdf.js` composes optional blocks rather than
 * rendering one layout:
 *
 * | Shape | Documents |
 * |---|---|
 * | label/value only | Student ID Card, Teacher ID Card |
 * | label/value + a table | Admission Form (guardians), Fee Receipt, Result Card |
 * | **prose** | Character Certificate, Leaving Certificate |
 *
 * ## The certificates state facts and characterise nothing
 *
 * A Character Certificate that read *"bears a good moral character"* would be this system asserting
 * something on the school's behalf that **no column records**. Nothing in §29 stores conduct, and
 * §20.5 fixes no wording. So the generated text says what is on file — who the student is, where and
 * when they were enrolled — and leaves the characterisation to the person who signs it. That is why
 * every certificate ends in a signature block: the document is a prepared form, not a judgement the
 * software made up.
 *
 * The Leaving Certificate is different in kind, because §15.1 gives leaving its own columns —
 * `left_at`, `leaving_reason`, `status`, `transfer_to` — so its prose states recorded facts.
 */
const PDF_SPEC = Object.freeze({
  [DOCUMENT_TYPES.STUDENT_ID_CARD]: (payload) => {
    const s = payload.student || {};
    return {
      details: pairs(
        pair('Name', s.name),
        pair('Student ID', s.student_id),
        pair('Admission number', s.admission_number),
        pair('Roll number', s.roll_number),
        pair('Class', nameOf(s.class)),
        pair('Section', nameOf(s.section)),
        pair('Session', nameOf(s.academic_session)),
        pair('Date of birth', s.date_of_birth),
        pair('Guardian', s.guardian_name)
      ),
    };
  },

  [DOCUMENT_TYPES.TEACHER_ID_CARD]: (payload) => {
    const t = payload.teacher || {};
    return {
      details: pairs(
        pair('Name', t.name),
        pair('Employee ID', t.employee_id),
        pair('Designation', t.designation),
        pair('Qualification', t.qualification),
        pair('Joined', t.joining_date),
        pair('Phone', t.phone),
        pair('Email', t.email)
      ),
    };
  },

  [DOCUMENT_TYPES.ADMISSION_FORM]: (payload) => {
    const s = payload.student || {};
    return {
      details: pairs(
        pair('Name', s.name),
        pair('Student ID', s.student_id),
        pair('Admission number', s.admission_number),
        pair('Admitted on', payload.admission_date || s.admission_date),
        pair('Class', nameOf(s.class)),
        pair('Section', nameOf(s.section)),
        pair('Session', nameOf(s.academic_session)),
        pair('Date of birth', s.date_of_birth),
        pair('Gender', s.gender),
        pair('Address', payload.address),
        pair('City', payload.city)
      ),
      columns: [
        { key: 'name', header: 'Guardian', width: 3 },
        { key: 'relation', header: 'Relation', width: 2 },
        { key: 'phone', header: 'Phone', width: 2 },
      ],
      rows: (payload.parents || []).map((p) => ({
        name: p.name, relation: p.relation, phone: p.phone,
      })),
    };
  },

  [DOCUMENT_TYPES.FEE_RECEIPT]: (payload) => {
    const p = payload.payment || {};
    const s = payload.student || {};
    const fee = payload.fee;
    return {
      details: pairs(
        pair('Receipt number', p.receipt_number),
        pair('Paid on', p.paid_at),
        pair('Student', s.name),
        pair('Student ID', s.student_id),
        pair('Class', nameOf(s.class)),
        pair('Method', p.method),
        pair('Reference', p.reference)
      ),
      columns: [
        { key: 'item', header: 'Item', width: 4 },
        { key: 'amount', header: `Amount (${p.currency || ''})`.trim(), width: 2 },
      ],
      rows: [
        { item: 'Amount paid', amount: p.amount },
        { item: 'Fine paid', amount: p.fine_paid },
        { item: 'Discount given', amount: p.discount_given },
        ...(fee ? [
          { item: 'Fee net amount', amount: fee.net_amount },
          { item: 'Paid to date', amount: fee.paid_amount },
        ] : []),
      ],
      summary: pairs(
        pair('Currency', p.currency),
        fee ? pair('Fee status', fee.status) : null,
        fee ? pair('Due date', fee.due_date) : null
      ),
    };
  },

  [DOCUMENT_TYPES.RESULT_CARD]: (payload) => {
    const s = payload.student || {};
    const exam = payload.exam || {};
    const r = payload.result;
    return {
      details: pairs(
        pair('Student', s.name),
        pair('Student ID', s.student_id),
        pair('Roll number', s.roll_number),
        pair('Class', nameOf(s.class)),
        pair('Exam', exam.name),
        pair('Exam type', exam.exam_type)
      ),
      columns: [
        { key: 'subject', header: 'Subject', width: 4 },
        { key: 'full', header: 'Full', width: 1 },
        { key: 'obtained', header: 'Obtained', width: 1 },
        { key: 'grade', header: 'Grade', width: 1 },
        { key: 'outcome', header: 'Outcome', width: 1 },
      ],
      rows: subjectRows(r && r.subject_breakdown),
      summary: r ? pairs(
        pair('Total', `${r.total_marks_obtained} / ${r.total_full_marks}`),
        pair('Percentage', r.percentage === null ? null : `${r.percentage}%`),
        pair('Grade', r.grade_name),
        pair('Outcome', r.outcome),
        pair('Position', r.position === null ? 'not ranked' : `${r.position} of ${r.position_out_of}`)
      ) : pairs(pair('Result', 'no published result for this exam')),
    };
  },

  [DOCUMENT_TYPES.CHARACTER_CERTIFICATE]: (payload, context) => {
    const s = payload.student || {};
    const where = [nameOf(s.class), nameOf(s.section)].filter(Boolean).join(' / ');
    return {
      details: pairs(
        pair('Student', s.name),
        pair('Student ID', s.student_id),
        pair('Class', where),
        pair('Session', nameOf(s.academic_session))
      ),
      body: [
        `This is to certify that ${s.name || 'the student named above'}`
        + (s.student_id ? `, bearing student identifier ${s.student_id},` : ',')
        + ` ${s.status === 'active' ? 'is' : 'was'} enrolled at ${context.schoolName}`
        + (where ? ` in ${where}` : '')
        + (nameOf(s.academic_session) ? ` for the academic session ${nameOf(s.academic_session)}` : '')
        + '.',
        'The particulars above are reproduced from the records held by the school on the date this '
        + 'certificate was generated.',
      ],
      signature: true,
    };
  },

  [DOCUMENT_TYPES.LEAVING_CERTIFICATE]: (payload, context) => {
    const s = payload.student || {};
    const leaving = payload.leaving || {};
    const where = [nameOf(s.class), nameOf(s.section)].filter(Boolean).join(' / ');
    return {
      details: pairs(
        pair('Student', s.name),
        pair('Student ID', s.student_id),
        pair('Class', where),
        pair('Status', leaving.status),
        pair('Left on', leaving.left_at),
        pair('Transferred on', leaving.transferred_at),
        pair('Transferred to', leaving.transfer_to)
      ),
      body: [
        `This is to certify that ${s.name || 'the student named above'}`
        + (s.student_id ? `, bearing student identifier ${s.student_id},` : ',')
        + ` was enrolled at ${context.schoolName}`
        + (where ? ` in ${where}` : '')
        + '.',
        leaving.left_at
          ? `The student left the school on ${leaving.left_at}`
            + (leaving.leaving_reason ? `, the recorded reason being: ${leaving.leaving_reason}.` : '.')
          : 'The school\'s records do not carry a leaving date for this student.',
        ...(leaving.transfer_to
          ? [`A transfer to ${leaving.transfer_to} is recorded`
            + (leaving.transferred_at ? ` on ${leaving.transferred_at}.` : '.')]
          : []),
      ],
      signature: true,
    };
  },
});

/**
 * A generated document, as a PDF — SRS §20.5, FR-DOC-001; Phase 5.4.
 *
 * Rendered from `generation_payload` — the snapshot taken when the document was generated — and not
 * from the live records. That is the whole point of storing it: a leaving certificate reissued a year
 * later must say what it said when it was issued, not what the student's row happens to hold now.
 * `present()` already describes the payload as *"a reproduction rather than a label"*, and this is
 * what reproduces it.
 *
 * The bytes are streamed, so `documents.file_path` stays null. §22 established that an export needs
 * no file on disk, and persisting a document is a separate decision from rendering one.
 *
 * @param {object} row  a `documents` row, with `generation_payload`
 * @param {object} [context]
 * @returns {Promise<Buffer>}
 */
function toPdf(row, context = {}) {
  const build = PDF_SPEC[row.document_type];
  if (!build) {
    /* Unreachable through a route — the type is an ENUM — but a silent blank page would be worse. */
    throw new Error(`documents.toPdf(): no PDF spec for "${row.document_type}"`);
  }

  const schoolName = context.schoolName || 'the school';
  const spec = build(row.generation_payload || {}, { schoolName });

  const body = [...(spec.body || [])];
  if (spec.signature) {
    body.push('');
    body.push('_______________________________');
    body.push('Signature and seal of the issuing authority');
  }

  return renderDocument({
    title: TITLE_OF[row.document_type] || 'Document',
    subtitle: [schoolName, row.document_number].filter(Boolean).join('  |  ') || null,
    details: spec.details,
    body,
    columns: spec.columns,
    rows: spec.rows,
    summary: spec.summary,
    footer: schoolName,
  });
}

/**
 * FR-DOC-001's precondition — *"Relevant underlying record exists"* — resolved in the caller's school.
 *
 * The school scoping is the point: without it a caller could generate a certificate for a student in
 * another school by naming their id, and the resulting row would carry that student's name under this
 * school's letterhead.
 */
async function loadOwner(ownerType, ownerId, schoolId) {
  const model = ownerType === DOCUMENT_OWNER_TYPES.TEACHER
    ? 'Teacher'
    : ownerType === DOCUMENT_OWNER_TYPES.PAYMENT
      ? 'FeePayment'
      : 'Student';

  const row = await db[model].findOne({ where: { id: ownerId, school_id: schoolId } });
  if (!row) {
    throw ApiError.validation(`That ${ownerType} is not in this school`, [
      { field: 'owner_id', message: `No ${ownerType} with that id exists in this school` },
    ]);
  }
  return row;
}

/**
 * The audiences that see only their own documents.
 *
 * `documents.view` reaches Teacher, Student and Parent as well as the four actors FR-DOC-001 names, and
 * there is no `documents.self.view` to tell them apart — the catalogue shape §20.2, §20.3 and §20.4 all
 * had. Three self-audiences rather than two, because a **teacher** is an owner here (their own ID card)
 * as well as a reader.
 *
 * Every profile is consulted, never the first one found: one account can be more than one of these, and
 * resolving only the first would silently hide the rest. That was a real defect in §19's `myResults()`.
 */
async function selfScope(req) {
  if (!req.user || !req.user.id) return null;

  const owners = [];
  let isSelfCaller = false;

  const student = await db.Student.findOne({ where: tenantWhere(req.tenant, { user_id: req.user.id }) });
  if (student) {
    isSelfCaller = true;
    owners.push({ type: DOCUMENT_OWNER_TYPES.STUDENT, id: Number(student.id) });
  }

  const teacher = await db.Teacher.findOne({ where: tenantWhere(req.tenant, { user_id: req.user.id }) });
  if (teacher) {
    isSelfCaller = true;
    owners.push({ type: DOCUMENT_OWNER_TYPES.TEACHER, id: Number(teacher.id) });
  }

  const parent = await db.Parent.findOne({ where: tenantWhere(req.tenant, { user_id: req.user.id }) });
  if (parent) {
    isSelfCaller = true;
    if (parent.is_active) {
      const links = await db.ParentStudent.findAll({
        where: { parent_id: parent.id, school_id: parent.school_id },
        attributes: ['student_id'],
      });
      for (const link of links) {
        owners.push({ type: DOCUMENT_OWNER_TYPES.STUDENT, id: Number(link.student_id) });
      }
    }
  }

  return isSelfCaller ? owners : null;
}

/** `[{type, id}]` as a where clause: any of those exact pairs, and nothing else. */
function ownedBy(owners) {
  if (!owners.length) return { owner_type: { [Op.in]: [''] } };
  return {
    [Op.or]: owners.map((o) => ({ owner_type: o.type, owner_id: o.id })),
  };
}

const matchesOwner = (owners, row) =>
  owners.some((o) => o.type === row.owner_type && o.id === Number(row.owner_id));

/* ─────────────────────────────── the three routes ─────────────────────────────── */

async function findById(req, id, namedSchoolId = undefined) {
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;
  const where = tenantWhere(req.tenant, { id });
  if (named) {
    const school = await resolveSchool(req, named);
    where.school_id = school.id;
  }
  const row = await db.Document.findOne({ where });
  if (!row) throw ApiError.notFound('Document not found', { code: 'DOCUMENT_NOT_FOUND' });

  /* Confined on a read by id as well as on the list — §20.2's lesson, repeated in §20.3 and §20.4. */
  const owners = await selfScope(req);
  if (owners && !matchesOwner(owners, row)) {
    throw ApiError.notFound('Document not found', { code: 'DOCUMENT_NOT_FOUND' });
  }
  return row;
}

async function list(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  for (const field of ['document_type', 'owner_type', 'owner_id', 'is_generated']) {
    if (query[field] !== undefined) where[field] = query[field];
  }
  if (query.q) where.title = { [Op.like]: `%${query.q}%` };

  const owners = await selfScope(req);
  if (owners) Object.assign(where, ownedBy(owners));

  const result = await paginateQuery(
    db.Document,
    { where, order: getSort({ query }, SORTABLE, ['id', 'DESC']) },
    pagination
  );
  return { rows: result.rows.map(present), count: result.count };
}

/** FR-DOC-001 — generate. */
async function generate(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  /* Per document type, because the seven map onto four different subscribable modules. */
  await assertModuleForType(req, payload.document_type);

  const ownerType = OWNER_OF[payload.document_type];
  const owner = await loadOwner(ownerType, payload.owner_id, school.id);

  const context = {};
  if (payload.document_type === DOCUMENT_TYPES.RESULT_CARD) {
    const exam = await db.Exam.findOne({ where: { id: payload.exam_id, school_id: school.id } });
    if (!exam) {
      throw ApiError.validation('That exam is not in this school', [
        { field: 'exam_id', message: 'Unknown exam for this school' },
      ]);
    }
    context.exam = exam;
  }

  const built = await PAYLOAD[payload.document_type](owner, context);
  const generation_payload = {
    document_type: payload.document_type,
    /* Stamped into the payload as well as the row, so a reproduction is dated by itself. */
    generated_on: dates.toDateOnly(new Date()),
    school: await schoolBlock(school.id),
    ...built,
  };

  try {
    const row = await db.Document.create({
      school_id: school.id,
      organization_id: school.organization_id,
      document_type: payload.document_type,
      owner_type: ownerType,
      owner_id: owner.id,
      title: payload.title || TITLE_OF[payload.document_type],
      description: payload.description || null,
      is_generated: true,
      generated_at: new Date(),
      generation_payload,
      uploaded_by: req.user ? req.user.id : null,
      /*
       * No bytes: rendering is Phase 5.4. `file_path`, `file_name`, `mime_type` and `file_size_bytes`
       * stay null, and `storage_limit` is not incremented, because nothing was stored.
       */
    });

    await recordAudit(req, {
      tableName: 'documents',
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

module.exports = {
  toPdf,
  PDF_SPEC,
  list,
  findById,
  generate,
  present,
  selfScope,
  assertModuleForType,
  loadOwner,
  OWNER_OF,
  TITLE_OF,
  PAYLOAD,
  SORTABLE,
};
