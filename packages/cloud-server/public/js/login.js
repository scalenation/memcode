const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : window.location.origin;

const errorEl    = document.getElementById('auth-error');
const form       = document.getElementById('login-form');
const emailInput = document.getElementById('login-email');
const passInput  = document.getElementById('login-password');
const submitBtn  = document.getElementById('login-submit');

// ── Show error from URL param (e.g., after failed OAuth redirect) ─────────────
const params = new URLSearchParams(window.location.search);
const oauthError = params.get('error');
if (oauthError) {
  const messages = {
    oauth_denied:   'Sign-in was cancelled.',
    invalid_state:  'Security check failed. Please try again.',
    token_exchange: 'Failed to complete sign-in. Please try again.',
    userinfo:       'Could not retrieve your profile. Please try again.',
    no_email:       'Your GitHub account has no public email. Please add one and try again.',
  };
  showError(messages[oauthError] ?? 'Sign-in failed. Please try again.');
  history.replaceState(null, '', '/login.html');
}

// ── If already logged in, skip to dashboard ───────────────────────────────────
const stored = localStorage.getItem('mc_token');
if (stored) {
  fetch(`${API_BASE}/v1/user/profile`, {
    headers: { Authorization: `Bearer ${stored}` },
  }).then(r => {
    if (r.ok) window.location.replace('/dashboard');
  });
}

// ── Email / password sign-in ──────────────────────────────────────────────────
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = emailInput.value.trim();
  const password = passInput.value;
  if (!email || !password) return;

  submitBtn.disabled   = true;
  submitBtn.textContent = 'Signing in…';
  hideError();

  try {
    const res = await fetch(`${API_BASE}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);

    localStorage.setItem('mc_token', body.token);
    window.location.replace('/dashboard');
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Sign-in failed.');
    submitBtn.disabled   = false;
    submitBtn.textContent = 'Sign in →';
  }
});

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add('visible');
}
function hideError() {
  errorEl.classList.remove('visible');
}
