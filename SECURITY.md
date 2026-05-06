# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅ Yes     |
| < 1.0   | ❌ No      |

## Reporting a Vulnerability

**Please do not file a public GitHub issue for security vulnerabilities.**

Email **security@memcode.dev** with:

1. A description of the vulnerability and its potential impact.
2. Steps to reproduce or a proof-of-concept.
3. The version(s) affected.
4. Any suggested remediation if you have one.

You will receive an acknowledgement within **48 hours** and a resolution timeline within **7 days**.

## Built-in Redaction

MemCode redacts the following patterns before any data is persisted or synced:

- API keys and tokens (common prefixes: `sk-`, `ghp_`, `xoxb-`, `AKIA…`)
- JWT tokens (`eyJ…`)
- PEM private keys
- `password =`, `secret =`, `token =` in `.env`-style content
- High-entropy strings ≥ 20 characters (Shannon entropy ≥ 4.5 bits/char)

If you believe the redaction engine misses a class of secrets, please report it.

## Local Storage

All memory data is stored in `.memory/memory.db` (SQLite) and `.memory/events.jsonl` inside your project directory. These files are excluded from git by default.

An optional local encryption passphrase can be configured in `.memory/config.json` (not yet implemented in v1 — tracked as a roadmap item).

## Cloud Sync (Pro)

Cloud sync is **opt-in only**. When enabled:

- Data is encrypted in transit (TLS 1.3).
- Payloads are encrypted per-workspace with a user-controlled key.
- Only summaries and metadata are synced — raw transcripts stay local.
