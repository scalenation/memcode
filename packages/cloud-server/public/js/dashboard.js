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
  if (sectionId === 'billing' && !document.getElementById('pm-list').dataset.loaded) {
    loadPaymentMethods();
  }
  if (sectionId === 'workspaces' && !document.getElementById('ws-list').dataset.loaded) {
    loadWorkspaces();
  }
  if (sectionId === 'history') {
    loadHistory();
  }
}

// ── Load profile ──────────────────────────────────────────────────────────────
async function loadProfile() {
  const res = await authFetch('/v1/user/profile');
  if (res.status === 401) { localStorage.removeItem('mc_token'); window.location.replace('/login?error=session_expired'); return; }
  if (!res.ok) { showNotice('Failed to load profile. Please refresh.', 'error'); return; }

  profileData = await res.json();
  const { email, name, subscription } = profileData;
  const activeSub = subscription && subscription.status !== 'canceled' ? subscription : null;

  // Nav
  document.getElementById('nav-email').textContent = email;

  // Overview
  document.getElementById('ov-email').textContent = email;
  document.getElementById('ov-plan').textContent = activeSub ? activeSub.planName : 'Free';
  document.getElementById('ov-sub-loading').hidden = true;
  document.getElementById('ov-sub-content').hidden = false;
  if (activeSub) {
    document.getElementById('ov-sub-content').hidden = false;
    document.getElementById('ov-free').hidden = true;
    document.getElementById('ov-renews').textContent = fmtDate(activeSub.currentPeriodEnd);
    document.getElementById('ov-status-badge').innerHTML = statusBadge(activeSub.status);
  } else {
    document.getElementById('ov-sub-content').hidden = true;
    document.getElementById('ov-free').hidden = false;
  }

  // Profile fields
  document.getElementById('profile-name').value = name ?? '';
  document.getElementById('profile-email').value = email;

  // Show "Set CLI Password" card for OAuth/checkout accounts that have no password yet
  if (profileData.hasPassword === false) {
    document.getElementById('set-cli-password-card').hidden = false;
    document.getElementById('pw-save-btn').closest('.card').hidden = true; // hide change-password card
  }

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

  // Load workspace stats for overview (fire-and-forget)
  loadOverviewStats();
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

// Single persistent event delegation on the PM list
document.getElementById('pm-list').addEventListener('click', handlePmClick);

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

// ── Set initial CLI password (OAuth accounts) ─────────────────────────────────
document.getElementById('cli-pw-save-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('cli-pw-save-btn');
  const msgEl = document.getElementById('cli-pw-msg');
  const newPassword = document.getElementById('cli-pw-new').value;
  const confirmPassword = document.getElementById('cli-pw-confirm').value;

  if (!newPassword || !confirmPassword) {
    setMsg(msgEl, 'Both fields are required.', 'error'); return;
  }
  if (newPassword !== confirmPassword) {
    setMsg(msgEl, 'Passwords do not match.', 'error'); return;
  }
  if (newPassword.length < 8) {
    setMsg(msgEl, 'Password must be at least 8 characters.', 'error'); return;
  }

  btn.disabled = true;
  btn.textContent = 'Setting…';
  setMsg(msgEl, '', null);

  try {
    const res = await authFetch('/v1/auth/set-password', { method: 'POST', body: JSON.stringify({ newPassword }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to set password');
    document.getElementById('cli-pw-new').value = '';
    document.getElementById('cli-pw-confirm').value = '';
    setMsg(msgEl, 'Password set! You can now use memory sync auth from the CLI.', 'success');
    document.getElementById('set-cli-password-card').hidden = true;
    document.getElementById('pw-save-btn').closest('.card').hidden = false;
  } catch (err) {
    setMsg(msgEl, err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Set password';
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

// ── Overview workspace stats ──────────────────────────────────────────────────
async function loadOverviewStats() {
  try {
    const res = await authFetch('/v1/user/workspaces');
    if (!res.ok) return;
    const { workspaces, totalBlobCount } = await res.json();
    document.getElementById('ov-ws-count').textContent = workspaces.length;
    document.getElementById('ov-total-syncs').textContent = totalBlobCount;
  } catch { /* non-fatal */ }
}

// ── Workspaces ────────────────────────────────────────────────────────────────
async function loadWorkspaces() {
  const loading = document.getElementById('ws-loading');
  const list = document.getElementById('ws-list');
  const none = document.getElementById('ws-none');
  loading.hidden = false;
  list.hidden = true;
  none.hidden = true;

  try {
    const res = await authFetch('/v1/user/workspaces');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to load workspaces');
    loading.hidden = true;

    const { workspaces, totalStorageBytes, totalBlobCount } = body;

    // Stats
    document.getElementById('ws-count-stat').textContent = workspaces.length;
    document.getElementById('ws-syncs-stat').textContent = totalBlobCount;

    // Storage bar (500 MB soft limit display)
    const limitBytes = 500 * 1024 * 1024;
    const pct = Math.min(100, (totalStorageBytes / limitBytes) * 100);
    const fill = document.getElementById('storage-bar-fill');
    fill.style.width = `${pct.toFixed(1)}%`;
    fill.classList.remove('warn', 'danger-fill');
    if (pct > 80) fill.classList.add('danger-fill');
    else if (pct > 60) fill.classList.add('warn');
    document.getElementById('storage-used-label').textContent = fmtBytes(totalStorageBytes) + ' used';
    document.getElementById('storage-limit-label').textContent = fmtBytes(limitBytes) + ' limit';

    if (workspaces.length === 0) {
      none.hidden = false;
    } else {
      renderWorkspaces(workspaces);
      list.hidden = false;
    }
    list.dataset.loaded = '1';
  } catch (err) {
    if (document.getElementById('ws-loading')) {
      document.getElementById('ws-loading').hidden = true;
    }
    showNotice(err.message ?? 'Failed to load workspaces.', 'error');
  }
}

function renderWorkspaces(workspaces) {
  const list = document.getElementById('ws-list');
  list.innerHTML = '';
  for (const ws of workspaces) {
    const div = document.createElement('div');
    div.className = 'ws-row';
    const lastSync = ws.lastSyncedAt ? timeAgo(ws.lastSyncedAt) : 'Never';
    div.innerHTML = `
      <div class="ws-info">
        <div class="ws-id">${esc(ws.id)}</div>
        <div class="ws-meta">Last sync: ${lastSync} &nbsp;·&nbsp; ${ws.blobCount} blob${ws.blobCount !== 1 ? 's' : ''} &nbsp;·&nbsp; ${fmtBytes(ws.storageBytes)}</div>
        <div class="ws-del-confirm" id="wsc-${esc(ws.id)}" hidden>
          <span>Delete this workspace and all its blobs?</span>
          <button class="btn btn-danger btn-sm" data-action="ws-delete-confirm" data-ws="${esc(ws.id)}">Delete</button>
          <button class="btn btn-secondary btn-sm" data-action="ws-delete-cancel" data-ws="${esc(ws.id)}">Cancel</button>
        </div>
      </div>
      <button class="btn btn-danger btn-sm" id="ws-del-btn-${esc(ws.id)}" data-action="ws-delete" data-ws="${esc(ws.id)}">Delete</button>
    `;
    list.appendChild(div);
  }
}

document.getElementById('ws-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const wsId = btn.dataset.ws;

  if (action === 'ws-delete') {
    btn.hidden = true;
    document.getElementById(`wsc-${wsId}`).hidden = false;
  }
  if (action === 'ws-delete-cancel') {
    document.getElementById(`wsc-${wsId}`).hidden = true;
    document.getElementById(`ws-del-btn-${wsId}`).hidden = false;
  }
  if (action === 'ws-delete-confirm') {
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      const res = await authFetch(`/v1/user/workspaces/${encodeURIComponent(wsId)}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to delete workspace');
      showNotice('Workspace deleted.', 'success');
      document.getElementById('ws-list').removeAttribute('data-loaded');
      loadWorkspaces();
    } catch (err) {
      showNotice(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  }
});

// ── Sessions ──────────────────────────────────────────────────────────────────
async function loadSessions() {
  const loading = document.getElementById('sessions-loading');
  const list = document.getElementById('sessions-list');
  const none = document.getElementById('sessions-none');
  loading.hidden = false;
  list.hidden = true;
  none.hidden = true;

  try {
    const res = await authFetch('/v1/user/sessions');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to load sessions');
    loading.hidden = true;

    const { sessions } = body;
    if (!sessions || sessions.length === 0) {
      none.hidden = false;
    } else {
      renderSessions(sessions);
      list.hidden = false;
    }
    list.dataset.loaded = '1';
  } catch (err) {
    if (document.getElementById('sessions-loading')) {
      document.getElementById('sessions-loading').hidden = true;
    }
    showNotice(err.message ?? 'Failed to load sessions.', 'error');
  }
}

function parseUA(ua) {
  if (!ua) return 'Unknown device';
  if (/memcode|memory.sync|memory-sync/i.test(ua)) return 'MemCode CLI';
  if (/python/i.test(ua)) return 'Python CLI';
  if (/curl/i.test(ua)) return 'Terminal (curl)';
  if (/edg\//i.test(ua)) return 'Edge Browser';
  if (/chrome/i.test(ua)) return 'Chrome Browser';
  if (/firefox/i.test(ua)) return 'Firefox Browser';
  if (/safari/i.test(ua)) return 'Safari Browser';
  const first = ua.split(/[\s/]/)[0];
  return first.length > 0 ? first : 'Unknown device';
}

function renderSessions(sessions) {
  const list = document.getElementById('sessions-list');
  list.innerHTML = '';
  for (const sess of sessions) {
    const div = document.createElement('div');
    div.className = 'session-row';
    const label = parseUA(sess.userAgent);
    const metaParts = [];
    if (sess.ip) metaParts.push(`IP: ${esc(sess.ip)}`);
    metaParts.push(`Last seen: ${timeAgo(sess.lastSeenAt)}`);
    metaParts.push(`Created: ${fmtDate(sess.createdAt)}`);
    div.innerHTML = `
      <div class="session-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
      </div>
      <div class="session-info">
        <div class="session-ua">${esc(label)}${sess.isCurrent ? '<span class="current-badge">current</span>' : ''}</div>
        <div class="session-meta">${metaParts.join(' · ')}</div>
      </div>
      ${!sess.isCurrent
        ? `<button class="btn btn-danger btn-sm" data-action="revoke-session" data-sess="${esc(sess.id)}">Revoke</button>`
        : '<span style="font-size:0.75rem;color:var(--text-dim)">This session</span>'}
    `;
    list.appendChild(div);
  }
}

document.getElementById('sessions-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="revoke-session"]');
  if (!btn) return;
  const sessId = btn.dataset.sess;
  btn.disabled = true;
  btn.textContent = 'Revoking…';
  try {
    const res = await authFetch(`/v1/user/sessions/${encodeURIComponent(sessId)}`, { method: 'DELETE' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to revoke session');
    showNotice('Session revoked.', 'success');
    document.getElementById('sessions-list').removeAttribute('data-loaded');
    loadSessions();
  } catch (err) {
    showNotice(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Revoke';
  }
});

// ── Delete account ────────────────────────────────────────────────────────────
document.getElementById('delete-account-btn')?.addEventListener('click', () => {
  document.getElementById('delete-account-confirm').hidden = false;
  document.getElementById('delete-account-btn').hidden = true;
});
document.getElementById('delete-account-abort-btn')?.addEventListener('click', () => {
  document.getElementById('delete-account-confirm').hidden = true;
  document.getElementById('delete-account-btn').hidden = false;
});
document.getElementById('delete-account-confirm-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('delete-account-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const res = await authFetch('/v1/user/account', { method: 'DELETE' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to delete account');
    localStorage.removeItem('mc_token');
    window.location.replace('/login?message=account_deleted');
  } catch (err) {
    showNotice(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Yes, permanently delete';
    document.getElementById('delete-account-confirm').hidden = true;
    document.getElementById('delete-account-btn').hidden = false;
  }
});

// ── Extra helpers ─────────────────────────────────────────────────────────────
function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return fmtDate(iso);
}

// ── Session History ───────────────────────────────────────────────────────────
let historyData = [];

async function loadHistory() {
  const loading = document.getElementById('hist-loading');
  const empty   = document.getElementById('hist-empty');
  const list    = document.getElementById('hist-list');
  loading.hidden = false;
  empty.hidden   = true;
  list.innerHTML = '';

  try {
    const res  = await authFetch('/v1/sync/history');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to load history');

    historyData = body.workspaces ?? [];
    loading.hidden = true;

    if (historyData.length === 0) {
      empty.hidden = false;
    } else {
      renderHistory(historyData);
    }
    list.dataset.loaded = '1';
  } catch (err) {
    loading.hidden = true;
    showNotice(err.message ?? 'Failed to load history.', 'error');
  }
}

function parseCLIUA(ua) {
  if (!ua) return null;
  const cliMatch = ua.match(/MemCode-CLI\/([^\s]+)/i) || ua.match(/memcode[/-](\S+)/i);
  if (cliMatch) return `MemCode CLI ${cliMatch[1]}`;
  if (/memcode|memory.sync/i.test(ua)) return 'MemCode CLI';
  if (/python/i.test(ua)) return 'Python';
  if (/curl/i.test(ua)) return 'curl';
  if (/edg\//i.test(ua)) return 'Edge';
  if (/chrome/i.test(ua)) return 'Chrome';
  if (/firefox/i.test(ua)) return 'Firefox';
  if (/safari/i.test(ua)) return 'Safari';
  return ua.split(/[\s/]/)[0] || 'Unknown';
}

function renderHistory(workspaces) {
  const list = document.getElementById('hist-list');
  list.innerHTML = '';
  updateHistCount(workspaces.length);

  for (const ws of workspaces) {
    const cpCount = ws.checkpoints ? ws.checkpoints.length : 0;
    const lastCp  = ws.checkpoints && ws.checkpoints[0];
    const wsName  = ws.name || ws.id.slice(0, 12) + '…';

    const card = document.createElement('div');
    card.className = 'hist-ws';
    card.dataset.wsId = ws.id;

    const metaParts = [];
    if (ws.machineName) metaParts.push(`<span class="hist-ws-meta-item"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>${esc(ws.machineName)}</span>`);
    if (lastCp) metaParts.push(`<span class="hist-ws-meta-item"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Last sync ${timeAgo(lastCp.createdAt)}</span>`);
    metaParts.push(`<span class="hist-ws-meta-item">Created ${fmtDate(ws.createdAt)}</span>`);

    let checkpointsHtml = '';
    if (cpCount > 0) {
      for (const cp of ws.checkpoints) {
        const uaLabel = parseCLIUA(cp.userAgent) || 'Unknown';
        const restoreCmd = `memory sync restore ${cp.id}`;
        const detailParts = [];
        if (cp.ip) detailParts.push(`<span class="hist-cp-detail-item"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>${esc(cp.ip)}</span>`);
        detailParts.push(`<span class="hist-cp-detail-item"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>${esc(uaLabel)}</span>`);
        detailParts.push(`<span class="hist-cp-detail-item" title="${esc(new Date(cp.createdAt).toLocaleString())}">${esc(new Date(cp.createdAt).toLocaleString())}</span>`);

        checkpointsHtml += `
          <div class="hist-cp" data-blob-id="${esc(cp.id)}">
            <div class="hist-cp-dot"></div>
            <div class="hist-cp-body">
              <div class="hist-cp-top">
                <span class="hist-cp-time">${timeAgo(cp.createdAt)}</span>
                ${cp.label ? `<span class="hist-cp-label">${esc(cp.label)}</span>` : ''}
              </div>
              ${cp.meta && cp.meta.length > 0 ? `<div class="hist-cp-summaries">${cp.meta.map(m => {
                const parts = [];
                if (m.trigger) parts.push(`<span class="hist-meta-tag hist-meta-trigger">${esc(m.trigger)}</span>`);
                if (m.branch) parts.push(`<span class="hist-meta-tag">${esc(m.branch)}</span>`);
                if (m.git_sha) parts.push(`<code class="hist-meta-sha">${esc(m.git_sha)}</code>`);
                return `<div class="hist-meta-row">${parts.join('')}${m.summary ? `<span class="hist-meta-summary">${esc(m.summary)}</span>` : ''}</div>`;
              }).join('')}</div>` : ''}
              <div class="hist-cp-details">${detailParts.join('')}</div>
              <div class="hist-cp-restore">
                <code>${esc(restoreCmd)}</code>
                <button class="hist-cp-copy" data-copy="${esc(restoreCmd)}" title="Copy restore command">Copy</button>
              </div>
            </div>
          </div>`;
      }
    } else {
      checkpointsHtml = `<div style="padding:14px 20px;font-size:0.82rem;color:var(--text-dim)">No checkpoints yet.</div>`;
    }

    card.innerHTML = `
      <div class="hist-ws-header">
        <div class="hist-ws-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h6l2 3h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg>
        </div>
        <div class="hist-ws-info">
          <div class="hist-ws-name">${esc(wsName)}</div>
          <div class="hist-ws-meta">${metaParts.join('')}</div>
        </div>
        <span class="hist-ws-badge">${cpCount} checkpoint${cpCount !== 1 ? 's' : ''}</span>
        <svg class="hist-ws-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
      <div class="hist-checkpoints">${checkpointsHtml}</div>`;

    // Toggle expand/collapse
    card.querySelector('.hist-ws-header').addEventListener('click', () => {
      card.classList.toggle('open');
    });

    // Copy restore command buttons
    card.querySelectorAll('.hist-cp-copy').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(btn.dataset.copy).then(() => {
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
        });
      });
    });

    list.appendChild(card);
  }
}

function updateHistCount(total) {
  const badge = document.getElementById('hist-count');
  if (badge) badge.textContent = total > 0 ? `${total} workspace${total !== 1 ? 's' : ''}` : '';
}

// Search filter
document.getElementById('hist-search')?.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  const cards = document.querySelectorAll('.hist-ws');
  let visible = 0;
  cards.forEach(card => {
    const wsId   = card.dataset.wsId ?? '';
    const wsName = card.querySelector('.hist-ws-name')?.textContent?.toLowerCase() ?? '';
    const machine = card.querySelector('.hist-ws-meta')?.textContent?.toLowerCase() ?? '';
    const cpTexts = Array.from(card.querySelectorAll('.hist-cp-restore code')).map(c => c.textContent.toLowerCase()).join(' ');
    const matches = !q || wsName.includes(q) || wsId.includes(q) || machine.includes(q) || cpTexts.includes(q);
    card.classList.toggle('hidden', !matches);
    if (matches) visible++;
  });
  updateHistCount(visible);
});
