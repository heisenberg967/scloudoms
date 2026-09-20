import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.env.API_URL ?? 'http://127.0.0.1:3000');
const token = process.env.API_TOKEN;
assert(token, 'API_TOKEN is required');
assert(
  base.protocol === 'https:' ||
    (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)),
  'Use HTTPS for remote smoke tests'
);

async function request(path, { authenticated = true, ...options } = {}) {
  return fetch(new URL(path, base), {
    ...options,
    headers: {
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  });
}

async function json(path, options, expectedStatus = 200) {
  const response = await request(path, options);
  assert.equal(response.status, expectedStatus, `${path}: expected HTTP ${expectedStatus}, got ${response.status}`);
  return response.json();
}

await json('/health', { authenticated: false });
const ready = await json('/ready', { authenticated: false });
assert.equal(ready.status, 'READY');
const unauthorized = await request('/api/v1/warehouses', { authenticated: false });
assert.equal(unauthorized.status, 401, 'Inventory must require authentication');
const warehouses = await json('/api/v1/warehouses');
assert.equal(warehouses.length, 6);

const payload = JSON.stringify({
  quantity: 1,
  customerCoordinates: { latitude: 40.7128, longitude: -74.006 }
});
const quote = await json('/v1/order-quotes', { method: 'POST', body: payload });
assert.equal(quote.isValid, true, 'Expected a valid one-device quote near New York');

// One persistent test order per release; rerunning a release reuses its key.
const headers = { 'idempotency-key': `deployment-smoke-${process.env.SMOKE_ID ?? randomUUID()}` };
const submitted = await request('/v1/orders', { method: 'POST', body: payload, headers });
assert([200, 201].includes(submitted.status), `Order submission returned HTTP ${submitted.status}`);
const order = await submitted.json();
const retry = await json('/v1/orders', { method: 'POST', body: payload, headers });
assert.equal(retry.orderNumber, order.orderNumber, 'Retry must return the same order');
const stored = await json(`/v1/orders/${encodeURIComponent(order.orderNumber)}`);
assert.equal(stored.orderNumber, order.orderNumber);
assert.equal(stored.pricing.quantity, 1);

const spec = await json('/docs/json');
assert.equal(spec.servers[0].url, '/');
console.log('Passed: readiness, authentication, quote, order, idempotent retry, inventory and OpenAPI.');
