import type { EmbeddingProvider, RecallResult } from '@memcode/core';
import type Database from 'better-sqlite3';

/**
 * HostedEmbeddingProvider — Pro-tier EmbeddingProvider.
 *
 * Sends text batches to the MemCode Pro embedding API, which returns
 * dense vectors. The server-side vector index (HNSW) is queried for
 * semantic nearest neighbours.
 *
 * Why this is hard to recreate:
 *   1. Requires a running embedding model (fine-tuned on code + decisions)
 *   2. Requires a vector index populated from your entire history
 *   3. Cross-project search requires seeing vectors from all workspaces
 *   4. The model is continuously improved from user feedback signals
 *
 * PROPRIETARY — do not open-source.
 */
export class HostedEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hosted-embedding';
  readonly dimensions = 1536;

  constructor(
    private readonly apiEndpoint: string,
    private readonly apiToken: string,
    private readonly workspaceId: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.apiEndpoint}/v1/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify({ texts, workspaceId: this.workspaceId }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status}`);
    }

    const { embeddings } = await response.json() as { embeddings: number[][] };
    return embeddings;
  }

  /**
   * semanticSearch — called by retrieval.ts when this provider is registered.
   *
   * Queries the server-side vector index for entries similar to `queryVector`.
   * The server has visibility across ALL workspaces for cross-project search
   * (if the user has opted in), providing insights impossible to get locally.
   */
  async semanticSearch(
    _db: Database.Database,
    workspaceId: string,
    queryVector: number[],
    limit: number,
  ): Promise<RecallResult[]> {
    const response = await fetch(`${this.apiEndpoint}/v1/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify({ workspaceId, queryVector, limit }),
    });

    if (!response.ok) {
      throw new Error(`Semantic search API error: ${response.status}`);
    }

    return (await response.json() as { results: RecallResult[] }).results;
  }
}
