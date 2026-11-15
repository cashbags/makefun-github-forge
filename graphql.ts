// GitHub GraphQL v4: a small executor for the documents the suite sends
// (the `gh` CLI and `github-mcp-server` shapes), plus __type introspection and
// batched documents. Unknown fields become errors, not crashes.

import { parseCommit } from './store.ts';
import type { Repo, Store, Issue, Pull } from './store.ts';
import { VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL } from './store.ts';

// ---- global ids (opaque, stable) ---------------------------------------------

export function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

// ---- parser -------------------------------------------------------------------

interface Selection {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: Selection[] | null;
  fragmentType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly text: string;
  private readonly variables: Record<string, unknown>;

  constructor(text: string, variables: Record<string, unknown>) {
    this.text = text;
    this.variables = variables;
  }

  private skipWs(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') this.pos += 1;
      else if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
      } else break;
    }
  }

  private peek(): string {
    this.skipWs();
    return this.text[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.text[this.pos] !== ch) throw new Error(`expected ${ch} at ${this.pos}, got ${this.text[this.pos]}`);
    this.pos += 1;
  }

  private readName(): string {
    this.skipWs();
    const start = this.pos;
    while (this.pos < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.pos])) this.pos += 1;
    if (this.pos === start) throw new Error(`expected name at ${this.pos}`);
    return this.text.slice(start, this.pos);
  }

  private readString(): string {
    this.skipWs();
    if (this.text[this.pos] !== '"') throw new Error(`expected string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        this.pos += 1;
        const esc = this.text[this.pos];
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else out += esc;
        this.pos += 1;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw new Error('unterminated string');
  }

  private readValue(): unknown {
    this.skipWs();
    const ch = this.text[this.pos];
    if (ch === '"') return this.readString();
    if (ch === '$') {
      this.pos += 1;
      const name = this.readName();
      return this.variables[name] ?? null;
    }
    if (ch === '[') {
      this.pos += 1;
      const items: unknown[] = [];
      while (this.peek() !== ']') items.push(this.readValue());
      this.expect(']');
      return items;
    }
    if (ch === '{') {
      this.pos += 1;
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}') {
        const key = this.readName();
        this.expect(':');
        obj[key] = this.readValue();
      }
      this.expect('}');
      return obj;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = this.pos;
      while (this.pos < this.text.length && /[0-9.eE+-]/.test(this.text[this.pos])) this.pos += 1;
      return Number(this.text.slice(start, this.pos));
    }
    const name = this.readName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return { __enum: name };
  }

  private readArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    this.skipWs();
    if (this.text[this.pos] !== '(') return args;
    this.pos += 1;
    while (this.peek() !== ')') {
      const key = this.readName();
      this.expect(':');
      args[key] = this.readValue();
    }
    this.expect(')');
    return args;
  }

  private readSelections(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '.' && this.text[this.pos + 1] === '.' && this.text[this.pos + 2] === '.') {
        this.pos += 3;
        let fragmentType: string | null = null;
        if (this.peek() === 'o') {
          const kw = this.readName();
          if (kw === 'on') fragmentType = this.readName();
        }
        const selections = this.readSelections();
        out.push({ alias: null, name: '__fragment__', args: {}, selections, fragmentType });
        continue;
      }
      const first = this.readName();
      let alias: string | null = null;
      let name = first;
      if (this.peek() === ':') {
        this.pos += 1;
        alias = first;
        name = this.readName();
      }
      const args = this.readArguments();
      const selections = this.peek() === '{' ? this.readSelections() : null;
      out.push({ alias, name, args, selections, fragmentType: null });
    }
    this.expect('}');
    return out;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (true) {
      this.skipWs();
      if (this.pos >= this.text.length) break;
      let kind: 'query' | 'mutation' = 'query';
      let name: string | null = null;
      const ch = this.text[this.pos];
      if (ch === '{') {
        ops.push({ kind, name, variables: {}, selections: this.readSelections() });
        continue;
      }
      const kw = this.readName();
      if (kw === 'query' || kw === 'mutation') {
        kind = kw;
        this.skipWs();
        if (this.text[this.pos] !== '{' && this.text[this.pos] !== '(') name = this.readName();
        if (this.text[this.pos] === '(') {
          // Variable definitions: skip them (values come from `variables`).
          let depth = 0;
          while (this.pos < this.text.length) {
            const c = this.text[this.pos];
            if (c === '(') depth += 1;
            if (c === ')') {
              depth -= 1;
              this.pos += 1;
              if (depth === 0) break;
              continue;
            }
            if (c === '"' || c === "'") {
              this.readString();
              continue;
            }
            this.pos += 1;
          }
        }
      } else {
        throw new Error(`unexpected keyword ${kw}`);
      }
      ops.push({ kind, name, variables: {}, selections: this.readSelections() });
    }
    return ops;
  }
}

// ---- execution ------------------------------------------------------------------

type GqlValue = { __type: string; value: unknown };

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
}

const ISSUE_FIELDS = ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt'];
const PULL_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'author', 'createdAt', 'updatedAt'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const USER_FIELDS = ['id', 'login', 'name', 'email'];

function fieldKnown(typeName: string, field: string): boolean {
  if (field === '__typename') return true;
  switch (typeName) {
    case 'Query':
      return ['viewer', 'repository', 'node', '__type'].includes(field);
    case 'Mutation':
      return ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'].includes(field);
    case 'User':
      return USER_FIELDS.includes(field);
    case 'Repository':
      return REPO_FIELDS.includes(field);
    case 'Issue':
      return ISSUE_FIELDS.includes(field);
    case 'PullRequest':
      return PULL_FIELDS.includes(field);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
      return ['nodes', 'edges', 'pageInfo', 'totalCount'].includes(field);
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
      return ['node', 'cursor'].includes(field);
    case 'PageInfo':
      return ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'].includes(field);
    case 'Ref':
      return ['name'].includes(field);
    case '__Type':
      return ['name', 'kind', 'fields', 'enumValues'].includes(field);
    case '__Field':
      return ['name'].includes(field);
    case '__EnumValue':
      return ['name'].includes(field);
    case 'PullRequestChangedFile':
      return ['path'].includes(field);
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload':
      return ['issue', 'pullRequest', 'commentEdge'].includes(field);
    case 'IssueCommentEdge':
      return ['node'].includes(field);
    case 'IssueComment':
      return ['id', 'body'].includes(field);
    default:
      return true;
  }
}

function resolveSelections(ctx: Ctx, typeName: string, value: unknown, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.name === '__fragment__') {
      if (sel.fragmentType === null || sel.fragmentType === typeName) {
        Object.assign(out, resolveSelections(ctx, typeName, value, sel.selections ?? []));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (!fieldKnown(typeName, sel.name)) {
      ctx.errors.push({ message: `Field "${sel.name}" doesn't exist on type "${typeName}"` });
      out[key] = null;
      continue;
    }
    out[key] = resolveField(ctx, typeName, value, sel);
  }
  return out;
}

function repoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function issueByGid(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'issue' || parsed.parts.length !== 2) return null;
  const repo = repoById(store, parseInt(parsed.parts[0], 10));
  if (!repo) return null;
  const issue = repo.issues.get(parseInt(parsed.parts[1], 10));
  if (!issue) return null;
  return { repo, issue };
}

function pullByGid(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'pr' || parsed.parts.length !== 2) return null;
  const repo = repoById(store, parseInt(parsed.parts[0], 10));
  if (!repo) return null;
  const pull = repo.pulls.get(parseInt(parsed.parts[1], 10));
  if (!pull) return null;
  return { repo, pull };
}

function issueConnection(repo: Repo, issues: Issue[], args: Record<string, unknown>): Record<string, unknown> {
  let list = [...issues];
  const states = args.states;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((s) => (typeof s === 'object' && s !== null && '__enum' in (s as Record<string, unknown>) ? String((s as Record<string, unknown>).__enum) : String(s)).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state.toLowerCase()));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy && typeof orderBy === 'object') {
    const field = typeof orderBy.field === 'object' && orderBy.field !== null && '__enum' in (orderBy.field as Record<string, unknown>) ? String((orderBy.field as Record<string, unknown>).__enum) : String(orderBy.field ?? '');
    const direction = typeof orderBy.direction === 'object' && orderBy.direction !== null && '__enum' in (orderBy.direction as Record<string, unknown>) ? String((orderBy.direction as Record<string, unknown>).__enum) : String(orderBy.direction ?? '');
    if (field === 'CREATED_AT' && direction === 'DESC') list.sort((a, b) => b.createdSeq - a.createdSeq);
    else if (field === 'CREATED_AT' && direction === 'ASC') list.sort((a, b) => a.createdSeq - b.createdSeq);
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  const after = numberFromCursor(typeof args.after === 'string' ? args.after : null);
  if (after !== null) list = list.filter((i) => i.number > after);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const endCursor = page.length ? cursorFor(page[page.length - 1].number) : null;
  return {
    nodes: page,
    edges: page.map((i) => ({ node: i, cursor: cursorFor(i.number) })),
    pageInfo: { hasNextPage: list.length > page.length, hasPreviousPage: after !== null, startCursor: page.length ? cursorFor(page[0].number) : null, endCursor },
    totalCount: list.length,
  };
}

function resolveField(ctx: Ctx, typeName: string, value: unknown, sel: Selection): unknown {
  const args = sel.args;
  const sub = sel.selections ?? [];
  const as = (v: GqlValue): GqlValue => v;

  if (typeName === 'Query') {
    if (sel.name === 'viewer') {
      return resolveSelections(ctx, 'User', { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL }, sub);
    }
    if (sel.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = ctx.store.getRepo(owner, name);
      if (!repo) return null;
      return resolveSelections(ctx, 'Repository', as({ __type: 'Repository', value: repo }), sub);
    }
    if (sel.name === 'node') {
      const id = String(args.id ?? '');
      const parsed = parseGid(id);
      if (!parsed) return null;
      if (parsed.kind === 'repo') {
        const repo = repoById(ctx.store, parseInt(parsed.parts[0], 10));
        if (!repo) return null;
        return resolveSelections(ctx, 'Repository', as({ __type: 'Repository', value: repo }), sub);
      }
      if (parsed.kind === 'issue') {
        const found = issueByGid(ctx.store, id);
        if (!found) return null;
        return resolveSelections(ctx, 'Issue', as({ __type: 'Issue', value: { repo: found.repo, issue: found.issue } }), sub);
      }
      return null;
    }
    if (sel.name === '__type') {
      const name = String(args.name ?? '');
      return resolveSelections(ctx, '__Type', { name }, sub);
    }
    return null;
  }

  if (typeName === 'User') {
    const user = value as { login: string; id: number; name: string; email: string };
    if (sel.name === 'id') return gid('user', user.login);
    if (sel.name === 'login') return user.login;
    if (sel.name === 'name') return user.name;
    if (sel.name === 'email') return user.email;
    return null;
  }

  if (typeName === 'Repository') {
    const repo = (value as GqlValue).value as Repo;
    if (sel.name === 'id') return gid('repo', repo.id);
    if (sel.name === 'databaseId') return repo.id;
    if (sel.name === 'name') return repo.name;
    if (sel.name === 'nameWithOwner') return repo.fullName;
    if (sel.name === 'owner') return resolveSelections(ctx, 'User', { login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL }, sub);
    if (sel.name === 'defaultBranchRef') return resolveSelections(ctx, 'Ref', { name: repo.defaultBranch }, sub);
    if (sel.name === 'viewerPermission') return 'ADMIN';
    if (sel.name === 'hasIssuesEnabled') return true;
    if (sel.name === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      if (!issue) return null;
      return resolveSelections(ctx, 'Issue', as({ __type: 'Issue', value: { repo, issue } }), sub);
    }
    if (sel.name === 'issues') {
      const conn = issueConnection(repo, [...repo.issues.values()], args);
      return resolveConnection(ctx, 'Issue', repo, conn, sub);
    }
    if (sel.name === 'pullRequests') {
      let pulls = [...repo.pulls.values()];
      pulls.sort((a, b) => a.number - b.number);
      const after = numberFromCursor(typeof args.after === 'string' ? args.after : null);
      if (after !== null) pulls = pulls.filter((p) => p.number > after);
      const first = typeof args.first === 'number' ? args.first : pulls.length;
      const page = pulls.slice(0, first);
      const conn = {
        nodes: page,
        edges: page.map((p) => ({ node: p, cursor: cursorFor(p.number) })),
        pageInfo: { hasNextPage: pulls.length > page.length, hasPreviousPage: after !== null, startCursor: page.length ? cursorFor(page[0].number) : null, endCursor: page.length ? cursorFor(page[page.length - 1].number) : null },
        totalCount: pulls.length,
      };
      return resolveConnection(ctx, 'PullRequest', repo, conn, sub);
    }
    if (sel.name === 'pullRequest') {
      const pull = repo.pulls.get(Number(args.number));
      if (!pull) return null;
      return resolveSelections(ctx, 'PullRequest', as({ __type: 'PullRequest', value: { repo, pull } }), sub);
    }
    return null;
  }

  if (typeName === 'Issue') {
    const pair = (value as GqlValue).value as { repo: Repo; issue: Issue };
    const issue = pair.issue;
    if (sel.name === 'id') return gid('issue', pair.repo.id, issue.number);
    if (sel.name === 'databaseId') return issue.id;
    if (sel.name === 'number') return issue.number;
    if (sel.name === 'title') return issue.title;
    if (sel.name === 'body') return issue.body;
    if (sel.name === 'state') return issue.state.toUpperCase();
    if (sel.name === 'author') return resolveSelections(ctx, 'User', { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL }, sub);
    if (sel.name === 'createdAt') return new Date(1700000000 * 1000 + issue.createdSeq * 1000).toISOString();
    if (sel.name === 'updatedAt') return new Date(1700000000 * 1000 + issue.createdSeq * 1000).toISOString();
    return null;
  }

  if (typeName === 'PullRequest') {
    const pair = (value as GqlValue).value as { repo: Repo; pull: Pull };
    const pull = pair.pull;
    if (sel.name === 'id') return gid('pr', pair.repo.id, pull.number);
    if (sel.name === 'databaseId') return pull.id;
    if (sel.name === 'number') return pull.number;
    if (sel.name === 'title') return pull.title;
    if (sel.name === 'body') return pull.body;
    if (sel.name === 'state') return pull.state.toUpperCase();
    if (sel.name === 'headRefName') return pull.headRef;
    if (sel.name === 'baseRefName') return pull.baseRef;
    if (sel.name === 'mergeable') return ctx.store.mergeable(pair.repo, pull);
    if (sel.name === 'merged') return pull.merged;
    if (sel.name === 'author') return resolveSelections(ctx, 'User', { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL }, sub);
    if (sel.name === 'createdAt') return new Date(1700000000 * 1000 + pull.createdSeq * 1000).toISOString();
    if (sel.name === 'updatedAt') return new Date(1700000000 * 1000 + pull.createdSeq * 1000).toISOString();
    if (sel.name === 'files') {
      const repo = pair.repo;
      const headObj = repo.objects.get(pull.headSha);
      const baseObj = repo.objects.get(pull.baseSha);
      let files: Array<{ path: string }> = [];
      if (headObj && baseObj) {
        const diff = ctx.store.diffTrees(repo, parseCommit(baseObj.data).tree, parseCommit(headObj.data).tree);
        files = diff.map((d) => ({ path: d.path }));
      }
      const first = typeof args.first === 'number' ? args.first : files.length;
      const page = files.slice(0, first);
      const conn = {
        nodes: page,
        edges: page.map((f, i) => ({ node: f, cursor: cursorFor(i + 1) })),
        pageInfo: { hasNextPage: files.length > page.length, hasPreviousPage: false, startCursor: page.length ? cursorFor(1) : null, endCursor: page.length ? cursorFor(page.length) : null },
        totalCount: files.length,
      };
      return resolveConnection(ctx, 'PullRequestChangedFile', repo, conn, sub);
    }
    return null;
  }

  if (typeName === '__Type') {
    const name = (value as { name: string }).name;
    if (sel.name === 'name') return name;
    if (sel.name === 'kind') return name === 'SearchType' ? 'ENUM' : 'OBJECT';
    if (sel.name === 'fields') {
      const fields =
        name === 'Issue' ? ISSUE_FIELDS.map((f) => ({ name: f })) : name === 'PullRequest' ? PULL_FIELDS.map((f) => ({ name: f })) : name === 'Repository' ? REPO_FIELDS.map((f) => ({ name: f })) : [];
      return fields.map((f) => resolveSelections(ctx, '__Field', f, sub));
    }
    if (sel.name === 'enumValues') {
      if (name !== 'SearchType') return null;
      const values = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PROJECT', 'ORGANIZATION'].map((v) => ({ name: v }));
      return values.map((v) => resolveSelections(ctx, '__EnumValue', v, sub));
    }
    return null;
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (sel.name === 'name') return (value as { name: string }).name;
    return null;
  }

  if (typeName === 'Ref') {
    if (sel.name === 'name') return (value as { name: string }).name;
    return null;
  }

  if (typeName === 'PageInfo') {
    const page = value as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
    if (sel.name === 'hasNextPage') return page.hasNextPage;
    if (sel.name === 'hasPreviousPage') return page.hasPreviousPage;
    if (sel.name === 'startCursor') return page.startCursor;
    if (sel.name === 'endCursor') return page.endCursor;
    return null;
  }

  if (typeName === 'PullRequestChangedFile') {
    if (sel.name === 'path') return (value as { path: string }).path;
    return null;
  }

  if (typeName === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (sel.name === 'createIssue') {
      const repoId = String(input.repositoryId ?? '');
      const parsed = parseGid(repoId);
      if (!parsed || parsed.kind !== 'repo') {
        ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
        return null;
      }
      const repo = repoById(ctx.store, parseInt(parsed.parts[0], 10));
      if (!repo) {
        ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
        return null;
      }
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return resolveSelections(ctx, 'CreateIssuePayload', { issue: { repo, issue } }, sub);
    }
    if (sel.name === 'closeIssue') {
      const found = issueByGid(ctx.store, String(input.issueId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'closeIssue: unknown issueId' });
        return null;
      }
      found.issue.state = 'closed';
      return resolveSelections(ctx, 'CloseIssuePayload', { issue: { repo: found.repo, issue: found.issue } }, sub);
    }
    if (sel.name === 'createPullRequest') {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'repo') {
        ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
        return null;
      }
      const repo = repoById(ctx.store, parseInt(parsed.parts[0], 10));
      if (!repo) {
        ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
        return null;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.branchTip(headRef);
      const baseSha = repo.branchTip(baseRef);
      if (headSha === undefined || baseSha === undefined) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch not found' });
        return null;
      }
      const pull = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef, headSha, baseSha);
      return resolveSelections(ctx, 'CreatePullRequestPayload', { pullRequest: { repo, pull } }, sub);
    }
    if (sel.name === 'mergePullRequest') {
      const found = pullByGid(ctx.store, String(input.pullRequestId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
        return null;
      }
      if (found.pull.state !== 'open') {
        ctx.errors.push({ message: 'mergePullRequest: pull request is not open' });
        return null;
      }
      const result = ctx.store.squashMerge(found.repo, found.pull);
      if ('conflict' in result) {
        ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
        return null;
      }
      return resolveSelections(ctx, 'MergePullRequestPayload', { pullRequest: { repo: found.repo, pull: found.pull } }, sub);
    }
    if (sel.name === 'addComment') {
      const found = issueByGid(ctx.store, String(input.subjectId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'addComment: unknown subjectId' });
        return null;
      }
      const comments = found.repo.issueComments.get(found.issue.number) ?? [];
      const id = ++ctx.store.commentIdSeq;
      const comment = { id, body: String(input.body ?? ''), createdSeq: ctx.store.nextSeq() };
      comments.push(comment);
      found.repo.issueComments.set(found.issue.number, comments);
      return resolveSelections(ctx, 'AddCommentPayload', { commentEdge: { node: comment } }, sub);
    }
    return null;
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    const pair = (value as { issue: { repo: Repo; issue: Issue } }).issue;
    if (sel.name === 'issue') return resolveSelections(ctx, 'Issue', { __type: 'Issue', value: pair }, sub);
    return null;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    const pair = (value as { pullRequest: { repo: Repo; pull: Pull } }).pullRequest;
    if (sel.name === 'pullRequest') return resolveSelections(ctx, 'PullRequest', { __type: 'PullRequest', value: pair }, sub);
    return null;
  }
  if (typeName === 'AddCommentPayload') {
    if (sel.name === 'commentEdge') {
      const edge = (value as { commentEdge: { node: { id: number; body: string } } }).commentEdge;
      return resolveSelections(ctx, 'IssueCommentEdge', edge, sub);
    }
    return null;
  }
  if (typeName === 'IssueCommentEdge') {
    if (sel.name === 'node') {
      const node = (value as { node: { id: number; body: string } }).node;
      return resolveSelections(ctx, 'IssueComment', node, sub);
    }
    return null;
  }
  if (typeName === 'IssueComment') {
    const node = value as { id: number; body: string };
    if (sel.name === 'id') return gid('comment', node.id);
    if (sel.name === 'body') return node.body;
    return null;
  }

  return null;
}

function resolveConnection(ctx: Ctx, itemType: string, repo: Repo, conn: Record<string, unknown>, sub: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sub) {
    const key = sel.alias ?? sel.name;
    if (sel.name === 'nodes') {
      const nodes = conn.nodes as unknown[];
      out[key] = nodes.map((n) => {
        if (itemType === 'Issue') return resolveSelections(ctx, 'Issue', { __type: 'Issue', value: { repo, issue: n as Issue } }, sel.selections ?? []);
        if (itemType === 'PullRequest') return resolveSelections(ctx, 'PullRequest', { __type: 'PullRequest', value: { repo, pull: n as Pull } }, sel.selections ?? []);
        return resolveSelections(ctx, 'PullRequestChangedFile', n, sel.selections ?? []);
      });
    } else if (sel.name === 'edges') {
      const edges = conn.edges as Array<{ node: unknown; cursor: string }>;
      out[key] = edges.map((e) => {
        const edgeOut: Record<string, unknown> = {};
        for (const esel of sel.selections ?? []) {
          const ekey = esel.alias ?? esel.name;
          if (esel.name === 'node') {
            if (itemType === 'Issue') edgeOut[ekey] = resolveSelections(ctx, 'Issue', { __type: 'Issue', value: { repo, issue: e.node as Issue } }, esel.selections ?? []);
            else if (itemType === 'PullRequest') edgeOut[ekey] = resolveSelections(ctx, 'PullRequest', { __type: 'PullRequest', value: { repo, pull: e.node as Pull } }, esel.selections ?? []);
            else edgeOut[ekey] = resolveSelections(ctx, 'PullRequestChangedFile', e.node, esel.selections ?? []);
          } else if (esel.name === 'cursor') edgeOut[ekey] = e.cursor;
        }
        return edgeOut;
      });
    } else if (sel.name === 'pageInfo') {
      out[key] = resolveSelections(ctx, 'PageInfo', conn.pageInfo, sel.selections ?? []);
    } else if (sel.name === 'totalCount') {
      out[key] = conn.totalCount;
    }
  }
  return out;
}

export function executeGraphQL(store: Store, body: unknown): unknown {
  const docs = Array.isArray(body) ? body : [body];
  const results = docs.map((doc) => {
    if (doc === null || typeof doc !== 'object') return { errors: [{ message: 'expected an object' }] };
    const docObj = doc as Record<string, unknown>;
    const query = typeof docObj.query === 'string' ? docObj.query : '';
    const variables = (docObj.variables ?? {}) as Record<string, unknown>;
    const ctx: Ctx = { store, errors: [] };
    try {
      const operations = new Parser(query, variables).parseDocument();
      if (operations.length === 0) return { errors: [{ message: 'empty document' }] };
      const op = operations[0];
      const typeName = op.kind === 'mutation' ? 'Mutation' : 'Query';
      const data = resolveSelections(ctx, typeName, null, op.selections);
      const out: Record<string, unknown> = { data };
      if (ctx.errors.length) out.errors = ctx.errors;
      return out;
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  });
  return Array.isArray(body) ? results : results[0];
}
