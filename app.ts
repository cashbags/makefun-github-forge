// The forge's HTTP server: routing, auth, and the git smart-HTTP endpoints.
// REST lives in rest.ts, GraphQL in graphql.ts, MCP in mcp.ts, the store in store.ts.
// One rule for auth: every call carries `Authorization: Bearer <shop token>` except
// the /healthz boot probe. When MAKEFUN_SHOP_TOKEN is set (the trial sets it) the
// presented token must match it; when it is unset any non-empty token is the viewer.

import http from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import type { RequestContext, HandlerResult } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp, parseMcpBody } from './mcp.ts';
import {
  pktLine,
  FLUSH,
  parsePktLines,
  parseV2Commands,
  v0Advertisement,
  v2LsRefs,
  buildFetchResponse,
  buildV0FetchResponse,
  parseV0Fetch,
  handleReceivePack,
  allRefLines,
} from './git.ts';

const MAX_BODY = 64 * 1024 * 1024;

function jsonResponse(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(payload);
}

function requestId(counter: number): string {
  return `req-${counter}`;
}

function authorized(req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  if (!token) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected && expected.length > 0) return token === expected;
  return true;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): http.Server {
  const store = new Store();
  let counter = 0;

  const server = http.createServer(async (req, res) => {
    counter += 1;
    const rid = requestId(counter);
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      res.setHeader('X-GitHub-Request-Id', rid);

      if (method === 'GET' && path === '/healthz') {
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (!authorized(req)) {
        jsonResponse(res, 401, { message: 'Requires authentication' });
        return;
      }

      const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

      // ---- git smart HTTP -----------------------------------------------------
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const servicePath = gitMatch[3];
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          jsonResponse(res, 404, { message: 'Not Found' });
          return;
        }
        const protocolVersion = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
        if (method === 'GET' && servicePath === 'info/refs') {
          const service = url.searchParams.get('service') ?? '';
          const isUpload = service === 'git-upload-pack';
          const isReceive = service === 'git-receive-pack';
          if (!isUpload && !isReceive) {
            jsonResponse(res, 400, { message: 'service is required' });
            return;
          }
          const contentType = isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
          if (protocolVersion === 2 && isUpload) {
            const caps = [
              pktLine('version 2\n'),
              pktLine('ls-refs=unborn\n'),
              pktLine('fetch=shallow\n'),
              pktLine('object-format=sha1\n'),
              pktLine('agent=forge/1.0\n'),
              FLUSH,
            ];
            res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
            res.end(Buffer.concat(caps));
            return;
          }
          const lines = allRefLines(repo);
          const caps = isUpload
            ? 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack agent=forge/1.0'
            : 'symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0';
          res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
          res.end(v0Advertisement(service, lines, caps));
          return;
        }
        if (method === 'POST' && servicePath === 'git-upload-pack') {
          try {
            if (protocolVersion === 2) {
              const { command, args } = parseV2Commands(rawBody);
              if (command === 'ls-refs') {
                res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' });
                res.end(v2LsRefs(repo, args));
                return;
              }
              if (command === 'fetch') {
                res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' });
                res.end(buildFetchResponse(store, repo, args));
                return;
              }
              jsonResponse(res, 400, { message: `unknown command ${command}` });
              return;
            }
            const { wants, haves, shallow, deepen } = parseV0Fetch(rawBody);
            res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' });
            res.end(buildV0FetchResponse(store, repo, wants, haves, shallow, deepen));
            return;
          } catch (err) {
            jsonResponse(res, 400, { message: err instanceof Error ? err.message : 'malformed request' });
            return;
          }
        }
        if (method === 'POST' && servicePath === 'git-receive-pack') {
          try {
            res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-cache' });
            res.end(handleReceivePack(store, repo, rawBody));
            return;
          } catch (err) {
            jsonResponse(res, 400, { message: err instanceof Error ? err.message : 'malformed request' });
            return;
          }
        }
        jsonResponse(res, 404, { message: 'Not Found' });
        return;
      }

      // ---- MCP -----------------------------------------------------------------
      if (path === '/mcp') {
        if (method === 'DELETE') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (method !== 'POST') {
          jsonResponse(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const { request, parseErrorId } = parseMcpBody(rawBody);
        if (!request) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parseErrorId ?? null, error: { code: -32700, message: 'Parse error' } }));
          return;
        }
        if (!request.hasId) {
          // A notification: no JSON-RPC response body.
          handleMcp(store, request);
          res.writeHead(202);
          res.end();
          return;
        }
        const result = handleMcp(store, request);
        if (result.body === null) {
          res.writeHead(result.status);
          res.end();
          return;
        }
        jsonResponse(res, result.status, result.body);
        return;
      }

      // ---- GraphQL --------------------------------------------------------------
      if (method === 'POST' && path === '/api/graphql') {
        let body: unknown;
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          jsonResponse(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
          return;
        }
        jsonResponse(res, 200, executeGraphQL(store, body));
        return;
      }

      // ---- REST -----------------------------------------------------------------
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        let body: unknown = null;
        if (rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody.toString('utf8'));
          } catch {
            jsonResponse(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
        }
        const ctx: RequestContext = {
          store,
          method,
          path,
          query: url.searchParams,
          headers: req.headers as Record<string, string | undefined>,
          body,
          rawBody,
          baseUrl: `http://${req.headers.host ?? '127.0.0.1'}`,
        };
        let result: HandlerResult | null;
        try {
          result = handleRest(ctx);
        } catch (err) {
          jsonResponse(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
          return;
        }
        if (result === null) {
          jsonResponse(res, 404, { message: 'Not Found' });
          return;
        }
        if (result.raw !== undefined) {
          res.writeHead(result.status, { 'Content-Type': result.contentType ?? 'application/octet-stream', ...(result.headers ?? {}) });
          res.end(result.raw);
          return;
        }
        if (result.status === 204) {
          res.writeHead(204, result.headers ?? {});
          res.end();
          return;
        }
        jsonResponse(res, result.status, result.body, result.headers ?? {});
        return;
      }

      jsonResponse(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        jsonResponse(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      } else {
        res.end();
      }
    }
  });

  return server;
}
