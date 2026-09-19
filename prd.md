# AetherDust — Product Requirements Document (PRD)

**Version:** 1.0  
**Date:** 2026-09-20  
**Status:** MVP Specification  
**Product:** AetherDust  
**Network:** Midnight

---

## 1. Product Summary

AetherDust is a self-hostable **DUST sponsorship control plane for Midnight DApps**.

It lets a DApp sponsor the transaction costs of its users without requiring those users to hold DUST themselves.

The core relationship is simple:

> **The user authorizes the transaction. The DApp decides whether it will sponsor it. AetherDust enforces that decision. The sponsor wallet pays the DUST.**

AetherDust sits between a DApp and Midnight as infrastructure. It is not a wallet, token, marketplace, or general-purpose transaction executor.

### One-line description

**AetherDust gives Midnight DApps a controlled way to offer gasless user experiences by sponsoring DUST through programmable policies, budgets, limits, and transaction controls.**

---

# 2. Problem

Midnight DApps can require users to pay transaction costs in DUST.

For a new user, this creates a major onboarding problem:

1. User discovers a DApp.
2. User wants to perform an action.
3. User has no DUST.
4. User must obtain DUST before completing the action.
5. The onboarding flow becomes dependent on a blockchain-native asset the user may not understand or possess.

This introduces unnecessary friction for applications that would prefer to pay transaction costs on behalf of their users.

However, simply giving a DApp access to a funded wallet is not enough.

A production sponsorship system needs to answer:

- Which users can receive sponsorship?
- Which contracts can be sponsored?
- Which entry points/actions are allowed?
- How much DUST can be spent?
- How much can one user consume?
- How quickly can requests be made?
- What happens if a transaction is invalid?
- How is sponsorship usage tracked?
- How does the operator know when its DUST budget is being consumed?
- How can the infrastructure be self-hosted?

AetherDust solves this operational control problem.

---

# 3. Product Vision

Make transaction sponsorship on Midnight feel like normal application infrastructure.

Developers should be able to integrate AetherDust without building their own:

- sponsorship relay,
- policy engine,
- spending-limit system,
- user rate limiter,
- transaction pre-flight layer,
- sponsorship accounting system,
- monitoring dashboard.

The resulting developer experience should look conceptually like:

```text
User
  │
  │ authorizes transaction
  ▼
DApp
  │
  │ sponsorship request
  ▼
AetherDust
  │
  ├── Authenticate
  ├── Validate policy
  ├── Check budget
  ├── Check user limits
  ├── Rate limit
  ├── Pre-flight validation
  │
  ▼
Sponsor Wallet
  │
  │ pays DUST
  ▼
Midnight
  │
  ▼
Transaction Result
```

---

# 4. Goals

## 4.1 Primary Goals

### G1 — Enable DApp-sponsored transactions

Allow a DApp to pay DUST for eligible user transactions.

### G2 — Preserve user key ownership

Users must authorize their own transactions.

AetherDust must not require custody of user private keys.

### G3 — Make sponsorship programmable

Developers must be able to define rules controlling sponsorship.

Examples:

- allowed contracts,
- allowed entry points,
- global spending budget,
- per-user spending limits,
- credential/user request limits.

### G4 — Prevent uncontrolled DUST spending

The sponsor must have explicit controls preventing arbitrary transaction sponsorship.

### G5 — Provide operational visibility

Operators must be able to see:

- sponsorship requests,
- successful transactions,
- rejected requests,
- DUST consumption,
- remaining budget,
- usage by user/credential,
- transaction status.

### G6 — Be self-hostable

AetherDust should be deployable by a DApp operator using Docker.

---

# 5. Non-Goals

AetherDust must **not** become:

### 5.1 A user wallet

It does not generate or manage user wallets.

### 5.2 A private-key custodian for users

User private keys never need to be handed to AetherDust.

### 5.3 A new token

AetherDust does not introduce a token or replace DUST.

### 5.4 A marketplace

AetherDust does not buy, sell, or trade sponsorship.

### 5.5 A blockchain

AetherDust does not create a new consensus or settlement layer.

### 5.6 A general transaction executor

AetherDust only performs the narrowly defined sponsorship workflow.

### 5.7 A protocol modification

AetherDust operates around the existing Midnight transaction/sponsorship model rather than requiring a modification to Midnight itself.

### 5.8 A Sybil-proof identity system

MVP limits can be associated with authenticated users or credentials, but AetherDust does not claim to solve identity or Sybil resistance.

---

# 6. Target Users

## 6.1 DApp Developer

Wants users to interact with the application without needing to acquire DUST first.

Needs:

- simple API,
- policy configuration,
- predictable sponsorship,
- transaction status,
- easy integration.

## 6.2 DApp Operator

Responsible for the DApp's infrastructure and sponsorship budget.

Needs:

- spending controls,
- monitoring,
- usage accounting,
- rate limiting,
- self-hosting,
- operational visibility.

## 6.3 End User

Wants to use a Midnight DApp.

Needs:

- no requirement to manually acquire DUST for sponsored actions,
- control over their own transaction authorization,
- clear transaction status.

---

# 7. Core Product Concept

AetherDust introduces a controlled sponsorship boundary between the DApp and Midnight.

The DApp does not simply say:

> "Pay for everything this user submits."

Instead, it defines a sponsorship policy.

For example:

```yaml
sponsorship:
  enabled: true

contracts:
  allowlist:
    - contract_a

entry_points:
  allowlist:
    - register
    - claim

limits:
  global_daily_dust: 100
  per_user_daily_dust: 1
  max_dust_per_transaction: 0.1

rate_limit:
  requests_per_minute: 10
```

AetherDust evaluates every sponsorship request against this policy.

Only requests satisfying the configured rules can proceed.

---

# 8. User Experience

## 8.1 Desired User Flow

1. User connects their Midnight wallet to the DApp.
2. User chooses an action.
3. DApp constructs the transaction.
4. User authorizes/signs the transaction.
5. DApp sends the sponsorship request to AetherDust.
6. AetherDust authenticates the request.
7. AetherDust checks sponsorship policy.
8. AetherDust checks budget and user limits.
9. AetherDust performs basic pre-flight validation.
10. Sponsor wallet provides the required DUST sponsorship.
11. Transaction is submitted to Midnight.
12. AetherDust returns transaction status.
13. DApp displays the result to the user.

The user should not need to manually acquire DUST for a sponsored action.

---

# 9. Core Architecture

```text
┌───────────────────────┐
│        User           │
│                       │
│ Midnight Wallet       │
└───────────┬───────────┘
            │
            │ Authorizes transaction
            ▼
┌───────────────────────┐
│         DApp          │
│                       │
│ Frontend + Backend    │
└───────────┬───────────┘
            │
            │ Sponsorship request
            ▼
┌────────────────────────────┐
│        AetherDust          │
│                            │
│  API / Authentication      │
│          │                 │
│          ▼                 │
│  Policy Engine             │
│          │                 │
│          ▼                 │
│  Budget & Limits           │
│          │                 │
│          ▼                 │
│  Rate Limiter              │
│          │                 │
│          ▼                 │
│  Pre-flight Validation     │
│          │                 │
│          ▼                 │
│  Sponsorship Relay         │
└────────────┬───────────────┘
             │
             ▼
┌───────────────────────┐
│    Sponsor Wallet     │
│                       │
│ Holds DUST            │
└───────────┬───────────┘
            │
            │ Sponsored transaction
            ▼
┌───────────────────────┐
│       Midnight        │
└───────────────────────┘
```

---

# 10. Major Components

## 10.1 AetherDust API

The public interface used by DApps.

Responsibilities:

- authenticate DApp requests,
- accept sponsorship requests,
- validate request schema,
- return request/transaction status,
- expose usage information where authorized.

---

## 10.2 Authentication Layer

Every sponsorship request must be associated with an authorized DApp/application credential.

Requirements:

- API credentials,
- credential validation,
- request authentication,
- credential-level rate limiting.

MVP does not require a decentralized identity system.

---

## 10.3 Policy Engine

The policy engine determines whether a transaction is eligible for sponsorship.

Policy dimensions include:

### Contract allowlist

Only approved contracts may be sponsored.

### Entry-point allowlist

Only approved contract actions may be sponsored.

### Global budget

Maximum DUST sponsorship over a configured period.

### Per-user limit

Maximum sponsorship assigned to an individual authenticated user/credential.

### Per-transaction limit

Maximum DUST that can be sponsored for a single transaction.

Policies must fail closed.

If a request does not satisfy the policy, sponsorship is rejected.

---

# 11. Budget System

The budget system prevents uncontrolled DUST consumption.

## 11.1 Global Budget

Example:

```text
Daily sponsorship budget = 100 DUST
Used = 37 DUST
Remaining = 63 DUST
```

When the budget is exhausted, new sponsorship requests are rejected.

## 11.2 Per-user Budget

Example:

```text
User A:
Daily allowance = 1 DUST
Used = 0.4 DUST
Remaining = 0.6 DUST
```

## 11.3 Per-transaction Limit

Example:

```text
Maximum sponsorship per transaction = 0.1 DUST
```

A transaction requiring more than the configured maximum is rejected.

---

# 12. Rate Limiting

Rate limiting protects the sponsor and infrastructure from request abuse.

Rate limits may be applied to:

- DApp credential,
- user/credential,
- IP/request source where appropriate,
- endpoint.

Example:

```text
10 sponsorship requests / minute / credential
```

Rate limiting occurs before sponsorship execution.

---

# 13. Pre-flight Validation

Before spending sponsor DUST, AetherDust performs basic validation.

The purpose is to avoid sponsoring requests that can be rejected before reaching Midnight.

MVP pre-flight should verify information available to AetherDust without attempting to become a complete blockchain simulator.

Examples:

- request structure is valid,
- required transaction fields exist,
- contract is allowed,
- entry point is allowed,
- sponsorship amount is within limits,
- request has not already been processed,
- transaction does not violate configured policy.

More advanced simulation is deferred.

---

# 14. Sponsorship Relay

The relay is responsible for the actual sponsorship path.

Conceptually:

```text
DApp
  │
  │ signed/authorized transaction
  ▼
AetherDust
  │
  │ policy-approved
  ▼
Sponsor Wallet
  │
  │ DUST sponsorship
  ▼
Midnight
```

The relay must ensure that policy checks happen before sponsor resources are committed.

---

# 15. Sponsor Wallet

AetherDust requires a sponsor-controlled wallet/account holding DUST.

The sponsor wallet is controlled by the DApp operator.

Important distinction:

```text
User wallet
    ↓
owns user keys
authorizes user transaction

Sponsor wallet
    ↓
controlled by DApp operator
provides DUST sponsorship
```

AetherDust does not take custody of user private keys.

For the MVP, sponsor-wallet handling must be designed so that the infrastructure can safely sign/submit sponsorship transactions without exposing credentials through the API.

---

# 16. Transaction State Machine

Each sponsorship request should have an explicit lifecycle.

```text
RECEIVED
   │
   ▼
AUTHENTICATED
   │
   ▼
POLICY_CHECK
   │
   ├──────────────► REJECTED
   │
   ▼
BUDGET_CHECK
   │
   ├──────────────► REJECTED
   │
   ▼
PREFLIGHT
   │
   ├──────────────► REJECTED
   │
   ▼
SPONSORING
   │
   ▼
SUBMITTED
   │
   ▼
CONFIRMED
```

Possible failure states:

```text
AUTH_FAILED
POLICY_REJECTED
BUDGET_EXCEEDED
RATE_LIMITED
PREFLIGHT_FAILED
SPONSORING_FAILED
SUBMISSION_FAILED
TIMEOUT
UNKNOWN
```

---

# 17. Idempotency

AetherDust must protect against duplicate sponsorship.

Every sponsorship request should contain an idempotency identifier.

If the same request is submitted multiple times, AetherDust should not unintentionally spend the sponsor's DUST multiple times.

Example:

```text
idempotency_key:
  dapp_123:user_456:request_789
```

Repeated requests should resolve to the existing request state where appropriate.

---

# 18. API Requirements

## 18.1 Create Sponsorship Request

```http
POST /v1/sponsorship/requests
```

Example request:

```json
{
  "request_id": "req_123",
  "user_id": "user_456",
  "contract": "contract_address",
  "entry_point": "claim",
  "transaction": {
    "payload": "..."
  }
}
```

Example response:

```json
{
  "request_id": "req_123",
  "status": "approved",
  "transaction_id": "tx_789"
}
```

---

## 18.2 Get Sponsorship Status

```http
GET /v1/sponsorship/requests/{request_id}
```

Example:

```json
{
  "request_id": "req_123",
  "status": "confirmed",
  "transaction_id": "tx_789",
  "sponsored_dust": "0.04"
}
```

---

## 18.3 Usage

```http
GET /v1/usage
```

Should expose authorized operational metrics such as:

- total DUST sponsored,
- current period usage,
- remaining budget,
- successful requests,
- rejected requests,
- usage by user/credential,
- usage by contract,
- usage by entry point.

---

# 19. Dashboard

The MVP dashboard should provide a simple operational control plane.

## 19.1 Overview

Display:

- sponsor wallet balance,
- DUST sponsored,
- remaining budget,
- successful sponsorships,
- rejected requests,
- active policy.

## 19.2 Transactions

Display:

- request ID,
- user/credential,
- contract,
- entry point,
- DUST amount,
- timestamp,
- status,
- transaction ID.

## 19.3 Policy

Allow operators to configure:

- contract allowlists,
- entry-point allowlists,
- global budget,
- per-user limits,
- per-transaction limits,
- rate limits.

## 19.4 Usage

Visualize:

```text
DUST usage over time
Usage by contract
Usage by entry point
Usage by user/credential
Rejected sponsorship requests
```

---

# 20. Data Model

AetherDust should maintain records for at least:

## Application

```text
id
name
credential
status
created_at
```

## Sponsorship Policy

```text
id
application_id
allowed_contracts
allowed_entry_points
global_budget
per_user_budget
per_transaction_limit
rate_limit
period
enabled
created_at
updated_at
```

## Sponsorship Request

```text
id
application_id
user_id/credential
contract
entry_point
transaction_reference
requested_dust
approved_dust
status
rejection_reason
transaction_id
created_at
updated_at
```

## Usage Record

```text
id
request_id
application_id
user_id/credential
dust_consumed
timestamp
```

---

# 21. Security Requirements

Security is a core product requirement because AetherDust controls a funded sponsor account.

## 21.1 User Key Isolation

AetherDust must not require user private keys.

## 21.2 Sponsor Credential Protection

Sponsor wallet credentials must never be exposed through public API responses.

## 21.3 Fail-Closed Policies

If policy evaluation fails, sponsorship should not proceed.

## 21.4 Spending Controls

All sponsorship must pass configured limits before execution.

## 21.5 Replay Protection

Idempotency and request tracking must prevent unintended duplicate sponsorship.

## 21.6 Authentication

Unauthenticated callers must not be able to trigger sponsorship.

## 21.7 Rate Limiting

Abusive request volumes must be blocked before sponsor resources are consumed.

## 21.8 Auditability

Every sponsorship decision should produce an auditable record:

```text
who requested
what was requested
which policy was evaluated
whether it was approved
how much DUST was sponsored
what transaction resulted
```

---

# 22. Privacy Requirements

AetherDust should minimize unnecessary user information.

MVP may use a DApp-provided user/credential identifier for enforcing limits.

The system should avoid requiring unnecessary personal identity information.

### Future privacy direction

A later version may support privacy-preserving allowance mechanisms, including compact/ZK-based proofs or private usage limits.

These are explicitly outside MVP scope.

---

# 23. Error Handling

AetherDust should return machine-readable errors.

Example:

```json
{
  "error": {
    "code": "BUDGET_EXCEEDED",
    "message": "Sponsorship budget exceeded."
  }
}
```

Core error codes:

```text
AUTH_FAILED
INVALID_REQUEST
RATE_LIMITED
CONTRACT_NOT_ALLOWED
ENTRY_POINT_NOT_ALLOWED
GLOBAL_BUDGET_EXCEEDED
USER_LIMIT_EXCEEDED
TRANSACTION_LIMIT_EXCEEDED
PREFLIGHT_FAILED
SPONSOR_BALANCE_LOW
SPONSORING_FAILED
SUBMISSION_FAILED
TIMEOUT
DUPLICATE_REQUEST
```

---

# 24. Reliability Requirements

AetherDust should:

- use explicit transaction states,
- support retries for safe operations,
- avoid duplicate sponsorship,
- persist sponsorship records,
- recover request state after service restart,
- distinguish retryable from non-retryable errors.

A failed API response must not automatically imply that sponsorship did not happen.

The final transaction state must be recoverable from persistent state and/or the Midnight network.

---

# 25. Observability

The system should expose:

### Metrics

- sponsorship requests/sec,
- successful sponsorship rate,
- rejection rate,
- average sponsorship amount,
- total DUST sponsored,
- remaining budget,
- sponsor wallet balance,
- transaction confirmation latency.

### Logs

Each request should be traceable using:

```text
request_id
transaction_id
application_id
```

Sensitive secrets must never be logged.

---

# 26. Deployment

AetherDust must be self-hostable.

Target deployment:

```text
Docker
   │
   ├── AetherDust API
   ├── Policy Engine
   ├── Sponsorship Worker
   ├── Database
   └── Dashboard
```

Configuration should be environment-variable based.

Example:

```env
AETHERDUST_DATABASE_URL=
AETHERDUST_API_KEY=
AETHERDUST_SPONSOR_CONFIG=
MIDNIGHT_NETWORK=
MIDNIGHT_RPC_URL=
```

Secrets must be supplied through secure deployment configuration rather than committed to source control.

---

# 27. MVP Scope

## Must Have

### Sponsorship

- real DUST sponsorship,
- sponsor wallet integration,
- sponsorship relay/API.

### Policy

- contract allowlist,
- entry-point allowlist,
- global budget,
- per-user/credential limits,
- per-transaction limit.

### Protection

- authentication,
- rate limiting,
- idempotency,
- basic pre-flight validation.

### Operations

- transaction status,
- DUST usage tracking,
- dashboard,
- audit records.

### Deployment

- Docker/self-hosting,
- configuration through environment variables,
- documented setup.

---

# 28. Post-MVP Scope

The following should not block the MVP.

## Should Have

- richer transaction simulation,
- advanced analytics,
- alerts,
- webhooks,
- sponsorship campaigns,
- multiple sponsor accounts,
- richer policy conditions.

## Future

- privacy-preserving usage limits,
- ZK-based allowance proofs,
- advanced private accounting,
- more sophisticated identity/credential systems,
- automated sponsor funding workflows.

---

# 29. Acceptance Criteria

AetherDust MVP is considered functional when all of the following are true:

### AC1 — Sponsored transaction

A DApp can submit an eligible user transaction and have the sponsor provide the required DUST.

### AC2 — User key preservation

The user can authorize the transaction without giving AetherDust their private key.

### AC3 — Contract restriction

A transaction targeting a non-allowlisted contract is rejected.

### AC4 — Entry-point restriction

A transaction targeting a non-allowlisted entry point is rejected.

### AC5 — Global budget

Once the configured global sponsorship budget is exhausted, additional requests are rejected.

### AC6 — User limit

A user exceeding their sponsorship allowance is rejected.

### AC7 — Transaction limit

A transaction exceeding the configured per-transaction limit is rejected.

### AC8 — Rate limiting

Excessive requests are rejected without triggering sponsorship.

### AC9 — Idempotency

Retrying the same sponsorship request does not unintentionally consume sponsorship twice.

### AC10 — Status tracking

The operator can follow a sponsorship request from submission through confirmation or failure.

### AC11 — Usage tracking

The dashboard accurately reflects DUST sponsorship consumption.

### AC12 — Self-hosting

A developer can deploy the system using Docker and configure it for a Midnight environment.

---

# 30. Example End-to-End Scenario

Imagine a Midnight DApp called `ExampleDApp`.

The operator configures:

```text
Global daily budget:       100 DUST
Per-user daily budget:       1 DUST
Per-transaction maximum:     0.1 DUST

Allowed contract:
    ExampleContract

Allowed entry points:
    register
    claim
```

A new user opens the application.

The user has:

```text
DUST balance: 0
```

They click:

```text
Claim
```

The DApp creates the transaction.

The user authorizes it.

The DApp sends the sponsorship request to AetherDust.

AetherDust checks:

```text
✓ Application authenticated
✓ Contract allowed
✓ Entry point allowed
✓ User below limit
✓ Global budget available
✓ Transaction below maximum
✓ Request within rate limit
✓ Basic pre-flight passed
```

AetherDust approves the request.

The sponsor wallet provides the required DUST.

Midnight processes the transaction.

AetherDust records:

```text
Status: CONFIRMED
Sponsored: 0.04 DUST
User usage: 0.04 / 1 DUST
Global usage: 37.04 / 100 DUST
```

The user experiences the application without needing to acquire DUST first.

---

# 31. Example Rejected Scenario

A malicious or accidental request attempts:

```text
Contract: UnknownContract
Entry point: drain
Requested sponsorship: 50 DUST
```

AetherDust evaluates the request.

```text
Contract allowlist: FAIL
```

The request is rejected immediately.

No sponsor DUST is spent.

```json
{
  "status": "rejected",
  "error": {
    "code": "CONTRACT_NOT_ALLOWED"
  }
}
```

This illustrates the core value of AetherDust:

> **Sponsorship is permissioned, bounded, and observable rather than an unrestricted funded wallet endpoint.**

---

# 32. Developer Integration

The ideal integration should be small.

Conceptually:

```typescript
const result = await aetherDust.sponsor({
  requestId,
  userId,
  transaction,
});
```

The DApp should not need to implement:

- sponsor accounting,
- spending limits,
- policy evaluation,
- rate limiting,
- DUST usage accounting,
- transaction status infrastructure.

AetherDust provides these as infrastructure.

---

# 33. Product Principles

### Principle 1 — User signs, sponsor pays

The user's authorization remains distinct from sponsorship.

### Principle 2 — Policy before money

No sponsor funds should be committed before policy checks succeed.

### Principle 3 — Least privilege

Only explicitly allowed actions should be sponsorable.

### Principle 4 — Fail closed

Ambiguity or policy failure should result in rejection, not sponsorship.

### Principle 5 — Observable by default

Every sponsorship decision should be traceable.

### Principle 6 — Self-hostable

The DApp operator should be able to run its own infrastructure.

### Principle 7 — Keep the MVP narrow

AetherDust should solve sponsorship infrastructure rather than becoming a general Web3 platform.

---

# 34. Success Metrics

For an MVP/demo, success is demonstrated by:

### Functional

- successful end-to-end sponsored transaction,
- successful rejection of unauthorized transactions,
- working budget enforcement,
- working per-user limits,
- working rate limiting,
- working idempotency.

### Operational

- accurate DUST accounting,
- recoverable transaction state,
- useful dashboard,
- reproducible Docker deployment.

### Developer Experience

A developer should be able to understand the integration from the documentation and connect a DApp without implementing a custom sponsorship infrastructure layer.

---

# 35. MVP Definition in One Sentence

**AetherDust is a self-hostable control plane that lets Midnight DApps sponsor user transactions with DUST while enforcing authentication, allowlists, spending limits, rate limits, pre-flight checks, and usage tracking—without taking custody of user private keys.**

---

# 36. Future Product Direction

The long-term direction is to make AetherDust the **policy and privacy layer for sponsored interactions on Midnight**.

The progression is:

```text
MVP
│
├── DUST sponsorship
├── Policy engine
├── Budgets
├── User limits
├── Rate limiting
└── Dashboard
     │
     ▼
Advanced
│
├── Rich simulation
├── Alerts
├── Webhooks
├── Multiple sponsor accounts
└── Campaigns
     │
     ▼
Privacy Layer
│
├── Private allowances
├── ZK usage proofs
├── Private accounting
└── Privacy-preserving sponsorship policies
```

The fundamental product relationship remains unchanged:

```text
USER AUTHORIZES
       ↓
AETHERDUST POLICY-CHECKS
       ↓
SPONSOR PAYS
       ↓
MIDNIGHT SETTLES
```

That is the core of AetherDust.
