# Tests — github-core-clone-01

Entry: `~/workspace/makefun/bounties/github-core-clone-01/entry/`
Kit: `~/workspace/makefun/bounties/github-core-clone-01/unpacked/github-core-clone-01-kit/`
Node: `~/workspace/makefun/node22/bin/node` v22.18.0 (shell Node is v24.22.1; the
competition needs Node major 22 exactly, so the local binary is used for every run).

## 1. Local conformance suite (`sdk/run.ts`, the kit's own runner)

Server: `serve.ts` (in the bounty dir, not part of the entry) runs `createApp()` on
`http://127.0.0.1:18181`. Runner: `node --experimental-strip-types sdk/run.ts
--url http://127.0.0.1:18181 --token test-token [--perf] --json`, fresh server per run
(the store is in-memory, so a re-run against a used server fails on duplicate names).

| Run | Conformance | Feature | Agent | Perf | Score |
| --- | --- | --- | --- | --- | --- |
| 1 (before fixes) | 109/120 | 545 | 200 | — | 745 |
| 2 (after 6 fixes) | **120/120** | 600 | 200 | — | 800 |
| 3 (`--perf`, stale server) | 36/120 | 180 | 120 | 29 | 329 |
| 4 (`--perf`, fresh server) | **120/120** | 600 | 200 | 93 | 893 |
| 5 (`--perf`, after deflate-level + oid fixes) | **120/120** | 600 | 200 | 96 | 896 |
| 6 (`--perf`, after compressed-object cache) | **120/120** | 600 | 200 | 136 | **936** |
| 7 (`--perf`, fresh server, confirm) | **120/120** | 600 | 200 | 120 | **920** |

Run 3 is not a regression: it re-used the server from run 2, so the suite's deterministic
repo names already existed (POST /user/repos → 422). Runs 6–7 are the real numbers:
**120/120 conformance, score 920–936**. The reference forge scores ~900 by construction
(600 + 200 + 100 perf, since T_ref is its own median), so this entry is above it.

Per-workload perf (runs 6 / 7, T_ref in brackets):

| Workload | p50 run 6 | p50 run 7 | T_ref | Points run 6 / 7 |
| --- | --- | --- | --- | --- |
| push (200 × 1 KiB pushes) | 991.6 ms | 1020.0 ms | 1640.82 ms | 34 / 34 |
| clone (50 concurrent shallow clones) | 237.3 ms | 241.4 ms | 266.94 ms | 27 / 27 |
| read (2,000 sequential issue GETs) | 1388.9 ms | 1748.4 ms | 2759.72 ms | 37 / 33 |
| write (200 sequential issue creates) | 165.3 ms | 338.4 ms | 348.97 ms | 38 / 26 |

Read/write vary run to run (shared-VM CPU noise); push and clone are stable.

## 2. Bugs found by the suite and fixed

| Check | Root cause | Fix |
| --- | --- | --- |
| `git.ls-refs-prefix` | HEAD line returned even when a `ref-prefix` was given; only the first prefix was honoured | `v2LsRefs`: a ref (incl. HEAD) is listed only if it matches any prefix |
| `git.clone-annotated-tag` | `closureOf` never included a wanted tag object (only commits) | `computeFetch` peels tag wants to their commit and forces the tag objects into the pack |
| `git.fetch-shallow-depth1`, `git.fetch-shallow-deepen` | `closureOf` followed commit parents, so a depth-1 fetch carried the whole history | `closureOf` adds a commit's tree/blobs only; which commits are sent is decided by the want/have walk |
| `git.push-100-files` | sideband chunk 65,519 B + band byte + length = 65,524 > 65,520 pkt-line max | chunk pack pieces to 65,515 B |
| `repos.commits` | server-made commits got a trailing `\n` appended to the message; REST echoes it verbatim | `makeCommit` stores the message exactly as given |
| `pulls.merge-conflict` | conflict detection used the PR's stored (stale) base sha instead of the current base tip | `squashMerge`/`mergeable` re-resolve the current head/base tips at merge time |
| `graphql.pull-requests-list` etc. (4) | same ls-refs-prefix bug: the env's git fixture lists two prefixes (`refs/heads/<branch>`, `refs/heads/main`) and only the first was honoured, so `main` looked missing | same fix as `git.ls-refs-prefix` |

## 3. Performance work

- In-process profile of a shallow fetch of a 200-commit repo (tip tree 200 × 1 KiB files):
  `computeFetch` 1.08 ms, `writePack` 5.91 ms, `buildFetchResponse` 10.83 ms per call.
  `writePack` was dominated by per-call `deflateSync` overhead (202 objects).
- Fix: deflate level 1, and cache the compressed form on the immutable `GitObject`
  (first pack pays, every later pack reuses it). After: `writePack` 0.21 ms,
  `buildFetchResponse` 1.63 ms. Clone workload 17 → 27 points.

## 4. Kit check (`cli/makefun.mjs check`)

Run from the unpacked kit, Node 22:
`node cli/makefun.mjs check --kit . --repo <entry>` (no `--transcripts`; the parent
bundles transcripts at submit time).

Result: **6 passed, 1 failed, 13 skipped, 5 checked at submission.**
Passes: competition_open, snapshot (12 files, 131,355 bytes), license_osi (MIT),
entrypoint (main.ts selects node22), entry_size, committed_provider_key.
Fail (expected locally): `transcripts_present` — no bundle was passed.
Skips: prerequisites (PATH node is v24, not 22 — the entry itself selects node22),
strategy_note, committed_secret, and all transcript-dependent checks.
At submission: repo_public, repo_owner, repo_created_after_open, commit_in_repo,
duplicate_snapshot — evaluated by the site from the pushed repo + commit.
Full output is in CHECK.md.

## 5. Smoke test

`curl http://127.0.0.1:18181/healthz` → `{"ok":true}`.
`GET /api/v3/` without a token → 401; with `Authorization: Bearer test-token` → 200
with `X-OAuth-Scopes: repo, read:org`. `GET /api/v3/meta` → `{"installed_version":"1.0.0"}`.
