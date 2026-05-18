export interface Workspace {
  id: string;
  name: string;
  path_hash: string;
  created_at: number;
}

export interface Session {
  id: string;
  workspace_id: string;
  editor?: string;
  agent?: string;
  source?: string;
  provider?: string;
  model?: string;
  task_label?: string;
  category?: 'decision' | 'bugfix' | 'feature' | 'discovery';
  started_at: number;
  ended_at?: number;
}

export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  token_count?: number;
  created_at: number;
}

export interface Checkpoint {
  id: string;
  workspace_id: string;
  session_id?: string;
  git_sha?: string;
  branch?: string;
  trigger: string;
  summary_short: string;
  summary_long: string;
  created_at: number;
}

export type DecisionStatus = 'active' | 'superseded' | 'rejected';

export interface Decision {
  id: string;
  workspace_id: string;
  title: string;
  rationale: string;
  impact?: string;
  status: DecisionStatus;
  checkpoint_id?: string;
  created_at: number;
  updated_at: number;
}

export type TaskStatus = 'open' | 'in-progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  workspace_id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority?: TaskPriority;
  decision_id?: string;
  checkpoint_id?: string;
  created_at: number;
  updated_at: number;
}

export interface Artifact {
  id: string;
  checkpoint_id: string;
  kind: string;
  path?: string;
  hash?: string;
  metadata_json?: string;
}

export interface SyncState {
  workspace_id: string;
  enabled: number;
  last_cursor?: string;
  last_synced_at?: number;
  provider?: string;
}

export interface MemoryConfig {
  version: number;
  workspaceId: string;
  cloudSync: {
    enabled: boolean;
    provider?: string;
    endpoint?: string;
  };
}

// ── Orchestration ─────────────────────────────────────────────────────────────

export type RunStatus =
  | 'pending'
  | 'planning'
  | 'awaiting-approval'
  | 'executing'
  | 'paused'
  | 'validating'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'rolled-back';

export type RunPhase =
  | 'retrieve'
  | 'plan'
  | 'approve'
  | 'build'
  | 'validate'
  | 'review'
  | 'commit'
  | 'deploy'
  | 'custom';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface RunPolicy {
  planning?: { required?: boolean; options?: number; humanApproval?: 'required' | 'optional' | 'skip' };
  implementation?: { checkpointBeforeEdit?: boolean; maxFilesWithoutApproval?: number; useWorktree?: boolean };
  validation?: { commands?: string[] };
  rollback?: { onValidationFailure?: 'ask' | 'auto' | 'skip'; onDirtyFiles?: 'block' | 'warn' | 'allow' };
  cost?: { maxUsd?: number };
}

export interface Run {
  id: string;
  workspace_id: string;
  title: string;
  description?: string;
  status: RunStatus;
  policy_json?: string;
  git_branch?: string;
  git_sha_before?: string;
  git_stash_ref?: string;
  git_worktree?: string;
  plan_json?: string;
  selected_option?: number;
  created_at: number;
  updated_at: number;
  finished_at?: number;
}

export interface RunStep {
  id: string;
  run_id: string;
  phase: RunPhase;
  label: string;
  status: StepStatus;
  input_json?: string;
  output_json?: string;
  model?: string;
  cost_usd?: number;
  started_at?: number;
  finished_at?: number;
  seq: number;
}

export interface RunEvent {
  id: string;
  run_id: string;
  step_id?: string;
  type: string;
  payload_json?: string;
  created_at: number;
}

export interface RunArtifact {
  id: string;
  run_id: string;
  step_id?: string;
  kind: string;
  label?: string;
  content?: string;
  path?: string;
  metadata_json?: string;
  created_at: number;
}

export type AssumptionSource = 'agent' | 'user' | 'detected' | 'imported';

export interface Assumption {
  id: string;
  workspace_id: string;
  key: string;
  value: string;
  source: AssumptionSource;
  stale: number;
  run_id?: string;
  created_at: number;
  updated_at: number;
}

export type RepoIndexKind =
  | 'component'
  | 'endpoint'
  | 'schema'
  | 'test'
  | 'script'
  | 'convention'
  | 'module'
  | 'bridge';

export interface RepoIndexEntry {
  id: string;
  workspace_id: string;
  kind: RepoIndexKind;
  path: string;
  label: string;
  metadata_json?: string;
  updated_at: number;
}

export interface EvalTask {
  id: string;
  workspace_id: string;
  title: string;
  description?: string;
  acceptance_json?: string;
  status: 'active' | 'archived';
  created_at: number;
}

export interface EvalResult {
  id: string;
  eval_task_id: string;
  run_id?: string;
  agent?: string;
  model?: string;
  passed: number;
  score?: number;
  notes?: string;
  created_at: number;
}

export interface AgentSession {
  id: string;
  workspace_id: string;
  run_id?: string;
  agent: string;
  status: 'active' | 'idle' | 'ended';
  goal?: string;
  stash_ref?: string;
  files_changed?: string;  // JSON array
  blocker?: string;
  started_at: number;
  last_heartbeat_at: number;
  ended_at?: number;
  snapshot_json?: string;
}
