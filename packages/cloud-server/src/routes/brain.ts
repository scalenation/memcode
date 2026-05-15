import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/client';
import { authenticate } from '../middleware/authenticate';
import { requireActiveSubscription } from '../middleware/require-active-subscription';
import type { TokenPayload } from '../middleware/authenticate';
import {
  DEFAULT_OPENROUTER_MODEL,
  decryptSecret,
  completeWithOpenRouter,
} from '../openrouter';

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

type ProjectGroup = {
  projectId: string;
  projectName: string;
  workspaceIds: string[];
  machineNames: string[];
  workspaceCount: number;
  hasBrain: boolean;
  updatedAt: string | null;
  summary: string | null;
};

export async function brainRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/v1/brain/projects',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;
      const projects = await listProjectGroups(user.sub);
      return reply.send({ projects });
    },
  );

  fastify.get<{ Params: { projectId: string } }>(
    '/v1/brain/projects/:projectId',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Params: { projectId: string } }> & { user: TokenPayload }).user;
      const row = await latestProjectBrainRow(user.sub, request.params.projectId);
      if (!row) return reply.status(404).send({ error: 'Project brain not found' });
      return reply.send(row);
    },
  );

  fastify.get<{ Params: { projectId: string }; Querystring: { q?: string } }>(
    '/v1/brain/projects/:projectId/ask',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { q?: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Params: { projectId: string }; Querystring: { q?: string } }> & { user: TokenPayload }).user;
      const row = await latestProjectBrainRow(user.sub, request.params.projectId);
      if (!row) return reply.status(404).send({ error: 'Project brain not found' });
      const q = request.query.q?.trim();
      if (!q) return reply.status(400).send({ error: 'q query param is required' });
      return reply.send(await generateBrainAnswer(user.sub, row.brain, q, row.projectName));
    },
  );

  fastify.get<{ Params: { projectId: string }; Querystring: { type?: string } }>(
    '/v1/brain/projects/:projectId/report',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { type?: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Params: { projectId: string }; Querystring: { type?: string } }> & { user: TokenPayload }).user;
      const row = await latestProjectBrainRow(user.sub, request.params.projectId);
      if (!row) return reply.status(404).send({ error: 'Project brain not found' });
      const type = request.query.type ?? 'status';
      return reply.send({
        projectId: row.projectId,
        projectName: row.projectName,
        type,
        generatedAt: new Date().toISOString(),
        markdown: await generateBrainReport(user.sub, row.brain, type, row.projectName),
      });
    },
  );

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
      const answer = await generateBrainAnswer(user.sub, row.brain, q, row.workspaceId);
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
      const markdown = await generateBrainReport(user.sub, row.brain, type, row.workspaceId);
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

async function listProjectGroups(userId: string): Promise<ProjectGroup[]> {
  const workspaces = await listUserWorkspaces(userId);
  if (workspaces.length === 0) return [];

  const brainRows = await latestBrainRowsForWorkspaceIds(workspaces.map(workspace => workspace.id));
  const brainByWorkspaceId = new Map(brainRows.map(row => [row.workspaceId, row]));
  const grouped = new Map<string, typeof workspaces>();

  for (const workspace of workspaces) {
    const projectId = makeProjectId(workspace.name, workspace.id);
    if (!grouped.has(projectId)) grouped.set(projectId, []);
    grouped.get(projectId)?.push(workspace);
  }

  return [...grouped.entries()]
    .map(([projectId, projectWorkspaces]) => {
      const rows = projectWorkspaces
        .map(workspace => brainByWorkspaceId.get(workspace.id))
        .filter(Boolean) as BrainRow[];
      const aggregated = rows.length > 0 ? aggregateBrainRows(projectId, projectNameFor(projectWorkspaces), rows) : null;
      return {
        projectId,
        projectName: projectNameFor(projectWorkspaces),
        workspaceIds: projectWorkspaces.map(workspace => workspace.id),
        machineNames: uniqueStrings(projectWorkspaces.map(workspace => workspace.machine_name ?? 'Unknown device')),
        workspaceCount: projectWorkspaces.length,
        hasBrain: rows.length > 0,
        updatedAt: aggregated?.updatedAt ?? null,
        summary: aggregated?.brain.summary ?? null,
      };
    })
    .sort((a, b) => {
      if (a.hasBrain !== b.hasBrain) return a.hasBrain ? -1 : 1;
      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
    });
}

async function latestProjectBrainRow(
  userId: string,
  projectId: string,
): Promise<{ projectId: string; projectName: string; workspaceIds: string[]; machineNames: string[]; workspaceCount: number; cursor: string; updatedAt: string; brain: ProjectBrain; meta: BrainMetaEntry[] } | null> {
  const workspaces = await listUserWorkspaces(userId);
  const projectWorkspaces = workspaces.filter(workspace => makeProjectId(workspace.name, workspace.id) === projectId);
  if (projectWorkspaces.length === 0) return null;

  const rows = await latestBrainRowsForWorkspaceIds(projectWorkspaces.map(workspace => workspace.id));
  if (rows.length === 0) return null;

  const aggregated = aggregateBrainRows(projectId, projectNameFor(projectWorkspaces), rows);
  return {
    projectId,
    projectName: projectNameFor(projectWorkspaces),
    workspaceIds: projectWorkspaces.map(workspace => workspace.id),
    machineNames: uniqueStrings(projectWorkspaces.map(workspace => workspace.machine_name ?? 'Unknown device')),
    workspaceCount: projectWorkspaces.length,
    cursor: aggregated.cursor,
    updatedAt: aggregated.updatedAt,
    brain: aggregated.brain,
    meta: aggregated.meta,
  };
}

async function listUserWorkspaces(userId: string): Promise<Array<{ id: string; name: string | null; machine_name: string | null; created_at: string }>> {
  const result = await pool.query(
    `SELECT id, name, machine_name, created_at
     FROM workspaces
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows as Array<{ id: string; name: string | null; machine_name: string | null; created_at: string }>;
}

function aggregateBrainRows(
  projectId: string,
  projectName: string,
  rows: BrainRow[],
): BrainRow {
  if (rows.length === 1) {
    return {
      ...rows[0],
      brain: {
        ...rows[0].brain,
        workspaceId: projectName,
      },
    };
  }

  const sorted = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const mergedBrain = compactBrain(mergeBrains(projectName || projectId, sorted.map(row => row.brain)));
  return {
    workspaceId: projectId,
    cursor: sorted[0].cursor,
    updatedAt: sorted[0].updatedAt,
    brain: {
      ...mergedBrain,
      workspaceId: projectName,
    },
    meta: compactMeta(sorted.flatMap(row => row.meta), mergedBrain),
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

async function generateBrainAnswer(
  userId: string,
  brain: ProjectBrain,
  question: string,
  projectName: string,
): Promise<{ answer: string; evidence: Array<{ kind: string; title: string; snippet: string }> }> {
  const fallback = answerFromBrain(brain, question);
  const settings = await loadUserAiSettings(userId);
  if (!settings.apiKey) return fallback;

  try {
    const answer = await completeWithOpenRouter({
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt: 'You answer questions about a software project using only the provided project brain context. Be concise, grounded, and explicit when the context is incomplete.',
      userPrompt: [
        `Project: ${projectName}`,
        `Question: ${question}`,
        '',
        buildBrainContext(brain),
      ].join('\n'),
      temperature: 0.2,
    });
    return { ...fallback, answer };
  } catch {
    return fallback;
  }
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

async function generateBrainReport(
  userId: string,
  brain: ProjectBrain,
  type: string,
  projectName: string,
): Promise<string> {
  const fallback = renderReport(brain, type);
  const settings = await loadUserAiSettings(userId);
  if (!settings.apiKey) return fallback;

  try {
    return await completeWithOpenRouter({
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt: 'You generate practical markdown reports for engineering projects. Use only the provided project brain context. Do not invent progress, metrics, or roadmap items.',
      userPrompt: [
        `Project: ${projectName}`,
        `Requested report type: ${type}`,
        '',
        'Return markdown only.',
        '',
        buildBrainContext(brain),
      ].join('\n'),
      temperature: 0.3,
    });
  } catch {
    return fallback;
  }
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

function makeProjectId(name: string | null | undefined, workspaceId: string): string {
  return name && name.trim() ? `name:${normalizeKey(name)}` : `workspace:${workspaceId}`;
}

function projectNameFor(workspaces: Array<{ id: string; name: string | null }>): string {
  return workspaces[0]?.name?.trim() || workspaces[0]?.id || 'Unnamed project';
}

async function loadUserAiSettings(userId: string): Promise<{ apiKey: string | null; model: string }> {
  const result = await pool.query(
    'SELECT openrouter_api_key_encrypted, openrouter_model FROM users WHERE id = $1',
    [userId],
  );
  const row = result.rows[0] as { openrouter_api_key_encrypted: string | null; openrouter_model: string | null } | undefined;
  if (!row?.openrouter_api_key_encrypted) {
    return { apiKey: null, model: row?.openrouter_model ?? DEFAULT_OPENROUTER_MODEL };
  }

  try {
    return {
      apiKey: decryptSecret(row.openrouter_api_key_encrypted),
      model: row.openrouter_model ?? DEFAULT_OPENROUTER_MODEL,
    };
  } catch {
    return { apiKey: null, model: row.openrouter_model ?? DEFAULT_OPENROUTER_MODEL };
  }
}

function buildBrainContext(brain: ProjectBrain): string {
  return [
    `Summary: ${brain.summary}`,
    `Stats: ${brain.stats.checkpointCount} checkpoints, ${brain.stats.decisionCount} decisions, ${brain.stats.taskCount} tasks, ${brain.stats.openTaskCount} open tasks.`,
    '',
    'Milestones:',
    ...brain.milestones.slice(0, 8).map(item => `- ${item.title}${item.detail ? ` — ${item.detail}` : ''}`),
    '',
    'Decisions:',
    ...brain.decisions.slice(0, 8).map(item => `- ${item.title}: ${item.rationale}`),
    '',
    'Tasks:',
    ...brain.tasks.slice(0, 10).map(item => `- [${item.status}] ${item.title}${item.description ? `: ${item.description}` : ''}`),
  ].join('\n');
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