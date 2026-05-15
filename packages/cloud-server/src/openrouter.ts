import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export type OpenRouterModelOption = {
  id: string;
  label: string;
  provider: string;
  free: boolean;
};

export const OPENROUTER_MODELS: OpenRouterModelOption[] = [
  { id: 'openai/gpt-oss-20b:free', label: 'OpenAI GPT-OSS 20B', provider: 'OpenAI', free: true },
  { id: 'openai/gpt-oss-120b:free', label: 'OpenAI GPT-OSS 120B', provider: 'OpenAI', free: true },
  { id: 'meta-llama/llama-3.3-8b-instruct:free', label: 'Llama 3.3 8B Instruct', provider: 'Meta', free: true },
  { id: 'qwen/qwen-2.5-72b-instruct:free', label: 'Qwen 2.5 72B Instruct', provider: 'Qwen', free: true },
  { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku', provider: 'Anthropic', free: false },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Google', free: false },
  { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini', provider: 'OpenAI', free: false },
];

export const DEFAULT_OPENROUTER_MODEL = OPENROUTER_MODELS[0].id;

export function isSupportedOpenRouterModel(model: string): boolean {
  return OPENROUTER_MODELS.some(option => option.id === model);
}

export function encryptSecret(plaintext: string): string {
  const key = secretKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
}

export function decryptSecret(encoded: string): string {
  const key = secretKey();
  const buffer = Buffer.from(encoded, 'base64');
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(buffer.length - AUTH_TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH, buffer.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export async function completeWithOpenRouter(input: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}): Promise<string> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.appUrl,
      'X-Title': 'MemCode',
    },
    body: JSON.stringify({
      model: input.model,
      temperature: input.temperature ?? 0.2,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed: ${response.status} ${body}`);
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map(part => typeof part?.text === 'string' ? part.text : '')
      .join('')
      .trim();
    if (text) return text;
  }

  throw new Error('OpenRouter response did not contain any text output');
}

function secretKey(): Buffer {
  return createHash('sha256').update(config.jwtSecret).digest();
}