import type Database from 'better-sqlite3';
import { registry } from './providers';

export interface RecallResult {
  id: string;
  type: 'decision' | 'checkpoint' | 'task';
  title: string;
  detail: string;
  score: number;
  created_at: number;
  reason: string;
}

interface Candidate {
  id: string;
  type: string;
  title: string;
  detail: string;
  created_at: number;
}

const TYPE_BOOSTS: Record<string, number> = {
  decision: 1.5,
  checkpoint: 1.0,
  task: 1.0,
};

/** Exponential recency decay — half-life of 30 days. */
const HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Recall memory entries matching `query`.
 *
 * Free tier:  keyword scoring + recency decay + type boost (synchronous)
 * Pro tier:   semantic embedding similarity replaces keyword scoring when an
 *             EmbeddingProvider is registered. The caller must await the result.
 *
 * score = keyword_score + recency_weight × type_boost
 *   keyword_score  = matched_keywords / total_keywords
 *   recency_weight = exp(−age_days × ln2 / HALF_LIFE)
 */
export async function recall(
  db: Database.Database,
  workspaceId: string,
  query: string,
  limit = 10,
): Promise<RecallResult[]> {
  const embeddingProvider = registry.getEmbedding();
  if (embeddingProvider) {
    return semanticRecall(db, workspaceId, query, limit, embeddingProvider);
  }
  return keywordRecall(db, workspaceId, query, limit);
}

/**
 * Synchronous keyword-only recall (free tier).
 * Used directly in tests and anywhere async is inconvenient.
 */
export function recallSync(
  db: Database.Database,
  workspaceId: string,
  query: string,
  limit = 10,
): RecallResult[] {
  return keywordRecall(db, workspaceId, query, limit);
}
// ---------------------------------------------------------------------------
// Free-tier: keyword recall
// ---------------------------------------------------------------------------

function keywordRecall(
  db: Database.Database,
  workspaceId: string,
  query: string,
  limit: number,
): RecallResult[] {
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length > 1);

  if (keywords.length === 0) return [];

  const candidates = db
    .prepare<[string, string, string], Candidate>(`
      SELECT id, 'decision' AS type,
             title,
             (title || ' ' || rationale || ' ' || COALESCE(impact, '')) AS detail,
             created_at
      FROM decisions WHERE workspace_id = ?

      UNION ALL

      SELECT id, 'checkpoint' AS type,
             summary_short AS title,
             (summary_short || ' ' || summary_long) AS detail,
             created_at
      FROM checkpoints WHERE workspace_id = ?

      UNION ALL

      SELECT id, 'task' AS type,
             title,
             (title || ' ' || COALESCE(description, '')) AS detail,
             created_at
      FROM tasks WHERE workspace_id = ?
    `)
    .all(workspaceId, workspaceId, workspaceId) as Candidate[];

  const now = Date.now();

  const scored = candidates
    .map((item) => {
      const textLower = item.detail.toLowerCase();
      const matched = keywords.filter((k) => textLower.includes(k));
      const keywordScore = matched.length / keywords.length;
      if (keywordScore === 0) return null;

      const ageDays = (now - item.created_at) / DAY_MS;
      const recencyWeight = Math.exp((-ageDays * Math.LN2) / HALF_LIFE_DAYS);
      const typeBoost = TYPE_BOOSTS[item.type] ?? 1.0;
      const score = keywordScore + recencyWeight * typeBoost;

      const reason = `Matched [${matched.join(', ')}] in ${item.type} from ${new Date(item.created_at).toLocaleDateString()}`;

      return {
        id: item.id,
        type: item.type as RecallResult['type'],
        title: item.title.slice(0, 200),
        detail: item.detail.slice(0, 400),
        score,
        created_at: item.created_at,
        reason,
      } satisfies RecallResult;
    })
    .filter((x): x is RecallResult => x !== null);

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Pro-tier: semantic (embedding) recall
// ---------------------------------------------------------------------------

/**
 * Semantic recall using vector similarity from a registered EmbeddingProvider.
 *
 * This function is only reachable when @memcode/pro registers an embedding
 * provider. The actual vector index and cosine similarity logic lives in the
 * Pro package (private). Here we define the contract and the fallback path.
 *
 * The Pro implementation:
 *   1. Embeds the query via the provider
 *   2. Queries the hosted vector index (HNSW or similar) for top-K neighbours
 *   3. Re-ranks by recency × type boost
 *   4. Returns RecallResult[] with semantic similarity scores
 */
async function semanticRecall(
  db: Database.Database,
  workspaceId: string,
  query: string,
  limit: number,
  provider: import('./providers').EmbeddingProvider,
): Promise<RecallResult[]> {
  // The embedding provider's `embed` call goes out to the Pro API.
  // If it fails, fall back to keyword recall silently.
  try {
    const [[queryVector]] = await Promise.all([provider.embed([query])]);
    // The Pro package attaches a `semanticSearch` method to the provider at
    // runtime. If it's not there (e.g. a custom embedding provider without
    // the Pro server), fall through to keyword.
    const proSearch = (provider as unknown as {
      semanticSearch?: (
        db: Database.Database,
        workspaceId: string,
        vector: number[],
        limit: number,
      ) => Promise<RecallResult[]>;
    }).semanticSearch;

    if (proSearch) {
      return proSearch(db, workspaceId, queryVector, limit);
    }
  } catch {
    // Graceful degradation — Pro feature unavailable, use keyword
  }
  return keywordRecall(db, workspaceId, query, limit);
}
