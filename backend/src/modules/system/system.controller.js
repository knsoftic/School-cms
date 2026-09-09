'use strict';

/**
 * System endpoints — liveness, readiness, and the public API descriptor.
 *
 * These are the only routes mounted ahead of `authenticate`, and each has a reason to be:
 *
 *  - A liveness probe is called by whatever supervises the process (SRS §27's deployment topology
 *    puts nginx in front of it). If it needed a token it could not do its job, and if it touched the
 *    database a slow query would get the process killed for a fault it does not have.
 *  - A readiness probe is the opposite: it exists precisely to report the database, so a deployment
 *    is not sent traffic before it can serve any.
 *  - `/meta` is what a client reads before it has a session — the API prefix and version it should
 *    be talking to.
 *
 * Nothing here reveals configuration. A health endpoint that prints the database host, the pool
 * size or a driver name is a reconnaissance endpoint; it says whether a dependency answers, not how
 * it is wired.
 */

const config = require('../../config/env');
const logger = require('../../config/logger');
const ApiResponse = require('../../utils/ApiResponse');
const { assertConnection } = require('../../config/database');
const { version } = require('../../../package.json');

/** Whole seconds since the process started. */
function uptimeSeconds() {
  return Math.floor(process.uptime());
}

/**
 * Liveness — is this process serving?
 *
 * Deliberately touches nothing. Answering at all is the entire signal.
 */
function health(req, res) {
  return ApiResponse.ok(res, {
    status: 'ok',
    uptime: uptimeSeconds(),
  });
}

/**
 * Readiness — can this process serve a request that needs the database?
 *
 * 503 rather than 500 when the database is unreachable: the process is fine, it is the dependency
 * that is not, and 503 is the status that tells a load balancer to stop sending traffic and keep
 * checking rather than to treat the instance as broken.
 */
async function ready(req, res) {
  let database = 'up';
  let healthy = true;

  try {
    await assertConnection();
  } catch (err) {
    database = 'down';
    healthy = false;
    /*
     * Logged here rather than thrown, because this endpoint reporting a failure is it working
     * correctly — the error handler would record it as a request that went wrong instead.
     */
    logger.error('Readiness check failed: database unreachable', {
      requestId: req.id,
      error: err.message,
    });
  }

  return ApiResponse.ok(
    res,
    { status: healthy ? 'ready' : 'degraded', uptime: uptimeSeconds(), checks: { database } },
    { status: healthy ? 200 : 503 }
  );
}

/**
 * The public API descriptor.
 *
 * Only what a client cannot work out for itself and needs before authenticating.
 */
function meta(req, res) {
  return ApiResponse.ok(res, {
    name: config.app.name,
    version,
    apiPrefix: config.app.apiPrefix,
    environment: config.env,
  });
}

module.exports = { health, ready, meta };
