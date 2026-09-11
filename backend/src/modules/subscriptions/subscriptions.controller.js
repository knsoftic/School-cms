'use strict';

/**
 * Subscription controllers — SRS §12, §33; FR-SUB-010 … FR-SUB-015. Thin: every rule is in
 * `subscriptions.service.js`, and every accepted field in `subscriptions.validation.js`.
 *
 * The only judgement in this file is what goes in the response *message*. That matters more here
 * than in the catalogue modules, because several of these operations do something the operator did
 * not literally ask for and has no other way to find out about: a downgrade may be scheduled rather
 * than applied, an upgrade may consume a credit balance, and a resume moves the renewal date. Each
 * one says so.
 */

const service = require('./subscriptions.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');
const money = require('../../utils/money');

/**
 * A subscription plus its derived standing block.
 *
 * `toJSON()` is called explicitly for the reason `plans.controller.present()` gives: `standing` has
 * to sit beside the subscription's own columns, and a Sequelize instance does not accept added
 * properties. Each override also carries `is_effective`, so a screen listing them does not re-derive
 * the window `entitlementService` applies — the service's `isEffective()` is the single definition.
 *
 * @param {object} subscription  loaded with `detailInclude()`
 * @returns {object}
 */
function present(subscription) {
  const json = subscription.toJSON();

  if (Array.isArray(json.overrides)) {
    json.overrides = json.overrides.map((override) => ({
      ...override,
      is_effective: service.isEffective(override),
    }));
  }

  return { ...json, standing: service.standing(subscription) };
}

/** A short label for activity rows and messages: the plan name when loaded, else the id. */
function labelOf(subscription) {
  return subscription.plan && subscription.plan.name
    ? subscription.plan.name
    : `subscription #${subscription.id}`;
}

/* ─────────────────────────────── reads ─────────────────────────────── */

/** GET /catalogue — the §12 vocabulary and the transition table. */
async function catalogue(req, res) {
  return ApiResponse.ok(res, service.catalogue());
}

/** GET / — one page of subscriptions, confined to the caller's tenant. */
async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req.tenant, req.query, pagination, req);

  return ApiResponse.paginated(
    res,
    { count: result.count, rows: result.rows.map(present) },
    pagination
  );
}

/** GET /:id */
async function show(req, res) {
  const subscription = await service.findById(req.tenant, req.params.id);
  return ApiResponse.ok(res, { subscription: present(subscription) });
}

/**
 * GET /:id/history — FR-SUB-010's audit trail.
 *
 * The rows are returned as they are stored. `subscription_history` is the ledger, so presenting it
 * through a derived block would mean two versions of a figure an operator may be reconciling.
 */
async function historyList(req, res) {
  const pagination = getPagination(req);
  const result = await service.history(req.tenant, req.params.id, req.query, pagination, req);

  return ApiResponse.paginated(res, { count: result.count, rows: result.rows }, pagination);
}

/* ───────────────────── FR-SUB-010 — create ───────────────────── */

/** POST / — put a school on a plan. */
async function create(req, res) {
  const subscription = await service.create(req, req.body);

  describeActivity(req, {
    entityId: subscription.id,
    description: `Subscribed school ${subscription.school_id} to ${labelOf(subscription)}`,
    metadata: {
      schoolId: Number(subscription.school_id),
      planId: Number(subscription.plan_id),
      state: subscription.state,
      billingCycle: subscription.billing_cycle,
      cycleAmount: money.decimal(subscription.cycle_amount),
      currency: subscription.currency,
    },
  });

  return ApiResponse.created(
    res,
    { subscription: present(subscription) },
    {
      /*
       * Which state it landed in decides what the operator has to do next, so the message says it
       * rather than leaving them to read `state` out of the body.
       */
      message:
        subscription.state === 'trial'
          ? `Subscription created. The ${subscription.trial_days}-day trial has started.`
          : 'Subscription created in pending state. Activate it to start the billing period.',
    }
  );
}

/** PATCH /:id — FR-SUB-011 / FR-SUB-012. */
async function update(req, res) {
  const subscription = await service.update(req, req.params.id, req.body);

  describeActivity(req, {
    entityId: subscription.id,
    description: `Updated ${labelOf(subscription)} for school ${subscription.school_id}`,
    metadata: {
      schoolId: Number(subscription.school_id),
      fields: Object.keys(req.body).filter((key) => key !== 'reason'),
    },
  });

  return ApiResponse.ok(res, { subscription: present(subscription) }, {
    message: 'Subscription updated',
  });
}

/* ────────────── FR-SUB-010 — the six operator transitions ────────────── */

/**
 * One handler for all six administrative transitions.
 *
 * Curried on the same reasoning as `addons.controller.transitionTo()`, and with more force here: six
 * endpoints written out would be six chances for the activity row, the message and the metadata to
 * drift from the state the service actually wrote.
 *
 * @param {string} action  a key of `service.TRANSITIONS`
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<any>}
 */
function transitionTo(action) {
  return async function applyTransition(req, res) {
    const reason = req.body && req.body.reason;
    const { subscription, previousState, verb } = await service.transition(
      req,
      req.params.id,
      action,
      reason
    );

    describeActivity(req, {
      entityId: subscription.id,
      description: `${verb} ${labelOf(subscription)} for school ${subscription.school_id}`,
      metadata: {
        schoolId: Number(subscription.school_id),
        from: previousState,
        to: subscription.state,
        ...(reason ? { reason } : {}),
      },
    });

    /*
     * Three of the six do something to the dates that the operator did not ask for and cannot see
     * without comparing before and after. Those three say so; the rest state the fact.
     */
    const messages = {
      activate: 'Subscription activated. The billing period starts now.',
      suspend: 'Subscription suspended. The school loses access until it is reactivated.',
      reactivate: 'Subscription reactivated on a new billing period starting now.',
      pause: 'Subscription paused. The remaining period is preserved and resumes where it stopped.',
      resume: 'Subscription resumed. The renewal date has moved forward by the paused duration.',
      cancel: 'Subscription cancelled. The record is kept as billing history.',
    };

    return ApiResponse.ok(
      res,
      { subscription: present(subscription) },
      { message: messages[action] || `Subscription ${verb.toLowerCase()}` }
    );
  };
}

/* ──────── FR-SUB-013 / FR-SUB-014 — upgrade and downgrade (§12.3, §12.4) ──────── */

/**
 * One handler for both directions.
 *
 * The direction is checked against `subscription_plans.tier_rank` in the service, not taken from the
 * route — so this hands the route's own direction down and lets the service refuse a mismatch. The
 * two endpoints exist because the FRs are two requirements with different bodies (a downgrade must
 * choose a §12.4 timing), not because the operation differs.
 *
 * @param {'upgrade'|'downgrade'} direction
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<any>}
 */
function changePlanTo(direction) {
  return async function applyChange(req, res) {
    const { subscription, change } = await service.changePlan(
      req,
      req.params.id,
      req.body,
      direction
    );

    describeActivity(req, {
      entityId: subscription.id,
      description: change.applied
        ? `${direction === 'upgrade' ? 'Upgraded' : 'Downgraded'} school ${subscription.school_id} to ${change.toPlan.name}`
        : `Scheduled a downgrade of school ${subscription.school_id} to ${change.toPlan.name}`,
      metadata: {
        schoolId: Number(subscription.school_id),
        direction: change.direction,
        timing: change.timing,
        applied: change.applied,
        fromPlanId: change.fromPlan.id ? Number(change.fromPlan.id) : null,
        toPlanId: Number(change.toPlan.id),
        newCycleAmount: change.newCycleAmount,
        ...(change.proration
          ? {
              prorationDue: change.proration.prorationDue,
              creditApplied: change.proration.creditApplied,
              amountDue: change.proration.amountDue,
            }
          : {}),
        ...(req.body.reason ? { reason: req.body.reason } : {}),
      },
    });

    /*
     * The §12.3 figures go in the message, not just the body. An operator who upgrades a school
     * mid-period needs to know what is actually owed now — that is the whole substance of
     * FR-SUB-013's "calculates proration" and "applies remaining credit", and a number buried in a
     * nested object is a number nobody reads.
     */
    let message;
    if (!change.applied) {
      message = `Downgrade to ${change.toPlan.name} scheduled for the end of the current billing cycle (SRS §12.4). The school keeps its current plan until then.`;
    } else if (change.proration && change.proration.creditApplied > 0) {
      message =
        `${direction === 'upgrade' ? 'Upgraded' : 'Downgraded'} to ${change.toPlan.name}. ` +
        `${money.format(change.proration.prorationDue, change.currency)} prorated for the remaining ` +
        `${change.proration.remainingDays} day(s), ${money.format(change.proration.creditApplied, change.currency)} ` +
        `credit applied, ${money.format(change.proration.amountDue, change.currency)} due.`;
    } else {
      message = `${direction === 'upgrade' ? 'Upgraded' : 'Downgraded'} to ${change.toPlan.name}.`;
    }

    return ApiResponse.ok(res, { subscription: present(subscription), change }, { message });
  };
}

/* ────────────────── FR-SUB-015 — manual renewal (§12.5) ────────────────── */

/**
 * POST /:id/renew — §12.5's Manual Renewal, *"initiated by an authorized user"*.
 *
 * The same service function the sweep calls for Automatic Renewal, with a request attached. `mode` is
 * passed explicitly rather than read off `renewal_mode`, because a manual renewal of a subscription
 * configured for automatic renewal is still a manual renewal and the history row should say so.
 */
async function renew(req, res) {
  const { subscription, renewal } = await service.renew(req, req.params.id, {
    reason: req.body && req.body.reason,
    mode: 'manual',
  });

  describeActivity(req, {
    entityId: subscription.id,
    description: `Renewed ${labelOf(subscription)} for school ${subscription.school_id}`,
    metadata: {
      schoolId: Number(subscription.school_id),
      mode: 'manual',
      from: renewal.previousState,
      renewalCount: renewal.renewalCount,
      periodEnd: renewal.periodEnd ? renewal.periodEnd.toISOString() : null,
      appliedScheduledChange: renewal.appliedScheduledChange,
      ...(req.body && req.body.reason ? { reason: req.body.reason } : {}),
    },
  });

  return ApiResponse.ok(
    res,
    { subscription: present(subscription), renewal },
    {
      message: renewal.appliedScheduledChange
        ? `Subscription renewed and the scheduled downgrade to ${renewal.toPlan.name} has been applied.`
        : 'Subscription renewed for the next billing cycle.',
    }
  );
}

/* ──────────── §11.3 / FR-SUB-009 — add-ons on a subscription ──────────── */

/** POST /:id/addons — purchase an add-on onto this subscription. */
async function purchaseAddon(req, res) {
  const { subscription, purchase, invoice } = await service.purchaseAddon(req, req.params.id, req.body);

  describeActivity(req, {
    entityId: subscription.id,
    description: `Purchased ${purchase.addon.name} × ${purchase.quantity} for school ${subscription.school_id}`,
    metadata: {
      schoolId: Number(subscription.school_id),
      subscriptionAddonId: purchase.id,
      addonKey: purchase.addon.key,
      quantity: purchase.quantity,
      /* The copied effect, in the activity row: this is the value entitlement will read. */
      effectType: purchase.effectType,
      effectTarget: purchase.effectTarget,
      unitsGranted: purchase.unitsGranted,
      ...(req.body.reason ? { reason: req.body.reason } : {}),
    },
  });

  return ApiResponse.created(
    res,
    /* `invoice` — D24's charge at purchase when the period was already billed, else null. */
    { subscription: present(subscription), purchase, invoice },
    {
      /*
       * What the add-on actually granted, in words. A `limit_increase` bought with the wrong
       * quantity is otherwise invisible until someone hits the limit it was supposed to raise.
       */
      message:
        purchase.unitsGranted > 0
          ? `${purchase.addon.name} purchased. ${purchase.unitsGranted} added to ${purchase.effectTarget}.`
          : `${purchase.addon.name} purchased. ${purchase.effectTarget} unlocked.`,
    }
  );
}

/** POST /:id/addons/:addonId/cancel — withdraw a purchased add-on. */
async function cancelAddon(req, res) {
  const { subscription, purchase } = await service.cancelAddon(
    req,
    req.params.id,
    req.params.addonId,
    req.body && req.body.reason
  );

  describeActivity(req, {
    entityId: subscription.id,
    description: `Cancelled add-on purchase #${purchase.id} for school ${subscription.school_id}`,
    metadata: {
      schoolId: Number(subscription.school_id),
      subscriptionAddonId: purchase.id,
      addonKey: purchase.addon ? purchase.addon.key : null,
      unitsWithdrawn: purchase.unitsWithdrawn,
      ...(req.body && req.body.reason ? { reason: req.body.reason } : {}),
    },
  });

  return ApiResponse.ok(
    res,
    { subscription: present(subscription), purchase },
    {
      message: purchase.unitsWithdrawn
        ? `Add-on cancelled. ${purchase.unitsWithdrawn} unit(s) withdrawn from this subscription's allowance.`
        : 'Add-on cancelled.',
    }
  );
}

/* ────────── §33 — Feature Overrides, Custom Limits, Custom Pricing ────────── */

/** POST /:id/overrides — apply or replace a per-subscription override. */
async function createOverride(req, res) {
  const { subscription, override, created } = await service.createOverride(
    req,
    req.params.id,
    req.body
  );

  describeActivity(req, {
    entityId: subscription.id,
    description: `${created ? 'Applied' : 'Replaced'} ${override.override_type} override "${override.target_key}" for school ${subscription.school_id}`,
    metadata: {
      schoolId: Number(subscription.school_id),
      overrideId: override.id,
      overrideType: override.override_type,
      targetKey: override.target_key,
      isEnabled: override.is_enabled,
      limitType: override.limit_type,
      limitValue: override.limit_value === null ? null : Number(override.limit_value),
      replaced: !created,
      ...(req.body.reason ? { reason: req.body.reason } : {}),
    },
  });

  const body = {
    subscription: present(subscription),
    override: { ...override.toJSON(), is_effective: service.isEffective(override) },
  };

  /*
   * 200 on a replacement, 201 on a new row. The unique index over
   * `[subscription_id, override_type, target_key]` makes re-applying an override an update, and an
   * operator raising a negotiated ceiling twice should be able to tell which of the two happened.
   */
  return created
    ? ApiResponse.created(res, body, { message: 'Override applied' })
    : ApiResponse.ok(res, body, {
        message: 'Override replaced. The previous value for this target is no longer in force.',
      });
}

/** POST /:id/overrides/:overrideId/revoke */
async function revokeOverride(req, res) {
  const { subscription, override } = await service.revokeOverride(
    req,
    req.params.id,
    req.params.overrideId,
    req.body && req.body.reason
  );

  describeActivity(req, {
    entityId: subscription.id,
    description: `Revoked ${override.override_type} override "${override.target_key}" for school ${subscription.school_id}`,
    metadata: {
      schoolId: Number(subscription.school_id),
      overrideId: override.id,
      overrideType: override.override_type,
      targetKey: override.target_key,
      ...(req.body && req.body.reason ? { reason: req.body.reason } : {}),
    },
  });

  return ApiResponse.ok(
    res,
    {
      subscription: present(subscription),
      override: { ...override.toJSON(), is_effective: service.isEffective(override) },
    },
    { message: "Override revoked. The plan's own value applies from now on." }
  );
}

module.exports = {
  /* reads */
  catalogue,
  list,
  show,
  history: historyList,

  /* FR-SUB-010 … FR-SUB-012 */
  create,
  update,

  /* FR-SUB-010 — the six administrative transitions */
  activate: transitionTo('activate'),
  suspend: transitionTo('suspend'),
  reactivate: transitionTo('reactivate'),
  pause: transitionTo('pause'),
  resume: transitionTo('resume'),
  cancel: transitionTo('cancel'),

  /* FR-SUB-013 / FR-SUB-014 / FR-SUB-015 */
  upgrade: changePlanTo('upgrade'),
  downgrade: changePlanTo('downgrade'),
  renew,

  /* §11.3 add-ons and §33 overrides */
  purchaseAddon,
  cancelAddon,
  createOverride,
  revokeOverride,

  present,
  transitionTo,
  changePlanTo,
};
