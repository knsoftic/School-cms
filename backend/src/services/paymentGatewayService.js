'use strict';

/**
 * Payment gateway registry — SRS §13.2, *"The payment gateway system must be plugin-based."*
 * FR-BILL-002 repeats it: *"Online Gateway integrations are implemented using a plugin-based
 * architecture."*
 *
 * This file **is** the plugin architecture. It ships with **zero adapters**, and that is the finished
 * state of the requirement rather than a gap in it — see below.
 *
 * ## Methods are not gateways, and `env.payments.enabledGateways` gates the first
 *
 * §13.2 lists five payment *methods*: Cash, Bank Transfer, Manual Payment, Online Gateway, Wallet. Four
 * of them are recorded, not processed — cash is counted, a transfer is reconciled from a bank statement,
 * a manual payment is reviewed by a Super Admin under FR-BILL-003/004, and a wallet is an internal
 * balance. Only **Online Gateway** talks to a third party, so only it needs an adapter.
 *
 * `env.payments.enabledGateways` defaults to exactly those five method names, so despite its name it is
 * the deployment's *method* allow-list — a school in a country with no card processing can be given
 * `PAYMENT_GATEWAYS=cash,bank_transfer,manual_payment`. `assertMethodEnabled()` is where that is read.
 * The adapter registry below is keyed by `payments.gateway_key` instead, which is a different column
 * answering a different question.
 *
 * ## Why no adapter ships, stated plainly
 *
 * The SRS names no payment provider. Not Stripe, not PayPal, not Razorpay, not a local processor —
 * §13.2 says *"Online Gateway"* and *"plugin-based"* and stops. Shipping a Stripe adapter would:
 *
 *  1. invent a requirement, which SRS §35 forbids;
 *  2. require credentials that do not exist — `env.payments.onlineGateway.apiKey` defaults to `''`;
 *  3. make the *plugin* claim false, because the one built-in would become the assumed shape.
 *
 * So what is implemented is the seam: a registry, a validated adapter contract, `charge()` and
 * `refund()` dispatch, `payment_transactions` writing on both, and a refusal that names what is missing
 * when an online payment is attempted with nothing registered. Adding a real provider is
 * `register({ key, label, charge, refund })` in a bootstrap file and one env var — no change to
 * `payments.service.js`, which is the test of whether the architecture is actually plugin-based.
 *
 * ## The adapter contract
 *
 *     {
 *       key: 'stripe',                       // matches payments.gateway_key, STRING(60)
 *       label: 'Stripe',
 *       async charge({ payment, invoice, amount, currency, metadata }) {
 *         // → { status, gatewayTransactionId, raw, errorCode?, errorMessage? }
 *         //   status is one of PAYMENT_TRANSACTION_STATUS
 *       },
 *       async refund({ payment, refund, amount, currency, metadata }) {
 *         // → the same shape
 *       },
 *       verifyWebhook?(rawBody, signature) { return true|false },
 *     }
 *
 * `charge()` and `refund()` return a result rather than throwing on a declined card: a decline is an
 * outcome the `payment_transactions` row must record, not an exception that loses it. A thrown error is
 * still handled — `dispatch()` converts it into a `failed` result carrying the message — because an
 * adapter written by someone else will throw eventually.
 */

const env = require('../config/env');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');
const {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LIST,
  PAYMENT_TRANSACTION_STATUS,
} = require('../config/constants');

/** key → adapter. Module-level, so registration at boot is visible to every request. */
const adapters = new Map();

/** The two functions an adapter must provide. `verifyWebhook` is optional. */
const REQUIRED_METHODS = Object.freeze(['charge', 'refund']);

/**
 * Register a gateway adapter.
 *
 * Validated on the way in rather than on first use: a malformed adapter discovered at boot is a
 * misconfiguration, while the same adapter discovered mid-charge is a school's failed payment.
 *
 * @param {object} adapter See the contract in the header.
 * @returns {object} the registered adapter
 */
function register(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('paymentGatewayService.register() needs an adapter object');
  }

  const key = String(adapter.key || '').trim();

  if (!key) throw new Error('A gateway adapter needs a "key"');
  if (key.length > 60) {
    throw new Error(`Gateway key "${key}" exceeds payments.gateway_key's 60 characters`);
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`Gateway adapter "${key}" must implement ${method}()`);
    }
  }

  if (adapters.has(key)) {
    logger.warn('Payment gateway adapter replaced', { key });
  }

  adapters.set(key, { label: key, ...adapter, key });
  logger.info('Payment gateway adapter registered', { key, label: adapter.label || key });

  return adapters.get(key);
}

/**
 * Forget an adapter. Exists for the verification suite, which registers a stub and must not leak it into
 * whatever runs next in the same process.
 *
 * @param {string} key
 * @returns {boolean}
 */
function unregister(key) {
  return adapters.delete(String(key || '').trim());
}

/** @returns {Array<{key: string, label: string, supportsRefund: boolean}>} */
function list() {
  return [...adapters.values()].map((adapter) => ({
    key: adapter.key,
    label: adapter.label,
    supportsRefund: typeof adapter.refund === 'function',
  }));
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function has(key) {
  return adapters.has(String(key || '').trim());
}

/**
 * The adapter for a key, or a 422 naming what is missing.
 *
 * A 422 rather than a 500: the request asked for a gateway this deployment does not have, which is a
 * problem with the request or the configuration and is fixable by whoever sent it.
 *
 * @param {string} key
 * @returns {object}
 */
function get(key) {
  const resolved = String(key || '').trim();
  const adapter = adapters.get(resolved);

  if (!adapter) {
    throw new ApiError(
      422,
      adapters.size
        ? `No payment gateway "${resolved}" is registered`
        : 'No payment gateway adapter is registered on this deployment — an online payment cannot be processed',
      {
        code: adapters.size ? 'PAYMENT_GATEWAY_UNKNOWN' : 'PAYMENT_GATEWAY_NOT_CONFIGURED',
        details: {
          requested: resolved || null,
          registered: list().map((entry) => entry.key),
          /* What it would take, so the refusal is actionable rather than just accurate. */
          required: adapters.size
            ? undefined
            : 'register an adapter via paymentGatewayService.register() and set ONLINE_GATEWAY_* in the environment',
        },
      }
    );
  }

  return adapter;
}

/**
 * Is this §13.2 payment method permitted on this deployment?
 *
 * @param {string} method
 * @returns {boolean}
 */
function isMethodEnabled(method) {
  const enabled = env.payments.enabledGateways || [];
  return enabled.includes(String(method || '').trim());
}

/**
 * Refuse a payment method the deployment has switched off.
 *
 * @param {string} method one of `PAYMENT_METHODS`
 * @returns {void}
 */
function assertMethodEnabled(method) {
  if (isMethodEnabled(method)) return;

  throw new ApiError(422, `The "${method}" payment method is not enabled on this deployment`, {
    code: 'PAYMENT_METHOD_DISABLED',
    details: {
      method,
      enabled: env.payments.enabledGateways,
      known: PAYMENT_METHOD_LIST,
    },
  });
}

/**
 * The methods a payment form may offer, with the online option's readiness resolved.
 *
 * `available` is false for `online_gateway` when nothing is registered, so the screen can grey the
 * option out instead of offering a payment that is going to be refused.
 *
 * @returns {Array<{method: string, enabled: boolean, available: boolean, requiresAdapter: boolean,
 *                  gateways: object[]}>}
 */
function methods() {
  const registered = list();

  return PAYMENT_METHOD_LIST.map((method) => {
    const requiresAdapter = method === PAYMENT_METHODS.ONLINE_GATEWAY;
    const enabled = isMethodEnabled(method);

    return {
      method,
      enabled,
      requiresAdapter,
      available: enabled && (!requiresAdapter || registered.length > 0),
      gateways: requiresAdapter ? registered : [],
    };
  });
}

/**
 * The configured default gateway key, from `env.payments.onlineGateway`.
 *
 * Used when a request selects `online_gateway` without naming which one — the common case for a
 * deployment with a single provider.
 *
 * @returns {string}
 */
function defaultGatewayKey() {
  return env.payments.onlineGateway.key;
}

/**
 * Has the online gateway's configuration been filled in?
 *
 * Separate from `has()`: an adapter can be registered while its credentials are still the empty-string
 * defaults, and a charge attempted in that state fails at the provider with something unhelpful.
 *
 * @returns {boolean}
 */
function isConfigured() {
  const { apiKey, secret } = env.payments.onlineGateway;
  return Boolean(apiKey && secret);
}

/**
 * Normalise whatever an adapter returned into the shape `payment_transactions` stores.
 *
 * An adapter that returns nothing, or a status outside `PAYMENT_TRANSACTION_STATUS`, is treated as
 * `failed` with the reason recorded — the alternative is a transaction row whose `status` column holds a
 * value the enum does not have, which the database would reject and which would lose the whole attempt.
 *
 * @param {any} result
 * @returns {{status: string, gatewayTransactionId: string|null, raw: object|null,
 *            errorCode: string|null, errorMessage: string|null}}
 */
function normaliseResult(result) {
  const known = Object.values(PAYMENT_TRANSACTION_STATUS);
  const status = result && known.includes(result.status) ? result.status : null;

  return {
    status: status || PAYMENT_TRANSACTION_STATUS.FAILED,
    gatewayTransactionId: result && result.gatewayTransactionId ? String(result.gatewayTransactionId).slice(0, 191) : null,
    raw: result && result.raw && typeof result.raw === 'object' ? result.raw : null,
    errorCode: result && result.errorCode ? String(result.errorCode).slice(0, 60) : status ? null : 'ADAPTER_CONTRACT',
    errorMessage:
      result && result.errorMessage
        ? String(result.errorMessage).slice(0, 255)
        : status
          ? null
          : `Gateway adapter returned an unusable result: ${JSON.stringify(result || null).slice(0, 180)}`,
  };
}

/**
 * Call `charge` or `refund` on an adapter and always come back with a recordable result.
 *
 * A thrown error becomes a `failed` result rather than propagating, because the caller is inside a
 * transaction that must still write the `payment_transactions` row: an attempt that vanished is worse
 * than an attempt that failed, since only the second one can be investigated.
 *
 * @param {string} key gateway key
 * @param {'charge'|'refund'} operation
 * @param {object} context passed straight to the adapter
 * @returns {Promise<{status: string, gatewayTransactionId: string|null, raw: object|null,
 *                    errorCode: string|null, errorMessage: string|null}>}
 */
async function dispatch(key, operation, context) {
  const adapter = get(key);

  if (typeof adapter[operation] !== 'function') {
    return normaliseResult({
      status: PAYMENT_TRANSACTION_STATUS.FAILED,
      errorCode: 'UNSUPPORTED_OPERATION',
      errorMessage: `Gateway "${adapter.key}" does not support ${operation}`,
    });
  }

  try {
    return normaliseResult(await adapter[operation](context));
  } catch (error) {
    logger.error('Payment gateway adapter threw', {
      key: adapter.key,
      operation,
      message: error.message,
    });

    return normaliseResult({
      status: PAYMENT_TRANSACTION_STATUS.FAILED,
      errorCode: error.code ? String(error.code) : 'ADAPTER_ERROR',
      errorMessage: error.message,
    });
  }
}

/**
 * Ask an adapter whether a webhook body really came from the provider.
 *
 * Returns `false` rather than throwing when the adapter has no `verifyWebhook` — an unverifiable webhook
 * must not be treated as verified, and defaulting to `true` here is exactly how a gateway integration
 * becomes an unauthenticated write endpoint.
 *
 * @param {string} key
 * @param {string|Buffer} rawBody
 * @param {string} signature
 * @returns {boolean}
 */
function verifyWebhook(key, rawBody, signature) {
  const adapter = get(key);
  if (typeof adapter.verifyWebhook !== 'function') return false;

  try {
    return Boolean(adapter.verifyWebhook(rawBody, signature));
  } catch (error) {
    logger.warn('Gateway webhook verification threw', { key, message: error.message });
    return false;
  }
}

module.exports = {
  register,
  unregister,
  list,
  has,
  get,
  methods,
  isMethodEnabled,
  assertMethodEnabled,
  defaultGatewayKey,
  isConfigured,
  normaliseResult,
  dispatch,
  verifyWebhook,
  REQUIRED_METHODS,
};
