'use strict';
/* Arch Diagram (hosted): static files, a small REST API and a WebSocket hub
   for real-time co-editing. A diagram is reachable by anyone who has its
   unguessable id (/d/<id>). Diagrams are kept as JSON files in DATA_DIR. */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024;
const MAX_ELEMS = 20000;
const COLLS = ['blocks', 'links', 'flows', 'frames'];
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PEER_COLORS = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5'];

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------------------------------------------------------------
   Diagram store: in memory while somebody has it open, on disk always
   --------------------------------------------------------------------- */
const rooms = new Map(); // id -> { id, doc, clients:Set, saveTimer, evictTimer, dirty }

const newId = () => crypto.randomBytes(12).toString('base64url');
const filePath = id => path.join(DATA_DIR, id + '.json');

function emptyDoc(name) {
  const now = new Date().toISOString();
  return { name: name || 'Untitled diagram', settings: null, blocks: [], links: [], flows: [], frames: [], createdAt: now, updatedAt: now };
}

/* keep only the shape the server relies on; the content of each element is
   normalised and sanitised by the clients, exactly as for a local file */
function cleanDoc(src, name) {
  const d = emptyDoc(name || (src && typeof src.name === 'string' ? src.name : ''));
  if (!src || typeof src !== 'object') return d;
  d.name = String(d.name).slice(0, 200);
  if (src.settings && typeof src.settings === 'object') d.settings = src.settings;
  for (const c of COLLS) {
    const seen = new Set();
    d[c] = (Array.isArray(src[c]) ? src[c] : [])
      .filter(o => o && typeof o === 'object' && typeof o.id === 'string' && !seen.has(o.id) && seen.add(o.id))
      .slice(0, MAX_ELEMS);
  }
  if (typeof src.createdAt === 'string') d.createdAt = src.createdAt;
  if (typeof src.updatedAt === 'string') d.updatedAt = src.updatedAt;
  return d;
}

async function loadRoom(id) {
  let room = rooms.get(id);
  if (room) return room;
  let text;
  try { text = await fsp.readFile(filePath(id), 'utf8'); } catch (e) { return null; }
  room = rooms.get(id); // somebody else may have loaded it meanwhile
  if (room) return room;
  room = { id, doc: cleanDoc(JSON.parse(text)), clients: new Set(), saveTimer: null, evictTimer: null, dirty: false };
  rooms.set(id, room);
  return room;
}

async function writeDoc(id, doc) {
  const tmp = filePath(id) + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(doc));
  await fsp.rename(tmp, filePath(id));
}

function scheduleSave(room) {
  room.dirty = true;
  room.doc.updatedAt = new Date().toISOString();
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => flush(room), 800);
}
async function flush(room) {
  clearTimeout(room.saveTimer); room.saveTimer = null;
  if (!room.dirty) return;
  room.dirty = false;
  try { await writeDoc(room.id, room.doc); } catch (e) { room.dirty = true; console.error('save failed', room.id, e.message); }
}
function maybeEvict(room) {
  clearTimeout(room.evictTimer);
  if (room.clients.size) return;
  room.evictTimer = setTimeout(async () => {
    if (room.clients.size) return;
    await flush(room);
    if (!room.clients.size && !room.dirty) rooms.delete(room.id);
  }, 60000);
}

/* ---------------------------------------------------------------------
   Operations. Element-level, last writer wins in server order:
     { o:'add', c, v }      insert a whole element (or replace it)
     { o:'set', c, id, f }  merge fields; null removes a field
     { o:'del', c, id }
     { o:'order', c, ids }  z-order / list order
     { o:'settings', v }    diagram settings
     { o:'name', v }        diagram name
   --------------------------------------------------------------------- */
function reorder(list, ids) {
  const byId = new Map(list.map(o => [o.id, o]));
  const out = [];
  for (const id of ids) { const o = byId.get(id); if (o) { out.push(o); byId.delete(id); } }
  for (const o of list) if (byId.has(o.id)) out.push(o);
  return out;
}

function applyOp(doc, op) {
  if (!op || typeof op !== 'object') return false;
  if (op.o === 'settings') { if (op.v && typeof op.v === 'object') { doc.settings = op.v; return true; } return false; }
  if (op.o === 'name') { doc.name = String(op.v ?? '').slice(0, 200); return true; }
  if (!COLLS.includes(op.c)) return false;
  const list = doc[op.c];
  switch (op.o) {
    case 'add': {
      const v = op.v;
      if (!v || typeof v !== 'object' || typeof v.id !== 'string') return false;
      const i = list.findIndex(o => o.id === v.id);
      if (i >= 0) list[i] = v;
      else { if (list.length >= MAX_ELEMS) return false; list.push(v); }
      return true;
    }
    case 'set': {
      const el = list.find(o => o.id === op.id);
      if (!el || !op.f || typeof op.f !== 'object') return false; // deleted meanwhile: the delete wins
      for (const [k, v] of Object.entries(op.f)) {
        if (k === 'id' || k === '__proto__') continue;
        if (v === null) delete el[k]; else el[k] = v;
      }
      return true;
    }
    case 'del': {
      const i = list.findIndex(o => o.id === op.id);
      if (i < 0) return false;
      list.splice(i, 1);
      return true;
    }
    case 'order':
      if (!Array.isArray(op.ids)) return false;
      doc[op.c] = reorder(list, op.ids.map(String));
      return true;
  }
  return false;
}

/* ---------------------------------------------------------------------
   HTTP
   --------------------------------------------------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, body, type = 'application/json', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(data);
}
async function sendFile(res, file) {
  try {
    const data = await fsp.readFile(file);
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream', { 'Referrer-Policy': 'no-referrer' });
  } catch (e) { send(res, 404, { error: 'not found' }); }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
/* the JSON file format of the stand-alone app */
function fileObject(room) {
  const d = room.doc;
  return {
    app: { name: 'arch-diagram', version: '1.0.0', github: 'https://github.com/avchaykin/arch-diagram' },
    format: 1, savedAt: new Date().toISOString(), name: d.name,
    settings: d.settings || undefined, blocks: d.blocks, links: d.links, flows: d.flows, frames: d.frames
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'POST' && p === '/api/diagrams') {
      let src = null;
      const text = await readBody(req);
      if (text.trim()) { try { src = JSON.parse(text); } catch (e) { return send(res, 400, { error: 'invalid JSON' }); } }
      const id = newId();
      const doc = cleanDoc(src && src.data ? src.data : src, src && src.name);
      await writeDoc(id, doc);
      return send(res, 201, { id, url: '/d/' + id });
    }
    let m = p.match(/^\/api\/diagrams\/([^/]+)$/);
    if (m && req.method === 'GET') {
      if (!ID_RE.test(m[1])) return send(res, 404, { error: 'not found' });
      const room = await loadRoom(m[1]);
      if (!room) return send(res, 404, { error: 'not found' });
      const out = fileObject(room);
      maybeEvict(room);
      return send(res, 200, JSON.stringify(out, null, 2), 'application/json', url.searchParams.has('download')
        ? { 'Content-Disposition': `attachment; filename="${(out.name || 'diagram').replace(/[^\w.-]+/g, '_')}.json"` } : {});
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    if (p === '/' || p === '/index.html') return sendFile(res, path.join(PUBLIC_DIR, 'home.html'));
    m = p.match(/^\/d\/([^/]+)\/?$/);
    if (m) return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    const f = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(p)));
    if (f.startsWith(PUBLIC_DIR + path.sep) && path.basename(f) !== 'index.html') return sendFile(res, f);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
  }
});

/* ---------------------------------------------------------------------
   WebSocket: /ws/<id>
   client -> server: hello {user}, ops {n, ops}, presence {cursor, sel}, user {user}
   server -> client: init {doc, you, peers}, ack {n}, ops {ops, from}, join, leave, presence, user
   --------------------------------------------------------------------- */
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });

server.on('upgrade', async (req, socket, head) => {
  const m = new URL(req.url, 'http://x').pathname.match(/^\/ws\/([^/]+)$/);
  const room = m && ID_RE.test(m[1]) ? await loadRoom(m[1]).catch(() => null) : null;
  if (!room) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => onConnection(ws, room));
});

const cleanUser = (u, fallbackColor) => ({
  name: String((u && u.name) || 'Guest').slice(0, 40),
  color: /^#[0-9a-f]{6}$/i.test(u && u.color) ? u.color : fallbackColor
});
function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) if (c !== except && c.readyState === 1) c.send(data);
}

let nextCid = 1;
function onConnection(ws, room) {
  clearTimeout(room.evictTimer);
  if (!rooms.has(room.id)) rooms.set(room.id, room);
  ws.cid = 'c' + (nextCid++);
  ws.user = null;
  ws.presence = { cursor: null, sel: [] };
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello': {
        if (ws.user) return;
        ws.user = cleanUser(msg.user, PEER_COLORS[room.clients.size % PEER_COLORS.length]);
        const peers = [...room.clients].filter(c => c.user).map(c => ({ cid: c.cid, user: c.user, ...c.presence }));
        room.clients.add(ws);
        ws.send(JSON.stringify({ t: 'init', doc: room.doc, you: ws.cid, peers }));
        broadcast(room, { t: 'join', cid: ws.cid, user: ws.user }, ws);
        break;
      }
      case 'ops': {
        if (!ws.user || !Array.isArray(msg.ops)) return;
        const applied = msg.ops.filter(op => applyOp(room.doc, op));
        ws.send(JSON.stringify({ t: 'ack', n: msg.n }));
        if (applied.length) { scheduleSave(room); broadcast(room, { t: 'ops', ops: applied, from: ws.cid }, ws); }
        break;
      }
      case 'presence': {
        if (!ws.user) return;
        const c = msg.cursor;
        ws.presence = {
          cursor: c && isFinite(c.x) && isFinite(c.y) ? { x: +c.x, y: +c.y } : null,
          sel: Array.isArray(msg.sel) ? msg.sel.slice(0, 500).map(String) : []
        };
        broadcast(room, { t: 'presence', cid: ws.cid, ...ws.presence }, ws);
        break;
      }
      case 'user': {
        if (!ws.user) return;
        ws.user = cleanUser(msg.user, ws.user.color);
        broadcast(room, { t: 'user', cid: ws.cid, user: ws.user }, ws);
        break;
      }
    }
  });
  ws.on('close', () => {
    if (room.clients.delete(ws)) broadcast(room, { t: 'leave', cid: ws.cid });
    maybeEvict(room);
  });
}

/* drop dead connections */
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 30000).unref();

async function shutdown() {
  await Promise.all([...rooms.values()].map(flush));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => console.log(`Arch Diagram server on http://localhost:${PORT} (data: ${DATA_DIR})`));
