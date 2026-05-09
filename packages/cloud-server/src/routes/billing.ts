import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { pool } from '../db/client';
import { config } from '../config';
import { authenticate, signToken } from '../middleware/authenticate';
import type { TokenPayload } from '../middleware/authenticate';

const stripe = new Stripe(config.stripeSecretKey, { apiVersion: '2024-06-20' });

interface CheckoutBody {
  email: string;
  plan?: 'monthly' | 'yearly';
}

export async function billingRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/billing/checkout
   * Creates a Stripe Checkout session for a new $3.99/month subscription.
   * Does NOT require auth — the user may not have an account yet.
   * Body: { email }
   * Returns: { url }  — redirect the browser to this URL
   */
  fastify.post<{ Body: CheckoutBody }>(
    '/v1/billing/checkout',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string' },
            plan: { type: 'string', enum: ['monthly', 'yearly'] },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CheckoutBody }>, reply: FastifyReply) => {
      const { email, plan = 'monthly' } = request.body;
      const priceId = plan === 'yearly' ? config.stripePriceIdYearly : config.stripePriceId;

      // Get or create Stripe customer for this email
      let customerId: string;
      let checkoutDbUserId: string | undefined;
      const userResult = await pool.query(
        'SELECT id, stripe_customer_id FROM users WHERE email = $1',
        [email.toLowerCase()],
      );

      if ((userResult.rowCount ?? 0) > 0) {
        const user = userResult.rows[0] as { id: string; stripe_customer_id: string | null };
        checkoutDbUserId = user.id;
        if (user.stripe_customer_id) {
          customerId = user.stripe_customer_id;
        } else {
          const customer = await stripe.customers.create({ email: email.toLowerCase() });
          customerId = customer.id;
          await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [
            customerId,
            user.id,
          ]);
        }
      } else {
        const customer = await stripe.customers.create({ email: email.toLowerCase() });
        customerId = customer.id;
      }

      const createCheckoutSession = async (cid: string) =>
        stripe.checkout.sessions.create({
          customer: cid,
          payment_method_types: ['card'],
          mode: 'subscription',
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: `${config.appUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${config.appUrl}/pricing`,
          customer_update: { address: 'auto' },
          automatic_tax: { enabled: true },
        });

      let session: Stripe.Checkout.Session;
      try {
        session = await createCheckoutSession(customerId);
      } catch (err) {
        if ((err as Stripe.StripeRawError).code === 'resource_missing') {
          const customer = await stripe.customers.create({ email: email.toLowerCase() });
          customerId = customer.id;
          if (checkoutDbUserId) {
            await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [
              customerId, checkoutDbUserId,
            ]);
          }
          session = await createCheckoutSession(customerId);
        } else {
          throw err;
        }
      }

      return reply.send({ url: session.url });
    },
  );

  /**
   * POST /v1/billing/setup-intent
   * Creates a Stripe SetupIntent so the frontend can collect card details via
   * Stripe Elements (no redirect). Returns clientSecret + customerId.
   * Body: { email }
   */
  fastify.post<{ Body: { email: string } }>(
    '/v1/billing/setup-intent',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string' } },
        },
      },
    },
    async (request: FastifyRequest<{ Body: { email: string } }>, reply: FastifyReply) => {
      const { email } = request.body;

      let customerId: string;
      let dbUserId: string | undefined;
      const userResult = await pool.query(
        'SELECT id, stripe_customer_id FROM users WHERE email = $1',
        [email.toLowerCase()],
      );

      if ((userResult.rowCount ?? 0) > 0) {
        const user = userResult.rows[0] as { id: string; stripe_customer_id: string | null };
        dbUserId = user.id;
        if (user.stripe_customer_id) {
          customerId = user.stripe_customer_id;
        } else {
          const customer = await stripe.customers.create({ email: email.toLowerCase() });
          customerId = customer.id;
          await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [
            customerId,
            user.id,
          ]);
        }
      } else {
        const customer = await stripe.customers.create({ email: email.toLowerCase() });
        customerId = customer.id;
      }

      let setupIntent: Stripe.SetupIntent;
      try {
        setupIntent = await stripe.setupIntents.create({
          customer: customerId,
          payment_method_types: ['card'],
          usage: 'off_session',
        });
      } catch (err) {
        // Stale customer ID (e.g. deleted from Stripe dashboard) — recreate
        if ((err as Stripe.StripeRawError).code === 'resource_missing') {
          const customer = await stripe.customers.create({ email: email.toLowerCase() });
          customerId = customer.id;
          if (dbUserId) {
            await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [
              customerId,
              dbUserId,
            ]);
          }
          setupIntent = await stripe.setupIntents.create({
            customer: customerId,
            payment_method_types: ['card'],
            usage: 'off_session',
          });
        } else {
          throw err;
        }
      }

      return reply.send({ clientSecret: setupIntent.client_secret, customerId });
    },
  );

  /**
   * POST /v1/billing/subscribe
   * Called after the frontend confirms the SetupIntent. Creates a subscription.
   * Body: { customerId, paymentMethodId, plan? }
   */
  fastify.post<{ Body: { customerId: string; paymentMethodId: string; plan?: 'monthly' | 'yearly' } }>(
    '/v1/billing/subscribe',
    {
      schema: {
        body: {
          type: 'object',
          required: ['customerId', 'paymentMethodId'],
          properties: {
            customerId: { type: 'string' },
            paymentMethodId: { type: 'string' },
            plan: { type: 'string', enum: ['monthly', 'yearly'] },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { customerId: string; paymentMethodId: string; plan?: 'monthly' | 'yearly' } }>,
      reply: FastifyReply,
    ) => {
      const { customerId, paymentMethodId, plan = 'monthly' } = request.body;
      const priceId = plan === 'yearly' ? config.stripePriceIdYearly : config.stripePriceId;

      // Idempotency guard: return any non-canceled subscription for this customer
      const existing = await stripe.subscriptions.list({
        customer: customerId,
        limit: 5,
      });
      const live = existing.data.find(s =>
        ['active', 'trialing', 'incomplete', 'past_due'].includes(s.status),
      );
      if (live) {
        return reply.send({ subscriptionId: live.id, status: live.status });
      }

      // Attach card as customer default payment method
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });

      // Create subscription (idempotency key scoped to customer+price)
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        default_payment_method: paymentMethodId,
      }, {
        idempotencyKey: `sub-${customerId}-${priceId}`,
      });

      // Provision user account if not yet created
      const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
      const email = customer.email;
      if (email) {
        await pool.query(
          `INSERT INTO users (email, password_hash, stripe_customer_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (email) DO UPDATE SET stripe_customer_id = $3`,
          [email.toLowerCase(), '!LOCKED', customerId],
        );
        await upsertSubscription(subscription);

        // Issue a JWT so the frontend can auto-log in after checkout
        const userRow = await pool.query(
          'SELECT id FROM users WHERE email = $1',
          [email.toLowerCase()],
        );
        if ((userRow.rowCount ?? 0) > 0) {
          const userId = (userRow.rows[0] as { id: string }).id;
          const token = await signToken({ sub: userId, email: email.toLowerCase() });
          return reply.send({ subscriptionId: subscription.id, status: subscription.status, token });
        }
      }

      return reply.send({ subscriptionId: subscription.id, status: subscription.status });
    },
  );

  /**
   * GET /v1/billing/payment-methods
   * Returns the saved payment methods for the authenticated user's Stripe customer.
   * Requires auth.
   */
  fastify.get(
    '/v1/billing/payment-methods',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;
      const userResult = await pool.query(
        'SELECT stripe_customer_id FROM users WHERE id = $1',
        [user.sub],
      );
      const row = userResult.rows[0] as { stripe_customer_id: string | null } | undefined;
      if (!row?.stripe_customer_id) {
        return reply.send({ paymentMethods: [] });
      }
      // Fetch the customer so we know the default PM
      const customer = await stripe.customers.retrieve(row.stripe_customer_id) as Stripe.Customer;
      const defaultPmId =
        typeof customer.invoice_settings?.default_payment_method === 'string'
          ? customer.invoice_settings.default_payment_method
          : (customer.invoice_settings?.default_payment_method as Stripe.PaymentMethod | null)?.id ?? null;

      const pmList = await stripe.paymentMethods.list({
        customer: row.stripe_customer_id,
        type: 'card',
        limit: 10,
      });
      const paymentMethods = pmList.data.map((pm) => ({
        id: pm.id,
        brand: pm.card?.brand ?? 'card',
        last4: pm.card?.last4 ?? '????',
        expMonth: pm.card?.exp_month ?? 0,
        expYear: pm.card?.exp_year ?? 0,
        isDefault: pm.id === defaultPmId,
      }));
      return reply.send({ paymentMethods });
    },
  );

  /**
   * POST /v1/billing/update-payment
   * Creates a new SetupIntent so the user can replace their payment method.
   * Requires auth.
   */
  fastify.post(
    '/v1/billing/update-payment',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;
      const userResult = await pool.query(
        'SELECT stripe_customer_id FROM users WHERE id = $1',
        [user.sub],
      );
      const row = userResult.rows[0] as { stripe_customer_id: string | null } | undefined;
      if (!row?.stripe_customer_id) {
        return reply.status(404).send({ error: 'No billing account found' });
      }
      const setupIntent = await stripe.setupIntents.create({
        customer: row.stripe_customer_id,
        payment_method_types: ['card'],
        usage: 'off_session',
      });
      return reply.send({ clientSecret: setupIntent.client_secret });
    },
  );

  /**
   * POST /v1/billing/confirm-payment-update
   * After SetupIntent confirmed on frontend, attach new PM and update subscription default.
   * Body: { paymentMethodId }
   * Requires auth.
   */
  fastify.post<{ Body: { paymentMethodId: string } }>(
    '/v1/billing/confirm-payment-update',
    { preHandler: authenticate },
    async (request: FastifyRequest<{ Body: { paymentMethodId: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Body: { paymentMethodId: string } }> & { user: TokenPayload }).user;
      const { paymentMethodId } = request.body;
      const userResult = await pool.query(
        'SELECT stripe_customer_id FROM users WHERE id = $1',
        [user.sub],
      );
      const row = userResult.rows[0] as { stripe_customer_id: string | null } | undefined;
      if (!row?.stripe_customer_id) {
        return reply.status(404).send({ error: 'No billing account found' });
      }
      // Set as default on customer and active subscription
      await stripe.customers.update(row.stripe_customer_id, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
      const subs = await stripe.subscriptions.list({ customer: row.stripe_customer_id, limit: 1 });
      if (subs.data.length > 0) {
        await stripe.subscriptions.update(subs.data[0].id, {
          default_payment_method: paymentMethodId,
        });
      }
      return reply.send({ ok: true });
    },
  );

  /**
   * POST /v1/billing/cancel
   * Cancels the subscription at period end.
   * Requires auth.
   */
  fastify.post(
    '/v1/billing/cancel',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;
      const userResult = await pool.query(
        'SELECT stripe_customer_id FROM users WHERE id = $1',
        [user.sub],
      );
      const row = userResult.rows[0] as { stripe_customer_id: string | null } | undefined;
      if (!row?.stripe_customer_id) {
        return reply.status(404).send({ error: 'No billing account found' });
      }
      const subs = await stripe.subscriptions.list({
        customer: row.stripe_customer_id,
        status: 'active',
        limit: 1,
      });
      if (subs.data.length === 0) {
        return reply.status(404).send({ error: 'No active subscription found' });
      }
      const cancelled = await stripe.subscriptions.update(subs.data[0].id, {
        cancel_at_period_end: true,
      });
      // Update local DB status
      await pool.query(
        'UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE stripe_subscription_id = $2',
        ['canceled', cancelled.id],
      );
      return reply.send({ ok: true, cancelAt: new Date(cancelled.cancel_at! * 1000).toISOString() });
    },
  );

  /**
   * POST /v1/billing/set-default-payment
   * Sets a payment method as the customer + subscription default.
   * Body: { paymentMethodId }
   * Requires auth.
   */
  fastify.post<{ Body: { paymentMethodId: string } }>(
    '/v1/billing/set-default-payment',
    { preHandler: authenticate },
    async (request: FastifyRequest<{ Body: { paymentMethodId: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Body: { paymentMethodId: string } }> & { user: TokenPayload }).user;
      const { paymentMethodId } = request.body;
      const userResult = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [user.sub]);
      const row = userResult.rows[0] as { stripe_customer_id: string | null } | undefined;
      if (!row?.stripe_customer_id) return reply.status(404).send({ error: 'No billing account found' });
      // Verify ownership
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
      if (pm.customer !== row.stripe_customer_id) return reply.status(403).send({ error: 'Forbidden' });
      await stripe.customers.update(row.stripe_customer_id, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
      const subs = await stripe.subscriptions.list({ customer: row.stripe_customer_id, limit: 1 });
      if (subs.data.length > 0) {
        await stripe.subscriptions.update(subs.data[0].id, { default_payment_method: paymentMethodId });
      }
      return reply.send({ ok: true });
    },
  );

  /**
   * DELETE /v1/billing/payment-method/:pmId
   * Detaches a payment method from the customer.
   * Requires auth.
   */
  fastify.delete<{ Params: { pmId: string } }>(
    '/v1/billing/payment-method/:pmId',
    { preHandler: authenticate },
    async (request: FastifyRequest<{ Params: { pmId: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Params: { pmId: string } }> & { user: TokenPayload }).user;
      const { pmId } = request.params;
      const userResult = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [user.sub]);
      const row = userResult.rows[0] as { stripe_customer_id: string | null } | undefined;
      if (!row?.stripe_customer_id) return reply.status(404).send({ error: 'No billing account found' });
      // Verify ownership before detaching
      const pm = await stripe.paymentMethods.retrieve(pmId);
      if (pm.customer !== row.stripe_customer_id) return reply.status(403).send({ error: 'Forbidden' });
      await stripe.paymentMethods.detach(pmId);
      return reply.send({ ok: true });
    },
  );

  /**
   * POST /v1/billing/portal
   * Kept for backwards compat.
   */
  fastify.post(
    '/v1/billing/portal',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;

      const userResult = await pool.query(
        'SELECT stripe_customer_id FROM users WHERE id = $1',
        [user.sub],
      );
      const row = userResult.rows[0] as { stripe_customer_id: string | null } | undefined;

      if (!row?.stripe_customer_id) {
        return reply.status(404).send({ error: 'No billing account found' });
      }

      try {
        const portalSession = await stripe.billingPortal.sessions.create({
          customer: row.stripe_customer_id,
          return_url: `${config.appUrl}/dashboard`,
        });
        return reply.send({ url: portalSession.url });
      } catch (err) {
        const stripeErr = err as { message?: string; type?: string };
        fastify.log.error({ err }, 'Stripe billing portal error');
        return reply.status(502).send({
          error: stripeErr.message ?? 'Failed to open billing portal. Please try again.',
        });
      }
    },
  );

  /**
   * POST /v1/billing/webhook
   * Stripe webhook — handles subscription lifecycle events.
   * Must receive raw (unparsed) body for signature verification.
   */
  fastify.post(
    '/v1/billing/webhook',
    {
      config: { rawBody: true }, // requires rawBody plugin or addContentTypeParser
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const sig = request.headers['stripe-signature'] as string;
      let event: Stripe.Event;

      try {
        event = stripe.webhooks.constructEvent(
          (request as FastifyRequest & { rawBody: Buffer }).rawBody,
          sig,
          config.stripeWebhookSecret,
        );
      } catch (err) {
        fastify.log.warn('Stripe webhook signature verification failed');
        return reply.status(400).send({ error: 'Invalid signature' });
      }

      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription;
          await upsertSubscription(subscription);
          break;
        }
        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription;
          await pool.query(
            `UPDATE subscriptions SET status = 'canceled', updated_at = NOW()
             WHERE stripe_subscription_id = $1`,
            [subscription.id],
          );
          break;
        }
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          // If the checkout was for a new user (no pre-existing account), create one.
          // The user will set a password via the CLI `memory sync auth` flow.
          if (session.customer_email && session.customer) {
            const existing = await pool.query(
              'SELECT id FROM users WHERE email = $1',
              [session.customer_email],
            );
            if ((existing.rowCount ?? 0) === 0) {
              // Create account with a locked password — they must set it via CLI
              await pool.query(
                `INSERT INTO users (email, password_hash, stripe_customer_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (email) DO UPDATE SET stripe_customer_id = $3`,
                [
                  session.customer_email,
                  '!LOCKED', // placeholder — user sets password on first CLI login
                  session.customer as string,
                ],
              );
            } else {
              await pool.query(
                'UPDATE users SET stripe_customer_id = $1 WHERE email = $2',
                [session.customer as string, session.customer_email],
              );
            }
          }
          break;
        }
        default:
          // Ignore unhandled event types
          break;
      }

      return reply.send({ received: true });
    },
  );
}

async function upsertSubscription(subscription: Stripe.Subscription): Promise<void> {
  // Resolve user by Stripe customer ID
  const userResult = await pool.query(
    'SELECT id FROM users WHERE stripe_customer_id = $1',
    [subscription.customer as string],
  );
  if ((userResult.rowCount ?? 0) === 0) return;

  const userId = (userResult.rows[0] as { id: string }).id;
  const priceId = subscription.items.data[0]?.price.id ?? '';
  const periodEnd = new Date((subscription.current_period_end) * 1000).toISOString();

  await pool.query(
    `INSERT INTO subscriptions
       (user_id, stripe_subscription_id, stripe_price_id, status, current_period_end)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (stripe_subscription_id) DO UPDATE
       SET status = $4, current_period_end = $5, updated_at = NOW()`,
    [userId, subscription.id, priceId, subscription.status, periodEnd],
  );
}
