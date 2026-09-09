'use strict';

/**
 * Notification engine — SRS §23, FR-NOTIF-001.
 *
 * §23 documents nine notification types and *"no additional notification types are introduced"*. It
 * has exactly one requirement, whose **Actor / Role is `System`**, whose precondition is *"Triggering
 * event occurs"*, and whose outcome is *"Relevant users ... receive the notification."* So §23 is not
 * a CRUD surface with a `create`. It is an engine that watches seven other modules and addresses
 * their events to the right people.
 *
 * ## Why the engine is a set of sweeps, and not a call inside each owning module
 *
 * The obvious build is to call `notify()` from `homework.create()`, `exams.publishResults()`,
 * `attendance.markStudents()` and so on. That was rejected, and the schema is the reason.
 *
 * §29 gave five tables a dedicated marker column, and every one of their comments describes a job:
 *
 * | Column | §29's own comment |
 * |---|---|
 * | `homework.notified_at` | *"Set once the Homework notification has been dispatched (SRS §23)."* |
 * | `exams.announced_at` | *"Set when the Exam Announcement notification has been dispatched (SRS §23)."* |
 * | `student_attendance.alert_sent_at` | *"Set once the low-attendance alert has fired, so it is not sent twice (SRS §23)."* |
 * | `invoices.reminder_sent_at` | *"Marker used by the fee/subscription reminder **cron**."* |
 * | `subscriptions.expiry_notified_at` | *"Marker used by the expiry-notice **cron** so a school is warned exactly once per cycle."* |
 *
 * Two earlier sections read those comments the same way and wrote it into their own validation:
 * `homework.validation.js` and `exams.validation.js` both refuse their marker with the message
 * *"stamped by the §23 notification **job**"*. A marker column exists to answer *"have I already sent
 * this?"* — a question only something that runs repeatedly over old rows ever needs to ask. A call
 * inside `create()` knows the answer without a column.
 *
 * So the schema settled the architecture before this module was written, and three things follow:
 *
 * 1. **The actor stays `System`.** A notification raised inside `homework.create()` is really the
 *    teacher acting; one raised by a sweep is the system, which is what FR-NOTIF-001 says.
 * 2. **Dispatch has no route**, exactly like `subscriptions.runLifecycleSweep()`,
 *    `invoices.markOverdue()` and `coupons`' expiry pass. Its caller is a scheduler; `src/jobs/` is
 *    Phase 5. `runNotificationSweep()` is driven directly by the suite, as those three already are.
 * 3. **Not one line of the seven owning modules changes.** §23 reads their tables and stamps their
 *    markers; it does not reach into their write paths. The 4,613 assertions standing over those
 *    modules describe exactly the same code after this section as before it.
 *
 * ## Idempotency, for the four types §29 gave no marker
 *
 * `result_published`, `fee_paid`, `payment_received` and `payment_failed` have no marker column, so
 * the sweep asks the `notifications` table itself: is there already a row of this type against this
 * `(reference_type, reference_id)`? §29 put an index on exactly that pair, which is what makes the
 * question cheap, and is a strong hint it was meant to be asked. One grouped query per sweep, never
 * one per candidate row.
 *
 * ## Two channels, two different things
 *
 * `NOTIFICATION_CHANNELS` holds `in_app` and `email` and its own comment records why there are no
 * others: §35 marks *"Additional notification channels"* unspecified. There is no SMS channel, no
 * `sms_limit` among §11.2's eight limits, and no `MODULES.NOTIFICATIONS` — so §23 is **core,
 * ungated and unmetered**, unlike every module built since §14.
 *
 * The two channels are not two copies of one thing:
 *
 * - an **`in_app`** row *is* the delivery. Persisting it is what the recipient reads, so it is born
 *   `sent`, and it is the row `read_at` belongs to. This is the inbox, and what `GET /` returns.
 * - an **`email`** row is a *delivery attempt* through `mailService`. It is born `pending`, becomes
 *   `sent` or `failed` with the transport's own message in `error_message`, and is the only row
 *   `POST /:id/retry` can act on.
 *
 * That is why `status`, `sent_at` and `error_message` are per-row rather than per-event: they
 * describe a channel's fate, not an event's. A user with no e-mail address gets the in-app row and
 * no second row, rather than an `email` row that could never have been sent.
 *
 * A failing mail transport must never lose the notification. `deliver()` therefore records the
 * failure **on the row** and returns; it does not throw, because the in-app copy has already been
 * received and FR-NOTIF-001's outcome is already met.
 *
 * ## Tenancy: this is the one module that must not call `tenantWhere()`
 *
 * `notifications.school_id` and `organization_id` are **both nullable** — §29's own comment says
 * *"Null school_id = a platform notification addressed to the Super Admin"* — and `tenantWhere()`
 * writes an equality, which no platform row would ever match. Every read here is scoped by
 * `user_id = req.user.id` instead, which is strictly narrower than any tenant filter: a recipient
 * sees their own notifications and there is no route that returns anyone else's. `parent_students`,
 * traversed by the audience resolvers, is separately one of the tables `tenantWhere()` is unsafe on
 * because it has no `organization_id`; it is only ever queried here by explicit `student_id`.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const dates = require('../../utils/dates');
const logger = require('../../config/logger');
const mailService = require('../../services/mailService');
const { paginateQuery, getSort } = require('../../utils/pagination');
const {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_LIST,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUS,
  STUDENT_STATUS,
  USER_STATUS,
  EXAM_STATUS,
  ATTENDANCE_STATUS,
  PAYMENT_STATUS,
  STUDENT_FEE_STATUS,
  SUBSCRIPTION_STATES,
  ROLES,
} = require('../../config/constants');

const SORTABLE = Object.freeze(['id', 'created_at', 'sent_at', 'read_at', 'type']);

/** Rows per sweep pass, so one run cannot take unbounded time. `runLifecycleSweep()`'s default. */
const SWEEP_LIMIT = 500;

/**
 * How far ahead a fee reminder looks. Seven days, taken from `invoices.reminderCandidates()` rather
 * than chosen here, because §23 names one *"Fee Reminder"* covering both and two different horizons
 * for the same notice would be a defect nobody would notice until a school asked.
 */
const FEE_REMINDER_WINDOW_DAYS = 7;

/** A fee is worth reminding about while it is still owed. `waived` and `paid` are not. */
const OWED_FEE_STATUSES = Object.freeze([
  STUDENT_FEE_STATUS.UNPAID,
  STUDENT_FEE_STATUS.PARTIALLY_PAID,
]);

/**
 * An exam is announced once it leaves `draft`. `cancelled` is excluded for the obvious reason, and
 * every later state is included so that an exam which raced past `scheduled` before the first sweep
 * ran is still announced rather than silently skipped.
 */
const ANNOUNCEABLE_EXAM_STATUSES = Object.freeze([
  EXAM_STATUS.SCHEDULED,
  EXAM_STATUS.ONGOING,
  EXAM_STATUS.MARKS_ENTRY,
  EXAM_STATUS.COMPLETED,
  EXAM_STATUS.PUBLISHED,
]);

/** §13's payment outcomes, mapped onto §23's two payment types. */
const PAYMENT_OUTCOME = Object.freeze({
  [PAYMENT_STATUS.APPROVED]: NOTIFICATION_TYPES.PAYMENT_RECEIVED,
  [PAYMENT_STATUS.REJECTED]: NOTIFICATION_TYPES.PAYMENT_FAILED,
  [PAYMENT_STATUS.FAILED]: NOTIFICATION_TYPES.PAYMENT_FAILED,
});

/** The two school-scoped roles that answer for a school's billing (§13, §23's payment types). */
const SCHOOL_BILLING_ROLES = Object.freeze([ROLES.PRINCIPAL, ROLES.SCHOOL_ADMIN]);

/* ─────────────────────────────── Presentation ─────────────────────────────── */

/**
 * `error_message` is the transport's own words and can name a host, a port or a mailbox. It is kept
 * out of the payload and left readable in the row for an operator — the same line `payments` draws
 * around `rejection_reason` versus `review_note` — and replaced by the one bit a caller needs, which
 * is whether there was a failure at all. Everything else is returned: `school_id` being **null** is
 * §29's own way of saying *"a platform notification"*, so hiding it would hide the distinction.
 */
function present(row) {
  if (!row) return row;
  const value = typeof row.get === 'function' ? row.get({ plain: true }) : row;
  const { error_message: errorMessage, ...rest } = value;
  return { ...rest, has_error: Boolean(errorMessage) };
}

/* ──────────────────────────── Audience resolution ──────────────────────────── */

/**
 * Turn user ids into the recipients `notify()` needs, dropping anyone who cannot receive.
 *
 * Only `active` users are notified. An `inactive`, `suspended` or `pending` account has either not
 * confirmed it owns the address or has been stopped from using the system, and §23's outcome —
 * *"relevant users receive the notification"* — is not served by writing rows nobody will read or
 * mailing an address nobody has proved they hold.
 *
 * @param {Array<number>} userIds
 * @returns {Promise<Array<{id:number,email:?string,name:string}>>}
 */
async function recipientsForUsers(userIds) {
  const ids = [...new Set((userIds || []).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return [];

  const rows = await db.User.findAll({
    where: { id: { [Op.in]: ids }, status: USER_STATUS.ACTIVE },
    attributes: ['id', 'name', 'email'],
  });
  return rows.map((row) => ({ id: row.id, name: row.name, email: row.email || null }));
}

/**
 * The people who should hear about something that happened to a student: the student's own account
 * and every parent linked to them.
 *
 * FR-NOTIF-001 names *"school, parent, student, teacher, or Super Admin as applicable"*, and for the
 * five student-facing types both the student and the parent are applicable — §23's Attendance Alert
 * and Fee Reminder are addressed to a guardian, while Result Published and Homework are things a
 * student reads too. Sending to both is what "as applicable" means here; narrowing to one would be a
 * product decision §23 does not make.
 *
 * `parent_students` carries `school_id` but **no `organization_id`**, so it is one of the tables
 * `tenantWhere()` is unsafe on. It is queried here by explicit `student_id` only.
 */
async function recipientsForStudents(studentIds) {
  const ids = [...new Set((studentIds || []).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Map();

  const [students, links] = await Promise.all([
    db.Student.findAll({
      where: { id: { [Op.in]: ids } },
      attributes: ['id', 'user_id', 'first_name', 'last_name'],
    }),
    db.ParentStudent.findAll({
      where: { student_id: { [Op.in]: ids } },
      attributes: ['student_id', 'parent_id'],
    }),
  ]);

  const parentIds = [...new Set(links.map((link) => link.parent_id))];
  const parents = parentIds.length
    ? await db.Parent.findAll({
      where: { id: { [Op.in]: parentIds }, is_active: true },
      attributes: ['id', 'user_id'],
    })
    : [];

  const parentUserById = new Map(parents.map((parent) => [parent.id, parent.user_id]));

  /*
   * student_id -> the set of user ids to notify about that student.
   *
   * Attribution is enforced twice over, and measured to be so: the query above asks only for the
   * students in hand, and `byStudent.get()` below refuses to attach a link to a student it was not
   * asked about. Either alone is sufficient, so a deliberate regression on either alone changes
   * nothing — they are defence in depth rather than one guard and one redundancy, and the suite
   * regresses the pair together for that reason.
   */
  const byStudent = new Map();
  for (const student of students) {
    const users = new Set();
    if (student.user_id) users.add(student.user_id);
    byStudent.set(student.id, users);
  }
  for (const link of links) {
    const users = byStudent.get(link.student_id);
    const userId = parentUserById.get(link.parent_id);
    if (users && userId) users.add(userId);
  }
  return byStudent;
}

/** Active students of a class, or of one section of it when the event names a section. */
async function studentIdsForClass(schoolId, classId, sectionId) {
  if (!classId) return [];
  const where = { school_id: schoolId, class_id: classId, status: STUDENT_STATUS.ACTIVE };
  if (sectionId) where.section_id = sectionId;
  const rows = await db.Student.findAll({ where, attributes: ['id'] });
  return rows.map((row) => row.id);
}

/**
 * The users who answer for a school — §23's *"school"* recipient, used by the two payment types and
 * by Subscription Expiry.
 *
 * Resolved through `roles.slug` rather than a hard-coded id, because §29 seeds the eleven roles and
 * nothing fixes their ids. Organization Admin is deliberately **not** here: they are notified about
 * their own organization's subscriptions, which is a different query, and adding them to every
 * school's payment notices would mail one person for every school they hold.
 */
async function schoolAdminUserIds(schoolId) {
  if (!schoolId) return [];
  const roles = await db.Role.findAll({
    where: { slug: { [Op.in]: SCHOOL_BILLING_ROLES } },
    attributes: ['id'],
  });
  if (!roles.length) return [];

  const users = await db.User.findAll({
    where: {
      school_id: schoolId,
      role_id: { [Op.in]: roles.map((role) => role.id) },
      status: USER_STATUS.ACTIVE,
    },
    attributes: ['id'],
  });
  return users.map((user) => user.id);
}

/* ────────────────────────────────── Delivery ────────────────────────────────── */

/**
 * Send one `email` row and record what happened **on the row**.
 *
 * Never throws. The in-app copy of this notification has already been persisted and therefore already
 * received, so a transport failure is a delivery fact to be recorded, not an error to be raised into
 * a sweep that is halfway through a thousand rows. `mailService.send()` does throw on an incomplete
 * message — that is a defect in this module rather than a delivery failure — and that is caught here
 * for the same reason and logged at `error`, because it would otherwise stop the pass.
 */
async function deliver(row) {
  try {
    await mailService.send({ to: row.metadata.email, subject: row.title, text: row.message });
    await row.update({ status: NOTIFICATION_STATUS.SENT, sent_at: new Date(), error_message: null });
    return true;
  } catch (error) {
    logger.error('notifications: email delivery failed', {
      notification_id: row.id, type: row.type, error: error.message,
    });
    await row.update({
      status: NOTIFICATION_STATUS.FAILED,
      error_message: String(error.message || 'delivery failed').slice(0, 500),
    });
    return false;
  }
}

/**
 * Raise one notification to a set of recipients. The engine's only entry point for writing.
 *
 * Creates one `in_app` row per recipient — born `sent`, because persisting it *is* the delivery —
 * and one `email` row per recipient that has an address. Recipients with no address get the in-app
 * row alone rather than an `email` row that was never sendable.
 *
 * @param {object} event
 * @param {string} event.type            one of `NOTIFICATION_TYPES`
 * @param {Array<{id:number,email:?string,name:string}>} event.recipients
 * @param {string} event.title
 * @param {string} event.message
 * @param {?number} [event.schoolId]     null for a platform notification (§29's own convention)
 * @param {?number} [event.organizationId]
 * @param {?string} [event.actionUrl]
 * @param {?string} [event.referenceType]
 * @param {?number} [event.referenceId]
 * @param {object}  [event.metadata]
 * @returns {Promise<{created:number,emailed:number,failed:number}>}
 */
async function notify(event) {
  const recipients = event.recipients || [];
  const result = { created: 0, emailed: 0, failed: 0 };
  if (!recipients.length) return result;

  if (!Object.values(NOTIFICATION_TYPES).includes(event.type)) {
    /*
     * Thrown, not logged: §23 introduces no tenth type, so an unknown one is a defect in a sweep and
     * writing the row would put a value in the column the enum does not carry.
     */
    throw new Error(`notifications.notify(): unknown type "${event.type}"`);
  }

  const base = {
    school_id: event.schoolId || null,
    organization_id: event.organizationId || null,
    type: event.type,
    title: String(event.title).slice(0, 180),
    message: event.message,
    action_url: event.actionUrl || null,
    reference_type: event.referenceType || null,
    reference_id: event.referenceId || null,
    metadata: event.metadata || null,
  };

  const inApp = recipients.map((recipient) => ({
    ...base,
    user_id: recipient.id,
    channel: NOTIFICATION_CHANNELS.IN_APP,
    status: NOTIFICATION_STATUS.SENT,
    sent_at: new Date(),
  }));
  await db.Notification.bulkCreate(inApp);
  result.created += inApp.length;

  /*
   * Measured: `users.email` is NOT NULL, so no audience this module resolves can contain a recipient
   * without an address, and **no sweep can reach the else of this filter**. It is not dead, because
   * `notify()` is exported and takes a caller-supplied recipient list — which is where the suite
   * proves it — but it is defensive with respect to every path that exists today. Said here rather
   * than implied, because a guard that looks load-bearing and is not reads as coverage it does not
   * have. The filter stays: `mailService.send()` throws without a `to`, and that would turn one
   * incomplete recipient into a `failed` row instead of no row.
   */
  for (const recipient of recipients.filter((person) => person.email)) {
    const row = await db.Notification.create({
      ...base,
      user_id: recipient.id,
      channel: NOTIFICATION_CHANNELS.EMAIL,
      status: NOTIFICATION_STATUS.PENDING,
      /* The address is kept on the row so a retry does not have to re-resolve the audience. */
      metadata: { ...(base.metadata || {}), email: recipient.email },
    });
    result.created += 1;
    if (await deliver(row)) result.emailed += 1;
    else result.failed += 1;
  }

  return result;
}

/**
 * Which of these reference ids already have a notification of this type.
 *
 * The idempotency check for the four types §29 gave no marker column. One grouped query per sweep
 * over §29's `(reference_type, reference_id)` index — never one query per candidate.
 */
/**
 * "Not yet notified", expressed in SQL so the LIMIT is spent on work that remains.
 *
 * ## The bug this exists to remove
 *
 * Five of the nine passes are backed by a marker column §29 provides — `homework.notified_at`,
 * `exams.announced_at`, `student_attendance.alert_sent_at`, `student_fees.reminder_sent_at` — and put
 * it straight in the WHERE, so a notified row leaves the candidate set and the next LIMIT fetches the
 * next unnotified rows.
 *
 * The four with no marker column did the opposite: they selected the OLDEST `limit` rows and then
 * discarded the already-notified ones **in JavaScript**. The filtering happened after the LIMIT, so
 * the LIMIT was spent on rows already handled. Once the first 500 published results had been
 * notified, `seen` held all 500, `pending` was empty on every subsequent run, and result 501 was
 * never fetched — the sweep reported 0 for ever while new rows piled up outside the window.
 * `sweepFeePaid` was the starkest: `findAll({ order, limit })` with no WHERE clause at all.
 *
 * Four of §23's nine types — Result Published, Fee Paid, Payment Received, Payment Failed — therefore
 * stopped permanently once a school passed 500 of the relevant row. FR-NOTIF-001 requires all nine.
 *
 * §35 forbids adding the marker columns the other five enjoy, so the exclusion is a subquery against
 * `notifications` itself — the same table `alreadyNotified()` reads, asked in the other direction and
 * one step earlier.
 */
function notYetNotified(type, referenceType) {
  /*
   * Both arguments are internal constants, never request data. Validated anyway, because this builds
   * a raw SQL fragment and "it is only ever called with a constant" is a property of today's callers.
   */
  if (!NOTIFICATION_TYPE_LIST.includes(type)) {
    throw new Error(`notYetNotified(): unknown notification type "${type}"`);
  }
  if (!/^[a-z_]+$/.test(String(referenceType))) {
    throw new Error(`notYetNotified(): suspicious reference type "${referenceType}"`);
  }
  return {
    [Op.notIn]: db.sequelize.literal(
      '(SELECT n.reference_id FROM notifications n' +
        ` WHERE n.type = ${db.sequelize.escape(type)}` +
        ` AND n.reference_type = ${db.sequelize.escape(referenceType)}` +
        ' AND n.reference_id IS NOT NULL)'
    ),
  };
}

async function alreadyNotified(type, referenceType, referenceIds) {
  if (!referenceIds.length) return new Set();
  const rows = await db.Notification.findAll({
    where: {
      type,
      reference_type: referenceType,
      reference_id: { [Op.in]: referenceIds },
    },
    attributes: ['reference_id'],
    group: ['reference_id'],
  });
  return new Set(rows.map((row) => row.reference_id));
}

/* ─────────────────────────────── Read surface ─────────────────────────────── */

/**
 * A recipient's own notifications.
 *
 * Scoped by `user_id`, never by `tenantWhere()` — see the header. `channel` defaults to `in_app`
 * because that is what an inbox is; the `email` rows are delivery records and are reachable by
 * asking for them explicitly, which is how an administrator finds the failures to retry.
 */
async function list(req, query, pagination) {
  const where = { user_id: req.user.id };

  if (query.channel) where.channel = query.channel;
  else where.channel = NOTIFICATION_CHANNELS.IN_APP;

  if (query.type) where.type = query.type;
  if (query.status) where.status = query.status;
  if (query.unread !== undefined) where.read_at = query.unread ? null : { [Op.ne]: null };
  if (query.from || query.to) {
    where.created_at = {
      ...(query.from ? { [Op.gte]: dates.startOfDay(query.from) } : {}),
      ...(query.to ? { [Op.lte]: dates.endOfDay(query.to) } : {}),
    };
  }
  if (query.q) {
    where[Op.or] = [
      { title: { [Op.like]: `%${query.q}%` } },
      { message: { [Op.like]: `%${query.q}%` } },
    ];
  }

  const result = await paginateQuery(
    db.Notification,
    { where, order: getSort({ query }, SORTABLE, ['created_at', 'DESC']) },
    pagination
  );
  return { rows: result.rows.map(present), count: result.count };
}

/**
 * One notification of the caller's own.
 *
 * `user_id` is part of the lookup rather than checked afterwards, so another recipient's row is a
 * 404 and not a 403: a reader learns nothing about whether the id exists.
 */
async function findById(req, id) {
  const row = await db.Notification.findOne({ where: { id, user_id: req.user.id } });
  if (!row) throw ApiError.notFound('Notification not found');
  return row;
}

/** How many unread in-app notifications the caller has — the badge FR-NOTIF-001's outcome implies. */
async function unreadCount(req) {
  return db.Notification.count({
    where: {
      user_id: req.user.id,
      channel: NOTIFICATION_CHANNELS.IN_APP,
      read_at: null,
    },
  });
}

/**
 * Mark one of the caller's notifications read.
 *
 * Idempotent: re-reading an already-read notification returns it unchanged rather than moving
 * `read_at` forward, because the column records when it was *first* read and a client that fires the
 * call on every render would otherwise rewrite history.
 */
async function markRead(req, id) {
  const row = await findById(req, id);
  if (row.read_at) return row;
  await row.update({ status: NOTIFICATION_STATUS.READ, read_at: new Date() });
  return row;
}

/** Mark every unread in-app notification of the caller's read, optionally narrowed to one type. */
async function markAllRead(req, body = {}) {
  const where = {
    user_id: req.user.id,
    channel: NOTIFICATION_CHANNELS.IN_APP,
    read_at: null,
  };
  if (body.type) where.type = body.type;

  const [affected] = await db.Notification.update(
    { status: NOTIFICATION_STATUS.READ, read_at: new Date() },
    { where }
  );
  return { updated: affected };
}

/**
 * Re-attempt a failed e-mail delivery. The one thing `notifications.send` guards.
 *
 * §23 names no human sender — its actor is `System` — so this route composes nothing: the title,
 * message and recipient are the ones the engine already chose, and a caller can only ask that they
 * be tried again. That is the narrowest reading of `notifications.send` that does any work, and it
 * serves FR-NOTIF-001's stated outcome directly: a row sitting at `failed` is one where *"relevant
 * users receive the notification"* is not yet true.
 *
 * Restricted to `email` rows at `failed`. An `in_app` row was delivered by being written, so there is
 * nothing to retry, and a `sent` row would be a second copy rather than a repair — both are refused
 * with 409 rather than quietly doing nothing.
 *
 * Unlike the read routes this is **not** scoped to the caller's own rows: `notifications.send` is
 * held by Super Admin, Principal and School Admin, and a failure is repaired by an administrator, not
 * by the person who never received it. It is scoped to the caller's school instead — a `school_id`
 * equality, which is safe here precisely because a row with a null `school_id` is a platform
 * notification and only the Super Admin, who has no school, can reach those.
 */
async function retry(req, id) {
  const where = { id };
  if (!req.tenant.isPlatform) where.school_id = req.tenant.schoolId;

  const row = await db.Notification.findOne({ where });
  if (!row) throw ApiError.notFound('Notification not found');

  if (row.channel !== NOTIFICATION_CHANNELS.EMAIL) {
    throw ApiError.conflict('Only email notifications can be retried; an in-app notification is delivered when it is written');
  }
  if (row.status !== NOTIFICATION_STATUS.FAILED) {
    throw ApiError.conflict(`Only a failed notification can be retried; this one is "${row.status}"`);
  }
  if (!row.metadata || !row.metadata.email) {
    throw ApiError.conflict('This notification has no recorded address to retry');
  }

  const sent = await deliver(row);
  return { row, sent };
}

/* ───────────────────────────────── The sweeps ───────────────────────────────── */
/*
 * Nine types, eight passes — the two payment types share one, because they are one query over
 * `payments.status` and splitting them would read the table twice to answer the same question.
 *
 * Every pass has the same shape, which is `runLifecycleSweep()`'s: take the candidates, notify, stamp
 * the marker, and count. A row that throws is logged and skipped rather than aborting the sweep —
 * one bad student must not stop a school's notifications, which is the rule §13's billing sweep
 * already follows for one bad subscription.
 */

/** Run `handler` over `rows`, counting successes and collecting failures rather than throwing. */
async function forEachCandidate(rows, report, key, handler) {
  for (const row of rows) {
    try {
      const sent = await handler(row);
      if (sent) report[key] += 1;
    } catch (error) {
      logger.error(`notifications: ${key} failed for row ${row.id}`, { error: error.message });
      report.failed.push({ pass: key, id: row.id, error: error.message });
    }
  }
}

/** §23 Homework — published homework the class has not been told about. */
async function sweepHomework(report, options) {
  const rows = await db.Homework.findAll({
    where: { is_published: true, notified_at: null },
    order: [['id', 'ASC']],
    limit: options.limit,
  });

  await forEachCandidate(rows, report, 'homework', async (row) => {
    const studentIds = await studentIdsForClass(row.school_id, row.class_id, row.section_id);
    const byStudent = await recipientsForStudents(studentIds);
    const userIds = [...byStudent.values()].flatMap((set) => [...set]);
    const recipients = await recipientsForUsers(userIds);

    await notify({
      type: NOTIFICATION_TYPES.HOMEWORK,
      recipients,
      schoolId: row.school_id,
      organizationId: row.organization_id,
      title: `New homework: ${row.title}`,
      message: row.due_date
        ? `New homework "${row.title}" has been assigned, due ${dates.toDateOnly(row.due_date)}.`
        : `New homework "${row.title}" has been assigned.`,
      actionUrl: `/homework/${row.id}`,
      referenceType: 'homework',
      referenceId: row.id,
    });

    /* Stamped whether or not anyone was found: an empty class is still a class that has been told. */
    await row.update({ notified_at: options.at });
    return true;
  });
}

/** §23 Exam Announcement — exams that have left `draft` and not yet been announced. */
async function sweepExamAnnouncements(report, options) {
  const rows = await db.Exam.findAll({
    where: { announced_at: null, status: { [Op.in]: ANNOUNCEABLE_EXAM_STATUSES } },
    order: [['id', 'ASC']],
    limit: options.limit,
  });

  await forEachCandidate(rows, report, 'examAnnouncements', async (row) => {
    const studentIds = await studentIdsForClass(row.school_id, row.class_id, row.section_id);
    const byStudent = await recipientsForStudents(studentIds);
    const recipients = await recipientsForUsers([...byStudent.values()].flatMap((set) => [...set]));

    await notify({
      type: NOTIFICATION_TYPES.EXAM_ANNOUNCEMENT,
      recipients,
      schoolId: row.school_id,
      organizationId: row.organization_id,
      title: `Exam announced: ${row.name}`,
      message: row.start_date
        ? `The exam "${row.name}" is scheduled to begin on ${dates.toDateOnly(row.start_date)}.`
        : `The exam "${row.name}" has been scheduled.`,
      actionUrl: `/exams/${row.id}`,
      referenceType: 'exam',
      referenceId: row.id,
    });

    await row.update({ announced_at: options.at });
    return true;
  });
}

/**
 * §23 Result Published — published results nobody has been told about.
 *
 * §29 gave `results` no marker, so idempotency comes from the `notifications` table itself. The
 * candidate window is `is_published`, which §19 sets, and `published_at` orders the pass so the
 * oldest unnotified result goes first.
 */
async function sweepResults(report, options) {
  /* The exclusion is in the WHERE, so the LIMIT fetches results that still need notifying. */
  const pending = await db.Result.findAll({
    where: {
      is_published: true,
      id: notYetNotified(NOTIFICATION_TYPES.RESULT_PUBLISHED, 'result'),
    },
    order: [['id', 'ASC']],
    limit: options.limit,
  });

  await forEachCandidate(pending, report, 'results', async (row) => {
    const byStudent = await recipientsForStudents([row.student_id]);
    const recipients = await recipientsForUsers([...(byStudent.get(row.student_id) || [])]);
    if (!recipients.length) return false;

    await notify({
      type: NOTIFICATION_TYPES.RESULT_PUBLISHED,
      recipients,
      schoolId: row.school_id,
      organizationId: row.organization_id,
      title: 'Result published',
      message: `A result has been published: ${row.percentage}% (${row.grade_name || 'ungraded'}).`,
      actionUrl: `/results/${row.id}`,
      referenceType: 'result',
      referenceId: row.id,
      metadata: { exam_id: row.exam_id, percentage: row.percentage, outcome: row.outcome },
    });
    return true;
  });
}

/**
 * §23 Attendance Alert — an absence a guardian has not been told about.
 *
 * §29 put `alert_sent_at` on `student_attendance`, which holds one row per student per day, so the
 * alert is **per absence**: the marker's granularity is the requirement's granularity. A threshold
 * across a term would need a marker somewhere else, and §23 describes none.
 */
async function sweepAttendanceAlerts(report, options) {
  const rows = await db.StudentAttendance.findAll({
    where: { status: ATTENDANCE_STATUS.ABSENT, alert_sent_at: null },
    order: [['id', 'ASC']],
    limit: options.limit,
  });

  await forEachCandidate(rows, report, 'attendanceAlerts', async (row) => {
    const byStudent = await recipientsForStudents([row.student_id]);
    const recipients = await recipientsForUsers([...(byStudent.get(row.student_id) || [])]);

    await notify({
      type: NOTIFICATION_TYPES.ATTENDANCE_ALERT,
      recipients,
      schoolId: row.school_id,
      organizationId: row.organization_id,
      title: 'Attendance alert',
      message: `Marked absent on ${dates.toDateOnly(row.attendance_date)}.`,
      actionUrl: `/attendance/students?date=${dates.toDateOnly(row.attendance_date)}`,
      referenceType: 'student_attendance',
      referenceId: row.id,
      metadata: { student_id: row.student_id, attendance_date: dates.toDateOnly(row.attendance_date) },
    });

    await row.update({ alert_sent_at: options.at });
    return true;
  });
}

/**
 * §23 Fee Reminder — a fee still owed and falling due, whose reminder has not gone out.
 *
 * The window and the once-only semantics are `invoices.reminderCandidates()`', not new ones: seven
 * days ahead, and `reminder_sent_at IS NULL` means *"once"* because a marker column with no interval
 * beside it describes a single reminder.
 */
async function sweepFeeReminders(report, options) {
  const horizon = dates.toDateOnly(dates.addDays(options.at, options.withinDays));
  const rows = await db.StudentFee.findAll({
    where: {
      status: { [Op.in]: OWED_FEE_STATUSES },
      due_date: { [Op.ne]: null, [Op.lte]: horizon },
      reminder_sent_at: null,
    },
    order: [['due_date', 'ASC'], ['id', 'ASC']],
    limit: options.limit,
  });

  await forEachCandidate(rows, report, 'feeReminders', async (row) => {
    const byStudent = await recipientsForStudents([row.student_id]);
    const recipients = await recipientsForUsers([...(byStudent.get(row.student_id) || [])]);

    await notify({
      type: NOTIFICATION_TYPES.FEE_REMINDER,
      recipients,
      schoolId: row.school_id,
      organizationId: row.organization_id,
      title: `Fee due: ${row.title}`,
      message: `${row.currency} ${row.pending_amount} is due on ${dates.toDateOnly(row.due_date)} for ${row.title}.`,
      actionUrl: `/fees/ledger?student_id=${row.student_id}`,
      referenceType: 'student_fee',
      referenceId: row.id,
      metadata: { pending_amount: row.pending_amount, currency: row.currency },
    });

    await row.update({ reminder_sent_at: options.at });
    return true;
  });
}

/** §23 Fee Paid — a receipt nobody has been told about. No marker column; idempotent by reference. */
async function sweepFeePaid(report, options) {
  const pending = await db.FeePayment.findAll({
    where: { id: notYetNotified(NOTIFICATION_TYPES.FEE_PAID, 'fee_payment') },
    order: [['id', 'ASC']],
    limit: options.limit,
  });

  await forEachCandidate(pending, report, 'feePaid', async (row) => {
    const byStudent = await recipientsForStudents([row.student_id]);
    const recipients = await recipientsForUsers([...(byStudent.get(row.student_id) || [])]);
    if (!recipients.length) return false;

    await notify({
      type: NOTIFICATION_TYPES.FEE_PAID,
      recipients,
      schoolId: row.school_id,
      organizationId: row.organization_id,
      title: 'Fee payment received',
      message: `A payment of ${row.currency} ${row.amount} has been received. Receipt ${row.receipt_number}.`,
      actionUrl: `/fees/payments/${row.id}`,
      referenceType: 'fee_payment',
      referenceId: row.id,
      metadata: { receipt_number: row.receipt_number, amount: row.amount, currency: row.currency },
    });
    return true;
  });
}

/**
 * §23 Subscription Expiry — a school whose subscription is running out.
 *
 * The window is not recomputed here. `subscriptions.runLifecycleSweep()` already decides who is
 * expiring and moves them into the `expiring` state, and `expiry_notified_at` is nulled on renewal by
 * that same module — which is what makes §29's *"warned exactly once per cycle"* true. §23 notifies
 * the state; it does not re-derive it, for the same reason §22's Exam Report aggregates §19's stored
 * columns instead of recomputing a rank.
 */
async function sweepSubscriptionExpiry(report, options) {
  const rows = await db.Subscription.findAll({
    where: { state: SUBSCRIPTION_STATES.EXPIRING, expiry_notified_at: null },
    order: [['id', 'ASC']],
    limit: options.limit,
  });

  await forEachCandidate(rows, report, 'subscriptionExpiry', async (row) => {
    const recipients = await recipientsForUsers(await schoolAdminUserIds(row.school_id));

    await notify({
      type: NOTIFICATION_TYPES.SUBSCRIPTION_EXPIRY,
      recipients,
      schoolId: row.school_id,
      organizationId: row.organization_id,
      title: 'Subscription expiring',
      message: row.current_period_end
        ? `Your subscription ends on ${dates.toDateOnly(row.current_period_end)}. Renew to keep access.`
        : 'Your subscription is expiring. Renew to keep access.',
      actionUrl: '/subscriptions',
      referenceType: 'subscription',
      referenceId: row.id,
      metadata: { state: row.state, current_period_end: row.current_period_end },
    });

    await row.update({ expiry_notified_at: options.at });
    return true;
  });
}

/**
 * §23 Payment Received and Payment Failed — one pass, because they are one query.
 *
 * Addressed to the school rather than the student: these are §13's platform payments, whose payer is
 * a school paying for its subscription. The person who submitted it is included if they are not
 * already an administrator, because they are the one waiting on the answer.
 */
async function sweepPayments(report, options) {
  /*
   * One branch per §23 payment type, derived from `PAYMENT_OUTCOME` so the two cannot drift.
   *
   * A payment's status maps to exactly one type, and the previous per-type check is preserved rather
   * than simplified to "has any payment notification": a payment approved and later rejected is a
   * case §23 does not discuss, and collapsing the two types here would silently decide it.
   */
  const statusesByType = Object.entries(PAYMENT_OUTCOME).reduce((byType, [status, type]) => {
    (byType[type] = byType[type] || []).push(status);
    return byType;
  }, {});

  const pending = await db.Payment.findAll({
    where: {
      [Op.or]: Object.entries(statusesByType).map(([type, statuses]) => ({
        status: { [Op.in]: statuses },
        id: notYetNotified(type, 'payment'),
      })),
    },
    order: [['id', 'ASC']],
    limit: options.limit,
  });

  await forEachCandidate(pending, report, 'payments', async (row) => {
    const type = PAYMENT_OUTCOME[row.status];
    const userIds = await schoolAdminUserIds(row.school_id);
    if (row.submitted_by) userIds.push(row.submitted_by);
    const recipients = await recipientsForUsers(userIds);
    if (!recipients.length) return false;

    const received = type === NOTIFICATION_TYPES.PAYMENT_RECEIVED;
    await notify({
      type,
      recipients,
      schoolId: row.school_id,
      organizationId: row.organization_id,
      title: received ? 'Payment received' : 'Payment failed',
      message: received
        ? `Your payment ${row.payment_number} of ${row.currency} ${row.amount} has been received.`
        : `Your payment ${row.payment_number} of ${row.currency} ${row.amount} was not accepted.`,
      actionUrl: `/payments/${row.id}`,
      referenceType: 'payment',
      referenceId: row.id,
      metadata: { payment_number: row.payment_number, status: row.status },
    });
    return true;
  });
}

/**
 * Every pass, in order. **No route** — see the header.
 *
 * @param {object} [options]
 * @param {Date}   [options.at]          the moment to evaluate against; injectable so a suite can drive dates
 * @param {number} [options.withinDays]  the fee-reminder horizon
 * @param {number} [options.limit]       rows per pass, so one run cannot take unbounded time
 * @param {Array<string>} [options.only] run a subset of the passes
 * @returns {Promise<object>} a per-pass report, in `runLifecycleSweep()`'s shape
 */
async function runNotificationSweep(options = {}) {
  const at = options.at || new Date();
  const settings = {
    at,
    limit: options.limit || SWEEP_LIMIT,
    withinDays: Number.isFinite(Number(options.withinDays))
      ? Number(options.withinDays)
      : FEE_REMINDER_WINDOW_DAYS,
  };

  const passes = [
    ['homework', sweepHomework],
    ['examAnnouncements', sweepExamAnnouncements],
    ['results', sweepResults],
    ['attendanceAlerts', sweepAttendanceAlerts],
    ['feeReminders', sweepFeeReminders],
    ['feePaid', sweepFeePaid],
    ['subscriptionExpiry', sweepSubscriptionExpiry],
    ['payments', sweepPayments],
  ];

  const report = { at: at.toISOString(), failed: [] };
  for (const [key] of passes) report[key] = 0;

  for (const [key, pass] of passes) {
    if (options.only && !options.only.includes(key)) continue;
    await pass(report, settings);
  }
  return report;
}

module.exports = {
  /* the engine */
  notify,
  runNotificationSweep,
  /* the read surface */
  list,
  findById,
  unreadCount,
  markRead,
  markAllRead,
  retry,
  /* internals worth naming, because the suite drives them directly */
  present,
  recipientsForUsers,
  recipientsForStudents,
  studentIdsForClass,
  schoolAdminUserIds,
  alreadyNotified,
  SORTABLE,
  SWEEP_LIMIT,
  FEE_REMINDER_WINDOW_DAYS,
  ANNOUNCEABLE_EXAM_STATUSES,
  OWED_FEE_STATUSES,
  PAYMENT_OUTCOME,
  SCHOOL_BILLING_ROLES,
};
