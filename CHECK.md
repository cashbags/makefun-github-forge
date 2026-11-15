# Kit check — github-core-clone-01

Command (from the unpacked kit, Node 22, no `--transcripts` — the parent bundles
transcripts at submit time):

```sh
node cli/makefun.mjs check --kit . --repo ~/workspace/makefun/bounties/github-core-clone-01/entry
```

## Result: 6 passed, 1 failed, 13 skipped, 5 checked at submission

| Check | Result | Detail |
| --- | --- | --- |
| prerequisites | skip | PATH node is v24, not 22 (the entry itself selects node22; the local Node 22 binary is `~/workspace/makefun/node22/bin/node` v22.18.0) |
| competition_open | pass | now is between opening 2026-11-14T06:30:00Z and deadline 2026-11-21T06:30:00Z |
| snapshot | pass | 14 files, 139,882 bytes at worktree@820fa3a52d48 (caps: 100 MiB/file, 100,000 entries, 1 GiB archive, 512 MiB repo) — re-checked after TESTS.md and CHECK.md were added |
| license_osi | pass | LICENSE declares SPDX-License-Identifier: MIT, OSI-approved |
| entrypoint | pass | main.ts at the root selects node22, which github-core-clone-01 accepts |
| strategy_note | skip | github-core-clone-01 does not ask for a strategy note |
| entry_size | pass | 14 regular files, 139,882 bytes (at most 16,777,216); largest graphql.ts 30,969 bytes (at most 8,388,608 a file) |
| committed_provider_key | pass | no model provider API key in its text files |
| committed_secret | skip | no --env-file given |
| transcripts_present | **FAIL** | no transcripts were uploaded — expected locally; the parent bundles the agent sessions at submit time |
| transcripts_recorded | skip | no transcript session parsed (transcripts_present) |
| thinking_wellformed | skip | no transcript session parsed |
| thinking_in_window | skip | no transcript session parsed |
| thinking_committed | skip | the entry is not signed |
| thinking_reproduces | skip | no transcript session parsed |
| thinking_on_task | skip | no transcript session parsed |
| thinking_turns | skip | no transcript session parsed |
| thinking_priced | skip | no transcript session parsed |
| thinking_revised | skip | no transcript session parsed |
| thinking_fresh | skip | no transcript session parsed |
| repo_public | at submission | the site reads the repository from GitHub when you submit: it must be public then |
| repo_owner | at submission | GitHub owner must be the account's GitHub login, or the commit must carry `.makefun/owner.json` naming one of the account's entry wallets — this entry carries `.makefun/owner.json` with wallet `4vJXnxMrsBrtXoHRWkDUXh2ydserPugEKeDyF7CPMB8L` |
| repo_created_after_open | at submission | GitHub creation time must be at or after 2026-11-14T06:30:00Z |
| commit_in_repo | at submission | the submitted commit must be pushed to a branch of the repository |
| duplicate_snapshot | at submission | the files must differ from every other account's earlier entry |

Note: the first check ran before TESTS.md and CHECK.md were added (12 files, 131,355 bytes,
worktree@466ab09ef407). Re-checked after they were added: 14 files, 139,882 bytes,
worktree@820fa3a52d48 — same verdict (6 passed, 1 failed transcripts_present, 13 skipped,
5 at submission).
