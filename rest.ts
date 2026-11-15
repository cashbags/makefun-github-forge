// GitHub REST v3 API: repositories, branches, commits, contents, issues, labels,
// comments and pull requests. All of it reads from and writes to the shared Store,
// so the git, GraphQL and MCP surfaces see the same state.

import { parseCommit, parseTree, lineDiffCounts, ZERO_OID } from './store.ts';
import type { Repo, Store, Issue, Pull } from './store.ts';
import { VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL, DEFAULT_BRANCH } from './store.ts';

export interface RequestContext {
  store: Store;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: unknown;
  rawBody: Buffer;
  baseUrl: string;
}

export type HandlerResult = { status: number; headers?: Record<string, string>; body?: unknown; raw?: Buffer; contentType?: string };

function isoFromSeq(seq: number): string {
  return new Date(1700000000 * 1000 + seq * 1000).toISOString();
}

export function viewerUser(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: Buffer.from(`user:${VIEWER_ID}`, 'utf8').toString('base64'),
    avatar_url: `https://example.invalid/avatar/${VIEWER_LOGIN}`,
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER_LOGIN}`,
    html_url: `https://example.invalid/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

function repoJson(repo: Repo, store: Store): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`repo:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: Buffer.from(`user:${VIEWER_ID}`, 'utf8').toString('base64'), type: 'User' },
    html_url: `https://example.invalid/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: isoFromSeq(repo.createdSeq),
    updated_at: isoFromSeq(repo.createdSeq),
    pushed_at: isoFromSeq(repo.createdSeq),
    git_url: `git://example.invalid/${repo.fullName}.git`,
    ssh_url: `git@example.invalid:${repo.fullName}.git`,
    clone_url: `https://example.invalid/${repo.fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`issue:${repo.id}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000', description: null, default: false };
    }),
    assignee: null,
    assignees: [],
    locked: false,
    comments: (repo.issueComments.get(issue.number) ?? []).length,
    created_at: isoFromSeq(issue.createdSeq),
    updated_at: isoFromSeq(issue.createdSeq),
    closed_at: null,
    author_association: 'OWNER',
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`pr:${repo.id}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: [],
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, repo: { name: repo.name, full_name: repo.fullName } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: { name: repo.name, full_name: repo.fullName } },
    merged: pull.merged,
    mergeable: null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: isoFromSeq(pull.createdSeq),
    updated_at: isoFromSeq(pull.createdSeq),
    closed_at: pull.state === 'closed' ? (pull.mergedAt ?? isoFromSeq(pull.createdSeq)) : null,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

function bodyObj(ctx: RequestContext): Record<string, unknown> {
  if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) return {};
  return ctx.body as Record<string, unknown>;
}

function notFound(message = 'Not Found'): HandlerResult {
  return { status: 404, body: { message } };
}

function paginate<T>(items: T[], ctx: RequestContext, basePath: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const total = items.length;
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const makeUrl = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${ctx.baseUrl}${basePath}?${q.toString()}`;
  };
  if (start + perPage < total) links.push(`<${makeUrl(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) links.push(`<${makeUrl(pageNum - 1)}>; rel="prev"`);
  links.push(`<${makeUrl(Math.max(1, Math.ceil(total / perPage)))}>; rel="last"`);
  links.push(`<${makeUrl(1)}>; rel="first"`);
  headers.Link = links.join(', ');
  return { page, headers };
}

/** Resolve a ref name (branch) or oid to a commit oid, or undefined. */
function resolveRefCommit(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined) return repo.branchTip(repo.defaultBranch);
  const branchTip = repo.branchTip(ref);
  if (branchTip !== undefined) return branchTip;
  const refTip = repo.refs.get(ref);
  if (refTip !== undefined) return refTip;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = repo.objects.get(ref);
    if (obj && obj.type === 'commit') return ref;
  }
  return undefined;
}

/** Commits reachable from a tip, newest-first (parent walk, visited set). */
function commitsFromTip(store: Store, repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    queue.push(...parseCommit(obj.data).parents);
  }
  return out;
}

export function handleRest(ctx: RequestContext): HandlerResult | null {
  const { method, path } = ctx;
  const store = ctx.store;

  if (method === 'GET' && path === '/api/v3/') {
    return { status: 200, headers: { 'X-OAuth-Scopes': 'repo, read:org' }, body: { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' } };
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    return { status: 200, body: { installed_version: '1.0.0' } };
  }
  if (method === 'GET' && path === '/api/v3/user') {
    return { status: 200, body: viewerUser() };
  }

  // POST /api/v3/user/repos
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const body = bodyObj(ctx);
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name) return { status: 422, body: { message: 'name is required' } };
    if (store.getRepo(VIEWER_LOGIN, name)) return { status: 422, body: { message: 'Repository already exists' } };
    const repo = store.createRepo(VIEWER_LOGIN, name, typeof body.description === 'string' ? body.description : '', body.private === true);
    return { status: 201, body: repoJson(repo, store) };
  }
  // GET /api/v3/user/repos
  if (method === 'GET' && path === '/api/v3/user/repos') {
    const repos = store.listReposByOwner(VIEWER_LOGIN);
    const { page, headers } = paginate(repos, ctx, '/api/v3/user/repos');
    return { status: 200, headers, body: page.map((r) => repoJson(r, store)) };
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(path);
  if (!repoMatch) return null;
  const owner = decodeURIComponent(repoMatch[1]);
  const repoName = decodeURIComponent(repoMatch[2]);
  const rest = repoMatch[3] ?? '';
  const repo = store.getRepo(owner, repoName);

  // Repo-level routes that do not need an existing repo: none (all need the repo).
  if (!repo) return notFound('Not Found');

  // GET /repos/{o}/{r}
  if (method === 'GET' && rest === '') return { status: 200, body: repoJson(repo, store) };
  // PATCH /repos/{o}/{r}
  if (method === 'PATCH' && rest === '') {
    const body = bodyObj(ctx);
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.name === 'string' && body.name !== repo.name) {
      // Renaming is not exercised by the suite; keep the name stable.
      return { status: 422, body: { message: 'renaming is not supported' } };
    }
    return { status: 200, body: repoJson(repo, store) };
  }
  // DELETE /repos/{o}/{r}
  if (method === 'DELETE' && rest === '') {
    store.deleteRepo(owner, repoName);
    return { status: 204, body: undefined };
  }

  // Branches
  if (method === 'GET' && rest === '/branches') {
    const branches: Record<string, unknown>[] = [];
    for (const [ref, oid] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
    }
    branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { status: 200, body: branches };
  }
  const branchMatch = /^\/branches\/([^/]+)$/.exec(rest);
  if (method === 'GET' && branchMatch) {
    const branch = decodeURIComponent(branchMatch[1]);
    const tip = repo.branchTip(branch);
    if (tip === undefined) return notFound('Branch not found');
    return { status: 200, body: { name: branch, commit: { sha: tip }, protected: false } };
  }

  // Commits
  if (method === 'GET' && rest === '/commits') {
    const sha = ctx.query.get('sha') ?? undefined;
    const tip = resolveRefCommit(repo, sha);
    if (tip === undefined) return { status: 200, body: [] };
    const list = commitsFromTip(store, repo, tip).map((oid) => {
      const c = parseCommit(repo.objects.get(oid)!.data);
      return {
        sha: oid,
        commit: {
          message: c.message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoFromSeq(1) },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoFromSeq(1) },
        },
        author: { login: VIEWER_LOGIN, id: VIEWER_ID },
        committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
      };
    });
    return { status: 200, body: list };
  }

  // git refs
  if (method === 'POST' && rest === '/git/refs') {
    const body = bodyObj(ctx);
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref || !sha) return { status: 422, body: { message: 'ref and sha are required' } };
    if (repo.refs.has(ref)) return { status: 422, body: { message: 'Reference already exists' } };
    repo.refs.set(ref, sha);
    return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
  }
  const gitRefMatch = /^\/git\/refs\/(.+)$/.exec(rest);
  if (method === 'GET' && gitRefMatch) {
    const ref = decodeURIComponent(gitRefMatch[1]);
    const tip = repo.refs.get(ref);
    if (tip === undefined) return notFound('Reference not found');
    return { status: 200, body: { ref, object: { sha: tip, type: 'commit' } } };
  }

  // Labels
  if (method === 'POST' && rest === '/labels') {
    const body = bodyObj(ctx);
    const name = typeof body.name === 'string' ? body.name : '';
    const color = typeof body.color === 'string' ? body.color : '000000';
    if (!name) return { status: 422, body: { message: 'name is required' } };
    repo.labels.set(name, { name, color });
    return { status: 201, body: { name, color, description: null, default: false } };
  }
  if (method === 'GET' && rest === '/labels') {
    return { status: 200, body: [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: null, default: false })) };
  }

  // Contents
  if (rest.startsWith('/contents')) {
    const contentsPath = decodeURIComponent(rest.slice('/contents'.length).replace(/^\//, ''));
    return handleContents(ctx, repo, contentsPath);
  }

  // Issues
  if (rest === '/issues') {
    if (method === 'POST') {
      const body = bodyObj(ctx);
      const title = typeof body.title === 'string' ? body.title : '';
      const bodyText = typeof body.body === 'string' ? body.body : '';
      const labels = Array.isArray(body.labels) ? body.labels.filter((l) => typeof l === 'string') : [];
      const unknown = labels.filter((l) => !repo.labels.has(l));
      if (unknown.length) return { status: 422, body: { message: `unknown label: ${unknown[0]}` } };
      const issue = store.createIssue(repo, title, bodyText, labels);
      return { status: 201, body: issueJson(repo, issue) };
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      void sort;
      const { page, headers } = paginate(list, ctx, `/api/v3/repos/${owner}/${repoName}/issues`);
      return { status: 200, headers, body: page.map((i) => issueJson(repo, i)) };
    }
  }
  const issueMatch = /^\/issues\/(\d+)(\/.*)?$/.exec(rest);
  if (issueMatch) {
    const number = parseInt(issueMatch[1], 10);
    const sub = issueMatch[2] ?? '';
    const issue = repo.issues.get(number);
    if (!issue) return notFound('Issue not found');
    if (method === 'GET' && sub === '') return { status: 200, body: issueJson(repo, issue) };
    if (method === 'PATCH' && sub === '') {
      const body = bodyObj(ctx);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l) => typeof l === 'string');
        const unknown = labels.filter((l) => !repo.labels.has(l));
        if (unknown.length) return { status: 422, body: { message: `unknown label: ${unknown[0]}` } };
        issue.labels = labels;
      }
      return { status: 200, body: issueJson(repo, issue) };
    }
    if (sub === '/comments') {
      const comments = repo.issueComments.get(number) ?? [];
      if (method === 'POST') {
        const body = bodyObj(ctx);
        const text = typeof body.body === 'string' ? body.body : '';
        const id = ++store.commentIdSeq;
        const comment = { id, body: text, createdSeq: store.nextSeq() };
        comments.push(comment);
        repo.issueComments.set(number, comments);
        return {
          status: 201,
          body: { id, body: text, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: isoFromSeq(comment.createdSeq), updated_at: isoFromSeq(comment.createdSeq), html_url: `https://example.invalid/${repo.fullName}/issues/${number}#issuecomment-${id}`, url: `/api/v3/repos/${repo.fullName}/issues/comments/${id}` },
        };
      }
      if (method === 'GET') {
        return {
          status: 200,
          body: comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: isoFromSeq(c.createdSeq), updated_at: isoFromSeq(c.createdSeq) })),
        };
      }
    }
  }

  // Pulls
  if (rest === '/pulls') {
    if (method === 'POST') {
      const body = bodyObj(ctx);
      const title = typeof body.title === 'string' ? body.title : '';
      const bodyText = typeof body.body === 'string' ? body.body : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      const headSha = repo.branchTip(head);
      const baseSha = repo.branchTip(base);
      if (headSha === undefined || baseSha === undefined) return { status: 422, body: { message: 'head or base branch not found' } };
      const pull = store.createPull(repo, title, bodyText, head, base, headSha, baseSha);
      return { status: 201, body: pullJson(repo, pull) };
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, headers } = paginate(list, ctx, `/api/v3/repos/${owner}/${repoName}/pulls`);
      return { status: 200, headers, body: page.map((p) => pullJson(repo, p)) };
    }
  }
  const pullMatch = /^\/pulls\/(\d+)(\/.*)?$/.exec(rest);
  if (pullMatch) {
    const number = parseInt(pullMatch[1], 10);
    const sub = pullMatch[2] ?? '';
    const pull = repo.pulls.get(number);
    if (!pull) return notFound('Pull request not found');
    if (method === 'GET' && sub === '') return { status: 200, body: pullJson(repo, pull) };
    if (method === 'GET' && sub === '/files') {
      const headObj = repo.objects.get(pull.headSha);
      const baseObj = repo.objects.get(pull.baseSha);
      if (!headObj || !baseObj) return { status: 200, body: [] };
      const headTree = parseCommit(headObj.data).tree;
      const baseTree = parseCommit(baseObj.data).tree;
      const diff = store.diffTrees(repo, baseTree, headTree);
      const files = diff.map((d) => {
        let additions = 0;
        let deletions = 0;
        const oldText = d.oldOid === null ? '' : (repo.objects.get(d.oldOid)?.data.toString('utf8') ?? '');
        const newText = d.newOid === null ? '' : (repo.objects.get(d.newOid)?.data.toString('utf8') ?? '');
        if (d.status === 'added') additions = newText === '' ? 0 : newText.split('\n').length;
        else if (d.status === 'removed') deletions = oldText === '' ? 0 : oldText.split('\n').length;
        else {
          const counts = lineDiffCounts(oldText, newText);
          additions = counts.additions;
          deletions = counts.deletions;
        }
        return { filename: d.path, status: d.status, additions, deletions, changes: additions + deletions };
      });
      return { status: 200, body: files };
    }
    if (method === 'PUT' && sub === '/merge') {
      if (pull.state !== 'open') return { status: 405, body: { message: 'Pull request is not open' } };
      const result = store.squashMerge(repo, pull);
      if ('conflict' in result) return { status: 405, body: { message: 'Merge conflict' } };
      return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull request successfully merged' } };
    }
  }

  return null;
}

function handleContents(ctx: RequestContext, repo: Repo, contentsPath: string): HandlerResult {
  const { method, store } = ctx;
  const refParam = ctx.query.get('ref') ?? undefined;

  if (method === 'GET') {
    const tip = resolveRefCommit(repo, refParam);
    if (tip === undefined) return notFound('Not Found');
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return notFound('Not Found');
    const treeOid = parseCommit(commit.data).tree;
    const files = store.treeToMap(repo, treeOid);
    if (contentsPath === '') {
      // Root listing: real entries from the root tree.
      const rootObj = repo.objects.get(treeOid);
      const entries: Record<string, unknown>[] = [];
      if (rootObj) {
        for (const entry of parseTree(rootObj.data)) {
          entries.push({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: entry.name,
            sha: entry.oid,
            ...(entry.mode === '40000' ? {} : { encoding: 'base64', size: repo.objects.get(entry.oid)?.data.length ?? 0 }),
          });
        }
      }
      entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { status: 200, body: entries };
    }
    const file = files.get(contentsPath);
    if (file) {
      const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
      return {
        status: 200,
        body: { type: 'file', encoding: 'base64', size: data.length, name: contentsPath.split('/').pop(), path: contentsPath, content: data.toString('base64'), sha: file.oid },
      };
    }
    // Directory: navigate to the subtree and list its real entries.
    const segments = contentsPath.split('/');
    let currentTree = treeOid;
    let found = true;
    for (const seg of segments) {
      const obj = repo.objects.get(currentTree);
      if (!obj) {
        found = false;
        break;
      }
      const entry = parseTree(obj.data).find((e) => e.name === seg && e.mode === '40000');
      if (!entry) {
        found = false;
        break;
      }
      currentTree = entry.oid;
    }
    if (found) {
      const obj = repo.objects.get(currentTree);
      if (obj) {
        const entries: Record<string, unknown>[] = parseTree(obj.data).map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: `${contentsPath}/${entry.name}`,
          sha: entry.oid,
          ...(entry.mode === '40000' ? {} : { encoding: 'base64', size: repo.objects.get(entry.oid)?.data.length ?? 0 }),
        }));
        entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return { status: 200, body: entries };
      }
    }
    return notFound('Not Found');
  }

  if (method === 'PUT') {
    const body = bodyObj(ctx);
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    if (!contentB64) return { status: 422, body: { message: 'content is required' } };
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return { status: 400, body: { message: 'content is not valid base64' } };
    }
    let tip = repo.branchTip(branch);
    if (tip === undefined) {
      // Create the branch at the default branch tip (or unborn if the repo is empty).
      const baseTip = repo.branchTip(repo.defaultBranch);
      if (baseTip !== undefined) {
        repo.refs.set(`refs/heads/${branch}`, baseTip);
        tip = baseTip;
      }
    }
    const existing = tip !== undefined ? store.treeToMap(repo, parseCommit(repo.objects.get(tip)!.data).tree).get(contentsPath) : undefined;
    if (existing !== undefined) {
      if (sha === undefined || sha !== existing.oid) return { status: 409, body: { message: 'sha does not match the current file' } };
    }
    const blobOid = repo.putObject('blob', content);
    const files = tip !== undefined ? store.treeToMap(repo, parseCommit(repo.objects.get(tip)!.data).tree) : new Map();
    files.set(contentsPath, { oid: blobOid, mode: '100644' });
    const treeOid = store.mapToTree(repo, files);
    const parents = tip !== undefined ? [tip] : [];
    const commitOid = store.makeCommit(repo, treeOid, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    const isCreate = existing === undefined;
    return {
      status: isCreate ? 201 : 200,
      body: {
        content: { name: contentsPath.split('/').pop(), path: contentsPath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitOid, message },
      },
    };
  }

  if (method === 'DELETE') {
    const body = bodyObj(ctx);
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = repo.branchTip(branch);
    if (tip === undefined) return notFound('Not Found');
    const files = store.treeToMap(repo, parseCommit(repo.objects.get(tip)!.data).tree);
    const existing = files.get(contentsPath);
    if (existing === undefined) return notFound('Not Found');
    if (sha !== undefined && sha !== existing.oid) return { status: 409, body: { message: 'sha does not match the current file' } };
    files.delete(contentsPath);
    const treeOid = store.mapToTree(repo, files);
    const commitOid = store.makeCommit(repo, treeOid, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { status: 200, body: { commit: { sha: commitOid, message } } };
  }

  return { status: 405, body: { message: 'Method Not Allowed' } };
}
