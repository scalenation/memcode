/**
 * Repo index — auto-maintained catalog of project components, endpoints,
 * schemas, tests, scripts, and conventions.
 *
 * Agents query this instead of scanning the filesystem every call, which
 * cuts token spend and prevents duplicate-component hallucinations.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { generateId } from './workspace';
import type { RepoIndexEntry, RepoIndexKind } from './schema';

// ── Persistence ────────────────────────────────────────────────────────────────

export function upsertIndexEntry(
  db: DatabaseSync,
  workspaceId: string,
  kind: RepoIndexKind,
  path: string,
  label: string,
  metadata?: unknown,
): RepoIndexEntry {
  const existing = db.prepare(
    'SELECT * FROM repo_index WHERE workspace_id = ? AND kind = ? AND path = ?',
  ).get(workspaceId, kind, path) as unknown as RepoIndexEntry | undefined;

  const t = Date.now();
  const metaJson = metadata ? JSON.stringify(metadata) : null;

  if (existing) {
    db.prepare(
      'UPDATE repo_index SET label = ?, metadata_json = ?, updated_at = ? WHERE id = ?',
    ).run(label, metaJson, t, existing.id);
    return { ...existing, label, metadata_json: metaJson ?? undefined, updated_at: t };
  }

  const id = generateId();
  db.prepare(`
    INSERT INTO repo_index (id, workspace_id, kind, path, label, metadata_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, workspaceId, kind, path, label, metaJson, t);
  return { id, workspace_id: workspaceId, kind, path, label, metadata_json: metaJson ?? undefined, updated_at: t };
}

export function listIndexEntries(
  db: DatabaseSync,
  workspaceId: string,
  kind?: RepoIndexKind,
): RepoIndexEntry[] {
  if (kind) {
    return db.prepare(
      'SELECT * FROM repo_index WHERE workspace_id = ? AND kind = ? ORDER BY path',
    ).all(workspaceId, kind) as unknown as RepoIndexEntry[];
  }
  return db.prepare(
    'SELECT * FROM repo_index WHERE workspace_id = ? ORDER BY kind, path',
  ).all(workspaceId) as unknown as RepoIndexEntry[];
}

export function removeIndexEntry(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM repo_index WHERE id = ?').run(id);
}

export function clearIndex(db: DatabaseSync, workspaceId: string, kind?: RepoIndexKind): void {
  if (kind) {
    db.prepare('DELETE FROM repo_index WHERE workspace_id = ? AND kind = ?').run(workspaceId, kind);
  } else {
    db.prepare('DELETE FROM repo_index WHERE workspace_id = ?').run(workspaceId);
  }
}

// ── File Scanner ──────────────────────────────────────────────────────────────

const IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
  'coverage', '.nyc_output', '.memory', '__pycache__', '.venv',
]);

function walkDir(dir: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  let results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        results = results.concat(walkDir(full, maxDepth, depth + 1));
      } else if (e.isFile()) {
        results.push(full);
      }
    }
  } catch { /* unreadable dir */ }
  return results;
}

function safeReadHead(path: string, bytes = 2000): string {
  try {
    const buf = Buffer.alloc(bytes);
    const fd = require('node:fs').openSync(path, 'r');
    const read = require('node:fs').readSync(fd, buf, 0, bytes, 0);
    require('node:fs').closeSync(fd);
    return buf.slice(0, read).toString('utf8');
  } catch {
    return '';
  }
}

// ── Component Detector ─────────────────────────────────────────────────────────

const COMPONENT_EXTS = new Set(['.tsx', '.jsx', '.svelte', '.vue']);
const COMPONENT_RE = /export\s+(default\s+)?function\s+([A-Z][A-Za-z0-9]+)/;

function detectComponents(file: string, content: string): { label: string; props?: string } | null {
  if (!COMPONENT_EXTS.has(extname(file))) return null;
  const match = COMPONENT_RE.exec(content);
  if (!match) return null;
  // Extract props interface if present
  const propsMatch = /interface\s+\w*Props[^{]*{([^}]*)}/s.exec(content);
  return { label: match[2], props: propsMatch ? propsMatch[1].trim().slice(0, 400) : undefined };
}

// ── Endpoint Detector ──────────────────────────────────────────────────────────

const ENDPOINT_RE = /\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
const NEXT_ROUTE_RE = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)/g;

function detectEndpoints(file: string, content: string): { method: string; path: string }[] {
  const results: { method: string; path: string }[] = [];

  // Express/Fastify/Hono style
  let m: RegExpExecArray | null;
  ENDPOINT_RE.lastIndex = 0;
  while ((m = ENDPOINT_RE.exec(content)) !== null) {
    results.push({ method: m[1].toUpperCase(), path: m[2] });
  }

  // Next.js App Router
  if (file.includes('/route.') || file.includes('/route/')) {
    NEXT_ROUTE_RE.lastIndex = 0;
    while ((m = NEXT_ROUTE_RE.exec(content)) !== null) {
      const routePath = relative(process.cwd(), file)
        .replace(/^.*?app/, '')
        .replace(/\/route\.[jt]sx?$/, '');
      results.push({ method: m[1], path: routePath || '/' });
    }
  }

  return results;
}

// ── Convention Detector ────────────────────────────────────────────────────────

const CONVENTION_FILES = [
  '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs',
  '.prettierrc', '.prettierrc.json', '.prettierrc.js',
  'biome.json', 'biome.jsonc',
  'tsconfig.json', 'tsconfig.base.json',
  '.editorconfig',
  'CONTRIBUTING.md', 'ARCHITECTURE.md',
  'CLAUDE.md', '.github/copilot-instructions.md',
];

// ── Test Detector ──────────────────────────────────────────────────────────────

const TEST_EXTS = new Set(['.test.ts', '.test.tsx', '.test.js', '.spec.ts', '.spec.tsx', '.spec.js']);

function isTestFile(file: string): boolean {
  return TEST_EXTS.has(extname(basename(file, extname(file))) + extname(file)) ||
    file.includes('.test.') || file.includes('.spec.');
}

// ── Public Scanner ─────────────────────────────────────────────────────────────

export interface IndexOptions {
  workspaceId: string;
  projectPath: string;
  kinds?: RepoIndexKind[];
  maxDepth?: number;
}

export interface IndexStats {
  components: number;
  endpoints: number;
  tests: number;
  conventions: number;
  modules: number;
  duration_ms: number;
}

/**
 * Walk the project tree and upsert index entries for detected items.
 * This is fast (~100ms for medium repos) because it only reads file heads.
 */
export function buildRepoIndex(db: DatabaseSync, opts: IndexOptions): IndexStats {
  const start = Date.now();
  const kinds = new Set(opts.kinds ?? ['component', 'endpoint', 'test', 'convention', 'module']);
  const maxDepth = opts.maxDepth ?? 8;
  const projectPath = opts.projectPath;
  const stats: IndexStats = { components: 0, endpoints: 0, tests: 0, conventions: 0, modules: 0, duration_ms: 0 };

  // Convention files (just check existence, no need to walk)
  if (kinds.has('convention')) {
    for (const cf of CONVENTION_FILES) {
      const full = join(projectPath, cf);
      try {
        statSync(full);
        const rel = cf;
        upsertIndexEntry(db, opts.workspaceId, 'convention', rel, `Convention: ${cf}`);
        stats.conventions++;
      } catch { /* not present */ }
    }
  }

  // Walk the tree
  const files = walkDir(projectPath, maxDepth);

  for (const file of files) {
    const rel = relative(projectPath, file);
    const ext = extname(file);

    if (kinds.has('test') && isTestFile(file)) {
      upsertIndexEntry(db, opts.workspaceId, 'test', rel, basename(file));
      stats.tests++;
      continue;
    }

    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.vue'].includes(ext)) continue;

    const content = safeReadHead(file);

    if (kinds.has('component')) {
      const comp = detectComponents(file, content);
      if (comp) {
        upsertIndexEntry(db, opts.workspaceId, 'component', rel, comp.label, comp.props ? { props: comp.props } : undefined);
        stats.components++;
        continue;
      }
    }

    if (kinds.has('endpoint')) {
      const eps = detectEndpoints(file, content);
      for (const ep of eps) {
        upsertIndexEntry(db, opts.workspaceId, 'endpoint', rel, `${ep.method} ${ep.path}`, { method: ep.method, route: ep.path });
        stats.endpoints++;
      }
    }

    if (kinds.has('module') && (content.includes('export function') || content.includes('export const') || content.includes('export class'))) {
      upsertIndexEntry(db, opts.workspaceId, 'module', rel, basename(file, ext));
      stats.modules++;
    }
  }

  stats.duration_ms = Date.now() - start;
  return stats;
}

/**
 * Format the index as a compact context block.
 */
export function formatIndexForContext(entries: RepoIndexEntry[], workspaceId: string): string {
  if (entries.length === 0) return '';

  const byKind: Partial<Record<RepoIndexKind, RepoIndexEntry[]>> = {};
  for (const e of entries) {
    (byKind[e.kind] ??= []).push(e);
  }

  const sections: string[] = ['## Repo Index'];
  for (const [kind, list] of Object.entries(byKind) as [RepoIndexKind, RepoIndexEntry[]][]) {
    sections.push(`\n### ${kind.charAt(0).toUpperCase() + kind.slice(1)}s (${list.length})`);
    for (const e of list.slice(0, 60)) {
      const meta = e.metadata_json ? ` — ${JSON.stringify(JSON.parse(e.metadata_json)).slice(0, 80)}` : '';
      sections.push(`- \`${e.path}\` ${e.label}${meta}`);
    }
    if (list.length > 60) sections.push(`  … and ${list.length - 60} more`);
  }

  return sections.join('\n');
}
