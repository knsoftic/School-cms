'use strict';

/**
 * Roles — SRS §5, "The system defines exactly the following eleven roles."
 *
 * Descriptions are condensed from the SRS §5 responsibilities table rather than invented.
 * Every role is flagged `is_system` so the role-management UI can refuse to delete them:
 * the eleven are fixed by the source and `users.role_id` is RESTRICT-constrained.
 */

const { ROLES } = require('../../config/constants');
const logger = require('../../config/logger');

/**
 * `is_platform_role` — operates above the school boundary, so `resolveTenant` does not
 * pin the user to one school.
 * `is_school_role`   — always scoped to exactly one school.
 */
const ROLE_DEFINITIONS = [
  {
    slug: ROLES.SUPER_ADMIN,
    name: 'Super Admin',
    description:
      'Platform-level owner. Manages organizations, schools, principal creation, subscription ' +
      'plans, billing, coupons, the platform-wide dashboard and reports, and global settings.',
    is_platform_role: true,
    is_school_role: false,
  },
  {
    slug: ROLES.ORGANIZATION_ADMIN,
    name: 'Organization Admin',
    description:
      'Administers an organization that may contain one or more schools/campuses, per the ' +
      'hierarchy Super Admin → Organizations → Schools/Campuses.',
    is_platform_role: true,
    is_school_role: false,
  },
  {
    slug: ROLES.PRINCIPAL,
    name: 'Principal',
    description:
      'School-level leadership role. Principals are assigned to schools by the Super Admin and ' +
      'have access to the Principal Dashboard.',
    is_platform_role: false,
    is_school_role: true,
  },
  {
    slug: ROLES.SCHOOL_ADMIN,
    name: 'School Admin',
    description: 'School-level administrative role, grouped with Principals/Admins in the hierarchy.',
    is_platform_role: false,
    is_school_role: true,
  },
  {
    slug: ROLES.TEACHER,
    name: 'Teacher',
    description:
      'Manages assigned subjects and classes; takes attendance; enters, edits and submits marks; ' +
      'creates homework and assignments; manages teaching periods; participates in the AI ' +
      'question-generation workflow (upload, preview, approve).',
    is_platform_role: false,
    is_school_role: true,
  },
  {
    slug: ROLES.ACCOUNTANT,
    name: 'Accountant',
    description: 'Staff role associated with Finance and Fee-related school operations.',
    is_platform_role: false,
    is_school_role: true,
  },
  {
    slug: ROLES.RECEPTIONIST,
    name: 'Receptionist',
    description: 'Staff role identified under Staff Management.',
    is_platform_role: false,
    is_school_role: true,
  },
  {
    slug: ROLES.LIBRARIAN,
    name: 'Librarian',
    description: 'Staff role associated with the Library module.',
    is_platform_role: false,
    is_school_role: true,
  },
  {
    slug: ROLES.STAFF,
    name: 'Staff',
    description:
      'General staff role/category encompassing Receptionist, Accountant, Librarian and Other Staff.',
    is_platform_role: false,
    is_school_role: true,
  },
  {
    slug: ROLES.STUDENT,
    name: 'Student',
    description:
      'Subject of admission, class/section assignment, attendance, fee, examination, result, ' +
      'timetable, homework, assignment and library records; access is limited to their own ' +
      'records within their school.',
    is_platform_role: false,
    is_school_role: true,
  },
  {
    slug: ROLES.PARENT,
    name: 'Parent',
    description:
      'Holds a Parent Account, may be linked to multiple children, and has access to the ' +
      'Parent Dashboard.',
    is_platform_role: false,
    is_school_role: true,
  },
];

module.exports = {
  name: 'roles',

  async up(db, transaction) {
    let created = 0;
    let updated = 0;

    for (const definition of ROLE_DEFINITIONS) {
      const [role, wasCreated] = await db.Role.findOrCreate({
        where: { slug: definition.slug },
        defaults: { ...definition, is_system: true },
        transaction,
      });

      if (wasCreated) {
        created += 1;
        continue;
      }

      /*
       * Re-running the seeder repairs drift in the descriptive fields but never touches a
       * role's identity, so existing users keep their role_id.
       */
      const changes = {};
      for (const key of ['name', 'description', 'is_platform_role', 'is_school_role']) {
        if (role[key] !== definition[key]) changes[key] = definition[key];
      }
      if (!role.is_system) changes.is_system = true;
      if (Object.keys(changes).length) {
        await role.update(changes, { transaction });
        updated += 1;
      }
    }

    const total = await db.Role.count({ transaction });
    if (total !== ROLE_DEFINITIONS.length) {
      logger.warn(
        `roles table holds ${total} rows but SRS §5 defines exactly ${ROLE_DEFINITIONS.length}.`
      );
    }

    return { created, updated, total };
  },

  async down(db, transaction) {
    /* Role rows are RESTRICT-referenced by users, so any remaining user blocks this. */
    const removed = await db.Role.destroy({
      where: { slug: ROLE_DEFINITIONS.map((r) => r.slug) },
      transaction,
    });
    return { removed };
  },

  ROLE_DEFINITIONS,
};
