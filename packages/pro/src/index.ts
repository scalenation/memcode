import { registry } from '@memcode/core';
import { LLMSummarizer } from './llm-summarizer';
import { HostedEmbeddingProvider } from './embedding-provider';

export interface ProActivationOptions {
  apiEndpoint: string;
  apiToken: string;
  workspaceId: string;
}

/**
 * activate() — called by @memcode/pro's CLI plugin before any command runs.
 *
 * Registers all Pro providers into the shared ProviderRegistry.
 * After this call, `registry.isPro === true` and all Pro gates open.
 *
 * The OSS CLI discovers this function via a plugin hook (package.json
 * "memcode" key), so users only need:
 *   npm install -g @memcode/pro
 *   memory sync auth
 * — no code changes to the OSS CLI.
 */
export function activate(opts: ProActivationOptions): void {
  registry.setSummarizer(new LLMSummarizer(opts.apiEndpoint, opts.apiToken, opts.workspaceId));
  registry.setEmbedding(new HostedEmbeddingProvider(opts.apiEndpoint, opts.apiToken, opts.workspaceId));
}

export { LLMSummarizer } from './llm-summarizer';
export { HostedEmbeddingProvider } from './embedding-provider';
