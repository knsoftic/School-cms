/**
 * Joi → OpenAPI Schema Object.
 *
 * SRS §28 requires every endpoint to document its Parameters and Request Body. This application
 * already states both, exactly and in one place: the Joi schemas passed to `validate()`. They are
 * not a description of what an endpoint accepts — they are the thing that decides it, and a request
 * that contradicts them is rejected with 422. Converting them is therefore the only way to produce a
 * document that is accurate by construction rather than by diligence.
 *
 * The conversion is deliberately conservative. Where OpenAPI cannot express what Joi enforces, the
 * constraint is written into `description` in words rather than dropped silently or approximated
 * into something subtly wrong — a reader told "required only when `kind` is `a`" is better served
 * than one shown an unconditional `required` the API does not actually impose.
 *
 * Three Joi constructs get that treatment:
 *
 *   - **`.when()`** (26 uses) has no OpenAPI equivalent. The base schema is emitted and the
 *     condition described. `oneOf` would be wrong: it says "match exactly one of these shapes",
 *     which is not what a conditional presence rule means.
 *   - **`.custom()`** runs arbitrary JavaScript. Its existence is noted; its logic cannot be read.
 *   - **`.forbidden()`** (36 uses) marks a key the route *refuses*. Those keys are omitted from the
 *     document entirely, because they are not part of the contract — sending one is an error. This
 *     matters more than it looks: several routes deliberately lift one key out of a shared
 *     `forbidden()` map, and a generated document shows the result of that lift rather than the
 *     intent behind it.
 */

/** Joi marks an overriding `allow()` with this sentinel; it is not a permitted value. */
function isOverrideSentinel(value) {
  return value !== null && typeof value === 'object' && value.override === true;
}

/** `String(/^x$/)` is `"/^x$/"`; OpenAPI wants the source without the delimiters or flags. */
function patternSource(regex) {
  const text = String(regex);
  const end = text.lastIndexOf('/');
  return end > 0 && text.startsWith('/') ? text.slice(1, end) : text;
}

function ruleMap(described) {
  const map = new Map();
  for (const rule of described.rules || []) map.set(rule.name, rule.args || {});
  return map;
}

function presenceWord(branch) {
  const presence = branch && branch.flags && branch.flags.presence;
  if (presence === 'required') return 'required';
  if (presence === 'forbidden') return 'not permitted';
  if (presence === 'optional') return 'optional';
  return 'constrained further';
}

/** Collect the human-readable notes OpenAPI has no field for. */
function notesFor(described, rules) {
  const notes = [];

  if (rules.has('precision')) {
    notes.push('at most ' + rules.get('precision').limit + ' decimal places');
  }
  if (rules.has('custom')) {
    notes.push('subject to an additional server-side check');
  }

  for (const when of described.whens || []) {
    const field = when.ref && when.ref.path ? when.ref.path.join('.') : 'another field';
    const branches = [];
    if (when.then) branches.push('then ' + presenceWord(when.then));
    if (when.otherwise) branches.push('otherwise ' + presenceWord(when.otherwise));
    notes.push(
      'conditional on `' + field + '`' + (branches.length ? ' — ' + branches.join(', ') : '')
    );
  }

  return notes;
}

/**
 * Convert one described Joi schema.
 *
 * @param {object} described  output of `schema.describe()`
 * @returns {object|null} an OpenAPI Schema Object, or `null` for a forbidden key
 */
function convert(described) {
  if (!described || typeof described !== 'object') return {};

  const flags = described.flags || {};
  if (flags.presence === 'forbidden') return null;

  const rules = ruleMap(described);
  const out = {};

  switch (described.type) {
    case 'string': {
      out.type = 'string';
      if (rules.has('min')) out.minLength = rules.get('min').limit;
      if (rules.has('max')) out.maxLength = rules.get('max').limit;
      if (rules.has('length')) {
        out.minLength = rules.get('length').limit;
        out.maxLength = rules.get('length').limit;
      }
      if (rules.has('pattern')) out.pattern = patternSource(rules.get('pattern').regex);
      if (rules.has('email')) out.format = 'email';
      if (rules.has('uri')) out.format = 'uri';
      if (rules.has('guid') || rules.has('uuid')) out.format = 'uuid';
      if (rules.has('isoDate')) out.format = 'date-time';
      break;
    }

    case 'number': {
      out.type = rules.has('integer') ? 'integer' : 'number';
      if (rules.has('min')) out.minimum = rules.get('min').limit;
      if (rules.has('max')) out.maximum = rules.get('max').limit;
      if (rules.has('greater')) {
        out.minimum = rules.get('greater').limit;
        out.exclusiveMinimum = true;
      }
      if (rules.has('less')) {
        out.maximum = rules.get('less').limit;
        out.exclusiveMaximum = true;
      }
      if (rules.has('positive')) {
        out.minimum = 0;
        out.exclusiveMinimum = true;
      }
      break;
    }

    case 'boolean':
      out.type = 'boolean';
      break;

    /*
     * A date crosses the wire as a string. `.iso()` is the only format this codebase uses (57 of 57),
     * and `date-time` is its OpenAPI spelling — a caller reading `type: string` alone would have no
     * idea what to send.
     */
    case 'date':
      out.type = 'string';
      out.format = 'date-time';
      break;

    case 'array': {
      out.type = 'array';
      const items = (described.items || []).map(convert).filter(Boolean);
      out.items = items.length === 1 ? items[0] : items.length ? { oneOf: items } : {};
      if (rules.has('min')) out.minItems = rules.get('min').limit;
      if (rules.has('max')) out.maxItems = rules.get('max').limit;
      if (rules.has('length')) {
        out.minItems = rules.get('length').limit;
        out.maxItems = rules.get('length').limit;
      }
      if (rules.has('unique')) out.uniqueItems = true;
      break;
    }

    case 'object': {
      out.type = 'object';
      const { properties, required } = convertKeys(described.keys);
      if (Object.keys(properties).length) out.properties = properties;
      if (required.length) out.required = required;
      /*
       * `validate()` strips unknown keys rather than accepting them, so a documented body that
       * allowed extras would be describing a permissiveness the API does not have.
       */
      if (flags.unknown !== true) out.additionalProperties = false;
      break;
    }

    case 'alternatives': {
      const options = (described.matches || [])
        .map((match) => match.schema && convert(match.schema))
        .filter(Boolean);
      if (options.length) out.oneOf = options;
      break;
    }

    default:
      /* `any`, `binary` and anything else: no type constraint is the honest rendering. */
      break;
  }

  /* `.valid()` sets `only`, which turns the allow-list into a closed enumeration. */
  const allowed = (described.allow || []).filter((value) => !isOverrideSentinel(value));
  if (flags.only && allowed.length) out.enum = allowed;
  if (allowed.includes(null)) out.nullable = true;

  /* A function default is computed per request; printing `[Function]` would be worse than silence. */
  if (flags.default !== undefined && typeof flags.default !== 'function') {
    out.default = flags.default;
  }

  const description = [];
  if (flags.description) description.push(flags.description);
  description.push(...notesFor(described, rules));
  if (description.length) out.description = description.join('; ');

  return out;
}

/**
 * Convert an object's keys, separating the required ones.
 *
 * @param {object} keys  `describe().keys`
 * @returns {{properties: object, required: string[]}}
 */
function convertKeys(keys) {
  const properties = {};
  const required = [];

  for (const [name, described] of Object.entries(keys || {})) {
    const schema = convert(described);
    if (schema === null) continue; /* forbidden: not part of the contract */
    properties[name] = schema;
    if (described.flags && described.flags.presence === 'required') required.push(name);
  }

  return { properties, required };
}

/**
 * Convert a live Joi schema rather than a description.
 *
 * @param {import('joi').Schema} schema
 * @returns {object}
 */
function fromJoi(schema) {
  if (!schema || typeof schema.describe !== 'function') return {};
  return convert(schema.describe()) || {};
}

module.exports = { fromJoi, convert, convertKeys, patternSource };
