/**
 * Model router — policy-driven routing of agent tasks to appropriate model tiers.
 *
 * Prevents burning frontier-model quota on trivial edits and explains routing
 * decisions so developers understand cost tradeoffs.
 */

export type ModelTier = 'small' | 'mid' | 'frontier';

export interface ModelRoute {
  pattern: string;
  tier: ModelTier;
  model?: string;
  reason: string;
}

export interface RoutingResult {
  tier: ModelTier;
  model: string;
  reason: string;
  matchedPattern: string;
}

// ── Default routing rules ─────────────────────────────────────────────────────
// Ordered: first match wins.
const DEFAULT_ROUTES: ModelRoute[] = [
  {
    pattern: 'rename|typo|format|style|lint|prettier|whitespace|comment|docstring',
    tier: 'small',
    reason: 'Cosmetic/formatting — fast small model sufficient',
  },
  {
    pattern: 'regex|replace|find.*replace|sed|awk',
    tier: 'small',
    reason: 'Simple text transformation — small model sufficient',
  },
  {
    pattern: 'unit test|test coverage|add test|mock|stub|fixture',
    tier: 'mid',
    reason: 'Test generation — mid-tier has enough code understanding',
  },
  {
    pattern: 'fix bug|debug|error|exception|failing test|traceback|stack trace',
    tier: 'mid',
    reason: 'Bug fix — mid-tier for most issues, escalates automatically if multi-file',
  },
  {
    pattern: 'api|endpoint|route|controller|handler|middleware',
    tier: 'mid',
    reason: 'API plumbing — mid-tier covers standard patterns',
  },
  {
    pattern: 'architect|design|system design|data model|schema design|ADR|decision',
    tier: 'frontier',
    reason: 'Architecture decision — requires strong reasoning model',
  },
  {
    pattern: 'migrate|migration|refactor|restructure|rewrite|overhaul',
    tier: 'frontier',
    reason: 'Multi-file structural change — frontier model reduces cascading errors',
  },
  {
    pattern: 'auth|security|encrypt|permission|rbac|oauth|jwt|credential',
    tier: 'frontier',
    reason: 'Security-critical — use strongest available model',
  },
  {
    pattern: 'deploy|ci|cd|pipeline|infra|terraform|docker|kubernetes|helm',
    tier: 'frontier',
    reason: 'Production infrastructure — high-consequence changes need best reasoning',
  },
];

// ── Default models per tier ───────────────────────────────────────────────────
const DEFAULT_MODELS: Record<ModelTier, string> = {
  small: 'google/gemini-2.0-flash-lite',
  mid: 'google/gemini-2.5-flash-preview',
  frontier: 'google/gemini-2.5-pro-preview',
};

// ── Router ────────────────────────────────────────────────────────────────────

export interface RouterConfig {
  routes?: ModelRoute[];
  models?: Partial<Record<ModelTier, string>>;
  defaultTier?: ModelTier;
}

export class ModelRouter {
  private routes: ModelRoute[];
  private models: Record<ModelTier, string>;
  private defaultTier: ModelTier;

  constructor(config: RouterConfig = {}) {
    this.routes = [...(config.routes ?? []), ...DEFAULT_ROUTES];
    this.models = { ...DEFAULT_MODELS, ...config.models };
    this.defaultTier = config.defaultTier ?? 'mid';
  }

  /**
   * Route a task description to the appropriate model.
   * Returns the tier, model ID, and human-readable reason.
   */
  route(taskDescription: string, context: { fileCount?: number; touchesAuth?: boolean; touchesInfra?: boolean } = {}): RoutingResult {
    const lower = taskDescription.toLowerCase();

    // Context escalation overrides
    if (context.touchesAuth || context.touchesInfra) {
      return {
        tier: 'frontier',
        model: this.models.frontier,
        reason: 'Escalated to frontier: task touches security or infrastructure',
        matchedPattern: 'context.escalation',
      };
    }
    if ((context.fileCount ?? 0) >= 10) {
      return {
        tier: 'frontier',
        model: this.models.frontier,
        reason: `Escalated to frontier: ${context.fileCount} files in scope exceeds threshold`,
        matchedPattern: 'context.fileCount',
      };
    }

    for (const route of this.routes) {
      const re = new RegExp(route.pattern, 'i');
      if (re.test(lower)) {
        return {
          tier: route.tier,
          model: route.model ?? this.models[route.tier],
          reason: route.reason,
          matchedPattern: route.pattern,
        };
      }
    }

    return {
      tier: this.defaultTier,
      model: this.models[this.defaultTier],
      reason: 'No specific pattern matched — using default tier',
      matchedPattern: 'default',
    };
  }

  /**
   * Explain routing for a task without executing it.
   */
  explain(taskDescription: string, context?: Parameters<ModelRouter['route']>[1]): string {
    const result = this.route(taskDescription, context);
    return [
      `Task   : ${taskDescription}`,
      `Tier   : ${result.tier}`,
      `Model  : ${result.model}`,
      `Reason : ${result.reason}`,
      `Pattern: ${result.matchedPattern}`,
    ].join('\n');
  }
}

export const defaultRouter = new ModelRouter();
