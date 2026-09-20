# ScreenCloud Order Management System

## What this is

ScreenCloud sells a device called the SCOS Station P1 Pro, and the sales team needed a way to quote and place orders for it. That's the brief in one sentence. The interesting part isn't "build a form that writes to a database" — it's two harder problems hiding underneath:

1. The device ships from six warehouses around the world, and shipping is charged by weight and distance. So for any order, you need to figure out the *cheapest possible way* to fulfill it — possibly splitting it across several warehouses — and reject it outright if shipping still comes out too expensive.
2. Two sales reps can try to buy the last few units at the same second. Whatever the system decides, it can't sell more devices than physically exist.

Everything else — the discount tiers, the API shape, the database schema — exists in service of getting those two things right.

**The device**: SCOS Station P1 Pro, $150, 365g. **Volume discounts**: 5% at 25 units, 10% at 50, 15% at 100, 20% at 250. **Shipping**: $0.01 per kilogram per kilometre, and if the cheapest possible shipping still exceeds 15% of the discounted total, the order is invalid — no exceptions, no partial fulfillment loophole.

**Technical asks from the brief**: TypeScript, a real database, a documented API, a clear testing strategy, trivial local setup, and an optional cloud deployment with CI/CD. Opinionated frameworks like NestJS were specifically discouraged.

## Final result

- **Live API**: `https://kl4ds7ecj0.execute-api.us-east-1.amazonaws.com/` — real HTTPS, running on AWS right now, not a screenshot of `localhost`.
- **Swagger docs**: same host, `/docs/`. It's gated behind a bearer token like every other business route here — this is shared via email along with this submission.
- **Repo**: `https://github.com/heisenberg967/scloudoms`

**Swagger, live**, listing every route behind the bearer token:

![Swagger UI showing the SCOS OMS API routes](assets/swagger-docs.png)

**A real quote request against the live deployment** (token redacted — same rule as everywhere else in this README):

![Sample order-quote request and response from the live API](assets/sample-quote-request.png)

What actually works, the TL;DR is: quoting and submitting orders with correct discounts, cheapest-first multi-warehouse allocation, the 15% shipping cap enforced properly, orders that survive concurrent submissions without overselling stock, idempotent retries, full order history with historically-accurate snapshots, and a CI/CD pipeline that actually deploys this to AWS behind real HTTPS on every manual trigger — not just a GitHub Actions badge that's never been tested.

## Running the app

### Option 1 — the live one

Hit the deployed API directly. You'll need a bearer token (shared via email):

```sh
API=https://kl4ds7ecj0.execute-api.us-east-1.amazonaws.com
TOKEN=your-token-here

curl $API/health   # public, no token needed
curl $API/ready    # public, no token needed

curl $API/v1/order-quotes \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"quantity":30,"customerCoordinates":{"latitude":40.7128,"longitude":-74.006}}'
```

Fair warning: any order you *submit* against the live deployment deducts from real (small) seeded stock, and there's no reset button short of tearing the stack down and redeploying. Quote away freely; submit sparingly.

### Option 2 — locally, which is genuinely easier

You need Git and Docker (with Compose v2). That's it — no Node install, no AWS account, no Pulumi.

```sh
git clone https://github.com/heisenberg967/scloudoms.git
cd scloudoms
cp .env.example .env
docker compose up --build -d --wait
curl --fail http://localhost:3000/ready
```

That last command should come back with `"status":"READY"` and `"database":"CONNECTED"`. Startup builds the schema and seeds the product, pricing rules, and all six warehouses automatically — there's no separate migration or seed step to remember.

Try it:

```sh
curl --fail-with-body http://localhost:3000/v1/order-quotes \
  -H 'Authorization: Bearer local-development-token-change-before-deployment' \
  -H 'Content-Type: application/json' \
  -d '{"quantity":30,"customerCoordinates":{"latitude":40.7128,"longitude":-74.006}}'
```

To actually submit it (deducts stock, returns an order number), send the same body to `/v1/orders`:

```sh
curl --fail-with-body http://localhost:3000/v1/orders \
  -H 'Authorization: Bearer local-development-token-change-before-deployment' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: local-order-1' \
  -d '{"quantity":30,"customerCoordinates":{"latitude":40.7128,"longitude":-74.006}}'
```

That `Idempotency-Key` header is just a string *you* make up — the server doesn't hand one out, you pick something unique per order attempt (a UUID, a request ID from whatever's calling this, anything). Here's why it exists: imagine the order goes through, stock gets deducted, an order number gets generated — and then the network drops before your client ever sees the response. Do you retry? If there were no idempotency key, retrying would create a *second* real order and deduct stock twice for something that already succeeded once. With the key, retrying the exact same request (same key, same input) just returns the original order back — no duplicate, no double deduction. Reuse the same key with genuinely different input (different quantity, say), and you get a `409` instead, because that's not a retry, that's a mistake. It's optional — leave the header off and every submission is treated as new — but for anything that might get retried by a flaky connection or an eager client, it's the difference between "safe to retry" and "don't you dare retry."

Retrieve the order later at `/v1/orders/:orderNumber` using the `orderNumber` from the response above. Everything else — `/api/v1/warehouses`, `/metrics`, `/docs`, tearing it down, developing with live reload — is covered in [Local development, in full](#local-development-in-full) near the bottom, so this section doesn't turn into a novel.

## Technical design

### Repo structure

```text
src/
  presentation/     HTTP routes, auth, validation, OpenAPI, startup
  application/      Quote, submit and retrieve workflows; the transaction port
  domain/           Pricing, allocation and validity rules — the actual brain
  infrastructure/   PostgreSQL adapters, migrations, outbox, metrics
tests/
  unit/             Pure calculations, no I/O
  integration/      Real PostgreSQL — HTTP through to persistence and back
infra/pulumi/       The AWS deployment, as code
```

The rule I held myself to: `domain/` doesn't know Fastify, PostgreSQL, or AWS exist. Not one import. If I want to swap the allocation algorithm, I shouldn't have to think about how routes are registered. If I want to swap the database, the pricing rules shouldn't notice.

### Architecture

```mermaid
flowchart TD
    API[Fastify API] --> App[Application use cases]
    App --> Domain[Pricing, allocation and validity rules]
    App --> Ports[Repository and transaction interfaces]
    Adapters[PostgreSQL adapters] -. implement .-> Ports
    Adapters --> DB[(PostgreSQL)]
```

Dependencies only point one direction. `SubmitOrderUseCase` orchestrates the flow but doesn't contain a single line of SQL — it asks a `IOrderUnitOfWork` to do the work and trusts it to come back with either a committed order or a clear error.

Here's the part that actually matters, shown as a sequence rather than described in prose — two sales reps racing for the same stock:

```mermaid
sequenceDiagram
    participant A as Rep A
    participant B as Rep B
    participant DB as PostgreSQL

    Note over DB: 10 units left, one warehouse
    A->>DB: BEGIN, lock warehouse rows
    B->>DB: BEGIN, lock warehouse rows (waits)
    A->>DB: recalculate, deduct 8, commit
    DB-->>A: order confirmed
    Note over DB: 2 units left
    B->>DB: lock granted, recalculate against current stock
    DB-->>B: INSUFFICIENT_STOCK (only 2 left, wanted 8)
```

Both reps could've received a valid *quote* for 8 units — quotes read stock without locking anything, because they don't change anything. Only one of them can actually get 8 units, and the system tells the loser exactly why, rather than silently overselling or throwing a generic 500.

### Key design decisions

**A quote is a guess; a submission is a promise.** Quoting reads current stock and shows you what *would* happen. It doesn't reserve anything, because reserving stock for a sales rep who's still on the phone with a customer creates its own headaches (what if they never call back?). Submission is where correctness has to actually hold, so it recalculates everything against locked, current stock inside one transaction.

**The transaction boundary is the whole warehouse table, not just the rows being touched.** Submission locks all six warehouse rows, in ascending ID order, before doing anything else. That last part — the fixed lock order — is what stops two concurrent submissions from deadlocking each other by grabbing the same two warehouses in opposite order. Locking all six instead of just the ones an order touches is the simplest thing that's obviously correct; it does serialize submissions against each other, which is a real throughput ceiling I'm accepting on purpose rather than by accident.

**Money lives in integer cents, always.** Floating point and currency don't mix — ask anyone who's had a shopping cart total off by a cent. Distance math still uses floating point (you can't avoid it for Haversine), but each warehouse's shipping charge gets rounded to the cent *before* being summed, and the 15% ceiling itself is rounded down rather than up, so a fractional cent can never sneak an order across the validity line.

**Why PostgreSQL, specifically.** This problem is fundamentally about correctness under concurrency — I needed real transactions, row-level locking, and `SELECT ... FOR UPDATE`, not eventual consistency and a promise it'll sort itself out. A relational database with proper ACID guarantees was the only honest choice for "don't oversell the last device."

**Why a modular monolith, not microservices.** Six warehouses and one product is not a scale problem — it's a correctness and clarity problem. Splitting this into services would mean distributed transactions for something that fits comfortably in one PostgreSQL transaction today, plus network calls and retry logic replacing what is currently a function call. The internal boundaries (domain / application / infrastructure) are real, though, so if this genuinely needed to scale out later, the seams already exist.

### Core algorithms & patterns

**Cheapest-first allocation, proven optimal (for this tariff).** Shipping cost per device from a given warehouse is:

```text
distanceKm × 0.365 kg × $0.01/(kg·km)
```

That's a fixed, linear cost per unit, per warehouse. The allocator computes the Haversine distance to all six warehouses, sorts by distance, and fills the order from the cheapest warehouse first, then the next, until the quantity's met. Warehouse ID breaks distance ties. That's it — no search, no optimization solver.

Is greedy actually optimal here? Yes, and the proof is a one-line exchange argument: if any valid allocation ships from a pricier warehouse while a cheaper one still has stock, moving a unit from the pricier one to the cheaper one strictly lowers total cost without changing how many units shipped. Repeat that swap until no such pair exists, and you've found the cheapest possible allocation. Runs in **O(W log W)** time for `W` warehouses — the sort dominates. This falls apart the moment shipping stops being linear — say, a flat $5 handling fee per warehouse touched — at which point it becomes a variant of facility location / knapsack, and greedy is no longer guaranteed optimal. `IFulfillmentOptimizer` exists as an interface specifically so that swap wouldn't require touching anything else.

**Patterns doing real work, not resume padding:**
- **Repository pattern** (`IWarehouseRepository`, `IOrderRepository`, `IProductRepository`, `IPricingRuleRepository`) — the domain asks for data through interfaces it owns; PostgreSQL adapters implement them. Swapping the database means writing new adapters, not touching a single use case.
- **Strategy pattern** (`IFulfillmentOptimizer`) — the allocation algorithm is pluggable by design, for the reason above.
- **Unit of Work** (`IOrderUnitOfWork`) — submission's entire transaction (lock warehouses, recalculate, save order, deduct stock, write audit log, queue an event) is expressed as one unit that commits or rolls back atomically.
- **Transactional outbox** — order events are written to an `outbox_events` table in the *same* transaction as the order itself, so "the order saved but the event didn't fire" can't happen. A separate dispatcher drains it with retries and `FOR UPDATE SKIP LOCKED` so multiple workers don't double-publish.
- **Idempotency keys** — a client-supplied key plus a fingerprint of the request lets a submission retry (say, after a dropped connection) return the original result instead of creating a second order.

### Data model

```text
products             One row: the SCOS Station P1 Pro. Price and weight, not a hardcoded constant.
warehouses            Six rows: location and live stock.
pricing_rules         Discount tiers and the shipping tariff, as data, not code.
orders                One row per submission — a full pricing/shipping snapshot, not a pointer to current prices.
order_allocations     Per-warehouse breakdown of a committed order: quantity, distance, cost.
idempotency_keys      Claims a key to one order id, so a concurrent duplicate resolves cleanly instead of racing.
inventory_audit_log   Every stock change, signed with a reason and a (self-reported) sales rep id.
outbox_events         Pending domain events, waiting for a publisher that doesn't exist yet (more on that below).
```

`order_allocations` exists because "shipping cost: $427" is useless to a fulfillment team if nobody can say which 120 units are supposed to come from where. And `orders` stores a full snapshot — unit price, discount tier, shipping rate, the threshold itself — precisely so that changing prices next quarter doesn't rewrite history. An order confirmed in September should still read exactly the way it did in September, forever.

### Tradeoffs & assumptions

- **Haversine distance, not carrier routing.** Great-circle distance is a reasonable proxy for "how far away is this warehouse," but it's not what a truck or plane actually drives/flies. Matches the brief; a real logistics system would want carrier-quoted rates.
- **Quotes don't reserve stock**, on purpose — see "a quote is a guess" above. It also means a quote can go stale the instant someone else submits.
- **The greedy allocator assumes a linear shipping cost with zero fixed cost per warehouse.** True today, false the moment ScreenCloud negotiates a flat per-shipment handling fee.
- **Locking all six warehouses on every submission is the right call at this scale**, and probably the wrong call at fifty thousand warehouses. I'd revisit it if — and only if — real contention numbers said so; guessing at a more complex scheme now would just be adding risk for a problem that doesn't exist yet.
- **One product.** Multi-product support needs order lines and stock keyed by product *and* warehouse, not just warehouse. Not hard, just genuinely out of scope for "one SCOS device, six warehouses."

## CI/CD & infrastructure

```text
GitHub push/PR to main
        │
        ▼
  GitHub Actions CI  ──  tests (Node 22 & 24) · typecheck · Docker build
        │
        ▼
  Deploy (manual trigger, main only)
        │  OIDC — no long-lived AWS keys anywhere
        ▼
  Pulumi  ──  builds + pushes image to ECR, updates the stack
        │
        ▼
Client --HTTPS--> API Gateway --VPC Link--> private ALB --HTTP--> Fargate task --> RDS PostgreSQL
```

CI (`ci.yml`) runs on every push and PR against `main`: the test suite against a real PostgreSQL container on both Node 22 and 24, a full typecheck, and a Docker build. The **Deploy** workflow is manual (`workflow_dispatch`, `main` only) — it re-runs those same checks, authenticates to AWS over OIDC, runs `pulumi preview` then `pulumi up`, confirms the running ECS task actually matches the image that was just published, and then runs a real smoke test against the live URL: readiness, that auth is actually enforced, a real quote, a real order submission, an idempotent retry, retrieval, and the OpenAPI document. If that smoke test fails, the workflow fails — a green run means the thing is genuinely up, not just that Pulumi didn't error.

Pulumi provisions ECR, an API Gateway HTTP API, a private Application Load Balancer, one Fargate task, a private single-AZ RDS PostgreSQL instance, CloudWatch logs, and Secrets Manager entries for the database URL and API token. **API Gateway is what gives this real HTTPS** — its own `execute-api.amazonaws.com` certificate, with zero domain purchase or DNS setup — and it reaches the ALB privately through a VPC Link, so the load balancer itself is never exposed to the internet directly. One Fargate task and a single-AZ database trade redundancy for cost, deliberately, for a graded demo — this isn't the shape I'd pick for something serving real customers.

### The deploy took a few tries

Getting this actually live on AWS surfaced a few issues:

1. **RDS refused to create** because the AWS account was still on Free Tier, which caps automated backup retention below the general 1–35 day range I'd set. Fixed by upgrading the account to pay-as-you-go, not a code change — the config was already reasonable, the account tier wasn't.
2. **CloudFront was my first choice** for free HTTPS with no domain — until AWS rejected `CreateDistribution` outright with "your account must be verified," a manual, no-ETA support gate on newer accounts. Rather than block the whole submission on an AWS Support ticket, I swapped it for **API Gateway + VPC Link**, which gets the same result (public HTTPS, private origin, no domain) without that gate.
3. **A cancelled deploy left a stale lock** on the Pulumi state file, and a separate interrupted image push left Pulumi believing an image existed in ECR that had actually never finished uploading. Both are exactly the kind of state-vs-reality drift that distributed infrastructure tooling occasionally produces — resolved by clearing the lock and dropping the stale resource from state so the next run rebuilt it for real.
4. **The container crash-looped in production** because the configured API token was shorter than the 32-character minimum the app itself enforces on startup — a real guard doing exactly its job, just against a bad config value.

None of these were code design flaws, they were real infrastructure quirks, and diagnosing "why is this actually broken" via ECS task logs and target-group health rather than guessing is, if anything, a better demonstration of the job than a deploy that happened to work first try.

## Testing strategy

```text
Unit           discount tiers, Haversine distance, allocation, validity boundaries — no I/O, fast
Integration    real PostgreSQL: HTTP request → persistence → response, migrations, outbox draining
Concurrency    two independent connection pools racing the same warehouse, an opposing-warehouse-
               preference deadlock check, concurrent idempotent duplicates, concurrent outbox
               drain via FOR UPDATE SKIP LOCKED, concurrent migrations on overlapping startups
```

The concurrency tests are the ones I actually care about, because they're the ones a mocked-lock unit test would happily lie to you about. They use genuinely separate connection pools racing each other against real PostgreSQL — not a single in-process mutex pretending to be a database.

Run them:

```sh
docker compose up -d --wait postgres
npm ci
npm test        # everything
npm run test:unit   # just the fast ones, no database needed
npm run lint         # typecheck, app and tests both
```

## API

The three that matter:

```text
POST /v1/order-quotes        simulate an order, no side effects
POST /v1/orders               submit and commit an order, deducts inventory
GET  /v1/orders/:orderNumber  retrieve a committed order
```

**`POST /v1/order-quotes`**
Request: `{ quantity, customerCoordinates: { latitude, longitude } }`.
Response: price, discount tier and amount, per-warehouse shipping allocation, total shipping cost, and `isValid`.
Fails with `400` on bad input (bad coordinates, non-positive quantity) — never touches inventory either way.

**`POST /v1/orders`**
Same request shape, plus optional `Idempotency-Key` and `x-sales-rep-id` headers.
Success returns `201` with an `orderNumber` and the same pricing/shipping breakdown as the quote, now committed. A replayed idempotent request returns `200` with the original order instead of creating a second one.
Fails with `409 INSUFFICIENT_STOCK` if the network doesn't have enough units, `422` if shipping exceeds the 15% ceiling, and `409 IDEMPOTENCY_CONFLICT` if the same key is reused with genuinely different input.

**`GET /v1/orders/:orderNumber`**
Returns the order exactly as it was confirmed — the historical snapshot, not a live recalculation. `404` if it doesn't exist.

Everything else, briefly:

| Method & path | What it's for |
| --- | --- |
| `GET /api/v1/warehouses` | Current stock per warehouse |
| `GET /api/v1/alerts/stock` | Warehouses at or below 50 units |
| `GET /metrics` | Prometheus-formatted counters and stock gauges |
| `GET /health`, `GET /ready` | Liveness / readiness — the only public routes |
| `GET /docs`, `GET /docs/json` | Swagger UI / raw OpenAPI spec |

All business routes and `/docs` require `Authorization: Bearer <token>`, checked with a constant-time comparison so response timing can't leak anything about the token. Errors come back as `application/problem+json` (RFC 7807: `type`, `title`, `status`, `detail`), consistently, everywhere.

## Future scope

### How this could fit into ScreenCloud

Nothing here is speculation about ScreenCloud's actual internal architecture — just the obvious shape this slots into. An internal sales tool could point at this API today, as-is. The domain logic is deliberately isolated from HTTP and persistence, so it could sit behind a CRM integration, an internal sales UI, or both, without the pricing/allocation logic caring which.

The transactional outbox is the other half of that story: order events are already being written, in-transaction, with nowhere configured to send them yet. Wire up a real publisher and you get a path to warehouse fulfillment systems or a data warehouse without adding any risk to order submission itself, since the event write already happened atomically with the order.

### What I'd actually build for analytics/reporting

Once order events are flowing somewhere, the obvious next questions become easy to answer:

- Order volume and revenue, over time and by region
- Fulfillment split by warehouse — which ones are actually doing the work
- Average shipping cost as a percentage of order value — is the 15% ceiling rejecting a meaningful chunk of demand?
- Invalid-order rate and *why* orders are failing (stock vs. shipping cost)
- Stock depletion trends per warehouse, to catch a restock need before `/api/v1/alerts/stock` would
- Regional demand patterns — useful input for "should there be a seventh warehouse, and where"

None of this needs new instrumentation in the hot path. It's a consumer reading the same events that already exist.

### Hardening this for real production use

The brief explicitly asked what I'd do next if this were a real project, so here it is, roughly in priority order:

1. **Replace the shared bearer token with real identity.** Right now, `x-sales-rep-id` is a client-supplied header trusted straight into the audit log with zero verification — anyone holding the one token can attribute an order to any name they like. Fine for a demo; not fine the moment there's more than one trusted caller.
2. **Scope idempotency keys per caller**, once there's a caller identity to scope them by. Right now two reps who both pick the same natural key (`"order-1"`) and submit identical input will have the *second* one silently receive the *first* one's order back as a successful "replay" — not an error, no signal anything's off. A genuine fingerprint mismatch on a reused key correctly returns `409`, but the matching case needs a caller dimension that doesn't exist yet.
3. **Rate limiting.** There isn't any today. A leaked token currently means unbounded quote/order traffic.
4. **A real runtime database role**, separate from the one that runs migrations, plus an actual proven backup-restore drill rather than "RDS backups are probably fine."
5. **Real monitoring** — request latency, lock-wait time, an outbox-backlog alarm. The current Prometheus counters are a start, not a monitored production system.
6. **Load-test before touching the locking strategy.** Locking all six warehouses on every submission is deliberately simple and serializes submissions against each other. I'd only make it more complex if real contention numbers said the throughput ceiling was actually a problem — not before.

---

## Local development, in full

Everything above got you a running system; this section is the reference for the rest of it.

### Stop, inspect, reset

```sh
docker compose logs --tail=100 app postgres   # diagnose a startup or request failure
docker compose down                            # stop containers, keep the data
docker compose down --volumes                  # nuke the database and start fresh next time
```

Orders and stock persist in a Docker volume across restarts — a restart doesn't replenish inventory, only `--volumes` does.

### Live reload for actually editing code

Needs Node.js 22.14+ and npm, on top of the Docker/`.env` setup above:

```sh
docker compose stop app
docker compose up -d --wait postgres
npm ci
HOST=127.0.0.1 npm run dev
```

The dev server reloads on file changes and reads `.env` automatically. Stop it with Ctrl+C. `npm run build && HOST=127.0.0.1 npm start` runs the compiled version instead.

### Viewing Swagger UI without a header-injecting client

Every business route (including `/docs`) requires the bearer token — a plain browser tab can't send that header on its own. Two ways around it:

- **Locally**: stop the dev server and run `HOST=127.0.0.1 API_TOKEN= npm run dev`, then open `http://localhost:3000/docs/` in an ordinary browser tab. This disables auth entirely for a server explicitly bound to localhost — the Docker setup keeps requiring the token regardless.
- **Against a real deployment** (where you can't just turn auth off): a header-injecting browser extension like ModHeader or Requestly, configured to add `Authorization: Bearer <token>` to requests matching that host. Watch out for extensions that only modify XHR/fetch by default and skip the top-level page navigation — that's the request that actually loads `/docs/`, so it needs to be included too.

### Deploying it yourself

One-time setup needs an AWS account, an S3 bucket for Pulumi state (name must start with `scos-pulumi-state-` to match [the deployer policy](infra/iam/sc-deployer-policy.json)), an OIDC trust relationship for GitHub Actions, and a `demo` Pulumi stack configured with a database password and API token (32+ characters, non-negotiable — the app refuses to start in production without it):

```sh
cd infra/pulumi
pulumi stack select demo
pulumi config set aws:region us-east-1
pulumi config set --secret dbPassword
pulumi config set --secret apiToken
```

Those last two prompt without touching shell history, and the encrypted result is safe to commit — `Pulumi.demo.yaml` holds AES-256-GCM ciphertext, not plaintext, decryptable only with a passphrase that never touches the repo (it lives in GitHub's `PULUMI_CONFIG_PASSPHRASE` secret and your own password manager). From there, GitHub Actions → **Deploy** → **Run workflow** on `main` does the rest.

## Tech stack

TypeScript · Node.js · Fastify · PostgreSQL (`postgres` driver, hand-written SQL and migrations — no ORM) · Zod · Vitest · Docker · Pulumi · AWS (ECS Fargate, RDS, ALB, API Gateway, ECR, Secrets Manager) · GitHub Actions

### A note on how this was built

I used Codex and Claude Code throughout this project — for scaffolding, for a second-pass code review that caught real bugs, and for working through the AWS deployment saga in the CI/CD section. It's still remarkable to me how much AI has changed the day-to-day of building software! 🙂
