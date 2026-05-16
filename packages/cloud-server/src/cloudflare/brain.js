import {
  DEFAULT_OPENROUTER_MODEL,
  decryptSecret,
  completeWithOpenRouter,
  fetchOpenRouterKeyInfo,
} from './openrouter.js';

const BRAIN_CATEGORIES = ['decision', 'bugfix', 'feature', 'discovery'];

export async function listProjectGroups(db, userId) {
  const workspaces = await listUserWorkspaces(db, userId);
  if (workspaces.length === 0) return [];

  const brainRows = await latestBrainRowsForWorkspaceIds(db, workspaces.map((workspace) => workspace.id));
  const brainByWorkspaceId = new Map(brainRows.map((row) => [row.workspaceId, row]));
  const grouped = new Map();

  for (const workspace of workspaces) {
    const projectId = makeProjectId(workspace.name, workspace.id);
    if (!grouped.has(projectId)) grouped.set(projectId, []);
    grouped.get(projectId).push(workspace);
  }

  return [...grouped.entries()]
    .map(([projectId, projectWorkspaces]) => {
      const rows = projectWorkspaces
        .map((workspace) => brainByWorkspaceId.get(workspace.id))
        .filter(Boolean);
      const aggregated = rows.length > 0 ? aggregateBrainRows(projectId, projectNameFor(projectWorkspaces), rows) : null;
      return {
        projectId,
        projectName: projectNameFor(projectWorkspaces),
        workspaceIds: projectWorkspaces.map((workspace) => workspace.id),
        machineNames: uniqueStrings(projectWorkspaces.map((workspace) => workspace.machine_name ?? 'Unknown device')),
        workspaceCount: projectWorkspaces.length,
        hasBrain: rows.length > 0,
        updatedAt: aggregated?.updatedAt ?? null,
        summary: aggregated?.brain.summary ?? null,
      };
    })
    .sort((a, b) => {
      if (a.hasBrain !== b.hasBrain) return a.hasBrain ? -1 : 1;
      return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
    });
}

export async function latestProjectBrainRow(db, userId, projectId) {
  const workspaces = await listUserWorkspaces(db, userId);
  const projectWorkspaces = workspaces.filter((workspace) => makeProjectId(workspace.name, workspace.id) === projectId);
  if (projectWorkspaces.length === 0) return null;

  const rows = await latestBrainRowsForWorkspaceIds(db, projectWorkspaces.map((workspace) => workspace.id));
  if (rows.length === 0) return null;

  const aggregated = aggregateBrainRows(projectId, projectNameFor(projectWorkspaces), rows);
  return {
    projectId,
    projectName: projectNameFor(projectWorkspaces),
    workspaceIds: projectWorkspaces.map((workspace) => workspace.id),
    machineNames: uniqueStrings(projectWorkspaces.map((workspace) => workspace.machine_name ?? 'Unknown device')),
    workspaceCount: projectWorkspaces.length,
    cursor: aggregated.cursor,
    updatedAt: aggregated.updatedAt,
    brain: aggregated.brain,
    meta: aggregated.meta,
  };
}

export async function latestBrainRow(db, userId, workspaceId) {
  const row = await db.first(
    `SELECT b.cursor, b.created_at, b.brain, b.meta
     FROM sync_blobs b
     INNER JOIN workspaces w ON w.id = b.workspace_id
     WHERE w.user_id = ? AND b.workspace_id = ? AND b.brain IS NOT NULL
     ORDER BY b.cursor DESC
     LIMIT 1`,
    [userId, workspaceId],
  );
  if (!row) return null;
  const brain = decorateBrain(parseJson(row.brain));
  return {
    workspaceId,
    cursor: row.cursor,
    updatedAt: toIsoString(row.created_at),
    brain,
    meta: normalizeMeta(parseJson(row.meta)),
  };
}

export async function generateBrainAnswer(env, db, userId, brain, question, projectName, projectId = null) {
  const fallback = answerFromBrain(brain, question);
  const settings = await loadUserAiSettings(db, env, userId);
  if (!settings.apiKey) return fallback;

  try {
    const startedAt = Date.now();
    const result = await completeWithOpenRouter(env, {
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt: 'You answer questions about a software project using only the provided project brain context. Be concise, grounded, and explicit when the context is incomplete.',
      userPrompt: [`Project: ${projectName}`, `Question: ${question}`, '', buildBrainContext(brain)].join('\n'),
      temperature: 0.2,
    });
    await recordAiUsageEvent(db, {
      userId,
      projectId,
      category: pickUsageCategory(brain, question),
      operation: 'ask',
      reportType: null,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      responseMs: Date.now() - startedAt,
      metadata: { questionLength: question.length },
    });
    return { ...fallback, answer: result.text };
  } catch {
    return fallback;
  }
}

export async function generateBrainReport(env, db, userId, brain, type, projectName, projectId = null) {
  const fallback = renderReport(brain, type);
  const settings = await loadUserAiSettings(db, env, userId);
  if (!settings.apiKey) return fallback;

  try {
    const startedAt = Date.now();
    const result = await completeWithOpenRouter(env, {
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt: 'You generate practical markdown reports for engineering projects. Use only the provided project brain context. Do not invent progress, metrics, or roadmap items.',
      userPrompt: [`Project: ${projectName}`, `Requested report type: ${type}`, '', 'Return markdown only.', '', buildBrainContext(brain)].join('\n'),
      temperature: 0.3,
    });
    await recordAiUsageEvent(db, {
      userId,
      projectId,
      category: dominantCategory(brain),
      operation: 'report',
      reportType: type,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      responseMs: Date.now() - startedAt,
      metadata: { reportType: type },
    });
    return result.text;
  } catch {
    return fallback;
  }
}

export async function loadAiDashboardUsage(db, env, userId, projectId = null) {
  const settings = await loadUserAiSettings(db, env, userId);
  const filters = [userId];
  let projectFilterSql = '';
  if (projectId) {
    projectFilterSql = ' AND project_id = ?';
    filters.push(projectId);
  }

  const summaryRow = await db.first(
    `SELECT
       COUNT(*) AS request_count,
       COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
       COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(credits_used), 0) AS credits_used
     FROM ai_usage_events
     WHERE user_id = ?${projectFilterSql}`,
    filters,
  );

  const categoryRows = await db.all(
    `SELECT
       category,
       COUNT(*) AS request_count,
       COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
       COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(credits_used), 0) AS credits_used
     FROM ai_usage_events
     WHERE user_id = ?${projectFilterSql}
     GROUP BY category
     ORDER BY total_tokens DESC, category ASC`,
    filters,
  );

  const operationRows = await db.all(
    `SELECT operation, COUNT(*) AS request_count, COALESCE(SUM(total_tokens), 0) AS total_tokens
     FROM ai_usage_events
     WHERE user_id = ?${projectFilterSql}
     GROUP BY operation
     ORDER BY total_tokens DESC, operation ASC`,
    filters,
  );

  const recentRows = await db.all(
    `SELECT category, operation, report_type, provider, model, prompt_tokens, completion_tokens, total_tokens, credits_used, response_ms, created_at
     FROM ai_usage_events
     WHERE user_id = ?${projectFilterSql}
     ORDER BY created_at DESC
     LIMIT 12`,
    filters,
  );

  let availability = null;
  if (settings.apiKey) {
    try {
      availability = await fetchOpenRouterKeyInfo(env, settings.apiKey);
    } catch {
      availability = null;
    }
  }

  return {
    provider: 'openrouter',
    model: settings.model,
    hasOpenRouterKey: Boolean(settings.apiKey),
    availability,
    summary: {
      requestCount: Number(summaryRow?.request_count ?? 0),
      promptTokens: Number(summaryRow?.prompt_tokens ?? 0),
      completionTokens: Number(summaryRow?.completion_tokens ?? 0),
      totalTokens: Number(summaryRow?.total_tokens ?? 0),
      creditsUsed: Number(summaryRow?.credits_used ?? 0),
    },
    byCategory: BRAIN_CATEGORIES.map((category) => {
      const row = categoryRows.rows.find((entry) => entry.category === category);
      return {
        category,
        requestCount: Number(row?.request_count ?? 0),
        promptTokens: Number(row?.prompt_tokens ?? 0),
        completionTokens: Number(row?.completion_tokens ?? 0),
        totalTokens: Number(row?.total_tokens ?? 0),
        creditsUsed: Number(row?.credits_used ?? 0),
      };
    }),
    byOperation: operationRows.rows.map((row) => ({
      operation: row.operation,
      requestCount: Number(row.request_count ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
    })),
    recent: recentRows.rows.map((row) => ({
      category: row.category,
      operation: row.operation,
      reportType: row.report_type ?? null,
      provider: row.provider,
      model: row.model ?? settings.model,
      promptTokens: Number(row.prompt_tokens ?? 0),
      completionTokens: Number(row.completion_tokens ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
      creditsUsed: Number(row.credits_used ?? 0),
      responseMs: Number(row.response_ms ?? 0),
      createdAt: toIsoString(row.created_at),
    })),
  };
}

export async function compactLatestBrainRows(db, workspaceId) {
  const rows = await latestBrainRowsForCompaction(db, workspaceId);
  let updated = 0;

  for (const row of rows) {
    const nextBrain = compactBrain(row.brain);
    const nextMeta = compactMeta(row.meta, nextBrain);
    if (JSON.stringify(nextBrain) === JSON.stringify(row.brain) && JSON.stringify(nextMeta) === JSON.stringify(row.meta)) {
      continue;
    }

    await db.run(
      'UPDATE sync_blobs SET brain = ?, meta = ? WHERE workspace_id = ? AND cursor = ?',
      [JSON.stringify(nextBrain), JSON.stringify(nextMeta), row.workspaceId, row.cursor],
    );
    updated++;
  }

  return { scannedWorkspaces: rows.length, compactedWorkspaces: updated };
}

async function latestBrainRowsForWorkspaceIds(db, workspaceIds) {
  if (workspaceIds.length === 0) return [];
  const placeholders = workspaceIds.map(() => '?').join(', ');
  const result = await db.all(
    `SELECT workspace_id, cursor, created_at, brain, meta
     FROM sync_blobs
     WHERE workspace_id IN (${placeholders}) AND brain IS NOT NULL
     ORDER BY workspace_id ASC, cursor DESC`,
    workspaceIds,
  );

  const rows = [];
  const seen = new Set();
  for (const row of result.rows) {
    if (seen.has(row.workspace_id)) continue;
    seen.add(row.workspace_id);
    rows.push({
      workspaceId: row.workspace_id,
      cursor: row.cursor,
      updatedAt: toIsoString(row.created_at),
      brain: parseJson(row.brain),
      meta: normalizeMeta(parseJson(row.meta)),
    });
  }
  return rows;
}

async function latestBrainRowsForCompaction(db, workspaceId) {
  if (workspaceId) return latestBrainRowsForWorkspaceIds(db, [workspaceId]);
  const result = await db.all(
    `SELECT workspace_id, cursor, created_at, brain, meta
     FROM sync_blobs
     WHERE brain IS NOT NULL
     ORDER BY workspace_id ASC, cursor DESC`,
  );
  const rows = [];
  const seen = new Set();
  for (const row of result.rows) {
    if (seen.has(row.workspace_id)) continue;
    seen.add(row.workspace_id);
    rows.push({
      workspaceId: row.workspace_id,
      cursor: row.cursor,
      updatedAt: toIsoString(row.created_at),
      brain: parseJson(row.brain),
      meta: normalizeMeta(parseJson(row.meta)),
    });
  }
  return rows;
}

async function listUserWorkspaces(db, userId) {
  const result = await db.all(
    `SELECT id, name, machine_name, created_at
     FROM workspaces
     WHERE user_id = ?
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

function aggregateBrainRows(projectId, projectName, rows) {
  if (rows.length === 1) {
    const brain = decorateBrain({
      ...rows[0].brain,
      workspaceId: projectName,
    });
    return {
      ...rows[0],
      brain,
    };
  }
  const sorted = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const mergedBrain = decorateBrain(mergeBrains(projectName || projectId, sorted.map((row) => row.brain)));
  return {
    workspaceId: projectId,
    cursor: sorted[0].cursor,
    updatedAt: sorted[0].updatedAt,
    brain: { ...mergedBrain, workspaceId: projectName },
    meta: compactMeta(sorted.flatMap((row) => row.meta), mergedBrain),
  };
}

function answerFromBrain(brain, question) {
  const terms = tokenize(question);
  const evidence = buildBrainSearchIndex(brain)
    .map((item) => ({
      kind: item.kind,
      category: item.category,
      title: item.title,
      snippet: item.detail ?? item.title,
      score: scoreText(buildBrainSearchText(item), terms),
      sortAt: item.sortAt,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.sortAt - a.sortAt)
    .slice(0, 6)
    .map(({ kind, category, title, snippet }) => ({ kind, category, title, snippet }));

  const answerParts = [brain.summary];
  if (evidence.length > 0) {
    answerParts.push(`Most relevant context: ${evidence.map((item) => `${item.kind} “${item.title}”`).join('; ')}.`);
  }
  if (brain.tasks.length > 0) {
    const openTasks = brain.tasks.filter((task) => isOpenTask(task.status)).slice(0, 3);
    if (openTasks.length > 0) answerParts.push(`Current active work: ${openTasks.map((task) => task.title).join('; ')}.`);
  }

  return { answer: answerParts.join(' '), evidence };
}

function renderReport(brain, type) {
  if (type === 'slides') {
    return [
      `# ${brain.workspaceId} Slide Outline`,
      '',
      '## 1. Executive Summary',
      `- ${brain.summary}`,
      '',
      '## 2. Milestones',
      ...brain.milestones.slice(0, 5).map((item) => `- ${item.title}`),
      '',
      '## 3. Decisions',
      ...brain.decisions.slice(0, 5).map((item) => `- ${item.title}: ${item.rationale}`),
      '',
      '## 4. Current Focus',
      ...brain.tasks.filter((task) => isOpenTask(task.status)).slice(0, 5).map((task) => `- ${task.title}`),
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
      ...brain.milestones.slice(0, 6).map((item) => `- ${item.title}`),
      '',
      '## Strategic Decisions',
      ...brain.decisions.slice(0, 6).map((item) => `- ${item.title}: ${item.rationale}`),
      '',
      '## Delivery Roadmap',
      ...brain.tasks.slice(0, 8).map((task) => `- [${task.status}] ${task.title}`),
    ].join('\n');
  }
  return [
    '# Project Status',
    '',
    '## Summary',
    brain.summary,
    '',
    '## Current Focus',
    ...brain.tasks.filter((task) => isOpenTask(task.status)).slice(0, 6).map((task) => `- [${task.status}] ${task.title}`),
    '',
    '## Recent Milestones',
    ...brain.milestones.slice(0, 6).map((item) => `- ${item.title}`),
    '',
    '## Key Decisions',
    ...brain.decisions.slice(0, 6).map((item) => `- ${item.title}`),
  ].join('\n');
}

function compactBrain(brain) {
  const milestones = dedupeBy(
    [...brain.milestones]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((item) => ({ ...item, title: compactText(item.title, item.title, 160), detail: compactText(item.detail, item.title, 280) }))
      .slice(0, 12),
    (item) => `${normalizeKey(item.title)}|${item.branch ?? ''}|${item.trigger ?? ''}`,
  );

  const decisions = dedupeBy(
    [...brain.decisions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((item) => ({ ...item, title: compactText(item.title, item.title, 160), rationale: compactText(item.rationale, item.title, 280), impact: item.impact ? compactText(item.impact, item.impact, 180) : item.impact }))
      .slice(0, 12),
    (item) => normalizeKey(item.title),
  );

  const tasks = dedupeBy(
    [...brain.tasks]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((item) => ({ ...item, title: compactText(item.title, item.title, 160), description: item.description ? compactText(item.description, item.title, 220) : item.description }))
      .slice(0, 20),
    (item) => `${normalizeKey(item.title)}|${item.status}`,
  );

  const openTasks = tasks.filter((task) => isOpenTask(task.status));
  const completedTasks = tasks.filter((task) => task.status === 'done');

  return {
    workspaceId: brain.workspaceId,
    generatedAt: Date.now(),
    summary: buildSummary(milestones, decisions, openTasks),
    milestones,
    decisions,
    tasks,
    agentTelemetry: compactAgentTelemetry(brain.agentTelemetry),
    stats: {
      checkpointCount: brain.stats.checkpointCount,
      decisionCount: brain.stats.decisionCount,
      taskCount: brain.stats.taskCount,
      openTaskCount: brain.stats.openTaskCount || openTasks.length,
      completedTaskCount: brain.stats.completedTaskCount || completedTasks.length,
    },
  };
}

function decorateBrain(brain) {
  const compacted = compactBrain(brain);
  const searchIndex = buildBrainSearchIndex(compacted);
  return {
    ...compacted,
    categories: [...BRAIN_CATEGORIES],
    searchIndex,
    analytics: buildBrainAnalytics(searchIndex),
  };
}

function mergeBrains(targetWorkspaceId, brains) {
  const merged = compactBrain({
    workspaceId: targetWorkspaceId,
    generatedAt: Date.now(),
    summary: '',
    milestones: brains.flatMap((brain) => brain.milestones),
    decisions: brains.flatMap((brain) => brain.decisions),
    tasks: brains.flatMap((brain) => brain.tasks),
    agentTelemetry: mergeAgentTelemetry(brains.map((brain) => brain.agentTelemetry)),
    stats: {
      checkpointCount: brains.reduce((sum, brain) => sum + (brain.stats.checkpointCount || 0), 0),
      decisionCount: brains.reduce((sum, brain) => sum + (brain.stats.decisionCount || 0), 0),
      taskCount: brains.reduce((sum, brain) => sum + (brain.stats.taskCount || 0), 0),
      openTaskCount: brains.reduce((sum, brain) => sum + (brain.stats.openTaskCount || 0), 0),
      completedTaskCount: brains.reduce((sum, brain) => sum + (brain.stats.completedTaskCount || 0), 0),
    },
  });
  return { ...merged, workspaceId: targetWorkspaceId };
}

function compactAgentTelemetry(agentTelemetry) {
  const empty = emptyAgentTelemetry();
  if (!agentTelemetry) return empty;

  const recent = [...(agentTelemetry.recent ?? [])]
    .map((entry) => ({
      ...entry,
      agent: compactText(entry.agent, entry.agent, 120),
      taskLabel: entry.taskLabel ? compactText(entry.taskLabel, entry.agent, 140) : entry.taskLabel,
    }))
    .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
    .slice(0, 12);

  return {
    summary: {
      sessionCount: Number(agentTelemetry.summary?.sessionCount ?? recent.length),
      messageCount: Number(agentTelemetry.summary?.messageCount ?? recent.reduce((sum, entry) => sum + Number(entry.messageCount ?? 0), 0)),
      estimatedTokens: Number(agentTelemetry.summary?.estimatedTokens ?? recent.reduce((sum, entry) => sum + Number(entry.estimatedTokens ?? 0), 0)),
      knownModelSessions: Number(agentTelemetry.summary?.knownModelSessions ?? recent.filter((entry) => entry.model).length),
      unknownModelSessions: Number(agentTelemetry.summary?.unknownModelSessions ?? recent.filter((entry) => !entry.model).length),
      knownProviderSessions: Number(agentTelemetry.summary?.knownProviderSessions ?? recent.filter((entry) => entry.provider).length),
      taskLabeledSessions: Number(agentTelemetry.summary?.taskLabeledSessions ?? recent.filter((entry) => entry.taskLabel).length),
    },
    byCategory: normalizeAgentBuckets(agentTelemetry.byCategory, ['category']),
    byAgent: normalizeAgentBuckets(agentTelemetry.byAgent, ['agent']),
    byModel: normalizeAgentBuckets(agentTelemetry.byModel, ['model', 'provider']),
    recent,
  };
}

function mergeAgentTelemetry(telemetries) {
  const compacted = telemetries.map((telemetry) => compactAgentTelemetry(telemetry));
  const recent = compacted
    .flatMap((telemetry) => telemetry.recent)
    .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
    .slice(0, 12);

  return {
    summary: compacted.reduce((summary, telemetry) => ({
      sessionCount: summary.sessionCount + Number(telemetry.summary?.sessionCount ?? 0),
      messageCount: summary.messageCount + Number(telemetry.summary?.messageCount ?? 0),
      estimatedTokens: summary.estimatedTokens + Number(telemetry.summary?.estimatedTokens ?? 0),
      knownModelSessions: summary.knownModelSessions + Number(telemetry.summary?.knownModelSessions ?? 0),
      unknownModelSessions: summary.unknownModelSessions + Number(telemetry.summary?.unknownModelSessions ?? 0),
      knownProviderSessions: summary.knownProviderSessions + Number(telemetry.summary?.knownProviderSessions ?? 0),
      taskLabeledSessions: summary.taskLabeledSessions + Number(telemetry.summary?.taskLabeledSessions ?? 0),
    }), emptyAgentTelemetry().summary),
    byCategory: mergeAgentBuckets(compacted.flatMap((telemetry) => telemetry.byCategory ?? []), (entry) => entry.category ?? 'discovery'),
    byAgent: mergeAgentBuckets(compacted.flatMap((telemetry) => telemetry.byAgent ?? []), (entry) => entry.agent ?? 'Unknown agent'),
    byModel: mergeAgentBuckets(compacted.flatMap((telemetry) => telemetry.byModel ?? []), (entry) => `${entry.provider ?? ''}|${entry.model ?? ''}`),
    recent,
  };
}

function emptyAgentTelemetry() {
  return {
    summary: {
      sessionCount: 0,
      messageCount: 0,
      estimatedTokens: 0,
      knownModelSessions: 0,
      unknownModelSessions: 0,
      knownProviderSessions: 0,
      taskLabeledSessions: 0,
    },
    byCategory: [],
    byAgent: [],
    byModel: [],
    recent: [],
  };
}

function normalizeAgentBuckets(entries, labels) {
  return [...(entries ?? [])]
    .map((entry) => ({ ...entry }))
    .filter((entry) => labels.some((label) => entry[label]))
    .sort((a, b) => Number(b.estimatedTokens ?? 0) - Number(a.estimatedTokens ?? 0))
    .slice(0, 8);
}

function mergeAgentBuckets(entries, keyFn) {
  const buckets = new Map();
  for (const entry of entries) {
    const key = keyFn(entry);
    const existing = buckets.get(key) ?? { ...entry, sessionCount: 0, messageCount: 0, estimatedTokens: 0 };
    existing.sessionCount += Number(entry.sessionCount ?? 0);
    existing.messageCount += Number(entry.messageCount ?? 0);
    existing.estimatedTokens += Number(entry.estimatedTokens ?? 0);
    buckets.set(key, existing);
  }
  return [...buckets.values()]
    .sort((a, b) => Number(b.estimatedTokens ?? 0) - Number(a.estimatedTokens ?? 0))
    .slice(0, 8);
}

function compactMeta(meta, brain) {
  const normalized = meta
    .map((entry) => ({
      type: entry.type ?? 'milestone',
      id: entry.id,
      trigger: entry.trigger ?? null,
      branch: entry.branch ?? null,
      git_sha: entry.git_sha ?? null,
      summary: entry.summary ? compactText(entry.summary, entry.summary, 160) : null,
      created_at: typeof entry.created_at === 'number' ? entry.created_at : 0,
    }))
    .filter((entry) => entry.summary && entry.created_at > 0);

  const milestoneEntries = brain.milestones.map((item) => ({
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
    (entry) => `${entry.type}|${entry.id ?? ''}|${normalizeKey(entry.summary ?? '')}|${entry.created_at ?? 0}`,
  );
}

function buildSummary(milestones, decisions, openTasks) {
  const parts = [milestones[0]?.title || 'No checkpoints recorded yet.'];
  if (decisions.length > 0) parts.push(`Recent decisions: ${decisions.slice(0, 3).map((item) => item.title).join('; ')}.`);
  if (openTasks.length > 0) parts.push(`Current focus: ${openTasks.slice(0, 4).map((item) => item.title).join('; ')}.`);
  return parts.join(' ');
}

function buildBrainSearchIndex(brain) {
  const milestones = (brain.milestones ?? []).map((item) => ({
    id: item.id,
    kind: 'milestone',
    category: categorizeBrainItem('milestone', item),
    title: item.title,
    detail: item.detail ?? null,
    status: null,
    priority: null,
    branch: item.branch ?? null,
    trigger: item.trigger ?? null,
    sortAt: item.createdAt ?? 0,
  }));

  const decisions = (brain.decisions ?? []).map((item) => ({
    id: item.id,
    kind: 'decision',
    category: 'decision',
    title: item.title,
    detail: item.rationale ?? item.impact ?? null,
    status: item.status ?? null,
    priority: null,
    branch: null,
    trigger: null,
    sortAt: item.updatedAt ?? 0,
  }));

  const tasks = (brain.tasks ?? []).map((item) => ({
    id: item.id,
    kind: 'task',
    category: categorizeBrainItem('task', item),
    title: item.title,
    detail: item.description ?? null,
    status: item.status ?? null,
    priority: item.priority ?? null,
    branch: null,
    trigger: null,
    sortAt: item.updatedAt ?? 0,
  }));

  return [...milestones, ...decisions, ...tasks]
    .sort((a, b) => b.sortAt - a.sortAt)
    .slice(0, 48);
}

function buildBrainAnalytics(searchIndex) {
  const categoryCounts = Object.fromEntries(BRAIN_CATEGORIES.map((category) => [category, 0]));
  const kindCounts = { milestone: 0, decision: 0, task: 0 };

  for (const item of searchIndex) {
    if (categoryCounts[item.category] != null) categoryCounts[item.category] += 1;
    if (kindCounts[item.kind] != null) kindCounts[item.kind] += 1;
  }

  return {
    totalItems: searchIndex.length,
    categoryCounts,
    kindCounts,
    recentItems: searchIndex.slice(0, 12),
  };
}

async function recordAiUsageEvent(db, event) {
  await db.run(
    `INSERT INTO ai_usage_events (
       id, user_id, project_id, category, operation, report_type, provider, model,
       prompt_tokens, completion_tokens, total_tokens, credits_used, response_ms, metadata, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      event.userId,
      event.projectId,
      event.category,
      event.operation,
      event.reportType,
      event.provider,
      event.model,
      event.usage?.promptTokens ?? 0,
      event.usage?.completionTokens ?? 0,
      event.usage?.totalTokens ?? 0,
      event.usage?.creditsUsed,
      event.responseMs ?? null,
      JSON.stringify(event.metadata ?? {}),
      Date.now(),
    ],
  );
}

function pickUsageCategory(brain, text) {
  const terms = tokenize(text);
  const scores = new Map(BRAIN_CATEGORIES.map((category) => [category, 0]));
  for (const item of brain.searchIndex ?? []) {
    const score = scoreText(buildBrainSearchText(item), terms);
    if (score > 0) scores.set(item.category, (scores.get(item.category) ?? 0) + score);
  }

  let bestCategory = dominantCategory(brain);
  let bestScore = scores.get(bestCategory) ?? 0;
  for (const category of BRAIN_CATEGORIES) {
    const score = scores.get(category) ?? 0;
    if (score > bestScore) {
      bestCategory = category;
      bestScore = score;
    }
  }
  return bestCategory;
}

function dominantCategory(brain) {
  const counts = brain.analytics?.categoryCounts ?? {};
  let bestCategory = 'feature';
  let bestCount = counts[bestCategory] ?? 0;
  for (const category of BRAIN_CATEGORIES) {
    const count = counts[category] ?? 0;
    if (count > bestCount) {
      bestCategory = category;
      bestCount = count;
    }
  }
  return bestCategory;
}

function categorizeBrainItem(kind, item) {
  if (kind === 'decision') return 'decision';

  const haystack = normalizeKey([
    item.title,
    item.detail,
    item.description,
    item.rationale,
    item.impact,
    item.status,
    item.priority,
    item.trigger,
    item.branch,
  ].filter(Boolean).join(' '));

  if (/(bug|bugfix|fix|fixed|fixing|hotfix|regression|incident|outage|crash|failure|broken|repair|patch|error)/.test(haystack)) {
    return 'bugfix';
  }
  if (/(investigate|investigation|discover|discovery|research|explore|analysis|analyze|spike|audit|triage|learn|evaluate|probe)/.test(haystack)) {
    return 'discovery';
  }
  if (/(feature|implement|implementation|add|build|create|launch|ship|support|enable|introduce|improve|enhance|upgrade)/.test(haystack)) {
    return 'feature';
  }

  if (kind === 'milestone' || kind === 'task') return 'feature';
  return 'discovery';
}

function buildBrainSearchText(item) {
  return [
    item.title,
    item.detail,
    item.category,
    item.kind,
    item.status,
    item.priority,
    item.branch,
    item.trigger,
  ].filter(Boolean).join(' ');
}

async function loadUserAiSettings(db, env, userId) {
  const row = await db.first(
    'SELECT openrouter_api_key_encrypted, openrouter_model FROM users WHERE id = ? LIMIT 1',
    [userId],
  );
  if (!row?.openrouter_api_key_encrypted) {
    return { apiKey: null, model: row?.openrouter_model ?? DEFAULT_OPENROUTER_MODEL };
  }

  try {
    return {
      apiKey: await decryptSecret(row.openrouter_api_key_encrypted, env),
      model: row.openrouter_model ?? DEFAULT_OPENROUTER_MODEL,
    };
  } catch {
    return { apiKey: null, model: row.openrouter_model ?? DEFAULT_OPENROUTER_MODEL };
  }
}

function buildBrainContext(brain) {
  return [
    `Summary: ${brain.summary}`,
    `Stats: ${brain.stats.checkpointCount} checkpoints, ${brain.stats.decisionCount} decisions, ${brain.stats.taskCount} tasks, ${brain.stats.openTaskCount} open tasks.`,
    '',
    'Milestones:',
    ...brain.milestones.slice(0, 8).map((item) => `- ${item.title}${item.detail ? ` — ${item.detail}` : ''}`),
    '',
    'Decisions:',
    ...brain.decisions.slice(0, 8).map((item) => `- ${item.title}: ${item.rationale}`),
    '',
    'Tasks:',
    ...brain.tasks.slice(0, 10).map((item) => `- [${item.status}] ${item.title}${item.description ? `: ${item.description}` : ''}`),
  ].join('\n');
}

function normalizeMeta(meta) {
  return Array.isArray(meta) ? meta : [];
}

function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
}

function scoreText(text, terms) {
  const haystack = text.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function isOpenTask(status) {
  return status !== 'done' && status !== 'cancelled';
}

function compactText(text, fallback, maxLength) {
  const raw = (text ?? '').split('\n').map((line) => line.trim()).filter(Boolean).join(' ').trim();
  if (!raw) return fallback;
  if (/^(trigger:|branch:|commit:|changed files|stats:)/i.test(raw)) return fallback;
  if (/files changed|\s\|\s|packages\//i.test(raw)) return fallback;
  return raw.length <= maxLength ? raw : `${raw.slice(0, maxLength - 3)}...`;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeKey(value) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function makeProjectId(name, workspaceId) {
  return name && name.trim() ? `name:${normalizeKey(name)}` : `workspace:${workspaceId}`;
}

function projectNameFor(workspaces) {
  return workspaces[0]?.name?.trim() || workspaces[0]?.id || 'Unnamed project';
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseJson(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toIsoString(value) {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isNaN(numeric)) return new Date(numeric).toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toISOString();
}