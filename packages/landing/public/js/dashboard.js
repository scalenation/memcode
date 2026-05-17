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
let historyData = [];
let brainProjectData = [];
let brainPayloadCache = new Map();
let currentBrainPayload = null;
let currentBrainProject = null;
let currentBrainFilter = 'all';
let openRouterModels = [];
const BRAIN_FILTER_ORDER = ['all', 'decision', 'bugfix', 'feature', 'discovery'];

// ── Auth fetch ────────────────────────────────────────────────────────────────
async function authFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
}

function proRequiredMessage() {
  return 'MemCode Pro is required to access synced dashboard history and autosync data.';
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
  if (sectionId === 'brain') {
    loadBrain();
  }
  if (sectionId === 'analytics') {
    loadAnalytics();
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
  openRouterModels = sortAiModels(profileData.aiSettings?.availableModels ?? []);
  populateAiModelOptions(openRouterModels, profileData.aiSettings?.openRouterModel);
  renderAiSettingsState(profileData.aiSettings ?? null);

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

function populateAiModelOptions(models, selectedModel) {
  const select = document.getElementById('ai-model-select');
  if (!select) return;
  select.innerHTML = '';

  const orderedModels = sortAiModels(models);
  for (const model of orderedModels) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = `${model.free ? 'Free · ' : ''}${model.label} · ${model.provider}`;
    select.appendChild(option);
  }

  if (selectedModel && orderedModels.some(model => model.id === selectedModel)) {
    select.value = selectedModel;
  } else if (orderedModels[0]) {
    select.value = orderedModels[0].id;
  }
}

function renderAiSettingsState(aiSettings) {
  const status = document.getElementById('ai-settings-status');
  const select = document.getElementById('ai-model-select');
  if (!status || !select) return;

  if (aiSettings?.openRouterModel && openRouterModels.some(model => model.id === aiSettings.openRouterModel)) {
    select.value = aiSettings.openRouterModel;
  }

  const selectedModel = openRouterModels.find((model) => model.id === select.value || model.id === aiSettings?.openRouterModel);
  const modelLabel = selectedModel ? `${selectedModel.label} · ${selectedModel.provider}` : 'No model selected';
  status.textContent = aiSettings?.hasOpenRouterKey
    ? `${modelLabel} · ${buildAiStatusText(aiSettings)}`
    : `${modelLabel} · No OpenRouter key saved yet. Brain outputs will fall back to built-in summaries until you add one.`;
}

function buildAiStatusText(aiSettings) {
  const availability = aiSettings?.availability;
  if (!availability) {
    return 'OpenRouter key saved. Brain reports and answers will use your selected model when available.';
  }

  const remaining = availability.limitRemaining == null ? 'Unlimited credits' : `${fmtCredits(availability.limitRemaining)} credits remaining`;
  return `${remaining} · ${fmtCredits(availability.usageMonthly)} used this month · ${fmtCredits(availability.usageDaily)} today.`;
}

function sortAiModels(models) {
  return [...models].sort((left, right) => {
    if (Boolean(left.free) !== Boolean(right.free)) {
      return left.free ? -1 : 1;
    }
    const providerCompare = String(left.provider ?? '').localeCompare(String(right.provider ?? ''));
    if (providerCompare !== 0) return providerCompare;
    return String(left.label ?? left.id ?? '').localeCompare(String(right.label ?? right.id ?? ''));
  });
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

document.getElementById('ai-settings-save-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('ai-settings-save-btn');
  const msgEl = document.getElementById('ai-settings-msg');
  const key = document.getElementById('ai-openrouter-key').value.trim();
  const model = document.getElementById('ai-model-select').value;

  btn.disabled = true;
  btn.textContent = 'Saving…';
  setMsg(msgEl, '', null);

  try {
    const res = await authFetch('/v1/user/ai-settings', {
      method: 'PUT',
      body: JSON.stringify({
        openRouterApiKey: key || undefined,
        openRouterModel: model,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to save AI settings');
    profileData.aiSettings = body.aiSettings;
    openRouterModels = sortAiModels(body.aiSettings?.availableModels ?? openRouterModels);
    populateAiModelOptions(openRouterModels, body.aiSettings?.openRouterModel);
    renderAiSettingsState(body.aiSettings);
    document.getElementById('ai-openrouter-key').value = '';
    setMsg(msgEl, body.aiSettings?.hasOpenRouterKey ? 'AI settings saved and validated.' : 'Model preference saved.', 'success');
  } catch (err) {
    setMsg(msgEl, err.message ?? 'Failed to save AI settings.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save AI settings';
  }
});

document.getElementById('ai-settings-clear-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('ai-settings-clear-btn');
  const msgEl = document.getElementById('ai-settings-msg');
  const model = document.getElementById('ai-model-select').value;

  btn.disabled = true;
  btn.textContent = 'Clearing…';
  setMsg(msgEl, '', null);

  try {
    const res = await authFetch('/v1/user/ai-settings', {
      method: 'PUT',
      body: JSON.stringify({ clearOpenRouterKey: true, openRouterModel: model }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to clear OpenRouter key');
    profileData.aiSettings = body.aiSettings;
    openRouterModels = sortAiModels(body.aiSettings?.availableModels ?? openRouterModels);
    populateAiModelOptions(openRouterModels, body.aiSettings?.openRouterModel);
    renderAiSettingsState(body.aiSettings);
    document.getElementById('ai-openrouter-key').value = '';
    setMsg(msgEl, 'OpenRouter key cleared.', 'success');
  } catch (err) {
    setMsg(msgEl, err.message ?? 'Failed to clear OpenRouter key.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Clear key';
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
    if (res.status === 402) throw new Error(proRequiredMessage());
    if (!res.ok) throw new Error(body.error ?? 'Failed to load workspaces');
    loading.hidden = true;

    const { workspaces, totalStorageBytes, totalBlobCount } = body;
    brainProjectData = [];

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

async function ensureBrainProjects(force = false) {
  if (force) brainPayloadCache = new Map();
  if (!force && brainProjectData.length > 0) {
    populateBrainProjectSelect(brainProjectData);
    return brainProjectData;
  }

  const res = await authFetch('/v1/brain/projects');
  const body = await res.json();
  if (res.status === 402) throw new Error(proRequiredMessage());
  if (!res.ok) throw new Error(body.error ?? 'Failed to load project brains');
  brainProjectData = body.projects ?? [];
  populateBrainProjectSelect(brainProjectData);
  return brainProjectData;
}

function populateBrainProjectSelect(projects) {
  populateProjectSelect(document.getElementById('brain-workspace'), projects);
  populateProjectSelect(document.getElementById('analytics-workspace'), projects);
}

function populateProjectSelect(select, projects) {
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = '';

  if (projects.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No synced projects';
    select.appendChild(option);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const project of projects) {
    const option = document.createElement('option');
    option.value = project.projectId;
    const labelParts = [project.projectName || 'Unnamed project'];
    labelParts.push(`${project.workspaceCount} source${project.workspaceCount !== 1 ? 's' : ''}`);
    if (!project.hasBrain) labelParts.push('No brain yet');
    option.textContent = labelParts.join(' · ');
    option.disabled = !project.hasBrain;
    select.appendChild(option);
  }

  const firstAvailable = projects.find(project => project.hasBrain)?.projectId ?? projects[0].projectId;
  const nextValue = projects.some(project => project.projectId === currentValue) ? currentValue : firstAvailable;
  select.value = nextValue;
}

async function fetchBrainProject(projectId) {
  if (brainPayloadCache.has(projectId)) {
    return brainPayloadCache.get(projectId);
  }

  const res = await authFetch(`/v1/brain/projects/${encodeURIComponent(projectId)}`);
  const body = await res.json();
  if (res.status === 402) throw new Error(proRequiredMessage());
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(body.error ?? 'Failed to load project brain');
  brainPayloadCache.set(projectId, body);
  return body;
}

function setProjectSelectValue(selectId, value) {
  const select = document.getElementById(selectId);
  if (select && value && Array.from(select.options).some(option => option.value === value)) {
    select.value = value;
  }
}

async function loadBrain() {
  const loading = document.getElementById('brain-summary-loading');
  const content = document.getElementById('brain-summary-content');
  loading.hidden = false;
  content.hidden = true;
  resetBrainOutputs();

  try {
    const projects = await ensureBrainProjects();
    if (projects.length === 0) {
      currentBrainPayload = null;
      currentBrainProject = null;
      renderBrainEmpty('Sync a project first to build a project brain.');
      return;
    }

    const projectId = document.getElementById('brain-workspace').value || projects[0].projectId;
    const body = await fetchBrainProject(projectId);
    if (!body) {
      currentBrainPayload = null;
      currentBrainProject = null;
      renderBrainEmpty('This project has no compact brain yet. Run a fresh sync from the CLI.');
      return;
    }

    currentBrainPayload = body;
    currentBrainProject = projects.find(project => project.projectId === projectId) ?? null;
    setProjectSelectValue('analytics-workspace', projectId);
    renderBrain(body, currentBrainProject);
    renderBrainSearchResults();
  } catch (err) {
    currentBrainPayload = null;
    currentBrainProject = null;
    renderBrainEmpty(err.message ?? 'Failed to load project brain.');
    showNotice(err.message ?? 'Failed to load project brain.', 'error');
  }
}

function resetBrainOutputs() {
  document.getElementById('brain-answer-empty').hidden = false;
  document.getElementById('brain-answer-content').hidden = true;
  document.getElementById('brain-answer').textContent = '';
  document.getElementById('brain-evidence').innerHTML = '';
  document.getElementById('brain-report-empty').hidden = false;
  document.getElementById('brain-report').hidden = true;
  document.getElementById('brain-report').textContent = '';
}

function renderBrainEmpty(message) {
  document.getElementById('brain-summary-loading').hidden = true;
  document.getElementById('brain-summary-content').hidden = false;
  document.getElementById('brain-summary').textContent = message;
  document.getElementById('brain-stats').innerHTML = '';
  document.getElementById('brain-milestones').innerHTML = '';
  document.getElementById('brain-decisions-tasks').innerHTML = '';
  document.getElementById('brain-search-results').innerHTML = '<div class="brain-item"><div class="brain-item-detail">No searchable memory available yet.</div></div>';
  document.getElementById('brain-search-count').textContent = '';
  renderBrainFilterState([]);
}

function renderBrain(payload, project) {
  const brain = payload.brain;
  const searchIndex = brain.searchIndex ?? [];
  const categoryByKey = new Map(searchIndex.map(item => [`${item.kind}:${item.id || item.title}`, item.category]));
  document.getElementById('brain-summary-loading').hidden = true;
  document.getElementById('brain-summary-content').hidden = false;
  document.getElementById('brain-summary').textContent = brain.summary;

  const stats = [
    { title: 'Project', meta: payload.projectName || project?.projectName || brain.workspaceId, detail: `${payload.workspaceCount || project?.workspaceCount || 1} source${(payload.workspaceCount || project?.workspaceCount || 1) !== 1 ? 's' : ''} · ${(payload.machineNames || project?.machineNames || []).join(', ') || 'Unknown device'}` },
    { title: 'Last compacted snapshot', meta: timeAgo(payload.updatedAt), detail: `${brain.stats.checkpointCount} checkpoints · ${brain.stats.decisionCount} decisions · ${brain.stats.taskCount} tasks` },
    { title: 'Open work', meta: `${brain.stats.openTaskCount} open tasks`, detail: `${brain.stats.completedTaskCount} completed tasks` },
  ];
  document.getElementById('brain-stats').innerHTML = stats.map(renderBrainItem).join('');

  const milestones = brain.milestones.slice(0, 8);
  document.getElementById('brain-milestones').innerHTML = milestones.length > 0
    ? milestones.map(item => renderBrainItem({
      title: item.title,
      meta: [formatCategoryLabel(categoryByKey.get(`milestone:${item.id || item.title}`)), item.trigger, item.branch, item.createdAt ? fmtDate(item.createdAt) : null].filter(Boolean).join(' · '),
      detail: item.detail || 'No detail recorded.',
    })).join('')
    : '<div class="brain-item"><div class="brain-item-detail">No milestones recorded yet.</div></div>';

  const combined = [
    ...brain.decisions.slice(0, 4).map(item => ({
      title: `Decision: ${item.title}`,
      meta: [formatCategoryLabel(categoryByKey.get(`decision:${item.id || item.title}`)), item.status, item.updatedAt ? fmtDate(item.updatedAt) : null].filter(Boolean).join(' · '),
      detail: item.rationale,
    })),
    ...brain.tasks.slice(0, 4).map(item => ({
      title: `Task: ${item.title}`,
      meta: [formatCategoryLabel(categoryByKey.get(`task:${item.id || item.title}`)), item.status, item.priority, item.updatedAt ? fmtDate(item.updatedAt) : null].filter(Boolean).join(' · '),
      detail: item.description || 'No description recorded.',
    })),
  ];
  document.getElementById('brain-decisions-tasks').innerHTML = combined.length > 0
    ? combined.map(renderBrainItem).join('')
    : '<div class="brain-item"><div class="brain-item-detail">No decisions or tasks recorded yet.</div></div>';
  renderBrainFilterState(searchIndex);
}

function renderBrainItem(item) {
  return `
    <div class="brain-item">
      ${item.badges?.length ? `<div class="brain-item-badges">${item.badges.map(renderBrainBadge).join('')}</div>` : ''}
      <div class="brain-item-title">${esc(item.title)}</div>
      ${item.meta ? `<div class="brain-item-meta">${esc(item.meta)}</div>` : ''}
      ${item.detail ? `<div class="brain-item-detail">${esc(item.detail)}</div>` : ''}
    </div>`;
}

function renderBrainBadge(badge) {
  const tone = badge.tone ? ` category-${badge.tone}` : '';
  return `<span class="brain-item-badge${tone}">${esc(badge.label)}</span>`;
}

function formatCategoryLabel(category) {
  if (!category) return '';
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function buildBrainSearchText(item) {
  return [item.title, item.detail, item.category, item.kind, item.status, item.priority, item.branch, item.trigger]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function renderBrainSearchResults() {
  const list = document.getElementById('brain-search-results');
  const count = document.getElementById('brain-search-count');
  const query = document.getElementById('brain-search-input')?.value?.trim().toLowerCase() ?? '';
  const items = currentBrainPayload?.brain?.searchIndex ?? [];

  const filtered = items.filter(item => {
    if (currentBrainFilter !== 'all' && item.category !== currentBrainFilter) return false;
    if (!query) return true;
    return buildBrainSearchText(item).includes(query);
  });

  const scopeLabel = currentBrainFilter === 'all' ? 'all memory' : `${formatCategoryLabel(currentBrainFilter)} memory`;
  count.textContent = filtered.length > 0
    ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'} in ${scopeLabel}`
    : `No matches in ${scopeLabel}`;

  list.innerHTML = filtered.length > 0
    ? filtered.slice(0, 20).map(item => renderBrainItem({
      title: item.title,
      meta: [item.kind, item.status, item.priority, item.sortAt ? fmtDate(item.sortAt) : null].filter(Boolean).join(' · '),
      detail: item.detail || 'No detail recorded.',
      badges: [
        { label: formatCategoryLabel(item.category), tone: item.category },
        { label: item.kind },
      ],
    })).join('')
    : '<div class="brain-item"><div class="brain-item-detail">No memory matched this search.</div></div>';
}

function setBrainFilter(category) {
  if (!BRAIN_FILTER_ORDER.includes(category)) category = 'all';
  currentBrainFilter = category;
  document.querySelectorAll('[data-brain-filter]').forEach(button => {
    button.classList.toggle('active', button.dataset.brainFilter === category);
  });
  renderBrainSearchResults();
}

function renderBrainFilterState(items) {
  const counts = new Map(BRAIN_FILTER_ORDER.filter((category) => category !== 'all').map((category) => [category, 0]));
  for (const item of items) {
    if (counts.has(item.category)) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
  }

  if (currentBrainFilter !== 'all' && (counts.get(currentBrainFilter) ?? 0) === 0) {
    currentBrainFilter = 'all';
  }

  document.querySelectorAll('[data-brain-filter]').forEach((button) => {
    const category = button.dataset.brainFilter;
    const baseLabel = button.dataset.brainFilterLabel ?? button.textContent.replace(/\s*\(\d+\)$/, '');
    button.dataset.brainFilterLabel = baseLabel;
    const total = category === 'all' ? items.length : (counts.get(category) ?? 0);
    button.textContent = `${baseLabel} (${total})`;
    button.disabled = category !== 'all' && total === 0;
    button.classList.toggle('active', category === currentBrainFilter);
  });
}

function renderAnalyticsEmpty(message) {
  document.getElementById('agent-availability-cards').innerHTML = `<div class="analytics-stat-card" style="grid-column:1 / -1"><div class="analytics-stat-sub">${esc(message)}</div></div>`;
  document.getElementById('agent-availability-note').innerHTML = '';
  document.getElementById('agent-usage-summary').innerHTML = `<div class="analytics-stat-card" style="grid-column:1 / -1"><div class="analytics-stat-sub">No synced coding-agent usage recorded yet.</div></div>`;
  document.getElementById('agent-usage-by-category').innerHTML = `<div class="analytics-stat-card" style="grid-column:1 / -1"><div class="analytics-stat-sub">No categorized coding-agent usage recorded yet.</div></div>`;
  document.getElementById('agent-usage-recent').innerHTML = '<div class="brain-item"><div class="brain-item-detail">No recent coding-agent sessions recorded yet.</div></div>';
  document.getElementById('agent-usage-operations').innerHTML = '<div class="brain-item"><div class="brain-item-detail">No model usage recorded yet.</div></div>';
  document.getElementById('analytics-category-cards').innerHTML = `<div class="analytics-stat-card" style="grid-column:1 / -1"><div class="analytics-stat-sub">${esc(message)}</div></div>`;
  document.getElementById('analytics-recent-items').innerHTML = '<div class="brain-item"><div class="brain-item-detail">No categorized memory available yet.</div></div>';
  document.getElementById('analytics-source-breakdown').innerHTML = '<div class="brain-item"><div class="brain-item-detail">No source mix available yet.</div></div>';
}

function renderAgentUsage(agentTelemetry) {
  const summary = agentTelemetry?.summary ?? {};
  const byAgent = agentTelemetry?.byAgent ?? [];
  const byModel = agentTelemetry?.byModel ?? [];
  const byCategory = agentTelemetry?.byCategory ?? [];
  const recent = agentTelemetry?.recent ?? [];

  const availabilityCards = [
    {
      label: 'Detected Agents',
      value: String(byAgent.length),
      sub: byAgent.length > 0 ? `${byAgent[0].agent}${byAgent.length > 1 ? ` +${byAgent.length - 1} more` : ''}` : 'No synced sessions yet',
    },
    {
      label: 'Imported Sessions',
      value: fmtInt(summary.sessionCount ?? 0),
      sub: `${fmtInt(summary.messageCount ?? 0)} messages synced`,
    },
    {
      label: 'Model Identified',
      value: fmtInt(summary.knownModelSessions ?? 0),
      sub: `${fmtInt(summary.unknownModelSessions ?? 0)} sessions missing model metadata`,
    },
    {
      label: 'Estimated Tokens',
      value: fmtInt(summary.estimatedTokens ?? 0),
      sub: `${fmtInt(summary.taskLabeledSessions ?? 0)} sessions labeled by task`,
    },
  ];
  document.getElementById('agent-availability-cards').innerHTML = availabilityCards.map((item) => `
    <div class="analytics-stat-card">
      <div class="analytics-stat-label">${esc(item.label)}</div>
      <div class="analytics-stat-value">${esc(item.value)}</div>
      <div class="analytics-stat-sub">${esc(item.sub)}</div>
    </div>`).join('');

  document.getElementById('agent-availability-note').innerHTML = [
    `${fmtInt(summary.knownProviderSessions ?? 0)} sessions with provider info`,
    `${fmtInt(summary.taskLabeledSessions ?? 0)} sessions with task labels`,
    byAgent.length > 0 ? `Top agent: ${esc(byAgent[0].agent)}` : 'Run a fresh sync after local transcript import to populate this view',
  ].map((text) => `<span>${text}</span>`).join('');

  const usageCards = [
    ['Messages', fmtInt(summary.messageCount ?? 0), 'Imported coding-agent messages'],
    ['Estimated Tokens', fmtInt(summary.estimatedTokens ?? 0), 'Approximate token volume from imported chats'],
    ['Known Models', fmtInt(summary.knownModelSessions ?? 0), 'Sessions with explicit model metadata'],
    ['Labeled Tasks', fmtInt(summary.taskLabeledSessions ?? 0), 'Sessions grouped to a task prompt'],
  ];
  document.getElementById('agent-usage-summary').innerHTML = usageCards.map(([label, value, sub]) => `
    <div class="analytics-stat-card">
      <div class="analytics-stat-label">${esc(label)}</div>
      <div class="analytics-stat-value">${esc(value)}</div>
      <div class="analytics-stat-sub">${esc(sub)}</div>
    </div>`).join('');

  document.getElementById('agent-usage-by-category').innerHTML = byCategory.map((entry) => `
    <div class="analytics-stat-card">
      <div class="analytics-stat-label">${esc(formatCategoryLabel(entry.category))}</div>
      <div class="analytics-stat-value">${esc(fmtInt(entry.estimatedTokens))}</div>
      <div class="analytics-stat-sub">${esc(`${entry.sessionCount} session${entry.sessionCount === 1 ? '' : 's'} · ${fmtInt(entry.messageCount)} messages`)}</div>
    </div>`).join('');

  document.getElementById('agent-usage-recent').innerHTML = recent.length > 0
    ? recent.map((entry) => renderBrainItem({
      title: entry.taskLabel || `${entry.agent} session`,
      meta: [entry.agent, entry.model || 'Model unavailable', entry.lastMessageAt ? fmtDate(entry.lastMessageAt) : null].filter(Boolean).join(' · '),
      detail: `${fmtInt(entry.estimatedTokens)} estimated tokens · ${fmtInt(entry.messageCount)} messages`,
      badges: [
        { label: formatCategoryLabel(entry.category), tone: entry.category },
        { label: entry.provider || 'Provider unknown' },
      ],
    })).join('')
    : '<div class="brain-item"><div class="brain-item-detail">No recent coding-agent sessions recorded yet.</div></div>';

  document.getElementById('agent-usage-operations').innerHTML = byModel.length > 0
    ? byModel.map((entry) => renderBrainItem({
      title: entry.model || 'Model unavailable',
      meta: [entry.provider || 'Provider unknown', `${entry.sessionCount} session${entry.sessionCount === 1 ? '' : 's'}`].join(' · '),
      detail: `${fmtInt(entry.estimatedTokens)} estimated tokens · ${fmtInt(entry.messageCount)} messages`,
    })).join('')
    : '<div class="brain-item"><div class="brain-item-detail">No model usage recorded yet.</div></div>';
}

function renderAnalytics(payload, project) {
  const analytics = payload?.brain?.analytics;
  const searchIndex = payload?.brain?.searchIndex ?? [];
  if (!analytics) {
    renderAnalyticsEmpty('No analytics available for this project yet.');
    return;
  }

  const total = analytics.totalItems || 0;
  const categories = ['decision', 'bugfix', 'feature', 'discovery'];
  document.getElementById('analytics-category-cards').innerHTML = categories.map((category) => {
    const value = analytics.categoryCounts?.[category] ?? 0;
    const share = total > 0 ? Math.round((value / total) * 100) : 0;
    return `
      <div class="analytics-stat-card">
        <div class="analytics-stat-label">${esc(formatCategoryLabel(category))}</div>
        <div class="analytics-stat-value">${esc(String(value))}</div>
        <div class="analytics-stat-sub">${esc(`${share}% of searchable memory`)} </div>
      </div>`;
  }).join('');

  document.getElementById('analytics-recent-items').innerHTML = (analytics.recentItems ?? []).length > 0
    ? analytics.recentItems.map(item => renderBrainItem({
      title: item.title,
      meta: [project?.projectName || payload.projectName || payload.brain.workspaceId, item.kind, item.sortAt ? fmtDate(item.sortAt) : null].filter(Boolean).join(' · '),
      detail: item.detail || 'No detail recorded.',
      badges: [
        { label: formatCategoryLabel(item.category), tone: item.category },
        { label: item.kind },
      ],
    })).join('')
    : '<div class="brain-item"><div class="brain-item-detail">No categorized memory available yet.</div></div>';

  const sourceKinds = [
    ['milestone', 'Milestones'],
    ['decision', 'Decisions'],
    ['task', 'Tasks'],
  ];
  document.getElementById('analytics-source-breakdown').innerHTML = sourceKinds.map(([kind, label]) => {
    const count = analytics.kindCounts?.[kind] ?? 0;
    const topCategories = searchIndex
      .filter(item => item.kind === kind)
      .reduce((acc, item) => {
        acc[item.category] = (acc[item.category] ?? 0) + 1;
        return acc;
      }, {});
    const mix = Object.entries(topCategories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([category, value]) => `${formatCategoryLabel(category)} ${value}`)
      .join(' · ');
    return renderBrainItem({
      title: label,
      meta: `${count} item${count === 1 ? '' : 's'}`,
      detail: mix || 'No categorized items yet.',
    });
  }).join('');
}

async function loadAnalytics() {
  try {
    const projects = await ensureBrainProjects();
    if (projects.length === 0) {
      renderAnalyticsEmpty('Sync a project first to unlock analytics.');
      return;
    }

    const projectId = document.getElementById('analytics-workspace').value || projects[0].projectId;
    const payload = await fetchBrainProject(projectId);
    if (!payload) {
      renderAnalyticsEmpty('This project has no compact brain yet. Run a fresh sync from the CLI.');
      return;
    }

    setProjectSelectValue('brain-workspace', projectId);
    renderAgentUsage(payload.brain?.agentTelemetry ?? null);
    renderAnalytics(payload, projects.find(project => project.projectId === projectId) ?? null);
  } catch (err) {
    renderAnalyticsEmpty(err.message ?? 'Failed to load analytics.');
    showNotice(err.message ?? 'Failed to load analytics.', 'error');
  }
}

async function askBrain() {
  const projectId = document.getElementById('brain-workspace').value;
  const question = document.getElementById('brain-ask-input').value.trim();
  if (!projectId) {
    showNotice('Select a project first.', 'error');
    return;
  }
  if (!question) {
    showNotice('Enter a question for the project brain.', 'error');
    return;
  }

  const btn = document.getElementById('brain-ask-btn');
  btn.disabled = true;
  btn.textContent = 'Asking…';

  try {
    const res = await authFetch(`/v1/brain/projects/${encodeURIComponent(projectId)}/ask?q=${encodeURIComponent(question)}`);
    const body = await res.json();
    if (res.status === 402) throw new Error(proRequiredMessage());
    if (!res.ok) throw new Error(body.error ?? 'Failed to query project brain');
    document.getElementById('brain-answer-empty').hidden = true;
    document.getElementById('brain-answer-content').hidden = false;
    document.getElementById('brain-answer').textContent = body.answer;
    document.getElementById('brain-evidence').innerHTML = (body.evidence ?? []).map(item => `
      <span class="brain-evidence-chip">${esc(item.category ?? item.kind)} · ${esc(item.kind)}: ${esc(item.title)}</span>
    `).join('');
  } catch (err) {
    showNotice(err.message ?? 'Failed to query project brain.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ask';
  }
}

async function generateBrainReport(type) {
  const projectId = document.getElementById('brain-workspace').value;
  if (!projectId) {
    showNotice('Select a project first.', 'error');
    return;
  }

  const buttons = Array.from(document.querySelectorAll('[data-brain-report]'));
  const activeButton = buttons.find((button) => button.dataset.brainReport === type);
  const reportEmpty = document.getElementById('brain-report-empty');
  const reportOutput = document.getElementById('brain-report');
  buttons.forEach(btn => { btn.disabled = true; });
  if (reportEmpty && activeButton) {
    reportEmpty.hidden = false;
    reportEmpty.textContent = `Researching the project brain and generating ${activeButton.textContent.toLowerCase()}…`;
  }
  if (reportOutput) {
    reportOutput.hidden = true;
    reportOutput.textContent = '';
  }

  try {
    const res = await authFetch(`/v1/brain/projects/${encodeURIComponent(projectId)}/report?type=${encodeURIComponent(type)}`);
    const body = await res.json();
    if (res.status === 402) throw new Error(proRequiredMessage());
    if (!res.ok) throw new Error(body.error ?? 'Failed to generate report');
    document.getElementById('brain-report-empty').hidden = true;
    document.getElementById('brain-report').hidden = false;
    document.getElementById('brain-report').textContent = body.markdown;
  } catch (err) {
    showNotice(err.message ?? 'Failed to generate report.', 'error');
  } finally {
    buttons.forEach(btn => { btn.disabled = false; });
  }
}

function renderWorkspaces(workspaces) {
  const list = document.getElementById('ws-list');
  list.innerHTML = '';

  const grouped = new Map();
  for (const ws of workspaces) {
    const projectName = ws.name || 'Unnamed project';
    if (!grouped.has(projectName)) grouped.set(projectName, []);
    grouped.get(projectName).push(ws);
  }

  for (const [projectName, projectWorkspaces] of grouped.entries()) {
    const group = document.createElement('div');
    group.className = 'ws-project';
    const totalBlobs = projectWorkspaces.reduce((sum, ws) => sum + ws.blobCount, 0);
    const latestSync = projectWorkspaces
      .map(ws => ws.lastSyncedAt)
      .filter(Boolean)
      .sort()
      .at(-1);
    group.innerHTML = `
      <div class="ws-project-name">${esc(projectName)}</div>
      <div class="ws-project-meta">${projectWorkspaces.length} device${projectWorkspaces.length !== 1 ? 's' : ''} &nbsp;·&nbsp; ${totalBlobs} sync snapshot${totalBlobs !== 1 ? 's' : ''}${latestSync ? ` &nbsp;·&nbsp; latest ${timeAgo(latestSync)}` : ''}</div>
    `;

    for (const ws of projectWorkspaces) {
    const div = document.createElement('div');
    div.className = 'ws-row';
    const lastSync = ws.lastSyncedAt ? timeAgo(ws.lastSyncedAt) : 'Never';
    const machineName = ws.machineName || 'Unknown device';
    div.innerHTML = `
      <div class="ws-info">
        <div class="ws-title">${esc(machineName)}</div>
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
      group.appendChild(div);
    }

    list.appendChild(group);
  }
}

document.getElementById('ws-list')?.addEventListener('click', async (e) => {
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

document.getElementById('sessions-list')?.addEventListener('click', async (e) => {
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

function fmtInt(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function fmtCredits(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric)
    ? new Intl.NumberFormat().format(numeric)
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(numeric);
}

// ── Session History ───────────────────────────────────────────────────────────
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
    if (res.status === 402) throw new Error(proRequiredMessage());
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

  workspaces.forEach((ws, index) => {
    const cpCount = ws.checkpoints ? ws.checkpoints.length : 0;
    const lastCp  = ws.checkpoints && ws.checkpoints[0];
    const wsName  = ws.name || ws.id.slice(0, 12) + '…';

    const card = document.createElement('div');
    card.className = index === 0 ? 'hist-ws open' : 'hist-ws';
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
                if (m.type === 'chat') parts.push(`<span class="hist-meta-tag hist-meta-chat">${esc(m.role || 'chat')}</span>`);
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
        <span class="hist-ws-badge">${cpCount} snapshot${cpCount !== 1 ? 's' : ''}</span>
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
  });
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
    const cpTexts = Array.from(card.querySelectorAll('.hist-cp')).map(c => c.textContent.toLowerCase()).join(' ');
    const matches = !q || wsName.includes(q) || wsId.includes(q) || machine.includes(q) || cpTexts.includes(q);
    card.classList.toggle('hidden', !matches);
    if (matches) visible++;
  });
  updateHistCount(visible);
});

document.getElementById('brain-workspace')?.addEventListener('change', () => {
  loadBrain();
});

document.getElementById('analytics-workspace')?.addEventListener('change', () => {
  loadAnalytics();
});

document.getElementById('brain-ask-btn')?.addEventListener('click', () => {
  askBrain();
});

document.getElementById('brain-search-input')?.addEventListener('input', () => {
  renderBrainSearchResults();
});

document.getElementById('brain-filter-row')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-brain-filter]');
  if (!button) return;
  setBrainFilter(button.dataset.brainFilter);
});

document.getElementById('brain-ask-input')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    askBrain();
  }
});

document.querySelectorAll('[data-brain-report]').forEach(btn => {
  btn.addEventListener('click', () => {
    generateBrainReport(btn.dataset.brainReport);
  });
});
