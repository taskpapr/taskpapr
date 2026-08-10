#!/usr/bin/env node
/**
 * taskpapr — Stripe checkout customer-params regression test
 *
 * Stripe's Checkout Session API rejects a request that sets both `customer`
 * and `customer_email`. buildCheckoutCustomerParams() (routes/billing.js)
 * previously spread both independently, so any returning customer (one with
 * both an email on file AND an existing stripe_customer_id — e.g. after a
 * first purchase links them) hit a 500 on every subsequent checkout attempt.
 * Undiscovered until v0.45.3, since every prior manual/CI test used a fresh
 * customer with no stripe_customer_id set yet.
 *
 * Exits non-zero if the two params are ever both present at once.
 */

const { buildCheckoutCustomerParams } = require('../routes/billing.js');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assertParams(label, user, expected) {
  const actual = buildCheckoutCustomerParams(user);
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail(`${label}: expected keys ${JSON.stringify(expectedKeys)}, got ${JSON.stringify(actualKeys)}`);
  }
  for (const key of expectedKeys) {
    if (actual[key] !== expected[key]) {
      fail(`${label}: expected ${key}=${expected[key]}, got ${actual[key]}`);
    }
  }
  // The actual bug: these two must never both be present.
  if ('customer' in actual && 'customer_email' in actual) {
    fail(`${label}: customer and customer_email both present — Stripe will reject this`);
  }
  console.log(`OK: ${label} -> ${JSON.stringify(actual)}`);
}

// Returning customer (has both email AND an existing stripe_customer_id) —
// this is the exact combination that triggered the bug.
assertParams(
  'returning customer with email',
  { email: 'james@example.com', stripe_customer_id: 'cus_123' },
  { customer: 'cus_123' }
);

// Fresh customer with an email — Stripe creates the customer at checkout.
assertParams(
  'new customer with email',
  { email: 'james@example.com', stripe_customer_id: null },
  { customer_email: 'james@example.com' }
);

// Fresh customer with no email at all (e.g. GitHub account with no public email).
assertParams(
  'new customer with no email',
  { email: null, stripe_customer_id: null },
  {}
);

console.log('All checkout customer-params checks passed.');
