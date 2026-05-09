const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3000' : window.location.origin;

// ── Bootstrap token ───────────────────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const urlToken = urlParams.get('token');
if (urlToken) { localStorage.setItem('mc_token', urlToken); history.replaceState(null, '', '/dashboard'); }
const token = localStorage.getItem('mc_token');
if (!token) window.location.replace('/login');

// ── Stripe ────────────────────────────────────────────────────────────────────
const stripe = window.Stripe ? window.Stripe(window.STRIPE_PK) : null;
let addCardElement = null;
let addCardElements = null;

// ── App state ─────────────────────────────────────────────────────────────────
let profileData = null; // { email, name, subscription }

// ── Auth fetch ────────────────────────────────────────────────────────────────
async function authFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
}

// ── Sign out ──────────────────────────────────────────────────────────────────
function signOut() { localStorage.removeItem('mc_token'); window.location.replace('/login'); }
document.getElementById('signout-btn')?.addEventListener('click', signOut);
document.getElementById('signout-sidebar')?.addEventListener('click', signOut);

// ── Sidebar navigation ────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item[data-section]').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.section));
});

function navigateTo(sectionId) {
  document.querySelectorAll('.nav-item[data-section]').forEach(b => b.classList.toggle('active', b.dataset.section === sectionId));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === `section-${sectionId}`));
  // Lazy-load billing section PM list when first opened
  if (sectionId === 'billing' && !document.getElementById('pm-list').dataset.loaded) {
    loadPaymentMethods();
  }
}

// ── Load profile ──────────────────────────────────────────────────────────────
async function loadProfile() {
  const res = await authFetch('/v1/user/profile');
  if (res.status === 401) { localStorage.removeItem('mc_token'); window.location.replace('/login?error=session_expired'); return; }
  if (!res.ok) { showNotice('Failed to load profile. Please refresh.', 'error'); return; }

  profileData = await res.json();
  const { email, name, subscription } = profileData;

  // Nav
  document.getElementById('nav-email').textContent = email;

  // Overview
  document.getElementById('ov-email').textContent = email;
  document.getElementById('ov-plan').textContent = subscription ? subscription.planName : 'Free';
  document.getElementById('ov-sub-loading').hidden = true;
  document.getElementById('ov-sub-content').hidden = false;
  if (subscription && subscription.status !== 'canceled') {
    document.getElementById('ov-sub-content').hidden = false;
    document.getElementById('ov-free').hidden = true;
    document.getElementById('ov-renews').textContent = fmtDate(subscription.currentPeriodEnd);
    document.getElementById('ov-status-badge').innerHTML = statusBadge(subscription.status);
  } else {
    document.getElementById('ov-sub-content').hidden = true;
    document.getElementById('ov-free').hidden = false;
  }

  // Profile fields
  document.getElementById('profile-name').value = name ?? '';
  document.getElementById('profile-email').value = email;

  // Billing subscription
  document.getElementById('billing-sub-loading').hidden = true;
  document.getElementById('billing-sub-content').hidden = false;
  if (subscription && subscription.status !== 'canceled') {
    document.getElementById('billing-sub-active').hidden = false;
    document.getElementById('billing-free').hidden = true;
    document.getElementById('billing-plan').textContent = subscription.planName;
    document.getElementById('billing-renews').textContent = fmtDate(subscription.currentPeriodEnd);
    document.getElementById('billing-status-badge').innerHTML = statusBadge(subscription.status);
  } else {
    document.getElementById('billing-sub-active').hidden = true;
    document.getElementById('billing-free').hidden = false;
  }
}

// ── Payment Methods ───────────────────────────────────────────────────────────
async function loadPaymentMethods() {
  document.getElementById('pm-loading').hidden = false;
  document.getElementById('pm-list').hidden = true;
  document.getElementById('pm-none').hidden = true;

  try {
    const res = await authFetch('/v1/billing/payment-methods');
    const body = await res.json();
    document.getElementById('pm-loading').hidden = true;
    renderPaymentMethods(body.paymentMethods ?? []);
    document.getElementById('pm-list').dataset.loaded = '1';
  } catch (_) {
    document.getElementById('pm-loading').hidden = true;
    document.getElementById('pm-none').hidden = false;
  }
}

function renderPaymentMethods(methods) {
  const list = document.getElementById('pm-list');
  list.innerHTML = '';

  if (methods.length === 0) {
    document.getElementById('pm-none').hidden = false;
    return;
  }

  for (const pm of methods) {
    const exp = `${String(pm.expMonth).padStart(2, '0')}/${String(pm.expYear).slice(-2)}`;
    const wrapper = document.createElement('div');

    const row = document.createElement('div');
    row.className = `pm-row${pm.isDefault ? ' is-default' : ''}`;
    row.dataset.pmId = pm.id;
    row.innerHTML = `
      <span class="pm-brand-icon">${esc(pm.brand)}</span>
      <span class="pm-digits">···· ${esc(pm.last4)}</span>
      <span class="pm-expiry">${exp}</span>
      ${pm.isDefault ? '<span class="pm-default-badge">Default</span>' : ''}
      <span class="pm-actions">
        ${!pm.isDefault ? `<button class="btn btn-secondary btn-sm" data-action="set-default" data-pm="${esc(pm.id)}">Set default</button>` : ''}
        <button class="btn btn-danger btn-sm" data-action="delete" data-pm="${esc(pm.id)}">Delete</button>
      </span>
    `;

    const confirmBar = document.createElement('div');
    confirmBar.className = 'pm-delete-confirm';
    confirmBar.hidden = true;
    confirmBar.innerHTML = `
      <span>Remove this card?</span>
      <button class="btn btn-danger btn-sm" data-action="delete-confirm" data-pm="${esc(pm.id)}">Remove</button>
      <button class="btn btn-secondary btn-sm" data-action="delete-cancel">Cancel</button>
    `;

    wrapper.appendChild(row);
    wrapper.appendChild(confirmBar);
    list.appendChild(wrapper);
  }

  list.hidden = false;
  document.getElementById('pm-none').hidden = true;

  // Event delegation
  list.addEventListener('click', handlePmClick);
}

async function handlePmClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const pmId = btn.dataset.pm;
  const wrapper = btn.closest('.pm-row')?.parentElement ?? btn.closest('.pm-delete-confirm')?.parentElement;

  if (action === 'set-default') {
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await authFetch('/v1/billing/set-default-payment', { method: 'POST', body: JSON.stringify({ paymentMethodId: pmId }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed');
      showNotice('Default payment method updated.', 'success');
      loadPaymentMethods();
    } catch (err) {
      showNotice(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Set default';
    }
  }

  if (action === 'delete') {
    wrapper?.querySelector('.pm-delete-confirm')?.removeAttribute('hidden');
    btn.hidden = true;
  }

  if (action === 'delete-cancel') {
    const confirmBar = btn.closest('.pm-delete-confirm');
    confirmBar.hidden = true;
    wrapper?.querySelector('[data-action="delete"]')?.removeAttribute('hidden');
  }

  if (action === 'delete-confirm') {
    btn.disabled = true;
    btn.textContent = 'Removing…';
    try {
      const res = await authFetch(`/v1/billing/payment-method/${encodeURIComponent(pmId)}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to remove card');
      showNotice('Card removed.', 'success');
      loadPaymentMethods();
    } catch (err) {
      showNotice(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Remove';
    }
  }
}

// Remove stale delegation when reloading
const listEl = document.getElementById('pm-list');
const origList = listEl.cloneNode(false);

// ── Add card ──────────────────────────────────────────────────────────────────
document.getElementById('add-card-btn')?.addEventListener('click', () => {
  const form = document.getElementById('add-card-form');
  form.hidden = false;
  document.getElementById('add-card-btn').hidden = true;
  document.getElementById('add-card-errors').style.display = 'none';

  if (!addCardElement && stripe) {
    addCardElements = stripe.elements({ appearance: { theme: 'night' } });
    addCardElement = addCardElements.create('card', {
      style: { base: { color: '#e5e7eb', fontFamily: 'Inter, sans-serif', fontSize: '15px', '::placeholder': { color: '#6b7280' } } },
    });
    addCardElement.mount('#add-card-element');
  }
});

document.getElementById('add-card-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('add-card-form').hidden = true;
  document.getElementById('add-card-btn').hidden = false;
  document.getElementById('add-card-errors').style.display = 'none';
});

document.getElementById('add-card-save-btn')?.addEventListener('click', async () => {
  if (!stripe || !addCardElement) return;
  const saveBtn = document.getElementById('add-card-save-btn');
  const errEl = document.getElementById('add-card-errors');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Adding…';
  errEl.style.display = 'none';

  try {
    // 1. Create SetupIntent
    const siRes = await authFetch('/v1/billing/update-payment', { method: 'POST' });
    const siBody = await siRes.json();
    if (!siRes.ok) throw new Error(siBody.error ?? 'Failed to init card setup');

    // 2. Confirm with Stripe
    const { setupIntent, error } = await stripe.confirmCardSetup(siBody.clientSecret, {
      payment_method: { card: addCardElement },
    });
    if (error) throw new Error(error.message);

    // 3. Attach to customer (sets as default)
    const confirmRes = await authFetch('/v1/billing/confirm-payment-update', {
      method: 'POST',
      body: JSON.stringify({ paymentMethodId: setupIntent.payment_method }),
    });
    const confirmBody = await confirmRes.json();
    if (!confirmRes.ok) throw new Error(confirmBody.error ?? 'Failed to save card');

    // Reset form
    addCardElement.clear();
    document.getElementById('add-card-form').hidden = true;
    document.getElementById('add-card-btn').hidden = false;
    showNotice('Card added successfully.', 'success');
    loadPaymentMethods();
  } catch (err) {
    errEl.textContent = err.message ?? 'Failed to add card.';
    errEl.style.display = 'block';
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Add card';
  }
});

// ── Cancel subscription ───────────────────────────────────────────────────────
document.getElementById('cancel-sub-btn')?.addEventListener('click', () => {
  document.getElementById('cancel-confirm').hidden = false;
  document.getElementById('cancel-sub-btn').hidden = true;
});
document.getElementById('cancel-abort-btn')?.addEventListener('click', () => {
  document.getElementById('cancel-confirm').hidden = true;
  document.getElementById('cancel-sub-btn').hidden = false;
});
document.getElementById('cancel-confirm-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('cancel-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Cancelling…';
  try {
    const res = await authFetch('/v1/billing/cancel', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to cancel');

    document.getElementById('cancel-confirm').hidden = true;
    document.getElementById('billing-renews').textContent = `Active until ${fmtDate(body.cancelAt)}`;
    document.getElementById('billing-status-badge').innerHTML = statusBadge('canceled');
    document.getElementById('cancel-sub-btn').remove();
    document.getElementById('ov-plan').textContent = 'Cancelling';
    document.getElementById('ov-status-badge').innerHTML = statusBadge('canceled');
    showNotice('Subscription cancelled. Access continues until end of billing period.', 'success');
  } catch (err) {
    showNotice(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Yes, cancel';
  }
});

// ── Profile save ──────────────────────────────────────────────────────────────
document.getElementById('profile-save-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('profile-save-btn');
  const msgEl = document.getElementById('profile-msg');
  const name = document.getElementById('profile-name').value.trim();

  btn.disabled = true;
  btn.textContent = 'Saving…';
  setMsg(msgEl, '', null);

  try {
    const res = await authFetch('/v1/user/profile', { method: 'PUT', body: JSON.stringify({ name }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to save');
    setMsg(msgEl, 'Changes saved.', 'success');
  } catch (err) {
    setMsg(msgEl, err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save changes';
  }
});

// ── Password change ───────────────────────────────────────────────────────────
document.getElementById('pw-save-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('pw-save-btn');
  const msgEl = document.getElementById('pw-msg');
  const currentPassword = document.getElementById('pw-current').value;
  const newPassword = document.getElementById('pw-new').value;
  const confirmPassword = document.getElementById('pw-confirm').value;

  if (!currentPassword || !newPassword || !confirmPassword) {
    setMsg(msgEl, 'All password fields are required.', 'error'); return;
  }
  if (newPassword !== confirmPassword) {
    setMsg(msgEl, 'New passwords do not match.', 'error'); return;
  }
  if (newPassword.length < 8) {
    setMsg(msgEl, 'New password must be at least 8 characters.', 'error'); return;
  }

  btn.disabled = true;
  btn.textContent = 'Updating…';
  setMsg(msgEl, '', null);

  try {
    const res = await authFetch('/v1/user/profile', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to update password');
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
    document.getElementById('pw-confirm').value = '';
    setMsg(msgEl, 'Password updated successfully.', 'success');
  } catch (err) {
    setMsg(msgEl, err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update password';
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function statusBadge(status) {
  const label = status === 'past_due' ? 'Past due' : status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ');
  return `<span class="status-badge status-${esc(status)}"><span class="status-dot"></span>${label}</span>`;
}
function setMsg(el, msg, type) {
  el.textContent = msg;
  el.className = 'form-msg' + (type ? ` ${type}` : '');
}
function showNotice(msg, type) {
  const el = document.getElementById('global-notice');
  el.textContent = msg;
  el.className = `notice-bar ${type} visible`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.classList.remove('visible'); }, 5000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadProfile();
