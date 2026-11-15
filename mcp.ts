// Model Context Protocol over streamable HTTP (JSON-RPC 2.0, no sessions):
// server/discover (modern era 2026-07-28), initialize (legacy fallback),
// tools/list, tools/call. All tools share the Store with REST/GraphQL/git.

import type { Repo, Store } from './store.ts';
import { VIEWER_LOGIN, VIEWER_ID } from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (args[name] !== undefined && args[name] !== null) return args[name];
  return undefined;
}

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER_ID },
  };
}

export interface McpRequest {
  id: unknown;
  hasId: boolean;
  method: string;
  params: Record<string, unknown>;
}

export function parseMcpBody(raw: Buffer): { request: McpRequest | null; parseErrorId: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    const m = /"id"\s*:\s*("([^"]*)"|(\d+))/.exec(raw.toString('utf8'));
    let id: unknown = null;
    if (m) id = m[2] !== undefined ? m[2] : Number(m[3]);
    return { request: null, parseErrorId: id };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { request: null, parseErrorId: null };
  const obj = parsed as Record<string, unknown>;
  const hasId = obj.id !== undefined;
  return {
    request: {
      id: obj.id ?? null,
      hasId,
      method: typeof obj.method === 'string' ? obj.method : '',
      params: (obj.params ?? {}) as Record<string, unknown>,
    },
    parseErrorId: null,
  };
}

export function handleMcp(store: Store, req: McpRequest): { status: number; body: unknown } {
  const id = req.id;
  const rpc = (result: unknown) => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const rpcError = (code: number, message: string) => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (req.method === 'notifications/initialized') {
    return { status: 202, body: null };
  }
  if (req.method === 'server/discover') {
    return rpc({
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (req.method === 'initialize') {
    const params = req.params;
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpc({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (req.method === 'ping') {
    return rpc({});
  }
  if (req.method === 'tools/list') {
    return rpc({ tools: TOOLS });
  }
  if (req.method === 'tools/call') {
    const params = req.params;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(-32602, `Unknown tool: ${name}`);
    const missing = tool.inputSchema.required.filter((r) => {
      // A required property is satisfied by any of its accepted synonyms.
      const synonyms: Record<string, string[]> = {
        owner: ['owner', 'owner_login'],
        repo: ['repo', 'repository'],
        head: ['head', 'head_branch'],
        base: ['base', 'base_branch'],
        pull_number: ['pull_number', 'number'],
        body: ['body', 'description'],
      };
      const names = synonyms[r] ?? [r];
      return !names.some((n) => args[n] !== undefined && args[n] !== null && args[n] !== '');
    });
    if (missing.length) return rpc({ ...toolError(`missing required argument: ${missing.join(', ')}`), isError: true });

    try {
      if (name === 'create_repo') {
        const repoName = String(pick(args, 'name'));
        if (store.getRepo(VIEWER_LOGIN, repoName)) return rpc(toolError(`Repository ${repoName} already exists`));
        const repo = store.createRepo(VIEWER_LOGIN, repoName, typeof pick(args, 'description') === 'string' ? String(pick(args, 'description')) : '', pick(args, 'private') === true);
        return rpc(toolResult(repoObject(repo)));
      }
      const owner = String(pick(args, 'owner', 'owner_login'));
      const repoName = String(pick(args, 'repo', 'repository'));
      const repo = store.getRepo(owner, repoName);
      if (name === 'get_repo') {
        if (!repo) return rpc(toolError(`Repository ${owner}/${repoName} not found`));
        return rpc(toolResult(repoObject(repo)));
      }
      if (!repo) return rpc(toolError(`Repository ${owner}/${repoName} not found`));
      if (name === 'create_issue') {
        const issue = store.createIssue(repo, String(pick(args, 'title')), typeof pick(args, 'body', 'description') === 'string' ? String(pick(args, 'body', 'description')) : '', []);
        return rpc(toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
      }
      if (name === 'list_issues') {
        const state = typeof pick(args, 'state') === 'string' ? String(pick(args, 'state')) : 'open';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        issues.sort((a, b) => a.number - b.number);
        return rpc(toolResult({ issues: issues.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state })) }));
      }
      if (name === 'create_pull_request') {
        const head = String(pick(args, 'head', 'head_branch'));
        const base = String(pick(args, 'base', 'base_branch'));
        const headSha = repo.branchTip(head);
        const baseSha = repo.branchTip(base);
        if (headSha === undefined || baseSha === undefined) return rpc(toolError('head or base branch not found'));
        const pull = store.createPull(repo, String(pick(args, 'title')), typeof pick(args, 'body', 'description') === 'string' ? String(pick(args, 'body', 'description')) : '', head, base, headSha, baseSha);
        return rpc(toolResult({ id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha } }));
      }
      if (name === 'merge_pull_request') {
        const number = Number(pick(args, 'pull_number', 'number'));
        const pull = repo.pulls.get(number);
        if (!pull) return rpc(toolError(`Pull request #${number} not found`));
        if (pull.state !== 'open') return rpc(toolError(`Pull request #${number} is not open`));
        const result = store.squashMerge(repo, pull);
        if ('conflict' in result) return rpc(toolError('Merge conflict'));
        return rpc(toolResult({ sha: result.sha, merged: true, number: pull.number }));
      }
    } catch (err) {
      return rpc(toolError(err instanceof Error ? err.message : String(err)));
    }
    return rpcError(-32602, `Unknown tool: ${name}`);
  }
  return rpcError(-32601, `Method not found: ${req.method}`);
}
