import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const sourcePath = path.resolve(process.cwd(), '.env.cloudflare.sync');
const outputPath = path.resolve(process.cwd(), '.cloudflare-secrets.env');
const secretKeys = [
  'JWT_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ID',
  'STRIPE_PRICE_ID_YEARLY',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
];

if (!fs.existsSync(sourcePath)) {
  console.error(`Missing source env file: ${sourcePath}`);
  process.exit(1);
}

const parsed = dotenv.parse(fs.readFileSync(sourcePath, 'utf8'));
const includedKeys = [];
const missingKeys = [];
const lines = [];

for (const key of secretKeys) {
  const value = parsed[key];
  if (typeof value === 'string' && value.length > 0) {
    includedKeys.push(key);
    lines.push(`${key}=${JSON.stringify(value)}`);
  } else {
    missingKeys.push(key);
  }
}

fs.writeFileSync(outputPath, `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, 'utf8');

console.log(JSON.stringify({
  sourcePath,
  outputPath,
  includedKeys,
  missingKeys,
}));