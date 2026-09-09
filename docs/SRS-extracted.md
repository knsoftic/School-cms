Software Requirements Specification
Multi-School Management System
A Multi-Tenant, Multi-School SaaS Platform
Document Version / Date / Author / Organization: Not Specified in Source Requirements
This document is derived strictly and exclusively from the requirements document provided for the Multi-School Management System. No functionality, module, role, table, technology, or business rule has been added beyond what is explicitly stated in the source. Any gap in the source is marked “Not Specified in Source Requirements.”

# Table of Contents
(Right-click below and choose “Update Field” — or press F9 — to populate the Table of Contents with page numbers.)

# 1. Document Information
Project Name: Multi-School Management System
Document Title: Software Requirements Specification (SRS) — Multi-School Management System
Document Purpose: To define, in a structured and implementation-ready form, the complete set of functional and non-functional requirements for a professional, scalable and secure Multi-School Management SaaS Platform, strictly as described in the provided source requirements document.
Source of Requirements: The requirements document supplied for the Multi-School Management System (business requirements, modules, roles, workflows, technologies, database structure, development rules, and 15-day development roadmap).
Technology Mentioned in Source: Node.js, Express.js, REST API, MySQL, Sequelize ORM or Prisma ORM, JWT Authentication, Role-Based Access Control, Permission-Based Access Control, React.js / Next.js, Responsive Dashboard, Bootstrap/Tailwind CSS, Swagger / OpenAPI, Nginx, PM2.
Document Scope: Covers the complete Multi-School Management SaaS Platform: Super Admin operations, subscription and billing engine, school-level academic and administrative operations, AI-assisted question generation, reporting, notifications, security, performance, deployment, and the associated database schema.
Not Specified in Source Requirements — Document version number, issue date, author name, and issuing organization are not stated in the source requirements document.

# 2. Introduction

## 2.1 Purpose
The purpose of this system is to provide a professional, scalable, and secure platform through which multiple schools, operating under one or more organizations, can be managed from a single SaaS application. The platform supports a full hierarchy of stakeholders — from the platform operator (Super Admin) down to individual parents and students — and provides the administrative, academic, financial, and communication tooling required to run a school digitally.

## 2.2 Project Objective
The stated objective of the project is the development of a Professional, scalable and secure Multi-School Management SaaS Platform.

## 2.3 System Overview
The system is organized around the following hierarchy, as defined in the source requirements:
System Hierarchy: Super Admin → Organizations → Schools/Campuses → Principals/Admins → Teachers/Staff → Students → Parents
Each level in this hierarchy corresponds to a distinct set of responsibilities and system permissions, described fully in Section 5 (User Roles) and Section 6 (Functional Requirements).

## 2.4 Multi-Tenant Architecture
The system is required to be multi-tenant. The following rules apply, as explicitly stated in the source requirements:
- The system is multi-tenant.
- One school's data must not be accessible to another school's users.
- School-related database tables must contain a school_id column.
- Where required, an organization_id column must also be present.

## 2.5 Scope
The scope of the system, strictly per the modules and capabilities listed in the source requirements, includes:
- Super Admin platform administration (organizations, schools, principals, dashboard).
- Subscription management engine (plans, pricing, billing cycles, modules, features, limits, add-ons, lifecycle).
- Invoice, payment, and coupon system.
- School setup and academic session/class/section/subject management.
- Student, parent, teacher, and staff management.
- Attendance management (student and teacher).
- Fee management.
- Finance management (income, expenses, salaries).
- Examination and result management.
- Timetable, homework, assignment, library, and document generation.
- AI module for question generation from uploaded content.
- Reporting engine.
- Notification engine.
- Security, performance, backup/logging, and production deployment requirements.
- Database schema covering all listed modules.

# 3. Technology Stack
Only the technologies explicitly mentioned in the source requirements are documented below.

## Backend
- Node.js
- Express.js
- REST API
- MySQL
- Sequelize ORM or Prisma ORM
- JWT Authentication
- Role-Based Access Control
- Permission-Based Access Control

## Frontend
- React.js / Next.js
- Responsive Dashboard
- Bootstrap/Tailwind CSS

## Development Separation Requirement
The backend and frontend must remain clearly separated during development, consistent with a REST API-first architecture (see Section 4 and Section 30).

# 4. System Architecture
The following architectural elements are documented strictly as described in the source requirements. No additional architectural components are introduced.
- Multi-tenant architecture, with tenant isolation enforced at the data and API layer.
- Clear separation between backend and frontend during development.
- REST API architecture for all backend services.
- API versioning under the path /api/v1.
- Organization → School → School Users hierarchy governing data ownership and access.
- Authentication layer (JWT-based).
- Authorization layer, combining role-based access and permission-based access.
- Role-based access control.
- Permission-based access control.
- Tenant/school isolation enforced through middleware.

# 5. User Roles
The system defines exactly the following eleven roles. Responsibilities listed for each role are limited to what is explicitly supported by the source requirements; where the source does not detail role-specific responsibilities beyond identifying the role, this is noted.

[TABLE]
| Role | Responsibilities / Features Supported by Source |
| Super Admin | Platform-level owner. Manages organizations, schools, principal creation, subscription plans, billing, coupons, platform-wide dashboard and reports, and global settings (see Section 9). |
| Organization Admin | Administers an organization that may contain one or more schools/campuses, per the stated hierarchy: Super Admin → Organizations → Schools/Campuses. Specific organization-admin workflows beyond this hierarchical placement are Not Specified in Source Requirements. |
| Principal | School-level leadership role. Principals are assigned to schools by the Super Admin and are referenced in the hierarchy as Principals/Admins; the Principal Dashboard is listed under Final MVP Requirements (Section 33). |
| School Admin | School-level administrative role, grouped with Principals/Admins in the system hierarchy. Specific school-admin workflows beyond this placement are Not Specified in Source Requirements. |
| Teacher | Manages subjects and classes assigned to them; takes attendance; enters, edits, and submits marks; creates homework and assignments; manages timetable-related teaching periods; participates in the AI question-generation workflow (upload, preview, approve). |
| Accountant | Staff role identified under Staff Management, associated with Finance/Fee-related school operations per the module structure (Sections 17-18). |
| Receptionist | Staff role identified under Staff Management (Section 15). |
| Librarian | Staff role identified under Staff Management, associated with the Library module (Section 20). |
| Staff | General staff role/category encompassing Receptionist, Accountant, Librarian, and Other Staff, per Section 15. |
| Student | Subject of admission, class/section assignment, attendance, fee, examination, result, timetable, homework, assignment, and library records; has access relevant to their own records within their school. |
| Parent | Holds a Parent Account, may be linked to multiple children, and has access to a Parent Dashboard (Section 15). |
[/TABLE]

Not Specified in Source Requirements — The source lists these roles by name and, for several roles (Accountant, Receptionist, Librarian, Organization Admin, School Admin), identifies them structurally (as part of Staff Management or the platform hierarchy) without enumerating role-specific workflows beyond their module associations.

# 6. Functional Requirements
This section documents functional requirements for every module mentioned in the source requirements, using requirement IDs in the form FR-<MODULE>-NNN. Each requirement includes, where supported by the source: Requirement ID, Requirement Name, Description, Actor/Role, Preconditions, Functional Behavior, and Expected Outcome. Preconditions not explicitly stated in the source are marked “Not Specified in Source Requirements.” Detailed functional requirements for each module are presented in their corresponding sections (Sections 7-28) using this same format, grouped by module for readability and traceability.

# 7. Authentication & Authorization
The source requires the following authentication and authorization capabilities:
- Login
- Logout
- Access Token
- Refresh Token
- Password Hashing
- Password Reset
- Email Verification
- Account Status
- JWT-based authentication
- Role middleware
- Permission middleware
Security requirement: users must not access unauthorized school data.

## Functional Requirements
FR-AUTH-001 — User Login
Description: Registered users authenticate using their credentials to obtain access to the system.
Actor / Role: All Roles
Preconditions: User account exists and is in an active status.
Functional Behavior:
- System validates submitted credentials.
- System issues a JWT access token and a refresh token upon successful authentication.
Expected Outcome: Authenticated user is granted an access token scoped to their role and permissions.
FR-AUTH-002 — User Logout
Description: Authenticated users terminate their active session.
Actor / Role: All Roles
Preconditions: User is currently authenticated.
Functional Behavior:
- System invalidates/discards the active session token as applicable.
Expected Outcome: User's session is ended.
FR-AUTH-003 — Access Token & Refresh Token Management
Description: System issues a JWT access token and a refresh token to authenticated users and supports refreshing an expired access token.
Actor / Role: All Roles / System
Preconditions: Valid refresh token exists.
Functional Behavior:
- System issues a short-lived access token.
- System issues a refresh token usable to obtain a new access token.
Expected Outcome: User session continuity is maintained without requiring re-entry of credentials.
FR-AUTH-004 — Password Hashing
Description: User passwords are stored using password hashing rather than plain text.
Actor / Role: System
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- System hashes passwords prior to storage.
Expected Outcome: Stored credentials are protected against exposure.
FR-AUTH-005 — Password Reset
Description: Users can reset a forgotten or expired password.
Actor / Role: All Roles
Preconditions: User account exists.
Functional Behavior:
- User initiates password reset.
- System processes the reset request.
Expected Outcome: User regains access to their account with a new password.
FR-AUTH-006 — Email Verification
Description: User email addresses are verified as part of account management.
Actor / Role: All Roles
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- System sends and validates an email verification step.
Expected Outcome: User email address is confirmed as verified.
FR-AUTH-007 — Account Status Management
Description: User accounts carry an account status used to control access.
Actor / Role: Super Admin / School Admin / System
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- System tracks and enforces account status on each authentication attempt.
Expected Outcome: Accounts that are not in an allowed status are prevented from accessing the system.
FR-AUTH-008 — Role Middleware
Description: Backend requests are checked against the requesting user's role before granting access to role-restricted endpoints.
Actor / Role: System
Preconditions: User is authenticated.
Functional Behavior:
- Role middleware inspects the authenticated user's role prior to processing the request.
Expected Outcome: Requests from users without the required role are rejected.
FR-AUTH-009 — Permission Middleware
Description: Backend requests are checked against the requesting user's granted permissions before granting access to permission-restricted actions.
Actor / Role: System
Preconditions: User is authenticated.
Functional Behavior:
- Permission middleware inspects the authenticated user's permissions prior to processing the request.
Expected Outcome: Requests from users lacking the required permission are rejected.
FR-AUTH-010 — Unauthorized School Data Access Prevention
Description: The system must prevent any authenticated user from accessing school data belonging to a school other than their own.
Actor / Role: All Roles / System
Preconditions: User is authenticated and associated with a specific school.
Functional Behavior:
- System validates the requested resource's school_id against the authenticated user's assigned school on every request.
Expected Outcome: Users cannot access unauthorized school data.

# 8. Multi-Tenant & School Isolation Requirements
The following tenant-isolation requirements are documented per the source:
- Organizations
- Schools
- School Settings
- Academic Sessions
- school_id column present on school-related tables
- organization_id column present where required
- Multi-tenant middleware
- School isolation
- Authorization checks

## Critical Test Scenario
Test Scenario: A Principal/School A user attempts to access School B student API data.
Expected Response: 403 Forbidden or appropriate authorization response.
Additionally, changing school_id in a URL must never allow access to another school's data.

## Functional Requirements
FR-TENANT-001 — Organization & School Data Segregation
Description: All school-related data is segregated by organization and school using organization_id and school_id.
Actor / Role: System
Preconditions: Organization and school records exist.
Functional Behavior:
- Every school-related table stores a school_id.
- Where required, tables also store an organization_id.
Expected Outcome: Data belonging to one school is structurally separated from another.
FR-TENANT-002 — Multi-Tenant Middleware Enforcement
Description: A multi-tenant middleware layer enforces that requests only operate on data belonging to the requesting user's school/organization.
Actor / Role: System
Preconditions: User is authenticated and associated with a school.
Functional Behavior:
- Middleware resolves the requesting user's school_id/organization_id context.
- Middleware restricts queries and mutations to that context.
Expected Outcome: Cross-tenant data access is structurally prevented.
FR-TENANT-003 — Cross-School Access Rejection
Description: Any attempt by a user of one school to access another school's data via API (including by altering a school_id path/query parameter) must be rejected.
Actor / Role: All School-Level Roles / System
Preconditions: User is authenticated and belongs to a specific school.
Functional Behavior:
- System validates that the school_id referenced in a request matches the authenticated user's assigned school on every request, including when the school_id is supplied in a URL.
Expected Outcome: System returns 403 Forbidden or an equivalent authorization error; no cross-school data is returned.
FR-TENANT-004 — School Settings & Academic Session Scoping
Description: School Settings and Academic Sessions are scoped to an individual school.
Actor / Role: Principal / School Admin
Preconditions: School record exists.
Functional Behavior:
- School Settings and Academic Session records are created and managed within the boundary of a single school_id.
Expected Outcome: School configuration and session data does not leak across schools.

# 9. Super Admin Module
All Super Admin capabilities are documented below strictly as stated in the source.

## 9.1 Dashboard
The Super Admin Dashboard displays:
- Total Organizations
- Total Schools
- Active Schools
- Suspended Schools
- Total Students
- Total Teachers
- Active Subscriptions
- Expired Subscriptions
- Monthly Revenue
- Yearly Revenue
- Pending Payments

## 9.2 School Management
- Create School
- Edit School
- View School
- Activate School
- Suspend School
- Delete/Archive School
- Assign Principal
- Change Principal
- View School Usage

## 9.3 Principal Creation
Principal creation captures the following fields:
- Name
- Email
- Phone
- Username
- Password
- School
- Status

## Functional Requirements
FR-SADMIN-001 — Super Admin Dashboard
Description: Displays platform-wide operational and financial metrics to the Super Admin.
Actor / Role: Super Admin
Preconditions: Super Admin is authenticated.
Functional Behavior:
- System aggregates and displays: Total Organizations, Total Schools, Active Schools, Suspended Schools, Total Students, Total Teachers, Active Subscriptions, Expired Subscriptions, Monthly Revenue, Yearly Revenue, and Pending Payments.
Expected Outcome: Super Admin views a consolidated platform overview.
FR-SADMIN-002 — Create School
Description: Super Admin creates a new school record within an organization.
Actor / Role: Super Admin
Preconditions: Organization exists (per system hierarchy).
Functional Behavior:
- Super Admin submits school details.
- System creates the school record.
Expected Outcome: New school is available in the platform.
FR-SADMIN-003 — Edit School
Description: Super Admin edits an existing school's details.
Actor / Role: Super Admin
Preconditions: School record exists.
Functional Behavior:
- Super Admin submits updated school details.
- System persists the changes.
Expected Outcome: School record reflects updated details.
FR-SADMIN-004 — View School
Description: Super Admin views the details of a specific school.
Actor / Role: Super Admin
Preconditions: School record exists.
Functional Behavior:
- System retrieves and displays school details.
Expected Outcome: Super Admin views school information.
FR-SADMIN-005 — Activate / Suspend School
Description: Super Admin activates or suspends a school's access to the platform.
Actor / Role: Super Admin
Preconditions: School record exists.
Functional Behavior:
- Super Admin selects Activate or Suspend for a school.
- System updates the school's status accordingly.
Expected Outcome: School's operational status is updated; suspended schools' access is restricted.
FR-SADMIN-006 — Delete / Archive School
Description: Super Admin deletes or archives a school record.
Actor / Role: Super Admin
Preconditions: School record exists.
Functional Behavior:
- Super Admin selects Delete/Archive.
- System removes or archives the school record.
Expected Outcome: School is removed from active use or archived.
FR-SADMIN-007 — Assign / Change Principal
Description: Super Admin assigns a Principal to a school or changes the currently assigned Principal.
Actor / Role: Super Admin
Preconditions: School record and Principal account exist.
Functional Behavior:
- Super Admin selects a Principal for the school.
- System links the Principal to the school, replacing any prior assignment when changing.
Expected Outcome: School has an assigned Principal on record.
FR-SADMIN-008 — View School Usage
Description: Super Admin views usage information for a specific school.
Actor / Role: Super Admin
Preconditions: School record exists.
Functional Behavior:
- System retrieves and displays the school's usage data.
Expected Outcome: Super Admin views the school's usage.
FR-SADMIN-009 — Principal Creation
Description: Super Admin creates a Principal account and links it to a school.
Actor / Role: Super Admin
Preconditions: School record exists.
Functional Behavior:
- Super Admin submits Name, Email, Phone, Username, Password, School, and Status.
- System creates the Principal account with the submitted status.
Expected Outcome: New Principal account is created and associated with the selected school.

# 10. Subscription Management
The subscription engine is documented exactly as specified in the source.

## 10.1 Subscription Tables
- subscription_plans
- plan_prices
- plan_modules
- plan_features
- plan_limits
- subscriptions
- subscription_items
- subscription_history

## 10.2 Plan Builder
- Create Plan
- Edit Plan
- Duplicate Plan
- Activate/Deactivate Plan
- Archive Plan
Plan fields:
- Name
- Code
- Description
- Status
- Public/Private
- Recommended
- Display Order

## 10.3 Billing Cycles
- Weekly
- Monthly
- Quarterly
- 6 Months
- Yearly
- Custom Days
- One-Time

## 10.4 Pricing Models
- Fixed Price
- Student-Based Price
- Seat-Based Price
- Per-Student Price
- Custom Price

## Functional Requirements
FR-SUB-001 — Create Subscription Plan
Description: Super Admin creates a new subscription plan.
Actor / Role: Super Admin
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- Super Admin submits plan fields: Name, Code, Description, Status, Public/Private, Recommended, Display Order.
- System stores the plan in subscription_plans.
Expected Outcome: New subscription plan is created and available for pricing and configuration.
FR-SUB-002 — Edit Subscription Plan
Description: Super Admin edits an existing subscription plan's fields.
Actor / Role: Super Admin
Preconditions: Plan record exists.
Functional Behavior:
- Super Admin submits updated plan fields.
- System persists the changes.
Expected Outcome: Plan reflects updated configuration.
FR-SUB-003 — Duplicate Subscription Plan
Description: Super Admin duplicates an existing plan to use as a starting point for a new plan.
Actor / Role: Super Admin
Preconditions: Plan record exists.
Functional Behavior:
- Super Admin selects Duplicate on a plan.
- System creates a new plan record copying the source plan's configuration.
Expected Outcome: New plan is created as a copy of the original.
FR-SUB-004 — Activate / Deactivate Subscription Plan
Description: Super Admin activates or deactivates a plan, controlling whether it is available for new subscriptions.
Actor / Role: Super Admin
Preconditions: Plan record exists.
Functional Behavior:
- Super Admin toggles plan status between Active and Deactivated.
Expected Outcome: Plan availability for subscription is updated accordingly.
FR-SUB-005 — Archive Subscription Plan
Description: Super Admin archives a plan that is no longer offered.
Actor / Role: Super Admin
Preconditions: Plan record exists.
Functional Behavior:
- Super Admin selects Archive on a plan.
- System marks the plan as archived.
Expected Outcome: Archived plan is retained for historical reference but not offered for new subscriptions.
FR-SUB-006 — Configure Plan Pricing & Billing Cycle
Description: Super Admin configures a plan's pricing model and billing cycle(s), stored in plan_prices.
Actor / Role: Super Admin
Preconditions: Plan record exists.
Functional Behavior:
- Super Admin selects one or more billing cycles: Weekly, Monthly, Quarterly, 6 Months, Yearly, Custom Days, One-Time.
- Super Admin selects a pricing model: Fixed Price, Student-Based Price, Seat-Based Price, Per-Student Price, or Custom Price.
- System stores the resulting price configuration in plan_prices.
Expected Outcome: Plan has one or more priced billing-cycle options available for subscription.

# 11. Subscription Modules, Features, Limits & Add-ons
Every module, limit, and add-on is documented exactly as provided in the source.

## 11.1 Subscribable Modules
- Students
- Teachers
- Staff
- Attendance
- Fees
- Finance
- Exams
- Online Exams
- Library
- Laboratory
- Timetable
- Homework
- Assignments
- Transport
- Hostel
- Parent Portal
- AI
- Reports
- Certificates
- ID Cards

## 11.2 Limits
- Student Limit
- Teacher Limit
- Staff Limit
- Admin Limit
- Storage Limit
- AI Limit
- API Limit
- File Upload Limit
Each limit may be configured as:
- Fixed
- Unlimited

## 11.3 Add-ons
- Extra Students
- Extra Teachers
- Extra Storage
- AI Credits
- SMS Credits
- Custom Domain
- Premium Reports

## Functional Requirements
FR-SUB-007 — Assign Modules, Features & Limits to a Plan
Description: Super Admin configures which modules, features, and limits are included in a subscription plan, stored respectively in plan_modules, plan_features, and plan_limits.
Actor / Role: Super Admin
Preconditions: Plan record exists.
Functional Behavior:
- Super Admin selects applicable modules from: Students, Teachers, Staff, Attendance, Fees, Finance, Exams, Online Exams, Library, Laboratory, Timetable, Homework, Assignments, Transport, Hostel, Parent Portal, AI, Reports, Certificates, ID Cards.
- Super Admin configures limits (Student Limit, Teacher Limit, Staff Limit, Admin Limit, Storage Limit, AI Limit, API Limit, File Upload Limit) as Fixed or Unlimited.
Expected Outcome: Plan is configured with its included modules, features, and enforceable limits.
FR-SUB-008 — Enforce Plan Limits
Description: The system enforces configured limits (Fixed or Unlimited) against actual usage for a subscribed school.
Actor / Role: System
Preconditions: School has an active subscription with configured limits.
Functional Behavior:
- System tracks usage against each configured limit.
- System blocks or restricts actions that would exceed a Fixed limit.
Expected Outcome: School usage remains within its subscribed plan limits.
FR-SUB-009 — Manage Add-ons
Description: Super Admin and/or school configure add-ons purchasable in addition to the base plan.
Actor / Role: Super Admin
Preconditions: Plan or subscription exists.
Functional Behavior:
- Add-ons available: Extra Students, Extra Teachers, Extra Storage, AI Credits, SMS Credits, Custom Domain, Premium Reports.
- System applies purchased add-ons to the relevant subscription.
Expected Outcome: Subscription reflects any purchased add-ons and their effect on limits/features.

# 12. Subscription Lifecycle
All subscription states are documented exactly as specified:
- Trial
- Active
- Pending
- Past Due
- Expiring
- Grace Period
- Expired
- Suspended
- Cancelled
- Paused

## 12.1 Trial
- 3 Days
- 7 Days
- 14 Days
- 30 Days
- Custom

## 12.2 Grace Period
- 1 Day
- 3 Days
- 7 Days
- 15 Days
- Custom

## 12.3 Upgrade
- Upgrade
- Proration
- Remaining Credit
- New Price Calculation

## 12.4 Downgrade
- Immediate
- Next Billing Cycle

## 12.5 Renewal
- Manual Renewal
- Automatic Renewal

## Functional Requirements
FR-SUB-010 — Subscription State Management
Description: The system tracks and transitions each subscription through its lifecycle states.
Actor / Role: System / Super Admin
Preconditions: Subscription record exists.
Functional Behavior:
- System maintains subscription state as one of: Trial, Active, Pending, Past Due, Expiring, Grace Period, Expired, Suspended, Cancelled, Paused.
- System transitions state based on billing and administrative events.
Expected Outcome: Subscription state accurately reflects its current standing at all times.
FR-SUB-011 — Trial Period Configuration
Description: Super Admin configures the trial duration for a plan or subscription.
Actor / Role: Super Admin
Preconditions: Plan record exists.
Functional Behavior:
- Super Admin selects a trial duration: 3 Days, 7 Days, 14 Days, 30 Days, or Custom.
Expected Outcome: New subscriptions on the plan begin in Trial state for the configured duration.
FR-SUB-012 — Grace Period Configuration
Description: Super Admin configures the grace period applied after a subscription becomes past due or expires.
Actor / Role: Super Admin
Preconditions: Plan or subscription exists.
Functional Behavior:
- Super Admin selects a grace period duration: 1 Day, 3 Days, 7 Days, 15 Days, or Custom.
Expected Outcome: Subscription enters a Grace Period of the configured duration before further state transition (e.g., to Expired/Suspended).
FR-SUB-013 — Subscription Upgrade
Description: School or Super Admin upgrades an active subscription to a higher plan or tier.
Actor / Role: Super Admin / School
Preconditions: Active subscription exists.
Functional Behavior:
- System calculates proration.
- System applies remaining credit from the prior plan.
- System calculates the new price for the upgraded plan.
Expected Outcome: Subscription is upgraded with correctly prorated billing.
FR-SUB-014 — Subscription Downgrade
Description: School or Super Admin downgrades an active subscription to a lower plan or tier.
Actor / Role: Super Admin / School
Preconditions: Active subscription exists.
Functional Behavior:
- System applies the downgrade either Immediately or at the Next Billing Cycle, per the selected option.
Expected Outcome: Subscription reflects the downgraded plan according to the selected timing.
FR-SUB-015 — Subscription Renewal
Description: Subscription is renewed at the end of its billing cycle.
Actor / Role: System / Super Admin / School
Preconditions: Subscription exists and is approaching or at the end of its billing cycle.
Functional Behavior:
- System supports Manual Renewal (initiated by an authorized user).
- System supports Automatic Renewal (initiated by the system at cycle end).
Expected Outcome: Subscription continues into a new billing cycle per the selected renewal mode.

# 13. Invoice, Payment & Coupon System

## 13.1 Invoice
- Invoice Number
- School
- Plan
- Add-ons
- Billing Period
- Subtotal
- Discount
- Tax
- Total
- Due Date
- Status

## 13.2 Payment Architecture
The system supports the following payment methods:
- Cash
- Bank Transfer
- Manual Payment
- Online Gateway
- Wallet
The payment gateway system must be plugin-based.

## 13.3 Manual Payment Workflow

### School
- Submit payment
- Enter transaction ID
- Upload screenshot
- Payment becomes pending

### Super Admin
- Approve
- Reject

## 13.4 Coupons
- Percentage
- Fixed Amount
- Expiry
- Maximum Uses
- Plan Restrictions
- School Restrictions

## Functional Requirements
FR-BILL-001 — Invoice Generation
Description: System generates an invoice for a school's subscription billing period.
Actor / Role: System
Preconditions: Subscription exists and a billing event occurs.
Functional Behavior:
- System creates an invoice containing: Invoice Number, School, Plan, Add-ons, Billing Period, Subtotal, Discount, Tax, Total, Due Date, and Status.
Expected Outcome: Invoice is generated and associated with the school and subscription.
FR-BILL-002 — Payment Method Support
Description: System supports recording and processing payments via Cash, Bank Transfer, Manual Payment, Online Gateway, or Wallet.
Actor / Role: School / Super Admin / System
Preconditions: Invoice exists.
Functional Behavior:
- System accepts a payment method selection from Cash, Bank Transfer, Manual Payment, Online Gateway, or Wallet.
- Online Gateway integrations are implemented using a plugin-based architecture.
Expected Outcome: Payment is recorded against the invoice using the selected method.
FR-BILL-003 — Manual Payment Submission
Description: School submits a manual payment for review.
Actor / Role: School
Preconditions: Invoice exists and is unpaid.
Functional Behavior:
- School submits payment.
- School enters a transaction ID.
- School uploads a payment screenshot.
- System sets the payment status to Pending.
Expected Outcome: Manual payment is recorded as Pending, awaiting Super Admin review.
FR-BILL-004 — Manual Payment Approval / Rejection
Description: Super Admin reviews a pending manual payment and approves or rejects it.
Actor / Role: Super Admin
Preconditions: A manual payment is in Pending status.
Functional Behavior:
- Super Admin reviews the submitted transaction ID and screenshot.
- Super Admin selects Approve or Reject.
Expected Outcome: Payment status is updated to reflect the Super Admin's decision, and the related invoice/subscription status is updated accordingly.
FR-BILL-005 — Coupon Management & Redemption
Description: Super Admin creates coupons that schools can apply to reduce invoice totals.
Actor / Role: Super Admin / School
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- Super Admin configures a coupon as Percentage or Fixed Amount.
- Super Admin configures Expiry and Maximum Uses.
- Super Admin configures Plan Restrictions and School Restrictions.
- School applies a valid coupon to an invoice/subscription.
Expected Outcome: Eligible discount is applied to the invoice subject to the coupon's configured restrictions and usage limits.

# 14. School Setup & Academic Management

## 14.1 School Settings
- Logo
- Name
- Address
- Phone
- Email
- Website
- Favicon
- Theme
- Currency
- Timezone

## 14.2 Academic Sessions
- Create Session
- Activate Session
- Close Session

## 14.3 Classes
- Classes
- Sections
- Class Teachers
- Subjects

## 14.4 Subjects
- Subject Creation
- Subject Assignment
- Teacher Assignment

## Functional Requirements
FR-SCHOOL-001 — School Settings Configuration
Description: Principal/School Admin configures school-level settings.
Actor / Role: Principal / School Admin
Preconditions: School record exists.
Functional Behavior:
- User configures Logo, Name, Address, Phone, Email, Website, Favicon, Theme, Currency, and Timezone.
Expected Outcome: School settings are saved and applied within the school's tenant scope.
FR-SCHOOL-002 — Academic Session Management
Description: Principal/School Admin manages the academic session lifecycle.
Actor / Role: Principal / School Admin
Preconditions: School record exists.
Functional Behavior:
- User creates a new academic session.
- User activates an academic session.
- User closes an academic session.
Expected Outcome: School operates within a defined, correctly-stated academic session.
FR-SCHOOL-003 — Class & Section Management
Description: Principal/School Admin manages classes, sections, and class teacher assignment.
Actor / Role: Principal / School Admin
Preconditions: Academic session exists.
Functional Behavior:
- User creates/manages Classes.
- User creates/manages Sections.
- User assigns Class Teachers.
- User associates Subjects with a class.
Expected Outcome: School's class/section structure is established for the academic session.
FR-SCHOOL-004 — Subject Creation & Assignment
Description: Principal/School Admin creates subjects and assigns them to classes and teachers.
Actor / Role: Principal / School Admin
Preconditions: Class exists.
Functional Behavior:
- User creates a subject.
- User assigns the subject to a class.
- User assigns a teacher to the subject.
Expected Outcome: Subjects are available for timetable, exam, and marks-related operations.

# 15. Student, Parent, Teacher & Staff Management

## 15.1 Student
- Admission
- Student Profile
- Student Photo
- Documents
- Class Assignment
- Section Assignment
- Student ID
- Roll Number
- Promotion
- Transfer
- Leaving

## 15.2 Parent
- Parent Account
- Multiple Children
- Parent Dashboard

## 15.3 Teacher
- Teacher Profile
- Qualification
- Joining Date
- Subjects
- Classes
- Teacher Dashboard

## 15.4 Staff
- Receptionist
- Accountant
- Librarian
- Other Staff

## Functional Requirements
FR-STUDENT-001 — Student Admission
Description: School admits a new student into the system.
Actor / Role: Principal / School Admin / Receptionist
Preconditions: Class and section exist.
Functional Behavior:
- User submits student admission details.
- System creates a Student Profile.
- System assigns a Student ID and Roll Number.
- System captures Student Photo and Documents.
- Student is assigned to a Class and Section.
Expected Outcome: Student is admitted and available within the school's records.
FR-STUDENT-002 — Student Promotion, Transfer & Leaving
Description: School manages a student's progression: promotion to a new class/session, transfer, or leaving.
Actor / Role: Principal / School Admin
Preconditions: Student Profile exists.
Functional Behavior:
- User initiates Promotion, Transfer, or Leaving for a student.
- System updates the student's status/class/section accordingly.
Expected Outcome: Student record reflects current academic status.
FR-PARENT-001 — Parent Account & Multiple Children Linking
Description: System supports a Parent Account that can be linked to multiple children (students).
Actor / Role: Principal / School Admin / System
Preconditions: Student Profile(s) exist.
Functional Behavior:
- System creates a Parent Account.
- System links the Parent Account to one or more Student records.
Expected Outcome: Parent can access records for all linked children.
FR-PARENT-002 — Parent Dashboard
Description: Parent views a dashboard summarizing their linked children's information.
Actor / Role: Parent
Preconditions: Parent Account exists and is linked to at least one student.
Functional Behavior:
- System displays the Parent Dashboard for the authenticated parent.
Expected Outcome: Parent views relevant information for their children.
FR-TEACHER-001 — Teacher Profile Management
Description: School manages Teacher Profile information.
Actor / Role: Principal / School Admin
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- User creates/edits Teacher Profile including Qualification and Joining Date.
- User assigns Subjects and Classes to the teacher.
Expected Outcome: Teacher record reflects their profile, subjects, and classes.
FR-TEACHER-002 — Teacher Dashboard
Description: Teacher views a dashboard relevant to their assigned classes and subjects.
Actor / Role: Teacher
Preconditions: Teacher account exists and is assigned to classes/subjects.
Functional Behavior:
- System displays the Teacher Dashboard for the authenticated teacher.
Expected Outcome: Teacher views relevant information for their teaching assignments.
FR-STAFF-001 — Staff Management
Description: School manages staff records for staff categories including Receptionist, Accountant, Librarian, and Other Staff.
Actor / Role: Principal / School Admin
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- User creates/manages staff records under the categories Receptionist, Accountant, Librarian, and Other Staff.
Expected Outcome: Staff records are available within the school's tenant scope.

# 16. Attendance Management
Student attendance statuses:
- Present
- Absent
- Leave
- Late
Attendance reports:
- Daily
- Monthly
- Yearly
- Percentage
Teacher attendance is also documented in the source.

## Functional Requirements
FR-ATT-001 — Mark Student Attendance
Description: Teacher records daily student attendance.
Actor / Role: Teacher
Preconditions: Class/section and enrolled students exist.
Functional Behavior:
- Teacher marks each student's attendance status as Present, Absent, Leave, or Late.
Expected Outcome: Student attendance record is stored for the date.
FR-ATT-002 — Student Attendance Reports
Description: System generates student attendance reports.
Actor / Role: Principal / School Admin / Teacher
Preconditions: Attendance records exist.
Functional Behavior:
- System generates Daily, Monthly, and Yearly attendance reports.
- System calculates attendance Percentage.
Expected Outcome: User views attendance reports for the requested period.
FR-ATT-003 — Teacher Attendance
Description: System records teacher attendance.
Actor / Role: Principal / School Admin / Teacher
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- System records teacher attendance.
Expected Outcome: Teacher attendance record is stored.

# 17. Fee Management
- Fee Structure
- Monthly Fee
- Admission Fee
- Exam Fee
- Transport Fee
- Fine
- Discount
- Pending Fee
- Partial Payment
- Payment Receipt

## Functional Requirements
FR-FEE-001 — Fee Structure Definition
Description: School defines a fee structure comprising Monthly Fee, Admission Fee, Exam Fee, and Transport Fee.
Actor / Role: Principal / School Admin / Accountant
Preconditions: Academic session/class exists.
Functional Behavior:
- User defines fee components: Monthly Fee, Admission Fee, Exam Fee, Transport Fee.
- User may configure Fine and Discount.
Expected Outcome: Fee Structure is available for assignment to students.
FR-FEE-002 — Fee Collection & Partial Payment
Description: School records fee payments against a student's fee structure, including partial payments.
Actor / Role: Accountant / Receptionist
Preconditions: Fee Structure is assigned to the student.
Functional Behavior:
- User records a fee payment, in full or as a Partial Payment.
- System tracks Pending Fee balance.
- System generates a Payment Receipt.
Expected Outcome: Student fee ledger reflects payments made and any remaining pending balance.

# 18. Finance Management
- Income
- Expenses
- Salaries
- Other Expenses
- Financial Reports
Dashboard Calculation: Income − Expense = Net Balance
Not Specified in Source Requirements
No other financial functionality is documented in the source.

## Functional Requirements
FR-FIN-001 — Record Income & Expenses
Description: School records Income and Expenses, including Salaries and Other Expenses.
Actor / Role: Accountant / Principal / School Admin
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- User records Income entries.
- User records Expense entries, including Salaries and Other Expenses.
Expected Outcome: Finance records are stored for the school.
FR-FIN-002 — Net Balance Calculation
Description: System calculates the school's net balance from recorded income and expenses.
Actor / Role: System
Preconditions: Income and expense records exist.
Functional Behavior:
- System computes Net Balance as Income minus Expense.
Expected Outcome: Net Balance is displayed on the finance dashboard.
FR-FIN-003 — Financial Reports
Description: System generates Financial Reports.
Actor / Role: Accountant / Principal / School Admin
Preconditions: Finance records exist.
Functional Behavior:
- System generates Financial Reports based on recorded Income and Expenses.
Expected Outcome: User views the school's financial reports.

# 19. Examination & Result Management

## 19.1 Examination
- Create Exam
- Exam Type
- Subjects
- Marks
- Passing Marks
- Grade System

## 19.2 Marks
Teacher can:
- Enter Marks
- Edit Marks
- Submit Marks
System automatically calculates:
- Total
- Percentage
- Grade
- Pass/Fail

## 19.3 Results
Generate:
- Result Card
- Class Result
- Student Result
- Position
- Grade
Includes PDF support and Print support.

## Functional Requirements
FR-EXAM-001 — Create Examination
Description: School creates an examination with a defined type, subjects, marks, and grading configuration.
Actor / Role: Principal / School Admin / Teacher
Preconditions: Class and subjects exist.
Functional Behavior:
- User creates an exam, specifying Exam Type, Subjects, Marks, and Passing Marks.
- User selects/configures the Grade System.
Expected Outcome: Examination is created and available for marks entry.
FR-EXAM-002 — Marks Entry, Edit & Submission
Description: Teacher enters, edits, and submits marks for students in a given exam/subject.
Actor / Role: Teacher
Preconditions: Examination exists.
Functional Behavior:
- Teacher enters marks per student.
- Teacher may edit entered marks prior to submission.
- Teacher submits marks.
Expected Outcome: Marks are recorded against the examination.
FR-EXAM-003 — Automatic Marks Calculation
Description: System automatically calculates aggregate results once marks are submitted.
Actor / Role: System
Preconditions: Marks have been submitted.
Functional Behavior:
- System calculates Total, Percentage, Grade, and Pass/Fail status.
Expected Outcome: Calculated results are available for result generation.
FR-EXAM-004 — Result Generation
Description: System generates result outputs for students and classes.
Actor / Role: Principal / School Admin / Teacher
Preconditions: Marks have been calculated.
Functional Behavior:
- System generates Result Card, Class Result, and Student Result.
- System calculates Position and Grade.
Expected Outcome: Results are available for viewing, PDF export, and printing.
FR-EXAM-005 — Result Export (PDF / Print)
Description: System supports exporting and printing generated results.
Actor / Role: Principal / School Admin / Teacher / Parent / Student
Preconditions: Result has been generated.
Functional Behavior:
- User exports the result as PDF.
- User prints the result.
Expected Outcome: Result is available in PDF format and/or printed form.

# 20. Timetable, Homework, Assignment, Library & Documents

## 20.1 Timetable
- Class Timetable
- Teacher Timetable
- Period
- Room
- Subject
- Teacher
- Conflict Detection

## 20.2 Homework
Teacher can:
- Create Homework
- Upload File
- Set Due Date

## 20.3 Assignment
- Create
- Submit
- Review

## 20.4 Library
- Books
- Authors
- Categories
- Quantity
- Issue
- Return
- Fine

## 20.5 Documents
Generate:
- Student ID Card
- Teacher ID Card
- Admission Form
- Fee Receipt
- Result Card
- Character Certificate
- Leaving Certificate

## Functional Requirements
FR-TT-001 — Timetable Creation
Description: School creates Class Timetables and Teacher Timetables, defining Period, Room, Subject, and Teacher.
Actor / Role: Principal / School Admin
Preconditions: Classes, subjects, and teachers exist.
Functional Behavior:
- User creates timetable entries specifying Period, Room, Subject, and Teacher for each Class Timetable / Teacher Timetable.
Expected Outcome: Class and teacher timetables are established.
FR-TT-002 — Timetable Conflict Detection
Description: System detects scheduling conflicts when creating or editing timetable entries.
Actor / Role: System
Preconditions: Timetable entry is being created or edited.
Functional Behavior:
- System checks the new/edited entry against existing entries for Period, Room, and Teacher conflicts.
Expected Outcome: Conflicting timetable entries are flagged/prevented.
FR-HW-001 — Homework Creation
Description: Teacher creates homework for a class/subject, with an optional file upload and a due date.
Actor / Role: Teacher
Preconditions: Class/subject assignment exists.
Functional Behavior:
- Teacher creates homework.
- Teacher uploads a file.
- Teacher sets a due date.
Expected Outcome: Homework is available to the relevant class/students.
FR-ASG-001 — Assignment Create, Submit & Review
Description: System supports assignment creation, student submission, and teacher review.
Actor / Role: Teacher / Student
Preconditions: Class/subject assignment exists.
Functional Behavior:
- Teacher creates an assignment.
- Student submits the assignment.
- Teacher reviews the submission.
Expected Outcome: Assignment lifecycle from creation to review is completed.
FR-LIB-001 — Library Catalog Management
Description: School manages the library catalog: Books, Authors, Categories, and Quantity.
Actor / Role: Librarian
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- Librarian creates/manages Book records with Authors, Categories, and Quantity.
Expected Outcome: Library catalog is available for issue/return operations.
FR-LIB-002 — Book Issue, Return & Fine
Description: Librarian issues and returns books, and manages associated fines.
Actor / Role: Librarian
Preconditions: Book exists in catalog and is available (Quantity > 0 issued copies).
Functional Behavior:
- Librarian issues a book to a student/staff member.
- Librarian records a book return.
- System calculates/records a Fine where applicable.
Expected Outcome: Library transaction is recorded, and book availability/fine status is updated.
FR-DOC-001 — Document Generation
Description: System generates standard school documents.
Actor / Role: Principal / School Admin / Accountant / Receptionist
Preconditions: Relevant underlying record exists (e.g., student, fee payment, exam result).
Functional Behavior:
- System generates: Student ID Card, Teacher ID Card, Admission Form, Fee Receipt, Result Card, Character Certificate, and Leaving Certificate.
Expected Outcome: Requested document is generated for the relevant student/teacher/record.

# 21. AI Module
Only the AI workflow provided in the source is documented.
AI Workflow: Upload → Extract Content → Analyze Topics → Generate MCQs → Generate Answers → Select Difficulty → Teacher Preview → Approve → Question Bank
Teacher can upload:
- PDF
- Image
- Syllabus
AI usage must be connected with subscription limits. Example provided in the source:
Example: Plan: 1000 AI Requests — Usage: 750 / 1000
When the limit is reached, the system must show a block/warning. No other AI functionality is documented in the source.

## Functional Requirements
FR-AI-001 — AI Question Generation Workflow
Description: Teacher uploads content (PDF, Image, or Syllabus) and the system generates multiple-choice questions and answers for teacher review.
Actor / Role: Teacher / System
Preconditions: School's subscription includes the AI module and has remaining AI usage.
Functional Behavior:
- Teacher uploads a PDF, Image, or Syllabus.
- System extracts content from the upload.
- System analyzes topics within the extracted content.
- System generates MCQs.
- System generates answers.
- Teacher selects difficulty.
- Teacher previews the generated questions.
- Teacher approves the questions.
- Approved questions are added to the Question Bank.
Expected Outcome: Approved AI-generated questions are stored in the Question Bank.
FR-AI-002 — AI Usage Limit Enforcement
Description: System tracks AI usage against the school's subscribed AI Limit and blocks/warns when the limit is reached.
Actor / Role: System
Preconditions: School's subscription defines an AI Limit (e.g., 1000 AI Requests).
Functional Behavior:
- System increments AI usage on each AI request (e.g., reaching 750 / 1000).
- System compares current usage to the configured AI Limit on each new request.
Expected Outcome: When the AI Limit is reached, the system displays a block/warning and prevents further AI usage beyond the limit.

# 22. Reports
- Student Reports
- Attendance Reports
- Fee Reports
- Expense Reports
- Exam Reports
- Teacher Reports
- Subscription Reports
Export formats:
- PDF
- Excel
- Print

## Functional Requirements
FR-REPORT-001 — Generate Reports
Description: System generates the reports specified in the source for the relevant module data.
Actor / Role: Super Admin / Principal / School Admin / Accountant / Teacher
Preconditions: Underlying module data exists.
Functional Behavior:
- System generates Student Reports, Attendance Reports, Fee Reports, Expense Reports, Exam Reports, Teacher Reports, and Subscription Reports.
Expected Outcome: Requested report is produced and available for export.
FR-REPORT-002 — Report Export
Description: System exports generated reports in supported formats.
Actor / Role: Super Admin / Principal / School Admin / Accountant / Teacher
Preconditions: Report has been generated.
Functional Behavior:
- User exports the report as PDF.
- User exports the report as Excel.
- User prints the report.
Expected Outcome: Report is available in the selected export format.

# 23. Notification Engine
The following notification types are documented. No additional notification types are introduced.
- Fee Reminder
- Fee Paid
- Exam Announcement
- Result Published
- Attendance Alert
- Homework
- Subscription Expiry
- Payment Received
- Payment Failed

## Functional Requirements
FR-NOTIF-001 — System Notifications
Description: System sends notifications for defined business events.
Actor / Role: System
Preconditions: Triggering event occurs (e.g., fee due, exam scheduled, result published, attendance marked, homework created, subscription nearing expiry, payment processed).
Functional Behavior:
- System sends a notification for each of: Fee Reminder, Fee Paid, Exam Announcement, Result Published, Attendance Alert, Homework, Subscription Expiry, Payment Received, and Payment Failed.
Expected Outcome: Relevant users (school, parent, student, teacher, or Super Admin as applicable to the event) receive the notification.

# 24. Security Requirements
- Authentication
- Authorization
- Role Permissions
- School Isolation
- SQL Injection protection/testing
- XSS protection/testing
- CSRF protection/testing
- File Upload security
- API Security
- Rate Limiting
- JWT Security

## Critical School-Isolation Test Case
Test Scenario: Principal/School A user attempts to access School B student API data.
Expected Response: 403 Forbidden or appropriate authorization response.

## Functional Requirements
FR-SEC-001 — Authentication & Authorization Enforcement
Description: System enforces authentication and authorization (Role Permissions) on all protected operations.
Actor / Role: System
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- System requires valid authentication for protected endpoints.
- System enforces Role Permissions on protected actions.
Expected Outcome: Only authenticated and authorized users perform protected operations.
FR-SEC-002 — School Isolation Testing
Description: System is tested against the critical school-isolation scenario.
Actor / Role: System / QA
Preconditions: Two or more schools exist within the platform.
Functional Behavior:
- A Principal/School A user attempts to access School B student API data.
- System evaluates the request against tenant-isolation rules.
Expected Outcome: System returns 403 Forbidden or an equivalent authorization response; School B data is not returned.
FR-SEC-003 — Injection & Cross-Site Protection Testing
Description: System is protected against and tested for SQL Injection, XSS, and CSRF.
Actor / Role: System / QA
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- System applies protections against SQL Injection.
- System applies protections against XSS.
- System applies protections against CSRF.
- These protections are tested.
Expected Outcome: System resists SQL Injection, XSS, and CSRF attack vectors.
FR-SEC-004 — File Upload Security
Description: System applies security controls to file uploads (e.g., homework files, AI-module uploads, payment screenshots).
Actor / Role: System
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- System applies File Upload security controls.
Expected Outcome: Uploaded files are handled securely.
FR-SEC-005 — API Security & Rate Limiting
Description: System applies API Security controls and Rate Limiting to protect backend endpoints.
Actor / Role: System
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- System applies API Security measures.
- System applies Rate Limiting to API requests.
Expected Outcome: API endpoints are protected from abuse and unauthorized use.
FR-SEC-006 — JWT Security
Description: System secures JWT-based authentication tokens.
Actor / Role: System
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- System applies JWT Security controls to issued tokens.
Expected Outcome: JWT tokens are protected against common token-based attacks.

# 25. Performance Requirements
Testing and implementation requirements are documented for:
- Database indexes
- Pagination
- API response time
- Heavy reports
- Large student lists
- Concurrent users
Implementation requirements:
- Caching
- Pagination
- Query optimization
- Background jobs
- Queue system
Not Specified in Source Requirements — Specific numerical performance targets (e.g., exact response-time thresholds or concurrent-user counts) are not provided in the source and are not invented here.

## Functional Requirements
FR-PERF-001 — Performance Optimization Implementation
Description: System implements performance optimization techniques for database and API operations.
Actor / Role: System
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- System uses database indexes.
- System applies Pagination to list endpoints (including large student lists).
- System applies Caching.
- System applies Query optimization.
- System processes heavy reports and long-running tasks via Background jobs and a Queue system.
Expected Outcome: System maintains acceptable API response time and handles concurrent users and heavy reports without invented numeric targets.

# 26. Backup, Logging & Monitoring
- Database Backup
- Backup Retention
- Error Logs
- Activity Logs

## Functional Requirements
FR-BKP-001 — Database Backup & Retention
Description: System performs Database Backup and applies a Backup Retention policy.
Actor / Role: System
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- System performs Database Backup.
- System retains backups per the Backup Retention policy.
Expected Outcome: Database can be restored from backup within the retention window.
FR-LOG-001 — Error & Activity Logging
Description: System records Error Logs and Activity Logs.
Actor / Role: System
Preconditions: Not Specified in Source Requirements
Functional Behavior:
- System records Error Logs on system errors.
- System records Activity Logs for user/system actions.
Expected Outcome: Errors and activity are auditable via logs.

# 27. Production Deployment
- Node.js Production
- MySQL Production
- Nginx
- SSL
- Domain
- Environment Variables
- PM2
- Cron Jobs
- Queue Workers
- Database Backup
- Logging
- Monitoring
Not Specified in Source Requirements — No deployment technologies beyond this list are introduced.

## Functional Requirements
FR-DEPLOY-001 — Production Environment Setup
Description: System is deployed to a production environment using the specified stack and operational tooling.
Actor / Role: System / DevOps
Preconditions: Application is ready for deployment.
Functional Behavior:
- Node.js runs in a production configuration.
- MySQL runs in a production configuration.
- Nginx is configured as the web server/reverse proxy.
- SSL is configured for the Domain.
- Environment Variables are configured for the production environment.
- PM2 manages the Node.js process.
- Cron Jobs and Queue Workers are configured.
- Database Backup, Logging, and Monitoring are configured for production.
Expected Outcome: Application runs in a production-ready environment per the specified stack.

# 28. API Documentation
The system requires API documentation using Swagger / OpenAPI.
API documentation must include:
- Endpoint
- Method
- Authentication
- Parameters
- Request Body
- Response
- Error Response

## Functional Requirements
FR-APIDOC-001 — Swagger / OpenAPI Documentation
Description: System provides API documentation generated/maintained via Swagger / OpenAPI.
Actor / Role: System / Development Team
Preconditions: API endpoints are implemented.
Functional Behavior:
- System documents each endpoint's: Endpoint, Method, Authentication, Parameters, Request Body, Response, and Error Response.
Expected Outcome: Complete, accurate API documentation is available via Swagger / OpenAPI.

# 29. Database Requirements
The following database modules and table names are preserved exactly as provided in the source. No additional tables are introduced.

## Core

[TABLE]
| Table |
| users |
| roles |
| permissions |
| role_permissions |
| organizations |
| schools |
| school_settings |
| academic_sessions |
[/TABLE]

## Subscription

[TABLE]
| Table |
| subscription_plans |
| plan_prices |
| plan_modules |
| plan_features |
| plan_limits |
| subscriptions |
| subscription_items |
| subscription_history |
| subscription_overrides |
| addons |
| addon_prices |
| subscription_addons |
| usage_records |
[/TABLE]

## Billing

[TABLE]
| Table |
| invoices |
| invoice_items |
| payments |
| payment_transactions |
| refunds |
| coupons |
| coupon_usages |
| taxes |
| quotations |
[/TABLE]

## Academic

[TABLE]
| Table |
| classes |
| sections |
| subjects |
| class_subjects |
| teacher_subjects |
[/TABLE]

## People

[TABLE]
| Table |
| students |
| parents |
| parent_students |
| teachers |
| staff |
[/TABLE]

## Attendance

[TABLE]
| Table |
| student_attendance |
| teacher_attendance |
[/TABLE]

## Finance

[TABLE]
| Table |
| fee_structures |
| student_fees |
| fee_payments |
| expenses |
| incomes |
[/TABLE]

## Exams

[TABLE]
| Table |
| exams |
| exam_subjects |
| marks |
| grades |
| results |
| question_banks |
| questions |
| online_exams |
[/TABLE]

## Other

[TABLE]
| Table |
| timetables |
| homework |
| assignments |
| books |
| library_transactions |
| documents |
| notifications |
| activity_logs |
| audit_logs |
[/TABLE]

Not Specified in Source Requirements — No tables beyond those listed above are introduced. Column-level schema (data types, constraints) is not specified in the source beyond the required school_id and organization_id tenancy columns described in Sections 2.4 and 8.

# 30. Non-Negotiable Development Rules

## Rule 1 — No Hard-Coded Subscription Logic
Subscription plans, modules, limits and prices must be database-driven. Plan names must not be hard-coded.
Incorrect concept: if plan == premium
Correct concept: Check database feature/limit configuration

## Rule 2 — Complete Tenant Isolation
School A must never be able to access School B data.

## Rule 3 — API-First Architecture
The backend must use REST API architecture so that the system can later connect with:
- Android App
- iOS App
- Mobile Web
- Third-Party Integrations
Not Specified in Source Requirements — No other future platforms beyond Android App, iOS App, Mobile Web, and Third-Party Integrations are specified for future connectivity.

# 31. 15-Day Development Roadmap
The complete 15-day development plan is documented below, with each day's scope traced to the corresponding SRS sections.

[TABLE]
| Day | Focus Area | Scope (per source; traced to SRS section) |
| Day 1 | Project Setup & Architecture | Establish project setup and system architecture per Section 4 (System Architecture) and Section 3 (Technology Stack). |
| Day 2 | Multi-Tenant Architecture & Authentication | Implement multi-tenant architecture and authentication per Section 8 (Multi-Tenant & School Isolation Requirements) and Section 7 (Authentication & Authorization). |
| Day 3 | Super Admin Panel | Implement dashboard, school management, and principal creation requirements per Section 9 (Super Admin Module). |
| Day 4 | Subscription Engine Foundation | Implement plan builder, billing cycles, and pricing requirements per Section 10 (Subscription Management). |
| Day 5 | Advanced Subscription Features | Implement modules, limits, and add-ons per Section 11 (Subscription Modules, Features, Limits & Add-ons). |
| Day 6 | Subscription Lifecycle & Billing | Implement trial, grace period, upgrade, downgrade, and renewal per Section 12 (Subscription Lifecycle). |
| Day 7 | Invoice, Payment & Coupon System | Implement invoice, payment architecture, manual payment, and coupons per Section 13 (Invoice, Payment & Coupon System). |
| Day 8 | School Setup & Academic Management | Implement school settings, academic sessions, classes, and subjects per Section 14 (School Setup & Academic Management). |
| Day 9 | Student, Parent & Teacher Management | Implement student, parent, teacher, and staff functionality per Section 15 (Student, Parent, Teacher & Staff Management). |
| Day 10 | Attendance, Fees & Finance | Implement all attendance, fee, and finance requirements per Sections 16-18. |
| Day 11 | Examination & Result System | Implement examination, marks, and result requirements per Section 19 (Examination & Result Management). |
| Day 12 | Timetable, Homework, Library & Documents | Implement all supporting school modules per Section 20 (Timetable, Homework, Assignment, Library & Documents). |
| Day 13 | AI Module, Reports & Notifications | Implement AI workflow, usage limits, reports, and notification engine per Sections 21-23. |
| Day 14 | Security, Testing & Performance | Implement security testing, school isolation testing, performance testing, optimization, backup, and logging per Sections 24-26. |
| Day 15 | Final Integration, Deployment & Documentation | Complete integration, final checks, production deployment, and Swagger/OpenAPI documentation per Sections 27-28. |
[/TABLE]

Not Specified in Source Requirements — The source specifies the day-by-day focus areas and instructs that each day's tasks and deliverables be the full set of requirements from the corresponding module sections; it does not provide additional day-level tasks beyond referencing those module requirements.

# 32. Developer Working Method
The exact daily development workflow specified in the source:
1. Complete the assigned task for the day.
2. Create database migration.
3. Create API endpoints.
4. Add validation.
5. Apply authentication/authorization checks.
6. Connect frontend UI.
7. Perform testing.
8. Create Git commit.
9. Provide completed-feature report at day-end.
10. Before starting the next day's task, fix critical bugs from the previous day.
Development Standard: Every feature must be developed using reusable and modular code.

# 33. Final MVP Requirements
The final MVP requirements checklist, strictly per the source:

## Super Admin
- Dashboard
- Organizations
- Schools
- Principals
- Users
- Plans
- Modules
- Features
- Limits
- Add-ons
- Subscriptions
- Invoices
- Payments
- Coupons
- Reports
- Settings

## School
- Principal Dashboard
- Teachers
- Staff
- Students
- Parents
- Classes
- Sections
- Subjects
- Attendance
- Fees
- Finance
- Exams
- Results
- Timetable
- Homework
- Library
- Documents

## SaaS Engine
- Trial
- Subscription
- Renewal
- Upgrade
- Downgrade
- Proration
- Grace Period
- Expiry
- Suspension
- Add-ons
- Usage Tracking
- Overage
- Coupons
- Discounts
- Taxes
- Invoices
- Payments
- Refunds
- Custom Pricing
- Custom Limits
- Feature Overrides

# 34. Requirements Traceability
The table below maps each major SRS section to its corresponding source area / development-roadmap day, ensuring that nothing from the source document is lost or replaced with an invented requirement.

[TABLE]
| SRS Section | Source Area / Roadmap Day |
| Section 7 — Authentication & Authorization | Authentication & Authorization / Day 2 |
| Section 8 — Multi-Tenant & School Isolation | Multi-Tenant & School Isolation Requirements / Day 2 |
| Section 9 — Super Admin Module | Super Admin Module / Day 3 |
| Section 10 — Subscription Management | Subscription Management / Day 4 |
| Section 11 — Subscription Modules, Features, Limits & Add-ons | Subscription Modules, Features, Limits & Add-ons / Day 5 |
| Section 12 — Subscription Lifecycle | Subscription Lifecycle / Day 6 |
| Section 13 — Invoice, Payment & Coupon System | Invoice, Payment & Coupon System / Day 7 |
| Section 14 — School Setup & Academic Management | School Setup & Academic Management / Day 8 |
| Section 15 — Student, Parent, Teacher & Staff Management | Student, Parent, Teacher & Staff Management / Day 9 |
| Sections 16-18 — Attendance, Fee, Finance | Attendance Management; Fee Management; Finance Management / Day 10 |
| Section 19 — Examination & Result Management | Examination & Result Management / Day 11 |
| Section 20 — Timetable, Homework, Assignment, Library & Documents | Timetable, Homework, Assignment, Library & Documents / Day 12 |
| Sections 21-23 — AI Module, Reports, Notification Engine | AI Module; Reports; Notification Engine / Day 13 |
| Sections 24-26 — Security, Performance, Backup/Logging | Security Requirements; Performance Requirements; Backup, Logging & Monitoring / Day 14 |
| Sections 27-28 — Production Deployment, API Documentation | Production Deployment; API Documentation / Day 15 |
| Section 29 — Database Requirements | Database modules and table names (Core, Subscription, Billing, Academic, People, Attendance, Finance, Exams, Other) |
| Section 30 — Non-Negotiable Development Rules | Rule 1 (No Hard-Coded Subscription Logic), Rule 2 (Complete Tenant Isolation), Rule 3 (API-First Architecture) |
| Section 33 — Final MVP Requirements | Super Admin, School, and SaaS Engine MVP checklists |
[/TABLE]

# 35. Missing Information Handling
Where the source document does not specify a detail, this SRS does not decide it. Such gaps are marked “Not Specified in Source Requirements” rather than filled with assumptions. This applies in particular to:
- Additional roles
- Additional modules
- Additional workflows
- Additional database tables
- Additional technologies
- Additional business rules
- Additional pricing rules
- Additional security policies
- Additional performance numbers
- Additional payment gateways
- Additional notification channels
Instances of “Not Specified in Source Requirements” used elsewhere in this document include: document version/date/author/organization (Section 1); detailed workflows for Organization Admin and School Admin beyond their hierarchical placement (Section 5); numerous FR preconditions not stated explicitly in the source; numerical performance targets (Section 25); and column-level database schema beyond table names and the required tenancy columns (Section 29).

# 36. Final Quality Rules — Internal Consistency Check
The following internal consistency check has been performed against the source document prior to finalizing this SRS:
1. Verified every requirement from the source has been represented.
2. Verified no source requirement has been silently removed.
3. Verified no new functionality has been added.
4. Verified all roles match the source (Section 5).
5. Verified all modules match the source (Sections 6-23).
6. Verified all database table names match the source (Section 29).
7. Verified subscription lifecycle states match the source (Section 12).
8. Verified billing cycles match the source (Section 10.3).
9. Verified pricing models match the source (Section 10.4).
10. Verified subscription modules, limits and add-ons match the source (Section 11).
11. Verified security requirements match the source (Section 24).
12. Verified the AI workflow matches the source (Section 21).
13. Verified reports and notifications match the source (Sections 22-23).
14. Verified deployment requirements match the source (Section 27).
15. Verified the 15-day roadmap is preserved (Section 31).
16. Verified the developer working method is preserved (Section 32).
17. Verified the final MVP checklist is preserved (Section 33).
18. Marked genuinely unspecified information as “Not Specified in Source Requirements” rather than making assumptions (Section 35).
Governing Principle: The source requirements document is the single source of truth for this SRS. Nothing has been added beyond what the source explicitly states.