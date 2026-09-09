# Verification record

**Project:** Multi-School Management System (multi-tenant SaaS)
**Source of truth:** `SRS_Multi-School-Management-System.docx` — 36 sections, 1,698 lines as extracted
**Recorded:** 2026-09-09
**This document is checklist row 7.13's output.** It could not be written earlier: the row asks for
the SRS to be re-read and every requirement verified, and this is the record of that having happened.

---

## What this document is, and what it is not

It is a statement of **what was checked, how, and what the check measured** — not a summary of
intent. Every figure below was produced by running something on the date recorded, and where a claim
could not be verified it is written down as unverified rather than omitted.

It is **not** a certificate. Three things in this system have never been executed and are named as
such in §5; a fourth is a body of frontend work that no queue in this repository had sized until it
was measured for this document, and it is the largest single item outstanding.

---

## 1. The re-read

Nine read-only agents took §1–§37 a slice at a time, checking **367 requirements** against the code
*and* against `docs/IMPLEMENTATION_CHECKLIST.md`'s own claims — because a checklist that has drifted
is indistinguishable from a requirement that is met.

| | |
|---|---|
| Requirements read | **367** |
| Verified clean | 173 |
| Findings raised | **70** |
| High severity | 4, all resolved |

The four high-severity findings are worth naming, because each was a requirement recorded as
Completed that the product did not meet:

1. **FR-FEE-002** — the fee ledger showed neither payments made nor the pending balance; the column
   labelled "Owed" was bound to `net_amount`, which is what the student was *charged*.
2. **FR-FIN-002** — Net Balance was computed by the backend (`finance.service.js`) and displayed
   nowhere; `net_balance` did not appear anywhere in `frontend/src`. It had been deferred to a school
   Reports screen that §33 does not list, so the deferral pointed nowhere.
3. **FR-NOTIF-001** — four of the nine notification types stopped permanently past 500 rows, because
   the LIMIT was spent on rows that had already been notified.
4. One that had already been fixed before it was reported.

A fifth finding claimed the §2 assertion table summed to 5,060. It sums to 5,133. **A finding is a
claim**, and that one was checked before it was acted on.

## 2. Triage

All 70 were triaged; the 61 that survived the high-severity pass were verified one at a time by eight
agents, each reading the SRS clause and the code it names.

| Verdict | Count | Meaning |
|---|---|---|
| `real-fixable` | 44 | **All applied.** |
| `real-blocked` | **13** | The defect is real; fixing it needs a decision the SRS does not supply. |
| `refused` | 5 | The finding was wrong about the requirement. |
| `already-fixed` | 1 | |

Two verdicts arrived as `real-fixable` and were **reclassified to `real-blocked` on inspection** —
student "Documents" (no document type and no permission exist for uploaded paperwork) and
admission-without-a-class (§15.1 and SRS:818 answer it two different ways). Both are recorded in
`docs/SRS-TRIAGE-VERDICTS.md` with the reasoning.

The pattern is consistent enough to state as a rule: **where the SRS lists a capability without
specifying it, a "fix" is a specification decision wearing implementation clothes.** Thirteen
findings sit there, and they are the honest end state for a source that names capabilities without
defining them — not a backlog.

## 3. What was measured, on 2026-09-09

| Check | Result |
|---|---|
| `npm test` (backend) | **5,512 assertions, 0 failures, 0 skips** — 38 suites, spawned serially, against live MariaDB. Six consecutive runs, exit 0 each time. |
| Recorded baseline | 5,312 assertions across 38 suites (`tests/baseline.json`) |
| `scripts/verify-frontend.js` | 170 assertions, **43 deliberate regressions all caught** |
| `npm run lint` (backend) | exit 0 |
| `npm run lint` (frontend) | **fails — see §5** |
| `tsc --noEmit` (frontend) | exit 0 |
| `next build` | clean |
| Schema | **65 tables** — §29's 64 plus `sequelize_meta`, the migration ledger |
| Permission catalogue | **109 permissions, 11 roles** |
| Git | initialised 2026-09-09; 397 files in the first commit; no `.env` in history |

**On the assertion counts differing:** 5,512 is what `npm test` reports as jest cases; 5,312 is the
recorded per-suite assertion baseline. They measure different things and `tests/verify.test.js`
asserts the second exactly — not "at least", because a suite that grows and later shrinks back would
slip through a floor.

**Why the baseline exists at all:** nineteen of the 38 suites answer an unreachable database by
skipping their HTTP half, printing "All pure … checks passed" and exiting **0**. Measured against a
database that does not exist: **3,143 of 5,112 assertions vanished and 19 suites stayed green.** The
baseline is the missing knowledge (Known Issue 28).

## 4. Coverage of the SRS, by section

Every section of §1–§37 has implementing code and at least one executable check. The per-requirement
status is `docs/IMPLEMENTATION_CHECKLIST.md`; this document records only where that status is **not**
`Completed`:

| Row | Status | What is outstanding |
|---|---|---|
| 5.2 | In Progress | The Anthropic adapter is exercised with the SDK replaced in `require.cache`, so prompt construction, `textOf()` and `parseJson()` all run and only the HTTP hop is substituted. **The live round trip has never happened** — it needs an API key this environment does not have. |
| 7.13 | In Progress | This document. Cannot close while 5.2 is open, and 13 findings remain `real-blocked`. |
| FR-SCHOOL-002 | Tested | Academic session create / activate / close are implemented and verified, and **no screen reaches them** — see §5. |
| FR-SCHOOL-003 | Tested | Classes and Sections can be created from the UI and not edited or deleted — see §5. |
| FR-SUB-008 | Tested | Six of the eight plan limits are enforced. `admin_limit` is counted and never blocks; `api_limit` is neither counted nor blocked, because §11.2 names "API Limit" without saying what it measures. |

## 5. What has never been executed, and one thing that was never sized

These are the honest gaps. Each is stated with what it would take.

**The Anthropic round trip.** Row 5.2. Needs a key.

**A real SMTP delivery.** `services/mailService.js` carries both a `log` and an `smtp` driver;
`.env` sets `MAIL_DRIVER=log`. The suites assert the delivery *records* — an `email` row born
`pending` and becoming `sent` or `failed` — not that a message left the machine.

**Frontend linting.** `npm run lint` in `frontend/` fails outright: Next.js 16 **removed the
`next lint` command** and `next build` no longer lints
(`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md:1084`), there is no
`eslint.config.*`, and the script still points at `next lint`. The frontend has therefore had **no
lint coverage since the Next 16 upgrade**, and earlier entries in the progress log recording
`npm run lint` exit 0 were true before it and are stale now. The backend is unaffected
(`.eslintrc.json`, exit 0).

**Ninety-nine write routes with no caller in the UI.** This is the largest item in this document and
no queue in the repository had sized it before now.

Measured by walking every `backend/src/modules/*/*.routes.js` and matching each mounted verb against
every `api.*` call in `frontend/src`, treating an interpolated `${…}` segment as a wildcard so the
count errs toward *reachable*:

> **142 write routes are mounted. 43 have a frontend caller. 99 do not.**

Spot-checked rather than trusted: the **Attendance** screen contains no form and no write call of any
kind, so §16's attendance cannot be marked from the product. **Platform Settings** cannot be saved.
`/plans` has nine write routes and one caller, so the Features, Limits and Modules sub-screens are
read-only.

Largest clusters: subscriptions 14, plans 9, exams 7, AI 6, students 5, taxes 5, quotations 5,
classes and sections 4, academic sessions 4, invoices 4, assignments 4.

Not all 99 are defects. `POST /coupons/validate` is a checkout-time call and there is no checkout
screen; several §9 platform lifecycle routes belong to screens §33 does not list. But most are
capabilities the API offers and the product does not, and they divide into two kinds that should not
be conflated:

* **No screen exists, and §33 does not name one.** Academic sessions are the clear case: four write
  routes, no screen, and §33's School list — seventeen entries, checked — does not include one, while
  FR-SCHOOL-002 requires the operations. *Where they belong is a specification question.*
* **The screen exists and simply has no control.** Classes and Sections edit/delete are the clear
  case: §33 names both, both exist, and neither has a row action. *No decision required.*

**How this was missed until now.** `docs/UI-AUDIT-FINDINGS.md` filed nine findings about unreachable
endpoints and all nine are closed. But that register was built by auditing **screens that exist** and
looking for defects in them — so a capability with no screen at all, and a screen whose missing row
action nobody had audited, produced no finding to close. A summary written earlier on 2026-09-09
concluded from those nine closures that there was "no remaining case of an endpoint the product
cannot reach". That was false, and the correction is recorded in `IMPLEMENTATION_PROGRESS.md`
part 43 alongside the measurement above.

## 6. Known issues still open

`IMPLEMENTATION_PROGRESS.md` §5 is the register. Eleven of 31 rows are open; these are the ones with
consequences:

| # | Issue | Note |
|---|---|---|
| 17 | A school sees add-on prices restricted to plans it is not on | Small. `detailInclude()` has two callers, both in its own file; the register's stated reason for deferring it is wrong. |
| 21 | A limit check and the write it guards are not atomic | Real. Two concurrent admissions can both pass at `used = limit − 1`. |
| 18 | An unpriced add-on purchase records at zero | **Must not be "fixed"** — the SRS names no default `addon_prices` row. |
| 19 | `wallet_balance` is never debited or credited | **Must not be "fixed"** — §13.2 lists "Wallet" among five payment methods and says nothing else. |
| 2 | MySQL (XAMPP) does not survive this environment reliably | Environmental. The Aria recovery procedure is in the register, including the correction that logs must be quarantined *outside* the data directory. |
| 11 | `SUPER_ADMIN_PASSWORD` in `backend/.env` is still the example value | The seeder hard-refuses it under `NODE_ENV=production`. |
| 25 | The `verify-*.js` suites are not safe to run concurrently | Procedural, and it bit during this session: overlapping runs produced two failures in a suite that passed twelve times alone. The harness holds `tests/.suite-run.lock` and says so. |
| 31 | Fabricated SRS quotations, and the class is not cleanly assertable | 207 backticked quotations sit next to an SRS reference and 45 are not verbatim in the source — almost all legitimately, because the same convention quotes model comments and MySQL error strings. A check failing on 45 correct lines is worse than no check. |

## 7. What would close row 7.13

1. A live Anthropic API key, to close 5.2.
2. A decision on the 13 `real-blocked` findings — each needs a requirement the SRS does not state.
   They are listed with their reasoning in `docs/SRS-TRIAGE-VERDICTS.md`.

Neither is engineering work. Both are decisions or credentials, and this document exists so that the
distinction is on the record rather than inferred.
