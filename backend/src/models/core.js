'use strict';

/**
 * Core tables — SRS §29 "Core":
 *   users · roles · permissions · role_permissions · organizations · schools ·
 *   school_settings · academic_sessions
 *
 * SRS §29 states no tables beyond those listed may be introduced. Refresh-token storage,
 * password reset, email verification and account status (all required by SRS §7) are
 * therefore columns on `users` rather than separate tables.
 */

const {
  DataTypes,
  id,
  fk,
  organizationId,
  schoolId,
  enumOf,
  json,
  modelOptions,
  softDeleteOptions,
} = require('./columns');

const {
  ROLE_LIST,
  USER_STATUS,
  SCHOOL_STATUS,
  ORGANIZATION_STATUS,
  ACADEMIC_SESSION_STATUS,
} = require('../config/constants');

module.exports = (sequelize) => {
  /* ─────────────────────────────── roles ─────────────────────────────── */

  const Role = sequelize.define(
    'Role',
    {
      id: id(),
      slug: {
        type: DataTypes.STRING(60),
        allowNull: false,
        unique: true,
        validate: { isIn: [ROLE_LIST] },
        comment: 'One of the eleven roles defined in SRS §5',
      },
      name: { type: DataTypes.STRING(120), allowNull: false },
      description: { type: DataTypes.STRING(255), allowNull: true },
      /** Platform roles operate above the school boundary (SRS §5 Super Admin). */
      is_platform_role: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      /** School-scoped roles must always carry a school_id on their user record. */
      is_school_role: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      is_system: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'System roles cannot be deleted; their permissions may still be edited',
      },
    },
    modelOptions('roles')
  );

  /* ─────────────────────────────── permissions ─────────────────────────────── */

  const Permission = sequelize.define(
    'Permission',
    {
      id: id(),
      key: {
        type: DataTypes.STRING(120),
        allowNull: false,
        unique: true,
        comment: '<module>.<action>, e.g. students.manage',
      },
      name: { type: DataTypes.STRING(160), allowNull: false },
      group: { type: DataTypes.STRING(60), allowNull: false },
      module: {
        type: DataTypes.STRING(40),
        allowNull: true,
        comment: 'Subscribable module (SRS §11.1) this permission belongs to, when any',
      },
      description: { type: DataTypes.STRING(255), allowNull: true },
    },
    modelOptions('permissions')
  );

  /* ─────────────────────────────── role_permissions ─────────────────────────────── */

  const RolePermission = sequelize.define(
    'RolePermission',
    {
      id: id(),
      role_id: fk({ references: { model: 'roles', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      permission_id: fk({
        references: { model: 'permissions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
    },
    modelOptions('role_permissions', {
      indexes: [
        { unique: true, fields: ['role_id', 'permission_id'], name: 'role_permissions_unique' },
        { fields: ['permission_id'] },
      ],
    })
  );

  /* ─────────────────────────────── organizations ─────────────────────────────── */

  const Organization = sequelize.define(
    'Organization',
    {
      id: id(),
      name: { type: DataTypes.STRING(180), allowNull: false },
      code: {
        type: DataTypes.STRING(40),
        allowNull: false,
        unique: true,
        comment: 'Short unique identifier used in references and reports',
      },
      email: { type: DataTypes.STRING(180), allowNull: true, validate: { isEmail: true } },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      address: { type: DataTypes.STRING(255), allowNull: true },
      website: { type: DataTypes.STRING(180), allowNull: true },
      logo_path: { type: DataTypes.STRING(255), allowNull: true },
      status: enumOf(ORGANIZATION_STATUS, { defaultValue: ORGANIZATION_STATUS.ACTIVE }),
      notes: { type: DataTypes.TEXT, allowNull: true },
    },
    softDeleteOptions('organizations', {
      indexes: [{ fields: ['status'] }, { fields: ['name'] }],
    })
  );

  /* ─────────────────────────────── schools ─────────────────────────────── */

  const School = sequelize.define(
    'School',
    {
      id: id(),
      organization_id: organizationId(),
      name: { type: DataTypes.STRING(180), allowNull: false },
      code: {
        type: DataTypes.STRING(40),
        allowNull: false,
        comment: 'Unique per organization; also used as the student-ID prefix',
      },
      email: { type: DataTypes.STRING(180), allowNull: true, validate: { isEmail: true } },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      address: { type: DataTypes.STRING(255), allowNull: true },
      city: { type: DataTypes.STRING(90), allowNull: true },
      state: { type: DataTypes.STRING(90), allowNull: true },
      country: { type: DataTypes.STRING(90), allowNull: true },
      /** SRS §9.2 — Assign Principal / Change Principal (FR-SADMIN-007). */
      principal_id: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      /** SRS §9.2 — Activate / Suspend / Delete-Archive School. */
      status: enumOf(SCHOOL_STATUS, { defaultValue: SCHOOL_STATUS.ACTIVE }),
      suspended_at: { type: DataTypes.DATE, allowNull: true },
      suspension_reason: { type: DataTypes.STRING(255), allowNull: true },
      archived_at: { type: DataTypes.DATE, allowNull: true },
      /** Cached from the school's active subscription so dashboards avoid a join. */
      subscription_state: { type: DataTypes.STRING(30), allowNull: true },
    },
    softDeleteOptions('schools', {
      indexes: [
        { unique: true, fields: ['organization_id', 'code'], name: 'schools_org_code_unique' },
        { fields: ['organization_id'] },
        { fields: ['status'] },
        { fields: ['principal_id'] },
      ],
    })
  );

  /* ─────────────────────────────── users ─────────────────────────────── */

  const User = sequelize.define(
    'User',
    {
      id: id(),
      /**
       * Tenancy. Null for Super Admin (platform scope). Organization Admin carries
       * organization_id only; school users carry both (SRS §4 hierarchy).
       */
      organization_id: organizationId({ allowNull: true, onDelete: 'CASCADE' }),
      school_id: schoolId({ allowNull: true, onDelete: 'CASCADE' }),
      role_id: fk({ references: { model: 'roles', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' }),

      name: { type: DataTypes.STRING(160), allowNull: false },
      email: { type: DataTypes.STRING(180), allowNull: false, validate: { isEmail: true } },
      username: { type: DataTypes.STRING(80), allowNull: false },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      password_hash: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'bcrypt hash — SRS §7 Password Hashing (FR-AUTH-004)',
      },
      avatar_path: { type: DataTypes.STRING(255), allowNull: true },

      /** SRS §7 "Account Status" (FR-AUTH-007). */
      status: enumOf(USER_STATUS, { defaultValue: USER_STATUS.ACTIVE }),

      /** SRS §7 "Email Verification" (FR-AUTH-006). */
      email_verified_at: { type: DataTypes.DATE, allowNull: true },
      email_verification_token_hash: { type: DataTypes.STRING(128), allowNull: true },
      email_verification_expires_at: { type: DataTypes.DATE, allowNull: true },

      /** SRS §7 "Password Reset" (FR-AUTH-005). */
      password_reset_token_hash: { type: DataTypes.STRING(128), allowNull: true },
      password_reset_expires_at: { type: DataTypes.DATE, allowNull: true },
      password_changed_at: { type: DataTypes.DATE, allowNull: true },

      /**
       * SRS §7 "Refresh Token" (FR-AUTH-003). Stored as a SHA-256 hash so a database
       * read cannot mint a session. Logout clears it (FR-AUTH-002).
       */
      refresh_token_hash: { type: DataTypes.STRING(128), allowNull: true },
      refresh_token_expires_at: { type: DataTypes.DATE, allowNull: true },

      last_login_at: { type: DataTypes.DATE, allowNull: true },
      last_login_ip: { type: DataTypes.STRING(60), allowNull: true },
      failed_login_attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      locked_until: { type: DataTypes.DATE, allowNull: true },

      /** Per-user permission overrides layered on top of the role grant. */
      extra_permissions: json({ comment: 'Array of permission keys granted in addition to the role' }),
      denied_permissions: json({ comment: 'Array of permission keys revoked from the role grant' }),

      locale: { type: DataTypes.STRING(10), allowNull: true },
      must_change_password: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    softDeleteOptions('users', {
      defaultScope: {
        attributes: {
          exclude: [
            'password_hash',
            'refresh_token_hash',
            'password_reset_token_hash',
            'email_verification_token_hash',
          ],
        },
      },
      scopes: {
        /** Explicitly opt in to secret columns — only the auth service does. */
        withSecrets: { attributes: { include: [] } },
      },
      indexes: [
        { unique: true, fields: ['email'], name: 'users_email_unique' },
        { unique: true, fields: ['username'], name: 'users_username_unique' },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['role_id'] },
        { fields: ['status'] },
      ],
    })
  );

  /** Never leak secret columns through JSON serialisation, even on an unscoped instance. */
  User.prototype.toJSON = function toJSON() {
    const values = { ...this.get() };
    delete values.password_hash;
    delete values.refresh_token_hash;
    delete values.password_reset_token_hash;
    delete values.email_verification_token_hash;
    return values;
  };

  /* ─────────────────────────────── school_settings ─────────────────────────────── */

  /** SRS §14.1 — Logo, Name, Address, Phone, Email, Website, Favicon, Theme, Currency, Timezone. */
  const SchoolSetting = sequelize.define(
    'SchoolSetting',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      logo_path: { type: DataTypes.STRING(255), allowNull: true },
      name: { type: DataTypes.STRING(180), allowNull: true, comment: 'Display name; may differ from schools.name' },
      address: { type: DataTypes.STRING(255), allowNull: true },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      email: { type: DataTypes.STRING(180), allowNull: true, validate: { isEmail: true } },
      website: { type: DataTypes.STRING(180), allowNull: true },
      favicon_path: { type: DataTypes.STRING(255), allowNull: true },
      theme: {
        type: DataTypes.STRING(40),
        allowNull: false,
        defaultValue: 'default',
        comment: 'SRS §14.1 Theme',
      },
      theme_config: json({ comment: 'Optional colour/branding detail for the selected theme' }),
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'UTC' },
      /** Operational preferences used by school modules. */
      preferences: json({
        comment: 'e.g. attendance alert threshold, fee fine rules, library loan period, grade scale id',
      }),
    },
    modelOptions('school_settings', {
      indexes: [
        { unique: true, fields: ['school_id'], name: 'school_settings_school_unique' },
        { fields: ['organization_id'] },
      ],
    })
  );

  /* ─────────────────────────────── academic_sessions ─────────────────────────────── */

  /** SRS §14.2 — Create Session / Activate Session / Close Session (FR-SCHOOL-002). */
  const AcademicSession = sequelize.define(
    'AcademicSession',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      name: { type: DataTypes.STRING(90), allowNull: false, comment: 'e.g. 2025-2026' },
      start_date: { type: DataTypes.DATEONLY, allowNull: false },
      end_date: { type: DataTypes.DATEONLY, allowNull: false },
      status: enumOf(ACADEMIC_SESSION_STATUS, { defaultValue: ACADEMIC_SESSION_STATUS.UPCOMING }),
      is_current: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Exactly one active session per school is flagged current',
      },
      activated_at: { type: DataTypes.DATE, allowNull: true },
      closed_at: { type: DataTypes.DATE, allowNull: true },
    },
    modelOptions('academic_sessions', {
      indexes: [
        { unique: true, fields: ['school_id', 'name'], name: 'academic_sessions_school_name_unique' },
        { fields: ['school_id', 'status'] },
        { fields: ['organization_id'] },
      ],
      validate: {
        endAfterStart() {
          if (this.start_date && this.end_date && this.end_date <= this.start_date) {
            throw new Error('Academic session end_date must be after start_date');
          }
        },
      },
    })
  );

  return { Role, Permission, RolePermission, Organization, School, User, SchoolSetting, AcademicSession };
};
