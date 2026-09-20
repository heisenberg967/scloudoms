# ScreenCloud Order Management System

A backend for quoting and submitting SCOS device orders. The main challenge is choosing the cheapest warehouse allocation while keeping inventory correct when sales representatives submit orders at the same time.

## The problem

The challenge specifies one product, the **SCOS Station P1 Pro**, priced at **$150** and weighing **365 g**, stocked across six warehouses. Orders receive the largest qualifying volume discount: **5% at 25 units, 10% at 50, 15% at 100, and 20% at 250**.

Shipping costs **$0.01 per kilogram per kilometre**. An order can draw stock from several warehouses, but shipping must not exceed **15% of the device total after discount**.

These rules lead to two workflows, plus a way to retrieve the result:

| Endpoint | Behaviour |
| --- | --- |
| `POST /v1/order-quotes` | Return price, discount, shipping, allocation, and validity without changing inventory. |
| `POST /v1/orders` | Recalculate against current stock, commit the order, and immediately deduct inventory. |
| `GET /v1/orders/:orderNumber` | Return the amounts and allocation stored at submission. |

This addresses the brief's functional requirements. TypeScript, PostgreSQL, OpenAPI documentation, Docker setup, and the testing strategy below address its technical requirements.

## Architecture

The service is a modular monolith. Both workflows share the same domain rules; HTTP handling and persistence sit behind separate boundaries.

```mermaid
flowchart TD
    API[Fastify API] --> App[Application use cases]
    App --> Domain[Pricing, allocation and validity rules]
    App --> Ports[Repository and transaction interfaces]
    Adapters[PostgreSQL adapters] -. implement .-> Ports
    Adapters --> DB[(PostgreSQL)]
```

The arrows show code dependencies. The domain has no HTTP or database dependencies, and the submission use case contains no SQL. The PostgreSQL unit of work supplies repositories that share one transaction connection.

```text
src/
  presentation/     HTTP routes, validation, OpenAPI and startup
  application/      Quote, submit and retrieve workflows; transaction port
  domain/           Business rules, models and repository interfaces
  infrastructure/   PostgreSQL adapters, migrations, outbox and metrics
tests/
  unit/             Calculations without I/O
  integration/      API, persistence and concurrency against PostgreSQL
infra/pulumi/       AWS deployment definition
docs/               Deployment details and remaining work
```

## Decisions that matter

### Cheapest first is optimal for this tariff

For the specified device:

```text
shipping cost per device = distanceKm × 0.365 kg × $0.01/(kg × km)
```

The allocator calculates Haversine distances, sorts an array of warehouses by distance, and takes available stock from each until the quantity is filled. Warehouse ID breaks distance ties. This takes **O(W log W)** time and **O(W)** space for `W` warehouses.

The greedy choice follows an exchange argument: if a plan uses a more expensive warehouse while a cheaper one still has stock, moving a unit to the cheaper warehouse reduces cost without changing the quantity. Repeating that exchange gives the cheapest-first allocation. This depends on the linear tariff: a fixed fee per shipment would change the problem.

### A quote is advisory; a submission is atomic

Suppose two representatives each request eight of the last ten devices. Both can receive a valid quote. Only one order can commit.

Submission uses one PostgreSQL transaction to:

1. Claim the optional idempotency key and lock warehouse rows in ascending ID order.
2. Recalculate pricing and allocation, rejecting insufficient stock or excessive shipping.
3. Save the order and allocations, deduct stock, and write inventory audit records and an outbox event.

Success is returned after commit. A failure rolls everything back. Conditional stock updates and a database constraint prevent negative inventory; consistent lock ordering prevents circular warehouse lock waits.

Locking all six warehouses makes this straightforward, but serializes submissions. Quotes use ordinary reads. That is an explicit throughput trade-off to revisit under measured contention.

An `Idempotency-Key` also handles a successful order followed by a lost HTTP response. An identical retry returns the stored order; reusing the key with different input returns `409`.

### Preserve order snapshots

Money is stored in integer cents. Distance calculations use floating point; each warehouse's shipping charge is rounded to cents before summing. A fractional-cent shipping ceiling is rounded down so rounding cannot admit an order above the limit.

Product metadata and pricing rules come from PostgreSQL. Orders retain the price, discount, shipping rate, charge, and threshold used at submission. `order_allocations` preserves each warehouse's identity, quantity, distance, and cost. Later price or warehouse changes therefore do not alter historical confirmations.

The [schema and migrations](src/infrastructure/db/migrations.ts) also hold idempotency claims, inventory movements, and pending events. The challenge's product and warehouse data are [seeded](src/infrastructure/db/seeds.ts) once; restarting does not replenish stock.

## Trade-offs and growth

Haversine models geographic distance, not carrier routes. Inventory currently belongs to one product. These choices match the brief; multiple products would need order lines and inventory keyed by product and warehouse.

Growth would change the design in specific ways:

- **More quote traffic:** add API instances and consider caching product and pricing metadata, while budgeting database connections across instances.
- **More order contention:** consider locking only selected warehouses or conditional deductions with full allocation retries.
- **Many more warehouses:** consider spatial indexing, expanding the candidate set when nearby stock cannot fulfil an order.

An internal sales tool could use the API today. The transactional outbox provides a path to warehouse fulfilment or an analytics warehouse later: consumers could derive shipping cost by region and inventory depletion without adding work to order submission. Quote conversion metrics would also need quote events and correlation IDs.

No external publisher is configured yet, so events remain pending. The dispatcher supports retries and concurrent workers; consumers must deduplicate because delivery is at least once. Integration and production tasks are tracked in [remaining work](docs/remaining-work.md).

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

Other endpoints include `/api/v1/warehouses` for stock, `/metrics`, and `/docs/json` for OpenAPI. Swagger UI at `/docs/` also requires the authorization header; see the development option below for ordinary browser access.

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

Unit tests cover discounts, distances, allocation, and validity boundaries. Integration tests exercise real PostgreSQL commits, rollback, snapshot preservation, duplicate requests, and competing orders through independent connection pools.

## Deployment

GitHub Actions tests against PostgreSQL on Node 22 and 24, typechecks the code, and checks the Docker build. The manual **Deploy** workflow runs those checks, authenticates to AWS with OIDC, and uses Pulumi to publish the image and update our single environment. It then checks readiness, authentication, quoting, and order submission against the deployed API.

Pulumi defines ECR, an HTTPS load balancer, one Fargate task, private RDS PostgreSQL, logs, and secrets. The task uses a public subnet with inbound access restricted to the load balancer, avoiding a NAT gateway. One task and a single-AZ database limit cost at the expense of redundancy. State is stored in S3.

The workflow still needs its GitHub/AWS settings and a verified live deployment. The shared API token authenticates a trusted client; company identity and per-user permissions remain rollout work. See [deployment instructions](docs/deployment.md) for setup and remaining prerequisites.
