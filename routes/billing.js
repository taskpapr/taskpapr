'use strict';

const express    = require('express');
const { queryOne, queryRun, sqlNowExpr } = require('../db');
const { getTodayStr }  = require('../lib/date');
const { requireAuth }  = require('../auth');
const { applyReferral } = require('../auth');

// Stripe is initialised once at module load — null when the key is absent
// so that self-hosted installs without the key never require the stripe package.
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// ── Helpers ───────────────────────────────────────────────────

// Find a user row by Stripe customer ID
const userByCustomer = (customerId) =>
  queryOne('SELECT * FROM users WHERE stripe_customer_id = ?', [customerId]);

// Update subscription fields on a user
async function updateSub(userId, fields) {
  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values     = [...Object.values(fields), userId];
  await queryRun(`UPDATE users SET ${setClauses} WHERE id = ?`, values);
}

// ── Pricing display ────────────────────────────────────────────
// Amounts are fetched live from Stripe rather than duplicated in a config
// file — the price shown on /pricing always matches what's actually charged.
// Cached briefly so the pricing page doesn't hit the Stripe API on every load.
let pricingCache   = null;
let pricingCacheAt = 0;
const PRICING_CACHE_MS = 5 * 60 * 1000;
const CURRENCY_SYMBOLS = { gbp: '£', usd: '$', eur: '€' };

async function getPricingConfig() {
  const empty = { currency_symbol: '', monthly: 0, annual: 0, annual_monthly_equivalent: 0, trial_days: 14 };

  const monthlyId = process.env.STRIPE_SOLO_MONTHLY_PRICE_ID;
  const annualId  = process.env.STRIPE_SOLO_ANNUAL_PRICE_ID;
  if (!stripe || !monthlyId || !annualId) return empty;

  if (pricingCache && (Date.now() - pricingCacheAt) < PRICING_CACHE_MS) {
    return pricingCache;
  }

  try {
    const [monthlyPrice, annualPrice] = await Promise.all([
      stripe.prices.retrieve(monthlyId),
      stripe.prices.retrieve(annualId),
    ]);
    const monthly = monthlyPrice.unit_amount / 100;
    const annual  = annualPrice.unit_amount / 100;
    pricingCache = {
      currency_symbol: CURRENCY_SYMBOLS[monthlyPrice.currency] || '',
      monthly,
      annual,
      annual_monthly_equivalent: Math.round((annual / 12) * 100) / 100,
      trial_days: 14,
    };
    pricingCacheAt = Date.now();
    return pricingCache;
  } catch (err) {
    console.error('[pricing] failed to fetch prices from Stripe:', err.message);
    return pricingCache || empty; // serve stale data over a broken page if we have any
  }
}

// ── Stripe event processor ────────────────────────────────────

async function handleStripeEvent(event) {
  const obj = event.data.object;

  switch (event.type) {

    // ── subscription.created / updated ─────────────────────
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const customerId = obj.customer;
      const status     = obj.status; // trialing | active | past_due | canceled | unpaid
      // Map Stripe status to our internal status
      const ourStatus = ['active', 'trialing'].includes(status) ? status
                      : status === 'past_due' ? 'past_due'
                      : 'canceled';
      // Determine tier from price metadata or product name — default 'solo'
      const tier = 'solo'; // v0.39+ will read from price metadata

      const user = await userByCustomer(customerId);
      if (!user) {
        console.warn(`[stripe/webhook] no user found for customer ${customerId}`);
        return;
      }
      await updateSub(user.id, { subscription_status: ourStatus, subscription_tier: tier });
      console.log(`[stripe/webhook] user ${user.id} subscription → ${ourStatus} (${tier})`);
      break;
    }

    // ── subscription.deleted (cancelled at period end) ──────
    case 'customer.subscription.deleted': {
      const customerId = obj.customer;
      const user = await userByCustomer(customerId);
      if (!user) return;
      await updateSub(user.id, { subscription_status: 'canceled', subscription_tier: null });
      console.log(`[stripe/webhook] user ${user.id} subscription → canceled`);
      break;
    }

    // ── payment failed ───────────────────────────────────────
    case 'invoice.payment_failed': {
      const customerId = obj.customer;
      const user = await userByCustomer(customerId);
      if (!user) return;
      await updateSub(user.id, { subscription_status: 'past_due' });
      console.log(`[stripe/webhook] user ${user.id} payment failed → past_due`);
      break;
    }

    // ── payment succeeded (clears past_due; triggers referral credit) ──
    case 'invoice.payment_succeeded': {
      const customerId = obj.customer;
      const user = await userByCustomer(customerId);
      if (!user) return;
      // Only update if they were past_due — don't overwrite trialing/active
      if (user.subscription_status === 'past_due') {
        await updateSub(user.id, { subscription_status: 'active' });
        console.log(`[stripe/webhook] user ${user.id} payment recovered → active`);
      }
      // ── Referral credit: first successful payment by a referred user ──
      if (stripe && user.referred_by_user_id) {
        const referral = await queryOne(
          'SELECT * FROM referrals WHERE referee_id = ? AND converted_at IS NULL',
          [user.id]
        );
        if (referral) {
          await queryRun(
            `UPDATE referrals SET converted_at = ${sqlNowExpr()} WHERE id = ?`,
            [referral.id]
          );
          const referrer = await queryOne(
            'SELECT id, stripe_customer_id FROM users WHERE id = ?',
            [user.referred_by_user_id]
          );
          if (referrer?.stripe_customer_id) {
            try {
              const creditAmount = -(obj.amount_paid || 0);
              if (creditAmount < 0) {
                await stripe.customers.createBalanceTransaction(referrer.stripe_customer_id, {
                  amount:      creditAmount,
                  currency:    obj.currency || 'gbp',
                  description: `Referral credit: user ${user.id} converted`,
                });
              }
              await queryRun(
                `UPDATE referrals SET credit_applied_at = ${sqlNowExpr()} WHERE id = ?`,
                [referral.id]
              );
              console.log(`[referral] credited referrer user ${referrer.id} for converting user ${user.id}`);
            } catch (err) {
              console.error('[referral] failed to apply Stripe credit', { referrerId: referrer.id, error: err.message });
            }
          } else {
            console.log(`[referral] referrer user ${user.referred_by_user_id} has no Stripe customer — credit skipped`);
          }
        }
      }
      break;
    }

    // ── checkout session completed (first-time checkout) ─────
    // Links the new Stripe customer to the taskpapr user account.
    case 'checkout.session.completed': {
      const customerId = obj.customer;
      const clientRef  = obj.client_reference_id; // we send userId as client_reference_id
      if (!clientRef) return;
      const userId = parseInt(clientRef);
      if (isNaN(userId)) return;
      // Store the Stripe customer ID against this user
      await queryRun('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, userId]);
      console.log(`[stripe/webhook] linked customer ${customerId} to user ${userId}`);
      break;
    }

    default:
      // Unhandled event type — ignore silently
      break;
  }
}

// ── Public routes (before requireAuth) ───────────────────────

function registerPublic(app) {
  // GET /api/pricing — display config for the pricing page, sourced from Stripe
  app.get('/api/pricing', async (_req, res) => {
    res.json(await getPricingConfig());
  });

  // POST /api/stripe/webhook — Stripe requires the raw request body to verify
  // the signature. Mounted before the JSON body-parser runs on this route.
  app.post('/api/stripe/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      // If Stripe is not configured, acknowledge and ignore
      if (!stripe) return res.json({ received: true, note: 'Stripe not configured' });

      const sig    = req.headers['stripe-signature'];
      const secret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!secret) {
        console.warn('[stripe/webhook] STRIPE_WEBHOOK_SECRET not set — skipping verification');
        return res.status(400).json({ error: 'webhook secret not configured' });
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
      } catch (err) {
        console.warn('[stripe/webhook] signature verification failed:', err.message);
        return res.status(400).json({ error: `webhook error: ${err.message}` });
      }

      // Process BEFORE acknowledging. A 200 tells Stripe to never retry, so
      // responding first meant a thrown handler lost the event forever. On
      // failure return 500 and let Stripe retry — the handlers are idempotent
      // (status upserts; referral credit guarded by converted_at IS NULL).
      console.log(`[stripe/webhook] event: ${event.type}`);

      try {
        await handleStripeEvent(event);
      } catch (err) {
        console.error('[stripe/webhook] handler error:', err.message);
        return res.status(500).json({ error: 'event handler failed — Stripe will retry' });
      }

      res.json({ received: true });
    }
  );
}

// ── Auth-protected routes (after requireAuth) ────────────────

function registerAuth(app) {
  const PORT = process.env.PORT || 3033;

  // POST /api/billing/create-checkout — create a Stripe Checkout session
  // Returns { url } for the browser to redirect to.
  app.post('/api/billing/create-checkout', async (req, res) => {
    if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });

    const { interval = 'monthly' } = req.body; // 'monthly' | 'annual'
    const priceId = interval === 'annual'
      ? process.env.STRIPE_SOLO_ANNUAL_PRICE_ID
      : process.env.STRIPE_SOLO_MONTHLY_PRICE_ID;

    if (!priceId) {
      return res.status(400).json({ error: `Stripe price ID not configured for interval: ${interval}` });
    }

    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    const user   = req.user;

    try {
      // Reuse existing Stripe customer if we have one; otherwise Stripe creates one at checkout
      const checkoutParams = {
        mode:                 'subscription',
        line_items:           [{ price: priceId, quantity: 1 }],
        success_url:          `${appUrl}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:           `${appUrl}/pricing/canceled`,
        client_reference_id:  String(user.id), // used in checkout.session.completed event
        allow_promotion_codes: true,
        // Pre-fill email from the user's profile
        ...(user.email ? { customer_email: user.email } : {}),
        // Reuse existing customer if linked
        ...(user.stripe_customer_id ? { customer: user.stripe_customer_id } : {}),
        // Stripe Tax — calculates UK VAT + EU digital services tax automatically
        automatic_tax: { enabled: !!process.env.STRIPE_TAX_ENABLED },
      };

      const session = await stripe.checkout.sessions.create(checkoutParams);
      res.json({ url: session.url });
    } catch (err) {
      console.error('[billing/create-checkout] error:', err.message);
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  // GET /api/billing/portal — redirect to Stripe Customer Portal
  // Allows users to manage payment methods, view invoices, cancel, etc.
  app.get('/api/billing/portal', async (req, res) => {
    if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });

    const user = req.user;
    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account linked to this user' });
    }

    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer:   user.stripe_customer_id,
        return_url: `${appUrl}/settings`,
      });
      res.json({ url: session.url });
    } catch (err) {
      console.error('[billing/portal] error:', err.message);
      res.status(500).json({ error: 'Failed to create billing portal session' });
    }
  });

  // GET /api/billing/status — returns the calling user's subscription status
  // Used by the settings page and user menu to display trial countdown / plan info.
  app.get('/api/billing/status', async (req, res) => {
    const u = await queryOne(
      'SELECT subscription_status, subscription_tier, trial_ends_at, stripe_customer_id FROM users WHERE id = ?',
      [req.user.id]
    );
    const stripeConfigured = !!stripe;
    const todayStr = getTodayStr();

    let trialDaysLeft = null;
    if (u.subscription_status === 'trialing' && u.trial_ends_at) {
      const msLeft = new Date(u.trial_ends_at + 'T23:59:59Z') - new Date(todayStr + 'T00:00:00Z');
      trialDaysLeft = Math.max(0, Math.ceil(msLeft / 86400000));
    }

    res.json({
      stripe_configured:    stripeConfigured,
      subscription_status:  u.subscription_status  || 'trialing',
      subscription_tier:    u.subscription_tier    || null,
      trial_ends_at:        u.trial_ends_at        || null,
      trial_days_left:      trialDaysLeft,
      has_billing_account:  !!u.stripe_customer_id,
    });
  });

  // GET /api/referral/stats — referral link + counts for the settings page
  app.get('/api/referral/stats', async (req, res) => {
    const user = await queryOne('SELECT referral_code FROM users WHERE id = ?', [req.user.id]);
    const code = user?.referral_code || null;
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    const referralLink = code ? `${appUrl}/pricing?ref=${encodeURIComponent(code)}` : null;

    const referred  = await queryOne('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ?', [req.user.id]);
    const converted = await queryOne('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ? AND converted_at IS NOT NULL', [req.user.id]);
    const credited  = await queryOne('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ? AND credit_applied_at IS NOT NULL', [req.user.id]);

    res.json({
      referral_code:   code,
      referral_link:   referralLink,
      total_referred:  referred?.c  || 0,
      total_converted: converted?.c || 0,
      months_earned:   credited?.c  || 0,
    });
  });

  // POST /api/referral/apply — apply a referral code to the current user's account
  // Idempotent: silently no-ops if already referred or code is invalid.
  app.post('/api/referral/apply', async (req, res) => {
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'code required' });
    }
    try {
      await applyReferral(req.user.id, code.trim());
      res.json({ ok: true });
    } catch (err) {
      console.error('[referral/apply] error:', err.message);
      res.status(500).json({ error: 'Failed to apply referral code' });
    }
  });
}

module.exports = { registerPublic, registerAuth };
