'use strict';

/**
 * Concurrency — Known Issues #21, the limit check and the write it guards.
 *
 * ## Why this suite exists rather than assertions inside the three module suites
 *
 * Because what it asserts is not a property of any one module. `enforceLimit` counts, decides and
 * returns; the handler then opens a transaction and writes. Two requests can both pass a ceiling of
 * N and leave the school at N+1, and that is a property of the **guard**, present since the guard was
 * written, and reachable through students, teachers and staff alike. A suite per module would assert
 * it three times and each would look like a module bug.
 *
 * It also needs something no other suite does: **genuine parallelism**. Every other assertion in this
 * loop is sequential on purpose. This one fires N calls with `Promise.all` and reads the table
 * afterwards, which is the only shape in which the defect appears at all.
 *
 * ## The defect, measured before the fix was written
 *
 * Against `msms_test`, one school on a plan whose `student_limit`, `teacher_limit` and `staff_limit`
 * are each **1**, with eight concurrent creates on each:
 *
 *     students  8 concurrent, limit 1 -> 8 admitted, 8 in table   RACE
 *     teachers  8 concurrent, limit 1 -> 8 admitted, 8 in table   RACE
 *     staff     8 concurrent, limit 1 -> 8 admitted, 8 in table   RACE
 *
 * Three of three, every run. After `usageService.reserveHeadcount()` was added to the three create
 * paths: one admitted and one row, every run, with the other seven refused `PLAN_LIMIT_EXCEEDED`.
 * Removing the three reservation calls reproduces the table above exactly, which is how this suite
 * was checked against the thing it is supposed to catch.
 *
 * ## `ai_limit` is here too, and it is fixed by a different instrument
 *
 * It is the fourth racing key, and a lock is the wrong tool for it: its critical section is an entire
 * LLM provider round trip, so the remedy the three above use would hold a `schools` row lock across a
 * call to a third party — blocking every other write for that school for as long as the provider takes,
 * and turning a provider outage into a database pile-up. `usageService.reserveUsage()` takes the
 * allowance **before** the driver instead, in one conditional `UPDATE` whose row lock lives and dies
 * inside that statement, and `releaseUsage()` gives it back when nothing was produced.
 *
 * Measured the same way: eight concurrent generates against `ai_limit: 1`, each on its own question
 * bank because the workflow stage machine already serialises two generates on one bank. Before the fix,
 * **8 admitted and the counter at 8**; after, one admitted, seven refused `PLAN_LIMIT_EXCEEDED`, and the
 * counter at exactly 1. The refund is asserted separately, by making the provider fail.
 *
 * The other four §11.2 keys cannot race: `admin_limit` has no guard mounted, `storage_limit` is never
 * incremented, `api_limit` has no writer, and `file_upload_limit` is per-request and reads no shared
 * state.
 *
 * ## The fixture, and why it must be its own school
 *
 * A ceiling of 1 is the smallest that can be exceeded, and the smallest that makes "one admitted" an
 * unambiguous pass. All four limits are set to it. The school is created here and removed here: sharing a fixture school with
 * another suite would let this one's eight parallel writes interleave with that one's assertions.
 * Every row it creates carries the `CONC-21` code or a `Conc` name prefix, and teardown is checked
 * rather than assumed.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
/*
 * Pinned, not inherited. The `ai_limit` half below drives `ai.service.generate()` for real, and a run
 * that picked up a live provider from a local `.env` would make network calls from the verification
 * loop and take its answers from a third party. `.env` already sets `mock`; this makes it a property of
 * the suite rather than of the machine it happens to run on.
 */
process.env.AI_DRIVER = 'mock';

const db = require('../src/models');
const usageService = require('../src/services/usageService');
const tenantService = require('../src/services/tenantService');
const studentsService = require('../src/modules/students/students.service');
const teachersService = require('../src/modules/teachers/teachers.service');
const staffService = require('../src/modules/staff/staff.service');
const aiService = require('../src/modules/ai/ai.service');
const { LIMITS } = require('../src/config/constants');

const TAG = 'CONC-21';
const CONCURRENCY = 8;

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${
      ok ? '' : `  (expected ${JSON.stringify(expected)})`
    }`
  );
}

async function cleanup() {
  await db.sequelize.query("DELETE FROM students WHERE first_name LIKE 'Conc%'");
  await db.sequelize.query("DELETE FROM teachers WHERE first_name LIKE 'Conc%'");
  await db.sequelize.query("DELETE FROM staff WHERE first_name LIKE 'Conc%'");
  await db.sequelize.query(
    "DELETE FROM questions WHERE question_bank_id IN (SELECT id FROM question_banks WHERE name LIKE 'Conc %')"
  );
  await db.sequelize.query("DELETE FROM question_banks WHERE name LIKE 'Conc %'");
  await db.sequelize.query(
    "DELETE FROM usage_records WHERE school_id IN (SELECT id FROM schools WHERE code = 'CONC-21')"
  );
  await db.sequelize.query(
    `DELETE FROM plan_limits WHERE plan_id IN (SELECT id FROM subscription_plans WHERE code = '${TAG}')`
  );
  await db.sequelize.query(
    `DELETE FROM subscriptions WHERE school_id IN (SELECT id FROM schools WHERE code = '${TAG}')`
  );
  await db.sequelize.query(
    `DELETE FROM plan_prices WHERE plan_id IN (SELECT id FROM subscription_plans WHERE code = '${TAG}')`
  );
  await db.sequelize.query(`DELETE FROM subscription_plans WHERE code = '${TAG}'`);
  await db.sequelize.query(`DELETE FROM schools WHERE code = '${TAG}'`);
  await db.sequelize.query(`DELETE FROM organizations WHERE code = '${TAG}'`);
}

/** A school of its own, on a plan whose four racing ceilings are each 1. */
async function buildFixture() {
  const org = await db.Organization.create({ name: 'Concurrency Org', code: TAG, status: 'active' });
  const school = await db.School.create({
    name: 'Concurrency School',
    code: TAG,
    organization_id: org.id,
    status: 'active',
  });
  const plan = await db.SubscriptionPlan.create({
    name: 'Concurrency Plan',
    code: TAG,
    status: 'active',
    visibility: 'private',
    tier_rank: 1,
  });

  for (const key of [LIMITS.STUDENT_LIMIT, LIMITS.TEACHER_LIMIT, LIMITS.STAFF_LIMIT, LIMITS.AI_LIMIT]) {
    /* eslint-disable-next-line no-await-in-loop */
    await db.PlanLimit.create({
      plan_id: plan.id,
      limit_key: key,
      limit_type: 'fixed',
      limit_value: 1,
      allow_overage: false,
    });
  }

  const price = await db.PlanPrice.create({
    plan_id: plan.id,
    billing_cycle: 'monthly',
    pricing_model: 'fixed',
    currency: 'USD',
    base_amount: 10,
    is_active: true,
    is_default: true,
  });

  const now = new Date();
  await db.Subscription.create({
    school_id: school.id,
    organization_id: org.id,
    plan_id: plan.id,
    plan_price_id: price.id,
    state: 'active',
    billing_cycle: 'monthly',
    currency: 'USD',
    cycle_amount: 10,
    quantity: 1,
    starts_at: now,
    current_period_start: now,
    current_period_end: new Date(now.getTime() + 30 * 86400000),
  });

  await tenantService.invalidateSchool(school.id);
  return { org, school };
}

function requestFor(school, org) {
  return {
    tenant: { isPlatform: false, schoolId: school.id, organizationId: org.id },
    user: { id: null },
    ip: '127.0.0.1',
  };
}

/** Run one composed create and report either `created` or the code it was refused with. */
async function attempt(fn) {
  try {
    await fn();
    return 'created';
  } catch (err) {
    return err.code || err.name || 'error';
  }
}

async function main() {
  console.log('=== Known Issues #21 — the limit check and the write it guards ===\n');

  await cleanup();
  const { org, school } = await buildFixture();
  const req = requestFor(school, org);

  /*
   * Each attempt is composed exactly as the route composes it: `assertWithinLimit` first, which is
   * what `enforceLimit` does, and then the service. The guard call is included rather than skipped
   * because leaving it out would test a path no request takes — and because the whole point is that
   * this check alone is **not** sufficient.
   */

  /*
   * `student_id` and `roll_number` are supplied so `allocateStudentId` and `allocateRollNumber` are
   * skipped. Their own `FOR UPDATE` reads serialise concurrent admissions as a side effect, which
   * masks the race being measured — with them in play the second admission collides and errors
   * rather than being admitted, so the guard's behaviour is never seen. This suite is about the
   * guard, so the allocator is taken out of the way. Found while reproducing the defect.
   */
  const cases = [
    {
      label: 'students',
      table: 'students',
      limitKey: LIMITS.STUDENT_LIMIT,
      run: (n) =>
        studentsService.create(req, {
          school_id: school.id,
          first_name: `Conc${n}`,
          last_name: 'Probe',
          admission_date: '2026-01-05',
          student_id: `${TAG}-${n}`,
          roll_number: `C${n}`,
        }),
    },
    {
      label: 'teachers',
      table: 'teachers',
      limitKey: LIMITS.TEACHER_LIMIT,
      run: (n) =>
        teachersService.create(req, {
          school_id: school.id,
          first_name: `Conc${n}`,
          last_name: 'Teacher',
          employee_id: `${TAG}-T${n}`,
          joining_date: '2026-01-05',
        }),
    },
    {
      label: 'staff',
      table: 'staff',
      limitKey: LIMITS.STAFF_LIMIT,
      run: (n) =>
        staffService.create(req, {
          school_id: school.id,
          first_name: `Conc${n}`,
          last_name: 'Staff',
          employee_id: `${TAG}-S${n}`,
          designation: 'Probe',
          joining_date: '2026-01-05',
        }),
    },
  ];

  for (const testCase of cases) {
    /* eslint-disable no-await-in-loop */
    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, n) =>
        attempt(async () => {
          await usageService.assertWithinLimit(school.id, testCase.limitKey, 1);
          await testCase.run(n);
        })
      )
    );

    const [{ n: stored }] = await db.sequelize.query(
      `SELECT COUNT(*) AS n FROM ${testCase.table} WHERE school_id = ${school.id}`,
      { type: db.sequelize.QueryTypes.SELECT }
    );

    const created = outcomes.filter((outcome) => outcome === 'created').length;

    /*
     * The row count is the assertion that matters, not the number of successful calls: a create that
     * succeeded and was rolled back would inflate the second and not the first, and it is the table
     * that decides whether the school is over its plan.
     */
    check(
      `${CONCURRENCY} concurrent ${testCase.label} against a ceiling of 1 leave exactly one row`,
      Number(stored),
      1
    );
    check(`  and exactly one call succeeded`, created, 1);

    /*
     * Every other call must be refused **by the limit**, not by a deadlock or a unique-key collision.
     * Without this, a fix that merely made concurrent creates fail for some other reason would pass
     * the two assertions above while leaving the guard broken.
     */
    const refusals = [...new Set(outcomes.filter((outcome) => outcome !== 'created'))];
    check(`  and the other ${CONCURRENCY - 1} were refused by the limit and nothing else`, refusals, [
      'PLAN_LIMIT_EXCEEDED',
    ]);
    /* eslint-enable no-await-in-loop */
  }

  /*
   * The reservation is guarded by the same predicate the headcount counts by, so a row created
   * inactive is admitted at the ceiling. `verify-teachers.js` asserts that from the module's side;
   * asserted here too, because it is the one way this fix could be made "safe" by being too strict.
   */
  const inactive = await attempt(() =>
    teachersService.create(req, {
      school_id: school.id,
      first_name: 'ConcInactive',
      last_name: 'Teacher',
      employee_id: `${TAG}-TI`,
      joining_date: '2026-01-05',
      is_active: false,
    })
  );
  check('an inactive teacher is still admitted at the ceiling, because it is not counted', inactive, 'created');

  /* ═════════════════ ai_limit — reserve-then-refund, no lock held across the provider ═════════════════ */

  /*
   * Eight banks, not one. `generate` requires `workflow_stage: 'analyzed'` and leaves `generated`, so
   * the stage machine already refuses a second generate on the same bank — a single-bank fixture would
   * measure that refusal and report a pass having never exercised the limit at all. Each bank is
   * planted directly at `analyzed`: the four steps before it are `verify-ai.js`'s subject, and driving
   * them here would only add ways for this fixture to fail for reasons that are not the point.
   */
  const banks = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, n) =>
      db.QuestionBank.create({
        school_id: school.id,
        organization_id: org.id,
        name: `Conc bank ${n}`,
        topic: 'Concurrency',
        source_type: 'syllabus',
        extracted_text: `Concurrency probe ${n}. `.repeat(20),
        analyzed_topics: [{ name: 'Concurrency', weight: 1 }],
        workflow_stage: 'analyzed',
        is_ai_generated: true,
      })
    )
  );

  const aiOutcomes = await Promise.all(
    banks.map((bank, n) =>
      attempt(async () => {
        await usageService.assertWithinLimit(school.id, LIMITS.AI_LIMIT, 1);
        await aiService.generate(req, bank.id, { count: 2, difficulty: 'medium' });
      }).then((outcome) => ({ outcome, n }))
    )
  );

  const generated = aiOutcomes.filter((r) => r.outcome === 'created').length;
  const aiUsage = await usageService.getUsage(school.id, LIMITS.AI_LIMIT);

  /*
   * The counter is the assertion that matters here, where the row count was the assertion for the three
   * above: `ai_limit` is PERIODIC, so what the plan constrains is `usage_records.used_value` and not a
   * number of rows in a table.
   */
  check(
    `${CONCURRENCY} concurrent generates against an ai_limit of 1 leave the counter at exactly one`,
    aiUsage.used,
    1
  );
  check('  and exactly one call produced questions', generated, 1);
  check(
    `  and the other ${CONCURRENCY - 1} were refused by the limit and nothing else`,
    [...new Set(aiOutcomes.filter((r) => r.outcome !== 'created').map((r) => r.outcome))],
    ['PLAN_LIMIT_EXCEEDED']
  );

  /*
   * The refund, which is the half a reservation can get wrong in the other direction. A provider that
   * fails must cost nothing — `ai.service.js` promised that before the reservation existed and the
   * promise now has to be kept by giving the unit back rather than by not having taken it yet.
   *
   * Provoked by emptying the source text, which `mock.js` still generates from — so the failure is
   * forced through the module's own error path by replacing the driver's `generate` for one call, the
   * technique `verify-notifications.js` uses on `mailService.send`.
   */
  await usageService.releaseUsage(school.id, LIMITS.AI_LIMIT, 1);
  const zeroed = await usageService.getUsage(school.id, LIMITS.AI_LIMIT);
  check('the counter can be given back, and does not go below zero', zeroed.used, 0);

  const aiDriver = require('../src/ai');
  const realGenerate = aiDriver.generate;
  aiDriver.generate = async () => {
    throw new Error('Concurrency probe: the provider is down');
  };
  const failedBank = await db.QuestionBank.create({
    school_id: school.id,
    organization_id: org.id,
    name: 'Conc bank failure',
    topic: 'Concurrency',
    source_type: 'syllabus',
    extracted_text: 'Concurrency failure probe.',
    analyzed_topics: [{ name: 'Concurrency', weight: 1 }],
    workflow_stage: 'analyzed',
    is_ai_generated: true,
  });
  const failed = await attempt(() => aiService.generate(req, failedBank.id, { count: 2 }));
  aiDriver.generate = realGenerate;

  check('a generation the provider failed is refused', failed !== 'created', true);
  const afterFailure = await usageService.getUsage(school.id, LIMITS.AI_LIMIT);
  check('  and costs the school nothing, because the reservation is refunded', afterFailure.used, 0);
  /*
   * Not vacuous: the same fixture with a working driver charges one. Without this, a `reserveUsage`
   * that never incremented at all would pass the assertion above.
   */
  const succeeded = await attempt(() => aiService.generate(req, failedBank.id, { count: 2 }));
  check('  which is not vacuous — the same bank charges one when the provider works', succeeded, 'created');
  check('    leaving the counter at one', (await usageService.getUsage(school.id, LIMITS.AI_LIMIT)).used, 1);

  await cleanup();
  await tenantService.invalidateSchool(school.id);

  const [{ n: leftover }] = await db.sequelize.query(
    `SELECT COUNT(*) AS n FROM schools WHERE code = '${TAG}'`,
    { type: db.sequelize.QueryTypes.SELECT }
  );
  check('the fixture school is removed', Number(leftover), 0);

  console.log('');
  if (failures > 0) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
  console.log('All concurrency checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
