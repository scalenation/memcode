import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/client';
import { authenticate } from '../middleware/authenticate';
import { requireActiveSubscription } from '../middleware/require-active-subscription';
import type { TokenPayload } from '../middleware/authenticate';

type BrainMilestone = {
  id: string;
  title: string;
  detail?: string;
  trigger?: string | null;
  branch?: string | null;
  gitSha?: string | null;
  createdAt: number;
};

type BrainDecision = {
  id: string;
  title: string;
  rationale: string;
  impact?: string;
  status: string;
  updatedAt: number;
};

type BrainTask = {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  updatedAt: number;
};

type ProjectBrain = {
  workspaceId: string;
  generatedAt: number;
  summary: string;
  milestones: BrainMilestone[];
  decisions: BrainDecision[];
  tasks: BrainTask[];
  stats: {
    checkpointCount: number;
    decisionCount: number;
    taskCount: number;
    openTaskCount: number;
    completedTaskCount: number;
  };
};

type BrainMetaEntry = {
  type?: string;
  id?: string;
  trigger?: string | null;
  branch?: string | null;
  git_sha?: string | null;
  summary?: string | null;
  created_at?: number;
};

type BrainRow = {
  workspaceId: string;
  cursor: string;
  updatedAt: string;
  brain: ProjectBrain;
  meta: BrainMetaEntry[];
};

export async function brainRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { workspaceId: string } }>(
    '/v1/brain/workspaces/:workspaceId',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest<{ Params: { workspaceId: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Params: { workspaceId: string } }> & { user: TokenPayload }).user;
      const row = await latestBrainRow(user.sub, request.params.workspaceId);
      if (!row) return reply.status(404).send({ error: 'Project brain not found' });
      return reply.send(row);
    },
  );

  fastify.get<{ Params: { workspaceId: string }; Querystring: { q?: string } }>(
    '/v1/brain/workspaces/:workspaceId/ask',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest<{ Params: { workspaceId: string }; Querystring: { q?: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Params: { workspaceId: string }; Querystring: { q?: string } }> & { user: TokenPayload }).user;
      const row = await latestBrainRow(user.sub, request.params.workspaceId);
      if (!row) return reply.status(404).send({ error: 'Project brain not found' });
      const q = request.query.q?.trim();
      if (!q) return reply.status(400).send({ error: 'q query param is required' });
      const answer = answerFromBrain(row.brain, q);
      return reply.send(answer);
    },
  );

  fastify.get<{ Params: { workspaceId: string }; Querystring: { type?: string } }>(
    '/v1/brain/workspaces/:workspaceId/report',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest<{ Params: { workspaceId: string }; Querystring: { type?: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Params: { workspaceId: string }; Querystring: { type?: string } }> & { user: TokenPayload }).user;
      const row = await latestBrainRow(user.sub, request.params.workspaceId);
      if (!row) return reply.status(404).send({ error: 'Project brain not found' });
      const type = request.query.type ?? 'status';
      const markdown = renderReport(row.brain, type);
      return reply.send({ workspaceId: row.workspaceId, type, generatedAt: new Date().toISOString(), markdown });
    },
  );

  fastify.post<{ Body: { targetWorkspaceId?: string; sourceWorkspaceIds?: string[] } }>(
    '/v1/admin/brain/merge-workspaces',
    async (request: FastifyRequest<{ Body: { targetWorkspaceId?: string; sourceWorkspaceIds?: string[] } }>, reply: FastifyReply) => {
      if (!hasAdminSecret(request)) return reply.status(401).send({ error: 'unauthorized' });

      const targetWorkspaceId = request.body?.targetWorkspaceId?.trim();
      const sourceWorkspaceIds = uniqueStrings(request.body?.sourceWorkspaceIds ?? []);
      if (!targetWorkspaceId || sourceWorkspaceIds.length === 0) {
        return reply.status(400).send({ error: 'targetWorkspaceId and at least one sourceWorkspaceId are required' });
      }
      if (sourceWorkspaceIds.includes(targetWorkspaceId)) {
        return reply.status(400).send({ error: 'target workspace cannot also be a source workspace' });
      }

      const workspaceRows = await pool.query<{ id: string; user_id: string }>(
        'SELECT id, user_id FROM workspaces WHERE id = ANY($1::text[])',
        [[targetWorkspaceId, ...sourceWorkspaceIds]],
      );
      if ((workspaceRows.rowCount ?? 0) !== sourceWorkspaceIds.length + 1) {
        return reply.status(404).send({ error: 'One or more workspaces were not found' });
      }

      const ownerIds = new Set(workspaceRows.rows.map(row => row.user_id));
      if (ownerIds.size !== 1) {
        return reply.status(400).send({ error: 'All workspaces must belong to the same user' });
      }

      const latestBlobCursor = await latestBlobCursorForWorkspace(targetWorkspaceId);
      if (!latestBlobCursor) {
        return reply.status(404).send({ error: 'Target workspace has no sync blobs to update' });
      }

      const rows = await latestBrainRowsForWorkspaceIds([targetWorkspaceId, ...sourceWorkspaceIds]);
      const sourceRows = rows.filter(row => sourceWorkspaceIds.includes(row.workspaceId));
      if (sourceRows.length !== sourceWorkspaceIds.length) {
        return reply.status(404).send({ error: 'Each source workspace must have a stored project brain before merge' });
      }

      const mergedBrain = compactBrain(mergeBrains(targetWorkspaceId, rows.map(row => row.brain)));
      const mergedMeta = compactMeta(rows.flatMap(row => row.meta), mergedBrain);

      const mergeResult = await pool.query(
        `WITH updated AS (
           UPDATE sync_blobs
           SET brain = $1, meta = $2
           WHERE workspace_id = $3 AND cursor = $4
           RETURNING cursor
         )
         DELETE FROM workspaces
         WHERE id = ANY($5::text[])
           AND EXISTS (SELECT 1 FROM updated)`,
        [mergedBrain, mergedMeta, targetWorkspaceId, latestBlobCursor, sourceWorkspaceIds],
      );
      if ((mergeResult.rowCount ?? 0) !== sourceWorkspaceIds.length) {
        return reply.status(409).send({ error: 'Target workspace changed during merge. Retry the merge.' });
      }

      return reply.send({
        ok: true,
        targetWorkspaceId,
        deletedWorkspaceIds: sourceWorkspaceIds,
        mergedStats: mergedBrain.stats,
      });
    },
  );

  fastify.post<{ Querystring: { workspaceId?: string } }>(
    '/v1/admin/brain/compact',
    async (request: FastifyRequest<{ Querystring: { workspaceId?: string } }>, reply: FastifyReply) => {
      if (!hasAdminSecret(request) && !isCronRequest(request)) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const workspaceId = request.query.workspaceId?.trim();
      const rows = await latestBrainRowsForCompaction(workspaceId);
      let updated = 0;

      for (const row of rows) {
        const nextBrain = compactBrain(row.brain);
        const nextMeta = compactMeta(row.meta, nextBrain);
        if (JSON.stringify(nextBrain) === JSON.stringify(row.brain) && JSON.stringify(nextMeta) === JSON.stringify(row.meta)) {
          continue;
        }

        await pool.query(
          'UPDATE sync_blobs SET brain = $1, meta = $2 WHERE workspace_id = $3 AND cursor = $4',
          [nextBrain, nextMeta, row.workspaceId, row.cursor],
        );
        updated++;
      }

      return reply.send({
        ok: true,
        scannedWorkspaces: rows.length,
        compactedWorkspaces: updated,
        trigger: hasAdminSecret(request) ? 'admin' : 'cron',
      });
    },
  );
}

async function latestBrainRow(userId: string, workspaceId: string): Promise<BrainRow | null> {
  const result = await pool.query(
    `SELECT b.cursor, b.created_at, b.brain, b.meta
     FROM sync_blobs b
     INNER JOIN workspaces w ON w.id = b.workspace_id
     WHERE w.user_id = $1 AND b.workspace_id = $2 AND b.brain IS NOT NULL
     ORDER BY b.cursor DESC
     LIMIT 1`,
    [userId, workspaceId],
  );
  if ((result.rowCount ?? 0) === 0) return null;
  const row = result.rows[0] as { cursor: string; created_at: string; brain: ProjectBrain; meta: BrainMetaEntry[] | null };
  return {
    workspaceId,
    cursor: row.cursor,
    updatedAt: row.created_at,
    brain: row.brain,
    meta: normalizeMeta(row.meta),
  };
}

async function latestBrainRowsForWorkspaceIds(workspaceIds: string[]): Promise<BrainRow[]> {
  const result = await pool.query(
    `SELECT DISTINCT ON (b.workspace_id) b.workspace_id, b.cursor, b.created_at, b.brain, b.meta
     FROM sync_blobs b
     WHERE b.workspace_id = ANY($1::text[]) AND b.brain IS NOT NULL
     ORDER BY b.workspace_id, b.cursor DESC`,
    [workspaceIds],
  );
  return result.rows.map(row => ({
    workspaceId: row.workspace_id as string,
    cursor: row.cursor as string,
    updatedAt: row.created_at as string,
    brain: row.brain as ProjectBrain,
    meta: normalizeMeta(row.meta as BrainMetaEntry[] | null),
  }));
}

async function latestBrainRowsForCompaction(workspaceId?: string): Promise<BrainRow[]> {
  if (workspaceId) return latestBrainRowsForWorkspaceIds([workspaceId]);
  const result = await pool.query(
    `SELECT DISTINCT ON (b.workspace_id) b.workspace_id, b.cursor, b.created_at, b.brain, b.meta
     FROM sync_blobs b
     WHERE b.brain IS NOT NULL
     ORDER BY b.workspace_id, b.cursor DESC`,
  );
  return result.rows.map(row => ({
    workspaceId: row.workspace_id as string,
    cursor: row.cursor as string,
    updatedAt: row.created_at as string,
    brain: row.brain as ProjectBrain,
    meta: normalizeMeta(row.meta as BrainMetaEntry[] | null),
  }));
}

async function latestBlobCursorForWorkspace(workspaceId: string): Promise<string | null> {
  const result = await pool.query(
    'SELECT cursor FROM sync_blobs WHERE workspace_id = $1 ORDER BY cursor DESC LIMIT 1',
    [workspaceId],
  );
  if ((result.rowCount ?? 0) === 0) return null;
  return result.rows[0].cursor as string;
}

function answerFromBrain(brain: ProjectBrain, question: string): { answer: string; evidence: Array<{ kind: string; title: string; snippet: string }> } {
  const terms = tokenize(question);
  const evidence = [
    ...brain.milestones.map(item => ({ kind: 'milestone', title: item.title, snippet: item.detail ?? item.title })),
    ...brain.decisions.map(item => ({ kind: 'decision', title: item.title, snippet: item.rationale })),
    ...brain.tasks.map(item => ({ kind: 'task', title: item.title, snippet: item.description ?? item.title })),
  ]
    .map(item => ({ ...item, score: scoreText(`${item.title} ${item.snippet}`, terms) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ kind, title, snippet }) => ({ kind, title, snippet }));

  const answerParts = [brain.summary];
  if (evidence.length > 0) {
    answerParts.push(`Most relevant context: ${evidence.map(item => `${item.kind} “${item.title}”`).join('; ')}.`);
  }
  if (brain.tasks.length > 0) {
    const openTasks = brain.tasks.filter(task => isOpenTask(task.status)).slice(0, 3);
    if (openTasks.length > 0) answerParts.push(`Current active work: ${openTasks.map(task => task.title).join('; ')}.`);
  }

  return {
    answer: answerParts.join(' '),
    evidence,
  };
}

function renderReport(brain: ProjectBrain, type: string): string {
  if (type === 'slides') {
    return [
      `# ${brain.workspaceId} Slide Outline`,
      '',
      '## 1. Executive Summary',
      `- ${brain.summary}`,
      '',
      '## 2. Milestones',
      ...brain.milestones.slice(0, 5).map(item => `- ${item.title}`),
      '',
      '## 3. Decisions',
      ...brain.decisions.slice(0, 5).map(item => `- ${item.title}: ${item.rationale}`),
      '',
      '## 4. Current Focus',
      ...brain.tasks.filter(task => isOpenTask(task.status)).slice(0, 5).map(task => `- ${task.title}`),
    ].join('\n');
  }
  if (type === 'business-plan') {
    return [
      '# Business Plan Draft',
      '',
      '## Executive Summary',
      brain.summary,
      '',
      '## Product Milestones',
      ...brain.milestones.slice(0, 6).map(item => `- ${item.title}`),
      '',
      '## Strategic Decisions',
      ...brain.decisions.slice(0, 6).map(item => `- ${item.title}: ${item.rationale}`),
      '',
      '## Delivery Roadmap',
      ...brain.tasks.slice(0, 8).map(task => `- [${task.status}] ${task.title}`),
    ].join('\n');
  }
  return [
    '# Project Status',
    '',
    '## Summary',
    brain.summary,
    '',
    '## Current Focus',
    ...brain.tasks.filter(task => isOpenTask(task.status)).slice(0, 6).map(task => `- [${task.status}] ${task.title}`),
    '',
    '## Recent Milestones',
    ...brain.milestones.slice(0, 6).map(item => `- ${item.title}`),
    '',
    '## Key Decisions',
    ...brain.decisions.slice(0, 6).map(item => `- ${item.title}`),
  ].join('\n');
}

function compactBrain(brain: ProjectBrain): ProjectBrain {
  const milestones = dedupeBy(
    [...brain.milestones]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(item => ({
        ...item,
        title: compactText(item.title, item.title, 160),
        detail: compactText(item.detail, item.title, 280),
      }))
      .slice(0, 12),
    item => `${normalizeKey(item.title)}|${item.branch ?? ''}|${item.trigger ?? ''}`,
  );

  const decisions = dedupeBy(
    [...brain.decisions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(item => ({
        ...item,
        title: compactText(item.title, item.title, 160),
        rationale: compactText(item.rationale, item.title, 280),
        impact: item.impact ? compactText(item.impact, item.impact, 180) : item.impact,
      }))
      .slice(0, 12),
    item => normalizeKey(item.title),
  );

  const tasks = dedupeBy(
    [...brain.tasks]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(item => ({
        ...item,
        title: compactText(item.title, item.title, 160),
        description: item.description ? compactText(item.description, item.title, 220) : item.description,
      }))
      .slice(0, 20),
    item => `${normalizeKey(item.title)}|${item.status}`,
  );

  const openTasks = tasks.filter(task => isOpenTask(task.status));
  const completedTasks = tasks.filter(task => task.status === 'done');

  return {
    workspaceId: brain.workspaceId,
    generatedAt: Date.now(),
    summary: buildSummary(milestones, decisions, openTasks),
    milestones,
    decisions,
    tasks,
    stats: {
      checkpointCount: brain.stats.checkpointCount,
      decisionCount: brain.stats.decisionCount,
      taskCount: brain.stats.taskCount,
      openTaskCount: brain.stats.openTaskCount || openTasks.length,
      completedTaskCount: brain.stats.completedTaskCount || completedTasks.length,
    },
  };
}

function mergeBrains(targetWorkspaceId: string, brains: ProjectBrain[]): ProjectBrain {
  const merged = compactBrain({
    workspaceId: targetWorkspaceId,
    generatedAt: Date.now(),
    summary: '',
    milestones: brains.flatMap(brain => brain.milestones),
    decisions: brains.flatMap(brain => brain.decisions),
    tasks: brains.flatMap(brain => brain.tasks),
    stats: {
      checkpointCount: brains.reduce((sum, brain) => sum + (brain.stats.checkpointCount || 0), 0),
      decisionCount: brains.reduce((sum, brain) => sum + (brain.stats.decisionCount || 0), 0),
      taskCount: brains.reduce((sum, brain) => sum + (brain.stats.taskCount || 0), 0),
      openTaskCount: brains.reduce((sum, brain) => sum + (brain.stats.openTaskCount || 0), 0),
      completedTaskCount: brains.reduce((sum, brain) => sum + (brain.stats.completedTaskCount || 0), 0),
    },
  });

  return {
    ...merged,
    workspaceId: targetWorkspaceId,
  };
}

function compactMeta(meta: BrainMetaEntry[], brain: ProjectBrain): BrainMetaEntry[] {
  const normalized = meta
    .map(entry => ({
      type: entry.type ?? 'milestone',
      id: entry.id,
      trigger: entry.trigger ?? null,
      branch: entry.branch ?? null,
      git_sha: entry.git_sha ?? null,
      summary: entry.summary ? compactText(entry.summary, entry.summary, 160) : null,
      created_at: typeof entry.created_at === 'number' ? entry.created_at : 0,
    }))
    .filter(entry => entry.summary && entry.created_at > 0);

  const milestoneEntries = brain.milestones.map(item => ({
    type: 'milestone',
    id: item.id,
    trigger: item.trigger ?? null,
    branch: item.branch ?? null,
    git_sha: item.gitSha ?? null,
    summary: item.title,
    created_at: item.createdAt,
  }));

  return dedupeBy(
    [...normalized, ...milestoneEntries]
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
      .slice(0, 50),
    entry => `${entry.type}|${entry.id ?? ''}|${normalizeKey(entry.summary ?? '')}|${entry.created_at ?? 0}`,
  );
}

function buildSummary(milestones: BrainMilestone[], decisions: BrainDecision[], openTasks: BrainTask[]): string {
  const parts = [milestones[0]?.title || 'No checkpoints recorded yet.'];
  if (decisions.length > 0) {
    parts.push(`Recent decisions: ${decisions.slice(0, 3).map(item => item.title).join('; ')}.`);
  }
  if (openTasks.length > 0) {
    parts.push(`Current focus: ${openTasks.slice(0, 4).map(item => item.title).join('; ')}.`);
  }
  return parts.join(' ');
}

function normalizeMeta(meta: BrainMetaEntry[] | null | undefined): BrainMetaEntry[] {
  return Array.isArray(meta) ? meta : [];
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 3);
}

function scoreText(text: string, terms: string[]): number {
  const haystack = text.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function isOpenTask(status: string): boolean {
  return status !== 'done' && status !== 'cancelled';
}

function compactText(text: string | undefined, fallback: string, maxLength: number): string {
  const raw = (text ?? '').split('\n').map(line => line.trim()).filter(Boolean).join(' ').trim();
  if (!raw) return fallback;
  if (/^(trigger:|branch:|commit:|changed files|stats:)/i.test(raw)) return fallback;
  if (/files changed|\s\|\s|packages\//i.test(raw)) return fallback;
  return raw.length <= maxLength ? raw : `${raw.slice(0, maxLength - 3)}...`;
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function hasAdminSecret(request: FastifyRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return false;
  return headerValue(request.headers['x-admin-secret']) === adminSecret;
}

function isCronRequest(request: FastifyRequest): boolean {
  const userAgent = headerValue(request.headers['user-agent']) ?? '';
  const cronHeader = headerValue(request.headers['x-vercel-cron']);
  return /vercel-cron\//i.test(userAgent) || cronHeader === '1';
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}