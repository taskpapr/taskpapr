#!/usr/bin/env bash
# taskpapr Stripe webhook LIVE integration test
#
# Exercises the full checkout.session.completed -> stripe.subscriptions.retrieve()
# path against Stripe's real test-mode sandbox, to catch the class of bug fixed
# in v0.45.2: customer.subscription.created arriving before checkout.session.
# completed left a paying customer stranded in 'trialing' forever, because the
# status update depended on event arrival order and a "successfully received"
# no-op is never retried by Stripe.
#
# Requires STRIPE_TEST_SECRET_KEY — a dedicated Stripe TEST MODE key (never a
# live key). Skips gracefully if it isn't set, so external contributor PRs
# (which don't get repo secrets) don't fail this check.
#
# The server under test must be started with STRIPE_SECRET_KEY set to the same
# STRIPE_TEST_SECRET_KEY value, so the app's own Stripe client can retrieve the
# fixtures this script creates.
#
# Usage: bash test/webhook-billing-live.sh [BASE_URL]

set -euo pipefail

BASE="${1:-http://localhost:3033}"
WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-whsec_test_dummy_for_ci}"
STRIPE_KEY="${STRIPE_TEST_SECRET_KEY:-}"

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

if [[ -z "$STRIPE_KEY" ]]; then
  info "STRIPE_TEST_SECRET_KEY not set — skipping live Stripe integration test"
  info "(expected for external contributor PRs; repo secrets aren't shared with forks)"
  exit 0
fi

stripe_api() {
  local method="$1" path="$2"; shift 2
  curl -s -X "$method" "https://api.stripe.com/v1/$path" -u "${STRIPE_KEY}:" "$@"
}

stripe_signature() {
  local payload="$1" ts sig
  ts=$(date +%s)
  sig=$(printf '%s' "${ts}.${payload}" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')
  echo "t=${ts},v1=${sig}"
}

send_event() {
  local payload sig
  payload="$1"
  sig=$(stripe_signature "$payload")
  curl -s -w '\n%{http_code}' -X POST "$BASE/api/stripe/webhook" \
    -H "Content-Type: application/json" -H "Stripe-Signature: $sig" \
    --data-raw "$payload"
}

echo "=== Stripe webhook LIVE integration test (real test-mode sandbox) ==="

info "Creating ephemeral test fixtures in Stripe test mode..."
CUSTOMER_ID=$(stripe_api POST customers \
  -d "email=ci-webhook-test@example.com" \
  -d "description=taskpapr CI ephemeral fixture" | jq -r '.id')
PRODUCT_ID=$(stripe_api POST products -d "name=CI Test Product (ephemeral)" | jq -r '.id')
PRICE_ID=$(stripe_api POST prices \
  -d "unit_amount=500" -d "currency=gbp" -d "recurring[interval]=month" \
  -d "product=$PRODUCT_ID" | jq -r '.id')

# pm_card_visa is Stripe's built-in test-mode PaymentMethod — always succeeds,
# no real card data involved, only usable with a test-mode key.
stripe_api POST "payment_methods/pm_card_visa/attach" -d "customer=$CUSTOMER_ID" > /dev/null
stripe_api POST "customers/$CUSTOMER_ID" \
  -d "invoice_settings[default_payment_method]=pm_card_visa" > /dev/null

SUB_RESP=$(stripe_api POST subscriptions -d "customer=$CUSTOMER_ID" -d "items[0][price]=$PRICE_ID")
SUB_ID=$(echo "$SUB_RESP" | jq -r '.id')
SUB_STATUS=$(echo "$SUB_RESP" | jq -r '.status')

cleanup() {
  info "Cleaning up Stripe test fixtures..."
  stripe_api DELETE "customers/$CUSTOMER_ID" > /dev/null 2>&1 || true
  stripe_api POST "prices/$PRICE_ID" -d "active=false" > /dev/null 2>&1 || true
  stripe_api POST "products/$PRODUCT_ID" -d "active=false" > /dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ "$SUB_ID" == "null" || -z "$SUB_ID" ]]; then
  fail "failed to create test subscription fixture: $SUB_RESP"
  echo "Results: ${PASS} passed, ${FAIL} failed"
  exit 1
fi
ok "created live test subscription $SUB_ID (status: $SUB_STATUS)"

# ── The regression scenario ────────────────────────────────────
# customer.subscription.created arrives BEFORE checkout.session.completed has
# linked this Stripe customer to a taskpapr user. Pre-fix (v0.45.1), this left
# the account stranded in 'trialing' forever. Post-fix, checkout.session.
# completed below must set status correctly on its own, regardless.
EARLY_EVENT=$(jq -n --arg cust "$CUSTOMER_ID" --arg status "$SUB_STATUS" \
  '{id:"evt_ci_sub_created",type:"customer.subscription.created",data:{object:{customer:$cust,status:$status}}}')
RESP=$(send_event "$EARLY_EVENT")
CODE=$(echo "$RESP" | tail -n1)
if [[ "$CODE" == "200" ]]; then
  ok "out-of-order subscription.created accepted gracefully (200, no matching user yet)"
else
  fail "expected 200 for early subscription.created, got $CODE"
fi

# The checkout completes — this event alone must set subscription_status
# correctly, independent of the (already-consumed, no-op'd) event above.
CHECKOUT_EVENT=$(jq -n --arg cust "$CUSTOMER_ID" --arg sub "$SUB_ID" \
  '{id:"evt_ci_checkout",type:"checkout.session.completed",data:{object:{customer:$cust,client_reference_id:"1",subscription:$sub}}}')
RESP=$(send_event "$CHECKOUT_EVENT")
CODE=$(echo "$RESP" | tail -n1)
if [[ "$CODE" == "200" ]]; then
  ok "checkout.session.completed accepted (200)"
else
  fail "expected 200 for checkout.session.completed, got $CODE: $(echo "$RESP" | sed '$d')"
fi

# The webhook handler is awaited before the HTTP response is sent (see
# routes/billing.js), so the subscription.retrieve() round-trip has already
# completed by the time curl returns above — no polling/sleep needed.
STATUS=$(curl -s "$BASE/api/billing/status")
if echo "$STATUS" | jq -e '.subscription_status == "active"' > /dev/null 2>&1 \
   && echo "$STATUS" | jq -e '.has_billing_account == true' > /dev/null 2>&1; then
  ok "subscription activated correctly despite out-of-order events (the v0.45.2 fix)"
else
  fail "expected subscription_status:active, has_billing_account:true — got: $STATUS"
fi

echo ""
echo "────────────────────────────────────────"
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -gt 0 ]]; then
  echo "Failures:"
  printf '%s\n' "${ERRORS[@]}"
  exit 1
fi
