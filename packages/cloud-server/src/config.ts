import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  syncPayloadStorage: process.env.SYNC_PAYLOAD_STORAGE ?? 'database',
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  stripeSecretKey: required('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: required('STRIPE_WEBHOOK_SECRET'),
  stripePriceId: required('STRIPE_PRICE_ID'),
  stripePriceIdYearly: required('STRIPE_PRICE_ID_YEARLY'),
  appUrl: process.env.APP_URL ?? 'http://localhost:3000',
  // Email (Resend) — optional; magic link is disabled if not configured
  resendApiKey: process.env.RESEND_API_KEY,
  resendFromEmail: process.env.RESEND_FROM_EMAIL ?? 'MemCode <noreply@memcode.pro>',
  // OAuth — optional; routes are skipped if not configured
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  githubClientId: process.env.GITHUB_CLIENT_ID,
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
};
