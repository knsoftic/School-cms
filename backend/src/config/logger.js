'use strict';

/**
 * Winston logger — SRS §26 "Error Logs", §27 "Logging".
 *
 * Two rotating files (`error-%DATE%.log`, `combined-%DATE%.log`) retained for
 * LOG_RETENTION_DAYS, plus a console transport outside production.
 */

const fs = require('fs');
const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

const config = require('./env');

fs.mkdirSync(config.logging.dir, { recursive: true });

const { combine, timestamp, printf, errors, json, colorize } = winston.format;

const consoleFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} ${level}: ${stack || message}${extra}`;
});

const transports = [
  new winston.transports.DailyRotateFile({
    level: 'error',
    dirname: config.logging.dir,
    filename: 'error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: `${config.logging.retentionDays}d`,
    zippedArchive: true,
  }),
  new winston.transports.DailyRotateFile({
    dirname: config.logging.dir,
    filename: 'combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: `${config.logging.retentionDays}d`,
    zippedArchive: true,
  }),
];

if (!config.isProduction && !config.isTest) {
  transports.push(
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), consoleFormat),
    })
  );
}

const logger = winston.createLogger({
  level: config.logging.level,
  defaultMeta: { service: 'msms-api', env: config.env },
  format: combine(errors({ stack: true }), timestamp(), json()),
  transports,
  exitOnError: false,
});

/** Stream adapter so morgan writes through winston. */
logger.stream = {
  write(message) {
    logger.info(message.trim());
  },
};

/** Resolve the log directory for the monitoring endpoint. */
logger.directory = config.logging.dir;
logger.logPath = (name) => path.join(config.logging.dir, name);

module.exports = logger;
