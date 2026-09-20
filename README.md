# ScreenCloud Order Management System

A backend for quoting and submitting orders for ScreenCloud's SCOS Station P1 Pro. Creating an order record is the easy part; the interesting part is finding the cheapest way to fulfill it across six warehouses, and keeping inventory correct when two sales reps hit submit on the last few units at the same time.

The goal was to keep the solution simple where the brief allows it, and treat the parts that matter — pricing, allocation, concurrency — like production code.

## The problem

The SCOS Station P1 Pro costs **$150** and weighs **365 g**. Orders qualify for the largest discount they reach: **5% at 25 units, 10% at 50, 15% at 100, 20% at 250**. Stock is spread across six warehouses:

| Warehouse | Coordinates | Stock |
| --- | --- | --- |
| Los Angeles | 33.9425, -118.408056 | 355 |
| New York | 40.639722, -73.778889 | 578 |
| São Paulo | -23.435556, -46.473056 | 265 |
| Paris | 49.009722, 2.547778 | 694 |
| Warsaw | 52.165833, 20.967222 | 245 |
| Hong Kong | 22.308889, 113.914444 | 419 |

Shipping costs **$0.01 per kilogram per kilometre**, and an order can draw stock from several warehouses at once. If the cheapest possible shipping still exceeds **15% of the discounted order total**, the order is invalid — full stop, no partial fulfillment workaround.

That leads to two workflows, plus a way to look one up afterward:

| Endpoint | Behaviour |
| --- | --- |
| `POST /v1/order-quotes` | Simulate price, discount, shipping, and allocation without touching inventory. |
| `POST /v1/orders` | Recalculate against live stock, commit atomically, and deduct inventory immediately. |
| `GET /v1/orders/:orderNumber` | Return the amounts and allocation exactly as they were at submission. |

Those three satisfy the brief's functional requirements. TypeScript, PostgreSQL, OpenAPI docs, Docker, and the testing strategy below satisfy its technical ones.

## Architecture at a glance

The service is a modular monolith: a single deployable with clear internal boundaries, rather than a distributed system built for a scale six warehouses don't require.

```mermaid
flowchart TD
    API[Fastify API] --> App[Application use cases]
    App --> Domain[Pricing, allocation and validity rules]
    App --> Ports[Repository and transaction interfaces]
    Adapters[PostgreSQL adapters] -. implement .-> Ports
    Adapters --> DB[(PostgreSQL)]
```

The domain layer has no idea Fastify, `postgres`, or AWS exist — no HTTP objects, no SQL, no imports pointing outward. The submission use case orchestrates a unit of work; it doesn't write queries itself.

```text
src/
  presentation/     HTTP routes, auth, validation, OpenAPI and startup
  application/      Quote, submit and retrieve workflows; transaction port
  domain/           Pricing, allocation and validity rules, models
  infrastructure/   PostgreSQL adapters, migrations, outbox and metrics
tests/
  unit/             Calculations without I/O
  integration/      API, persistence and concurrency against real PostgreSQL
infra/pulumi/       AWS deployment definition
```

If the shipping algorithm needs to change, nothing in `presentation/` should care. If PostgreSQL is swapped out, `domain/` doesn't notice.

## Design decisions that matter

### The greedy allocation is provably optimal — for this tariff

```text
shipping cost per device = distanceKm × 0.365 kg × $0.01/(kg·km)
```

Cost per unit is fixed per warehouse and purely linear in quantity, with zero cost for touching an additional warehouse. The allocator computes Haversine distance to all six, sorts by distance (warehouse ID breaks ties), and fills from the cheapest first. **Exchange argument**: if any valid plan uses a pricier warehouse while a cheaper one still has stock, moving one unit from the pricier to the cheaper warehouse strictly reduces cost without changing the total shipped. Repeat until no such pair exists, and you've reached the minimum. That's **O(W log W)** time, **O(W)** space — this depends entirely on the tariff being linear with no per-shipment fee; a flat fee per warehouse touched turns this into a knapsack-flavoured problem and greedy stops being optimal.

### A quote is a simulation; a submission is a transaction

A quote reads current stock and shows what *would* happen — it changes nothing and can go stale the instant someone else orders the last unit. Submission is where correctness actually has to hold: one PostgreSQL transaction that locks all six warehouse rows in ascending ID order, recalculates pricing and allocation against the now-locked stock, and only then writes the order, its allocations, inventory deductions, an audit record, and an outbox event. Commit or nothing.

Locking every warehouse row per submission is the simplest correct thing that could work, and it serializes submissions against each other — an explicit throughput trade-off, not an oversight. Quotes stay lock-free reads. Ascending-ID lock order is what prevents two concurrent submissions from deadlocking each other over the same two warehouses.

An `Idempotency-Key` header covers the case where an order succeeds but the HTTP response gets lost: an identical retry replays the stored order; reusing the key with different input returns `409`. That guarantee is per-key, not per-caller — see [Known limitations](#known-limitations).

### Orders are snapshots, not live pointers

Money is integer cents throughout; each warehouse's shipping charge is rounded to the cent *before* summing, and the 15% ceiling is rounded down so rounding can never let a borderline order sneak through. Everything used to price an order — unit price, discount tier, shipping rate, the threshold itself — is copied onto the order row at submission time, and `order_allocations` preserves exactly which warehouses shipped what, at what distance and cost. Change the price table next week and every historical order still reads back exactly as it was confirmed.

## Data model

```text
products            One row: the SCOS Station P1 Pro. Price and weight, not hardcoded constants.
warehouses           Six rows: location and live stock.
pricing_rules        Discount tiers and shipping tariff as data, not code — versioned by is_active + created_at.
orders               One row per submission: full pricing/shipping snapshot, order number, idempotency key.
order_allocations    Per-warehouse breakdown of a committed order: quantity, distance, cost.
idempotency_keys     Claims a key to one order id, so a concurrent duplicate resolves instead of racing.
inventory_audit_log  Every stock delta, signed with a reason and (self-reported) sales rep id.
outbox_events        Pending domain events for eventual external publication (see below).
```

`order_allocations` exists because "shipping cost: $427" isn't very useful to anyone actually fulfilling the order if you can't say which 120 units came from where.

## API

Business endpoints and `/docs` require `Authorization: Bearer <API_TOKEN>` (constant-time comparison, one shared token — see [Known limitations](#known-limitations)); `/health` and `/ready` are public.

| Method & path | Purpose |
| --- | --- |
| `POST /v1/order-quotes` | Quote an order without side effects |
| `POST /v1/orders` | Submit and commit an order (supports `Idempotency-Key`) |
| `GET /v1/orders/:orderNumber` | Retrieve a committed order |
| `GET /api/v1/warehouses` | Current stock per warehouse |
| `GET /api/v1/alerts/stock` | Warehouses at or below 50 units |
| `GET /metrics` | Prometheus-formatted counters and stock gauges |
| `GET /health`, `GET /ready` | Liveness / readiness (public) |
| `GET /docs`, `GET /docs/json` | Swagger UI / OpenAPI spec |

Errors follow `application/problem+json` (RFC 7807 shape): `type`, `title`, `status`, `detail`.

## Known limitations

Deliberate scope cuts and gaps worth being explicit about:

- **The shared bearer token is a trust boundary, not identity.** `x-sales-rep-id` is a client-supplied header written straight into the audit log with no verification — anyone holding the one token can attribute an order to any rep string. Fine for a demo; not fine once there's more than one caller who might lie.
- **Idempotency keys are global, not per-caller, with two different failure modes depending on what collides.** The key is matched against a fingerprint of `(quantity, coordinates, salesRepId)`. If two callers reuse the same key with a *matching* fingerprint (same input, same or both-omitted `salesRepId`), the second caller silently receives the first caller's order back as a successful "replayed" response — not an error, and nothing distinguishes it from having submitted that order themselves. Only a fingerprint *mismatch* on a reused key returns `409 IDEMPOTENCY_CONFLICT`. There's currently no caller identity to scope keys by — see the point above.
- **No rate limiting.** A leaked token allows unbounded quote/order traffic today.
- **No CORS policy or security-header middleware.** Reasonable for a token-gated backend API with no browser client, but not a decision I want to leave implicit.
- **No inventory reservation during a quote.** Intentional — quotes are advisory by design — but worth stating plainly.
- Haversine distance, not carrier routing; one product, not a catalog. Both match the brief; a real multi-product system needs order lines and inventory keyed by product *and* warehouse.

## Testing strategy

```text
Unit          discount tiers, distance math, allocation, validity boundaries — no I/O
Integration   real PostgreSQL: HTTP → persistence → response, migrations, outbox
Concurrency   two connection pools racing the same warehouse; opposing-warehouse-preference
              deadlock; concurrent idempotent duplicates; concurrent outbox drain with
              FOR UPDATE SKIP LOCKED; concurrent migrations on overlapping startups
```

The concurrency tests use genuinely separate connection pools racing each other, not mocked locks — that's where an in-memory allocator would lie to you about correctness.

## Run locally

You need Git and a running Docker engine with Docker Compose v2. The Docker setup runs both the API and PostgreSQL; it needs no AWS or Pulumi setup and no local Node.js installation. Keep ports **3000** and **5432** available. Commands below use a macOS/Linux shell or WSL.

### 1. Get the code and local settings

```sh
git clone https://github.com/heisenberg967/scloudoms.git
cd scloudoms
cp .env.example .env
```

If you already have the code, start in the project root and create `.env` only if it does not exist. The example values work as supplied for local development. `.env` is ignored by Git; its sample password and token must not be used for a public deployment.

### 2. Start the application

```sh
docker compose up --build -d --wait
curl --fail http://localhost:3000/ready
```

The readiness response should contain `"status":"READY"` and `"database":"CONNECTED"`. Startup creates the schema and seeds the product, pricing rules, and six warehouses automatically. No separate migration or seed command is needed.

### 3. Try the API

The API is at **http://localhost:3000**. Health endpoints are public; business endpoints and documentation require the `API_TOKEN` from `.env`. This request uses the supplied development token; replace the header value if you changed it:

```sh
curl --fail-with-body http://localhost:3000/v1/order-quotes \
  -H 'Authorization: Bearer local-development-token-change-before-deployment' \
  -H 'Content-Type: application/json' \
  -d '{"quantity":30,"customerCoordinates":{"latitude":40.7128,"longitude":-74.006}}'
```

The response includes pricing, warehouse allocation, shipping, and `isValid`, without changing inventory. To submit, send the same request to `/v1/orders` with `-H 'Idempotency-Key: local-order-1'`. This deducts stock and returns an `orderNumber`, which you can retrieve at `/v1/orders/:orderNumber` with the same authorization header. An identical retry with the same key returns the existing order.

Other endpoints include `/api/v1/warehouses` for stock, `/api/v1/alerts/stock` for low-stock warehouses, `/metrics`, and `/docs/json` for OpenAPI. Swagger UI at `/docs/` also requires the authorization header; see the development option below for ordinary browser access.

### Stop, inspect, or reset

```sh
docker compose logs --tail=100 app postgres  # Diagnose startup or request failures
docker compose down                        # Stop containers; keep database contents
```

Orders and stock persist in a Docker volume across restarts. To deliberately **delete all local database contents**, run `docker compose down --volumes`, then repeat the startup command to get fresh seed data.

### Develop with live reload

For editing code, install **Node.js 22.14+ and npm**. After the clone and `.env` steps above, run PostgreSQL in Docker and the API on your machine:

```sh
docker compose stop app
docker compose up -d --wait postgres
npm ci
HOST=127.0.0.1 npm run dev
```

The API reloads when source files change. The npm scripts load `.env` automatically; `DATABASE_URL` connects to PostgreSQL on localhost. Stop the API with Ctrl+C. To run the compiled application instead, use `npm run build && HOST=127.0.0.1 npm start`.

For local Swagger UI access without a header-injecting client, stop the development server and run `HOST=127.0.0.1 API_TOKEN= npm run dev`, then open **http://localhost:3000/docs/**. This explicitly disables authentication for the development server bound to localhost; the Docker configuration continues to require a token.

## Test it

With Node.js 22.14+ installed and `.env` created as above, run from the project root:

```sh
docker compose up -d --wait postgres
npm ci
npm test
npm run lint
```

The API does not need to be running. Tests use `TEST_DATABASE_URL` from `.env` and create isolated schemas in PostgreSQL, leaving application orders and stock untouched. Unavailable PostgreSQL fails the integration suite. `npm run test:unit` runs only the unit tests and needs no database.

## Deployment

Cloud hosting and CI/CD are explicitly optional for this challenge — everything above stands on its own via Docker Compose. This section exists to show the design, not to compensate for a weak local story.

```text
Client --HTTPS--> API Gateway --HTTP via VPC Link--> private ALB --HTTP--> Fargate task --> RDS PostgreSQL
```

GitHub Actions runs CI (Postgres-backed tests on Node 22 & 24, typecheck, Docker build) on pushes to `main` and on pull requests targeting it — a push to a feature branch alone doesn't trigger it. A manual **Deploy** workflow (`workflow_dispatch`, `main` only) authenticates to AWS via OIDC — no long-lived AWS keys in GitHub — and runs Pulumi against a single `demo` stack with state in a private S3 bucket:

1. Re-run CI checks.
2. Assume the deployment role via OIDC.
3. `pulumi preview`, then `pulumi up` — builds and publishes the Docker image to ECR, deploys its digest to one Fargate task.
4. Confirm the running task definition matches the published image digest.
5. Run `scripts/smoke.mjs` against the live URL: readiness, auth rejection, a real quote, a real order submission, an idempotent retry, retrieval, and the OpenAPI document.

Pulumi provisions ECR, an API Gateway HTTP API, a private ALB, one Fargate task, private single-AZ RDS PostgreSQL, CloudWatch logs, and Secrets Manager entries for the database URL and API token. **API Gateway terminates HTTPS** on its own generated `execute-api.amazonaws.com` certificate — no domain purchase or DNS zone needed — and reaches the ALB over plain HTTP through a VPC Link; the ALB itself only accepts traffic from the VPC Link's security group. The Fargate task sits in a public subnet with inbound access restricted to the ALB's security group, which avoids paying for a NAT gateway while keeping the task's only inbound path through the load balancer. One task and a single-AZ database trade redundancy for cost, deliberately, for a graded demo.

An earlier version of this put CloudFront in front of the ALB instead, for the same reason (free HTTPS with no domain). It was abandoned mid-deployment: AWS rejected `CreateDistributionWithTags` with `AccessDenied: Your account must be verified before you can add new CloudFront resources`, a manual account-verification gate on new/recently-changed accounts with no defined turnaround time. API Gateway's HTTP API + VPC Link gives the same result — a public HTTPS endpoint with an AWS-issued certificate over a private origin — without that gate.

**Access model:** the deployed API is authenticated the same way as local — one bearer token, checked with a constant-time comparison. The token is stored encrypted in `infra/pulumi/Pulumi.demo.yaml` (safe to commit — Pulumi decrypts it with a stack passphrase that isn't in the repo) and injected into the running task via Secrets Manager; that authentication check, not the URL, is what actually protects the deployment. The API Gateway URL itself isn't secret — anyone who has it and a valid token can call it. I'm not publishing the URL or a live token in this README simply so the public repo doesn't invite unsolicited traffic against a resource-limited, real-money demo account; ask and I'll share both directly.

**Status as of this submission:** GitHub Actions repository variables/secrets (`AWS_ROLE_ARN`, `PULUMI_BACKEND_URL`, `PULUMI_CONFIG_PASSPHRASE`) are set, and the OIDC trust and deployer role exist in AWS. The deployer IAM *policy document* in this repo (`infra/iam/sc-deployer-policy.json`) was updated for the API Gateway/VPC Link resources added above, but editing that file doesn't update AWS by itself — the live policy attached to the role needs to be synced to it before a deploy using it will succeed. Treat "deployed and verified" as a status to confirm at review time, not assume from this document.

## What I'd do next

If this graduated from challenge to real project, roughly in order of urgency:

- **Identity and permissions** — replace the shared token with the company identity provider, authorize sales/ops roles, and derive `sales_rep_id` from a verified claim instead of a client-supplied header.
- **Rate limiting** on the API, now that there's a plan for who's allowed to call it and how much.
- **Idempotency keys scoped per caller** once there's a caller identity to scope them by.
- **Database operations** — a restricted runtime DB role separate from the migration role, and a proven backup-restore drill, before trusting this with real inventory.
- **Monitoring** — request latency and lock-wait histograms, dashboards, alert routing, and an outbox-backlog alarm; the current counters and stock gauges are a start, not a monitored production deployment.
- **Capacity** — load-test representative quote/submit traffic and set connection-pool budgets and timeouts from real numbers, rather than the current "lock all six warehouses" default. Revisit that locking strategy only if measured contention justifies something more complex.
- **An external event publisher** for the outbox (currently events sit `PENDING` — the dispatcher, retries, and at-least-once delivery all work, there's just nowhere configured to send them yet). That unlocks warehouse fulfillment, conversion analytics, or a data warehouse feed without touching order submission.
- **Multi-product support** if the catalog ever grows past one SKU — needs order lines and inventory keyed by product *and* warehouse, not just warehouse.

## Tech stack

TypeScript · Node.js · Fastify · PostgreSQL (`postgres` driver, hand-written SQL and migrations) · Zod · Vitest · Docker · Pulumi · AWS (ECS Fargate, RDS, ALB, API Gateway, ECR, Secrets Manager) · GitHub Actions
