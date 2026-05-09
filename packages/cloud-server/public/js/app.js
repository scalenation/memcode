/* global API endpoint */
const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : window.location.origin;  // landing + API are on the same Vercel deployment

// ─── Checkout flow (2-step: email → embedded card via Stripe Elements) ────────

let currentPlan = 'monthly';
let stripeCustomerId = '';

const modal       = document.getElementById('checkout-modal');
const modalClose  = document.getElementById('modal-close-btn');
const backdrop    = modal?.querySelector('.modal-backdrop');
const step1       = document.getElementById('checkout-step-1');
const step2       = document.getElementById('checkout-step-2');
const form        = document.getElementById('checkout-form');
const emailInput  = document.getElementById('checkout-email');
const submitBtn   = document.getElementById('checkout-submit');
const errorEl     = document.getElementById('checkout-error');
const cardErrors  = document.getElementById('card-errors');
const cardSubmit  = document.getElementById('card-submit-btn');
const backBtn     = document.getElementById('back-to-email-btn');
const emailDisplay = document.getElementById('trial-email-display');

// Stripe Elements (initialised lazily when step 2 is first shown)
let stripe = null;
let cardElement = null;

function initStripe() {
  if (stripe) return;
  // eslint-disable-next-line no-undef
  stripe = Stripe(window.STRIPE_PK);
  const elements = stripe.elements({
    appearance: {
      theme: 'night',
      variables: {
        colorPrimary: '#6c63ff',
        colorBackground: '#1e1e2e',
        colorText: '#e2e4ea',
        colorDanger: '#f87171',
        fontFamily: 'Inter, system-ui, sans-serif',
        borderRadius: '8px',
      },
    },
  });
  cardElement = elements.create('card', {
    style: {
      base: {
        fontSize: '15px',
        color: '#e2e4ea',
        '::placeholder': { color: '#6b7280' },
      },
    },
  });
  cardElement.mount('#card-element');
}

function openModal(plan) {
  if (!modal) return;
  currentPlan = plan;
  const priceText = document.getElementById('modal-price-text');
  if (priceText) priceText.textContent = plan === 'yearly' ? '€40/year' : '$3.99/month';
  showStep(1);
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  emailInput?.focus();
}

function closeModal() {
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = '';
}

function showStep(n) {
  if (step1) step1.hidden = n !== 1;
  if (step2) step2.hidden = n !== 2;
  if (n === 2) initStripe();
}

document.getElementById('checkout-btn-monthly')?.addEventListener('click', () => openModal('monthly'));
document.getElementById('checkout-btn-yearly')?.addEventListener('click',  () => openModal('yearly'));
modalClose?.addEventListener('click', closeModal);
backdrop?.addEventListener('click', closeModal);
backBtn?.addEventListener('click', () => showStep(1));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// Step 1: email submit → fetch setup-intent
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = emailInput?.value?.trim();
  if (!email) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Loading…';
  if (errorEl) errorEl.hidden = true;

  try {
    const res = await fetch(`${API_BASE}/v1/billing/setup-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Server error ${res.status}`);
    }

    const { clientSecret, customerId } = await res.json();
    stripeCustomerId = customerId;

    // Store client secret on the card submit button for later use
    cardSubmit.dataset.clientSecret = clientSecret;
    if (emailDisplay) emailDisplay.textContent = email;

    showStep(2);
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      errorEl.hidden = false;
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Continue →';
  }
});

// Step 2: confirm card + create subscription
cardSubmit?.addEventListener('click', async () => {
  if (!stripe || !cardElement) return;
  const clientSecret = cardSubmit.dataset.clientSecret;
  if (!clientSecret) return;

  cardSubmit.disabled = true;
  cardSubmit.textContent = 'Processing…';
  if (cardErrors) cardErrors.hidden = true;

  const email = emailInput?.value?.trim();

  try {
    const { setupIntent, error } = await stripe.confirmCardSetup(clientSecret, {
      payment_method: {
        card: cardElement,
        billing_details: { email: email ?? undefined },
      },
    });

    if (error) throw new Error(error.message);

    const paymentMethodId = setupIntent.payment_method;

    const res = await fetch(`${API_BASE}/v1/billing/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: stripeCustomerId, paymentMethodId, plan: currentPlan }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Server error ${res.status}`);
    }

    // Success!
    closeModal();
    const overlay = document.getElementById('success-overlay');
    if (overlay) {
      overlay.hidden = false;
      document.body.style.overflow = 'hidden';
    }
  } catch (err) {
    if (cardErrors) {
      cardErrors.textContent = err instanceof Error ? err.message : 'Payment failed. Please try again.';
      cardErrors.hidden = false;
    }
    cardSubmit.disabled = false;
    cardSubmit.textContent = 'Start free trial →';
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
