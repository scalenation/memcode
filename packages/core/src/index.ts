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
} from './schema';
