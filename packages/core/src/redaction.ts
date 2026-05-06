/**
 * Secret and high-entropy string redaction engine.
 *
 * Applied to all user-provided text before it is persisted to SQLite or the
 * JSONL event archive.  The goal is defence-in-depth: if a user accidentally
 * pastes a credential into a note or commit message, it will not reach disk in
 * plaintext.
 */

interface RedactionPattern {
  name: string;
  /** Regex must use the `g` flag for replaceAll behaviour. */
  pattern: RegExp;
  /**
   * If a capture group holds the sensitive value (rather than the whole
   * match), provide its 1-based index here. The replacement will only mask
   * the captured portion, leaving the surrounding key name visible for
   * debugging.
   */
  captureGroup?: number;
}

const PATTERNS: RedactionPattern[] = [
  // Generic key=value / key: value credentials
  {
    name: 'api-key-assignment',
    pattern: /\b(api[_-]?key|apikey|access[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9_\-]{20,})["']?/gi,
    captureGroup: 2,
  },
  {
    name: 'secret-assignment',
    pattern: /\b(secret|client[_-]?secret|app[_-]?secret)\s*[:=]\s*["']?([A-Za-z0-9_\-]{16,})["']?/gi,
    captureGroup: 2,
  },
  {
    name: 'password-assignment',
    // No leading \b — matches db_password=, my_passwd=, etc.
    pattern: /(password|passwd|pwd)\s*[:=]\s*["']?([^\s"']{8,})["']?/gi,
    captureGroup: 2,
  },
  {
    name: 'token-assignment',
    pattern: /\b(token|auth[_-]?token|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{20,})["']?/gi,
    captureGroup: 2,
  },
  // Provider-specific tokens
  {
    name: 'bearer-token',
    pattern: /Bearer\s+([A-Za-z0-9\-._~+/]{20,})/g,
    captureGroup: 1,
  },
  {
    name: 'jwt',
    // eyJ… (base64url header) + . + eyJ… (payload) + . + signature
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  },
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    name: 'aws-access-key-id',
    pattern: /\b(AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'aws-secret-access-key',
    pattern: /\b(aws_secret_access_key)\s*[:=]\s*["']?([A-Za-z0-9+/]{40})["']?/gi,
    captureGroup: 2,
  },
  {
    name: 'github-token',
    pattern: /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9]{36,}\b/g,
  },
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g,
  },
  {
    name: 'stripe-key',
    pattern: /\b(sk|pk)_(live|test)_[A-Za-z0-9]{24,}\b/g,
  },
  {
    name: 'openai-key',
    pattern: /\bsk-[A-Za-z0-9]{32,}\b/g,
  },
  {
    name: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9\-]{32,}\b/g,
  },
  {
    name: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  },
];

// ---------------------------------------------------------------------------
// Shannon entropy helpers
// ---------------------------------------------------------------------------

function shannonEntropy(str: string): number {
  const freq = new Map<string, number>();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Heuristic: long tokens with high Shannon entropy that appear after an
 * assignment operator are likely credentials even if they don't match a
 * known pattern.
 */
const HIGH_ENTROPY_THRESHOLD = 4.5;
const HIGH_ENTROPY_MIN_LENGTH = 32;

// Matches tokens that follow = or : in an assignment context
const HIGH_ENTROPY_CONTEXT_RE =
  /(?<=[=:]\s*["']?)([A-Za-z0-9+/=_\-]{32,})(?=["';\s\n]|$)/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redact secrets from `text` and return the sanitised string.
 * The operation is deterministic and non-reversible.
 */
export function redact(text: string): string {
  let result = text;

  for (const { pattern, captureGroup } of PATTERNS) {
    // Reset lastIndex so reuse of stateful regexes is safe
    pattern.lastIndex = 0;

    if (captureGroup !== undefined) {
      result = result.replace(pattern, (match, ...args) => {
        // args: [group1, group2, ..., offset, fullString]
        const captured = args[captureGroup - 1] as string;
        if (!captured) return '[REDACTED]';
        return match.replace(captured, '[REDACTED]');
      });
    } else {
      result = result.replace(pattern, '[REDACTED]');
    }
  }

  // High-entropy context-aware pass
  HIGH_ENTROPY_CONTEXT_RE.lastIndex = 0;
  result = result.replace(HIGH_ENTROPY_CONTEXT_RE, (token) => {
    if (
      token.length >= HIGH_ENTROPY_MIN_LENGTH &&
      shannonEntropy(token) >= HIGH_ENTROPY_THRESHOLD
    ) {
      return '[REDACTED]';
    }
    return token;
  });

  return result;
}

/**
 * Return true if the string contains at least one redactable pattern
 * (useful for testing and validation).
 */
export function containsSecret(text: string): boolean {
  return redact(text) !== text;
}
