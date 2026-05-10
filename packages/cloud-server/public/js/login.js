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
    oauth_denied:        'Sign-in was cancelled.',
    invalid_state:       'Security check failed. Please try again.',
    token_exchange:      'Failed to complete sign-in. Please try again.',
    userinfo:            'Could not retrieve your profile. Please try again.',
    no_email:            'Your GitHub account has no public email. Please add one and try again.',
    server_error:        'A server error occurred. Please try again.',
    not_configured:      'Google/GitHub sign-in is not yet configured. Please use email/password.',
    invalid_magic_link:  'That sign-in link is invalid. Please request a new one.',
    expired_magic_link:  'That sign-in link has expired. Please request a new one.',
  };
  showError(messages[oauthError] ?? 'Sign-in failed. Please try again.');
  history.replaceState(null, '', '/login');
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

// ── Magic link form ───────────────────────────────────────────────────────────
document.getElementById('magic-link-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('magic-email').value.trim();
  const btn   = document.getElementById('magic-submit');
  const msg   = document.getElementById('magic-msg');
  if (!email) return;

  btn.disabled   = true;
  btn.textContent = 'Sending…';
  msg.style.display = 'none';

  try {
    const res = await fetch(`${API_BASE}/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? 'Failed to send email.');
    }
    msg.style.display     = 'block';
    msg.style.background  = 'rgba(52,211,153,0.1)';
    msg.style.border      = '1px solid rgba(52,211,153,0.3)';
    msg.style.color       = '#34d399';
    msg.textContent       = `If an account exists for ${email}, you'll receive a sign-in link shortly. Check your inbox (and spam folder).`;
    btn.textContent = 'Email sent';
  } catch (err) {
    msg.style.display    = 'block';
    msg.style.background = 'rgba(248,113,113,0.1)';
    msg.style.border     = '1px solid rgba(248,113,113,0.3)';
    msg.style.color      = '#f87171';
    msg.textContent      = err instanceof Error ? err.message : 'Failed to send email.';
    btn.disabled   = false;
    btn.textContent = 'Email me a sign-in link';
  }
});
