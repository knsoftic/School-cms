'use client';

/**
 * One student — SRS §15.1, FR-STUDENT-001, and the two routes with no caller.
 *
 * ## Why this screen exists
 *
 * `PATCH /students/:id` and `POST /students/:id/photo` were both unreachable. A student could be
 * admitted and then never corrected: a mistyped name, a missing date of birth, a guardian's phone
 * number that had changed, all permanent. FR-STUDENT-001 names editing the profile, and the create
 * form's own hints tell the operator that placement and guardian details "can be filled in later" —
 * later was nowhere.
 *
 * ## What this form deliberately cannot do
 *
 * **The lifecycle.** `status`, `promoted_at`, `previous_class_id`, `transferred_at`, `transfer_to`,
 * `left_at` and `leaving_reason` are all `forbiddenField()` on the update schema, each with its own
 * message saying which operation stamps it. They belong to promote / transfer / leave, which are row
 * actions on the list. Rendering a status select here would be offering a control whose only
 * possible outcome is a 422.
 *
 * **The photo, from this form.** `photo_path` is `Joi.any().forbidden()` with the message
 * *"written from an uploaded file — POST /students/:id/photo, never a request body"*. So the photo
 * is a separate panel and a separate request, which is also why it is not inside the `<form>`.
 *
 * ## The photo can now be looked at — Known Issues #32
 *
 * This block used to say the opposite, and it was true when it was written: `present()` deletes
 * `photo_path` and returns `has_photo` in its place, `sendStoredFile` had exactly three callers —
 * assignments, homework and payments — and students was not one, so an upload stored a file that no
 * screen could display. The panel carried a notice saying so rather than implying a viewer.
 *
 * `GET /students/:id/photo` now serves the bytes, so the notice is gone and the image is here. It
 * arrives as a **blob URL through the authenticated client**, not as an `<img src>` pointing at the
 * route: the route is behind `students.view` and the token only ever travels in an `Authorization`
 * header, which a browser fetching an `<img>` does not send. The long note on the `stored` state has
 * the rest of it.
 */

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { splitApiErrors } from '@/lib/formErrors';
import { useClassSections, OPTION_LIMIT } from '@/lib/useTimetablePickers';
import {
  Field,
  FileField,
  FormActions,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { Icon } from '@/components/icon';
import { useToast } from '@/components/toast';
import {
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

/**
 * `GENDERS` in `config/constants.js`.
 *
 * The **column** is nullable, so a student can have no gender recorded — but the update schema is
 * a bare `Joi.string().valid(...)` with no `.allow(null)`, so this form can set one and cannot
 * clear it. Blank therefore means "leave it as it is" here, not "set it to nothing".
 */
const GENDERS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
];

/** Every field this form renders. Anything else a 422 names goes to the banner. */
const FORM_FIELDS = new Set([
  'student_id',
  'first_name',
  'last_name',
  'admission_date',
  'admission_number',
  'admission_session_id',
  'class_id',
  'section_id',
  'academic_session_id',
  'roll_number',
  'gender',
  'date_of_birth',
  'blood_group',
  'religion',
  'nationality',
  'email',
  'phone',
  'address',
  'city',
  'guardian_name',
  'guardian_phone',
  'guardian_relation',
  'emergency_contact',
  'uses_transport',
  'notes',
  'metadata',
  'reason',
]);

/** One student, as `students.service.present()` leaves it — `photo_path` removed, `has_photo` added. */
interface Student {
  id: number;
  student_id: string;
  first_name: string;
  last_name: string | null;
  admission_date: string;
  admission_number: string | null;
  admission_session_id: number | null;
  class_id: number | null;
  section_id: number | null;
  academic_session_id: number | null;
  roll_number: string | null;
  gender: string | null;
  date_of_birth: string | null;
  blood_group: string | null;
  religion: string | null;
  nationality: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  guardian_relation: string | null;
  emergency_contact: string | null;
  uses_transport: boolean | null;
  notes: string | null;
  status: string;
  has_photo: boolean;
}

interface SessionOption {
  id: number;
  name: string;
  is_current: boolean;
}

/** `''` for a null column, so an untouched control does not post a value it never had. */
const text = (value: string | null | undefined) => value ?? '';
const num = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));

export default function StudentDetailPage() {
  const params = useParams<{ id: string }>();
  const { can } = useAuth();
  const { success, error: errorToast } = useToast();

  const studentId = params.id;
  const canManage = can('students.manage');

  const [student, setStudent] = useState<Student | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const [values, setValues] = useState({
    student_id: '',
    first_name: '',
    last_name: '',
    admission_date: '',
    admission_number: '',
    admission_session_id: '',
    class_id: '',
    section_id: '',
    academic_session_id: '',
    roll_number: '',
    gender: '',
    date_of_birth: '',
    blood_group: '',
    religion: '',
    nationality: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    guardian_name: '',
    guardian_phone: '',
    guardian_relation: '',
    emergency_contact: '',
    uses_transport: '',
    notes: '',
    reason: '',
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const { classes, sections } = useClassSections(values.class_id, canManage);
  const [sessions, setSessions] = useState<SessionOption[]>([]);

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    (async () => {
      try {
        const page = await api.page<SessionOption[]>('/sessions', {
          query: { limit: OPTION_LIMIT },
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setSessions(page.data);
      } catch {
        /* The two session selects stay at what the record holds; `sessions.view` is its own grant. */
      }
    })();
    return () => controller.abort();
  }, [canManage]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setRefusal(null);

    (async () => {
      try {
        const body = await api.get<{ student: Student }>(`/students/${studentId}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const row = body.student;
        setStudent(row);
        setValues({
          student_id: row.student_id,
          first_name: row.first_name,
          last_name: text(row.last_name),
          admission_date: row.admission_date.slice(0, 10),
          admission_number: text(row.admission_number),
          admission_session_id: num(row.admission_session_id),
          class_id: num(row.class_id),
          section_id: num(row.section_id),
          academic_session_id: num(row.academic_session_id),
          roll_number: text(row.roll_number),
          gender: text(row.gender),
          date_of_birth: row.date_of_birth ? row.date_of_birth.slice(0, 10) : '',
          blood_group: text(row.blood_group),
          religion: text(row.religion),
          nationality: text(row.nationality),
          email: text(row.email),
          phone: text(row.phone),
          address: text(row.address),
          city: text(row.city),
          guardian_name: text(row.guardian_name),
          guardian_phone: text(row.guardian_phone),
          guardian_relation: text(row.guardian_relation),
          emergency_contact: text(row.emergency_contact),
          /* A tri-state select: '' is "not recorded", which the column allows. */
          uses_transport: row.uses_transport === null ? '' : row.uses_transport ? 'true' : 'false',
          notes: text(row.notes),
          reason: '',
        });
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          setLoadError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setLoadError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [studentId, attempt]);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  /** `''` → `null` for a nullable column: clearing a field means clearing the value. */
  const orNull = (value: string) => (value.trim() ? value.trim() : null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      /*
       * The whole editable set, not a diff. `.min(1)` would accept a diff, but computing one means
       * deciding whether a cleared field is "set to null" or "unchanged" — and getting that wrong
       * silently drops an edit. Nothing lifecycle-owned is sent: every one of those is
       * `forbiddenField()` and would be a 422 naming a control this form does not have.
       */
      const body = await api.patch<{ student: Student }>(`/students/${studentId}`, {
        student_id: values.student_id.trim(),
        first_name: values.first_name.trim(),
        last_name: orNull(values.last_name),
        admission_date: values.admission_date,
        admission_number: orNull(values.admission_number),
        admission_session_id: values.admission_session_id ? Number(values.admission_session_id) : null,
        class_id: values.class_id ? Number(values.class_id) : null,
        section_id: values.section_id ? Number(values.section_id) : null,
        academic_session_id: values.academic_session_id ? Number(values.academic_session_id) : null,
        roll_number: orNull(values.roll_number),
        /*
         * Omitted when blank, not sent as null — and the two behave differently for a reason worth
         * recording. Every other optional column here is `.empty('').allow(null)`, so clearing it
         * sends `null` and the value is cleared. `gender` is a bare
         * `Joi.string().valid(...GENDERS)` and `uses_transport` a bare `Joi.boolean()`: **neither
         * accepts null**, so sending one is a 422 — which is exactly what happened the first time
         * this form was driven, on a student whose gender was never recorded.
         *
         * The consequence is a real limitation rather than a bug in this screen: once either is set
         * it can be changed but not returned to "not recorded", because the schema has no value for
         * that. The hints say so.
         */
        ...(values.gender ? { gender: values.gender } : {}),
        date_of_birth: values.date_of_birth || null,
        blood_group: orNull(values.blood_group),
        religion: orNull(values.religion),
        nationality: orNull(values.nationality),
        email: orNull(values.email),
        phone: orNull(values.phone),
        address: orNull(values.address),
        city: orNull(values.city),
        guardian_name: orNull(values.guardian_name),
        guardian_phone: orNull(values.guardian_phone),
        guardian_relation: orNull(values.guardian_relation),
        emergency_contact: orNull(values.emergency_contact),
        ...(values.uses_transport === ''
          ? {}
          : { uses_transport: values.uses_transport === 'true' }),
        notes: orNull(values.notes),
        reason: values.reason.trim() || undefined,
      });

      setStudent(body.student);
      setValues((prev) => ({ ...prev, reason: '' }));
      success('Student updated');
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      if (EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
        return;
      }
      const { perField, banner } = splitApiErrors(caught, FORM_FIELDS);
      setFieldErrors(perField);
      setError(banner);
      if (Object.keys(perField).length) focusFirstInvalidField();
    } finally {
      setSaving(false);
    }
  }

  /* ── the photo, which is its own request ── */

  const [photo, setPhoto] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  /**
   * The stored photo, as an object URL — Known Issues #32, now that `GET /students/:id/photo` exists.
   *
   * ## Why it cannot be an `<img src>` pointing at the route
   *
   * The route is behind `requirePermission('students.view')`, and `middlewares/authenticate.js`
   * reads the bearer token from `Authorization` and nowhere else — there is no cookie fallback. A
   * browser fetching an `<img>` sends no such header, so the request would be a 401 and the panel
   * would show a broken image. The bytes have to come through the authenticated client and reach the
   * `<img>` as a blob URL. This is the shape `super-admin/payments` established for FR-BILL-004's
   * screenshot, and the reasoning is identical.
   *
   * Four states rather than a nullable string, for the same reason that screen has four: "not asked
   * for", "fetching", "here it is" and "it would not load" are different things to show, and an empty
   * frame that might still be loading is the one answer that makes someone guess.
   */
  const [stored, setStored] = useState<
    { state: 'idle' } | { state: 'loading' } | { state: 'ready'; url: string } | { state: 'failed' }
  >({ state: 'idle' });

  /*
   * Fetch when the record says there is one, and revoke on the way out.
   *
   * `student?.has_photo` is in the dependency list on purpose: after an upload `setStudent` replaces
   * the record, so a first photo flips the flag and this re-runs. A *replacement* does not change the
   * flag, so `photoVersion` is bumped by the uploader to force the refetch — without it, storing a new
   * image would leave the old one on screen and the panel would be lying about what is on file.
   *
   * `cancelled` guards the late resolve: React 19 Strict Mode runs this mount → unmount → mount, so
   * the first fetch lands after its own teardown.
   */
  const [photoVersion, setPhotoVersion] = useState(0);
  useEffect(() => {
    if (!student?.has_photo) {
      setStored({ state: 'idle' });
      return;
    }

    let cancelled = false;
    let url: string | null = null;
    setStored({ state: 'loading' });

    (async () => {
      try {
        const file = await api.download(`/students/${studentId}/photo`);
        if (cancelled) return;
        url = URL.createObjectURL(file.blob);
        setStored({ state: 'ready', url });
      } catch {
        if (!cancelled) setStored({ state: 'failed' });
      }
    })();

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [studentId, student?.has_photo, photoVersion]);

  async function uploadPhoto() {
    if (!photo) return;
    setUploading(true);
    setPhotoError(null);

    try {
      /*
       * Multipart, and the field name is `photo` because that is what
       * `uploadSingle(UPLOAD_PROFILES.PERSON_PHOTO, 'photo')` listens on. A file sent under any
       * other name is not `req.file`, and the request would be accepted with nothing stored.
       */
      const form = new FormData();
      form.append('photo', photo);
      const body = await api.post<{ student: Student }>(`/students/${studentId}/photo`, undefined, {
        formData: form,
      });
      setStudent(body.student);
      setPhoto(null);
      /* A replacement leaves `has_photo` true, so nothing above it would refetch. See the effect. */
      setPhotoVersion((n) => n + 1);
      success('Photo stored on the record');
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      setPhotoError(caught.message);
      errorToast('Could not store that photo', caught.message);
    } finally {
      setUploading(false);
    }
  }

  if (!canManage) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Student" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'Editing a student needs the students.manage permission.',
          }}
        />
      </div>
    );
  }

  if (refusal) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Student" />
        <RefusalNotice refusal={refusal} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Student" />
        <ErrorNotice message={loadError} onRetry={reload} />
      </div>
    );
  }

  if (loading || !student) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Student" />
        <LoadingBlock />
      </div>
    );
  }

  const name = [student.first_name, student.last_name].filter(Boolean).join(' ');

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={name}
        description={`${student.student_id}. Admitted ${student.admission_date.slice(0, 10)}.`}
        action={
          <Link href="/school/students" className="btn btn-secondary">
            <Icon name="chevron-left" size={15} />
            All students
          </Link>
        }
      />

      {/*
        * The status is shown and not editable, and the two facts belong together: it is
        * `forbiddenField()` on this schema because promote / transfer / leave own it, and those are
        * row actions on the list. Saying so here is what stops a reader looking for the control.
        */}
      <p className="mb-6 flex flex-wrap items-center gap-2 text-sm text-muted">
        <StatusBadge status={student.status} />
        <span>
          Set by promotion, transfer or leaving — all three are actions on the students list, not
          fields on this form.
        </span>
      </p>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="space-y-8" noValidate>
        <FormSection
          title="Identity and admission"
          description="Who the student is, and the day they joined."
        >
          <Field
            id="first_name"
            label="First name"
            required
            maxLength={90}
            value={values.first_name}
            onChange={set('first_name')}
            error={fieldErrors.first_name}
          />
          <Field
            id="last_name"
            label="Last name"
            maxLength={90}
            value={values.last_name}
            onChange={set('last_name')}
            error={fieldErrors.last_name}
            hint="Optional — the column is nullable and the list joins the two names without leaving a gap."
          />
          <Field
            id="student_id"
            label="Student ID"
            maxLength={60}
            value={values.student_id}
            onChange={set('student_id')}
            error={fieldErrors.student_id}
            hint="Unique within the school. Changing it changes what every printed document says next time it is generated."
          />
          <Field
            id="admission_date"
            label="Admission date"
            type="date"
            required
            value={values.admission_date}
            onChange={set('admission_date')}
            error={fieldErrors.admission_date}
            hint="Its year is also the year in a generated student ID, so back-dating an admission back-dates the identifier."
          />
          <Field
            id="admission_number"
            label="Admission number"
            maxLength={60}
            value={values.admission_number}
            onChange={set('admission_number')}
            error={fieldErrors.admission_number}
            hint="A separate number from the student ID, and never generated."
          />
          <SelectField
            id="admission_session_id"
            label="Admission session"
            value={values.admission_session_id}
            onChange={set('admission_session_id')}
            error={fieldErrors.admission_session_id}
            hint="The intake cohort. Promotion never moves it, which is what separates it from the current session below."
          >
            <option value="">Not recorded</option>
            {sessions.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
                {row.is_current ? ' — current' : ''}
              </option>
            ))}
          </SelectField>
        </FormSection>

        <FormSection
          title="Class placement"
          description="Where the student sits in the timetable. A promotion moves this too — editing it here is for a correction rather than a progression."
        >
          <SelectField
            id="class_id"
            label="Class"
            value={values.class_id}
            onChange={(event) => {
              setValues((prev) => ({ ...prev, class_id: event.target.value, section_id: '' }));
            }}
            error={fieldErrors.class_id}
            disabled={classes.state === 'loading'}
          >
            <option value="">{classes.state === 'loading' ? 'Loading…' : 'Not placed'}</option>
            {classes.state === 'ready'
              ? classes.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                    {row.code ? ` (${row.code})` : ''}
                    {row.is_active ? '' : ' — inactive'}
                  </option>
                ))
              : null}
          </SelectField>
          <SelectField
            id="section_id"
            label="Section"
            value={values.section_id}
            onChange={set('section_id')}
            error={fieldErrors.section_id}
            disabled={!values.class_id || sections.state === 'loading'}
            hint="Sections of the chosen class only, and cleared whenever that class changes."
          >
            <option value="">No section</option>
            {sections.state === 'ready'
              ? sections.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                    {row.is_active ? '' : ' — inactive'}
                  </option>
                ))
              : null}
          </SelectField>
          <SelectField
            id="academic_session_id"
            label="Current session"
            value={values.academic_session_id}
            onChange={set('academic_session_id')}
            error={fieldErrors.academic_session_id}
          >
            <option value="">Not recorded</option>
            {sessions.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
                {row.is_current ? ' — current' : ''}
              </option>
            ))}
          </SelectField>
          <Field
            id="roll_number"
            label="Roll number"
            maxLength={40}
            value={values.roll_number}
            onChange={set('roll_number')}
            error={fieldErrors.roll_number}
          />
        </FormSection>

        <FormSection
          title="Personal details"
          description="Profile information held on the record. Every field here is optional."
        >
          <SelectField
            id="gender"
            label="Gender"
            value={values.gender}
            onChange={set('gender')}
            error={fieldErrors.gender}
            hint="Once set this cannot be returned to “not recorded” — the schema accepts the three values and nothing else."
          >
            {/* See the submit handler: once set, this cannot be returned to "not recorded". */}
            <option value="">Not recorded</option>
            {GENDERS.map((row) => (
              <option key={row.value} value={row.value}>
                {row.label}
              </option>
            ))}
          </SelectField>
          <Field
            id="date_of_birth"
            label="Date of birth"
            type="date"
            value={values.date_of_birth}
            onChange={set('date_of_birth')}
            error={fieldErrors.date_of_birth}
          />
          <Field
            id="blood_group"
            label="Blood group"
            maxLength={10}
            value={values.blood_group}
            onChange={set('blood_group')}
            error={fieldErrors.blood_group}
          />
          <Field
            id="religion"
            label="Religion"
            maxLength={60}
            value={values.religion}
            onChange={set('religion')}
            error={fieldErrors.religion}
          />
          <Field
            id="nationality"
            label="Nationality"
            maxLength={60}
            value={values.nationality}
            onChange={set('nationality')}
            error={fieldErrors.nationality}
          />
        </FormSection>

        <FormSection title="Contact" description="How the school reaches the student directly.">
          <Field
            id="email"
            label="Email"
            type="email"
            maxLength={180}
            value={values.email}
            onChange={set('email')}
            error={fieldErrors.email}
          />
          <Field
            id="phone"
            label="Phone"
            maxLength={40}
            value={values.phone}
            onChange={set('phone')}
            error={fieldErrors.phone}
          />
          <Field
            id="address"
            label="Address"
            maxLength={255}
            value={values.address}
            onChange={set('address')}
            error={fieldErrors.address}
          />
          <Field
            id="city"
            label="City"
            maxLength={90}
            value={values.city}
            onChange={set('city')}
            error={fieldErrors.city}
          />
        </FormSection>

        <FormSection
          title="Guardian and emergency contact"
          description="Who to call, and who to call when the guardian cannot be reached."
        >
          <Field
            id="guardian_name"
            label="Guardian name"
            maxLength={160}
            value={values.guardian_name}
            onChange={set('guardian_name')}
            error={fieldErrors.guardian_name}
          />
          <Field
            id="guardian_phone"
            label="Guardian phone"
            maxLength={40}
            value={values.guardian_phone}
            onChange={set('guardian_phone')}
            error={fieldErrors.guardian_phone}
          />
          <Field
            id="guardian_relation"
            label="Guardian relation"
            maxLength={60}
            value={values.guardian_relation}
            onChange={set('guardian_relation')}
            error={fieldErrors.guardian_relation}
          />
          <Field
            id="emergency_contact"
            label="Emergency contact"
            maxLength={40}
            value={values.emergency_contact}
            onChange={set('emergency_contact')}
            error={fieldErrors.emergency_contact}
          />
        </FormSection>

        <FormSection
          title="Services and notes"
          description="What the student is enrolled in, and anything the office needs on the record."
        >
          <SelectField
            id="uses_transport"
            label="School transport"
            value={values.uses_transport}
            onChange={set('uses_transport')}
            error={fieldErrors.uses_transport}
            hint="Blank is the column's own “not recorded”, which is a different fact from “no”. Once set it cannot be returned to blank — the schema has no value for it."
          >
            <option value="">Not recorded</option>
            <option value="true">Uses school transport</option>
            <option value="false">Does not use it</option>
          </SelectField>
          <TextAreaField
            id="notes"
            label="Notes"
            rows={3}
            maxLength={2000}
            value={values.notes}
            onChange={set('notes')}
            error={fieldErrors.notes}
            hint="Kept on the record and never shown to the student or their guardian."
          />
          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            hint="Recorded against this edit rather than on the student. Optional."
          />
        </FormSection>

        <FormActions cancelHref="/school/students" cancelLabel="Back to students">
          <SubmitButton busy={saving} busyLabel="Saving…" fullWidth={false}>
            Save changes
          </SubmitButton>
        </FormActions>
      </form>

      {/* ─────────────── the photo, outside the form ─────────────── */}

      <section aria-labelledby="photo-heading" className="mt-12 border-t border-border-soft pt-8">
        <div className="mb-4 max-w-2xl">
          <h2 id="photo-heading" className="text-base font-semibold tracking-tight text-ink">
            Photo
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {student.has_photo
              ? 'A photo is on file for this student.'
              : 'No photo is on file for this student.'}
          </p>
        </div>

        {/*
          * The viewer that closes Known Issues #32.
          *
          * This panel used to carry a notice saying the photo could be stored and not looked at,
          * which was true: `present()` removes `photo_path` and returned `has_photo` in its place,
          * and nothing served the bytes. `GET /students/:id/photo` now does, so the note is gone and
          * the image is here instead.
          *
          * `max-h` rather than a fixed box: a school's photos are whatever aspect ratio their camera
          * produced, and `object-contain` inside a bounded frame shows all of one without cropping a
          * face out of it.
          */}
        {stored.state === 'loading' && (
          <div
            className="h-40 w-32 animate-pulse rounded-md border border-border-soft bg-surface-sunken"
            role="status"
            aria-label="Loading the photo"
          />
        )}
        {stored.state === 'ready' && (
          /* eslint-disable-next-line @next/next/no-img-element -- a blob: URL, not an optimisable asset */
          <img
            src={stored.url}
            alt={`${student.first_name} ${student.last_name ?? ''}`.trim()}
            className="max-h-56 w-auto rounded-md border border-border-soft object-contain"
          />
        )}
        {stored.state === 'failed' && (
          <Notice tone="warn">
            The record says a photo is on file, but it could not be loaded. The stored file may be
            missing from disk.
          </Notice>
        )}

        <div className="mt-4 space-y-4">
          <FileField
            id="photo"
            label={student.has_photo ? 'Replace the photo' : 'Add a photo'}
            accept=".jpg,.jpeg,.png,.webp"
            file={photo}
            onChange={setPhoto}
            busy={uploading}
            error={photoError}
            hint="The size ceiling is your plan's file upload limit, so it is not checked here."
          />

          <button
            type="button"
            onClick={() => void uploadPhoto()}
            disabled={!photo || uploading}
            aria-busy={uploading}
            className="btn btn-primary"
          >
            {uploading ? 'Storing…' : 'Store photo'}
          </button>
        </div>
      </section>
    </div>
  );
}
