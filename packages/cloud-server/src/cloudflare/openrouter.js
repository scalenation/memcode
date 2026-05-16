const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const IV_LENGTH = 12;

export const OPENROUTER_MODELS = [
  { id: 'openai/gpt-oss-20b:free', label: 'OpenAI GPT-OSS 20B', provider: 'OpenAI', free: true },
  { id: 'openai/gpt-oss-120b:free', label: 'OpenAI GPT-OSS 120B', provider: 'OpenAI', free: true },
  { id: 'meta-llama/llama-3.3-8b-instruct:free', label: 'Llama 3.3 8B Instruct', provider: 'Meta', free: true },
  { id: 'qwen/qwen-2.5-72b-instruct:free', label: 'Qwen 2.5 72B Instruct', provider: 'Qwen', free: true },
  { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku', provider: 'Anthropic', free: false },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Google', free: false },
  { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini', provider: 'OpenAI', free: false },
];

export const DEFAULT_OPENROUTER_MODEL = OPENROUTER_MODELS[0].id;

export function isSupportedOpenRouterModel(model) {
  return OPENROUTER_MODELS.some((option) => option.id === model);
}

export async function encryptSecret(plaintext, env) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await secretKey(env.JWT_SECRET);
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return bytesToBase64(concatBytes(iv, new Uint8Array(ciphertext)));
}

export async function decryptSecret(encoded, env) {
  const buffer = base64ToBytes(encoded);
  const iv = buffer.slice(0, IV_LENGTH);
  const ciphertext = buffer.slice(IV_LENGTH);
  const key = await secretKey(env.JWT_SECRET);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

export async function completeWithOpenRouter(env, input) {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': env.APP_URL,
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
    throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) {
    return {
      text: content.trim(),
      usage: normalizeOpenRouterUsage(payload?.usage),
      model: payload?.model ?? input.model,
      provider: 'openrouter',
    };
  }
  if (Array.isArray(content)) {
    const text = content.map((part) => typeof part?.text === 'string' ? part.text : '').join('').trim();
    if (text) {
      return {
        text,
        usage: normalizeOpenRouterUsage(payload?.usage),
        model: payload?.model ?? input.model,
        provider: 'openrouter',
      };
    }
  }

  throw new Error('OpenRouter response did not contain any text output');
}

export async function fetchOpenRouterKeyInfo(env, apiKey) {
  const response = await fetch(OPENROUTER_KEY_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': env.APP_URL,
      'X-Title': 'MemCode',
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter key lookup failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const data = payload?.data ?? {};
  return {
    label: data.label ?? null,
    limit: numberOrNull(data.limit),
    limitRemaining: numberOrNull(data.limit_remaining),
    limitReset: data.limit_reset ?? null,
    usage: numberOrZero(data.usage),
    usageDaily: numberOrZero(data.usage_daily),
    usageWeekly: numberOrZero(data.usage_weekly),
    usageMonthly: numberOrZero(data.usage_monthly),
    byokUsage: numberOrZero(data.byok_usage),
    byokUsageDaily: numberOrZero(data.byok_usage_daily),
    byokUsageWeekly: numberOrZero(data.byok_usage_weekly),
    byokUsageMonthly: numberOrZero(data.byok_usage_monthly),
    includeByokInLimit: Boolean(data.include_byok_in_limit),
    isFreeTier: Boolean(data.is_free_tier),
  };
}

function normalizeOpenRouterUsage(usage) {
  const promptTokens = numberOrZero(usage?.prompt_tokens ?? usage?.input_tokens);
  const completionTokens = numberOrZero(usage?.completion_tokens ?? usage?.output_tokens);
  const totalTokens = numberOrZero(usage?.total_tokens ?? (promptTokens + completionTokens));
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    creditsUsed: numberOrNull(usage?.cost ?? usage?.credits ?? usage?.total_cost),
  };
}

async function secretKey(jwtSecret) {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jwtSecret));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function concatBytes(a, b) {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function numberOrNull(value) {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}