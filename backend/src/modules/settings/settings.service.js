'use strict';

/**
 * School settings — SRS §14.1, FR-SCHOOL-001.
 *
 * One row per school (`school_settings_school_unique`). **GET does not insert** — it reads the row if
 * one exists and otherwise returns `virtualDefaults()`, so a Principal opening the settings screen is
 * not staring at a 404 and no row is written by a read. **PATCH is the upsert.**
 *
 * This paragraph said "GET find-or-creates" until the §36 pass, contradicting the note at :34-37 of
 * this same file — which spells out why a read must not insert: the row would carry no audit trail
 * and would have passed no `school.settings.manage` check. The ten §14.1 fields are the editable set; `schools.name` is the platform
 * record and is not overwritten here — `school_settings.name` is the display name the column
 * comment already describes.
 */

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const { resolveSchool } = require('../../utils/schoolScope');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');

const EDITABLE = Object.freeze([
  'name',
  'address',
  'phone',
  'email',
  'website',
  'logo_path',
  'favicon_path',
  'theme',
  'theme_config',
  'currency',
  'timezone',
  'preferences',
]);

/**
 * Virtual defaults when no `school_settings` row exists yet.
 *
 * GET does not insert: a settings screen opening is not a write, and inserting here would create a
 * row with no audit trail and no `school.settings.manage` check. PATCH is the upsert.
 */
function virtualDefaults(school) {
  return {
    id: null,
    school_id: school.id,
    organization_id: school.organization_id,
    logo_path: null,
    name: school.name,
    address: null,
    phone: null,
    email: null,
    website: null,
    favicon_path: null,
    theme: 'default',
    theme_config: null,
    currency: 'USD',
    timezone: 'UTC',
    preferences: null,
    created_at: null,
    updated_at: null,
  };
}

function pickEditable(payload) {
  const next = {};
  for (const key of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) next[key] = payload[key];
  }
  return next;
}

async function show(req) {
  const school = await resolveSchool(req, req.query.school_id);
  const row = await db.SchoolSetting.findOne({ where: { school_id: school.id } });
  return row || virtualDefaults(school);
}

async function update(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  const next = pickEditable(payload);

  if (!Object.keys(next).length) {
    throw ApiError.validation('No settings fields to update', [
      { field: 'body', message: 'Send at least one of the §14.1 fields' },
    ]);
  }

  let row = await db.SchoolSetting.findOne({ where: { school_id: school.id } });

  if (!row) {
    row = await db.SchoolSetting.create({
      school_id: school.id,
      organization_id: school.organization_id,
      name: school.name,
      ...next,
    });
    await recordAudit(req, {
      tableName: 'school_settings',
      recordId: row.id,
      event: 'create',
      before: null,
      after: snapshot(row),
      reason: payload.reason || null,
    });
    return row;
  }

  const before = snapshot(row);
  row.set(next);
  await row.save();

  await recordAudit(req, {
    tableName: 'school_settings',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  return row;
}

module.exports = { show, update, EDITABLE, virtualDefaults };
