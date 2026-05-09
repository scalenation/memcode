const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : window.location.origin;

// ── Token bootstrap ───────────────────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const urlToken  = urlParams.get('token');
if (urlToken) {
  localStorage.setItem('mc_token', urlToken);
  history.replaceState(null, '', '/dashboard');
}

const token = localStorage.getItem('mc_token');
if (!token) window.location.replace('/login');

// ── Stripe ────────────────────────────────────────────────────────────────────
const stripe = window.Stripe ? window.Stripe(window.STRIPE_PK) : null;
let updateCardElement = null;

// ── Sign out ──────────────────────────────────────────────────────────────────
document.getElementById('signout-btn')?.addEventListener('click', () => {
  localStorage.removeItem('mc_token');
  window.location.replace('/login');
});

// ── Auth fetch helper ─────────────────────────────────────────────────────────
async function authFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
}

// ── Load profile ──────────────────────────────────────────────────────────────
async function loadProfile() {
  const res = await authFetch('/v1/user/profile');
  if (res.status === 401) {
    localStorage.removeItem('mc_token');
    window.location.replace('/login?error=session_expired');
    return;
  }
  if (!res.ok) { showError('Failed to load your profile. Please refresh.'); return; }

  const { email, subscription } = await res.json();

  document.getElementById('nav-email').textContent = email;
  document.getElementById('acc-email').textContent  = email;

  document.getElementById('sub-loading').hidden = true;
  document.getElementById('sub-content').hidden = false;

  if (subscription && subscription.status !== 'canceled') {
    document.getElementById('sub-active').hidden = false;
    document.getElementById('sub-plan').textContent   = subscription.planName;
    document.getElementById('sub-renews').textContent = formatDate(subscription.currentPeriodEnd);

    const badge = document.getElementById('sub-status-badge');
    const cls   = `status-${subscription.status}`;
    badge.innerHTML = `<span class="status-badge ${cls}"><span class="status-dot"></span>${capitalise(subscription.status.replace('_', ' '))}</span>`;

    if (['active', 'trialing'].includes(subscription.status)) {
      document.getElementById('cli-card').hidden = false;
    }
  } else {
    document.getElementById('sub-free').hidden = false;
  }
}

// ── Update payment method ─────────────────────────────────────────────────────
document.getElementById('update-card-btn')?.addEventListener('click', async () => {
  const form = document.getElementById('card-update-form');
  form.hidden = false;
  document.getElementById('cancel-confirm').hidden = true;
  document.getElementById('update-card-btn').hidden = true;

  if (!updateCardElement && stripe) {
    const elements = stripe.elements({ appearance: { theme: 'night' } });
    updateCardElement = elements.create('card', {
      style: { base: { color: '#e5e7eb', fontFamily: 'Inter, sans-serif', fontSize: '15px', '::placeholder': { color: '#6b7280' } } },
    });
    updateCardElement.mount('#update-card-element');
  }
});

document.getElementById('card-update-cancel')?.addEventListener('click', () => {
  document.getElementById('card-update-form').hidden = true;
  document.getElementById('update-card-btn').hidden = false;
  document.getElementById('update-card-errors').style.display = 'none';
});

document.getElementById('card-save-btn')?.addEventListener('click', async () => {
  if (!stripe || !updateCardElement) return;
  const saveBtn = document.getElementById('card-save-btn');
  const errEl   = document.getElementById('update-card-errors');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';
  errEl.style.display = 'none';

  try {
    // 1. Get a SetupIntent client secret
    const siRes  = await authFetch('/v1/billing/update-payment', { method: 'POST' });
    const siBody = await siRes.json();
    if (!siRes.ok) throw new Error(siBody.error ?? 'Failed to start payment update');

    // 2. Confirm the card on Stripe's side
    const { setupIntent, error } = await stripe.confirmCardSetup(siBody.clientSecret, {
      payment_method: { card: updateCardElement },
    });
    if (error) throw new Error(error.message);

    // 3. Tell the backend to attach the new PM
    const confirmRes = await authFetch('/v1/billing/confirm-payment-update', {
      method: 'POST',
      body: JSON.stringify({ paymentMethodId: setupIntent.payment_method }),
    });
    const confirmBody = await confirmRes.json();
    if (!confirmRes.ok) throw new Error(confirmBody.error ?? 'Failed to save card');

    document.getElementById('card-update-form').hidden = true;
    document.getElementById('update-card-btn').hidden  = false;
    showSuccess('Payment method updated successfully.');
  } catch (err) {
    errEl.textContent   = err instanceof Error ? err.message : 'Failed to update card.';
    errEl.style.display = 'block';
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save card';
  }
});

// ── Cancel subscription ───────────────────────────────────────────────────────
document.getElementById('cancel-sub-btn')?.addEventListener('click', () => {
  document.getElementById('cancel-confirm').hidden    = false;
  document.getElementById('card-update-form').hidden  = true;
  document.getElementById('update-card-btn').hidden   = true;
});

document.getElementById('cancel-abort-btn')?.addEventListener('click', () => {
  document.getElementById('cancel-confirm').hidden  = true;
  document.getElementById('update-card-btn').hidden = false;
});

document.getElementById('cancel-confirm-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('cancel-confirm-btn');
  btn.disabled    = true;
  btn.textContent = 'Cancelling…';

  try {
    const res  = await authFetch('/v1/billing/cancel', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to cancel');

    document.getElementById('cancel-confirm').hidden  = true;
    document.getElementById('update-card-btn').hidden = false;

    // Update the renews label to show cancel date
    const renewsEl = document.getElementById('sub-renews');
    if (renewsEl && body.cancelAt) {
      renewsEl.textContent = `Active until ${formatDate(body.cancelAt)}`;
    }
    // Update status badge
    const badge = document.getElementById('sub-status-badge');
    badge.innerHTML = `<span class="status-badge status-canceled"><span class="status-dot"></span>Cancels at period end</span>`;
    // Hide cancel button to prevent double-cancel
    document.getElementById('cancel-sub-btn').hidden = true;

    showSuccess('Subscription cancelled. Access continues until the end of your billing period.');
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Failed to cancel subscription.');
    btn.disabled    = false;
    btn.textContent = 'Yes, cancel';
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
function capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
function showError(msg) {
  const el = document.getElementById('dash-error');
  el.textContent = msg;
  el.classList.add('visible');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function showSuccess(msg) {
  const el = document.getElementById('dash-error');
  el.textContent = msg;
  el.style.background   = 'rgba(52,211,153,0.08)';
  el.style.borderColor  = 'rgba(52,211,153,0.25)';
  el.style.color        = '#34d399';
  el.classList.add('visible');
  setTimeout(() => { el.classList.remove('visible'); el.removeAttribute('style'); }, 4000);
}

loadProfile();
