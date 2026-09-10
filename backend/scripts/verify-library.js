'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *   RATE_LIMIT_MAX / AUTH_RATE_LIMIT_MAX  the limiters are not under test here.
 *   BCRYPT_ROUNDS=10, PASSWORD_MIN_LENGTH pinned so neither comes from the local .env.
 *   MAIL_DRIVER=log                       no mail is sent; a stray SMTP attempt would hang the run.
 *   CACHE_TTL=600                         so no entitlement assertion can pass by TTL expiry.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';
process.env.CACHE_TTL = '600';

/**
 * Verification of Phase 3.R library — `src/modules/library/*` — SRS §20.4, FR-LIB-001 and FR-LIB-002.
 *
 * ## The counter is the thing worth testing
 *
 * `books.available_quantity` is the first number in this project that two writers contend for. Every
 * assertion about issue and return is therefore written as an assertion about the **invariant**
 *
 *     quantity - available_quantity === copies currently on loan
 *
 * and not merely about the response of the request that just ran. The invariant is re-read off the
 * database after each step, because a response can be right while the row is wrong.
 *
 * The last copy is issued and a second issue is refused; a return puts it back; a **lost** copy does
 * not; and editing `quantity` moves `available_quantity` by the same delta rather than leaving it, with
 * a reduction below the copies on loan refused outright.
 *
 * ## The fine is calculated, not entered
 *
 * FR-LIB-002 says *"System calculates/records a Fine where applicable"*. So the suite issues a loan
 * whose due date is in the past, returns it, and checks the **arithmetic** — `fine_per_day` × whole days
 * late — rather than checking that some number was stored. It then proves the two events are separate:
 * a fine can be outstanding, part-paid, fully paid or waived, and a payment above the fine is refused.
 *
 * ## Borrower is not caller
 *
 * A book may be issued to a student, a teacher or a staff member, but the seeded catalogue gives
 * **Teacher no library permission at all**. So the suite issues a book to a teacher and then proves that
 * teacher cannot look the loan up — asserted against `DEFAULT_ROLE_PERMISSIONS` itself, so it reads as a
 * property of the fixed catalogue rather than as a gap in this module.
 *
 * Part 1 — request schemas (no database).
 * Part 2 — the declared route table, the router-level guard and the permission map.
 * Part 3 — over real HTTP against the real database.
 *
 * Run: node scripts/verify-library.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const { settle, settleRows, settleDistinct } = require('./lib/settle');

const libraryRoutes = require('../src/modules/library/library.routes');
const { schemas } = require('../src/modules/library/library.validation');
const service = require('../src/modules/library/library.service');

const {
  ROLES,
  USER_STATUS,
  MODULES,
  MODULE_LIST,
  LIMITS,
  LIMIT_TYPES,
  PLAN_STATUS,
  SUBSCRIPTION_STATES,
  BILLING_CYCLES,
  STUDENT_STATUS,
  ACADEMIC_SESSION_STATUS,
  LIBRARY_TRANSACTION_STATUS,
  LIBRARY_BORROWER_TYPES,
  STAFF_CATEGORIES,
} = require('../src/config/constants');
const { DEFAULT_ROLE_PERMISSIONS } = require('../src/config/permissions');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-library.local';
const PASSWORD = 'Verify@Library123';
const CODE_PREFIX = 'VLB-';

let failures = 0;
let dbSkipped = false;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${
      ok ? '' : `  (expected ${JSON.stringify(expected)})`
    }`
  );
}

const VALIDATE_OPTIONS = { abortEarly: false, convert: true, stripUnknown: true };

function run(schema, value) {
  const { error, value: cleaned } = schema.validate(value, VALIDATE_OPTIONS);
  return { ok: !error, value: cleaned, keys: error ? error.details.map((d) => d.path.join('.')) : [] };
}

/** Router source with comments stripped, so a probe cannot match explanatory prose — §5a session 18. */
function routerSource(moduleName) {
  return fs
    .readFileSync(path.join(__dirname, `../src/modules/${moduleName}/${moduleName}.routes.js`), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const mountsLimit = (m) => /enforceLimit/.test(routerSource(m));

function routesOf(router) {
  return router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
}

function handlerNames(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  return layer ? layer.route.stack.map((s) => s.handle.name) : [];
}

const BOOK = { title: 'A Brief History of Time' };
const ISSUE = { book_id: 1, borrower_type: LIBRARY_BORROWER_TYPES.STUDENT, student_id: 1 };

/* ═══════════════════════════ part 1 — request schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas ──\n');

  /* ── FR-LIB-001, the catalogue ── */

  check('a book needs only a title', run(schemas.createBook, BOOK).ok, true);
  check('and a title is required', run(schemas.createBook, { author: 'Hawking' }).ok, false);
  check(
    'author and category are free text, because §29 gives them no tables of their own',
    run(schemas.createBook, { ...BOOK, author: 'Stephen Hawking', category: 'Science' }).ok,
    true
  );

  const width = (field, n) => run(schemas.createBook, { ...BOOK, [field]: 'x'.repeat(n) }).ok;
  check('title is bounded at its STRING(255)', [width('title', 255), width('title', 256)], [true, false]);
  check('author at 255', [width('author', 255), width('author', 256)], [true, false]);
  check('category at its STRING(120)', [width('category', 120), width('category', 121)], [true, false]);
  check('isbn at its STRING(40)', [width('isbn', 40), width('isbn', 41)], [true, false]);

  check(
    'quantity is a non-negative integer — a catalogue entry for zero copies is a title on order',
    [
      run(schemas.createBook, { ...BOOK, quantity: 0 }).ok,
      run(schemas.createBook, { ...BOOK, quantity: -1 }).ok,
      run(schemas.createBook, { ...BOOK, quantity: 2.5 }).ok,
    ],
    [true, false, false]
  );
  check(
    'loan_days must be at least one — zero would make every loan overdue on the day it was issued',
    [run(schemas.createBook, { ...BOOK, loan_days: 1 }).ok, run(schemas.createBook, { ...BOOK, loan_days: 0 }).ok],
    [true, false]
  );
  check(
    'fine_per_day is money, rounded to the column scale rather than rejected',
    [
      run(schemas.createBook, { ...BOOK, fine_per_day: 0.5 }).value.fine_per_day,
      run(schemas.createBook, { ...BOOK, fine_per_day: 0.505 }).value.fine_per_day,
    ],
    [0.5, 0.51]
  );
  check('and a negative rate is refused', run(schemas.createBook, { ...BOOK, fine_per_day: -1 }).ok, false);

  check(
    'available_quantity is refused — it is derived from the copies on loan',
    run(schemas.createBook, { ...BOOK, available_quantity: 99 }).ok,
    false
  );
  check(
    'and so is cover_path, which would otherwise be Known Issues #26\'s sixth column',
    run(schemas.createBook, { ...BOOK, cover_path: '../../etc/passwd' }).ok,
    false
  );
  check('an update must carry something', run(schemas.updateBook, {}).ok, false);
  check('  and refuses the same two', [
    run(schemas.updateBook, { available_quantity: 9 }).ok,
    run(schemas.updateBook, { cover_path: 'x' }).ok,
  ], [false, false]);

  /* ── FR-LIB-002, the loan ── */

  check('an issue needs a book, a borrower type and the matching id', run(schemas.issue, ISSUE).ok, true);
  check('a book is required', run(schemas.issue, { borrower_type: 'student', student_id: 1 }).ok, false);
  check('a borrower type is required', run(schemas.issue, { book_id: 1, student_id: 1 }).ok, false);

  /*
   * The model's `borrowerMatchesType` validator checks only that the *matching* id is present, so a row
   * naming a student while also carrying a teacher id would pass it. The exclusivity has to live here.
   */
  check(
    'the named borrower type requires its own id',
    [
      run(schemas.issue, { book_id: 1, borrower_type: 'student' }).ok,
      run(schemas.issue, { book_id: 1, borrower_type: 'teacher' }).ok,
      run(schemas.issue, { book_id: 1, borrower_type: 'staff' }).ok,
    ],
    [false, false, false]
  );
  check(
    'and refuses the other two, which the model validator would not have caught',
    [
      run(schemas.issue, { book_id: 1, borrower_type: 'student', student_id: 1, teacher_id: 2 }).ok,
      run(schemas.issue, { book_id: 1, borrower_type: 'teacher', teacher_id: 1, staff_id: 2 }).ok,
      run(schemas.issue, { book_id: 1, borrower_type: 'staff', staff_id: 1, student_id: 2 }).ok,
    ],
    [false, false, false]
  );
  check('all three borrower types are accepted', [
    run(schemas.issue, { book_id: 1, borrower_type: 'student', student_id: 1 }).ok,
    run(schemas.issue, { book_id: 1, borrower_type: 'teacher', teacher_id: 1 }).ok,
    run(schemas.issue, { book_id: 1, borrower_type: 'staff', staff_id: 1 }).ok,
  ], [true, true, true]);

  for (const owned of ['status', 'return_date', 'fine_amount', 'issued_by', 'received_by', 'currency', 'organization_id', 'id']) {
    const r = run(schemas.issue, { ...ISSUE, [owned]: owned === 'status' ? 'issued' : owned === 'currency' ? 'USD' : 1 });
    check(`an issue refuses a caller-supplied ${owned}`, [r.ok, r.keys], [false, [owned]]);
  }
  check('and refuses to pre-settle a fine that does not exist yet', [
    run(schemas.issue, { ...ISSUE, fine_paid: 5 }).ok,
    run(schemas.issue, { ...ISSUE, fine_waived: true }).ok,
  ], [false, false]);

  check('a return may be empty — the date and the fine are both the system\'s', run(schemas.returnBook, {}).ok, true);
  /*
   * The positive assertion, which is what §20.3 learned to write. `return_date` is the one column of
   * the shared `transactionOwned` map this route legitimately writes, and spreading that map last
   * silently forbade it — every dated return answered 422 until this check was added.
   */
  check('  and a caller may name the day the book came back', run(schemas.returnBook, { return_date: '2026-08-18' }).ok, true);
  check('    which the shared owned map must not be allowed to shadow',
    run(schemas.returnBook, { return_date: '2026-08-18' }).keys, []);
  check(
    'its outcome is returned or lost, the two terminal states the enum offers',
    [
      run(schemas.returnBook, { outcome: LIBRARY_TRANSACTION_STATUS.RETURNED }).ok,
      run(schemas.returnBook, { outcome: LIBRARY_TRANSACTION_STATUS.LOST }).ok,
      run(schemas.returnBook, { outcome: LIBRARY_TRANSACTION_STATUS.ISSUED }).ok,
      run(schemas.returnBook, { outcome: LIBRARY_TRANSACTION_STATUS.OVERDUE }).ok,
    ],
    [true, true, false, false]
  );
  check(
    'a return cannot rewrite the loan it is closing',
    [
      run(schemas.returnBook, { book_id: 2 }).ok,
      run(schemas.returnBook, { student_id: 2 }).ok,
      run(schemas.returnBook, { due_date: '2020-01-01' }).ok,
      run(schemas.returnBook, { fine_amount: 0 }).ok,
    ],
    [false, false, false, false]
  );
  check(
    '  nor settle the fine it is about to calculate',
    [run(schemas.returnBook, { fine_paid: 5 }).ok, run(schemas.returnBook, { fine_waived: true }).ok],
    [false, false]
  );

  check('settling a fine takes a payment or a waiver', [
    run(schemas.settleFine, { fine_paid: 10 }).ok,
    run(schemas.settleFine, { fine_waived: true }).ok,
    run(schemas.settleFine, {}).ok,
  ], [true, true, false]);
  check('but never the fine amount itself', run(schemas.settleFine, { fine_amount: 0 }).ok, false);

  /* ── the lists ── */

  check(
    'the transaction list accepts every stored status and the derived one',
    Object.values(LIBRARY_TRANSACTION_STATUS).map((s) => run(schemas.listTransactions, { status: s }).ok),
    [true, true, true, true]
  );
  check(
    'a transposed issue window is refused rather than answered with an empty list',
    [
      run(schemas.listTransactions, { issued_from: '2026-01-01', issued_to: '2026-02-01' }).ok,
      run(schemas.listTransactions, { issued_from: '2026-02-01', issued_to: '2026-01-01' }).ok,
    ],
    [true, false]
  );
  check('the catalogue can be filtered by availability, which is FR-LIB-002\'s stated precondition',
    run(schemas.listBooks, { available: true }).ok, true);
  check('and the loans by an outstanding fine', run(schemas.listTransactions, { fine_outstanding: true }).ok, true);
}

/* ═══════════════════════ part 2 — the declared route table ═══════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — the router as declared ──\n');

  check('the nine routes', routesOf(libraryRoutes), [
    'GET /books',
    'POST /books',
    'GET /books/:id',
    'PATCH /books/:id',
    'GET /transactions',
    'GET /transactions/:id',
    'POST /transactions',
    'PATCH /transactions/:id/return',
    'PATCH /transactions/:id/fine',
  ]);
  check(
    'every path is prefixed by a literal collection, so unlike §20.3 nothing here depends on order',
    routesOf(libraryRoutes).every((r) => / \/(books|transactions)/.test(r)),
    true
  );

  check(
    'one router-level guard, mounted ahead of every route',
    [libraryRoutes.stack.filter((l) => !l.route).length, libraryRoutes.stack.findIndex((l) => !l.route)],
    [1, 0]
  );

  check('every write carries validate()', [
    handlerNames(libraryRoutes, 'post', '/books').includes('validateRequest'),
    handlerNames(libraryRoutes, 'patch', '/books/:id').includes('validateRequest'),
    handlerNames(libraryRoutes, 'post', '/transactions').includes('validateRequest'),
    handlerNames(libraryRoutes, 'patch', '/transactions/:id/return').includes('validateRequest'),
    handlerNames(libraryRoutes, 'patch', '/transactions/:id/fine').includes('validateRequest'),
  ], [true, true, true, true, true]);
  check('and every write declares its activity', [
    handlerNames(libraryRoutes, 'post', '/books').includes('activityDeclaration'),
    handlerNames(libraryRoutes, 'patch', '/books/:id').includes('activityDeclaration'),
    handlerNames(libraryRoutes, 'post', '/transactions').includes('activityDeclaration'),
    handlerNames(libraryRoutes, 'patch', '/transactions/:id/return').includes('activityDeclaration'),
    handlerNames(libraryRoutes, 'patch', '/transactions/:id/fine').includes('activityDeclaration'),
  ], [true, true, true, true, true]);

  const src = routerSource('library');
  check('FR-LIB-001\'s three catalogue writes and reads use library.manage / library.view',
    [(src.match(/requirePermission\('library\.manage'\)/g) || []).length,
      (src.match(/requirePermission\('library\.view'\)/g) || []).length],
    [2, 4]);
  check('and FR-LIB-002\'s three loan writes use library.issue',
    (src.match(/requirePermission\('library\.issue'\)/g) || []).length, 3);

  /* The catalogue is fixed by §29/§35, so these are assertions about it, not about this module. */
  const grants = (role) => (DEFAULT_ROLE_PERMISSIONS[role] || []).filter((k) => k.startsWith('library.')).sort();
  check('the Librarian both FRs name holds all three keys',
    grants(ROLES.LIBRARIAN), ['library.issue', 'library.manage', 'library.view']);
  check('a Student may look, and only look', grants(ROLES.STUDENT), ['library.view']);
  check(
    'a Teacher may borrow a book and holds NO library permission at all — borrower is not caller',
    grants(ROLES.TEACHER),
    []
  );
  check('and neither does a Parent', grants(ROLES.PARENT), []);

  check('no route carries an entitlement limit', mountsLimit('library'), false);
  check('  and the probe would find one — the students router does mount a limit', mountsLimit('students'), true);
  check('and §11.2 defines no library limit to carry',
    Object.values(LIMITS).some((k) => k.includes('librar') || k.includes('book')), false);

  check('no route mounts an upload — §20.4 names no cover, so cover_path stays unwritten',
    /uploadSingle|uploadArray/.test(src), false);

  /*
   * The locking reads, asserted at the SOURCE, because a lock cannot be provoked from a
   * single-threaded suite — two concurrent writers are the thing it defends against and this script
   * issues one request at a time. §5a session 21 established both the technique and the need to strip
   * comments first, so a probe cannot match the paragraph explaining the lock instead of the lock.
   *
   * `available_quantity` is the first number in this project two writers contend for: without the lock
   * both read 1, both write 0, and two copies leave the building.
   */
  const svc = fs
    .readFileSync(path.join(__dirname, '../src/modules/library/library.service.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check(
    'every path that moves available_quantity takes a locking read on the book row',
    (svc.match(/LOCK\.UPDATE/g) || []).length,
    3
  );
  check(
    '  and each of the three runs inside a transaction of its own',
    (svc.match(/db\.sequelize\.transaction\(/g) || []).length,
    3
  );
  check(
    '  which are exactly issue, return and the quantity edit',
    ['issue', 'returnLoan', 'updateBook'].map((fn) => svc.includes(`async function ${fn}(`)),
    [true, true, true]
  );

  /* The fine arithmetic, before any of it touches a database. */
  check('days overdue is whole days past the due date, never negative', [
    service.daysOverdue('2026-01-10', '2026-01-15'),
    service.daysOverdue('2026-01-10', '2026-01-10'),
    service.daysOverdue('2026-01-10', '2026-01-05'),
    service.daysOverdue(null, '2026-01-15'),
  ], [5, 0, 0, 0]);
}

/* ═══════════════════════════ part 3 — over real HTTP ═══════════════════════════ */

async function verifyHttp() {
  console.log('\n── Part 3 — real HTTP against the real database ──\n');

  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  const created = { users: [], schools: [], organizations: [], plans: [], subscriptions: [] };
  const baseline = {
    activityLog: (await db.ActivityLog.max('id')) || 0,
    auditLog: (await db.AuditLog.max('id')) || 0,
  };

  async function call(pathname, { method = 'GET', body, token } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + pathname, { method, headers, body: payload });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* left null */
    }
    return { status: res.status, body: parsed, raw: text };
  }

  const codeOf = (res) => (res.body && res.body.error ? res.body.error.code : `no-error:${res.status}`);
  const dataOf = (res) => (res.body && res.body.data !== undefined ? res.body.data : null);
  const idsOf = (res) => (dataOf(res) || []).map((r) => r.id).sort((a, b) => a - b);

  async function expectOk(pathname, options, wantStatus) {
    const res = await call(pathname, options);
    if (res.status !== wantStatus) {
      throw new Error(`${options.method || 'GET'} ${pathname} expected ${wantStatus}, got ${res.status}: ${res.raw}`);
    }
    return res;
  }

  /** The invariant, read straight off the row rather than out of a response. */
  async function shelf(bookId) {
    const row = await db.Book.findByPk(bookId);
    return [Number(row.quantity), Number(row.available_quantity)];
  }

  async function teardown() {
    /*
     * Scoped to this run's own tenant — Known Issues #25. An unbounded delete above `baseline` also
     * removes rows belonging to any suite running concurrently, which is the mechanism behind
     * "a parallel run reports false failures": the victim then reads `[]`, not a partial set.
     *
     * Both tables are ON DELETE CASCADE from `schools` and `organizations`, so this run's rows would
     * be removed anyway when its schools and organization go. This stays explicit as belt-and-braces
     * and to keep the ordering obvious; what matters is that it can no longer reach another run.
     *
     * Rows with neither a school nor an organization — the seeded Super Admin's sign-ins — are left.
     * Every suite authenticates as that same user, so no run can claim them, and they sit below the
     * next run's baseline where no assertion can see them.
     */
    const ownTenant = [
      ...(Array.isArray(created.schools) && created.schools.length ? [{ school_id: created.schools }] : []),
      ...(Array.isArray(created.organizations) && created.organizations.length
        ? [{ organization_id: created.organizations }] : []),
      /*
       * The run's own users, which catches its PLATFORM-scope rows — sign-ins and super-admin
       * actions have no school and no organization, so the two clauses above never match them and
       * the cascade from `schools`/`organizations` never reaches them either. This clause only works
       * because it runs BEFORE `User.destroy` below: both trail tables are ON DELETE SET NULL from
       * `users`, so afterwards there is no `user_id` left to match.
       */
      ...(Array.isArray(created.users) && created.users.length ? [{ user_id: created.users }] : []),
    ];
    if (ownTenant.length) {
      await db.ActivityLog.destroy({
        where: { id: { [db.Op.gt]: baseline.activityLog }, [db.Op.or]: ownTenant },
      });
      await db.AuditLog.destroy({
        where: { id: { [db.Op.gt]: baseline.auditLog }, [db.Op.or]: ownTenant },
      });
    }
    if (created.schools.length) {
      await db.LibraryTransaction.destroy({ where: { school_id: created.schools } });
      await db.Book.destroy({ where: { school_id: created.schools } });
      await db.Student.destroy({ where: { school_id: created.schools }, force: true });
      await db.Teacher.destroy({ where: { school_id: created.schools }, force: true });
      await db.Staff.destroy({ where: { school_id: created.schools }, force: true });
      await db.Section.destroy({ where: { school_id: created.schools }, force: true });
      await db.Class.destroy({ where: { school_id: created.schools }, force: true });
      await db.AcademicSession.destroy({ where: { school_id: created.schools }, force: true });
    }
    if (created.subscriptions.length) {
      await db.UsageRecord.destroy({ where: { subscription_id: created.subscriptions } });
      await db.Subscription.destroy({ where: { id: created.subscriptions }, force: true });
    }
    /* By fixture marker as well as by id, so a crash before setup finishes cannot poison the next run. */
    await db.User.destroy({ where: { email: { [db.Op.like]: `%@${DOMAIN}` } }, force: true });
    const planWhere = {
      [db.Op.or]: [
        { code: { [db.Op.like]: `${CODE_PREFIX}%` } },
        ...(created.plans.length ? [{ id: created.plans }] : []),
      ],
    };
    const stale = (await db.SubscriptionPlan.findAll({ where: planWhere, attributes: ['id'] })).map((p) => p.id);
    if (stale.length) {
      await db.PlanModule.destroy({ where: { plan_id: stale } });
      await db.PlanLimit.destroy({ where: { plan_id: stale } });
      await db.SubscriptionPlan.destroy({ where: { id: stale }, force: true });
    }
    if (created.schools.length) await db.School.destroy({ where: { id: created.schools }, force: true });
    await db.Organization.destroy({
      where: {
        [db.Op.or]: [
          { code: { [db.Op.like]: `${CODE_PREFIX}%` } },
          ...(created.organizations.length ? [{ id: created.organizations }] : []),
        ],
      },
      force: true,
    });
  }

  try {
    const roles = {};
    for (const slug of [ROLES.PRINCIPAL, ROLES.LIBRARIAN, ROLES.TEACHER, ROLES.STUDENT, ROLES.PARENT]) {
      // eslint-disable-next-line no-await-in-loop
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
    const residueCleared = await sweepResidue(db, { codes: ['VLB-'], domains: ['verify-library.local'] });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify Library Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Library A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Library B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Library C');
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Library D');

    const mkPlan = async (code, libraryEnabled) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Library ${code}`, code: `${CODE_PREFIX}${code}`, status: PLAN_STATUS.ACTIVE,
        tier_rank: 1, trial_days: 0, grace_period_days: 7,
      });
      created.plans.push(plan.id);
      for (const key of MODULE_LIST) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanModule.create({
          plan_id: plan.id, module_key: key, is_enabled: key === MODULES.LIBRARY ? libraryEnabled : true,
        });
      }
      for (const k of [LIMITS.STUDENT_LIMIT, LIMITS.TEACHER_LIMIT, LIMITS.FILE_UPLOAD_LIMIT, LIMITS.STORAGE_LIMIT]) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanLimit.create({ plan_id: plan.id, limit_key: k, limit_type: LIMIT_TYPES.FIXED, limit_value: 100 });
      }
      return plan;
    };
    const withLibrary = await mkPlan('WITH', true);
    const withoutLibrary = await mkPlan('WITHOUT', false);

    const subscribe = async (school, plan) => {
      const now = new Date();
      const sub = await db.Subscription.create({
        school_id: school.id, organization_id: org.id, plan_id: plan.id,
        state: SUBSCRIPTION_STATES.ACTIVE, billing_cycle: BILLING_CYCLES.MONTHLY, cycle_amount: 100,
        starts_at: now, current_period_start: now,
        current_period_end: new Date(now.getTime() + 30 * 864e5), grace_period_days: 7,
      });
      created.subscriptions.push(sub.id);
    };
    await subscribe(schoolA, withLibrary);
    await subscribe(schoolB, withoutLibrary);
    await subscribe(schoolD, withLibrary);
    /* schoolC is deliberately left unsubscribed. */

    const session = await db.AcademicSession.create({
      school_id: schoolA.id, organization_id: org.id, name: 'A 2025-2026',
      start_date: '2025-04-01', end_date: '2026-03-31', status: ACADEMIC_SESSION_STATUS.ACTIVE, is_current: true,
    });
    const klass = await db.Class.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id, name: 'A Grade 1', numeric_order: 1,
    });

    const password_hash = await hashPassword(PASSWORD);
    const mkUser = async (key, slug, organization_id, school_id) => {
      const u = await db.User.create({
        role_id: roles[slug].id, organization_id, school_id, name: `Verify LIB ${key}`,
        email: `${key}@${DOMAIN}`, username: `vlb_${key.replace(/-/g, '_')}`,
        password_hash, status: USER_STATUS.ACTIVE, must_change_password: false,
      });
      created.users.push(u.id);
      return u;
    };
    await mkUser('principal-a', ROLES.PRINCIPAL, org.id, schoolA.id);
    await mkUser('principal-b', ROLES.PRINCIPAL, org.id, schoolB.id);
    await mkUser('principal-c', ROLES.PRINCIPAL, org.id, schoolC.id);
    await mkUser('principal-d', ROLES.PRINCIPAL, org.id, schoolD.id);
    await mkUser('librarian', ROLES.LIBRARIAN, org.id, schoolA.id);
    const teacherUser = await mkUser('teacher', ROLES.TEACHER, org.id, schoolA.id);
    const aminaUser = await mkUser('student-amina', ROLES.STUDENT, org.id, schoolA.id);
    const bilalUser = await mkUser('student-bilal', ROLES.STUDENT, org.id, schoolA.id);

    const mkStudent = async (key, first, user) =>
      db.Student.create({
        school_id: schoolA.id, organization_id: org.id, student_id: `${CODE_PREFIX}${key}`, first_name: first,
        admission_date: '2025-04-01', status: STUDENT_STATUS.ACTIVE,
        class_id: klass.id, academic_session_id: session.id, user_id: user ? user.id : null,
      });
    const amina = await mkStudent('S1', 'Amina', aminaUser);
    const bilal = await mkStudent('S2', 'Bilal', bilalUser);

    const teacherA = await db.Teacher.create({
      school_id: schoolA.id, organization_id: org.id, employee_id: `${CODE_PREFIX}T1`,
      first_name: 'Nadia', joining_date: '2024-01-15', user_id: teacherUser.id,
    });
    const foreignTeacher = await db.Teacher.create({
      school_id: schoolD.id, organization_id: org.id, employee_id: `${CODE_PREFIX}T9`,
      first_name: 'Faraway', joining_date: '2024-01-15',
    });
    const staffA = await db.Staff.create({
      school_id: schoolA.id, organization_id: org.id, employee_id: `${CODE_PREFIX}ST1`,
      first_name: 'Rashid', category: STAFF_CATEGORIES.ADMINISTRATIVE, joining_date: '2024-02-01',
    });

    async function signIn(identifier) {
      const res = await call('/auth/login', { method: 'POST', body: { identifier, password: PASSWORD } });
      const token = res.body && res.body.data ? res.body.data.accessToken : null;
      if (!token) throw new Error(`sign-in failed for ${identifier}: ${res.raw}`);
      return token;
    }
    const principalA = await signIn(`principal-a@${DOMAIN}`);
    const principalB = await signIn(`principal-b@${DOMAIN}`);
    const principalC = await signIn(`principal-c@${DOMAIN}`);
    const principalD = await signIn(`principal-d@${DOMAIN}`);
    const librarian = await signIn(`librarian@${DOMAIN}`);
    const teacherToken = await signIn(`teacher@${DOMAIN}`);
    const aminaToken = await signIn(`student-amina@${DOMAIN}`);
    await signIn(`student-bilal@${DOMAIN}`);

    /* ── the entitlement guard ── */

    const moduleDenied = await call('/library/books', { token: principalB });
    check('a plan without the Library module refuses', moduleDenied.status, 403);
    check('and names the module', codeOf(moduleDenied), 'MODULE_NOT_SUBSCRIBED');
    check('naming which one', moduleDenied.body.error.details.missing, [MODULES.LIBRARY]);
    const noSub = await call('/library/books', { token: principalC });
    check('a school with no subscription is refused differently', noSub.status, 402);
    check('state is checked before module', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');

    /* ── FR-LIB-001 — the catalogue ── */

    const mkBook = async (body, token = librarian) =>
      dataOf(await expectOk('/library/books', { method: 'POST', token, body }, 201)).book;

    const cosmos = await mkBook({
      title: 'Cosmos', author: 'Carl Sagan', category: 'Science', isbn: '9780345539434',
      publisher: 'Ballantine', quantity: 3, fine_per_day: 0.5, loan_days: 7, price: 12.99,
    });
    check('a Librarian creates a book — FR-LIB-001 names them as the actor', Boolean(cosmos.id), true);
    check('the school is taken from the caller, never the body', cosmos.school_id, schoolA.id);
    check('and so is the organization', cosmos.organization_id, org.id);
    check('§20.4\'s author and category are stored as the columns §29 gives them',
      [cosmos.author, cosmos.category], ['Carl Sagan', 'Science']);
    check('every copy of a new book is available, because none can be on loan yet',
      [cosmos.quantity, cosmos.available_quantity], [3, 3]);
    check('  which the response states directly', [cosmos.on_loan, cosmos.is_available], [0, true]);
    check('money crosses the wire as a number', [cosmos.fine_per_day, cosmos.price], [0.5, 12.99]);
    check('the loan length is the book\'s own', cosmos.loan_days, 7);

    /*
     * A real path written straight onto the row, the way an upload would, because a `create()` response
     * has no key for a column the insert never named — so asserting its absence on a fresh create would
     * be true with the suppression deleted. A deliberate regression proved exactly that. The read-back
     * is where the leak would show.
     */
    await db.Book.update({ cover_path: `school-${schoolA.id}/covers/secret.jpg` }, { where: { id: cosmos.id } });
    const reread = dataOf(await expectOk(`/library/books/${cosmos.id}`, { token: librarian }, 200)).book;
    check('a stored cover path never reaches a caller', 'cover_path' in reread, false);
    check('  even though the row really holds one',
      Boolean((await db.Book.findByPk(cosmos.id)).cover_path), true);
    check('  and nothing in the response leaks the directory layout',
      JSON.stringify(reread).includes('school-'), false);

    const defaults = await mkBook({ title: 'A book with defaults' });
    check('a book defaults to one copy', [defaults.quantity, defaults.available_quantity], [1, 1]);
    check('  with the SRS-fixed fourteen-day loan', defaults.loan_days, 14);

    const bodyAvailable = await call('/library/books', {
      method: 'POST', token: librarian, body: { title: 'Cheat', quantity: 1, available_quantity: 99 },
    });
    check('a body-supplied available_quantity is refused, not stripped', bodyAvailable.status, 422);
    const bodyCover = await call('/library/books', {
      method: 'POST', token: librarian, body: { title: 'Cheat', cover_path: '../../etc/passwd' },
    });
    check('and so is a cover_path — this module adds no sixth column to Known Issues #26', bodyCover.status, 422);

    const studentCreate = await call('/library/books', {
      method: 'POST', token: aminaToken, body: { title: 'By a student' },
    });
    check('a Student cannot add to the catalogue', studentCreate.status, 403);
    check('  refused on the permission', codeOf(studentCreate), 'INSUFFICIENT_PERMISSION');
    const teacherRead = await call('/library/books', { token: teacherToken });
    check('a Teacher cannot even read the catalogue — they hold no library key at all', teacherRead.status, 403);
    check('  on the permission, not on the module', codeOf(teacherRead), 'INSUFFICIENT_PERMISSION');

    const studentBrowse = await expectOk('/library/books?limit=100', { token: aminaToken }, 200);
    check('a Student browses the whole catalogue — FR-LIB-001 makes it "available"',
      [idsOf(studentBrowse).includes(cosmos.id), idsOf(studentBrowse).includes(defaults.id)], [true, true]);

    /* ── FR-LIB-002 — issue ── */

    const issueOne = async (body, token = librarian, want = 201) =>
      dataOf(await expectOk('/library/transactions', { method: 'POST', token, body }, want)).transaction;

    const loan1 = await issueOne({
      book_id: cosmos.id, borrower_type: LIBRARY_BORROWER_TYPES.STUDENT, student_id: amina.id,
      issue_date: '2026-08-01',
    });
    check('a Librarian issues a book to a student', loan1.borrower_type, LIBRARY_BORROWER_TYPES.STUDENT);
    check('the loan opens as issued', loan1.status, LIBRARY_TRANSACTION_STATUS.ISSUED);
    check('the issuer is stamped', Boolean(loan1.issued_by), true);
    check('the due date comes from the book\'s own loan_days when none is named',
      [loan1.issue_date, loan1.due_date], ['2026-08-01', '2026-08-08']);
    check('and a copy has left the shelf', await shelf(cosmos.id), [3, 2]);

    /*
     * Explicit issue dates on all three, because the return dates below are fixed calendar dates and a
     * defaulted `issue_date` is *today* — which would put every return before its own issue the moment
     * the system clock passed them. That is a fixture trap this suite fell into on its first run.
     */
    const loan2 = await issueOne({
      book_id: cosmos.id, borrower_type: LIBRARY_BORROWER_TYPES.TEACHER, teacher_id: teacherA.id,
      issue_date: '2026-08-01',
    });
    check('the same book is issued to a teacher — a borrower need not be a caller', loan2.teacher_id, teacherA.id);
    const loan3 = await issueOne({
      book_id: cosmos.id, borrower_type: LIBRARY_BORROWER_TYPES.STAFF, staff_id: staffA.id,
      issue_date: '2026-08-01',
    });
    check('and to a staff member, the third borrower type the enum offers', loan3.staff_id, staffA.id);
    check('three copies out, none left', await shelf(cosmos.id), [3, 0]);

    const soldOut = await call('/library/transactions', {
      method: 'POST', token: librarian,
      body: { book_id: cosmos.id, borrower_type: LIBRARY_BORROWER_TYPES.STUDENT, student_id: bilal.id },
    });
    check('the last copy gone, a further issue is refused', soldOut.status, 409);
    check('  by FR-LIB-002\'s stated precondition', codeOf(soldOut), 'BOOK_UNAVAILABLE');
    check('  and the shelf is untouched by the refusal', await shelf(cosmos.id), [3, 0]);

    const foreignTeacherLoan = await call('/library/transactions', {
      method: 'POST', token: librarian,
      body: { book_id: defaults.id, borrower_type: LIBRARY_BORROWER_TYPES.TEACHER, teacher_id: foreignTeacher.id },
    });
    check("a borrower from another school is refused", foreignTeacherLoan.status, 422);

    const retired = await mkBook({ title: 'Retired', quantity: 1 });
    await expectOk(`/library/books/${retired.id}`, { method: 'PATCH', token: librarian, body: { is_active: false } }, 200);
    const retiredLoan = await call('/library/transactions', {
      method: 'POST', token: librarian,
      body: { book_id: retired.id, borrower_type: LIBRARY_BORROWER_TYPES.STUDENT, student_id: amina.id },
    });
    check('a retired book is not issued, there being no DELETE', retiredLoan.status, 409);
    check('  saying why', codeOf(retiredLoan), 'BOOK_INACTIVE');

    const studentIssue = await call('/library/transactions', {
      method: 'POST', token: aminaToken,
      body: { book_id: defaults.id, borrower_type: LIBRARY_BORROWER_TYPES.STUDENT, student_id: amina.id },
    });
    check('a Student cannot issue a book to themselves', studentIssue.status, 403);

    /* ── FR-LIB-002 — return, and the fine the system calculates ── */

    const returned1 = dataOf(
      await expectOk(`/library/transactions/${loan2.id}/return`, {
        method: 'PATCH', token: librarian, body: { return_date: '2026-08-05' },
      }, 200)
    ).transaction;
    check('a return closes the loan', returned1.status, LIBRARY_TRANSACTION_STATUS.RETURNED);
    check('the receiver is stamped', Boolean(returned1.received_by), true);
    check('an on-time return carries no fine', returned1.fine_amount, 0);
    check('and the copy is back on the shelf', await shelf(cosmos.id), [3, 1]);

    const twice = await call(`/library/transactions/${loan2.id}/return`, { method: 'PATCH', token: librarian, body: {} });
    check('a closed loan cannot be returned again', twice.status, 409);
    check('  saying so', codeOf(twice), 'LOAN_NOT_OPEN');
    check('  and the shelf did not move', await shelf(cosmos.id), [3, 1]);

    /* fine_per_day 0.5, due 2026-08-08, returned 2026-08-18 → 10 days × 0.5 = 5.00 */
    const late = dataOf(
      await expectOk(`/library/transactions/${loan1.id}/return`, {
        method: 'PATCH', token: librarian, body: { return_date: '2026-08-18' },
      }, 200)
    ).transaction;
    check('a late return is fined — FR-LIB-002: the system calculates it', late.fine_amount, 5);
    check('  at the book\'s rate times the whole days past the due date', [0.5 * 10, late.fine_amount], [5, 5]);
    check('  and the whole fine is outstanding until it is settled', late.fine_outstanding, 5);
    check('  a closed loan is never reported overdue; the fine is what records it',
      [late.is_overdue, late.days_overdue], [false, 0]);
    check('the copy still came back', await shelf(cosmos.id), [3, 2]);

    const lost = dataOf(
      await expectOk(`/library/transactions/${loan3.id}/return`, {
        method: 'PATCH', token: librarian,
        body: { outcome: LIBRARY_TRANSACTION_STATUS.LOST, return_date: '2026-08-10', remarks: 'Reported lost' },
      }, 200)
    ).transaction;
    check('a copy can be recorded lost, the enum\'s other terminal state', lost.status, LIBRARY_TRANSACTION_STATUS.LOST);
    check('  it is still fined for the days it was overdue', lost.fine_amount, 1);
    check(
      '  and it does NOT come back to the shelf — the gap against quantity is what records the loss',
      await shelf(cosmos.id),
      [3, 2]
    );

    const backwards = await mkBook({ title: 'Backwards', quantity: 1 });
    const backLoan = await issueOne({
      book_id: backwards.id, borrower_type: LIBRARY_BORROWER_TYPES.STUDENT, student_id: amina.id,
      issue_date: '2026-08-10',
    });
    const badReturn = await call(`/library/transactions/${backLoan.id}/return`, {
      method: 'PATCH', token: librarian, body: { return_date: '2026-08-01' },
    });
    check('a return before the issue date is refused', badReturn.status, 422);
    check('  and the loan is still open', (await db.LibraryTransaction.findByPk(backLoan.id)).status,
      LIBRARY_TRANSACTION_STATUS.ISSUED);

    /* ── FR-LIB-002 — "manages associated fines" ── */

    const overPaid = await call(`/library/transactions/${late.id}/fine`, {
      method: 'PATCH', token: librarian, body: { fine_paid: 6 },
    });
    check('a payment larger than the fine is refused', overPaid.status, 422);
    check('  naming the field', overPaid.body.error.details[0].field, 'fine_paid');

    const partPaid = dataOf(
      await expectOk(`/library/transactions/${late.id}/fine`, {
        method: 'PATCH', token: librarian, body: { fine_paid: 2 },
      }, 200)
    ).transaction;
    check('a part payment is recorded', partPaid.fine_paid, 2);
    check('  and the remainder stays outstanding', partPaid.fine_outstanding, 3);

    const settled = dataOf(
      await expectOk(`/library/transactions/${late.id}/fine`, {
        method: 'PATCH', token: librarian, body: { fine_paid: 5 },
      }, 200)
    ).transaction;
    check('paying it in full settles it', settled.fine_outstanding, 0);

    const waived = dataOf(
      await expectOk(`/library/transactions/${lost.id}/fine`, {
        method: 'PATCH', token: librarian, body: { fine_waived: true, reason: 'Long-standing borrower' },
      }, 200)
    ).transaction;
    check('or the librarian waives it', [waived.fine_waived, waived.fine_outstanding], [true, 0]);

    const noFine = await call(`/library/transactions/${returned1.id}/fine`, {
      method: 'PATCH', token: librarian, body: { fine_paid: 1 },
    });
    check('a loan with no fine has nothing to settle', noFine.status, 409);
    check('  saying so', codeOf(noFine), 'NO_FINE_TO_SETTLE');

    const studentSettles = await call(`/library/transactions/${late.id}/fine`, {
      method: 'PATCH', token: aminaToken, body: { fine_paid: 1 },
    });
    check('a Student cannot settle their own fine', studentSettles.status, 403);

    /* ── the counter under catalogue edits ── */

    const grow = dataOf(
      await expectOk(`/library/books/${cosmos.id}`, { method: 'PATCH', token: librarian, body: { quantity: 5 } }, 200)
    ).book;
    check('buying more copies raises the available count by the same delta', await shelf(cosmos.id), [5, 4]);
    check('  so the copies on loan are unchanged', grow.on_loan, 1);

    const shrinkOk = dataOf(
      await expectOk(`/library/books/${cosmos.id}`, { method: 'PATCH', token: librarian, body: { quantity: 1 } }, 200)
    ).book;
    check('withdrawing copies lowers it the same way, down to the copies on loan', await shelf(cosmos.id), [1, 0]);
    check('  and the invariant still holds', shrinkOk.on_loan, 1);

    const shrinkTooFar = await call(`/library/books/${cosmos.id}`, {
      method: 'PATCH', token: librarian, body: { quantity: 0 },
    });
    check('but not below them — the available count cannot go negative', shrinkTooFar.status, 409);
    check('  saying why', codeOf(shrinkTooFar), 'QUANTITY_BELOW_LOANS');
    check('  and nothing moved', await shelf(cosmos.id), [1, 0]);

    /* ── overdue is derived, and the stored column never holds it ── */

    const overdueBook = await mkBook({ title: 'Overdue title', quantity: 1, fine_per_day: 1, loan_days: 1 });
    const openLate = await issueOne({
      book_id: overdueBook.id, borrower_type: LIBRARY_BORROWER_TYPES.STUDENT, student_id: bilal.id,
      issue_date: '2025-01-01', due_date: '2025-01-08',
    });
    const readBack = dataOf(await expectOk(`/library/transactions/${openLate.id}`, { token: librarian }, 200)).transaction;
    check('an open loan past its due date reports itself overdue', readBack.is_overdue, true);
    check('  with the days counted', readBack.days_overdue > 300, true);
    check(
      '  while the stored status is still "issued", because nothing writes the overdue value',
      (await db.LibraryTransaction.findByPk(openLate.id)).status,
      LIBRARY_TRANSACTION_STATUS.ISSUED
    );
    const overdueList = await expectOk(
      `/library/transactions?status=${LIBRARY_TRANSACTION_STATUS.OVERDUE}&limit=100`, { token: librarian }, 200
    );
    check('the overdue filter finds it by computing, not by reading a column',
      idsOf(overdueList).includes(openLate.id), true);
    check('  and does not report a loan that came back late as still overdue',
      idsOf(overdueList).includes(late.id), false);

    /*
     * A fine that is genuinely unsettled, so the filter has a positive case to find. Without one the
     * two exclusions below would pass with the filter deleted, because neither row would be in an
     * unfiltered list either — the §20.3 lesson about an assertion that proves nothing.
     */
    const unpaidBook = await mkBook({ title: 'Unpaid fine', quantity: 1, fine_per_day: 2, loan_days: 1 });
    const unsettledLoan = await issueOne({
      book_id: unpaidBook.id, borrower_type: LIBRARY_BORROWER_TYPES.STUDENT, student_id: bilal.id,
      issue_date: '2026-08-01', due_date: '2026-08-02',
    });
    const unsettled = dataOf(
      await expectOk(`/library/transactions/${unsettledLoan.id}/return`, {
        method: 'PATCH', token: librarian, body: { return_date: '2026-08-06' },
      }, 200)
    ).transaction;
    check('a fine nobody has settled stays wholly outstanding',
      [unsettled.fine_amount, unsettled.fine_outstanding], [8, 8]);

    const outstanding = await expectOk('/library/transactions?fine_outstanding=true&limit=100', { token: librarian }, 200);
    check('an unsettled fine is found by comparing the two columns, not by a flag',
      idsOf(outstanding).includes(unsettledLoan.id), true);
    check('  while a fully paid one is not', idsOf(outstanding).includes(late.id), false);
    check('  and neither is a waived one, whatever the two numbers say',
      idsOf(outstanding).includes(lost.id), false);

    /* ── a student sees their own loans and nobody else's ── */

    const aminaLoans = await expectOk('/library/transactions?limit=100', { token: aminaToken }, 200);
    check('a student sees their own loan', idsOf(aminaLoans).includes(late.id), true);
    check('  and not another student\'s', idsOf(aminaLoans).includes(openLate.id), false);
    check('  nor the teacher\'s or the staff member\'s',
      [idsOf(aminaLoans).includes(loan2.id), idsOf(aminaLoans).includes(loan3.id)], [false, false]);
    check('  every row is theirs', (dataOf(aminaLoans) || []).every((r) => r.student_id === amina.id), true);

    const aminaAsksForBilal = await expectOk(
      `/library/transactions?student_id=${bilal.id}&limit=100`, { token: aminaToken }, 200
    );
    check('naming another student intersects to nothing rather than overriding the narrowing',
      dataOf(aminaAsksForBilal).length, 0);
    const otherById = await call(`/library/transactions/${openLate.id}`, { token: aminaToken });
    check('and another student\'s loan cannot be read by guessing its id', otherById.status, 404);
    check('  while their own can be', (await call(`/library/transactions/${late.id}`, { token: aminaToken })).status, 200);

    const librarianAll = await expectOk('/library/transactions?limit=100', { token: librarian }, 200);
    check('a librarian sees every borrower, so the narrowing is the student\'s and not the query\'s',
      [idsOf(librarianAll).includes(late.id), idsOf(librarianAll).includes(loan2.id),
        idsOf(librarianAll).includes(loan3.id), idsOf(librarianAll).includes(openLate.id)],
      [true, true, true, true]);

    /* ── tenant isolation ── */

    const crossRead = await call(`/library/books/${cosmos.id}`, { token: principalD });
    check('a principal of another school cannot read this book', crossRead.status, 404);
    const crossNamed = await call(`/library/books?school_id=${schoolD.id}`, { token: principalA });
    check('and naming another school is refused by the tenant chain', crossNamed.status, 403);
    check('  before the record is ever looked for', codeOf(crossNamed), 'CROSS_TENANT_ACCESS_DENIED');

    /* ── the trail ── */

    /*
     * Named explicitly rather than `settleDistinct(..., 'entity_type', 2)`. This query is NOT filtered
     * by entity_type, so it also returns the sign-in rows — two distinct values can therefore be
     * reached as {login, books} while `library_transactions` has not landed yet, and the poll would
     * return exactly one assertion too early. The predicate below waits for the two the assertions
     * actually name.
     */
    const activity = await settle(() => db.ActivityLog.findAll({
      where: { id: { [db.Op.gt]: baseline.activityLog } }, order: [['id', 'ASC']],
    }), (rows) => rows.some((r) => r.entity_type === 'books')
      && rows.some((r) => r.entity_type === 'library_transactions'));
    check('every catalogue write is in the activity trail',
      activity.filter((r) => r.entity_type === 'books').length > 0, true);
    check('and every loan write', activity.filter((r) => r.entity_type === 'library_transactions').length > 0, true);

    const bookAudits = await settleRows(() => db.AuditLog.findAll({
      where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: 'books' },
    }));
    const loanAudits = await settleDistinct(() => db.AuditLog.findAll({
      where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: 'library_transactions' },
    }), 'event', 2);
    check('books are audited per row', bookAudits.length > 0, true);
    check('and so are loans', loanAudits.length > 0, true);
    check('  an issue is audited as a create', loanAudits.some((r) => r.event === 'create'), true);
    check('  a return as an update', loanAudits.some((r) => r.event === 'update'), true);
    const waiver = loanAudits.find((r) => r.reason === 'Long-standing borrower');
    check('  and a waiver carries the reason it was given', Boolean(waiver), true);
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-library Part 3 teardown failed:', err);
    }
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

/* ═══════════════════════════════════════ run ═══════════════════════════════════════ */

async function main() {
  verifySchemas();
  verifyRouting();

  try {
    await db.sequelize.authenticate();
  } catch (err) {
    dbSkipped = true;
    console.log(`\nSKIP  Part 3 (HTTP) — database unreachable: ${err.message}`);
    return;
  }

  await verifyHttp();
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nverify-library crashed:', err);
  })
  .finally(async () => {
    console.log('');
    if (dbSkipped) {
      console.log('⚠  Part 3 (HTTP) was SKIPPED — MySQL/MariaDB is not reachable.');
      console.log('   Parts 1–2 (pure) executed in full.');
    }
    if (failures === 0) {
      console.log(
        dbSkipped
          ? 'All pure library checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All library checks passed (Parts 1–3).'
      );
    } else {
      console.log(`${failures} check(s) FAILED.`);
    }
    try {
      await db.sequelize.close();
    } catch (_) {
      /* the pool may never have opened */
    }
    /*
     * A degraded run is a FAILED run — Known Issue 28.
     *
     * This suite answers an unreachable database by setting `dbSkipped`, returning early from its
     * database half and printing that it passed. Until session 26 it then **exited 0**, so a stopped
     * MySQL read as a green run to anything that looks at the exit code — which is `node
     * scripts/verify-*.js` run directly (the workflow this project's log documents throughout) and
     * `scripts/stress.sh:17`, whose entire scoring is `if ! wait "$pid"`. A stress run with the
     * database down would have reported a perfect determinism score for suites that never ran.
     *
     * `npm test` was never exposed: `tests/globalSetup.js` proves the database with `SELECT
     * DATABASE()` before any suite spawns, and `tests/verify.test.js` asserts both that `skipped` is
     * empty and that each suite produced its exact recorded count. This closes the direct-run path,
     * which is the one a person uses.
     *
     * `--allow-skip` is for running the pure checks deliberately, and mirrors `--allow-shrink` in
     * `record-baseline.js` rather than inventing a new convention. The jest harness passes no
     * arguments (`suiteRunner.js:220`), so it can never opt out by accident.
     */
    if (dbSkipped && !process.argv.includes('--allow-skip')) {
      console.log('');
      console.log('   Exiting 1: the database half did not run, so this is not a pass.');
      console.log('   Re-run with --allow-skip to execute the pure checks on purpose.');
      process.exit(1);
    }
    process.exit(failures === 0 ? 0 : 1);
  });
