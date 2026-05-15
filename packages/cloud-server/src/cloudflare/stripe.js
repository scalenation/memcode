const STRIPE_API_BASE = 'https://api.stripe.com/v1';

export async function createStripeCheckoutSession(env, input) {
  return stripeRequest(env, 'POST', '/checkout/sessions', {
    customer: input.customer,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: `${env.APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.APP_URL}/pricing`,
    customer_update: { address: 'auto' },
    automatic_tax: { enabled: true },
  });
}

export async function createStripeCustomer(env, email) {
  return stripeRequest(env, 'POST', '/customers', { email });
}

export async function updateStripeCustomer(env, customerId, fields) {
  return stripeRequest(env, 'POST', `/customers/${customerId}`, fields);
}

export async function retrieveStripeCustomer(env, customerId) {
  return stripeRequest(env, 'GET', `/customers/${customerId}`);
}

export async function createStripeSetupIntent(env, customerId) {
  return stripeRequest(env, 'POST', '/setup_intents', {
    customer: customerId,
    payment_method_types: ['card'],
    usage: 'off_session',
  });
}

export async function listStripeSubscriptions(env, params) {
  return stripeRequest(env, 'GET', '/subscriptions', params);
}

export async function createStripeSubscription(env, input) {
  return stripeRequest(env, 'POST', '/subscriptions', {
    customer: input.customer,
    items: [{ price: input.priceId }],
    default_payment_method: input.paymentMethodId,
  }, { idempotencyKey: input.idempotencyKey });
}

export async function updateStripeSubscription(env, subscriptionId, fields) {
  return stripeRequest(env, 'POST', `/subscriptions/${subscriptionId}`, fields);
}

export async function cancelStripeSubscription(env, subscriptionId) {
  return stripeRequest(env, 'DELETE', `/subscriptions/${subscriptionId}`);
}

export async function listStripePaymentMethods(env, customerId) {
  return stripeRequest(env, 'GET', '/payment_methods', {
    customer: customerId,
    type: 'card',
    limit: 10,
  });
}

export async function retrieveStripePaymentMethod(env, paymentMethodId) {
  return stripeRequest(env, 'GET', `/payment_methods/${paymentMethodId}`);
}

export async function detachStripePaymentMethod(env, paymentMethodId) {
  return stripeRequest(env, 'POST', `/payment_methods/${paymentMethodId}/detach`);
}

export async function createStripeBillingPortalSession(env, customerId) {
  return stripeRequest(env, 'POST', '/billing_portal/sessions', {
    customer: customerId,
    return_url: `${env.APP_URL}/dashboard`,
  });
}

export async function verifyStripeWebhook(env, signatureHeader, rawBody) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('Missing STRIPE_WEBHOOK_SECRET');
  if (!signatureHeader) throw new Error('Missing Stripe signature');

  const parts = parseStripeSignature(signatureHeader);
  const timestamp = parts.t;
  const signatures = parts.v1;
  if (!timestamp || signatures.length === 0) throw new Error('Invalid Stripe signature');

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) throw new Error('Stripe signature expired');

  const payload = `${timestamp}.${rawBody}`;
  const digest = await computeHmac(env.STRIPE_WEBHOOK_SECRET, payload);
  if (!signatures.includes(digest)) throw new Error('Invalid Stripe signature');

  return JSON.parse(rawBody);
}

async function stripeRequest(env, method, path, body, options = {}) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Missing STRIPE_SECRET_KEY');
  }

  let url = `${STRIPE_API_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
  };
  const init = { method, headers };

  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  if (method === 'GET' && body) {
    const params = buildForm(body);
    const query = params.toString();
    if (query) url += `?${query}`;
  } else if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = buildForm(body).toString();
  }

  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Stripe request failed: ${response.status}`);
  }
  return payload;
}

function buildForm(value) {
  const params = new URLSearchParams();
  appendForm(params, '', value);
  return params;
}

function appendForm(params, prefix, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendForm(params, `${prefix}[${index}]`, item));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const nextPrefix = prefix ? `${prefix}[${key}]` : key;
      appendForm(params, nextPrefix, nested);
    }
    return;
  }
  params.append(prefix, String(value));
}

function parseStripeSignature(header) {
  return header.split(',').reduce((acc, part) => {
    const [key, value] = part.split('=');
    if (!key || !value) return acc;
    if (key === 'v1') acc.v1.push(value);
    else acc[key] = value;
    return acc;
  }, { v1: [] });
}

async function computeHmac(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}