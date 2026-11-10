// Runs commands.js the way ncSender does (one script, a pluginContext global)
// against an in-memory WebDAV server and file library.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'commands.js'), 'utf8')
  .replace(/^export\s*\{[^}]*\}\s*;?\s*$/m, '');

function makeWorld(opts = {}) {
  const world = {
    remote: new Map(),        // "CNC/a.nc" → { body, etag }
    remoteDirs: new Set(['']),
    local: new Map(),         // "Vaultix/a.nc" → { body, modified }
    saved: null, clock: 1000, etag: 1, requests: [], changed: 0,
    totp: opts.totp || null, deny: false, jobStatus: 'idle', kiosk: opts.kiosk !== false,
  };
  const put = (p, body) => {
    world.remote.set(p, { body, etag: `"e${world.etag++}"` });
    const parts = p.split('/'); parts.pop();
    let d = ''; for (const part of parts) { d = d ? `${d}/${part}` : part; world.remoteDirs.add(d); }
  };
  world.put = put;
  world.putLocal = (p, body) => world.local.set(p, { body, modified: world.clock++ });
  const xml = (p, folder, f) => `<D:response><D:href>/dav/${p.split('/').map(encodeURIComponent).join('/')}${folder ? '/' : ''}</D:href><D:propstat><D:prop>` +
    (folder ? '<D:resourcetype><D:collection/></D:resourcetype>' : `<D:resourcetype/><D:getcontentlength>${f.body.length}</D:getcontentlength><D:getetag>${f.etag.replace(/"/g, '&quot;')}</D:getetag>`) +
    '</D:prop></D:propstat></D:response>';
  const respond = (cb, r) => setImmediate(() => cb(Object.assign({ ok: r.status >= 200 && r.status < 300, headers: {}, body: '', error: null, size: 0, modified: 0 }, r)));
  const davPath = (url) => decodeURIComponent(new URL(url).pathname).replace(/^\/dav\/?/, '').replace(/\/$/, '');
  const authed = (o) => !world.deny && o.headers && o.headers.Authorization === 'Basic ' + Buffer.from('francis:vx_tok').toString('base64');

  const http = {
    request(o, cb) {
      const url = new URL(o.url); const method = o.method || 'GET';
      world.requests.push(`${method} ${url.pathname}`);
      if (url.pathname === '/api/auth/token') {
        const b = JSON.parse(o.body);
        if (b.password !== 'secret') return respond(cb, { status: 401, body: '{"error":"Wrong username or password"}' });
        if (world.totp && !b.code) return respond(cb, { status: 401, body: '{"error":"Code required","totp_required":true}' });
        if (world.totp && b.code !== world.totp) return respond(cb, { status: 401, body: '{"error":"Invalid code"}' });
        return respond(cb, { status: 200, body: '{"token":"vx_tok","username":"francis"}' });
      }
      if (url.pathname === '/api/me')
        return respond(cb, o.headers.Authorization === 'Bearer vx_tok' ? { status: 200, body: '{"username":"francis"}' } : { status: 401 });
      if (!authed(o)) return respond(cb, { status: 401 });
      const p = davPath(o.url);
      if (method === 'MKCOL') { if (world.remoteDirs.has(p)) return respond(cb, { status: 405 }); world.remoteDirs.add(p); return respond(cb, { status: 201 }); }
      if (method === 'PROPFIND') {
        if (world.remote.has(p)) return respond(cb, { status: 207, body: `<D:multistatus xmlns:D="DAV:">${xml(p, false, world.remote.get(p))}</D:multistatus>` });
        if (!world.remoteDirs.has(p)) return respond(cb, { status: 404 });
        let out = xml(p, true);
        const child = (q) => q !== p && q.startsWith(p ? p + '/' : '') && !q.slice(p ? p.length + 1 : 0).includes('/');
        for (const d of world.remoteDirs) if (d && child(d)) out += xml(d, true);
        for (const [f, v] of world.remote) if (child(f)) out += xml(f, false, v);
        return respond(cb, { status: 207, body: `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${out}</D:multistatus>` });
      }
      respond(cb, { status: 400 });
    },
    download(o, to, cb) {
      world.requests.push(`GET ${new URL(o.url).pathname}`);
      if (!authed(o)) return respond(cb, { status: 401 });
      const f = world.remote.get(davPath(o.url));
      if (!f) return respond(cb, { status: 404 });
      world.putLocal(to, f.body);
      respond(cb, { status: 200, size: f.body.length, modified: world.local.get(to).modified });
    },
    upload(from, o, cb) {
      world.requests.push(`PUT ${new URL(o.url).pathname}`);
      if (!authed(o)) return respond(cb, { status: 401 });
      const f = world.local.get(from);
      const p = davPath(o.url);
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      if (!world.remoteDirs.has(dir)) return respond(cb, { status: 409 });
      put(p, f.body);
      respond(cb, { status: 201, size: f.body.length, modified: f.modified });
    },
  };
  const timers = [];
  const pluginContext = {
    isKiosk: world.kiosk,
    http,
    files: {
      root: '/data/gcode-files',
      list: (under) => [...world.local].filter(([p]) => p.startsWith(under + '/')).map(([p, f]) => ({ path: p, size: f.body.length, modified: f.modified })),
      remove: (p) => world.local.delete(p),
      changed: () => { world.changed++; },
    },
    storage: { get: () => (world.saved ? JSON.parse(world.saved) : null), set: (v) => { world.saved = JSON.stringify(v); return true; } },
    getServerState: () => ({ jobStatus: world.jobStatus }),
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    log: () => {},
  };
  const context = vm.createContext({ pluginContext, setImmediate, console });
  vm.runInContext(SOURCE, context);
  world.ask = (req) => JSON.parse(JSON.stringify(vm.runInContext('onRequest', context)(req)));
  world.fn = (name) => vm.runInContext(name, context);
  world.settle = async () => {
    for (let i = 0; i < 500; i++) {
      await new Promise((r) => setImmediate(r));
      const s = world.ask({});
      if (s.phase !== 'syncing' && s.login.state !== 'working' && s.browse.state !== 'working') return s;
    }
    throw new Error('did not settle');
  };
  world.signIn = async (folder = 'CNC') => {
    world.ask({ action: 'login', server: 'http://drive.test', username: 'Francis', password: 'secret' });
    await world.settle();
    world.ask({ action: 'setFolder', folder });
    return world.settle();
  };
  world.sync = async () => { world.ask({ action: 'syncNow' }); return world.settle(); };
  return world;
}

test('signs in, keeps only the token, and never reports it', async () => {
  const w = makeWorld();
  w.ask({ action: 'login', server: 'drive.test/', username: 'Francis', password: 'secret' });
  const s = await w.settle();
  assert.equal(s.signedIn, true);
  assert.equal(s.server, 'https://drive.test');
  assert.equal(s.username, 'francis');
  assert.ok(!JSON.stringify(s).includes('vx_tok'));
  assert.ok(!w.saved.includes('secret'));
  assert.ok(w.saved.includes('vx_tok'));
});

test('asks for the two-factor code, and keeps asking after a wrong one', async () => {
  const w = makeWorld({ totp: '123456' });
  w.ask({ action: 'login', server: 'http://drive.test', username: 'francis', password: 'secret' });
  assert.equal((await w.settle()).login.state, 'needCode');
  w.ask({ action: 'login', code: '000000' });
  let s = await w.settle();
  assert.equal(s.login.state, 'needCode');
  assert.equal(s.login.error, 'Invalid code');
  w.ask({ action: 'login', code: '123456' });
  s = await w.settle();
  assert.equal(s.login.state, 'ok');
  assert.equal(s.signedIn, true);
});

test('a wrong password is an error, an app password skips the code', async () => {
  const w = makeWorld({ totp: '123456' });
  w.ask({ action: 'login', server: 'http://drive.test', username: 'francis', password: 'nope' });
  assert.equal((await w.settle()).login.error, 'Wrong username or password');
  w.ask({ action: 'login', server: 'http://drive.test', username: 'francis', password: 'vx_tok' });
  assert.equal((await w.settle()).signedIn, true);
});

test('lists server folders for the folder step', async () => {
  const w = makeWorld();
  w.put('CNC/a.nc', 'G0'); w.put('CNC/Signs/b.nc', 'G1'); w.put('Photos/x.jpg', 'x');
  await w.signIn();
  w.ask({ action: 'browse', path: '' });
  let s = await w.settle();
  assert.deepEqual(s.browse.folders, ['CNC', 'Photos']);
  w.ask({ action: 'browse', path: '/CNC' });
  s = await w.settle();
  assert.deepEqual(s.browse.folders, ['Signs']);
  assert.equal(s.browse.files, 1);
});

test('first sync pulls only G-code from the chosen folder, with subfolders', async () => {
  const w = makeWorld();
  w.put('CNC/a.nc', 'G0 X1'); w.put('CNC/Signs/logo sign.gcode', 'G1'); w.put('CNC/notes.pdf', 'pdf'); w.put('Other/z.nc', 'no');
  const s = await w.signIn();
  assert.equal(s.error, null);
  assert.deepEqual([...w.local.keys()].sort(), ['Vaultix/Signs/logo sign.gcode', 'Vaultix/a.nc']);
  assert.equal(w.local.get('Vaultix/a.nc').body, 'G0 X1');
  assert.equal(w.changed, 1);
  assert.deepEqual(s.recent.map((r) => r.k), ['down', 'down']);
  const before = w.requests.length;
  await w.sync();
  assert.ok(!w.requests.slice(before).some((r) => r.startsWith('GET') || r.startsWith('PUT')), 'second pass moves nothing');
});

test('a file made on the kiosk goes up, creating its folder', async () => {
  const w = makeWorld();
  w.put('CNC/a.nc', 'G0');
  await w.signIn();
  w.putLocal('Vaultix/QuickCut/rect.nc', 'G1 X50');
  const s = await w.sync();
  assert.equal(s.error, null);
  assert.equal(w.remote.get('CNC/QuickCut/rect.nc').body, 'G1 X50');
  assert.equal(s.recent[0].k, 'up');
  const before = w.requests.length;
  await w.sync();
  assert.ok(!w.requests.slice(before).some((r) => r.startsWith('PUT')));
});

test('edits travel both ways', async () => {
  const w = makeWorld();
  w.put('CNC/a.nc', 'v1'); w.put('CNC/b.nc', 'v1');
  await w.signIn();
  w.put('CNC/a.nc', 'server v2');
  w.putLocal('Vaultix/b.nc', 'kiosk v2');
  await w.sync();
  assert.equal(w.local.get('Vaultix/a.nc').body, 'server v2');
  assert.equal(w.remote.get('CNC/b.nc').body, 'kiosk v2');
});

test('a file changed in both places keeps both copies', async () => {
  const w = makeWorld();
  w.put('CNC/a.nc', 'v1');
  await w.signIn();
  w.put('CNC/a.nc', 'server edit');
  w.putLocal('Vaultix/a.nc', 'kiosk edit');
  let s = await w.sync();
  assert.equal(s.recent[0].k, 'conflict');
  assert.equal(w.local.get('Vaultix/a.nc').body, 'server edit');
  const copy = [...w.remote.keys()].find((k) => k.includes('(conflict kiosk'));
  assert.ok(copy && copy.endsWith('.nc'));
  assert.equal(w.remote.get(copy).body, 'kiosk edit');
  await w.sync();
  assert.equal(w.local.get('Vaultix/' + copy.slice(4)).body, 'kiosk edit');
});

test('deleting on the server removes the kiosk copy; deleting on the kiosk never reaches the server', async () => {
  const w = makeWorld();
  w.put('CNC/a.nc', 'A'); w.put('CNC/b.nc', 'B'); w.put('CNC/c.nc', 'C');
  await w.signIn();
  w.remote.delete('CNC/a.nc');
  w.local.delete('Vaultix/b.nc');
  const s = await w.sync();
  assert.ok(!w.local.has('Vaultix/a.nc'));
  assert.ok(w.remote.has('CNC/b.nc'));
  assert.ok(!w.local.has('Vaultix/b.nc'), 'a kiosk delete is not undone');
  assert.ok(!w.requests.some((r) => r.startsWith('DELETE')));
  assert.equal(s.recent[0].k, 'removed');
  w.put('CNC/b.nc', 'B2');
  await w.sync();
  assert.equal(w.local.get('Vaultix/b.nc').body, 'B2', 'but a later server edit brings it back');
});

test('an empty server folder does not empty the kiosk', async () => {
  const w = makeWorld();
  w.put('CNC/a.nc', 'A'); w.put('CNC/b.nc', 'B');
  await w.signIn();
  w.remote.clear();
  const s = await w.sync();
  assert.equal(w.local.size, 2);
  assert.match(s.warning, /looks empty/);
});

test('a missing folder or a revoked sign-in changes nothing', async () => {
  const w = makeWorld();
  w.put('CNC/a.nc', 'A');
  await w.signIn();
  w.remoteDirs.delete('CNC'); w.remote.clear();
  let s = await w.sync();
  assert.match(s.error, /not found/);
  assert.equal(w.local.size, 1);
  w.deny = true;
  s = await w.sync();
  assert.equal(s.signedIn, false);
  assert.match(s.error, /Sign in again/);
  assert.equal(w.local.size, 1);
});

test('existing same-size files are adopted, different ones kept as a conflict', async () => {
  const w = makeWorld();
  w.put('CNC/same.nc', 'AAAA'); w.put('CNC/diff.nc', 'server');
  w.putLocal('Vaultix/same.nc', 'AAAA'); w.putLocal('Vaultix/diff.nc', 'kiosk copy');
  await w.signIn();
  assert.ok(!w.requests.includes('GET /dav/CNC/same.nc'));
  assert.equal(w.local.get('Vaultix/diff.nc').body, 'server');
  assert.ok([...w.remote.values()].some((f) => f.body === 'kiosk copy'));
});

test('nothing syncs while a job runs, or off a kiosk', async () => {
  const w = makeWorld();
  w.put('CNC/a.nc', 'A');
  await w.signIn();
  w.put('CNC/b.nc', 'B');
  w.jobStatus = 'running';
  const tick = w.fn('tick');
  w.fn('run').lastAttempt = 0;
  tick();
  await w.settle();
  assert.ok(!w.local.has('Vaultix/b.nc'));
  w.jobStatus = 'idle';
  tick();
  await w.settle();
  assert.ok(w.local.has('Vaultix/b.nc'));

  const desk = makeWorld({ kiosk: false });
  const s = desk.ask({ action: 'login', server: 'http://drive.test', username: 'francis', password: 'secret' });
  assert.equal(s.kiosk, false);
  assert.equal(s.libraryPath, '/data/gcode-files');
  assert.equal(desk.requests.length, 0);
});

test('sign out forgets the token but keeps the files', async () => {
  const w = makeWorld();
  w.put('CNC/a.nc', 'A');
  await w.signIn();
  const s = w.ask({ action: 'signOut' });
  assert.equal(s.signedIn, false);
  assert.equal(s.server, 'http://drive.test');
  assert.ok(!w.saved.includes('vx_tok'));
  assert.equal(w.local.size, 1);
});

test('helpers', () => {
  const w = makeWorld();
  assert.equal(w.fn('base64')('francis:vx_é'), Buffer.from('francis:vx_é').toString('base64'));
  assert.equal(w.fn('cleanFolder')('/CNC/../Signs/'), 'CNC/Signs');
  assert.equal(w.fn('isGcode')('A.NC'), true);
  assert.equal(w.fn('isGcode')('a.txt'), false);
  assert.match(w.fn('conflictName')('Signs/logo.nc', 0), /^Signs\/logo \(conflict kiosk \d{4}-\d\d-\d\d \d{4}\)\.nc$/);
  const parsed = JSON.parse(JSON.stringify(w.fn('parseMultistatus')(
    '<d:multistatus xmlns:d="DAV:"><d:response><d:href>http://h/dav/My%20Folder/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>' +
    '<d:response><d:href>/dav/My%20Folder/a%26b.nc</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12</d:getcontentlength><d:getlastmodified>Mon, 09 Nov 2026 10:00:00 GMT</d:getlastmodified><d:getetag>&quot;abc&quot;</d:getetag></d:prop></d:propstat></d:response></d:multistatus>')));
  assert.deepEqual(parsed, [
    { path: '/dav/My Folder', folder: true, size: 0, modified: '', etag: '' },
    { path: '/dav/My Folder/a&b.nc', folder: false, size: 12, modified: 'Mon, 09 Nov 2026 10:00:00 GMT', etag: '"abc"' },
  ]);
});
