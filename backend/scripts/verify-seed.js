'use strict';

/**
 * Behavioural verification for the core seeders (Phase 3.B).
 *
 * These are the guarantees the seeders' own comments claim, exercised against the live
 * database. Each case mutates a row the way an administrator or a bad deploy would, re-runs
 * the seed, and asserts what changed and what did not.
 */

const db = require('../src/models');
const seed = require('../src/database/seed');
const { restoreSeededCatalogue, readJournal, writeJournal, clearJournal } = require('./lib/residue');

const pass = [];
const fail = [];
const check = (name, ok, detail) => (ok ? pass : fail).push(name + (detail ? ` — ${detail}` : ''));

const q = async (sql) => db.sequelize.query(sql, { type: db.sequelize.QueryTypes.SELECT });
const one = async (sql) => (await q(sql))[0];
const raw = (sql) => db.sequelize.query(sql);

/** Re-run the seed with its log output suppressed, so the check output stays readable. */
async function reseed() {
  const logger = require('../src/config/logger');
  const levels = ['info', 'warn', 'error'];
  const saved = {};
  for (const level of levels) {
    saved[level] = logger[level];
    logger[level] = () => {};
  }
  try {
    await seed.run(db.sequelize);
  } finally {
    for (const level of levels) logger[level] = saved[level];
  }
}

/** The journal this suite writes its capture to — see scripts/lib/residue.js. */
const JOURNAL = 'verify-seed';
const SUPER_ADMIN_FIELDS = ['password_hash', 'must_change_password', 'status'];
const ADDON_FIELDS = ['units_per_quantity', 'is_active', 'display_order'];

/** The Super Admin's and `ai_credits`' fields as they are now, before any case touches them. */
async function captureUnrepairable() {
  const email = require('../src/config/env').superAdmin.email.toLowerCase();
  const superAdmin = await db.User.findOne({
    where: { email }, attributes: ['id', ...SUPER_ADMIN_FIELDS], raw: true, paranoid: false,
  });
  const aiCredits = await db.Addon.findOne({
    where: { key: 'ai_credits' }, attributes: ['id', ...ADDON_FIELDS], raw: true,
  });
  return { superAdmin, aiCredits };
}

async function restoreUnrepairable(captured) {
  if (captured.superAdmin) {
    const { id, ...fields } = captured.superAdmin;
    await db.User.update(fields, { where: { id }, paranoid: false, hooks: false });
  }
  if (captured.aiCredits) {
    const { id, ...fields } = captured.aiCredits;
    await db.Addon.update(fields, { where: { id } });
  }
}

/** A journal found at start is a capture from before a dead run touched either row. */
async function recoverFromDeadRun() {
  const pending = readJournal(JOURNAL);
  if (!pending) return;
  await restoreUnrepairable(pending);
  clearJournal(JOURNAL);
  console.log('(restored the Super Admin and ai_credits rows a killed earlier run left mutated)');
}

async function main() {
  const permissionId = async (key) =>
    (await one(`SELECT id FROM permissions WHERE \`key\` = '${key}'`)).id;
  const roleId = async (slug) => (await one(`SELECT id FROM roles WHERE slug = '${slug}'`)).id;
  const grantCount = async (id) =>
    (await one(`SELECT COUNT(*) n FROM role_permissions WHERE role_id = ${id}`)).n;

  /*
   * Start from the seeded definition, not from whatever the last run left. Every case below damages
   * the catalogue deliberately and repairs it before the next, and the final restore is inline — so a
   * run killed partway leaves the `parent` role deleted, or `teacher` short a grant, for the next one.
   * Case 5 then captures `librarianDefaults` from a librarian that is not at its defaults. See
   * `restoreSeededCatalogue()` in scripts/lib/residue.js, which the harness also runs before the loop.
   */
  await recoverFromDeadRun();
  await restoreSeededCatalogue(db);
  /*
   * Two more rows this suite damages that the seeder will never repair, because it is not supposed to:
   * case 6 sets the seeded Super Admin to `suspended` with a sentinel password hash — the seeder never
   * rewrites that account, by design — and case 7 deactivates `ai_credits`, whose operator-configurable
   * columns the seeder leaves alone. Both are restored inline, so a kill inside either case would leave
   * the real Super Admin locked out, or an add-on off sale. Captured here, before either case runs.
   */
  writeJournal(JOURNAL, await captureUnrepairable());

  /* 1. Role descriptive drift is repaired; identity is not touched. */
  const teacherBefore = await one("SELECT id, description FROM roles WHERE slug = 'teacher'");
  await raw("UPDATE roles SET description = 'wrong', is_school_role = 0 WHERE slug = 'teacher'");
  await reseed();
  const teacherAfter = await one(
    "SELECT id, description, is_school_role FROM roles WHERE slug = 'teacher'"
  );
  check(
    'role drift repaired',
    teacherAfter.description === teacherBefore.description && teacherAfter.is_school_role === 1,
    `is_school_role=${teacherAfter.is_school_role}`
  );
  check(
    'role id survives repair',
    teacherAfter.id === teacherBefore.id,
    `${teacherBefore.id} -> ${teacherAfter.id}`
  );

  /* 2. A grant an administrator revoked on a non-super_admin role is not re-granted. */
  const teacher = await roleId('teacher');
  const homeworkManage = await permissionId('homework.manage');
  await raw(
    `DELETE FROM role_permissions WHERE role_id = ${teacher} AND permission_id = ${homeworkManage}`
  );
  const revokedTo = await grantCount(teacher);
  await reseed();
  check(
    'revoked grant on teacher stays revoked',
    (await grantCount(teacher)) === revokedTo,
    `${revokedTo} grants, not re-granted`
  );

  /* 3. A grant an administrator added beyond the defaults is not removed. */
  const backupsManage = await permissionId('backups.manage');
  await db.RolePermission.create({ role_id: teacher, permission_id: backupsManage });
  await reseed();
  check(
    'extra grant on teacher preserved',
    (
      await one(
        `SELECT COUNT(*) n FROM role_permissions WHERE role_id = ${teacher} AND permission_id = ${backupsManage}`
      )
    ).n === 1
  );

  /* 4. super_admin is the exception: hard-synced to the full catalogue in both directions. */
  const superAdmin = await roleId('super_admin');
  const catalogue = (await one('SELECT COUNT(*) n FROM permissions')).n;
  await raw(
    `DELETE FROM role_permissions WHERE role_id = ${superAdmin} AND permission_id = ${homeworkManage}`
  );
  await reseed();
  check(
    'super_admin revoked grant restored',
    (await grantCount(superAdmin)) === catalogue,
    `holds ${await grantCount(superAdmin)}/${catalogue}`
  );

  /* 5. A role emptied entirely is re-bootstrapped from the defaults. */
  const librarian = await roleId('librarian');
  const librarianDefaults = await grantCount(librarian);
  await raw(`DELETE FROM role_permissions WHERE role_id = ${librarian}`);
  await reseed();
  check(
    'emptied role re-bootstrapped',
    (await grantCount(librarian)) === librarianDefaults,
    `librarian back to ${librarianDefaults}`
  );

  /*
   * 5b. A role still on an earlier version's defaults is upgraded; a customised one is not.
   *
   * The owner's decision D27 is the first change to a default role grant — Principal and School Admin
   * gain `plans.view`, `addons.view` and `payments.view`. A role with grants is otherwise left as the
   * Super Admin configured it, which would have kept every existing install on the old defaults
   * forever. `PREVIOUS_DEFAULTS` names the old set: a role holding exactly it was never customised.
   */
  const { DEFAULT_ROLE_PERMISSIONS } = require('../src/config/permissions');
  const principalRole = await roleId('principal');
  const d27Ids = await Promise.all(['plans.view', 'addons.view', 'payments.view'].map(permissionId));
  await raw(`DELETE FROM role_permissions WHERE role_id = ${principalRole} AND permission_id IN (${d27Ids.join(',')})`);
  await reseed();
  check(
    'a role on the pre-D27 defaults is brought up to the current ones (D27)',
    (await grantCount(principalRole)) === DEFAULT_ROLE_PERMISSIONS.principal.length,
    `principal holds ${await grantCount(principalRole)} of ${DEFAULT_ROLE_PERMISSIONS.principal.length}`
  );
  const logsView = await permissionId('logs.view');
  await raw(
    `DELETE FROM role_permissions WHERE role_id = ${principalRole} AND permission_id IN (${[...d27Ids, logsView].join(',')})`
  );
  const customisedTo = await grantCount(principalRole);
  await reseed();
  check(
    'while a leadership role the Super Admin customised is left exactly as configured',
    (await grantCount(principalRole)) === customisedTo,
    `${customisedTo} grants, not upgraded`
  );
  /* Back to the defaults: an emptied role is re-bootstrapped (case 5). */
  await raw(`DELETE FROM role_permissions WHERE role_id = ${principalRole}`);
  await reseed();

  /* 6. The Super Admin account is created once and never rewritten. */
  const email = require('../src/config/env').superAdmin.email.toLowerCase();
  const original = await one(
    `SELECT password_hash h, must_change_password m, status s FROM users WHERE email = '${email}'`
  );
  const sentinel = '$2a$12$CHANGEDBYUSERCHANGEDBYUSERCHANGEDBYUSERCHANGEDBYUSERxxx';
  await raw(
    `UPDATE users SET password_hash = '${sentinel}', must_change_password = 0, ` +
      `status = 'suspended' WHERE email = '${email}'`
  );
  await reseed();
  const mutated = await one(
    `SELECT password_hash h, must_change_password m, status s FROM users WHERE email = '${email}'`
  );
  check('super admin password not reset', mutated.h === sentinel);
  check(
    'super admin suspension not undone',
    mutated.s === 'suspended' && mutated.m === 0,
    `status=${mutated.s} mustChange=${mutated.m}`
  );
  check('no duplicate super admin created', (await one('SELECT COUNT(*) n FROM users')).n === 1);
  await raw(
    `UPDATE users SET password_hash = '${original.h}', must_change_password = ${original.m}, ` +
      `status = '${original.s}' WHERE email = '${email}'`
  );

  /* 7. Add-ons: SRS-fixed fields repaired, operator-configurable fields left alone. */
  await raw(
    "UPDATE addons SET units_per_quantity = 100, is_active = 0, display_order = 99, " +
      "name = 'Renamed', effect_target = 'student_limit' WHERE `key` = 'ai_credits'"
  );
  await reseed();
  const addon = await one(
    'SELECT name, effect_target, units_per_quantity upq, is_active, display_order o ' +
      "FROM addons WHERE `key` = 'ai_credits'"
  );
  check('addon SRS name repaired', addon.name === 'AI Credits', addon.name);
  check('addon SRS effect_target repaired', addon.effect_target === 'ai_limit', addon.effect_target);
  check(
    'addon operator config preserved',
    addon.upq === 100 && addon.is_active === 0 && addon.o === 99,
    `upq=${addon.upq} active=${addon.is_active} order=${addon.o}`
  );
  await raw(
    'UPDATE addons SET units_per_quantity = 1, is_active = 1, display_order = 4 ' +
      "WHERE `key` = 'ai_credits'"
  );

  /* 8. A permission removed from the catalogue is dropped, and its grants cascade. */
  await db.Permission.create({
    key: 'zz.orphan.test',
    name: 'Orphan',
    group: 'Test',
    module: null,
  });
  const orphan = await permissionId('zz.orphan.test');
  await db.RolePermission.create({ role_id: teacher, permission_id: orphan });
  const teacherWithOrphan = await grantCount(teacher);
  await reseed();
  check(
    'stale permission removed',
    (await one("SELECT COUNT(*) n FROM permissions WHERE `key` = 'zz.orphan.test'")).n === 0
  );
  check(
    'stale permission grants cascaded',
    (await grantCount(teacher)) === teacherWithOrphan - 1,
    `${teacherWithOrphan} -> ${await grantCount(teacher)}`
  );

  /* 9. A failing seeder rolls the whole seed back rather than leaving it half-applied. */
  const rolesBefore = (await one('SELECT COUNT(*) n FROM roles')).n;
  await raw("DELETE FROM roles WHERE slug = 'parent'");
  const addonModel = db.Addon;
  const realFindOrCreate = addonModel.findOrCreate;
  addonModel.findOrCreate = async () => {
    throw new Error('simulated failure in the addons seeder');
  };
  let threw = false;
  try {
    await reseed();
  } catch {
    threw = true;
  } finally {
    addonModel.findOrCreate = realFindOrCreate;
  }
  check('failing seeder propagates the error', threw);
  check(
    'failed seed rolled back — deleted role not re-created',
    (await one('SELECT COUNT(*) n FROM roles')).n === rolesBefore - 1,
    `roles = ${(await one('SELECT COUNT(*) n FROM roles')).n}, expected ${rolesBefore - 1}`
  );
  await reseed();
  check(
    'clean re-run restores the deleted role',
    (await one('SELECT COUNT(*) n FROM roles')).n === rolesBefore
  );

  /* Restore the defaults the earlier cases deliberately diverged from. */
  await raw(`DELETE FROM role_permissions WHERE role_id = ${teacher}`);
  await reseed();

  /* 10. Final state matches the source vocabularies. */
  check('11 roles', (await one('SELECT COUNT(*) n FROM roles')).n === 11);
  check('109 permissions', (await one('SELECT COUNT(*) n FROM permissions')).n === 109);
  check('7 add-ons', (await one('SELECT COUNT(*) n FROM addons')).n === 7);
  /*
   * Owner decisions D16 and D25: a new install seeds Custom Domain and SMS Credits switched off, and
   * only those two — neither has anything in this application to consume it. Read from the definitions
   * the seeder inserts rather than from the table, because `is_active` is the operator's once a row
   * exists (case 7) — this database's rows predate both decisions.
   */
  const { ADDON_DEFINITIONS } = require('../src/database/seeders/05-addons');
  const seededInactive = ADDON_DEFINITIONS.filter((d) => !d.is_active).map((d) => d.key).sort();
  check(
    'a new install seeds exactly custom_domain and sms_credits switched off (D16, D25)',
    JSON.stringify(seededInactive) === JSON.stringify(['custom_domain', 'sms_credits']),
    `inactive = ${JSON.stringify(seededInactive)}`
  );
  /* 359 since D27 gave Principal and School Admin three billing reads each (353 + 6). */
  check('359 default grants', (await one('SELECT COUNT(*) n FROM role_permissions')).n === 359);
  check('1 user', (await one('SELECT COUNT(*) n FROM users')).n === 1);

  /* Every case restored what it damaged, so the journal is no longer owed. */
  clearJournal(JOURNAL);

  console.log(`\nPASS (${pass.length})`);
  pass.forEach((p) => console.log(`  + ${p}`));
  if (fail.length) {
    console.log(`\nFAIL (${fail.length})`);
    fail.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('');
}

main()
  .then(async () => {
    await db.sequelize.close();
    process.exit(fail.length ? 1 : 0);
  })
  .catch(async (err) => {
    console.error(err);
    /* A throw mid-run skips the inline restores; do not leave the catalogue or those rows behind it. */
    const pending = readJournal(JOURNAL);
    if (pending) await restoreUnrepairable(pending).then(() => clearJournal(JOURNAL)).catch(() => {});
    await restoreSeededCatalogue(db).catch(() => {});
    await db.sequelize.close().catch(() => {});
    process.exit(1);
  });
