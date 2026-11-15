// git smart HTTP: pkt-line framing, pack reading/writing, upload-pack and
// receive-pack (protocol v2 and v0), using only node:zlib / node:crypto.
// Deliberately no delta encoding: the client's pack writer sends plain objects
// only, and every check accepts a plain pack.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { sha1Object, parseCommit, parseTag, parseTree, ZERO_OID } from './store.ts';
import type { GitObject, GitObjectType, Repo, Store } from './store.ts';

// ---- pkt-lines ----------------------------------------------------------------

export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const len = body.length + 4;
  const prefix = Buffer.alloc(4);
  prefix.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'flush' | 'delim' | 'data';
  payload: Buffer;
}

/** Split a buffer into pkt-line frames. Throws on malformed framing. */
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > buf.length) throw new Error('truncated pkt-line');
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

/** Parse a sideband stream: split the payload of each packet into bands 1/2/3. */
export function parseSideband(buf: Buffer): { band1: Buffer[]; band2: Buffer[]; band3: Buffer[]; raw: Pkt[] } {
  const raw = parsePktLines(buf);
  const band1: Buffer[] = [];
  const band2: Buffer[] = [];
  const band3: Buffer[] = [];
  for (const pkt of raw) {
    if (pkt.kind !== 'data') continue;
    const band = pkt.payload[0];
    const body = pkt.payload.subarray(1);
    if (band === 1) band1.push(body);
    else if (band === 2) band2.push(body);
    else if (band === 3) band3.push(body);
    else band1.push(pkt.payload); // a plain (non-sideband) data packet
  }
  return { band1, band2, band3, raw };
}

export function sidebandPacket(band: number, data: Buffer): Buffer {
  const framed = Buffer.concat([Buffer.from([band]), data]);
  const len = framed.length + 4;
  const prefix = Buffer.alloc(4);
  prefix.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, framed]);
}

export function pktLinesForObjectIds(ids: Iterable<string>): Buffer[] {
  const out: Buffer[] = [];
  for (const id of ids) out.push(pktLine(`${id}\n`));
  return out;
}

// ---- pack ---------------------------------------------------------------------

const PACK_MAGIC = Buffer.from('PACK', 'ascii');

function encodeObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeNum: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const bytes: number[] = [];
  let first = (typeNum[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a pack (version 2, plain objects, no deltas) with its SHA-1 trailer.
 *  Entries are the store's own GitObjects: the compressed form is cached on them. */
export function writePack(entries: GitObject[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  PACK_MAGIC.copy(header, 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  chunks.push(header);
  for (const entry of entries) {
    chunks.push(encodeObjectHeader(entry.type, entry.data.length));
    // Level 1: the pack is a wire format, not an archive — speed beats size here.
    // The compressed form is cached on the object: it is immutable and packed often.
    if (entry.compressed === undefined) entry.compressed = deflateSync(entry.data, { level: 1 });
    chunks.push(entry.compressed);
  }
  const pack = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(pack).digest();
  return Buffer.concat([pack, trailer]);
}

/** Read a pack (version 2). Supports plain objects and OFS/REF deltas. */
export function readPack(buf: Buffer): Array<{ oid: string; type: GitObjectType; data: Buffer }> {
  if (buf.length < 32) throw new Error('pack too short');
  if (!buf.subarray(0, 4).equals(PACK_MAGIC)) throw new Error('not a pack');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  let offset = 12;
  const entries: Array<{ oid: string; type: GitObjectType; data: Buffer }> = [];
  const byOffset = new Map<number, { oid: string; type: GitObjectType; data: Buffer }>();
  const typeNames: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = buf[offset];
    offset += 1;
    const typeNum = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) {
      // OFS_DELTA: read the offset delta base.
      let b2 = buf[offset];
      offset += 1;
      let baseOffset = b2 & 0x7f;
      while (b2 & 0x80) {
        b2 = buf[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (b2 & 0x7f);
      }
      const baseEntry = byOffset.get(start - baseOffset);
      if (!baseEntry) throw new Error('ofs-delta base not found');
      const len = deflateLength(buf, offset);
      const delta = inflateSync(buf.subarray(offset, offset + len));
      offset += len;
      const data = applyDelta(baseEntry.data, delta);
      const oid = sha1Object(baseEntry.type, data);
      const entry = { oid, type: baseEntry.type, data };
      entries.push(entry);
      byOffset.set(start, entry);
    } else if (typeNum === 7) {
      // REF_DELTA: 20-byte base oid.
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const len = deflateLength(buf, offset);
      const delta = inflateSync(buf.subarray(offset, offset + len));
      offset += len;
      const baseEntry = entries.find((e) => e.oid === baseOid);
      if (!baseEntry) throw new Error('ref-delta base not found');
      const data = applyDelta(baseEntry.data, delta);
      const oid = sha1Object(baseEntry.type, data);
      const entry = { oid, type: baseEntry.type, data };
      entries.push(entry);
      byOffset.set(start, entry);
    } else {
      const type = typeNames[typeNum];
      if (!type) throw new Error(`unknown pack object type ${typeNum}`);
      const len = deflateLength(buf, offset);
      const data = inflateSync(buf.subarray(offset, offset + len));
      offset += len;
      const oid = sha1Object(type, data);
      const entry = { oid, type, data };
      entries.push(entry);
      byOffset.set(start, entry);
    }
  }
  return entries;
}

/** Number of compressed bytes consumed by the deflate stream starting at `start`.
 *  inflateSync fails on a truncated stream and ignores trailing bytes after a
 *  complete one, so the smallest succeeding prefix is exactly the stream end. */
function deflateLength(buf: Buffer, start: number): number {
  let lo = 2;
  let hi = buf.length - start;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(start, start + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

function readVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    const b = data[pos];
    pos += 1;
    value |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value, next: pos };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const src = readVarint(delta, pos);
  pos = src.next;
  const target = readVarint(delta, pos);
  pos = target.next;
  const out = Buffer.alloc(target.value);
  let outPos = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let cpOffset = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOffset |= delta[pos] << (i * 8);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= delta[pos] << (i * 8);
          pos += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, outPos, cpOffset, cpOffset + cpSize);
      outPos += cpSize;
    } else if (op > 0) {
      delta.copy(out, outPos, pos, pos + op);
      pos += op;
      outPos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  return out;
}

// ---- protocol -----------------------------------------------------------------

export interface RefLine {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

export function headRefLine(repo: Repo): RefLine | null {
  const tip = repo.branchTip(repo.defaultBranch);
  if (tip === undefined) return null;
  return { oid: tip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` };
}

export function allRefLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const head = headRefLine(repo);
  if (head) lines.push(head);
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const obj = repo.objects.get(oid);
    const line: RefLine = { oid, name };
    if (obj && obj.type === 'tag') {
      const peeled = parseTag(obj.data).object;
      const target = repo.objects.get(peeled);
      if (target) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

/** v0 advertisement body: '# service=...' line, flush, ref lines with caps on the first. */
export function v0Advertisement(service: string, lines: RefLine[], caps: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`), FLUSH);
  const first = lines[0];
  const rest = lines.slice(1);
  const format = (line: RefLine): string => {
    let body = `${line.oid} ${line.name}`;
    if (line.symrefTarget) body += ` symref-target:${line.symrefTarget}`;
    if (line.peeled) body += ` peeled:${line.peeled}`;
    return body;
  };
  if (first) {
    parts.push(pktLine(`${format(first)}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  for (const line of rest) parts.push(pktLine(`${format(line)}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v2 ls-refs response. A ref-prefix filters by prefix (any of them); HEAD is only
 *  listed when it matches a prefix (it never does for 'refs/...' prefixes). */
export function v2LsRefs(repo: Repo, args: Map<string, string[]>): Buffer {
  const lines: RefLine[] = [];
  const wantsPeel = args.has('peel');
  const wantsSymrefs = args.has('symrefs');
  const wantsUnborn = args.has('unborn');
  const prefixes = args.get('ref-prefix') ?? [];
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const headTip = repo.branchTip(repo.defaultBranch);
  if (headTip !== undefined) {
    if (matches('HEAD')) lines.push({ oid: headTip, name: 'HEAD', symrefTarget: wantsSymrefs ? `refs/heads/${repo.defaultBranch}` : undefined });
  } else if (wantsUnborn) {
    if (matches('HEAD')) lines.push({ oid: '', name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const obj = repo.objects.get(oid);
    if (wantsPeel && obj && obj.type === 'tag') {
      const peeled = parseTag(obj.data).object;
      if (repo.objects.has(peeled)) line.peeled = peeled;
    }
    lines.push(line);
  }
  const parts: Buffer[] = [];
  for (const line of lines) {
    let text: string;
    if (line.unborn) {
      text = `unborn ${line.name} symref-target:${line.symrefTarget ?? ''}\n`;
    } else {
      text = `${line.oid} ${line.name}`;
      if (line.symrefTarget) text += ` symref-target:${line.symrefTarget}`;
      if (line.peeled) text += ` peeled:${line.peeled}`;
      text += '\n';
    }
    parts.push(pktLine(text));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Parse a v2 command stream: command line, then args until a delim or flush. */
export function parseV2Commands(body: Buffer): { command: string; args: Map<string, string[]> } {
  const pkts = parsePktLines(body);
  let command = '';
  const args = new Map<string, string[]>();
  let inArgs = false;
  for (const pkt of pkts) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind === 'delim') {
      inArgs = true;
      continue;
    }
    const text = pkt.payload.toString('utf8').trimEnd();
    if (!command) {
      const m = /^command=(.+)$/.exec(text);
      command = m ? m[1] : text;
      continue;
    }
    const key = text.split(' ')[0];
    if (!args.has(key)) args.set(key, []);
    args.get(key)!.push(text.includes(' ') ? text.slice(text.indexOf(' ') + 1) : '');
  }
  void inArgs;
  return { command, args };
}

function chunkSideband(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  // A sideband packet is a pkt-line: 4 length bytes + 1 band byte + payload, and a
  // pkt-line is at most 65520 bytes, so a pack piece is at most 65515 bytes.
  while (offset < pack.length) {
    const piece = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    chunks.push(sidebandPacket(1, piece));
    offset += piece.length;
  }
  return chunks;
}

/** Build the v2 fetch response sections for the given request. */
export function buildFetchResponse(
  store: Store,
  repo: Repo,
  args: Map<string, string[]>,
): Buffer {
  const wants = (args.get('want') ?? []).filter((w) => w !== ZERO_OID);
  const haves = args.get('have') ?? [];
  const shallow = args.get('shallow') ?? [];
  const deepen = args.get('deepen')?.[0];
  const depth = deepen !== undefined ? parseInt(deepen, 10) : undefined;
  const fetch = store.computeFetch(repo, wants, haves, shallow, depth);
  // The store already knows each object's oid (the map key); do not recompute SHA-1s.
  // Pass the store's own objects so the pack writer caches the compressed form on them.
  const entries = [...fetch.objectOids].map((oid) => repo.objects.get(oid)!);
  const pack = writePack(entries);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(FLUSH);
  parts.push(pktLine('shallow-info\n'));
  for (const oid of fetch.newShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of fetch.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(FLUSH);
  parts.push(pktLine('packfile\n'));
  parts.push(...chunkSideband(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Build the v0 fetch response: NAK then the sideband pack. */
export function buildV0FetchResponse(store: Store, repo: Repo, wants: string[], haves: string[], shallow: string[], deepen: number | undefined): Buffer {
  const fetch = store.computeFetch(repo, wants, haves, shallow, deepen);
  const entries = [...fetch.objectOids].map((oid) => repo.objects.get(oid)!);
  const pack = writePack(entries);
  const parts: Buffer[] = [pktLine('NAK\n'), ...chunkSideband(pack), FLUSH];
  return Buffer.concat(parts);
}

/** Parse a v0 upload-pack request (want/have/deepen/shallow lines, two sections). */
export function parseV0Fetch(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; deepen: number | undefined } {
  const pkts = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  for (const pkt of pkts) {
    if (pkt.kind !== 'data') continue;
    const text = pkt.payload.toString('utf8').trimEnd();
    if (text.startsWith('want ')) wants.push(text.slice(5).trim().split(' ')[0]);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim().split(' ')[0]);
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim().split(' ')[0]);
    else if (text.startsWith('deepen ')) deepen = parseInt(text.slice(7).trim(), 10);
    else if (text === 'done') continue;
  }
  return { wants, haves, shallow, deepen };
}

/** Handle a receive-pack request body: parse ref commands, apply the pack, return the report-status body. */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  // Parse pkt-lines from the front until the command-section flush; everything
  // after that offset is the pack (pack bytes may contain the ASCII '0000').
  const commands: Array<{ oldOid: string; newOid: string; ref: string; capabilities: string }> = [];
  let offset = 0;
  let packStart = -1;
  while (offset + 4 <= body.length) {
    const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) throw new Error('receive-pack: bad pkt-line length');
    if (len === 0) {
      packStart = offset + 4;
      break;
    }
    if (len === 1) {
      offset += 4;
      continue;
    }
    if (offset + len > body.length) throw new Error('receive-pack: truncated pkt-line');
    const text = body.subarray(offset + 4, offset + len).toString('utf8').trimEnd();
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const caps = nul >= 0 ? text.slice(nul + 1) : '';
    const fields = head.split(' ');
    if (fields.length < 3) throw new Error('receive-pack: bad command line');
    commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2], capabilities: caps });
    offset += len;
  }
  if (packStart < 0) throw new Error('receive-pack: no command flush');
  const packPart = body.subarray(packStart);
  // Parse and store the pack objects (a delete-only push has an empty pack).
  if (packPart.length > 0) {
    const objects = readPack(packPart);
    for (const obj of objects) repo.putObject(obj.type, obj.data);
  }
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current !== undefined && current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'reference has changed' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    // Create (old is zero) or update.
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        continue;
      }
    } else {
      if (current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'reference has changed' });
        continue;
      }
    }
    // Fast-forward check: the new commit must descend from the old one.
    if (cmd.oldOid !== ZERO_OID) {
      const target = repo.objects.get(cmd.newOid);
      if (!target || target.type !== 'commit' || !store.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true });
  }
  const lines: Buffer[] = [];
  const report: string[] = ['unpack ok\n'];
  for (const r of results) {
    report.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'rejected'}\n`);
  }
  const reportText = report.join('');
  lines.push(sidebandPacket(1, Buffer.from(reportText, 'utf8')));
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

export { parseCommit };
