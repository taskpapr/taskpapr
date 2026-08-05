  document.getElementById('yr').textContent = new Date().getFullYear();

  // Show expired banner if redirected from requireSubscription
  if (new URLSearchParams(location.search).has('expired')) {
    document.getElementById('expired-banner').classList.add('visible');
  }

  // Show "← Board" and hide "Sign in" if already logged in
  fetch('/api/me').then(r => {
    if (r.ok) {
      document.getElementById('nav-board-btn').style.display = '';
      document.getElementById('nav-signin-btn').style.display = 'none';
    }
  }).catch(() => {});

  // ── Pricing config (loaded from server — never hardcoded) ──
  // Detect referral — show extended trial callout if ?ref= is in the URL
  const refCode = new URLSearchParams(location.search).get('ref');
  if (refCode) {
    const badge = document.getElementById('trial-badge');
    if (badge) {
      badge.textContent = '🎁 You\'ve been referred — enjoy a 30-day free trial · No card required';
      badge.style.background = '#d4edda';
      badge.style.color = '#1a4a1a';
      badge.style.borderColor = '#b7d9a0';
    }
  }

  let pricing = { currency_symbol: '', monthly: 0, annual: 0, annual_monthly_equivalent: 0, trial_days: 14 };

  // ── Interval toggle ────────────────────
  let annual = false;
  const toggle   = document.getElementById('interval-toggle');
  const lblMo    = document.getElementById('lbl-monthly');
  const lblAn    = document.getElementById('lbl-annual');
  const soloPrice  = document.getElementById('solo-price');
  const soloPeriod = document.getElementById('solo-period');
  const soloAnnual = document.getElementById('solo-annual');

  function updateToggle() {
    const sym = pricing.currency_symbol || '';
    toggle.classList.toggle('annual', annual);
    lblMo.style.fontWeight = annual ? '400' : '600';
    lblMo.style.color      = annual ? '#888' : '#1a1a1a';
    if (annual) {
      soloPrice.textContent  = pricing.annual > 0 ? `${sym}${pricing.annual}` : '—';
      soloPeriod.textContent = '/year';
      soloAnnual.textContent = pricing.annual_monthly_equivalent > 0
        ? `That's ${sym}${pricing.annual_monthly_equivalent}/month — 2 months free`
        : '\u00a0';
    } else {
      soloPrice.textContent  = pricing.monthly > 0 ? `${sym}${pricing.monthly}` : '—';
      soloPeriod.textContent = '/month';
      soloAnnual.textContent = '\u00a0';
    }
  }

  // Load pricing from server, then render
  fetch('/api/pricing').then(r => r.json()).then(p => {
    pricing = p;
    updateToggle();
  }).catch(() => {
    // Server unreachable or Stripe not configured — render dashes, don't crash
    updateToggle();
  });

  toggle.addEventListener('click', () => { annual = !annual; updateToggle(); });
  toggle.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { annual = !annual; updateToggle(); } });

  function getSafeRedirectUrl(url) {
    if (!url || typeof url !== 'string') return null;
    let u;
    try {
      u = new URL(url, location.origin);
    } catch (_) {
      return null;
    }
    // Allow same-origin navigations (including relative paths)
    if (u.origin === location.origin) return u.href;
    // Allow Stripe-hosted checkout/portal URLs
    if (u.protocol === 'https:' && (u.hostname === 'stripe.com' || u.hostname.endsWith('.stripe.com'))) return u.href;
    return null;
  }

  // ── CTA handler ────────────────────────
  document.getElementById('solo-cta').addEventListener('click', async function() {
    this.disabled = true;
    this.textContent = 'Redirecting…';

    // Check auth state
    const meRes = await fetch('/api/me');
    if (!meRes.ok) {
      // Not signed in — send to login first, then back here
      location.href = '/login';
      return;
    }

    const me = await meRes.json();

    // If Stripe not configured, just send to the board
    if (!me.stripe_configured) {
      location.href = '/';
      return;
    }

    // If already active, send to board
    if (me.subscription_status === 'active') {
      location.href = '/';
      return;
    }

    // If on trial, create checkout
    try {
      const r = await fetch('/api/billing/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval: annual ? 'annual' : 'monthly' }),
      });
      const data = await r.json();
      if (data.url) {
        const safeUrl = getSafeRedirectUrl(data.url);
        if (safeUrl) {
          location.href = safeUrl;
        } else {
          alert('Could not start checkout: unsafe redirect URL');
          this.disabled = false;
          this.textContent = 'Start free trial →';
        }
      } else {
        alert('Could not start checkout: ' + (data.error || 'unknown error'));
        this.disabled = false;
        this.textContent = 'Start free trial →';
      }
    } catch (err) {
      alert('Error: ' + err.message);
      this.disabled = false;
      this.textContent = 'Start free trial →';
    }
  });
