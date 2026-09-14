'use client';

/**
 * Add a book to the catalogue — SRS §20.4 "Library", FR-LIB-001, Known Issue 30.
 *
 * Follows `super-admin/organizations/new/page.tsx`, which is where the shared decisions are argued —
 * the omit-blanks rule, `fieldErrors()` onto the inputs, `EXPLAINED_CODES` to `RefusalNotice`,
 * `router.replace` on success — and `school/subjects/new/page.tsx`, which is where the school-scope
 * decisions are. Only what is specific to a book is written down here.
 *
 * ## The field set is the create schema's, and only `title` is required
 *
 * `library.validation.js` `createBook` names `school_id`, `title`, `author`, `category`, `isbn`,
 * `publisher`, `edition`, `language`, `rack_number`, `description`, `quantity`, `price`,
 * `fine_per_day`, `loan_days`, `is_active` and `reason`, and marks exactly one `.required()` —
 * **`title`**. Every other column has a default on the `books` model that `createBook()` is content
 * to take: `quantity` 1, `fine_per_day` 0, `loan_days` 14, `is_active` true, `price` null, and every
 * descriptive string null. FR-LIB-001 asks for *"Books, Authors, Categories, and Quantity"*, and a
 * one-required-field form is what that turns into once the defaults are read rather than guessed.
 *
 * ## The two fields that look like foreign keys are not
 *
 * Author and category are the obvious candidates for a picker, and they are **columns**, not tables:
 * `books.author STRING(255)` and `books.category STRING(120)`. `library.validation.js` says why —
 * §29 fixes the schema at 64 tables, lists neither, and §35 forbids a 65th. So they are free-text
 * inputs. Nor is either backed by a suggestion list scraped from `GET /library/books`: that endpoint
 * pages at 100 rows, so the "known categories" it could offer would be the categories of *some* of
 * the catalogue, and a control that quietly omits the value you were looking for is worse than one
 * that never promised it.
 *
 * That leaves this create with no foreign key at all. The book's only two are `school_id` and
 * `organization_id`, and neither is a caller's to choose — see below.
 *
 * ## Three columns the schema refuses by name
 *
 * `id`, `organization_id`, `available_quantity` and `cover_path` are `forbiddenField(...)`, refused
 * rather than stripped, so a control for any of them would be a control whose only outcome is a 422.
 * Two are worth the words:
 *
 *   * **`available_quantity`** is `quantity` minus the copies on loan, and a new catalogue entry has
 *     none — `createBook()` writes `available_quantity = quantity` itself. A caller who could set it
 *     could make a book look available while every copy was out.
 *   * **`cover_path`** is a stored filesystem path with no upload profile behind it. The schema
 *     refuses it specifically so it does not become Known Issue 26's sixth caller-supplied path, and
 *     this form is where that refusal would otherwise have been undone by a helpful-looking text box.
 *
 * ## No school picker
 *
 * `school_id` is the one optional field the schema accepts that this form does not offer, for the
 * reason `school/subjects/new` argues: `resolveSchool()` takes the school from `req.tenant` for a
 * caller who has one and refuses a different id with `CROSS_SCHOOL_ACCESS`, so a librarian, principal
 * or school admin has exactly one possible answer.
 *
 * The cost of leaving it out is a real 422 that names a field with no input: a platform caller with
 * no school in scope hits *"school_id is required when the caller has no school in scope"*, whose
 * only detail is keyed `school_id`. `CONTROLLED` catches that and promotes the response's own message
 * into the banner, which also covers the two other unplaceable shapes this endpoint produces — the
 * foreign-key rethrow, keyed `body`, and the model's `availableWithinQuantity` validator, keyed by
 * the validator's own name.
 *
 * ## What the API is left to refuse
 *
 * The router carries `requireModule(MODULES.LIBRARY)`, so a school whose plan does not include the
 * Library module is refused with `MODULE_NOT_SUBSCRIBED` — already in `EXPLAINED_CODES`, so it lands
 * as a refusal with its upgrade wording rather than as a red error. Pre-checking it here would mean
 * this screen holding an opinion about an entitlement it cannot see. There is no `enforceLimit()` on
 * the route: §11.2's eight limits contain nothing library-shaped, and a book is not a headcount.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import {
  CheckboxField,
  Field,
  Notice,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
  FormActions,
  FormSection,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/**
 * `moneyField`'s ceiling — `Joi.number().max(9999999999.99)` in `library.validation.js`, which is
 * **narrower** than the `DECIMAL(14,2)` column behind it (`models/columns.js` `money()`).
 *
 * The API's bound, not the column's, is the one that matters here: raising this to the column width
 * would let the browser accept a figure the schema then refuses with a 422. (This comment used to
 * call the column `DECIMAL(12,2)`, copying the same slip from the schema's own comment.)
 *
 * Written out rather than left implicit because the two money inputs below want it as their `max`,
 * and a literal repeated twice is a literal that gets edited once.
 */
const MONEY_MAX = 9999999999.99;

/** `quantity` is `INTEGER UNSIGNED`; the schema's `max` is the column's own ceiling. */
const QUANTITY_MAX = 4294967295;

/**
 * The fields this form actually renders an input for.
 *
 * Used to decide whether a 422's detail has somewhere to go — see the header on `school_id`, the one
 * field the schema accepts and this screen deliberately does not show.
 */
const CONTROLLED = new Set([
  'title',
  'author',
  'category',
  'isbn',
  'publisher',
  'edition',
  'language',
  'rack_number',
  'description',
  'quantity',
  'price',
  'fine_per_day',
  'loan_days',
  'is_active',
  'reason',
]);

export default function NewBookPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [values, setValues] = useState({
    title: '',
    author: '',
    category: '',
    isbn: '',
    publisher: '',
    edition: '',
    language: '',
    rack_number: '',
    description: '',
    quantity: '',
    price: '',
    fine_per_day: '',
    loan_days: '',
    reason: '',
  });
  /* Held apart from `values`: a checkbox has no blank to omit, so it carries its column's default. */
  const [isActive, setIsActive] = useState(true);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /*
     * Only what was filled in. The descriptive strings are `.empty('')` server-side so a blank would
     * be coerced to `null` either way, but the numbers are not: `""` against `Joi.number()` fails as
     * *"must be a number"*, which is a complaint about a value nobody typed.
     *
     * The numbers are posted as the strings that were typed rather than run through `Number()`, for
     * the reason `super-admin/subscriptions/new` gives: `validate()` runs Joi with `convert: true`,
     * and coercing here would turn anything unparseable into `NaN`, which `JSON.stringify` writes as
     * `null`. A truthiness test is safe for them because `"0"` is a non-empty string — and `0` is a
     * real answer for both `quantity` (a title on order) and `fine_per_day` (a book that is never
     * fined), not a stand-in for "unset".
     */
    const body: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(values)) {
      const value = raw.trim();
      if (value) body[key] = value;
    }

    /* The column defaults to `true`, so an untouched box and an absent key produce the same row. */
    if (!isActive) body.is_active = false;

    try {
      await api.post('/library/books', body);
      /*
       * `replace`, not `push`: Back would otherwise re-open an empty form for a book that exists.
       * No `?tab=` is needed — `useActiveTab` falls back to the first tab, and on the Library screen
       * that is the catalogue this book just joined.
       */
      success('Book added', 'It can now be issued.');
      router.replace('/school/library');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        const perField: Record<string, string> = {};
        let unplaceable = false;

        for (const [field, message] of Object.entries(caught.fieldErrors())) {
          if (CONTROLLED.has(field)) perField[field] = message;
          else unplaceable = true;
        }

        setFieldErrors(perField);
        focusFirstInvalidField();
        /* See the header: a detail keyed `school_id`, `body`, or a model validator's name. */
        /* Whole-object rules have no field at all; `formErrors()` is where they arrive. */
        const formLevel = caught.formErrors();
        setError(
          formLevel.length
            ? formLevel.join(' ')
            : unplaceable || !Object.keys(perField).length
              ? caught.message
              : null
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      setSaving(false);
    }
  }

  /*
   * Gated exactly as the catalogue tab's "Add book" button is.
   *
   * `library.manage` is FR-LIB-001's permission — *"Librarian creates/manages Book records"* — and it
   * is a different key from the `library.issue` that FR-LIB-002's routes require and from the
   * `library.view` that opened the list. A librarian holds all three; a student holds only the last,
   * and reaches this screen's refusal rather than an empty form.
   */
  if (!can('library.manage')) {
    return (
      <div>
        <PageHeader title="New book" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to add a book to the catalogue.',
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New book"
        description="Only the title is required. Everything else falls back to the catalogue's own defaults — one copy, no fine, a fourteen-day loan."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The book"
          description="Bibliographic details. Only a title is required — the rest can be filled in from the copy in hand."
        >
          <Field
            id="title"
            width="md"
            label="Title"
            required
            maxLength={255}
            value={values.title}
            onChange={set('title')}
            error={fieldErrors.title}
            /*
             * No uniqueness is claimed, and that is deliberate rather than an omission. `books` carries
             * no unique index and the service's header says it does not want one: a school may hold two
             * catalogue entries for the same title — a second edition, or a donated copy tracked apart.
             */
            hint="Up to 255 characters. Two entries may share a title; they are separate catalogue records."
          />

          <Field
            id="author"
            width="md"
            label="Author"
            maxLength={255}
            value={values.author}
            onChange={set('author')}
            error={fieldErrors.author}
            hint="SRS §20.4's Author, stored on the book rather than in an authors table. Free text, so keep the spelling consistent — the catalogue can be filtered by an exact author."
          />

          <Field
            id="category"
            width="sm"
            label="Category"
            maxLength={120}
            value={values.category}
            onChange={set('category')}
            error={fieldErrors.category}
            hint="Up to 120 characters. Also an exact-match filter on the catalogue, so an existing spelling is worth reusing."
          />

          <Field
            id="isbn"
            label="ISBN"
            maxLength={40}
            value={values.isbn}
            onChange={set('isbn')}
            error={fieldErrors.isbn}
            /*
             * No check-digit rule and no 10-or-13 length rule: the schema is a trimmed string to 40, and
             * refusing here what the API accepts would block the shelf-mark-style codes a school library
             * legitimately keeps in this column for anything without a real ISBN.
             */
            hint="Up to 40 characters, and searched alongside the title and author. Not validated as a real ISBN, so an internal accession number is fine."
          />

          <Field
            id="publisher"
            width="md"
            label="Publisher"
            maxLength={180}
            value={values.publisher}
            onChange={set('publisher')}
            error={fieldErrors.publisher}
          />

          <Field
            id="edition"
            width="xs"
            label="Edition"
            maxLength={60}
            value={values.edition}
            onChange={set('edition')}
            error={fieldErrors.edition}
            hint="Up to 60 characters, e.g. 3rd edition."
          />

          <Field
            id="language"
            label="Language"
            maxLength={60}
            value={values.language}
            onChange={set('language')}
            error={fieldErrors.language}
            /* A free string, not a locale code: nothing in §20.4 or the column constrains it. */
            hint="Up to 60 characters. A plain name — the column is free text, not a language code."
          />

          <Field
            id="rack_number"
            width="xs"
            label="Rack number"
            maxLength={60}
            value={values.rack_number}
            onChange={set('rack_number')}
            error={fieldErrors.rack_number}
            hint="Up to 60 characters. Where the copies physically sit; it is on the catalogue list because it is what someone fetching the book actually needs."
          />

          <TextAreaField
            id="description"
            label="Description"
            rows={3}
            maxLength={5000}
            value={values.description}
            onChange={set('description')}
            error={fieldErrors.description}
            hint="Up to 5000 characters, and the only long-form column on the row — so a note about the copies themselves, their condition or where they came from, has room to go here."
          />
        </FormSection>

        <FormSection
          title="Copies and lending"
          description="How many the library holds, what a copy is worth, and the terms it goes out on."
        >
          <Field
            id="quantity"
            label="Quantity"
            type="number"
            min={0}
            max={QUANTITY_MAX}
            step={1}
            value={values.quantity}
            onChange={set('quantity')}
            error={fieldErrors.quantity}
            /*
             * `min(0)`, not `min(1)`, and the schema says why: *"A catalogue entry for zero copies is
             * legitimate — a title on order."* Blank is a different answer again — the column's own
             * default of 1 — which is why the number is only sent when something was typed.
             */
            hint="How many copies the library holds. Blank means one. Zero is allowed, for a title on order. Availability is derived from this and the copies on loan, and is not set here."
          />

          <Field
            id="price"
            label="Price"
            type="number"
            min={0}
            max={MONEY_MAX}
            step={0.01}
            value={values.price}
            onChange={set('price')}
            error={fieldErrors.price}
            /*
             * Recorded, never charged. `returnLoan()` marks a copy `lost` without pricing it, because
             * §20.4 says nothing about billing a lost book — so this is a valuation for the library's
             * own records and inventing a "lost book charge" from it would be inventing a requirement.
             */
            hint="Per copy, to two decimal places. Kept for the library's own records — a lost copy is recorded as lost, not billed at this price."
          />

          <Field
            id="fine_per_day"
            label="Fine per day"
            type="number"
            min={0}
            max={MONEY_MAX}
            step={0.01}
            value={values.fine_per_day}
            onChange={set('fine_per_day')}
            error={fieldErrors.fine_per_day}
            /*
             * The book's rate, read at return time rather than copied onto the loan: FR-LIB-002's
             * *"System calculates/records a Fine"* multiplies this by the whole days past the due date.
             * Editing it later therefore changes what an already-open loan will be fined, which is a
             * property of the module worth knowing at the moment the number is first set.
             */
            hint="Blank means no fine. The fine on a late return is this times the whole days overdue, taken from the book at the moment the book comes back."
          />

          <Field
            id="loan_days"
            label="Loan days"
            type="number"
            min={1}
            max={3650}
            step={1}
            value={values.loan_days}
            onChange={set('loan_days')}
            error={fieldErrors.loan_days}
            /*
             * `min(1)`, and the schema states the reason outright: *"Zero would make every loan overdue
             * on the day it was issued."* A librarian may still name an explicit due date per loan.
             */
            hint="How long a copy may be kept. Blank means fourteen days. At least one — a zero-day loan would be overdue the day it was issued."
          />

          {/*
            `CheckboxField` carries the explanation as a `hint` wired up by `aria-describedby` instead
            of nesting it inside the label, where it was read out as part of the box's own name.
          */}
          <div className="pt-1">
            <CheckboxField
              id="is_active"
              label="Active"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              hint="There is no delete for a book — retiring one is this flag going off, which also stops it being issued while its loan history stays intact. Leave it on unless the entry is being made ahead of the copies arriving."
            />
            {/*
              Still a hand-rolled paragraph, unlike every other message on this form: `CheckboxField`
              takes a `hint` but no `error`, so there is nothing to hand this to. It is near-unreachable
              — the box can only ever send `false`, which is what `Joi.boolean()` asks for — so the
              markup is kept rather than dropped, but the fix belongs in the component, not here.
            */}
            {fieldErrors.is_active ? (
              <p className="mt-1 text-sm text-danger">{fieldErrors.is_active}</p>
            ) : null}
          </div>
        </FormSection>

        <FormSection
          title="Internal notes"
          description="Kept on the audit entry for this book."
        >
          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            /*
             * In the create schema and actually read, but not a `books` column: `createBook()` passes it
             * to `recordAudit()` as the reason on this book's audit row. It never appears on the
             * catalogue, so this is the only chance to record why the entry was added.
             */
            hint="Up to 255 characters, kept on the audit entry for this book rather than on the book itself. Optional."
          />
        </FormSection>

        <FormActions cancelHref="/school/library">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Add book
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
