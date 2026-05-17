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
const BRAIN_ANSWER_EMPTY_TEXT = 'Ask a question about the project to see grounded context from the compact brain.';
const BRAIN_REPORT_EMPTY_TEXT = 'Generate a summary, slide deck, or business plan from the current project brain.';
const ACTIVITY_LIMIT = 12;
const GENERATION_TYPES = {
  status: {
    label: 'Summary',
    promptId: 'brain-prompt-status',
    exportKind: 'report',
    empty: 'Generate a summary to preview it here as a markdown document with export options.',
    previewHint: 'Markdown summary document with PDF and DOCX exports.',
  },
  slides: {
    label: 'Slides',
    promptId: 'brain-prompt-slides',
    exportKind: 'slides',
    empty: 'Generate slides to preview the deck here with PDF, PPTX, and Google Slides options.',
    previewHint: 'Presentation-style slide deck preview with direct export actions.',
  },
  'business-plan': {
    label: 'Business Plan',
    promptId: 'brain-prompt-business-plan',
    exportKind: 'report',
    empty: 'Generate a business plan to preview it here as a markdown document with export options.',
    previewHint: 'Long-form markdown business plan with PDF and DOCX exports.',
  },
};
let activityEvents = [];
let toastCounter = 0;
let generatedArtifacts = {
  status: null,
  slides: null,
  'business-plan': null,
};
let activeGenerationType = 'status';
let googleSlidesClientId = null;

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
  if (sectionId === 'runs') {
    populateOrchWorkspaceSelect('runs-workspace-filter', loadRuns);
  }
  if (sectionId === 'assumptions') {
    populateOrchWorkspaceSelect('assumptions-workspace-filter', loadAssumptions);
  }
  if (sectionId === 'repo-index') {
    populateOrchWorkspaceSelect('index-workspace-filter', loadRepoIndex);
  }
  if (sectionId === 'evals') {
    populateOrchWorkspaceSelect('evals-workspace-filter', loadEvals);
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
  googleSlidesClientId = profileData.integrations?.googleClientId ?? null;

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
  if (msg && type) {
    showNotice(msg, type === 'error' ? 'error' : 'success', {
      title: type === 'error' ? 'Action failed' : 'Action completed',
      duration: type === 'error' ? 7000 : 4500,
    });
  }
}
function showNotice(msg, type = 'info', options = {}) {
  const {
    title = defaultNoticeTitle(type),
    duration = type === 'error' ? 7000 : 5000,
    persist = type === 'loading',
    skipToast = false,
    skipFeed = false,
    skipBanner = false,
  } = options;
  const el = document.getElementById('global-notice');
  if (!skipBanner && el) {
    el.innerHTML = renderNoticeMarkup({ title, message: msg, type });
    el.className = `notice-bar ${type} visible`;
    clearTimeout(el._t);
    if (!persist && duration > 0) {
      el._t = setTimeout(() => { el.classList.remove('visible'); }, duration);
    }
  }
  if (!skipFeed) {
    recordActivity({ title, message: msg, type });
  }
  if (!skipToast) {
    return createToast({ title, message: msg, type, duration: persist ? 0 : duration });
  }
  return null;
}

function defaultNoticeTitle(type) {
  if (type === 'error') return 'Something failed';
  if (type === 'success') return 'Completed';
  if (type === 'loading') return 'Working';
  return 'Notice';
}

function renderNoticeMarkup({ title, message, type }) {
  return `
    ${renderStatusGlyph(type)}
    <div class="notice-copy">
      <div class="notice-title">${esc(title)}</div>
      <div class="notice-message">${esc(message)}</div>
    </div>`;
}

function renderStatusGlyph(type) {
  if (type === 'loading') return '<span class="spinner" aria-hidden="true"></span>';
  return '<span class="status-dot-solid" aria-hidden="true"></span>';
}

function createToast({ title, message, type, duration }) {
  const stack = document.getElementById('notification-stack');
  if (!stack) return null;

  const id = `toast-${++toastCounter}`;
  const toast = document.createElement('div');
  toast.className = `notification-toast ${type}`;
  toast.dataset.toastId = id;
  toast.innerHTML = `
    <div class="notification-toast-header">
      ${renderStatusGlyph(type)}
      <div class="notification-toast-copy">
        <div class="notification-toast-title">${esc(title)}</div>
        <div class="notification-toast-message">${esc(message)}</div>
      </div>
    </div>`;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));

  if (duration > 0) {
    toast._dismissTimer = setTimeout(() => dismissToast(id), duration);
  }
  return id;
}

function dismissToast(id) {
  const toast = document.querySelector(`[data-toast-id="${id}"]`);
  if (!toast) return;
  clearTimeout(toast._dismissTimer);
  toast.classList.remove('visible');
  setTimeout(() => toast.remove(), 180);
}

function recordActivity(event) {
  activityEvents.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: event.title,
    message: event.message,
    type: event.type,
    createdAt: Date.now(),
  });
  activityEvents = activityEvents.slice(0, ACTIVITY_LIMIT);
  renderActivityFeed();
}

function renderActivityFeed() {
  const panel = document.getElementById('activity-feed');
  const list = document.getElementById('activity-feed-list');
  if (!panel || !list) return;

  if (activityEvents.length === 0) {
    panel.hidden = true;
    panel.classList.remove('visible');
    list.innerHTML = '<div class="activity-feed-empty">No activity yet.</div>';
    return;
  }

  panel.hidden = false;
  panel.classList.add('visible');
  list.innerHTML = activityEvents.map((event) => `
    <div class="activity-feed-item ${esc(event.type)}">
      ${renderStatusGlyph(event.type)}
      <div class="activity-feed-body">
        <div class="activity-feed-item-title">${esc(event.title)}</div>
        <div class="activity-feed-item-message">${esc(event.message)}</div>
      </div>
      <div class="activity-feed-item-time">${esc(formatActivityTime(event.createdAt))}</div>
    </div>`).join('');
}

function formatActivityTime(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 15000) return 'just now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function setButtonBusy(button, busyLabel) {
  if (!button) return;
  if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;
  button.disabled = true;
  button.classList.add('is-busy');
  button.innerHTML = `<span class="btn-content"><span class="spinner" aria-hidden="true"></span><span>${esc(busyLabel)}</span></span>`;
}

function resetButtonBusy(button) {
  if (!button) return;
  if (button.dataset.idleHtml) button.innerHTML = button.dataset.idleHtml;
  button.disabled = false;
  button.classList.remove('is-busy');
}

function startTask({ button, busyLabel, title, message }) {
  if (button && busyLabel) setButtonBusy(button, busyLabel);
  const toastId = showNotice(message, 'loading', { title, duration: 0, persist: true });
  return { button, toastId };
}

function finishTask(task, { type, title, message }) {
  if (task?.toastId) dismissToast(task.toastId);
  if (task?.button) resetButtonBusy(task.button);
  showNotice(message, type, { title });
}

function renderInlineLoading(text) {
  return `<span class="inline-feedback"><span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span></span>`;
}

document.getElementById('activity-clear-btn')?.addEventListener('click', () => {
  activityEvents = [];
  renderActivityFeed();
});

document.querySelectorAll('[data-generation-type]').forEach((card) => {
  card.addEventListener('click', (event) => {
    if (event.target.closest('button, textarea')) return;
    setActiveGenerationType(card.dataset.generationType);
  });
});

document.querySelectorAll('.brain-generator-input').forEach((input) => {
  input.addEventListener('focus', () => {
    const card = input.closest('[data-generation-type]');
    if (card?.dataset.generationType) setActiveGenerationType(card.dataset.generationType);
  });
});

document.getElementById('brain-export-actions')?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-export-action]');
  if (!button) return;
  await handleGenerationExport(button.dataset.exportAction);
});

// ── Init ──────────────────────────────────────────────────────────────────────
renderGenerationPreview();
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
  document.getElementById('brain-answer-empty').textContent = BRAIN_ANSWER_EMPTY_TEXT;
  document.getElementById('brain-answer-content').hidden = true;
  document.getElementById('brain-answer').textContent = '';
  document.getElementById('brain-evidence').innerHTML = '';
  generatedArtifacts = { status: null, slides: null, 'business-plan': null };
  renderGenerationPreview();
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
  document.getElementById('agent-usage-operations').innerHTML = '<div class="brain-item"><div class="brain-item-detail">No model usage recorded yet.</div></div>';
  document.getElementById('analytics-category-cards').innerHTML = `<div class="analytics-stat-card" style="grid-column:1 / -1"><div class="analytics-stat-sub">${esc(message)}</div></div>`;
  document.getElementById('analytics-source-breakdown').innerHTML = '<div class="brain-item"><div class="brain-item-detail">No source mix available yet.</div></div>';
}

function renderAgentUsage(agentTelemetry) {
  const summary = agentTelemetry?.summary ?? {};
  const byAgent = agentTelemetry?.byAgent ?? [];
  const byModel = agentTelemetry?.byModel ?? [];
  const byCategory = agentTelemetry?.byCategory ?? [];
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
  const answerEmpty = document.getElementById('brain-answer-empty');
  const answerContent = document.getElementById('brain-answer-content');
  answerEmpty.hidden = false;
  answerEmpty.innerHTML = renderInlineLoading('Searching project memory and composing an answer…');
  answerContent.hidden = true;
  const task = startTask({
    button: btn,
    busyLabel: 'Asking…',
    title: 'Asking project brain',
    message: 'Searching compact memory and generating a grounded answer in the background.',
  });

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
    finishTask(task, {
      type: 'success',
      title: 'Brain answer ready',
      message: 'The project brain returned a grounded answer with supporting evidence.',
    });
  } catch (err) {
    answerEmpty.hidden = false;
    answerEmpty.textContent = BRAIN_ANSWER_EMPTY_TEXT;
    finishTask(task, {
      type: 'error',
      title: 'Brain question failed',
      message: err.message ?? 'Failed to query project brain.',
    });
  }
}

async function generateBrainReport(type) {
  const projectId = document.getElementById('brain-workspace').value;
  if (!projectId) {
    showNotice('Select a project first.', 'error');
    return;
  }

  const config = GENERATION_TYPES[type] ?? GENERATION_TYPES.status;
  const prompt = document.getElementById(config.promptId)?.value?.trim() ?? '';
  setActiveGenerationType(type);
  const buttons = Array.from(document.querySelectorAll('[data-brain-report]'));
  const activeButton = buttons.find((button) => button.dataset.brainReport === type);
  const reportEmpty = document.getElementById('brain-report-empty');
  const reportOutput = document.getElementById('brain-report');
  buttons.forEach(btn => {
    if (btn !== activeButton) btn.disabled = true;
  });
  const reportLabel = activeButton?.textContent?.trim() || 'report';
  const task = startTask({
    button: activeButton,
    busyLabel: 'Generating…',
    title: reportLabel,
    message: `${reportLabel} is being generated from the synced brain context in the background.`,
  });
  if (reportEmpty && activeButton) {
    reportEmpty.hidden = false;
    reportEmpty.innerHTML = renderInlineLoading(`Researching the project brain and generating ${reportLabel.toLowerCase()}…`);
  }
  if (reportOutput) {
    reportOutput.hidden = true;
    reportOutput.innerHTML = '';
  }

  try {
    const res = await authFetch(`/v1/brain/projects/${encodeURIComponent(projectId)}/report`, {
      method: 'POST',
      body: JSON.stringify({ type, prompt }),
    });
    const body = await res.json();
    if (res.status === 402) throw new Error(proRequiredMessage());
    if (!res.ok) throw new Error(body.error ?? 'Failed to generate report');
    generatedArtifacts[type] = {
      type,
      label: config.label,
      projectId: body.projectId ?? projectId,
      projectName: body.projectName ?? currentBrainProject?.projectName ?? currentBrainPayload?.projectName ?? 'Project',
      generatedAt: body.generatedAt ?? new Date().toISOString(),
      markdown: body.markdown,
      prompt,
      slides: type === 'slides' ? parseSlidesMarkdown(body.markdown) : null,
    };
    renderGenerationPreview();
    finishTask(task, {
      type: 'success',
      title: `${reportLabel} ready`,
      message: `${reportLabel} finished successfully and is ready to review.`,
    });
  } catch (err) {
    renderGenerationPreview();
    finishTask(task, {
      type: 'error',
      title: `${reportLabel} failed`,
      message: err.message ?? 'Failed to generate report.',
    });
  } finally {
    buttons.forEach((btn) => {
      if (btn !== activeButton) btn.disabled = false;
    });
  }
}

function setActiveGenerationType(type) {
  if (!GENERATION_TYPES[type]) type = 'status';
  activeGenerationType = type;
  document.querySelectorAll('[data-generation-type]').forEach((card) => {
    card.classList.toggle('active', card.dataset.generationType === type);
  });
  renderGenerationPreview();
}

function renderGenerationPreview() {
  const config = GENERATION_TYPES[activeGenerationType] ?? GENERATION_TYPES.status;
  const artifact = generatedArtifacts[activeGenerationType];
  const titleEl = document.getElementById('brain-preview-title');
  const metaEl = document.getElementById('brain-preview-meta');
  const emptyEl = document.getElementById('brain-report-empty');
  const outputEl = document.getElementById('brain-report');
  const exportEl = document.getElementById('brain-export-actions');

  if (titleEl) titleEl.textContent = `${config.label} Preview`;
  if (metaEl) {
    metaEl.textContent = artifact
      ? `${config.previewHint} Generated ${timeAgo(artifact.generatedAt)}${artifact.prompt ? ' from your custom prompt.' : '.'}`
      : config.previewHint;
  }

  if (!artifact) {
    if (emptyEl) {
      emptyEl.hidden = false;
      emptyEl.textContent = config.empty;
    }
    if (outputEl) {
      outputEl.hidden = true;
      outputEl.innerHTML = '';
    }
    if (exportEl) exportEl.innerHTML = '';
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  if (outputEl) {
    outputEl.hidden = false;
    outputEl.innerHTML = config.exportKind === 'slides'
      ? renderSlidesPreview(artifact)
      : renderMarkdownPreview(artifact.markdown);
  }
  if (exportEl) exportEl.innerHTML = renderGenerationExportActions(config);
}

function renderGenerationExportActions(config) {
  if (config.exportKind === 'slides') {
    return [
      '<button class="btn btn-secondary btn-sm" data-export-action="slides-google">Upload to Google Slides</button>',
      '<button class="btn btn-secondary btn-sm" data-export-action="slides-pdf">Download PDF</button>',
      '<button class="btn btn-secondary btn-sm" data-export-action="slides-pptx">Download PPTX</button>',
    ].join('');
  }

  return [
    '<button class="btn btn-secondary btn-sm" data-export-action="report-md">Download MD</button>',
    '<button class="btn btn-secondary btn-sm" data-export-action="report-docx">Download DOCX</button>',
    '<button class="btn btn-secondary btn-sm" data-export-action="report-pdf">Download PDF</button>',
  ].join('');
}

function renderMarkdownPreview(markdown) {
  const blocks = parseMarkdownBlocks(markdown);
  return `<article class="markdown-preview">${blocks.map(renderMarkdownBlock).join('')}</article>`;
}

function renderMarkdownBlock(block) {
  if (block.type === 'heading') {
    const level = Math.min(Math.max(block.level, 1), 3);
    return `<h${level}>${esc(block.text)}</h${level}>`;
  }
  if (block.type === 'list') {
    return `<ul>${block.items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
  }
  return `<p>${esc(block.text)}</p>`;
}

function parseMarkdownBlocks(markdown) {
  const blocks = [];
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  let paragraph = [];
  let listItems = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ type: 'list', items: [...listItems] });
      listItems = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2].trim() });
      continue;
    }

    const listMatch = line.match(/^[-*+]\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1].trim());
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function parseSlidesMarkdown(markdown) {
  const blocks = parseMarkdownBlocks(markdown);
  const slides = [];
  let current = null;

  const ensureSlide = () => {
    if (!current) current = { title: 'Overview', subtitle: '', bullets: [] };
    return current;
  };
  const pushCurrent = () => {
    if (!current) return;
    slides.push({
      title: current.title || 'Untitled slide',
      subtitle: current.subtitle || '',
      bullets: current.bullets.filter(Boolean).slice(0, 6),
    });
    current = null;
  };

  for (const block of blocks) {
    if (block.type === 'heading') {
      pushCurrent();
      current = { title: block.text, subtitle: '', bullets: [] };
      continue;
    }

    const slide = ensureSlide();
    if (block.type === 'paragraph') {
      if (!slide.subtitle) slide.subtitle = block.text;
      else slide.bullets.push(block.text);
      continue;
    }

    if (block.type === 'list') {
      slide.bullets.push(...block.items);
    }
  }

  pushCurrent();
  return slides.length > 0 ? slides : [{ title: 'Overview', subtitle: '', bullets: ['No slide content generated yet.'] }];
}

function renderSlidesPreview(artifact) {
  const slides = artifact.slides ?? parseSlidesMarkdown(artifact.markdown);
  return `<div class="slides-preview-deck">${slides.map((slide, index) => `
    <section class="slide-preview-card">
      <div>
        <div class="slide-preview-eyebrow">Slide ${index + 1}</div>
        <div class="slide-preview-title">${esc(slide.title)}</div>
        ${slide.subtitle ? `<div class="slide-preview-subtitle">${esc(slide.subtitle)}</div>` : ''}
        ${slide.bullets.length > 0 ? `<ul class="slide-preview-bullets">${slide.bullets.map((bullet) => `<li>${esc(bullet)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="slide-preview-footer">
        <span>${esc(artifact.projectName || 'Project deck')}</span>
        <span>${esc(GENERATION_TYPES.slides.label)}</span>
      </div>
    </section>`).join('')}</div>`;
}

async function handleGenerationExport(action) {
  const artifact = generatedArtifacts[activeGenerationType];
  if (!artifact) {
    showNotice('Generate content first before exporting it.', 'error');
    return;
  }

  const task = startTask({
    title: 'Preparing export',
    message: `Preparing ${GENERATION_TYPES[activeGenerationType].label.toLowerCase()} export in the background.`,
  });

  try {
    if (action === 'report-md') await downloadReportMarkdown(artifact);
    if (action === 'report-docx') await downloadReportDocx(artifact);
    if (action === 'report-pdf') await downloadReportPdf(artifact);
    if (action === 'slides-pptx') await downloadSlidesPptx(artifact);
    if (action === 'slides-pdf') await downloadSlidesPdf(artifact);
    if (action === 'slides-google') await uploadSlidesToGoogle(artifact);

    finishTask(task, {
      type: 'success',
      title: 'Export ready',
      message: action === 'slides-google'
        ? 'Slide deck uploaded to Google Slides successfully.'
        : 'Your export has been prepared and downloaded.',
    });
  } catch (error) {
    finishTask(task, {
      type: 'error',
      title: 'Export failed',
      message: error?.message ?? 'Failed to export generated content.',
    });
  }
}

async function downloadReportMarkdown(artifact) {
  const blob = new Blob([artifact.markdown], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, `${artifactFileBase(artifact)}.md`);
}

async function downloadReportDocx(artifact) {
  const docxLib = window.docx;
  if (!docxLib?.Document || !docxLib?.Packer) {
    throw new Error('DOCX export is not available because the document library did not load.');
  }

  const blocks = parseMarkdownBlocks(artifact.markdown);
  const children = [
    new docxLib.Paragraph({ text: artifact.label || 'Generated document', heading: docxLib.HeadingLevel.TITLE }),
  ];

  for (const block of blocks) {
    if (block.type === 'heading') {
      children.push(new docxLib.Paragraph({
        text: block.text,
        heading: block.level === 1 ? docxLib.HeadingLevel.HEADING_1 : block.level === 2 ? docxLib.HeadingLevel.HEADING_2 : docxLib.HeadingLevel.HEADING_3,
      }));
      continue;
    }
    if (block.type === 'list') {
      block.items.forEach((item) => {
        children.push(new docxLib.Paragraph({ text: item, bullet: { level: 0 } }));
      });
      continue;
    }
    children.push(new docxLib.Paragraph({ text: block.text }));
  }

  const doc = new docxLib.Document({ sections: [{ children }] });
  const blob = await docxLib.Packer.toBlob(doc);
  downloadBlob(blob, `${artifactFileBase(artifact)}.docx`);
}

async function downloadReportPdf(artifact) {
  const jsPDF = window.jspdf?.jsPDF;
  if (!jsPDF) throw new Error('PDF export is not available because the PDF library did not load.');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const maxWidth = pageWidth - 96;
  let y = 54;

  const ensureRoom = (needed) => {
    if (y + needed <= pageHeight - 48) return;
    pdf.addPage();
    y = 54;
  };

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.text(artifact.label || 'Generated document', 48, y);
  y += 28;

  for (const block of parseMarkdownBlocks(artifact.markdown)) {
    if (block.type === 'heading') {
      const fontSize = block.level === 1 ? 18 : block.level === 2 ? 15 : 13;
      ensureRoom(fontSize + 16);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(fontSize);
      pdf.text(block.text, 48, y);
      y += fontSize + 10;
      continue;
    }

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    const lines = block.type === 'list'
      ? block.items.flatMap((item) => pdf.splitTextToSize(`• ${item}`, maxWidth - 16))
      : pdf.splitTextToSize(block.text, maxWidth);
    ensureRoom(lines.length * 15 + 12);
    pdf.text(lines, 48, y);
    y += lines.length * 15 + 10;
  }

  pdf.save(`${artifactFileBase(artifact)}.pdf`);
}

async function downloadSlidesPptx(artifact) {
  const PptxGenJS = window.PptxGenJS;
  if (!PptxGenJS) throw new Error('PPTX export is not available because the slide library did not load.');
  const deck = artifact.slides ?? parseSlidesMarkdown(artifact.markdown);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'MemCode';
  pptx.subject = artifact.label || 'Slide deck';
  pptx.company = 'MemCode';

  deck.forEach((slideData, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: '0F172A' };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: '0F172A' }, line: { color: '0F172A' } });
    slide.addShape(pptx.ShapeType.roundRect, { x: 0.48, y: 0.46, w: 12.37, h: 6.48, rectRadius: 0.14, fill: { color: '111827', transparency: 4 }, line: { color: '25324A', transparency: 12 } });
    slide.addText(`Slide ${index + 1}`, { x: 0.76, y: 0.54, w: 1.4, h: 0.3, fontSize: 10, color: '93C5FD', bold: true, charSpace: 1.1 });
    slide.addText(slideData.title, { x: 0.76, y: 1.02, w: 11.3, h: 0.82, fontSize: 24, color: 'FFFFFF', bold: true, fit: 'shrink' });
    if (slideData.subtitle) {
      slide.addText(slideData.subtitle, { x: 0.76, y: 1.88, w: 10.7, h: 0.56, fontSize: 12, color: 'BFDBFE', fit: 'shrink' });
    }
    const bulletText = (slideData.bullets ?? []).map((bullet) => `• ${bullet}`).join('\n');
    if (bulletText) {
      slide.addText(bulletText, { x: 0.96, y: 2.66, w: 11.2, h: 2.98, fontSize: 18, color: 'E2E8F0', breakLine: false, valign: 'top', fit: 'shrink' });
    }
    slide.addText(artifact.projectName || 'MemCode', { x: 10.6, y: 6.6, w: 1.8, h: 0.2, fontSize: 10, color: '93C5FD', align: 'right' });
  });

  await pptx.writeFile({ fileName: `${artifactFileBase(artifact)}.pptx` });
}

async function downloadSlidesPdf(artifact) {
  const jsPDF = window.jspdf?.jsPDF;
  if (!jsPDF) throw new Error('PDF export is not available because the PDF library did not load.');
  const slides = artifact.slides ?? parseSlidesMarkdown(artifact.markdown);
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();

  slides.forEach((slide, index) => {
    if (index > 0) pdf.addPage();
    pdf.setFillColor(15, 23, 42);
    pdf.rect(0, 0, pageWidth, pageHeight, 'F');
    pdf.setFillColor(17, 24, 39);
    pdf.roundedRect(26, 24, pageWidth - 52, pageHeight - 48, 18, 18, 'F');
    pdf.setTextColor(147, 197, 253);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text(`Slide ${index + 1}`, 44, 44);
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(24);
    pdf.text(pdf.splitTextToSize(slide.title, pageWidth - 120), 44, 88);
    let y = 130;
    if (slide.subtitle) {
      pdf.setTextColor(191, 219, 254);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(12);
      const subtitleLines = pdf.splitTextToSize(slide.subtitle, pageWidth - 140);
      pdf.text(subtitleLines, 44, y);
      y += subtitleLines.length * 15 + 18;
    }
    pdf.setTextColor(226, 232, 240);
    pdf.setFontSize(16);
    (slide.bullets ?? []).forEach((bullet) => {
      const lines = pdf.splitTextToSize(`• ${bullet}`, pageWidth - 150);
      pdf.text(lines, 58, y);
      y += lines.length * 19 + 8;
    });
    pdf.setTextColor(147, 197, 253);
    pdf.setFontSize(10);
    pdf.text(artifact.projectName || 'MemCode', pageWidth - 44, pageHeight - 32, { align: 'right' });
  });

  pdf.save(`${artifactFileBase(artifact)}.pdf`);
}

async function uploadSlidesToGoogle(artifact) {
  if (!googleSlidesClientId) {
    throw new Error('Google Slides upload is not configured for this deployment.');
  }
  if (!window.google?.accounts?.oauth2) {
    throw new Error('Google identity services did not load. Refresh the page and try again.');
  }

  const accessToken = await requestGoogleSlidesAccessToken();
  const slides = artifact.slides ?? parseSlidesMarkdown(artifact.markdown);

  const createResponse = await fetch('https://slides.googleapis.com/v1/presentations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: artifactExportTitle(artifact) }),
  });
  const presentation = await createResponse.json();
  if (!createResponse.ok) {
    throw new Error(presentation.error?.message ?? 'Failed to create Google Slides presentation.');
  }

  const requests = [];
  const defaultSlideId = presentation.slides?.[0]?.objectId;
  if (defaultSlideId) {
    requests.push({ deleteObject: { objectId: defaultSlideId } });
  }

  slides.forEach((slide, index) => {
    const slideId = `slide_${index}`;
    const titleId = `slide_${index}_title`;
    const bodyId = `slide_${index}_body`;
    const bodyText = [slide.subtitle, ...(slide.bullets ?? []).map((bullet) => `• ${bullet}`)].filter(Boolean).join('\n');

    requests.push({
      createSlide: {
        objectId: slideId,
        insertionIndex: index,
        slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: titleId },
          { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: bodyId },
        ],
      },
    });
    requests.push({ insertText: { objectId: titleId, insertionIndex: 0, text: slide.title } });
    requests.push({ insertText: { objectId: bodyId, insertionIndex: 0, text: bodyText || ' ' } });
  });

  const batchRes = await fetch(`https://slides.googleapis.com/v1/presentations/${presentation.presentationId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });
  const batchBody = await batchRes.json();
  if (!batchRes.ok) {
    throw new Error(batchBody.error?.message ?? 'Failed to populate Google Slides presentation.');
  }

  window.open(`https://docs.google.com/presentation/d/${presentation.presentationId}/edit`, '_blank', 'noopener');
}

function requestGoogleSlidesAccessToken() {
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: googleSlidesClientId,
      scope: 'https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/drive.file',
      prompt: 'consent',
      callback: (response) => {
        if (response?.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        resolve(response.access_token);
      },
    });
    client.requestAccessToken();
  });
}

function artifactFileBase(artifact) {
  return sanitizeFileName(`${artifact.projectName || 'memcode'}-${artifact.type}`);
}

function artifactExportTitle(artifact) {
  return `${artifact.projectName || 'MemCode'} ${artifact.label || artifact.type}`;
}

function sanitizeFileName(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'memcode-export';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

// ── Orchestration helpers ─────────────────────────────────────────────────────

function orchStatusBadge(status) {
  const colors = { done: '#22c55e', failed: '#ef4444', cancelled: '#f59e0b', 'rolled-back': '#f59e0b', executing: '#3b82f6', 'awaiting-approval': '#a855f7', paused: '#f59e0b', pending: '#6b7280' };
  const color = colors[status] ?? '#6b7280';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.72rem;background:${color}22;color:${color};font-weight:600">${escapeHtml(status)}</span>`;
}

async function populateOrchWorkspaceSelect(selectId, callback) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  if (sel.dataset.loaded) { callback && callback(); return; }
  const res = await authFetch('/v1/user/workspaces');
  if (!res.ok) return;
  const { workspaces } = await res.json();
  sel.innerHTML = '<option value="">— select workspace —</option>' + (workspaces || []).map(w => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name || w.id.slice(0, 16))}</option>`).join('');
  sel.dataset.loaded = '1';
  sel.addEventListener('change', () => callback && callback());
  if (workspaces?.length === 1) { sel.value = workspaces[0].id; callback && callback(); }
}

// ── Runs ──────────────────────────────────────────────────────────────────────

async function loadRuns() {
  const workspaceId = document.getElementById('runs-workspace-filter')?.value;
  const el = document.getElementById('runs-list');
  if (!el || !workspaceId) return;
  el.innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem">Loading…</p>';
  const res = await authFetch(`/v1/runs?workspace_id=${encodeURIComponent(workspaceId)}&limit=30`);
  if (!res.ok) { el.innerHTML = '<p style="color:var(--danger)">Failed to load runs.</p>'; return; }
  const { runs } = await res.json();
  if (!runs?.length) { el.innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem">No runs yet. Start one with <code>memory run start "task"</code></p>'; return; }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.82rem">
    <thead><tr style="text-align:left;border-bottom:1px solid var(--border)"><th style="padding:6px 8px">Status</th><th style="padding:6px 8px">Title</th><th style="padding:6px 8px">Branch</th><th style="padding:6px 8px">Created</th></tr></thead>
    <tbody>
      ${runs.map(r => `<tr class="run-row" data-run-id="${escapeHtml(r.id)}" style="cursor:pointer;border-bottom:1px solid var(--border-subtle)" onmouseover="this.style.background='var(--hover)'" onmouseout="this.style.background=''">
        <td style="padding:6px 8px">${orchStatusBadge(r.status)}</td>
        <td style="padding:6px 8px;font-weight:500">${escapeHtml((r.title || '').slice(0, 60))}</td>
        <td style="padding:6px 8px;color:var(--text-dim)">${escapeHtml(r.git_branch || '')}</td>
        <td style="padding:6px 8px;color:var(--text-dim)">${new Date(r.created_at).toLocaleDateString()}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
  el.querySelectorAll('.run-row').forEach(row => {
    row.addEventListener('click', () => loadRunDetail(row.dataset.runId));
  });
}

async function loadRunDetail(runId) {
  const detail = document.getElementById('run-detail');
  const listEl = document.getElementById('runs-list');
  if (!detail) return;
  detail.hidden = false;
  if (listEl) listEl.closest('.card').style.display = 'none';

  const [runRes, stepsRes] = await Promise.all([
    authFetch(`/v1/runs/${runId}`),
    authFetch(`/v1/runs/${runId}/steps`),
  ]);
  if (!runRes.ok) { detail.innerHTML = '<p style="color:var(--danger)">Run not found.</p>'; return; }
  const { run } = await runRes.json();
  const { steps } = stepsRes.ok ? await stepsRes.json() : { steps: [] };

  document.getElementById('run-detail-title').textContent = run.title || run.id.slice(0, 16);
  document.getElementById('run-detail-status').innerHTML = orchStatusBadge(run.status);
  document.getElementById('run-detail-meta').innerHTML =
    `ID: ${escapeHtml(run.id.slice(0, 16))} &nbsp;·&nbsp; Created: ${new Date(run.created_at).toLocaleString()}${run.git_branch ? ' &nbsp;·&nbsp; Branch: ' + escapeHtml(run.git_branch) : ''}`;

  const planEl = document.getElementById('run-plan-options');
  if (planEl) {
    if (run.plan_json) {
      try {
        const plans = JSON.parse(run.plan_json);
        planEl.innerHTML = plans.map(p => `<div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px${run.selected_option === p.index ? ';border-color:#22c55e' : ''}">
          <strong>Option ${p.index}: ${escapeHtml(p.title)}</strong>
          ${run.selected_option === p.index ? ' <span style="color:#22c55e;font-size:0.75rem">✓ selected</span>' : ''}
          <div style="font-size:0.78rem;color:var(--text-dim);margin-top:4px">Risk: ${escapeHtml(p.riskLevel)} · Files: ~${p.estimatedFiles}</div>
        </div>`).join('');
      } catch { planEl.textContent = 'No plan data.'; }
    } else { planEl.innerHTML = '<p style="color:var(--text-dim);font-size:0.82rem">No plan yet.</p>'; }
  }

  const stepsEl = document.getElementById('run-steps-list');
  if (stepsEl) {
    if (steps?.length) {
      stepsEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.8rem">
        <thead><tr style="border-bottom:1px solid var(--border)"><th style="padding:4px 8px;text-align:left">Status</th><th style="padding:4px 8px;text-align:left">Phase</th><th style="padding:4px 8px;text-align:left">Label</th><th style="padding:4px 8px;text-align:left">Model</th></tr></thead>
        <tbody>${steps.map(s => `<tr style="border-bottom:1px solid var(--border-subtle)">
          <td style="padding:4px 8px">${orchStatusBadge(s.status)}</td>
          <td style="padding:4px 8px;color:var(--text-dim)">${escapeHtml(s.phase)}</td>
          <td style="padding:4px 8px">${escapeHtml(s.label)}</td>
          <td style="padding:4px 8px;color:var(--text-dim);font-size:0.75rem">${escapeHtml(s.model || '')}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    } else { stepsEl.innerHTML = '<p style="color:var(--text-dim);font-size:0.82rem">No steps recorded yet.</p>'; }
  }
}

document.getElementById('run-detail-back')?.addEventListener('click', () => {
  document.getElementById('run-detail').hidden = true;
  const card = document.getElementById('runs-list')?.closest('.card');
  if (card) card.style.display = '';
  loadRuns();
});

document.getElementById('runs-workspace-filter')?.addEventListener('change', loadRuns);

// ── Assumptions ───────────────────────────────────────────────────────────────

async function loadAssumptions() {
  const workspaceId = document.getElementById('assumptions-workspace-filter')?.value;
  const el = document.getElementById('assumptions-list');
  if (!el || !workspaceId) return;
  el.innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem">Loading…</p>';
  const res = await authFetch(`/v1/assumptions?workspace_id=${encodeURIComponent(workspaceId)}`);
  if (!res.ok) { el.innerHTML = '<p style="color:var(--danger)">Failed to load.</p>'; return; }
  const { assumptions } = await res.json();
  if (!assumptions?.length) { el.innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem">No assumptions yet. Use <code>memory assume add</code> to record codebase knowledge.</p>'; return; }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.82rem">
    <thead><tr style="border-bottom:1px solid var(--border)"><th style="padding:6px 8px;text-align:left">Key</th><th style="padding:6px 8px;text-align:left">Value</th><th style="padding:6px 8px;text-align:left">Source</th><th style="padding:6px 8px;text-align:left">Updated</th></tr></thead>
    <tbody>${assumptions.map(a => `<tr style="border-bottom:1px solid var(--border-subtle)${a.stale ? ';opacity:0.5' : ''}">
      <td style="padding:6px 8px;font-weight:500">${escapeHtml(a.key)}${a.stale ? ' <em style="font-size:0.72rem;color:var(--text-dim)">(stale)</em>' : ''}</td>
      <td style="padding:6px 8px">${escapeHtml((a.value || '').slice(0, 100))}</td>
      <td style="padding:6px 8px;color:var(--text-dim)">${escapeHtml(a.source)}</td>
      <td style="padding:6px 8px;color:var(--text-dim)">${new Date(a.updated_at).toLocaleDateString()}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

document.getElementById('assumptions-workspace-filter')?.addEventListener('change', loadAssumptions);

// ── Repo Index ────────────────────────────────────────────────────────────────

async function loadRepoIndex() {
  const workspaceId = document.getElementById('index-workspace-filter')?.value;
  const kind = document.getElementById('index-kind-filter')?.value;
  const el = document.getElementById('index-list');
  if (!el || !workspaceId) return;
  el.innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem">Loading…</p>';
  const qs = new URLSearchParams({ workspace_id: workspaceId });
  if (kind) qs.set('kind', kind);
  const res = await authFetch(`/v1/index?${qs}`);
  if (!res.ok) { el.innerHTML = '<p style="color:var(--danger)">Failed to load.</p>'; return; }
  const { entries } = await res.json();
  if (!entries?.length) { el.innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem">No index entries yet. Run <code>memory index scan</code> locally.</p>'; return; }
  const byKind = {};
  for (const e of entries) (byKind[e.kind] ??= []).push(e);
  el.innerHTML = Object.entries(byKind).map(([k, list]) =>
    `<div style="margin-bottom:14px"><strong style="font-size:0.8rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim)">${escapeHtml(k)} (${list.length})</strong>
    <div style="margin-top:6px;font-size:0.8rem">
      ${list.map(e => `<div style="padding:4px 0;display:flex;gap:12px;border-bottom:1px solid var(--border-subtle)"><span style="flex:0 0 280px;color:var(--text-dim);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.path)}</span><span>${escapeHtml(e.label)}</span></div>`).join('')}
    </div></div>`
  ).join('');
}

document.getElementById('index-workspace-filter')?.addEventListener('change', loadRepoIndex);
document.getElementById('index-kind-filter')?.addEventListener('change', loadRepoIndex);

// ── Evals ─────────────────────────────────────────────────────────────────────

async function loadEvals() {
  const workspaceId = document.getElementById('evals-workspace-filter')?.value;
  const el = document.getElementById('evals-task-list');
  if (!el || !workspaceId) return;
  el.innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem">Loading…</p>';
  const res = await authFetch(`/v1/evals/tasks?workspace_id=${encodeURIComponent(workspaceId)}`);
  if (!res.ok) { el.innerHTML = '<p style="color:var(--danger)">Failed to load.</p>'; return; }
  const { tasks } = await res.json();
  if (!tasks?.length) { el.innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem">No eval tasks yet. Add one with <code>memory eval add</code>.</p>'; return; }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.82rem">
    <thead><tr style="border-bottom:1px solid var(--border)"><th style="padding:6px 8px;text-align:left">Title</th><th style="padding:6px 8px;text-align:left">Description</th><th style="padding:6px 8px;text-align:left">Created</th><th style="padding:6px 8px"></th></tr></thead>
    <tbody>${tasks.map(t => `<tr style="border-bottom:1px solid var(--border-subtle)">
      <td style="padding:6px 8px;font-weight:500">${escapeHtml(t.title)}</td>
      <td style="padding:6px 8px;color:var(--text-dim)">${escapeHtml((t.description || '').slice(0, 80))}</td>
      <td style="padding:6px 8px;color:var(--text-dim)">${new Date(t.created_at).toLocaleDateString()}</td>
      <td style="padding:6px 8px"><button class="btn btn-secondary" style="font-size:0.72rem;padding:2px 8px" onclick="loadEvalResults('${escapeHtml(t.id)}','${escapeHtml(t.title.replace(/'/g,''))}')">Results</button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

async function loadEvalResults(taskId, title) {
  const section = document.getElementById('evals-results-section');
  const label = document.getElementById('evals-task-label');
  const el = document.getElementById('evals-results-list');
  if (!section || !el) return;
  section.hidden = false;
  if (label) label.textContent = title;
  el.innerHTML = '<p style="color:var(--text-dim);font-size:0.82rem">Loading…</p>';
  const res = await authFetch(`/v1/evals/results?eval_task_id=${encodeURIComponent(taskId)}`);
  if (!res.ok) { el.innerHTML = '<p style="color:var(--danger)">Failed to load results.</p>'; return; }
  const { results } = await res.json();
  if (!results?.length) { el.innerHTML = '<p style="color:var(--text-dim);font-size:0.82rem">No results recorded yet.</p>'; return; }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.8rem">
    <thead><tr style="border-bottom:1px solid var(--border)"><th style="padding:4px 8px;text-align:left">Agent</th><th style="padding:4px 8px;text-align:left">Model</th><th style="padding:4px 8px;text-align:left">Passed</th><th style="padding:4px 8px;text-align:left">Score</th><th style="padding:4px 8px;text-align:left">Notes</th></tr></thead>
    <tbody>${results.map(r => `<tr style="border-bottom:1px solid var(--border-subtle)">
      <td style="padding:4px 8px">${escapeHtml(r.agent)}</td>
      <td style="padding:4px 8px;color:var(--text-dim)">${escapeHtml(r.model || '')}</td>
      <td style="padding:4px 8px">${r.passed === 1 ? '<span style="color:#22c55e">✓</span>' : r.passed === 0 ? '<span style="color:#ef4444">✗</span>' : '—'}</td>
      <td style="padding:4px 8px">${r.score != null ? r.score.toFixed(2) : '—'}</td>
      <td style="padding:4px 8px;color:var(--text-dim)">${escapeHtml((r.notes || '').slice(0, 80))}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

document.getElementById('evals-workspace-filter')?.addEventListener('change', loadEvals);
