'use strict';

/**
 * Process entry point — `npm start` and `npm run dev`.
 *
 * Everything that can only be done once per process lives here, and nothing else does: configuration
 * validation, the database and cache connections, binding the port, and shutting all of it down
 * again. `app.js` stays importable without any of it happening.
 *
 * ## Fail at boot, not on the first request
 *
 * `assertRuntimeConfig()` and `assertConnection()` both run *before* `listen`. A process that binds
 * its port with a bad JWT secret or an unreachable database is worse than one that refuses to start:
 * it passes a port check, gets sent traffic, and then fails every request — and in a rolling deploy
 * that means the healthy instance it replaced is already gone.
 *
 * ## Shutting down
 *
 * SIGTERM is how a container runtime, systemd or nginx asks for a graceful stop, and the default
 * behaviour is to drop every in-flight request. So: stop accepting connections, let the open ones
 * finish, close the pool, exit. With a hard timeout, because `server.close()` waits for keep-alive
 * connections that may never send another byte, and a shutdown that hangs is eventually a kill -9
 * with in-flight work lost anyway.
 */

const config = require('./config/env');
const logger = require('./config/logger');
const { createApp } = require('./app');
const { sequelize, assertConnection } = require('./config/database');
const { assertSchemaMatchesSrs } = require('./models');
const { initCache } = require('./config/cache');

/** How long a graceful shutdown may take before it stops being graceful. */
const SHUTDOWN_TIMEOUT_MS = 15000;

/** Set once shutdown begins, so a second signal does not start a second one. */
let shuttingDown = false;

/**
 * Close the HTTP server and the database pool, then exit.
 *
 * @param {import('http').Server} server
 * @param {string} reason  the signal or condition that triggered this
 * @param {number} code    process exit code
 */
async function shutdown(server, reason, code) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Shutting down (${reason})`);

  const forced = setTimeout(() => {
    logger.error(`Graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; exiting now`);
    process.exit(code || 1);
  }, SHUTDOWN_TIMEOUT_MS);

  /* Does not block the event loop from emptying, so a clean exit is not held open by this timer. */
  forced.unref();

  try {
    await new Promise((resolve, reject) => {
      /* Stops accepting new connections; the callback fires once the open ones have finished. */
      server.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info('HTTP server closed');

    await sequelize.close();
    logger.info('Database pool closed');
  } catch (err) {
    logger.error('Error during shutdown', { error: err.message });
    clearTimeout(forced);
    return process.exit(1);
  }

  clearTimeout(forced);
  return process.exit(code || 0);
}

/**
 * Validate, connect, listen.
 */
async function start() {
  /*
   * Configuration first, before a connection is attempted — a missing DB_NAME should be reported as
   * the misconfiguration it is, not as a connection failure.
   */
  config.assertRuntimeConfig();

  /*
   * The §29 schema guard, actually on the boot path.
   *
   * `models/index.js` promised this in two docblocks — ":7 fails at boot if the registered models
   * drift from the SRS §29 table list" and ":602 Fails at boot if…" — and this file's own header is
   * titled *"Fail at boot, not on the first request"*. None of it was true:
   * `assertSchemaMatchesSrs()` had exactly one caller in the repository, `scripts/check-models.js`,
   * an opt-in developer command. A process started with `npm start` would bind its port with a 65th
   * model registered and say nothing — precisely the failure the docblock said it prevented.
   *
   * It runs before the connection because it inspects only the registered models: a schema that
   * cannot be right should be reported as the §35 violation it is, not delayed behind a network
   * round trip that might fail first and mask it.
   */
  const { tableCount } = assertSchemaMatchesSrs();
  logger.info(`Schema matches SRS §29 (${tableCount} tables)`);

  await assertConnection();
  logger.info(`Database connected (${config.db.name})`);

  /*
   * `MIGRATE_ON_BOOT` — for a host where nobody can run `npm run db:migrate` (docs/DEPLOY-HOSTINGER.md).
   *
   * Before `listen`, not after: a request served against a schema one migration behind is the failure
   * this prevents, and a process that cannot migrate should not bind its port at all. A thrown error
   * reaches `start().catch` below and exits non-zero, which the host shows as a failed start.
   */
  if (config.boot.migrate) {
    const migrator = require('./database/migrator');
    const applied = await migrator.up(sequelize);
    await require('./database/seed').run(sequelize);
    logger.info(`MIGRATE_ON_BOOT: applied ${applied.length} migration(s); mandatory seed complete`);
  }

  /*
   * A no-op unless CACHE_DRIVER=redis. It resolves rather than rejects when Redis is unreachable,
   * falling back to the in-memory driver — a cache is an optimisation, and losing it should not stop
   * the application from serving.
   */
  await initCache();

  /*
   * `CRON_IN_API` — the scheduler in this process, for a host that gives an app no second one.
   *
   * Started before `listen` so a bad `CRON_SKIP` fails the boot as a configuration error instead of
   * surfacing later as an uncaught exception. The sweeps need the database, not the HTTP server, so
   * nothing is lost by their first tick arriving before the port is bound. `assertRuntimeConfig()`
   * has already refused this alongside `ENABLE_CRON` in production, and `cron.js` refuses resident
   * mode while it is on — so there is one scheduler, whichever process owns it.
   */
  if (config.cron.inApi) {
    require('./jobs/cron').schedule({ skip: config.cron.skip });
  }

  const app = createApp();
  const server = app.listen(config.app.port, () => {
    logger.info(
      `${config.app.name} listening on port ${config.app.port} ` +
        `(${config.env}, API at ${config.app.apiPrefix})`
    );
  });

  server.on('error', (err) => {
    /* EADDRINUSE is the common one and its default message does not name the port. */
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${config.app.port} is already in use`);
    } else {
      logger.error('HTTP server error', { error: err.message, code: err.code });
    }
    process.exit(1);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => shutdown(server, signal, 0));
  }

  /*
   * A rejection nobody handled leaves the process in a state we cannot reason about — some request
   * failed silently, and the next one may too. Logged with the stack and then shut down cleanly,
   * which is what Node itself does by default from v15 but without closing the pool first.
   */
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    shutdown(server, 'unhandledRejection', 1);
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    shutdown(server, 'uncaughtException', 1);
  });

  return server;
}

start().catch((err) => {
  /*
   * Boot failed, so there is no server to close and no logger guarantee either — a configuration
   * error can be thrown before the log directory is usable. Written to stderr as well as the log.
   */
  logger.error('Failed to start', { error: err.message, stack: err.stack });
  process.stderr.write(`\nFailed to start: ${err.message}\n`);
  process.exit(1);
});
