#!/usr/bin/env bash
# taskpapr Stripe webhook signature test
#
# Regression test for the v0.45.1 body-parser-ordering bug: a global
# express.json() middleware was consuming the request body before the
# webhook route's raw-body parser ran, so Stripe's HMAC signature check
# failed on every single delivery in production despite looking fine
# in every other test. This test verifies /api/stripe/webhook validates
# the signature against the RAW body, without needing a real Stripe
# account — constructEvent() is pure local HMAC verification, no
# network call involved.
#
# The server under test MUST be started with STRIPE_SECRET_KEY and
# STRIPE_WEBHOOK_SECRET set (dummy values are fine for this test).
#
# Usage: bash test/webhook-billing.sh [BASE_URL]

set -euo pipefail

BASE="${1:-http://localhost:3033}"
WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-whsec_test_dummy}"

PASS=0
FAIL=0
ERRORS=()

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC}  $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}✗${NC}  $1"; FAIL=$((FAIL+1)); ERRORS+=("$1"); }
info() { echo -e "  ${YELLOW}→${NC}  $1"; }

# Stripe's signed-header scheme: t=<unix_ts>,v1=<hex_hmac_sha256(secret, "ts.payload")>
stripe_signature() {
  local payload="$1" ts sig
  ts=$(date +%s)
  sig=$(printf '%s' "${ts}.${payload}" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')
  echo "t=${ts},v1=${sig}"
}

echo "=== Stripe webhook signature verification ==="

# checkout.session.completed for user id 1 (single-user mode's local user).
# Deliberately omits "subscription" so this test never calls Stripe's
# real API — it only exercises our own signature verification + routing.
PAYLOAD='{"id":"evt_test_1","type":"checkout.session.completed","data":{"object":{"customer":"cus_test_smoke","client_reference_id":"1"}}}'
SIG=$(stripe_signature "$PAYLOAD")

RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/stripe/webhook" \
  -H "Content-Type: application/json" \
  -H "Stripe-Signature: $SIG" \
  --data-raw "$PAYLOAD")
CODE=$(echo "$RESP" | tail -n1)
RBODY=$(echo "$RESP" | sed '$d')

if [[ "$CODE" == "200" ]] && echo "$RBODY" | jq -e '.received == true' > /dev/null 2>&1; then
  ok "valid signature accepted (200, received:true)"
else
  fail "expected 200 {received:true}, got $CODE: $RBODY"
fi

# An invalid signature must be rejected with Stripe's own verification
# error — not a type error. If the raw body were being parsed/re-encoded
# by earlier middleware (the exact regression this test guards against),
# constructEvent() throws "payload must be provided as a string or
# Buffer... was provided as a parsed JavaScript object" instead of the
# clean "no signatures found" failure below.
BAD_SIG="t=$(date +%s),v1=$(printf 'deadbeef%.0s' {1..8})"
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/stripe/webhook" \
  -H "Content-Type: application/json" \
  -H "Stripe-Signature: $BAD_SIG" \
  --data-raw "$PAYLOAD")
CODE=$(echo "$RESP" | tail -n1)
RBODY=$(echo "$RESP" | sed '$d')

if [[ "$CODE" == "400" ]] && echo "$RBODY" | grep -qi "no signatures found"; then
  ok "invalid signature rejected with the correct error (not a body-parsing type error)"
else
  fail "expected 400 'no signatures found', got $CODE: $RBODY"
fi

# Confirm the first event was actually processed end-to-end, not just
# acknowledged — the customer ID should now be linked to the user.
STATUS=$(curl -s "$BASE/api/billing/status")
if echo "$STATUS" | jq -e '.has_billing_account == true' > /dev/null 2>&1; then
  ok "webhook side effect applied (stripe_customer_id linked)"
else
  fail "expected has_billing_account:true after webhook, got: $STATUS"
fi

echo ""
echo "────────────────────────────────────────"
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -ne 0 ]]; then
  echo "Failures:"
  printf '%s\n' "${ERRORS[@]}"
  exit 1
fi
