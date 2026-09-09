'use strict';

/**
 * Add-ons — SRS §11.3 and FR-SUB-009, "Add-ons available: Extra Students, Extra Teachers,
 * Extra Storage, AI Credits, SMS Credits, Custom Domain, Premium Reports."
 *
 * These seven are the full set the source defines, so they are seeded as system data and
 * ordered as the document lists them. What each one *does* is not invented either: the
 * mapping from add-on to the limit it raises or the feature it unlocks lives in
 * `ADDON_EFFECTS`, and the entitlement resolver reads `addons.effect_type` /
 * `effect_target` from this table rather than branching on the key (SRS §30 Rule 1).
 *
 * `units_per_quantity` is seeded at 1 — one purchased quantity grants one unit of the target
 * limit. The source names no block sizes (no "Extra Storage = 1 GB", no "AI Credits = 100
 * requests"), and FR-SUB-009 makes add-ons Super-Admin-configurable, so the block size is a
 * business decision made in the add-ons screen, not a default this seeder should guess at.
 */

const { ADDON_LIST, ADDON_EFFECTS, LIMIT_UNITS, LIMIT_LABELS } = require('../../config/constants');
const logger = require('../../config/logger');

/** Names exactly as SRS §11.3 lists them. */
const ADDON_NAMES = Object.freeze({
  extra_students: 'Extra Students',
  extra_teachers: 'Extra Teachers',
  extra_storage: 'Extra Storage',
  ai_credits: 'AI Credits',
  sms_credits: 'SMS Credits',
  custom_domain: 'Custom Domain',
  premium_reports: 'Premium Reports',
});

/** Describe the add-on from its own effect, so the text cannot drift from the behaviour. */
function describe(key) {
  const effect = ADDON_EFFECTS[key];
  if (effect.type === 'limit_increase') {
    const label = LIMIT_LABELS[effect.target] || effect.target;
    const unit = LIMIT_UNITS[effect.target];
    return unit
      ? `Raises the ${label} by the purchased quantity, measured in ${unit}.`
      : `Raises the ${label} by the purchased quantity.`;
  }
  return `Unlocks the "${effect.target}" feature for the subscription.`;
}

const ADDON_DEFINITIONS = ADDON_LIST.map((key, index) => {
  const effect = ADDON_EFFECTS[key];
  return {
    key,
    name: ADDON_NAMES[key],
    description: describe(key),
    effect_type: effect.type,
    effect_target: effect.target,
    units_per_quantity: 1,
    unit: effect.type === 'limit_increase' ? LIMIT_UNITS[effect.target] || 'count' : null,
    is_active: true,
    display_order: index + 1,
  };
});

/* Guard against a key being added to ADDON_LIST without a matching SRS §11.3 name. */
for (const definition of ADDON_DEFINITIONS) {
  if (!definition.name) throw new Error(`Add-on "${definition.key}" has no SRS §11.3 name.`);
}

module.exports = {
  name: 'addons',

  async up(db, transaction) {
    let created = 0;
    let updated = 0;

    for (const definition of ADDON_DEFINITIONS) {
      const [addon, wasCreated] = await db.Addon.findOrCreate({
        where: { key: definition.key },
        defaults: definition,
        transaction,
      });

      if (wasCreated) {
        created += 1;
        continue;
      }

      /*
       * Repair only the fields the SRS fixes. `units_per_quantity`, `unit`, `is_active` and
       * `display_order` are left alone: those are the Super Admin's to configure through
       * FR-SUB-009, and overwriting them would undo a deliberate change.
       */
      const changes = {};
      for (const field of ['name', 'effect_type', 'effect_target']) {
        if (addon[field] !== definition[field]) changes[field] = definition[field];
      }
      if (!addon.description) changes.description = definition.description;
      if (Object.keys(changes).length) {
        await addon.update(changes, { transaction });
        updated += 1;
      }
    }

    const total = await db.Addon.count({ transaction });
    if (total !== ADDON_DEFINITIONS.length) {
      logger.info(
        `addons table holds ${total} rows; SRS §11.3 defines ${ADDON_DEFINITIONS.length} ` +
          '(extra rows are Super-Admin-created add-ons and are left in place).'
      );
    }

    return { created, updated, total };
  },

  async down(db, transaction) {
    const removed = await db.Addon.destroy({ where: { key: ADDON_LIST }, transaction });
    return { removed };
  },

  ADDON_DEFINITIONS,
};
