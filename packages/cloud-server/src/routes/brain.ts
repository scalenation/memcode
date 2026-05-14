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
}

async function latestBrainRow(userId: string, workspaceId: string): Promise<{ workspaceId: string; cursor: string; updatedAt: string; brain: ProjectBrain } | null> {
  const result = await pool.query(
    `SELECT b.cursor, b.created_at, b.brain
     FROM sync_blobs b
     INNER JOIN workspaces w ON w.id = b.workspace_id
     WHERE w.user_id = $1 AND b.workspace_id = $2 AND b.brain IS NOT NULL
     ORDER BY b.cursor DESC
     LIMIT 1`,
    [userId, workspaceId],
  );
  if ((result.rowCount ?? 0) === 0) return null;
  const row = result.rows[0] as { cursor: string; created_at: string; brain: ProjectBrain };
  return {
    workspaceId,
    cursor: row.cursor,
    updatedAt: row.created_at,
    brain: row.brain,
  };
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
    const openTasks = brain.tasks.filter(task => task.status !== 'done' && task.status !== 'cancelled').slice(0, 3);
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
      ...brain.tasks.filter(task => task.status !== 'done' && task.status !== 'cancelled').slice(0, 5).map(task => `- ${task.title}`),
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
    ...brain.tasks.filter(task => task.status !== 'done' && task.status !== 'cancelled').slice(0, 6).map(task => `- [${task.status}] ${task.title}`),
    '',
    '## Recent Milestones',
    ...brain.milestones.slice(0, 6).map(item => `- ${item.title}`),
    '',
    '## Key Decisions',
    ...brain.decisions.slice(0, 6).map(item => `- ${item.title}`),
  ].join('\n');
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 3);
}

function scoreText(text: string, terms: string[]): number {
  const haystack = text.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}