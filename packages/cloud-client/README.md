# @memcode/cloud-client

> Encrypted cloud sync client for MemCode — push and pull AES-256-GCM encrypted memory blobs across machines.

[![npm version](https://img.shields.io/npm/v/@memcode/cloud-client)](https://www.npmjs.com/package/@memcode/cloud-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/scalenation/memcode/blob/master/LICENSE)
[![Node.js ≥ 22.15](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen)](https://nodejs.org/)
[![GitHub](https://img.shields.io/badge/GitHub-scalenation%2Fmemcode-blue?logo=github)](https://github.com/scalenation/memcode)

---

## What is this package?

`@memcode/cloud-client` is the network layer used by the [`@memcode/cli`](https://www.npmjs.com/package/@memcode/cli) `memory sync` commands. It handles:

- **Key derivation** — `SHA256(passphrase + ":" + workspaceId)` — computed locally, never sent to the server
- **AES-256-GCM encryption/decryption** — all payloads are encrypted before upload and decrypted after download
- **Push** — serialise workspace memory, encrypt, POST to the cloud API
- **Pull** — GET latest encrypted blob, decrypt, merge into local store

> **Most users don't need to install this directly.** Install [`@memcode/cli`](https://www.npmjs.com/package/@memcode/cli) instead — it bundles the cloud client automatically.

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | ≥ 22.15.0 |
| MemCode Cloud account | [memcode.pro/pricing](https://memcode.pro/pricing) (Pro, $3.99/month) |

---

## Installation

```bash
npm install @memcode/cloud-client
```

---

## Security Architecture

The MemCode cloud is **zero-knowledge** — the server stores ciphertext only.

```
Your machine                         MemCode Cloud
─────────────────────────────────    ──────────────────────
passphrase + workspaceId
        │
        ▼
 SHA-256 → 32-byte key
        │
        ▼
AES-256-GCM encrypt(memory blob) ──▶  stores ciphertext
                                        never sees plaintext
        ▲
AES-256-GCM decrypt(ciphertext)  ◀──  returns ciphertext
```

The encryption passphrase is entered once via `memory sync auth` and stored locally in `~/.config/memcode/auth.json` (mode `0600`). It is never transmitted.

---

## API Reference

### `deriveKey(passphrase: string, workspaceId: string): Promise<CryptoKey>`

Derive a 256-bit AES-GCM key from a passphrase and workspace UUID using SHA-256.

```ts
import { deriveKey } from '@memcode/cloud-client';

const key = await deriveKey('my-passphrase', 'workspace-uuid');
```

---

### `pushSync(db: DatabaseSync, config: SyncConfig): Promise<PushResult>`

Encrypt the full workspace memory and push it to the cloud API.

```ts
import { pushSync, deriveKey } from '@memcode/cloud-client';

const key = await deriveKey(passphrase, workspaceId);

const result = await pushSync(db, {
  endpoint: 'https://api.memcode.pro',
  apiToken: 'your-jwt-token',
  workspaceId: 'workspace-uuid',
  encryptionKey: key,
});

console.log(result.cursor); // new cursor string
```

`pushSync` automatically registers the workspace with the API if it hasn't been registered yet.

---

### `pullSync(db: DatabaseSync, config: SyncConfig): Promise<PullResult>`

Fetch the latest encrypted blob from the cloud API and merge it into the local store.

```ts
import { pullSync, deriveKey } from '@memcode/cloud-client';

const key = await deriveKey(passphrase, workspaceId);

const result = await pullSync(db, {
  endpoint: 'https://api.memcode.pro',
  apiToken: 'your-jwt-token',
  workspaceId: 'workspace-uuid',
  encryptionKey: key,
  cursor: lastKnownCursor, // optional, omit to pull from the start
});

console.log(result.cursor);
console.log(result.merged); // { checkpoints, decisions, tasks }
```

---

## Types

```ts
export interface SyncConfig {
  endpoint: string;       // Base URL of the MemCode API, e.g. 'https://api.memcode.pro'
  apiToken: string;       // JWT obtained via POST /v1/auth/login
  workspaceId: string;    // Local workspace UUID (from .memory/config.json)
  encryptionKey: CryptoKey; // Derived via deriveKey()
  cursor?: string;        // Opaque cursor from the last pull (optional)
}

export interface PushResult {
  cursor: string;         // New cursor after the push
}

export interface PullResult {
  cursor: string;         // Latest cursor from the server
  merged: {
    checkpoints: number;
    decisions: number;
    tasks: number;
  };
}
```

---

## End-to-End Example

```ts
import { openDb, getOrCreateWorkspace } from '@memcode/core';
import { deriveKey, pushSync, pullSync } from '@memcode/cloud-client';

const db = openDb('/path/to/.memory/memory.db');
const workspace = getOrCreateWorkspace(db, process.cwd());

const key = await deriveKey('my-secret-passphrase', workspace.id);

const syncConfig = {
  endpoint: 'https://api.memcode.pro',
  apiToken: process.env.MEMCODE_API_TOKEN!,
  workspaceId: workspace.id,
  encryptionKey: key,
};

// Push local memory to cloud
const pushResult = await pushSync(db, syncConfig);
console.log('Pushed, cursor:', pushResult.cursor);

// On another machine — pull and merge
const pullResult = await pullSync(db, { ...syncConfig, cursor: pushResult.cursor });
console.log('Merged:', pullResult.merged);
```

---

## Obtaining an API Token

```bash
# Via CLI (interactive, saves to ~/.config/memcode/auth.json)
memory sync auth

# Via API directly
curl -X POST https://api.memcode.pro/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}'
# Returns: { "token": "eyJ..." }
```

---

## Related Packages

| Package | Description |
|---|---|
| [`@memcode/cli`](https://www.npmjs.com/package/@memcode/cli) | CLI tool — includes `memory sync auth/push/pull/status` |
| [`@memcode/core`](https://www.npmjs.com/package/@memcode/core) | Core library — SQLite schema, checkpoint engine, retrieval |

---

## License

MIT © [MemCode](https://github.com/scalenation/memcode)
