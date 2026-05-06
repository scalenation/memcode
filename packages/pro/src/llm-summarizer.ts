import type { SummarizerProvider } from '@memcode/core';
import type { GitInfo } from '@memcode/core';

const MAX_SHORT = 300;
const MAX_LONG = 1500;

/**
 * LLMSummarizer — Pro-tier SummarizerProvider.
 *
 * Sends git metadata and staged diff context to the MemCode Pro API, which
 * runs an LLM pipeline to generate:
 *   - Short summaries that describe INTENT ("Refactored auth to use JWT
 *     refresh tokens, removing the legacy session store")
 *   - Long summaries that link to prior related decisions and flag
 *     contradictions ("Note: this reverses decision D-3a2b from 2 months ago")
 *
 * The LLM pipeline, prompt engineering, and evals are proprietary and run
 * server-side. The client only sends metadata — no raw source code.
 *
 * PROPRIETARY — do not open-source.
 */
export class LLMSummarizer implements SummarizerProvider {
  readonly name = 'llm-summarizer';

  constructor(
    private readonly apiEndpoint: string,
    private readonly apiToken: string,
    private readonly workspaceId: string,
  ) {}

  async generateShort(gitInfo: GitInfo, trigger: string, note?: string): Promise<string> {
    try {
      const response = await fetch(`${this.apiEndpoint}/v1/summarize/short`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiToken}`,
        },
        body: JSON.stringify({ gitInfo, trigger, note, workspaceId: this.workspaceId }),
      });

      if (!response.ok) throw new Error(`API ${response.status}`);
      const { summary } = await response.json() as { summary: string };
      return summary.slice(0, MAX_SHORT);
    } catch {
      // Graceful degradation to deterministic fallback
      const { generateShortSummary } = await import('@memcode/core');
      return generateShortSummary(gitInfo, trigger, note);
    }
  }

  async generateLong(gitInfo: GitInfo, trigger: string, note?: string): Promise<string> {
    try {
      const response = await fetch(`${this.apiEndpoint}/v1/summarize/long`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiToken}`,
        },
        body: JSON.stringify({ gitInfo, trigger, note, workspaceId: this.workspaceId }),
      });

      if (!response.ok) throw new Error(`API ${response.status}`);
      const { summary } = await response.json() as { summary: string };
      return summary.slice(0, MAX_LONG);
    } catch {
      const { generateLongSummary } = await import('@memcode/core');
      return generateLongSummary(gitInfo, trigger, note);
    }
  }
}
