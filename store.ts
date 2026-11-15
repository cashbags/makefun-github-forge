// The forge's in-memory store: git objects and refs plus the REST/GraphQL/MCP resources
// (repositories, issues, labels, comments, pull requests) that all four surfaces share.
// Nothing here touches the disk or the clock: server-made commits take a monotonic
// timestamp from a fixed base, so the same request sequence builds the same objects.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
  /** Lazily computed zlib stream, cached: objects are immutable and are packed on
   *  every fetch, so the first pack pays the deflate cost and the rest reuse it. */
  compressed?: Buffer;
}

export function sha1Object(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const headers = new Map<string, string>();
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message,
  };
}

// ---------------------------------------------------------------------------------------------

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  issueComments = new Map<number, Comment[]>();
  pulls = new Map<number, Pull>();
  issueSeq = 0;
  pullSeq = 0;
  createdSeq: number;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, createdSeq: number) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = DEFAULT_BRANCH;
    this.createdSeq = createdSeq;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = sha1Object(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }
}

export class Store {
  repos = new Map<string, Repo>();
  repoIdSeq = 0;
  issueIdSeq = 0;
  commentIdSeq = 0;
  pullIdSeq = 0;
  seq = 0;
  /** Monotonic commit timestamp, from a fixed base: deterministic across runs. */
  commitClock = 1700000000;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextCommitTimestamp(): number {
    this.commitClock += 1;
    return this.commitClock;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    this.repoIdSeq += 1;
    const repo = new Repo(this.repoIdSeq, owner, name, description, isPrivate, this.nextSeq());
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // ---- git object helpers ---------------------------------------------------

  /** Flatten a tree into path -> {oid, mode}, recursively. */
  treeToMap(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (nested) trees from a flat path map; stores the tree objects; returns the root tree oid. */
  mapToTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, file] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return repo.putObject('tree', buildTreeData(entries));
    };
    return build(root);
  }

  /** Diff two trees (flat path maps): added / modified / removed entries. */
  diffTrees(
    repo: Repo,
    baseTree: string | null,
    headTree: string | null,
  ): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
    const base = baseTree === null ? new Map() : this.treeToMap(repo, baseTree);
    const head = headTree === null ? new Map() : this.treeToMap(repo, headTree);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    for (const [path, file] of head) {
      const old = base.get(path);
      if (!old) out.push({ path, status: 'added', oldOid: null, newOid: file.oid });
      else if (old.oid !== file.oid) out.push({ path, status: 'modified', oldOid: old.oid, newOid: file.oid });
    }
    for (const [path, file] of base) {
      if (!head.has(path)) out.push({ path, status: 'removed', oldOid: file.oid, newOid: null });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /** Create a commit object (stored) and return its oid. */
  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const ts = this.nextCommitTimestamp();
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
    const lines = [`tree ${tree}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    // The message is stored exactly as given: the REST view echoes it verbatim.
    return repo.putObject('commit', Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8'));
  }

  /** All commits reachable from `tip` (parents walk). */
  reachableCommits(repo: Repo, tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [...tips];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
    return seen;
  }

  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    return this.reachableCommits(repo, [desc]).has(anc);
  }

  /** A common ancestor of a and b (first found by BFS from a that is reachable from b), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromB = this.reachableCommits(repo, [b]);
    const queue: string[] = [a];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (fromB.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    }
    return null;
  }

  /** Full object closure of commits (commits + their trees + blobs, tags peeled).
   *  Commit parents are NOT followed: which commits are sent is decided by the
   *  want/have walk in computeFetch; the closure only adds each commit's tree. */
  closureOf(repo: Repo, commitOids: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const queue: string[] = [...commitOids];
    while (queue.length) {
      const oid = queue.pop()!;
      if (out.has(oid) || oid === ZERO_OID) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        queue.push(c.tree);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
      }
    }
    return out;
  }

  /**
   * Compute a fetch: objects to send, and the new shallow boundary.
   * wants: tip oids; haves: oids the client holds; shallow: the client's current shallow
   * boundary commits; depth: max generations from the wants (undefined = unlimited).
   */
  computeFetch(
    repo: Repo,
    wants: string[],
    haves: string[],
    shallow: string[],
    depth: number | undefined,
  ): { objectOids: Set<string>; newShallow: string[]; unshallow: string[] } {
    const shallowSet = new Set(shallow);
    // Peel tag wants to their target commit; the tag objects themselves are sent.
    const forcedObjects = new Set<string>();
    const peeledWants: string[] = [];
    for (const want of wants) {
      let oid = want;
      while (true) {
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'tag') break;
        forcedObjects.add(oid);
        oid = parseTag(obj.data).object;
      }
      peeledWants.push(oid);
    }
    // Commits reachable from wants within `depth` generations.
    const wantCommits = new Set<string>();
    {
      const queue: Array<{ oid: string; d: number }> = peeledWants.filter((w) => w !== ZERO_OID).map((oid) => ({ oid, d: 0 }));
      const seen = new Set<string>();
      while (queue.length) {
        const { oid, d } = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        wantCommits.add(oid);
        if (depth === undefined || d + 1 < depth) {
          for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, d: d + 1 });
        }
      }
    }
    // Commits the client already has: reachable from haves, not crossing the shallow boundary.
    const haveCommits = new Set<string>();
    {
      const queue: string[] = haves.filter((h) => h !== ZERO_OID);
      while (queue.length) {
        const oid = queue.pop()!;
        if (haveCommits.has(oid)) continue;
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        haveCommits.add(oid);
        if (shallowSet.has(oid)) continue; // the client lacks this commit's parents
        for (const p of parseCommit(obj.data).parents) queue.push(p);
      }
    }
    const sentCommits = new Set<string>();
    for (const oid of wantCommits) if (!haveCommits.has(oid)) sentCommits.add(oid);
    const wantObjects = this.closureOf(repo, sentCommits);
    const haveObjects = this.closureOf(repo, haveCommits);
    const sendOids = new Set<string>();
    for (const oid of wantObjects) if (!haveObjects.has(oid)) sendOids.add(oid);
    for (const oid of forcedObjects) if (!haveObjects.has(oid)) sendOids.add(oid);
    const heldCommits = new Set([...haveCommits, ...sentCommits]);
    const newShallow: string[] = [];
    for (const oid of sentCommits) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => !heldCommits.has(p))) newShallow.push(oid);
    }
    const unshallow: string[] = [];
    for (const oid of shallow) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((p) => heldCommits.has(p))) unshallow.push(oid);
    }
    // A boundary that stays shallow (its parents still unknown) is re-announced.
    const stillShallow: string[] = [];
    for (const oid of shallow) {
      if (unshallow.includes(oid)) continue;
      if (!haveCommits.has(oid) && !sentCommits.has(oid)) continue;
      stillShallow.push(oid);
    }
    return { objectOids: sendOids, newShallow: [...new Set([...newShallow, ...stillShallow])], unshallow };
  }

  // ---- issues / pulls ---------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    repo.issueSeq += 1;
    this.issueIdSeq += 1;
    const issue: Issue = { id: this.issueIdSeq, number: repo.issueSeq, title, body, state: 'open', labels: [...labels], createdSeq: this.nextSeq() };
    repo.issues.set(issue.number, issue);
    repo.issueComments.set(issue.number, []);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    repo.pullSeq += 1;
    this.pullIdSeq += 1;
    const pull: Pull = {
      id: this.pullIdSeq,
      number: repo.pullSeq,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /**
   * Squash-merge a pull request: one commit on the base branch whose tree is the head's tree.
   * The base and head are re-resolved to their current tips at merge time (the pull's
   * stored shas are from creation, and the base may have moved since).
   * Returns {sha} on success, or {conflict: true} when both sides changed the same path.
   */
  squashMerge(repo: Repo, pull: Pull): { sha: string } | { conflict: true } {
    const headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
    const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseSha;
    const headObj = repo.objects.get(headSha);
    const baseObj = repo.objects.get(baseSha);
    if (!headObj || headObj.type !== 'commit' || !baseObj || baseObj.type !== 'commit') return { conflict: true };
    const base = this.mergeBase(repo, headSha, baseSha);
    const headTree = parseCommit(headObj.data).tree;
    const baseTree = parseCommit(baseObj.data).tree;
    if (base !== null) {
      const baseObj2 = repo.objects.get(base);
      if (baseObj2 && baseObj2.type === 'commit') {
        const mergeBaseTree = parseCommit(baseObj2.data).tree;
        const headDiff = this.diffTrees(repo, mergeBaseTree, headTree);
        const baseDiff = this.diffTrees(repo, mergeBaseTree, baseTree);
        const baseChanged = new Map(baseDiff.map((d) => [d.path, d]));
        for (const change of headDiff) {
          const other = baseChanged.get(change.path);
          if (other && other.newOid !== change.newOid) return { conflict: true };
        }
      }
    }
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const sha = this.makeCommit(repo, headTree, [baseSha], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.headSha = headSha;
    pull.baseSha = baseSha;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(1700000000 * 1000 + this.nextSeq() * 1000).toISOString();
    pull.mergeCommitSha = sha;
    return { sha };
  }

  /** Whether merging this pull would conflict (same computation as squashMerge, read-only). */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
    const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseSha;
    const headObj = repo.objects.get(headSha);
    const baseObj = repo.objects.get(baseSha);
    if (!headObj || !baseObj) return 'UNKNOWN';
    if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
    const base = this.mergeBase(repo, headSha, baseSha);
    if (base === null) return 'UNKNOWN';
    const headTree = parseCommit(headObj.data).tree;
    const baseTree = parseCommit(baseObj.data).tree;
    const baseObj2 = repo.objects.get(base);
    if (!baseObj2 || baseObj2.type !== 'commit') return 'UNKNOWN';
    const mergeBaseTree = parseCommit(baseObj2.data).tree;
    const headDiff = this.diffTrees(repo, mergeBaseTree, headTree);
    const baseDiff = this.diffTrees(repo, mergeBaseTree, baseTree);
    const baseChanged = new Map(baseDiff.map((d) => [d.path, d]));
    for (const change of headDiff) {
      const other = baseChanged.get(change.path);
      if (other && other.newOid !== change.newOid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }
}

/** A simple line diff (LCS) for pull-request file change counts. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += n - i;
  additions += m - j;
  return { additions, deletions };
}
