'use strict';
/* End-to-end check of the server: create a diagram, two clients edit it,
   changes are relayed, acked, ordered and persisted. Run: npm test */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'archd-'));
const BASE = `http://127.0.0.1:${PORT}`;

function client(id, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', d => {
    const m = JSON.parse(d);
    const i = waiters.findIndex(w => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  });
  const next = (pred = () => true) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error(name + ': timeout waiting for message')), 3000);
    });
  };
  const open = new Promise(r => ws.on('open', r)).then(() => ws.send(JSON.stringify({ t: 'hello', user: { name, color: '#123456' } })));
  return { ws, next, open, send: m => ws.send(JSON.stringify(m)) };
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA, HOST: '127.0.0.1' }, stdio: 'pipe' });
  await new Promise(r => srv.stdout.on('data', r));
  try {
    // pages
    assert.strictEqual((await fetch(BASE + '/')).status, 200);
    assert.strictEqual((await fetch(BASE + '/d/doesnotexist')).status, 200);
    assert.strictEqual((await fetch(BASE + '/api/diagrams/doesnotexist')).status, 404);
    assert.strictEqual((await fetch(BASE + '/../server.js')).status, 404);

    // create
    const res = await fetch(BASE + '/api/diagrams', { method: 'POST', body: JSON.stringify({ name: 'Test', data: { blocks: [{ id: 'b1', x: 0, y: 0 }] } }) });
    assert.strictEqual(res.status, 201);
    const { id, url } = await res.json();
    assert.match(id, /^[A-Za-z0-9_-]{16}$/);
    assert.strictEqual(url, '/d/' + id);

    const A = client(id, 'Alice'); await A.open;
    const initA = await A.next(m => m.t === 'init');
    assert.strictEqual(initA.doc.name, 'Test');
    assert.deepStrictEqual(initA.doc.blocks.map(b => b.id), ['b1']);
    assert.deepStrictEqual(initA.peers, []);

    const B = client(id, 'Bob'); await B.open;
    const initB = await B.next(m => m.t === 'init');
    assert.strictEqual(initB.peers.length, 1);
    assert.strictEqual(initB.peers[0].user.name, 'Alice');
    const join = await A.next(m => m.t === 'join');
    assert.strictEqual(join.user.name, 'Bob');

    // A adds and edits; B receives, A gets an ack
    A.send({ t: 'ops', n: 1, ops: [{ o: 'add', c: 'blocks', v: { id: 'b2', x: 10, y: 20 } }, { o: 'set', c: 'blocks', id: 'b1', f: { x: 5, title: 'Hi' } }] });
    assert.strictEqual((await A.next(m => m.t === 'ack')).n, 1);
    const got = await B.next(m => m.t === 'ops');
    assert.strictEqual(got.ops.length, 2);

    // B reorders and removes a field, deletes; A receives
    B.send({ t: 'ops', n: 1, ops: [{ o: 'order', c: 'blocks', ids: ['b2', 'b1'] }, { o: 'set', c: 'blocks', id: 'b1', f: { title: null } }] });
    await B.next(m => m.t === 'ack');
    await A.next(m => m.t === 'ops');

    // a set on a deleted element is dropped (the delete wins)
    A.send({ t: 'ops', n: 2, ops: [{ o: 'del', c: 'blocks', id: 'b2' }] });
    B.send({ t: 'ops', n: 2, ops: [{ o: 'set', c: 'blocks', id: 'b2', f: { x: 99 } }] });
    await A.next(m => m.t === 'ack'); await B.next(m => m.t === 'ack');

    // presence and rename are relayed
    A.send({ t: 'presence', cursor: { x: 1, y: 2 }, sel: ['b1'] });
    const pr = await B.next(m => m.t === 'presence');
    assert.deepStrictEqual(pr.cursor, { x: 1, y: 2 });
    A.send({ t: 'ops', n: 3, ops: [{ o: 'name', v: 'Renamed' }, { o: 'settings', v: { canvas: { grid: true } } }] });
    await A.next(m => m.t === 'ack');

    // the state on the server
    const doc = await (await fetch(BASE + '/api/diagrams/' + id)).json();
    assert.strictEqual(doc.name, 'Renamed');
    assert.deepStrictEqual(doc.blocks, [{ id: 'b1', x: 5, y: 0 }]);
    assert.deepStrictEqual(doc.settings, { canvas: { grid: true } });
    assert.strictEqual(doc.app.name, 'arch-diagram');

    // leaving is announced, and the file is written
    B.ws.close();
    assert.strictEqual((await A.next(m => m.t === 'leave')).cid, initB.you);
    await new Promise(r => setTimeout(r, 1200));
    const disk = JSON.parse(fs.readFileSync(path.join(DATA, id + '.json'), 'utf8'));
    assert.strictEqual(disk.name, 'Renamed');
    assert.deepStrictEqual(disk.blocks, [{ id: 'b1', x: 5, y: 0 }]);
    A.ws.close();

    // unknown diagram: the socket is refused
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws/nonexistent123`);
    await new Promise(r => bad.on('error', r));
    console.log('server sync test: OK');
  } finally {
    srv.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
