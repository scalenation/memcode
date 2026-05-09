const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : window.location.origin;

// ── Token bootstrap ───────────────────────────────────────────────────────────
// After OAuth redirect, token arrives as ?token=... in the URL
const urlParams = new URLSearchParams(window.location.search);
const urlToken  = urlParams.get('token');
if (urlToken) {
  localStorage.setItem('mc_token', urlToken);
  history.replaceState(null, '', '/dashboard');
}

const token = localStorage.getItem('mc_token');
if (!token) {
  window.location.replace('/login');
}

// ── Sign out ──────────────────────────────────────────────────────────────────
document.getElementById('signout-btn')?.addEventListener('click', () => {
  localStorage.removeItem('mc_token');
  window.location.replace('/login');
});

// ── Load profile ──────────────────────────────────────────────────────────────
async function authFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
}

async function loadProfile() {
  const res = await authFetch('/v1/user/profile');
  if (res.status === 401) {
    localStorage.removeItem('mc_token');
    window.location.replace('/login?error=session_expired');
    return;
  }
  if (!res.ok) {
    showError('Failed to load your profile. Please refresh.');
    return;
  }

  const { email, subscription } = await res.json();

  // Nav + account
  document.getElementById('nav-email').textContent = email;
  document.getElementById('acc-email').textContent  = email;

  // Subscription
  document.getElementById('sub-loading').hidden = true;
  document.getElementById('sub-content').hidden = false;

  if (subscription && subscription.status !== 'canceled') {
    document.getElementById('sub-active').hidden = false;
    document.getElementById('sub-plan').textContent   = subscription.planName;
    document.getElementById('sub-renews').textContent = formatDate(subscription.currentPeriodEnd);

    // Status badge
    const badge = document.getElementById('sub-status-badge');
    const statusClass = `status-${subscription.status}`;
    badge.innerHTML = `<span class="status-badge ${statusClass}"><span class="status-dot"></span>${capitalise(subscription.status.replace('_', ' '))}</span>`;

    // Show CLI card only when active/trialing
    if (['active', 'trialing'].includes(subscription.status)) {
      document.getElementById('cli-card').hidden = false;
    }
  } else {
    document.getElementById('sub-free').hidden = false;
  }
}

// ── Manage billing (Stripe portal) ────────────────────────────────────────────
document.getElementById('manage-billing-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('manage-billing-btn');
  btn.disabled    = true;
  btn.textContent = 'Opening…';

  try {
    const res  = await authFetch('/v1/billing/portal', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
    window.location.href = body.url;
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Could not open billing portal.');
    btn.disabled    = false;
    btn.innerHTML   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg> Manage billing';
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
}

loadProfile();
