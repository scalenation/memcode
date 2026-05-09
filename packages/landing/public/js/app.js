/* global API endpoint — update to your deployed domain */
const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : 'https://api.memcode.pro';

// ─── Checkout flow ───────────────────────────────────────────────────────────

let currentPlan = 'monthly'; // set when a checkout button is clicked

const modal      = document.getElementById('checkout-modal');
const modalClose = document.getElementById('modal-close-btn');
const backdrop   = modal?.querySelector('.modal-backdrop');
const form       = document.getElementById('checkout-form');
const emailInput = document.getElementById('checkout-email');
const submitBtn  = document.getElementById('checkout-submit');
const errorEl    = document.getElementById('checkout-error');

function openModal(plan) {
  if (!modal) return;
  currentPlan = plan;
  const modalPriceText = document.getElementById('modal-price-text');
  if (modalPriceText) {
    modalPriceText.textContent = plan === 'yearly' ? '€40/year' : '$3.99/month';
  }
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  emailInput?.focus();
}

function closeModal() {
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = '';
}

document.getElementById('checkout-btn-monthly')?.addEventListener('click', () => openModal('monthly'));
document.getElementById('checkout-btn-yearly')?.addEventListener('click',  () => openModal('yearly'));
modalClose?.addEventListener('click', closeModal);
backdrop?.addEventListener('click', closeModal);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = /** @type {HTMLInputElement} */ (emailInput)?.value?.trim();
  if (!email) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Redirecting to Stripe…';
  if (errorEl) errorEl.hidden = true;

  try {
    const res = await fetch(`${API_BASE}/v1/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, plan: currentPlan }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Server error ${res.status}`);
    }

    const { url } = await res.json();
    window.location.href = url;
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      errorEl.hidden = false;
    }
    submitBtn.disabled = false;
    submitBtn.textContent = 'Continue to checkout →';
  }
});

// ─── Success page detection ───────────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);
if (params.has('session_id')) {
  const overlay = document.getElementById('success-overlay');
  if (overlay) {
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    // Clean URL without reloading
    history.replaceState(null, '', '/');
  }
}

// ─── Smooth anchor scrolling with nav offset ─────────────────────────────────

document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener('click', function (e) {
    const href = this.getAttribute('href');
    const target = document.querySelector(href);
    if (!target) return;
    e.preventDefault();
    const navHeight = document.querySelector('.nav-wrap')?.offsetHeight ?? 70;
    const top = target.getBoundingClientRect().top + window.scrollY - navHeight - 16;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});

// ─── Nav active state on scroll ──────────────────────────────────────────────

const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-links a[href^="#"]');

function onScroll() {
  const scrollY = window.scrollY + 120;
  sections.forEach((section) => {
    const top = section.offsetTop;
    const bottom = top + section.offsetHeight;
    const id = section.getAttribute('id');
    const link = document.querySelector(`.nav-links a[href="#${id}"]`);
    if (link) {
      if (scrollY >= top && scrollY < bottom) {
        link.style.color = 'var(--text)';
      } else {
        link.style.color = '';
      }
    }
  });
}

window.addEventListener('scroll', onScroll, { passive: true });
