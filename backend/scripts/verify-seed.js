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

async function main() {
  const permissionId = async (key) =>
    (await one(`SELECT id FROM permissions WHERE \`key\` = '${key}'`)).id;
  const roleId = async (slug) => (await one(`SELECT id FROM roles WHERE slug = '${slug}'`)).id;
  const grantCount = async (id) =>
    (await one(`SELECT COUNT(*) n FROM role_permissions WHERE role_id = ${id}`)).n;

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
  check('353 default grants', (await one('SELECT COUNT(*) n FROM role_permissions')).n === 353);
  check('1 user', (await one('SELECT COUNT(*) n FROM users')).n === 1);

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
    await db.sequelize.close().catch(() => {});
    process.exit(1);
  });
