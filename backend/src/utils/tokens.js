'use strict';

/**
 * Crypto + token helpers (SRS §7, §24 "JWT Security").
 *
 * Access and refresh tokens are signed with separate secrets, carry `iss`/`aud`/`jti`,
 * and pin the algorithm so a token cannot be re-signed with `alg: none`.
 * Refresh tokens are stored only as SHA-256 hashes, so a database read cannot mint sessions.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config/env');

/* ───────────────────────────── passwords (FR-AUTH-004) ───────────────────────────── */

async function hashPassword(plain) {
  return bcrypt.hash(plain, config.security.bcryptRounds);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/* ───────────────────────────── random tokens ───────────────────────────── */

/** URL-safe random token, used for password reset and email verification. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Deterministic hash for at-rest storage of a bearer-style secret. */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time comparison for tokens/signatures. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ───────────────────────────── JWT (FR-AUTH-001/003) ───────────────────────────── */

/**
 * Build the JWT payload. Tenant scope travels *in the token* — never taken from the request —
 * which is what makes the tenant middleware trustworthy (SRS §8).
 *
 * ## Permissions are deliberately not a claim
 *
 * They used to be. Nothing read them: `authenticate` populates `req.getPermissions()`, which always
 * asks `permissionService`, and every authorization decision in the codebase goes through that. The
 * claim was therefore a stale copy of authoritative data — a role edited a minute ago would not be
 * reflected in it — carried on every request for nothing. For a Super Admin with 109 permissions it
 * took the token from 379 to 3,093 characters, so every request in the system paid a three-kilobyte
 * `Authorization` header, close enough to nginx's default header buffer to matter once cookies are
 * added.
 *
 * The client still gets the list: it is in the body of login, refresh and `/auth/me`, which is where
 * a frontend reads it and where it is fresh.
 *
 * @param {object} user  a User instance with role + tenancy loaded
 */
function accessTokenPayload(user) {
  return {
    sub: String(user.id),
    role: user.role ? user.role.slug : null,
    roleId: user.role_id,
    organizationId: user.organization_id || null,
    schoolId: user.school_id || null,
    typ: 'access',
  };
}

function signAccessToken(payload) {
  return jwt.sign(payload, config.jwt.accessSecret, {
    algorithm: config.jwt.algorithm,
    expiresIn: config.jwt.accessExpiresIn,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    jwtid: crypto.randomUUID(),
  });
}

function signRefreshToken(userId) {
  return jwt.sign({ sub: String(userId), typ: 'refresh' }, config.jwt.refreshSecret, {
    algorithm: config.jwt.algorithm,
    expiresIn: config.jwt.refreshExpiresIn,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    jwtid: crypto.randomUUID(),
  });
}

/** @throws {jwt.JsonWebTokenError} */
function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.accessSecret, {
    algorithms: [config.jwt.algorithm],
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
}

/** @throws {jwt.JsonWebTokenError} */
function verifyRefreshToken(token) {
  return jwt.verify(token, config.jwt.refreshSecret, {
    algorithms: [config.jwt.algorithm],
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
}

/** Seconds until a decoded token expires; 0 when already expired. */
function secondsUntilExpiry(decoded) {
  if (!decoded || !decoded.exp) return 0;
  return Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
}

module.exports = {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256,
  safeEqual,
  accessTokenPayload,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  secondsUntilExpiry,
};
