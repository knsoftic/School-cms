'use strict';

/**
 * Bootstrap Super Admin — SRS §5 names Super Admin as the platform-level owner and SRS §6
 * makes it the root of the hierarchy, so the platform is unusable until one exists. Every
 * other account in the system is created *through* the application by someone already logged
 * in (Super Admin creates organizations, schools and principals; a school creates its own
 * staff), which makes this the single account that has to come from a seeder.
 *
 * Credentials come from `SUPER_ADMIN_*` in the environment. The account is created once and
 * never modified afterwards — re-running the seeder must not reset a password that has since
 * been changed, nor re-enable an account that was deliberately suspended.
 */

const config = require('../../config/env');
const logger = require('../../config/logger');
const { ROLES, USER_STATUS } = require('../../config/constants');
const { hashPassword } = require('../../utils/tokens');

/** The value shipped in `.env.example`; must not survive into a real deployment. */
const INSECURE_DEFAULT_PASSWORD = 'SuperAdmin@123';

module.exports = {
  name: 'super-admin',

  async up(db, transaction) {
    const role = await db.Role.findOne({ where: { slug: ROLES.SUPER_ADMIN }, transaction });
    if (!role) {
      throw new Error('The super_admin role is missing — run the roles seeder first.');
    }

    const { name, email, username, password } = config.superAdmin;
    const normalisedEmail = String(email).trim().toLowerCase();
    const normalisedUsername = String(username).trim().toLowerCase();

    /*
     * Match on either identifier: both are unique, so a partial match would otherwise fail
     * the insert with a constraint error instead of being recognised as "already seeded".
     */
    const existing = await db.User.scope('withSecrets').findOne({
      where: { [db.Op.or]: [{ email: normalisedEmail }, { username: normalisedUsername }] },
      paranoid: false,
      transaction,
    });

    if (existing) {
      if (existing.role_id !== role.id) {
        logger.warn(
          `User "${existing.email}" already exists with a different role; leaving it untouched. ` +
            'Set SUPER_ADMIN_EMAIL / SUPER_ADMIN_USERNAME to unused values if a new ' +
            'Super Admin account is needed.'
        );
        return { created: false, reason: 'identifier taken by another role' };
      }
      if (existing.deletedAt || existing.deleted_at) {
        logger.warn(
          `The Super Admin account "${existing.email}" is archived. Restore it from the ` +
            'database rather than seeding a duplicate.'
        );
      }
      return { created: false, reason: 'already present', id: existing.id };
    }

    if (password === INSECURE_DEFAULT_PASSWORD) {
      if (config.isProduction) {
        throw new Error(
          'SUPER_ADMIN_PASSWORD is still the example value. Set a real password before ' +
            'seeding a production database.'
        );
      }
      logger.warn(
        'Seeding the Super Admin with the example password from .env.example. Fine for local ' +
          'development; set SUPER_ADMIN_PASSWORD before deploying.'
      );
    }

    const user = await db.User.create(
      {
        /* Platform-level: deliberately not bound to an organization or a school (SRS §2.4). */
        organization_id: null,
        school_id: null,
        role_id: role.id,
        name,
        email: normalisedEmail,
        username: normalisedUsername,
        password_hash: await hashPassword(password),
        status: USER_STATUS.ACTIVE,
        /* Seeded from an env file that operators and CI both see — force a rotation on login. */
        must_change_password: true,
        email_verified_at: new Date(),
        password_changed_at: new Date(),
      },
      { transaction }
    );

    logger.info(`Created Super Admin "${user.email}" (must change password on first login).`);
    return { created: true, id: user.id, email: user.email };
  },

  async down(db, transaction) {
    const email = String(config.superAdmin.email).trim().toLowerCase();
    const removed = await db.User.destroy({ where: { email }, force: true, transaction });
    return { removed };
  },

  INSECURE_DEFAULT_PASSWORD,
};
