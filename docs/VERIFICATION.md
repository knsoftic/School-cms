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

It is **not** a certificate. **Two** things in this system have never been executed and are named as
such in §5 — it said three when it was first written, and the third, frontend linting, was fixed in
session 27. A fourth item was a body of frontend work that no queue in this repository had sized until
it was measured for this document; it was the largest single thing outstanding and **it is closed**,
at 149 of 150 write routes with a caller — **152 of 152** when re-measured at the end of session 28,
after the owner's decisions added two routes and both screens that call them.

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
| `real-blocked` | **13** → **11** → **0** | The defect is real; fixing it needs a decision the SRS does not supply. Two were closed in session 28 without any decision, because the tree had moved: findings 18 and 60 asked whether §33's screen list bounds the frontend surface, and session 27 had already answered it by building four screens beyond the seventeen. **The other eleven were answered by the project owner later in session 28** — decisions D1–D16 in `docs/OWNER-DECISIONS.md`, an addendum to the SRS — and each answer is built and asserted. |
| `refused` | 5 | The finding was wrong about the requirement. |
| `already-fixed` | 1 | |

Two verdicts arrived as `real-fixable` and were **reclassified to `real-blocked` on inspection** —
student "Documents" (no document type and no permission exist for uploaded paperwork) and
admission-without-a-class (§15.1 and SRS:818 answer it two different ways). Both are recorded in
`docs/SRS-TRIAGE-VERDICTS.md` with the reasoning.

The pattern is consistent enough to state as a rule: **where the SRS lists a capability without
specifying it, a "fix" is a specification decision wearing implementation clothes.** Eleven findings
sat there, and the honest end state for each was a question for someone entitled to answer it — not a
backlog. **Each first had the half of it that needed no decision done**: a consequence documented
beside the code that causes it, a silent discard turned into a refusal, or a gap recorded in the
checklist row it belongs to rather than only in the triage file. **Then the owner answered them**, and
the answers are in `docs/OWNER-DECISIONS.md` rather than in the code alone, so every behaviour built
on one can point at who decided it.

## 3. What was measured, on 2026-09-09, and again on 2026-09-10

**Re-measured at the end of session 28, and the loop re-run from cold on 2026-09-10** — after a session restart that killed a run mid-suite and took MariaDB down with it. That run's leftover fixture rows broke the next two runs until `verify-finance.js` was given a sweep for its own residue; see `IMPLEMENTATION_PROGRESS.md` §7, steps 409–411. **Measured a third time later that day**, after Known Issues #34 made every suite recover from being killed (steps 413–430): the `npm test`, baseline and kill-recovery rows are from that run; `verify-frontend.js`, both lints, `tsc`, `next build`, the schema and the catalogue were re-run with it and did not move; the write-route count was not re-run. **Measured a fourth time at the end of session 28**, after the
owner's decisions were built and the UI findings fixed (`IMPLEMENTATION_PROGRESS.md` steps 431–441):
every row below was re-run then, the write-route count included. The figures below are the latest
set; the earlier ones are kept beneath each where it differed, because a verification record that
quietly overwrites its own numbers is the thing it exists to prevent.

| Check | Result |
|---|---|
| `npm test` (backend) | **5,783 jest cases, 0 failures**, wrapping **40 suites / 5,573 assertions / 0 skips**, spawned serially against live MariaDB — twice, the second after the last change to `scripts/lib/residue.js`. *(5,705 / 5,495 after Known Issues #34; earlier on 2026-09-10 5,683 cases over 39 suites and 5,478 assertions, not updated when two later commits grew the loop; first recorded: 5,512 cases over 38 suites — see the correction below.)* |
| Recorded baseline | **5,573 assertions across 40 suites** (`tests/baseline.json`), re-recorded by `scripts/record-baseline.js`, which refuses a run with any failure. *(5,495 / 40 before the owner's decisions and the fixes after them; 5,478 / 39 when this row was first written on 2026-09-10; 5,484 after `verify-deploy.js` part 7 asserted the `.gitignore` patterns; 5,495 / 40 with `verify-quotations.js`. Each read from `git show <commit>:backend/tests/baseline.json`. Before that, 5,312 / 38.)* |
| Killed-run recovery | **39 of 40 suites SAFE** under `scripts/kill-test.js` — SIGKILLed partway (at 85% of their assertions, or 60% / 95% when that kill left nothing), rerun green, every non-log table back at its starting count. The fortieth, `verify-seed.js`, prints its assertions only at the end, so no kill lands inside it; its recovery was proved by planting the worst case. Re-measured after the last code change of session 28, in two parts (a session restart cut the full run off at 35 of 40). **That re-measurement first found two suites UNSAFE** — a dead run's platform notifications (owner decision D15) survived its rerun — and they were fixed before the figure above was taken. *(Before Known Issues #34: 11 of 40.)* |
| `scripts/verify-frontend.js` | **284 assertions**, 43 deliberate regressions all caught. *(Was 170.)* |
| Write routes with a frontend caller | **152 of 152** — the generated OpenAPI document against every `api.post/put/patch/delete` in `frontend/src`, template paths normalised; `POST /auth/refresh` counted through its raw `fetch`, as before. *(149 of 150 before D1 and D13 added two routes.)* — see §5 |
| `npm run lint` (backend) | exit 0 (`eslint src tests`). `scripts/`, outside that script, is **0 errors** too — it carried 46 until session 28 |
| `npm run lint` (frontend) | **exit 0** — it failed when this document was first written; `eslint.config.mjs` was added in session 27 |
| `tsc --noEmit` (frontend) | exit 0 |
| `next build` | clean, **83 routes** in the build's route list (73 static, 10 dynamic), counted from its output — 43 when the create screens were missing, 63 at the end of session 27, 82 recorded before the owner's decisions. *(The source holds 84 `page`/`not-found` files, three more than before D15's notification screens; a route list and a file count are different measures, and the earlier 82 was not re-derived here.)* |
| Schema | **65 tables** — §29's 64 plus `sequelize_meta`, the migration ledger |
| Permission catalogue | **109 permissions, 11 roles** |
| Git | initialised 2026-09-09; 397 files in the first commit; no `.env` in history |

**On the assertion counts differing:** the jest figure counts cases, the baseline counts suite
assertions, and jest adds five per suite plus the harness-integrity tests. They measure different
things and `tests/verify.test.js` asserts the second exactly — not "at least", because a suite that
grows and later shrinks back would slip through a floor.

**One figure in the first version of this table could not be reproduced and is corrected rather than
carried forward.** It recorded *"5,512 assertions ... six consecutive runs"* as the `npm test` result
and 5,312 as the baseline. 5,512 is not an assertion count from any baseline this repository has held:
the manifest of that moment summed to a different number, and the same 5,512 appeared in
`IMPLEMENTATION_CHECKLIST.md` where it likewise could not be derived. Where it came from is
**unknown** and is not guessed at here. What is recorded now is what a run today prints, which is the
standard the rest of this document is written to.

**Why the baseline exists at all:** nineteen of the then 38 suites **used to** answer an unreachable
database by skipping their HTTP half, printing "All pure … checks passed" and exiting **0**. Measured on
2026-09-05 against a database that does not exist: **3,143 of 5,112 assertions vanished and 19 suites
stayed green.** The baseline is the missing knowledge (Known Issue 28). **That defect is fixed at source**:
each of the nineteen now refuses to exit 0 on a degraded run, with `--allow-skip` for a deliberate
pure-checks run, and `npm test` would have caught it regardless through the exact per-suite count. The
paragraph is kept because it is the reason the baseline is exact rather than a floor.

## 4. Coverage of the SRS, by section

Every section of §1–§37 has implementing code and at least one executable check. The per-requirement
status is `docs/IMPLEMENTATION_CHECKLIST.md`; this document records only where that status is **not**
`Completed`:

| Row | Status | What is outstanding |
|---|---|---|
| 5.2 | In Progress | The Anthropic adapter is exercised with the SDK replaced in `require.cache`, so prompt construction, `textOf()` and `parseJson()` all run and only the HTTP hop is substituted. **The live round trip has never happened** — it needs an API key this environment does not have. |
| 7.13 | In Progress | This document. Cannot close while 5.2 is open, and **eleven** findings remain `real-blocked` — down from thirteen; findings 18 and 60 were closed in session 28 when the four screens beyond §33's seventeen were built and §33's list was ruled not to be a ceiling. |
| 3.S.1 | Will not be built | Demo seed data. Optional, and §35 forbids inventing the plans, classes and students it would contain. It sat at `Pending` until session 28 while its own note said the work must not be done. |
| FR-SUB-008 | In Progress | Six of the eight plan limits are enforced. `admin_limit` is counted and never blocks; `api_limit` is neither counted nor blocked, because §11.2 names "API Limit" without saying what it measures. *(Read `Tested` until session 28, which was wrong in the other direction — that status means unreachable, and `enforceLimit` has been mounted since session 16.)* |
| FR-STUDENT-001 | In Progress | Admission, profile, photo, class/section, student ID and roll number are all delivered and reachable. **§15.1's "Documents" half has no code path at all** — `UPLOAD_PROFILES.STUDENT_DOCUMENT` cites the FR in its own rule and has never had a caller, and giving it one needs a `document_type` and a permission the fixed catalogue does not contain (triage finding 16). |
| FR-BILL-001 | Implemented | All eleven §13.1 invoice fields are written and asserted — Add-ons included, each checked against the fixture rather than a literal. **The trigger is absent**: the requirement's actor is *System* and its precondition is *“a billing event occurs”*, a phrase that appears exactly once in the SRS and is never defined, so which events count, when to issue and what due date to set are decisions §35 forbids. A Super Admin issues invoices through `POST /invoices/generate` until then. |
| 5.3 | Implemented | PDF extraction is verified end to end against a real pdfkit document. The image branch sends the file to the provider as an image block, so it waits on 5.2's key. |

**Two rows left this table in session 28.** FR-SCHOOL-002 and FR-SCHOOL-003 are `Completed`:
`school/settings` reaches session create, activate and close — the nine endpoints finding 18 recorded
as having no caller — and the class and section screens cover FR-SCHOOL-003. Both were verified
against the tree, and `verify-frontend.js` asserts five of the nine by method and path.

## 5. What has never been executed, and one thing that was never sized

These are the honest gaps. Each is stated with what it would take.

**The Anthropic round trip.** Row 5.2. Needs a key.

**A real SMTP delivery.** `services/mailService.js` carries both a `log` and an `smtp` driver;
`.env` sets `MAIL_DRIVER=log`. The suites assert the delivery *records* — an `email` row born
`pending` and becoming `sent` or `failed` — not that a message left the machine.

**~~Frontend linting.~~ Fixed in session 27.** It read: *"`npm run lint` in `frontend/` fails
outright — Next.js 16 removed the `next lint` command, `next build` no longer lints, there is no
`eslint.config.*`, and the script still points at `next lint`."* All of that was true. `eslint.config.mjs`
now exists (flat config on `eslint-config-next/core-web-vitals`), the script is `eslint .`, seventeen
real findings were fixed, and `verify-deploy.js` asserts the config, the script string and a green run
the way it already asserted the backend's. **One rule is off and is not a suppression to forget**:
`react-hooks/set-state-in-effect`, whose 66 findings are two architectural patterns — a fetch effect
setting `loading` before awaiting, and a form re-seeding when its row changes. Turning it back on is the
acceptance test for whichever fetching architecture replaces the current one.

**Ninety-nine write routes with no caller in the UI.** This is the largest item in this document and
no queue in the repository had sized it before now.

Measured by walking every `backend/src/modules/*/*.routes.js` and matching each mounted verb against
every `api.*` call in `frontend/src`, treating an interpolated `${…}` segment as a wildcard so the
count errs toward *reachable*:

> **142 write routes are mounted. 43 have a frontend caller. 99 do not.**

**Closed in session 27.** Re-measured against the *generated OpenAPI document* — what the
application mounts, rather than what the route files declare — the figures were **150 / 61 / 89**
at the start of that session and are **150 / 149 / 1** at the end. The one route without a caller
is `POST /auth/refresh`, and it is a false positive: `apiClient.ts:302` reaches it with a raw
`fetch` because it *is* the refresh mechanism and cannot use the client that depends on it.

**Re-measured in session 28, and the measurement found two of its own blind spots.** The same script
reported **147** with a caller, not 149 — `POST /attendance/students` and `POST /attendance/teachers`
were reached by `api.post(teachers ? '/attendance/teachers' : '/attendance/students', body)`, a ternary
inside the call that neither this script nor `verify-frontend.js` can see, both collecting
`api.<method>(` followed *immediately* by a path literal. The screen worked; the safety net could not
tell. Both calls are now written out, and both routes are asserted by method and path, so losing either
caller is a red test rather than a silent regression. That is the third time this project has hit the
shape — FR-BILL-004's approve and reject, and the subscription plan change, were the first two — which
is why the rule is now written down: **an endpoint chosen by an expression is an endpoint nothing is
watching.**

Two corrections to what follows, both found by doing the work. **The *buildable / needs a
decision* split was right to draw and wrong in its second half**: §33 fixes two *screen lists*,
and a screen list is not the requirement — every cluster in that column was a stated requirement
with a built, verified API and no way in, so all of them are built and reached from a dashboard or
a sibling screen. And **the count errs in both directions**: eleven working routes were reported
as uncalled because their screens built the path from a variable, which the collector cannot see.
`IMPLEMENTATION_PROGRESS.md` §2an records both.

Spot-checked rather than trusted: the **Attendance** screen contains no form and no write call of any
kind, so §16's attendance cannot be marked from the product. `/plans` has nine write routes and one
caller, so the Features, Limits and Modules sub-screens are read-only.

### The split that matters

Conflating these two is how a specification question gets built as a feature, so they are counted
separately. Screen presence is read from the route tree; §33 presence from `lib/nav.ts`, which
`verify-frontend.js` already asserts against §33 in both directions.

| | Routes | Meaning |
|---|---|---|
| **Buildable now** | **69** | A screen exists, §33 names it, the control has an obvious home. Nothing to decide. |
| **Needs a decision** | **30** | No screen exists and §33 names none. *Where* the operation lives is a question about the requirement. |

**Buildable now (69).** subscriptions 14 · plans 9 · exams 7 · schools 6 · students 5 ·
classes and sections 4 · invoices 4 · coupons 3 · parents 3 · attendance 2 · finance 2 · payments 2 ·
users 2 · addons 2 · fees 1 · homework 1 · library 1 · organizations 1.

**Needs a decision (30).** AI workflow 6 · quotations 5 · taxes 5 · assignments 4 ·
**academic sessions 4** · notifications 3 · roles 2 · **school settings 1**.

The two clearest cases of each kind:

* *Buildable* — **Classes and Sections** edit and delete. §33 names both screens, both exist, and
  neither has a row action. The same shape as the subject and timetable actions already closed.
* *Needs a decision* — **academic sessions**. Four write routes, no screen, and §33's School list
  (seventeen entries, checked against `nav.ts`) does not include one, while FR-SCHOOL-002 requires
  create / activate / close. That is a question about the requirement, which is why `FR-SCHOOL-002`
  correctly still reads `Tested`.

A few of the 99 are deliberate rather than owed: `POST /coupons/validate` is a checkout-time call and
there is no checkout screen, and `POST /notifications/:id/read` wants a notification centre that §33
does not list.

**Correction to an earlier draft of this section.** It said *"Platform Settings cannot be saved"*.
That was wrong twice over. `PATCH /settings` is **§14.1, school-scoped**, with Principal / School
Admin as its actor — not a platform endpoint — and the school surface has no Settings screen because
§33's School list does not name one. The *platform* Settings screen has no form **deliberately**, and
its own header argues the case at length: §33 lists "Settings" among the sixteen Super Admin screens,
the role table points at "global settings (see Section 9)", and Section 9 defines only 9.1 Dashboard,
9.2 School Management and 9.3 Principal Creation — the cross-reference points at nothing. A form there
would have to invent the requirement, the fields, and an endpoint to save them to. That screen is
correct as it stands; `PATCH /settings` belongs in the *needs a decision* column above.

**How this was missed until now.** `docs/UI-AUDIT-FINDINGS.md` filed nine findings about unreachable
endpoints and all nine are closed. But that register was built by auditing **screens that exist** and
looking for defects in them — so a capability with no screen at all, and a screen whose missing row
action nobody had audited, produced no finding to close. A summary written earlier on 2026-09-09
concluded from those nine closures that there was "no remaining case of an endpoint the product
cannot reach". That was false, and the correction is recorded in `IMPLEMENTATION_PROGRESS.md`
part 43 alongside the measurement above.

## 6. Known issues still open

`IMPLEMENTATION_PROGRESS.md` §5 is the register. **Session 28 closed every row a patch could close**
— 17, 21, 31, 32, 33 and 34 — the last two found while re-measuring, and closed the same day.
What was open then was six rows — 2, 11, 15, 18, 19 and 25 — none of them waiting on engineering.
**Row 19 has since closed** on the owner's decision D5; five are open:

| # | Issue | Note |
|---|---|---|
| ~~17~~ | ~~A school sees add-on prices restricted to plans it is not on~~ | **Closed.** `detailInclude()` now filters `addon_prices` to the unrestricted rows plus the school's own plan, using the write path's `ADDON_PRICE_PLAN_MISMATCH` refusal inverted into a filter rather than a rule of its own. Regressed both ways. |
| ~~21~~ | ~~A limit check and the write it guards are not atomic~~ | **Closed, all four racing keys.** The three headcount limits take a `schools` row lock as their transaction's first statement (order is load-bearing: under REPEATABLE READ the first plain `SELECT` fixes the snapshot, not the lock). `ai_limit` could not use a lock — its critical section is a provider round trip — and takes the allowance ahead of the call in one conditional `UPDATE` instead, refunding when nothing is produced. **No 65th table was needed: the counter is the reservation.** `scripts/verify-concurrency.js` measures all four with eight concurrent calls each. |
| ~~32~~ | ~~A student photo can be stored and never looked at~~ | **Closed.** `GET /students/:id/photo` on `students.view`, through the same tenant-scoped finder `GET /:id` uses; the detail screen renders it as a blob through the authenticated client. |
| 18 | An unpriced add-on purchase records at zero | **Must not be "fixed" without an answer** — the SRS names no default `addon_prices` row. It was not among the sixteen questions, so it is the next one for the owner: waive, refuse, or keep the zero line. |
| ~~19~~ | ~~`wallet_balance` is never debited or credited~~ | **Closed by owner decision D5** — refunds credit it, invoices spend it, refused when short. Asserted in `verify-billing.js`. |
| 2 | MySQL (XAMPP) does not survive this environment reliably | Environmental. The Aria recovery procedure is in the register, including the correction that logs must be quarantined *outside* the data directory. |
| 11 | `SUPER_ADMIN_PASSWORD` in `backend/.env` is still the example value | The seeder hard-refuses it under `NODE_ENV=production`. |
| 25 | The `verify-*.js` suites are not safe to run concurrently | Procedural, and it bit during this session: overlapping runs produced two failures in a suite that passed twelve times alone. The harness holds `tests/.suite-run.lock` and says so. |
| ~~33~~ | ~~Runtime logs and an uploaded file were committed, and are still in the history~~ | **Half fixed.** `.gitignore`'s `storage/logs/` was anchored to the repository root and never matched `backend/storage/logs/`, so eleven files were tracked. Patterns fixed, files untracked, and `verify-deploy.js` part 7 now asserts both the patterns and `git ls-files`. `.env` was never among them. The history was rewritten too, on the owner's instruction: `filter-branch` over all 23 commits, verified by `HEAD^{tree}` being byte-identical to the pre-rewrite tree. The pack fell from 17 MB to 3.3 MB. |
| ~~31~~ | ~~Fabricated SRS quotations, and the class is not cleanly assertable~~ | **Closed.** `verify-quotations.js` — a quotation must be traceable to something this repository can point at, so the haystack is the SRS plus every `.js` file with quotation spans stripped out. 45 untraceable to 8, no invented convention. It found two more fabrications on its first run, both in `verify-subscriptions.js`, one of which was this application's own response message quoted back as the source. | 207 backticked quotations sit next to an SRS reference and 45 are not verbatim in the source — almost all legitimately, because the same convention quotes model comments and MySQL error strings. A check failing on 45 correct lines is worse than no check. |
| ~~34~~ | ~~A killed verification run poisoned the run after it~~ | **Closed.** Found when a session restart killed `npm test`; measured by hard-killing each suite partway and diffing every table — 29 of 40 could not recover. Each suite now clears what a dead run of itself left, by markers only it uses (`scripts/lib/residue.js`), and the five that mutate seeded rows journal them first. Two needed more than that, both in the log tables. `scripts/kill-test.js` repeats the measurement. |

## 7. What would close row 7.13

1. A live Anthropic API key, to close 5.2.
2. ~~A decision on the **eleven** `real-blocked` findings~~ — **answered by the owner in session 28**
   (`docs/OWNER-DECISIONS.md`, D1–D16) and built: what identifies two period-less fees of one
   component (20 → D12), whether a plan may be created Active (11 → D11), what `premium_reports`
   unlocks (64 → D9), which notifications reach a Teacher or the Super Admin (63 → D15), what a price
   override changes (39 → D7), whether a Principal's tenancy moves (10 → D3), whether a transaction id
   is required (52 → D8), who edits the timetable (47 → D14), who buys add-ons (53 → D10), how a
   student's documents are stored and read (16 → D13), and whether admission requires a class
   (17 → D4). What remains in this item is Known Issues #18, which was not asked.

Neither is engineering work. Both are decisions or credentials, and this document exists so that the
distinction is on the record rather than inferred.

**Everything else that was outstanding when this document was first written has been done.** The
ninety-nine uncalled write routes are 152 of 152 with a caller. The frontend has a lint. The three Known Issues rows
with real consequences — 17, 21 and 32 — are closed and held by assertions that were proved against
the defects they exist for. The eleven findings that were blocked on a decision have had it, and are
built.
