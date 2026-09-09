'use strict';

/**
 * School controllers — SRS §9.2. Thin: every rule is in `schools.service.js`.
 */

const service = require('./schools.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');
const { SCHOOL_STATUS } = require('../../config/constants');

/** GET / — one page of schools, scoped to the caller. */
async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req.tenant, req.query, pagination, req);
  return ApiResponse.paginated(res, result, pagination);
}

/** GET /:id — FR-SADMIN-004. */
async function show(req, res) {
  const school = await service.findById(req.tenant, req.params.id);
  return ApiResponse.ok(res, { school });
}

/** POST / — FR-SADMIN-002. */
async function create(req, res) {
  const school = await service.create(req, req.body);

  describeActivity(req, {
    entityId: school.id,
    description: `Created school ${school.name} (${school.code})`,
    metadata: { code: school.code, organizationId: school.organization_id, status: school.status },
  });

  return ApiResponse.created(res, { school }, { message: 'School created' });
}

/** PATCH /:id — FR-SADMIN-003. */
async function update(req, res) {
  const school = await service.update(req, req.params.id, req.body);

  describeActivity(req, {
    entityId: school.id,
    description: `Updated school ${school.name} (${school.code})`,
    metadata: { fields: Object.keys(req.body) },
  });

  return ApiResponse.ok(res, { school }, { message: 'School updated' });
}

/**
 * One handler for the three status transitions — FR-SADMIN-005 and the archive half of FR-SADMIN-006.
 *
 * Curried rather than repeated three times so the activity row, the message and the metadata cannot
 * drift apart between the endpoints. Each route names its own target status, which is what the
 * permission split (`schools.status` vs `schools.archive`) is enforced against.
 *
 * @param {string} status  one of `SCHOOL_STATUS`
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<any>}
 */
function transitionTo(status) {
  return async function transition(req, res) {
    const { school, previousStatus, verb } = await service.setStatus(
      req,
      req.params.id,
      status,
      req.body && req.body.reason
    );

    describeActivity(req, {
      entityId: school.id,
      description: `${verb} school ${school.name} (${school.code})`,
      metadata: {
        from: previousStatus,
        to: school.status,
        ...(req.body && req.body.reason ? { reason: req.body.reason } : {}),
      },
    });

    return ApiResponse.ok(res, { school }, { message: `School ${verb.toLowerCase()}` });
  };
}

/** DELETE /:id — FR-SADMIN-006's delete half. */
async function destroy(req, res) {
  const school = await service.remove(req, req.params.id);

  describeActivity(req, {
    entityId: school.id,
    description: `Deleted school ${school.name} (${school.code})`,
    metadata: { code: school.code },
  });

  /*
   * 200 with the deleted identity rather than 204: the caller needs something to confirm in a toast,
   * and a school's name is not recoverable from a body-less response once the row is gone.
   */
  return ApiResponse.ok(res, { school }, { message: 'School deleted' });
}

/** PUT /:id/principal — FR-SADMIN-007. */
async function assignPrincipal(req, res) {
  const { school, previous, principal } = await service.assignPrincipal(
    req,
    req.params.id,
    req.body.user_id
  );

  describeActivity(req, {
    entityId: school.id,
    description: previous
      ? `Changed Principal of ${school.name} from ${previous.name} to ${principal.name}`
      : `Assigned ${principal.name} as Principal of ${school.name}`,
    metadata: {
      principalId: principal.id,
      previousPrincipalId: previous ? previous.id : null,
    },
  });

  return ApiResponse.ok(
    res,
    { school, previousPrincipal: previous },
    { message: previous ? 'Principal changed' : 'Principal assigned' }
  );
}

/** GET /:id/usage — FR-SADMIN-008. */
async function usage(req, res) {
  const result = await service.usage(req.tenant, req.params.id);
  return ApiResponse.ok(res, result);
}

module.exports = {
  list,
  show,
  create,
  update,
  activate: transitionTo(SCHOOL_STATUS.ACTIVE),
  suspend: transitionTo(SCHOOL_STATUS.SUSPENDED),
  archive: transitionTo(SCHOOL_STATUS.ARCHIVED),
  destroy,
  assignPrincipal,
  usage,
  transitionTo,
};
