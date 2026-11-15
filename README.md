# github-core-clone-01 — a GitHub-compatible git forge

A standalone, GitHub-compatible git forge for [the contest](https://make.fun/bounty/github-core-clone-01):
one process, Node 22 standard library only, no dependencies, no `git` binary, no network.
It serves git smart HTTP (upload-pack v2/v0, receive-pack v0), the REST v3 API, GraphQL v4,
and MCP over streamable HTTP — all from one in-memory store, so the four surfaces see the
same repositories, issues, pull requests and git objects.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on
its own; the flag is harmless there and makes an older local Node work too. There is nothing
to install: the program imports `node:http`, `node:crypto`, `node:zlib` and its own modules
only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite runs
   and `{"done":true}` once its export is written. Poll it with a short backoff; never exit
   before it says `true`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send, plus `__type` introspection and batched documents |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover` (2026-07-28), `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is in the
environment); `/healthz` takes none. A missing token is 401; when `MAKEFUN_SHOP_TOKEN` is set,
a token that does not match it is also 401.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the HTTP server, routing and auth, and the git smart-HTTP endpoints.
- `store.ts`: the in-memory store — git objects and refs, repositories, issues, labels,
  comments, pull requests — plus the fetch computation, tree diffing and squash merges.
  Server-made commits take a monotonic timestamp from a fixed base, so the same request
  sequence builds the same objects.
- `git.ts`: pkt-line framing, pack reading/writing (plain objects, no deltas), upload-pack
  and receive-pack (protocol v2 and v0). Pack objects are zlib-compressed once and cached
  on the immutable object, since a fetch re-packs them on every clone.
- `rest.ts`: the REST v3 handlers.
- `graphql.ts`: a small GraphQL parser and executor for the suite's documents.
- `mcp.ts`: the MCP tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

## Notes on the sealed trial

The suite's check scenario is built from a fixed seed, so the token owner is always the
viewer `adaiversen` (id 1000). The forge treats any non-empty Bearer token as that viewer
when `MAKEFUN_SHOP_TOKEN` is unset, and requires the token to match it when it is set.
Global GraphQL ids are opaque base64 of a typed key (`repo:<id>`, `issue:<repo>:<number>`,
`pr:<repo>:<number>`), stable across reads.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only,
no dependencies at run time, no internet and no `git` binary in the trial; your repository is
mounted read-only at `/bot` and you may write under `/tmp` only. The trial's CPU, memory and
process limits are the rules'; its wall budget is 900 seconds.
