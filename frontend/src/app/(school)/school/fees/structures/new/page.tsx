'use client';

/**
 * Define a fee structure — SRS §17, FR-FEE-001, Known Issue 30.
 *
 * Follows `super-admin/organizations/new/page.tsx`, which is where the shared decisions are argued,
 * and `school/exams/new/page.tsx`, whose class picker and validator-named-refusal handling are the
 * same two problems this screen has. Only what is specific to a fee structure is written down here.
 *
 * ## The field set is the create schema's
 *
 * `fees.validation.js` `createStructure` takes `school_id`, `name`, `component`, `amount`,
 * `academic_session_id`, `class_id`, `currency`, `is_recurring`, `due_day`, `fine_amount`,
 * `fine_type`, `fine_grace_days`, `discount_amount`, `discount_type`, `is_active`, `description` and
 * `reason`, and marks exactly three `.required()`: **`name`**, **`component`** and **`amount`**. The
 * schema's own comment says why those three: *"`component` and `amount` are what make a structure a
 * structure; the fine and discount are the 'may configure' half and default at the column."* This
 * form marks the same three and no others.
 *
 * Everything else has a default — `is_recurring` false, `fine_amount` and `discount_amount` 0,
 * `fine_type` and `discount_type` `'none'`, `fine_grace_days` 0, `is_active` true at the column, and
 * the currency below — so a blank control means "take the default" rather than "no answer".
 *
 * The currency is the one this form fills in itself. The owner's decision D35 makes the school's own
 * currency (§14.1's setting) the default, and `createStructure()` applies it to a structure sent
 * without one; only a school that has never saved its settings has none, and then the column's `USD`
 * stands. The field starts on that currency, read from the profile (`school.currency` on
 * `/auth/me`), which every school role receives — so an Accountant, who cannot read the settings
 * themselves, sees the currency the structure will be in rather than a blank.
 *
 * `id` and `organization_id` are `forbidden()` rather than merely absent, so they have no control
 * here; `organization_id` is copied from the school row by `createStructure()`.
 *
 * `reason` is not a column on `fee_structures`. It is passed to `recordAudit(...)` as the note on the
 * created-record entry — `pickStructure()` filters it out of the insert — which is why it is on the
 * form and why the hint says where it goes.
 *
 * `school_id` is accepted by the schema and is still not on this form, for the reason the sibling
 * school screens give: `resolveSchool()` reads it only when the caller has no school of their own,
 * and a Principal, School Admin or Accountant — FR-FEE-001's three actors — always has one. Naming a
 * different id is `CROSS_SCHOOL_ACCESS`. See `FORM_FIELDS` below for the one refusal that costs.
 *
 * The route carries `requireModule(MODULES.FEES)` router-level and **no `enforceLimit`** — the
 * routes header says so in as many words, since §11.2's eight limits contain nothing fee-shaped.
 * Neither is pre-checked here: §30 Rule 1 puts entitlement with the API, and `MODULE_NOT_SUBSCRIBED`
 * is in `EXPLAINED_CODES`, so a school whose plan excludes §17 gets the explanation the list gives.
 *
 * ## Two enums, from two different places, and neither is invented
 *
 * `component` is `FEE_COMPONENT_LIST` in `constants.js` — the four §17 names, and the same list the
 * column's ENUM is built from; the suite asserts the schema's copy against the model's so the two
 * cannot drift.
 *
 * `fine_type` and `discount_type` are **not** in `constants.js`. Both the Joi field and
 * `models/finance.js` spell their values inline — `('none','fixed','per_day','percentage')` and
 * `('none','fixed','percentage')` — so those two literals are what is mirrored below. Written down
 * because the absence looks like an oversight otherwise, and a reader checking `constants.js` for
 * them would find nothing and be tempted to add a fifth value of their own.
 *
 * ## The two refusals whose `field` is not a field
 *
 * `models/finance.js` puts two **model-level** validators on `fee_structures`: `fineTypeNeedsAmount`
 * and `discountTypeNeedsAmount`, each refusing a type other than `none` with an amount of zero.
 * Sequelize keys a model-level failure by the validator's own name rather than by a column, and
 * `fees.service.rethrow()` maps a `ValidationError` straight through as
 * `{ field: e.path, message: e.message }` — so the 422 arrives keyed `fineTypeNeedsAmount`.
 *
 * Left alone, `fieldErrors()` would file that under a key no input renders, and the exemplar's
 * `Object.keys(perField).length ? null : caught.message` would then count one field error and
 * suppress the banner too: the form would go silent on the single most likely mistake on the page —
 * choosing a fine type and forgetting the amount that has to go with it. So a detail naming a field
 * this form does not have is promoted to the top-level `Notice`. The same branch catches the
 * `school_id` refusal above.
 *
 * The two validators are independent, so both can fail on one submit — a fine type and a discount
 * type, both amounts blank — and `rethrow()` maps Sequelize's errors one-to-one, so both arrive.
 * This form used to hold the promoted message in a single string that each one overwrote, so the
 * banner showed only the second, and fixing it revealed the first: two round trips for one form.
 * `splitApiErrors()` (`lib/formErrors.ts`) collects them all and joins them, which is what it is for.
 *
 * It also handles the other half — a whole-object Joi `.custom()` reports with no field at all, via
 * `formErrors()`. This schema has none today; the branch costs nothing and the next rule added will
 * land.
 *
 * No `Array.isArray` guard before `fieldErrors()`: `ApiError`'s constructor already drops a `details`
 * that is not an array of field errors, so the conflict shapes reach the banner as their own message.
 * (`rethrow()`'s only conflict is `RECEIPT_NUMBER_TAKEN`, which is `fee_payments`' unique index and
 * cannot fire here — nothing makes a structure's name unique, which is why the name hint says so.)
 *
 * ## What the two pickers are, and what they are deliberately not
 *
 * `class_id` and `academic_session_id` are foreign keys, so both are selects: a raw
 * `academic_sessions.id` in front of an accountant names a row nobody can look up.
 *
 * Neither narrows the other. `createStructure()` calls `loadClassInSchool()` and
 * `loadSessionInSchool()` independently — each checks only that the row belongs to the school, and
 * nothing requires the class and the session to agree — so filtering the class list by the chosen
 * session would hide classes the API would have accepted. Each class option names its own session
 * instead, which is what tells two identically-named classes from consecutive years apart.
 *
 * What both do refuse is a **closed** session — the owner's decision D20. `createStructure()` calls
 * `assertOpenForNew()` on the session named and on the class's own, and answers 409 `SESSION_CLOSED`
 * naming the session. So a closed session is not offered, and a class of one is listed but disabled,
 * with the reason in the hint. Both need the session list; for a caller without it the API's refusal
 * is the only notice, and it is put under the field it is about — the session when that is the one
 * named, the class otherwise.
 *
 * Inactive classes are annotated, never withheld, for the same reason: `loadClassInSchool()` does not
 * test `is_active`, and a picker that dropped them would enforce a rule the module does not have.
 *
 * Both lists need grants this screen's own `fees.manage` does not imply — `classes.view` and
 * `sessions.view` — so they are fetched with `allSettled` and each reports its own failure. Both
 * fields are optional, so neither failure is fatal to the form: the blank answer both selects fall
 * back to is a real answer, not a degraded one. See below.
 *
 * ## Blank is an answer on both pickers, and they mean different things
 *
 *   * **Class** blank is NULL, and the column comment defines it: *"Null = applies school-wide"*. The
 *     fees list renders exactly that as "all classes". A structure with no class is the normal case
 *     for an admission or exam fee.
 *   * **Academic session** blank is NULL too. `assign()` falls back to the *student's* session before
 *     the structure's, so leaving it blank does not orphan the fees raised from it. It starts on the
 *     current session all the same — D20's "forms default to the current session" — and "Not tied to
 *     a session" is still there to choose.
 *
 * The current session comes from the profile (`school.current_session` on `/auth/me`), not from
 * `GET /sessions/current`, which needs the same `sessions.view` as the list. The seeded Accountant —
 * FR-FEE-001's third actor — does not hold it, and so used to meet a disabled select and no default. Now
 * a caller who cannot read the list is offered the current session alone, beside "Not tied to a
 * session", and one who can gets the list with the current session chosen.
 *
 * ## The fine is applied by a daily job; three other fields are recorded and not read
 *
 * Worth knowing before writing hints that promise more than the module does. `assign()` reads
 * `component`, `amount`, `currency`, `name` (as the fee's title), `class_id` and
 * `academic_session_id` from the structure, and applies the discount through `discountFor()`.
 *
 * The fine is the owner's decision D29: `fees.service.applyFines()`, run daily by the `fee-fines`
 * task, fines each fee raised from this structure that is still unpaid or part-paid once its due
 * date plus `fine_grace_days` has passed — `fixed` the amount once, `percentage` that share of the
 * fee's amount once, `per_day` the amount for each day late beyond the grace days, until the fee is
 * paid. It only ever raises a fee's fine, so one set by hand at assignment is kept when it is higher.
 *
 * `due_day` and `is_recurring` are read by nothing: no process raises a fee on a schedule, and each
 * fee's due date is set on its assignment. The hints say so rather than imply an automation that
 * does not exist.
 *
 * ## `discount_amount` is not always an amount
 *
 * `discountFor()` reads it as a **percentage** when `discount_type` is `percentage` —
 * `money.percentageOf(amount, discount_amount)`, so `15` means 15%, not 15 currency units. The Joi
 * field is the shared `moneyField` either way, so nothing on the wire distinguishes the two readings
 * and only the hint can. Same shape for `fine_amount` against `fine_type`.
 *
 * ## Numbers go over the wire as the text that was typed
 *
 * `validate()` runs Joi with `convert: true`, so `"250.00"` arrives as `250`. Coercing here with
 * `Number()` would turn anything unparseable into `NaN`, which `JSON.stringify` writes as `null` —
 * and on `due_day`, `class_id` and `academic_session_id` `null` is a *meaning* the schema allows
 * rather than an error, so a mistyped due day would save silently as "no due day at all".
 *
 * The two booleans are the exception and are sent as real booleans, because JSON carries one and
 * there is no reason to make the server coerce a string it did not have to receive.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import type { PageMeta } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors } from '@/lib/formErrors';
import {
  Field,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
  FormActions,
  FormSection,
  FormSpan,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** `PAGINATION.MAX_LIMIT` — the most `commonSchemas.pagination` accepts in one page. */
const OPTION_LIMIT = 100;

/** `ACADEMIC_SESSION_STATUS.CLOSED` — the one status D20 refuses a new fee structure in. */
const CLOSED = 'closed';

/** §17's four components, mirroring `FEE_COMPONENT_LIST` in `constants.js`. */
const COMPONENTS = ['monthly_fee', 'admission_fee', 'exam_fee', 'transport_fee'];

/** Spelled inline in both `fees.validation.js` and `models/finance.js`; see the header. */
const FINE_TYPES = ['none', 'fixed', 'per_day', 'percentage'];
const DISCOUNT_TYPES = ['none', 'fixed', 'percentage'];

/** A class as `GET /classes` returns it; only the columns the picker reads are declared. */
interface ClassOption {
  id: number;
  name: string;
  code: string | null;
  /** Nullable on the column even though `classes.create` requires it — `SET NULL` on session delete. */
  academic_session_id: number | null;
  is_active: boolean;
}

/** An academic session as `GET /sessions` returns it. */
interface SessionOption {
  id: number;
  name: string;
  /** `ACADEMIC_SESSION_STATUS` — upcoming, active or closed. Closed is refused by D20; see the header. */
  status: string;
  is_current: boolean;
}

/** One option list: what came back, how many exist, and whether the call failed outright. */
interface Loaded<T> {
  rows: T[];
  total: number;
  failed: boolean;
}

const NOT_LOADED = { rows: [], total: 0, failed: false };

function settle<T>(result: PromiseSettledResult<{ data: T[]; meta: PageMeta | null }>): Loaded<T> {
  if (result.status !== 'fulfilled') return { rows: [], total: 0, failed: true };
  const rows = result.value.data ?? [];
  return { rows, total: result.value.meta?.total ?? rows.length, failed: false };
}

/**
 * The form's own field names, and the whole of the create schema's settable surface bar `school_id`.
 *
 * Doubles as the test for "does this 422 belong to an input on this page" — see the header on the
 * two model-level validators.
 */
const EMPTY_VALUES = {
  name: '',
  component: '',
  amount: '',
  currency: '',
  class_id: '',
  academic_session_id: '',
  is_recurring: '',
  due_day: '',
  fine_type: '',
  fine_amount: '',
  fine_grace_days: '',
  discount_type: '',
  discount_amount: '',
  is_active: '',
  description: '',
  reason: '',
};

const FORM_FIELDS = new Set(Object.keys(EMPTY_VALUES));

/** The two controls whose value is a boolean rather than the text of a number or a name. */
const BOOLEAN_FIELDS = new Set(['is_recurring', 'is_active']);

/** Enum values are stored `snake_case` and read as words. */
function humanise(value: string): string {
  return value.replace(/_/g, ' ');
}

export default function NewFeeStructurePage() {
  const router = useRouter();
  const { can, profile } = useAuth();
  const { success } = useToast();

  /* D35 and D20's defaults, from the profile every school role receives — see the header. */
  const schoolCurrency = profile?.school?.currency?.trim() || null;
  const current = profile?.school?.current_session ?? null;
  const currentId = current && current.status !== CLOSED ? String(current.id) : '';

  const [values, setValues] = useState(EMPTY_VALUES);

  /*
   * Both defaults, only into an empty field, so neither overwrites what was chosen; and only when the
   * default itself changes, so a field cleared to take the column's value, or set to "Not tied to a
   * session", stays that way. See the header.
   */
  useEffect(() => {
    if (!schoolCurrency) return;
    setValues((prev) => (prev.currency ? prev : { ...prev, currency: schoolCurrency }));
  }, [schoolCurrency]);

  useEffect(() => {
    if (!currentId) return;
    setValues((prev) => (prev.academic_session_id ? prev : { ...prev, academic_session_id: currentId }));
  }, [currentId]);

  const [classes, setClasses] = useState<Loaded<ClassOption>>(NOT_LOADED);
  const [sessions, setSessions] = useState<Loaded<SessionOption>>(NOT_LOADED);
  const [loadingOptions, setLoadingOptions] = useState(true);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  /*
   * `allSettled`, not `all`. `classes.view` and `sessions.view` are separate grants from the
   * `fees.manage` that opened this screen, and an Accountant is the actor most likely to hold the
   * third without the first two. `Promise.all` would let one missing permission empty both dropdowns,
   * and each has its own remedy — so each reports its own failure and the form still posts without
   * either, since both fields are optional.
   *
   * Neither call sends `school_id`: `tenantWhere(req.tenant, …)` already pins both queries to the
   * caller's school.
   */
  useEffect(() => {
    /* The permission gate is a `return` after the hooks, so without this both lists would be fetched
       for a caller who is about to be told no. `can` is memoized on the profile in `AuthProvider`. */
    if (!can('fees.manage')) {
      setLoadingOptions(false);
      return;
    }

    let live = true;

    (async () => {
      const [classResult, sessionResult] = await Promise.allSettled([
        api.page<ClassOption[]>('/classes', { query: { limit: OPTION_LIMIT } }),
        api.page<SessionOption[]>('/sessions', { query: { limit: OPTION_LIMIT } }),
      ]);
      if (!live) return;

      setClasses(settle(classResult));
      setSessions(settle(sessionResult));
      setLoadingOptions(false);
    })();

    return () => {
      live = false;
    };
  }, [can]);

  /*
   * The sessions the select offers. The list, with the current session added when it fell past the
   * first page — it is the default, so it has to be an option — or, for a caller who cannot read the
   * list, the current session alone. See the header.
   */
  const sessionOptions = useMemo<SessionOption[]>(() => {
    const own = current ? { ...current, is_current: true } : null;
    if (sessions.failed) return own ? [own] : [];
    return own && !sessions.rows.some((row) => row.id === own.id) ? [own, ...sessions.rows] : sessions.rows;
  }, [sessions, current]);

  /** Session names by id, for the label that tells two same-named classes apart. */
  const sessionNames = useMemo(() => {
    const byId = new Map<number, string>();
    for (const session of sessionOptions) byId.set(session.id, session.name);
    return byId;
  }, [sessionOptions]);

  /** The sessions D20 refuses a new structure in — see the header. Empty when the list could not be read. */
  const closedSessions = useMemo(
    () => new Set(sessionOptions.filter((session) => session.status === CLOSED).map((session) => session.id)),
    [sessionOptions]
  );
  const inClosedSession = (row: ClassOption) =>
    row.academic_session_id !== null && closedSessions.has(row.academic_session_id);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /* Only what was filled in, and every number as the string it was typed as. See the header. */
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (BOOLEAN_FIELDS.has(key)) continue;
      const trimmed = value.trim();
      if (trimmed) body[key] = trimmed;
    }

    /* Blank still means "let the column default it" — to false for recurrence, true for status. */
    if (values.is_recurring) body.is_recurring = values.is_recurring === 'true';
    if (values.is_active) body.is_active = values.is_active === 'true';

    try {
      await api.post('/fees/structures', body);
      /*
       * `replace`, not `push` — the exemplar's reason: Back would re-open an empty form for a
       * structure that already exists. No `?tab=structures`: `useActiveTab` falls back to `tabs[0]`,
       * which is the Structures tab, so the bare route already lands on the list this row joins.
       */
      success('Fee structure created', 'Assign it to students to raise their fees.');
      router.replace('/school/fees');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError && caught.code === 'SESSION_CLOSED') {
        /*
         * D20, under the field it is about — see the header. The refusal names the closed session;
         * when that is not the one chosen here, it was the class's own.
         */
        const named = caught.context?.academic_session_id;
        const onSession = values.academic_session_id !== '' && String(named) === values.academic_session_id;
        setFieldErrors(
          onSession
            ? { academic_session_id: caught.message }
            : { class_id: `${caught.message}. This class is in that session; choose a class of an open one, or All classes.` }
        );
        focusFirstInvalidField();
      } else if (caught instanceof ApiError) {
        /*
         * A field this form does not have — `fineTypeNeedsAmount`, `school_id` — goes to the banner
         * rather than nowhere, and **every** such message goes, joined, after the whole-object ones
         * `formErrors()` returns. See the header for why both validators can fail at once.
         */
        const { perField, banner } = splitApiErrors(caught, FORM_FIELDS);
        setFieldErrors(perField);
        setError(banner);
        if (Object.keys(perField).length) focusFirstInvalidField();
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      setSaving(false);
    }
  }

  /*
   * Gated exactly as the Structures tab's "Add structure" button is. `fees.routes.js` mounts
   * `requirePermission('fees.manage')` on `POST /structures` — not `fees.collect`, which is the
   * FR-FEE-002 half: a receptionist may take money against a fee, and may not create one.
   */
  if (!can('fees.manage')) {
    return (
      <div>
        <PageHeader title="New fee structure" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to create a fee structure.',
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New fee structure"
        description="What the school charges, and for what. A name, a component and an amount are required; the structure is then available to assign to students."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          columns={2}
          title="The fee"
          description="What is being charged, how much, and who it applies to."
        >
          <Field
            id="name"
            width="md"
            label="Name"
            required
            maxLength={160}
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
            hint="Up to 160 characters. Becomes the title of every fee raised from this structure, unless the assignment overrides it. Nothing checks it for uniqueness."
          />

          <SelectField
            id="component"
            width="sm"
            label="Component"
            required
            value={values.component}
            onChange={set('component')}
            error={fieldErrors.component}
            hint="The four §17 names, and the whole list — the column is an ENUM of exactly these. It is copied onto each fee raised from this structure and cannot be changed there."
          >
            <option value="">Choose a component</option>
            {COMPONENTS.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </SelectField>

          <Field
            id="amount"
            width="sm"
            label="Amount"
            type="number"
            required
            min={0}
            step={0.01}
            value={values.amount}
            onChange={set('amount')}
            error={fieldErrors.amount}
            hint="Two decimal places, up to 999,999,999,999.99. The base figure; an assignment may override it for one student."
          />

          <Field
            id="currency"
            width="xs"
            label="Currency"
            maxLength={10}
            value={values.currency}
            onChange={set('currency')}
            error={fieldErrors.currency}
            /* No dropdown: neither `constants.js` nor the column carries a currency list, so any set of
               options here would be one this screen made up. Uppercased server-side, as the org code is. */
            hint={`Up to 10 characters, stored in upper case — e.g. USD.${
              schoolCurrency
                ? ` Starts on ${schoolCurrency}, this school’s currency, which a blank also takes.`
                : ' Blank takes the school’s currency, or USD while the school has not saved one in its settings.'
            } Every fee raised from this structure inherits it.`}
          />

          <FormSpan>
            <SelectField
              id="class_id"
              label="Class"
              value={values.class_id}
              onChange={set('class_id')}
              disabled={loadingOptions || classes.failed}
              error={fieldErrors.class_id}
              hint={
                classes.failed
                  ? 'The class list could not be loaded, so a class cannot be chosen here — reading it needs the separate “View classes” permission. The structure can be created without one, and applies school-wide.'
                  : !loadingOptions && classes.rows.length === 0
                    ? 'This school has no classes yet, so the structure will apply school-wide.'
                    : `Leave it on “All classes” for a school-wide charge such as an admission fee.${
                        classes.total > classes.rows.length
                          ? ` Showing the first ${classes.rows.length} of ${classes.total}; a page cannot hold more.`
                          : ''
                      }${
                        classes.rows.some(inClosedSession)
                          ? ' A class of a closed session is shown and cannot be chosen: a closed session takes no new fee structure.'
                          : ''
                      }`
              }
            >
              {/* The empty option is an answer, not an absence — the column comment is "Null = applies
                  school-wide", and the fees list renders it as "all classes". */}
              <option value="">
                {loadingOptions ? 'Loading…' : classes.failed ? 'Unavailable' : 'All classes'}
              </option>
              {classes.rows.map((row) => {
                const session = row.academic_session_id
                  ? sessionNames.get(row.academic_session_id)
                  : undefined;
                const closed = inClosedSession(row);
                return (
                  <option key={row.id} value={row.id} disabled={closed}>
                    {row.name}
                    {row.code ? ` (${row.code})` : ''}
                    {session ? ` — ${session}` : ''}
                    {closed ? ' (closed)' : ''}
                    {row.is_active ? '' : ' — inactive'}
                  </option>
                );
              })}
            </SelectField>
          </FormSpan>

          <FormSpan>
            <SelectField
              id="academic_session_id"
              label="Academic session"
              value={values.academic_session_id}
              onChange={set('academic_session_id')}
              /* Without the list, still the current session — see the header. */
              disabled={loadingOptions || (sessions.failed && sessionOptions.length === 0)}
              error={fieldErrors.academic_session_id}
              hint={
                sessions.failed
                  ? `The session list could not be loaded — reading it needs the separate “View academic sessions” permission${
                      sessionOptions.length > 0 ? ', so only the current session is offered' : ''
                    }. The structure can be created without one.`
                  : `Optional, and starts on the current session. A fee raised from this structure takes the student’s own session first, so leaving this blank does not leave those fees unattached. Closed sessions are not offered — a closed session takes no new fee structure.${
                      sessions.total > sessions.rows.length
                        ? ` Showing the first ${sessions.rows.length} of ${sessions.total}, newest first.`
                        : ''
                    }`
              }
            >
              <option value="">
                {loadingOptions
                  ? 'Loading…'
                  : sessions.failed && sessionOptions.length === 0
                    ? 'Unavailable'
                    : 'Not tied to a session'}
              </option>
              {sessionOptions
                /* D20: `createStructure()` refuses a closed session with `SESSION_CLOSED` — see the header. */
                .filter((session) => session.status !== CLOSED)
                .map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.name} · {session.status}
                    {session.is_current ? ' · current' : ''}
                  </option>
                ))}
            </SelectField>
          </FormSpan>

          <SelectField
            id="is_recurring"
            width="sm"
            label="Recurrence"
            value={values.is_recurring}
            onChange={set('is_recurring')}
            error={fieldErrors.is_recurring}
            hint="Describes the charge — a monthly fee recurs, an admission fee does not. Nothing raises the fee on a schedule: each one is created by assigning this structure to students."
          >
            {/* Blank is the column's own default rather than this screen naming one. */}
            <option value="">Column default (one-off)</option>
            <option value="false">One-off</option>
            <option value="true">Recurring</option>
          </SelectField>

          <FormSpan>
            <Field
              id="due_day"
              label="Due day"
              type="number"
              min={1}
              max={31}
              step={1}
              value={values.due_day}
              onChange={set('due_day')}
              error={fieldErrors.due_day}
              hint="1 to 31 — the day of the month a recurring component falls due. Recorded on the structure; the actual due date is set on each assignment."
            />
          </FormSpan>
        </FormSection>

        <FormSection
          title="Late payment fine"
          description="Applied automatically, by a daily check, to each fee raised from this structure that is still owed, in whole or in part, once its due date and the grace days have passed. Leave the type unset for no fine."
        >
          <SelectField
            id="fine_type"
            label="Fine type"
            value={values.fine_type}
            onChange={set('fine_type')}
            error={fieldErrors.fine_type}
            hint="Fixed adds the amount once; percentage adds that share of the fee once; per day adds the amount for each day the fee is late past the grace days, until it is paid. The check only ever raises a fee’s fine, so one set higher by hand when the fee was assigned is kept. Anything but “none” needs a fine amount above zero."
          >
            <option value="">Column default (none)</option>
            {FINE_TYPES.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </SelectField>

          <Field
            id="fine_amount"
            label="Fine amount"
            type="number"
            min={0}
            step={0.01}
            value={values.fine_amount}
            onChange={set('fine_amount')}
            error={fieldErrors.fine_amount}
            hint="Read as currency for a fixed or per-day fine, and as a percentage of the fee for a percentage one — 15 means 15%. Blank stores 0, which only a fine type of “none” accepts."
          />

          <Field
            id="fine_grace_days"
            label="Grace days"
            type="number"
            min={0}
            max={365}
            step={1}
            value={values.fine_grace_days}
            onChange={set('fine_grace_days')}
            error={fieldErrors.fine_grace_days}
            hint="0 to 365. How many days after a fee’s due date pass before the fine applies; a per-day fine counts only the days after them. Blank stores 0."
          />
        </FormSection>

        <FormSection
          title="Discount"
          description="Applied to every student this structure covers. Leave the type unset for no discount."
        >
          <SelectField
            id="discount_type"
            width="sm"
            label="Discount type"
            value={values.discount_type}
            onChange={set('discount_type')}
            error={fieldErrors.discount_type}
            hint="Unlike the fine, this one is applied: assigning the structure takes the discount off the fee unless the assignment names its own. Anything but “none” needs a discount amount above zero."
          >
            <option value="">Column default (none)</option>
            {DISCOUNT_TYPES.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </SelectField>

          <Field
            id="discount_amount"
            label="Discount amount"
            type="number"
            min={0}
            step={0.01}
            value={values.discount_amount}
            onChange={set('discount_amount')}
            error={fieldErrors.discount_amount}
            hint="Currency for a fixed discount, a percentage of the fee for a percentage one — 15 means 15%. Never takes the fee below zero. Blank stores 0, which only a discount type of “none” accepts."
          />
        </FormSection>

        <FormSection
          title="Status and notes"
          description="Whether the structure is in force, and why it was created."
        >
          <SelectField
            id="is_active"
            width="sm"
            label="Status"
            value={values.is_active}
            onChange={set('is_active')}
            error={fieldErrors.is_active}
            hint="Inactive is how a component the school no longer charges is retired: §17 names no delete, and removing a structure would take the fees raised from it with it."
          >
            <option value="">Column default (active)</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </SelectField>

          <TextAreaField
            id="description"
            label="Description"
            rows={3}
            maxLength={255}
            value={values.description}
            onChange={set('description')}
            error={fieldErrors.description}
            hint="Up to 255 characters. Searched alongside the name and component on the structures list."
          />

          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            hint="Up to 255 characters. Not stored on the structure — it is the note on this structure's audit entry."
          />
        </FormSection>

        <FormActions cancelHref="/school/fees">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create fee structure
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
