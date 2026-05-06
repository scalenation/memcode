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
