import {
  DEFAULT_OPENROUTER_MODEL,
  decryptSecret,
  completeWithOpenRouter,
} from './openrouter.js';

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
  return {
    workspaceId,
    cursor: row.cursor,
    updatedAt: toIsoString(row.created_at),
    brain: parseJson(row.brain),
    meta: normalizeMeta(parseJson(row.meta)),
  };
}

export async function generateBrainAnswer(env, db, userId, brain, question, projectName) {
  const fallback = answerFromBrain(brain, question);
  const settings = await loadUserAiSettings(db, env, userId);
  if (!settings.apiKey) return fallback;

  try {
    const answer = await completeWithOpenRouter(env, {
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt: 'You answer questions about a software project using only the provided project brain context. Be concise, grounded, and explicit when the context is incomplete.',
      userPrompt: [`Project: ${projectName}`, `Question: ${question}`, '', buildBrainContext(brain)].join('\n'),
      temperature: 0.2,
    });
    return { ...fallback, answer };
  } catch {
    return fallback;
  }
}

export async function generateBrainReport(env, db, userId, brain, type, projectName) {
  const fallback = renderReport(brain, type);
  const settings = await loadUserAiSettings(db, env, userId);
  if (!settings.apiKey) return fallback;

  try {
    return await completeWithOpenRouter(env, {
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt: 'You generate practical markdown reports for engineering projects. Use only the provided project brain context. Do not invent progress, metrics, or roadmap items.',
      userPrompt: [`Project: ${projectName}`, `Requested report type: ${type}`, '', 'Return markdown only.', '', buildBrainContext(brain)].join('\n'),
      temperature: 0.3,
    });
  } catch {
    return fallback;
  }
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
    return {
      ...rows[0],
      brain: {
        ...rows[0].brain,
        workspaceId: projectName,
      },
    };
  }
  const sorted = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const mergedBrain = compactBrain(mergeBrains(projectName || projectId, sorted.map((row) => row.brain)));
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
  const evidence = [
    ...brain.milestones.map((item) => ({ kind: 'milestone', title: item.title, snippet: item.detail ?? item.title })),
    ...brain.decisions.map((item) => ({ kind: 'decision', title: item.title, snippet: item.rationale })),
    ...brain.tasks.map((item) => ({ kind: 'task', title: item.title, snippet: item.description ?? item.title })),
  ]
    .map((item) => ({ ...item, score: scoreText(`${item.title} ${item.snippet}`, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ kind, title, snippet }) => ({ kind, title, snippet }));

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
    stats: {
      checkpointCount: brain.stats.checkpointCount,
      decisionCount: brain.stats.decisionCount,
      taskCount: brain.stats.taskCount,
      openTaskCount: brain.stats.openTaskCount || openTasks.length,
      completedTaskCount: brain.stats.completedTaskCount || completedTasks.length,
    },
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