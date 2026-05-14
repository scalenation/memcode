import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Checkpoint, Decision, Message, Session, Task } from '@memcode/core';

export interface ProjectBrainMilestone {
  id: string;
  title: string;
  detail?: string;
  trigger?: string | null;
  branch?: string | null;
  gitSha?: string | null;
  createdAt: number;
}

export interface ProjectBrainDecision {
  id: string;
  title: string;
  rationale: string;
  impact?: string;
  status: string;
  updatedAt: number;
}

export interface ProjectBrainTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  updatedAt: number;
}

export interface ProjectBrain {
  workspaceId: string;
  generatedAt: number;
  summary: string;
  milestones: ProjectBrainMilestone[];
  decisions: ProjectBrainDecision[];
  tasks: ProjectBrainTask[];
  stats: {
    checkpointCount: number;
    decisionCount: number;
    taskCount: number;
    openTaskCount: number;
    completedTaskCount: number;
  };
}

export interface CloudConfig {
  endpoint: string;
  workspaceId: string;
  /** Per-workspace encryption key (32 bytes, hex-encoded) */
  encryptionKey: string;
  apiToken: string;
  /** If set, pull a specific blob by ID (point-in-time restore) */
  blobId?: string;
}

export interface SyncPayload {
  workspaceId: string;
  sessions?: Session[];
  messages?: Message[];
  checkpoints: Checkpoint[];
  decisions: Decision[];
  tasks: Task[];
  cursor: string;
  encryptedAt: number;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

/**
 * Encrypt a JSON payload with AES-256-GCM.
 *
 * Returns a base64-encoded string: IV (12 bytes) + ciphertext + auth tag (16 bytes).
 */
export function encryptPayload(data: unknown, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (64 hex chars)');

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Layout: IV | ciphertext | authTag
  const result = Buffer.concat([iv, encrypted, authTag]);
  return result.toString('base64');
}

/**
 * Decrypt a base64 AES-256-GCM payload produced by `encryptPayload`.
 */
export function decryptPayload<T = unknown>(encoded: string, keyHex: string): T {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');

  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const authTag = buf.subarray(buf.length - AUTH_TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - AUTH_TAG_LEN);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf-8')) as T;
}

/**
 * Derive a stable workspace encryption key from a user passphrase + workspace ID.
 * Uses SHA-256 — in production, replace with PBKDF2 or Argon2.
 */
export function deriveKey(passphrase: string, workspaceId: string): string {
  return createHash('sha256')
    .update(`${passphrase}:${workspaceId}`)
    .digest('hex');
}
