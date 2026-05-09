import { registry } from './providers';

/**
 * Feature gates for Pro-tier capabilities.
 *
 * The gate checks are intentionally cheap (registry look-ups, no I/O) so they
 * can be called in the hot path of every command.
 *
 * Free tier:  deterministic summarizer, keyword recall, local-only
 * Pro tier:   LLM summarizer, semantic recall, cloud sync, cross-project
 *             insights, team memory — all gated below
 *
 * How Pro is activated at runtime:
 *   1. User has a Pro subscription and has run `memory sync auth`.
 *   2. The Pro client package (@memcode/pro, private npm) is installed
 *      alongside @memcode/cli.
 *   3. It registers providers into the shared ProviderRegistry singleton
 *      before any command runs, via a CLI plugin hook.
 *
 * The OSS repo never contains or imports @memcode/pro. The proprietary code
 * lives in a private repository and is distributed via a private npm registry.
 */

export type FeatureFlag =
  | 'llm-summarizer'
  | 'semantic-recall'
  | 'cloud-sync'
  | 'cross-project-memory'
  | 'proactive-insights'
  | 'team-memory';

const FLAG_CHECKS: Record<FeatureFlag, () => boolean> = {
  'llm-summarizer':        () => !!registry.getSummarizer(),
  'semantic-recall':       () => !!registry.getEmbedding(),
  'cloud-sync':            () => !!process.env.MEMCODE_CLOUD_ENABLED,
  'cross-project-memory':  () => !!registry.getInsight(),
  'proactive-insights':    () => !!registry.getInsight(),
  'team-memory':           () => !!process.env.MEMCODE_TEAM_ENABLED,
};

/**
 * Return true if a Pro feature is available in the current process.
 */
export function isEnabled(flag: FeatureFlag): boolean {
  return FLAG_CHECKS[flag]?.() ?? false;
}

/**
 * Assert a Pro feature is available; throw a user-friendly error if not.
 */
export function requireFeature(flag: FeatureFlag): void {
  if (!isEnabled(flag)) {
    throw new ProFeatureError(flag);
  }
}

export class ProFeatureError extends Error {
  constructor(public readonly flag: FeatureFlag) {
    const descriptions: Record<FeatureFlag, string> = {
      'llm-summarizer':        'Intelligent LLM-powered summaries',
      'semantic-recall':       'Semantic (embedding-based) recall',
      'cloud-sync':            'Multi-device cloud sync',
      'cross-project-memory':  'Cross-project memory graph',
      'proactive-insights':    'Proactive contradiction and pattern detection',
      'team-memory':           'Shared team memory spaces',
    };
    super(
      `"${descriptions[flag]}" is a Pro feature.\n` +
      `Upgrade at https://memcode.pro/pricing or run 'memory sync auth' after subscribing.`,
    );
    this.name = 'ProFeatureError';
  }
}
