export { openDb, appliedMigrations, transaction } from './db';
export { MIGRATIONS } from './migrations';
export { getOrCreateWorkspace, getWorkspaceById, generateId } from './workspace';
export { redact, containsSecret } from './redaction';
export { generateShortSummary, generateLongSummary } from './summarizer';
export {
  getGitInfo,
  createCheckpoint,
  createCheckpointSync,
  listCheckpoints,
} from './checkpoint';
export type { GitInfo, CheckpointOptions } from './checkpoint';
export { recall, recallSync } from './retrieval';
export type { RecallResult } from './retrieval';
export { generateContextPack } from './context-pack';
export { getTimeline } from './timeline';
export type { TimelineEntry } from './timeline';
export { installGitHooks, uninstallGitHooks, installedHooks } from './hooks';
export type { HookInstallResult } from './hooks';
export {
  createDecision,
  listDecisions,
  updateDecisionStatus,
  createTask,
  listTasks,
  updateTaskStatus,
  updateTask,
} from './items';
export type {
  CreateDecisionOptions,
  CreateTaskOptions,
  UpdateTaskOptions,
} from './items';
export { registry } from './providers';
export type {
  SummarizerProvider,
  EmbeddingProvider,
  InsightProvider,
  Insight,
} from './providers';
export { isEnabled, requireFeature, ProFeatureError } from './feature-gate';
export type { FeatureFlag } from './feature-gate';

// ── Agent context writer ───────────────────────────────────────────────────────
export {
  buildAgentContextBlock,
  writeAgentContextFiles,
  clearAgentContextFiles,
} from './agent-context';
export type { AgentContextResult } from './agent-context';

// ── Orchestration ──────────────────────────────────────────────────────────────
export {
  createRun,
  getActiveRun,
  getRun,
  listRuns,
  startRun,
  setPlan,
  approveRun,
  pauseRun,
  resumeRun,
  finishRun,
  cancelRun,
  rollbackRun,
  addRunStep,
  finishRunStep,
  listRunSteps,
  addRunEvent,
  listRunEvents,
  addRunArtifact,
  listRunArtifacts,
  buildPlanOptions,
  createRunWorktree,
  stashBeforeRun,
} from './run';
export type { CreateRunOptions, AddStepOptions, PlanOption } from './run';

// ── Assumptions ────────────────────────────────────────────────────────────────
export {
  setAssumption,
  listAssumptions,
  getAssumption,
  invalidateAssumption,
  removeAssumption,
  clearAssumptions,
  formatAssumptionsForContext,
} from './assumptions';
export type { SetAssumptionOptions } from './assumptions';

// ── Repo Index ─────────────────────────────────────────────────────────────────
export {
  upsertIndexEntry,
  listIndexEntries,
  removeIndexEntry,
  clearIndex,
  buildRepoIndex,
  formatIndexForContext,
} from './repo-index';
export type { IndexOptions, IndexStats } from './repo-index';

// ── Model Router ───────────────────────────────────────────────────────────────
export { ModelRouter, defaultRouter } from './model-router';
export type { ModelRoute, RoutingResult, RouterConfig, ModelTier } from './model-router';

// ── Evals ──────────────────────────────────────────────────────────────────────
export {
  createEvalTask,
  listEvalTasks,
  archiveEvalTask,
  recordEvalResult,
  listEvalResults,
  evalSummary,
} from './evals';
export type { CreateEvalTaskOptions, RecordEvalResultOptions } from './evals';

// ── Schema types ───────────────────────────────────────────────────────────────
export type {
  Workspace,
  Session,
  Message,
  Checkpoint,
  Decision,
  Task,
  Artifact,
  SyncState,
  MemoryConfig,
  DecisionStatus,
  TaskStatus,
  TaskPriority,
  Run,
  RunStep,
  RunEvent,
  RunArtifact,
  RunStatus,
  RunPhase,
  RunPolicy,
  StepStatus,
  Assumption,
  AssumptionSource,
  RepoIndexEntry,
  RepoIndexKind,
  EvalTask,
  EvalResult,
} from './schema';
