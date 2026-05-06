import type { GitInfo } from './checkpoint';

/**
 * SummarizerProvider — plug-in interface for generating checkpoint summaries.
 *
 * Free tier:  DeterministicSummarizer (packages/core) — rule-based, no network
 * Pro tier:   LLMSummarizer (@memcode/pro, private) — LLM-powered, understands
 *             intent, links to prior decisions, generates richer context
 */
export interface SummarizerProvider {
  readonly name: string;
  generateShort(gitInfo: GitInfo, trigger: string, note?: string): Promise<string>;
  generateLong(gitInfo: GitInfo, trigger: string, note?: string): Promise<string>;
}

/**
 * EmbeddingProvider — plug-in interface for semantic vector search.
 *
 * Free tier:  null (keyword-only recall in retrieval.ts)
 * Pro tier:   HostedEmbeddingProvider (@memcode/pro, private) — calls your
 *             embedding API, stores vectors in a vector index, enables
 *             semantic recall ("find things conceptually similar to X")
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * InsightProvider — background analysis running server-side (Pro only).
 *
 * Not available locally. Results are delivered as push notifications or
 * surfaced in the Pro dashboard. Examples:
 *   - "Decision D-1a3b contradicts your current file structure"
 *   - "You've opened 14 tasks on auth in the past 3 months"
 *   - "Team member X made a related decision in project Y"
 *
 * The interface is defined here so the Pro server SDK can implement it;
 * the OSS code never calls it directly.
 */
export interface InsightProvider {
  readonly name: string;
  analyzeWorkspace(workspaceId: string, cursor: string): Promise<Insight[]>;
}

export interface Insight {
  id: string;
  kind: 'contradiction' | 'pattern' | 'stale-decision' | 'cross-project';
  title: string;
  detail: string;
  confidence: number;  // 0–1
  relatedIds: string[];
  created_at: number;
}

/**
 * ProviderRegistry — runtime container for pluggable providers.
 *
 * The OSS build registers only the free-tier defaults.
 * The Pro client registers premium implementations before any commands run.
 *
 * Usage:
 *   import { registry } from '@memcode/core';
 *   registry.setSummarizer(new LLMSummarizer(apiKey));   // Pro only
 *   registry.setEmbedding(new HostedEmbeddingProvider(apiKey));  // Pro only
 */
export class ProviderRegistry {
  private _summarizer?: SummarizerProvider;
  private _embedding?: EmbeddingProvider;
  private _insight?: InsightProvider;

  setSummarizer(p: SummarizerProvider): void {
    this._summarizer = p;
  }

  getSummarizer(): SummarizerProvider | undefined {
    return this._summarizer;
  }

  setEmbedding(p: EmbeddingProvider): void {
    this._embedding = p;
  }

  getEmbedding(): EmbeddingProvider | undefined {
    return this._embedding;
  }

  setInsight(p: InsightProvider): void {
    this._insight = p;
  }

  getInsight(): InsightProvider | undefined {
    return this._insight;
  }

  /** True when any Pro provider is registered. */
  get isPro(): boolean {
    return !!(this._summarizer || this._embedding || this._insight);
  }
}

/** Singleton registry used throughout the process. */
export const registry = new ProviderRegistry();
