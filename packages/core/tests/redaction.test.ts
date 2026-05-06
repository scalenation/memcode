import { describe, it, expect } from 'vitest';
import { redact, containsSecret } from '../src/redaction';

describe('redact()', () => {
  it('passes through clean text unchanged', () => {
    const text = 'This is a normal commit message with no secrets.';
    expect(redact(text)).toBe(text);
  });

  it('redacts an OpenAI API key', () => {
    const text = 'Set OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyzABCD1234 in env';
    const result = redact(text);
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyzABCD1234');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts a GitHub personal access token', () => {
    const text = 'token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789';
    const result = redact(text);
    expect(result).not.toContain('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts a JWT token', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ' +
      '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = redact(jwt);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts an AWS access key ID', () => {
    const text = 'Using AKIAIOSFODNN7EXAMPLE for S3 access';
    const result = redact(text);
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts a PEM private key', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIE...\nsome_base64_data\n-----END RSA PRIVATE KEY-----`;
    const result = redact(pem);
    expect(result).not.toContain('MIIe');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts password= assignment', () => {
    const text = 'db_password=supersecretpassword123';
    const result = redact(text);
    expect(result).not.toContain('supersecretpassword123');
  });

  it('redacts api_key: value', () => {
    const text = 'api_key: abcdefghijklmnopqrstuvwxyz1234567890';
    const result = redact(text);
    expect(result).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('preserves surrounding text around redacted credential', () => {
    const text = 'Connecting to DB with password=mysupersecret123 and retry=3';
    const result = redact(text);
    expect(result).toContain('password=');
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('retry=3');
  });

  it('handles multiple secrets in one string', () => {
    const text = [
      'OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyz12345678',
      'token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789',
    ].join('\n');
    const result = redact(text);
    expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('containsSecret()', () => {
  it('returns false for clean text', () => {
    expect(containsSecret('No secrets here')).toBe(false);
  });

  it('returns true when a secret is present', () => {
    expect(containsSecret('key=sk-abcdefghijklmnopqrstuvwxyz12345678')).toBe(true);
  });
});
