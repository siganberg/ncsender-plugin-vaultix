/**
 * Vaultix Sync: keeps one folder of a Vaultix drive (or any WebDAV folder)
 * in step with a "Vaultix" folder in ncSender's file library.
 *
 * Runs in ncSender's plugin engine, so:
 *  - no fetch / fs: the network and the library go through
 *    pluginContext.http and pluginContext.files, which need the "network"
 *    and "files" permissions in manifest.json;
 *  - every network call is a callback, never a wait: plugin code runs under
 *    a lock the machine's commands also take;
 *  - the plugin window (config.html) talks to this file through onRequest().
 *
 * Sync is a three-way compare, like the Vaultix desktop app: what the server
 * has, what the library has, and what both had after the last sync.
 *  - a change on one side is copied to the other;
 *  - a file changed on both sides keeps both copies;
 *  - a file deleted on the server is removed here; a file deleted here stays
 *    on the server (WebDAV deletes skip Vaultix's Trash, so we never send one).
 */

var LOCAL_ROOT = 'Vaultix';
var EXTENSIONS = ['.nc', '.gcode', '.ngc', '.tap', '.cnc'];
var TICK_MS = 5000;
var AUTO_EVERY_MS = 60000;
var MAX_FILES = 5000;
var MAX_FOLDERS = 500;
var MAX_RECENT = 30;
var PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>';

// What is kept between restarts (pluginContext.storage, never served to browsers).
var store = null;
// What only lives while ncSender runs.
var run = {
  phase: 'idle',          // idle | syncing
  error: null,            // last pass's problem, in words
  warning: null,
  progress: { done: 0, total: 0 },
  lastAttempt: 0,
  login: { state: 'idle', error: null },   // idle | working | needCode | ok | error
  pendingLogin: null,     // { server, username, password, at } while waiting for the 2FA code
  browse: { path: '', state: 'idle', folders: [], error: null }
};

function buildInitialConfig(raw) { return raw || {}; }

function hasHost() {
  return typeof pluginContext !== 'undefined' && pluginContext && pluginContext.http && pluginContext.files && pluginContext.storage;
}

function load() {
  if (store) return store;
  var saved = hasHost() ? pluginContext.storage.get() : null;
  store = saved && typeof saved === 'object' ? saved : {};
  if (!store.files) store.files = {};
  if (!store.recent) store.recent = [];
  if (store.auto === undefined) store.auto = true;
  return store;
}

function save() { if (hasHost()) pluginContext.storage.set(store); }

function signedIn() { var s = load(); return !!(s.server && s.username && s.token); }

/* ---------- small helpers ---------- */

function base64(text) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var bytes = [];
  var encoded = encodeURIComponent(text);
  for (var i = 0; i < encoded.length; i++) {
    if (encoded.charAt(i) === '%') { bytes.push(parseInt(encoded.substr(i + 1, 2), 16)); i += 2; }
    else bytes.push(encoded.charCodeAt(i));
  }
  var out = '';
  for (var j = 0; j < bytes.length; j += 3) {
    var a = bytes[j], b = bytes[j + 1], c = bytes[j + 2];
    out += chars[a >> 2] + chars[((a & 3) << 4) | ((b || 0) >> 4)];
    out += j + 1 < bytes.length ? chars[((b & 15) << 2) | ((c || 0) >> 6)] : '=';
    out += j + 2 < bytes.length ? chars[c & 63] : '=';
  }
  return out;
}

function cleanServer(url) {
  var s = String(url || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

/** "/CNC/Signs/" → "CNC/Signs"; "" is the whole drive. */
function cleanFolder(path) {
  return String(path || '').split('/').filter(function (p) { return p && p !== '.' && p !== '..'; }).join('/');
}

function joinPath(a, b) { return a && b ? a + '/' + b : a || b || ''; }

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function davUrl(server, path) { return server + '/dav/' + encodePath(path); }

function authHeader(s) { return 'Basic ' + base64(s.username + ':' + s.token); }

function isGcode(name) {
  var lower = name.toLowerCase();
  for (var i = 0; i < EXTENSIONS.length; i++) if (lower.slice(-EXTENSIONS[i].length) === EXTENSIONS[i]) return true;
  return false;
}

function decodeXml(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function tagText(xml, name) {
  var m = new RegExp('<(?:[A-Za-z0-9]+:)?' + name + '(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z0-9]+:)?' + name + '>', 'i').exec(xml);
  return m ? decodeXml(m[1]).trim() : '';
}

/**
 * The entries of a PROPFIND answer: [{ path, folder, size, modified, etag }].
 * path is the decoded URL path, e.g. "/dav/CNC/part.nc".
 */
function parseMultistatus(xml) {
  var entries = [];
  var parts = String(xml || '').split(/<(?:[A-Za-z0-9]+:)?response(?:\s[^>]*)?>/i);
  for (var i = 1; i < parts.length; i++) {
    var part = parts[i];
    var href = tagText(part, 'href');
    if (!href) continue;
    href = href.replace(/^https?:\/\/[^\/]+/i, '');
    var path;
    try { path = decodeURIComponent(href); } catch (e) { path = href; }
    var folder = /<(?:[A-Za-z0-9]+:)?collection[\s\/>]/i.test(part);
    entries.push({
      path: path.replace(/\/+$/, '') || '/',
      folder: folder,
      size: parseInt(tagText(part, 'getcontentlength'), 10) || 0,
      modified: tagText(part, 'getlastmodified'),
      etag: tagText(part, 'getetag')
    });
  }
  return entries;
}

/** What identifies a version of a server file. */
function remoteSig(entry) { return entry.etag || (entry.size + ':' + entry.modified); }
function localSig(file) { return file.size + ':' + file.modified; }

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function conflictName(rel, now) {
  var d = new Date(now);
  var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + pad(d.getMinutes());
  var slash = rel.lastIndexOf('/');
  var dir = slash >= 0 ? rel.slice(0, slash + 1) : '';
  var name = slash >= 0 ? rel.slice(slash + 1) : rel;
  var dot = name.lastIndexOf('.');
  var stem = dot > 0 ? name.slice(0, dot) : name;
  var ext = dot > 0 ? name.slice(dot) : '';
  return dir + stem + ' (conflict kiosk ' + stamp + ')' + ext;
}

/**
 * Decide what one pass does.
 *  remote: { rel: { sig } }   local: { rel: { sig } }   known: { rel: { rs, ls } }
 * Returns { ops: [{ type, rel }], forget: [rel], held: n }.
 *  type: download | upload | conflict | remove
 */
function planSync(remote, local, known) {
  var ops = [], forget = [], removals = [];
  var seen = {};
  var all = Object.keys(remote).concat(Object.keys(local), Object.keys(known));
  for (var i = 0; i < all.length; i++) {
    var rel = all[i];
    if (seen[rel]) continue;
    seen[rel] = true;
    var r = remote[rel], l = local[rel], k = known[rel];
    if (!r && !l) { forget.push(rel); continue; }
    if (r && !l) {
      // New on the server, or changed there after it was deleted here.
      if (!k || k.rs !== r.sig) ops.push({ type: 'download', rel: rel });
      continue;
    }
    if (l && !r) {
      if (!k || !k.rs) ops.push({ type: 'upload', rel: rel });          // new here
      else if (k.ls !== l.sig) ops.push({ type: 'upload', rel: rel });  // deleted there, edited here: the edit wins
      else removals.push({ type: 'remove', rel: rel });                 // deleted there
      continue;
    }
    if (!k) {
      // First time both sides have it. Same size: take it as the same file.
      ops.push({ type: r.size === l.size ? 'adopt' : 'conflict', rel: rel });
      continue;
    }
    var rChanged = k.rs !== r.sig, lChanged = k.ls !== l.sig;
    if (rChanged && lChanged) ops.push({ type: 'conflict', rel: rel });
    else if (rChanged) ops.push({ type: 'download', rel: rel });
    else if (lChanged) ops.push({ type: 'upload', rel: rel });
  }
  // A server that suddenly lists nothing (wiped, wrong folder, unmounted
  // disk) must not empty the library.
  var held = 0;
  if (removals.length > 0 && Object.keys(remote).length === 0) held = removals.length;
  else ops = ops.concat(removals);
  return { ops: ops, forget: forget, held: held };
}

function note(kind, path, now) {
  var s = load();
  s.recent.unshift({ t: now || Date.now(), k: kind, p: path });
  if (s.recent.length > MAX_RECENT) s.recent.length = MAX_RECENT;
}

function explain(res, what) {
  if (res.status === 401 || res.status === 403) return 'Vaultix no longer accepts this sign-in. Sign in again.';
  if (res.status === 404) return what + ' was not found on the server.';
  if (res.status === 507) return 'The Vaultix drive is full.';
  if (res.status) return what + ' failed (' + res.status + ').';
  return "Can't reach the Vaultix server" + (res.error ? ' (' + res.error + ')' : '') + '.';
}

/* ---------- WebDAV ---------- */

function propfind(s, path, depth, done) {
  pluginContext.http.request({
    method: 'PROPFIND',
    url: davUrl(s.server, path),
    headers: { Authorization: authHeader(s), Depth: String(depth), 'Content-Type': 'application/xml' },
    body: PROPFIND_BODY,
    timeoutMs: 60000
  }, function (res) {
    done(res, res.ok ? parseMultistatus(res.body) : []);
  });
}

/** The children of one server folder: entries with a name, minus the folder itself. */
function listFolder(s, path, done) {
  propfind(s, path, 1, function (res, entries) {
    if (!res.ok) return done(res, []);
    var self = '/dav' + (path ? '/' + path : '');
    var children = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.path === self || e.path === self + '/') continue;
      e.name = e.path.slice(e.path.lastIndexOf('/') + 1);
      if (!e.name || e.name.charAt(0) === '.') continue;
      children.push(e);
    }
    done(res, children);
  });
}

/** Every G-code file under the synced folder: { rel: { sig, size } }, plus the folders that exist. */
function walkRemote(s, done) {
  var files = {}, folders = { '': true }, queue = [''], count = 0, visited = 0;
  function next() {
    if (queue.length === 0) return done(null, files, folders);
    var dir = queue.shift();
    if (++visited > MAX_FOLDERS) return done('The Vaultix folder has too many subfolders to sync (over ' + MAX_FOLDERS + ').');
    listFolder(s, joinPath(s.folder, dir), function (res, children) {
      if (!res.ok) return done(explain(res, dir ? 'The folder ' + dir : 'The Vaultix folder'), null, null, res.status);
      for (var i = 0; i < children.length; i++) {
        var c = children[i], rel = joinPath(dir, c.name);
        if (c.folder) { folders[rel] = true; queue.push(rel); }
        else if (isGcode(c.name)) {
          if (++count > MAX_FILES) return done('The Vaultix folder has too many files to sync (over ' + MAX_FILES + ').');
          files[rel] = { sig: remoteSig(c), size: c.size };
        }
      }
      next();
    });
  }
  next();
}

function listLocal() {
  var out = {};
  var list = pluginContext.files.list(LOCAL_ROOT);
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    var rel = f.path.slice(LOCAL_ROOT.length + 1);
    var name = rel.slice(rel.lastIndexOf('/') + 1);
    if (isGcode(name)) out[rel] = { sig: localSig(f), size: f.size };
  }
  return out;
}

/** Make sure the server folders above rel exist. */
function ensureFolders(s, rel, folders, done) {
  var parts = rel.split('/');
  parts.pop();
  var missing = [], path = '';
  for (var i = 0; i < parts.length; i++) {
    path = joinPath(path, parts[i]);
    if (!folders[path]) missing.push(path);
  }
  function next() {
    if (missing.length === 0) return done(null);
    var dir = missing.shift();
    pluginContext.http.request({
      method: 'MKCOL', url: davUrl(s.server, joinPath(s.folder, dir)), headers: { Authorization: authHeader(s) }
    }, function (res) {
      // 405: it is already there.
      if (!res.ok && res.status !== 405) return done(res);
      folders[dir] = true;
      next();
    });
  }
  next();
}

function download(s, rel, toRel, done) {
  pluginContext.http.download({
    url: davUrl(s.server, joinPath(s.folder, rel)), headers: { Authorization: authHeader(s) }, timeoutMs: 600000
  }, LOCAL_ROOT + '/' + toRel, done);
}

/** Send a library file to the server and read back what the server now calls it. */
function upload(s, fromRel, rel, folders, done) {
  ensureFolders(s, rel, folders, function (failed) {
    if (failed) return done(failed, null);
    pluginContext.http.upload(LOCAL_ROOT + '/' + fromRel, {
      url: davUrl(s.server, joinPath(s.folder, rel)), headers: { Authorization: authHeader(s) }, timeoutMs: 600000
    }, function (res) {
      if (!res.ok) return done(res, null);
      propfind(s, joinPath(s.folder, rel), 0, function (pres, entries) {
        if (!pres.ok || entries.length === 0) return done(pres.ok ? { status: 0, error: 'no answer' } : pres, null);
        done(null, { rs: remoteSig(entries[0]), ls: res.size + ':' + res.modified });
      });
    });
  });
}

/* ---------- one sync pass ---------- */

function jobBusy() {
  try {
    var st = pluginContext.getServerState();
    return !!st && (st.jobStatus === 'running' || st.jobStatus === 'paused');
  } catch (e) { return false; }
}

function finishPass(error, changed) {
  var s = load();
  run.phase = 'idle';
  run.error = error || null;
  if (!error) s.lastSync = Date.now();
  save();
  if (changed) pluginContext.files.changed();
}

function syncNow() {
  var s = load();
  if (run.phase === 'syncing' || !signedIn() || s.folder === undefined || s.folder === null) return false;
  run.phase = 'syncing';
  run.lastAttempt = Date.now();
  run.progress = { done: 0, total: 0 };
  run.warning = null;

  walkRemote(s, function (error, remote, folders, status) {
    if (error) {
      if (status === 401 || status === 403) { s.token = null; save(); }
      return finishPass(error, false);
    }
    var local = listLocal();
    var plan = planSync(remote, local, s.files);
    for (var i = 0; i < plan.forget.length; i++) delete s.files[plan.forget[i]];
    if (plan.held > 0)
      run.warning = 'The Vaultix folder looks empty, so ' + plan.held + ' file' + (plan.held === 1 ? ' was' : 's were') + ' kept here.';

    var ops = plan.ops, changed = false, firstError = null;
    run.progress.total = ops.length;

    function fail(res, what) {
      var message = explain(res, what);
      if (!firstError) firstError = message;
      note('error', what);
      if (res.status === 401 || res.status === 403) { s.token = null; return true; }
      return false;
    }

    function step() {
      if (ops.length === 0) return finishPass(firstError, changed);
      // A job started mid-pass: stop here, the rest waits for the next pass.
      if (jobBusy()) return finishPass(firstError, changed);
      var op = ops.shift(), rel = op.rel;
      function done() { run.progress.done++; save(); step(); }

      if (op.type === 'adopt') {
        s.files[rel] = { rs: remote[rel].sig, ls: local[rel].sig };
        return done();
      }
      if (op.type === 'remove') {
        if (pluginContext.files.remove(LOCAL_ROOT + '/' + rel)) { changed = true; note('removed', rel); }
        delete s.files[rel];
        return done();
      }
      if (op.type === 'download') {
        return download(s, rel, rel, function (res) {
          if (!res.ok) { if (fail(res, rel)) return finishPass(firstError, changed); return done(); }
          s.files[rel] = { rs: remote[rel].sig, ls: res.size + ':' + res.modified };
          changed = true;
          note('down', rel);
          done();
        });
      }
      if (op.type === 'upload') {
        return upload(s, rel, rel, folders, function (failed, sigs) {
          if (failed) { if (fail(failed, rel)) return finishPass(firstError, changed); return done(); }
          s.files[rel] = sigs;
          note('up', rel);
          done();
        });
      }
      // conflict: the library's copy goes up under a second name, then the
      // server's copy comes down over the original. Both places keep both.
      var copy = conflictName(rel, Date.now());
      upload(s, rel, copy, folders, function (failed) {
        if (failed) { if (fail(failed, rel)) return finishPass(firstError, changed); return done(); }
        download(s, rel, rel, function (res) {
          if (!res.ok) { if (fail(res, rel)) return finishPass(firstError, changed); return done(); }
          s.files[rel] = { rs: remote[rel].sig, ls: res.size + ':' + res.modified };
          changed = true;
          note('conflict', rel);
          done();
        });
      });
    }
    step();
  });
  return true;
}

function tick() {
  if (!hasHost() || !pluginContext.isKiosk) return;
  var s = load();
  if (run.pendingLogin && Date.now() - run.pendingLogin.at > 5 * 60000) run.pendingLogin = null;
  if (!s.auto || run.phase === 'syncing' || !signedIn()) return;
  if (Date.now() - run.lastAttempt < AUTO_EVERY_MS) return;
  if (jobBusy()) return;
  syncNow();
}

/* ---------- sign-in ---------- */

function finishLogin(server, username, token) {
  var s = load();
  var changedAccount = s.server !== server || s.username !== username;
  s.server = server;
  s.username = username;
  s.token = token;
  if (changedAccount) { s.files = {}; s.folder = null; s.recent = []; s.lastSync = null; }
  save();
  run.pendingLogin = null;
  run.error = null;
  run.login = { state: 'ok', error: null };
}

function login(req) {
  var pending = run.pendingLogin;
  var server = cleanServer(req.server || (pending && pending.server));
  var username = String(req.username || (pending && pending.username) || '').trim().toLowerCase();
  var password = req.password || (pending && pending.password) || '';
  var code = req.code ? String(req.code).trim() : null;
  if (!server || !username || !password) { run.login = { state: 'error', error: 'Enter the server, username and password.' }; return; }
  run.login = { state: 'working', error: null };

  // An app password is already a token: check it and keep it.
  if (password.indexOf('vx_') === 0) {
    pluginContext.http.request({ url: server + '/api/me', headers: { Authorization: 'Bearer ' + password } }, function (res) {
      if (!res.ok) { run.login = { state: 'error', error: res.status ? "That app password isn't valid (it may have been revoked)." : explain(res, 'Sign-in') }; return; }
      var me = {};
      try { me = JSON.parse(res.body); } catch (e) { }
      if (me.username && String(me.username).toLowerCase() !== username) { run.login = { state: 'error', error: 'That app password belongs to a different user.' }; return; }
      finishLogin(server, username, password);
    });
    return;
  }

  pluginContext.http.request({
    method: 'POST',
    url: server + '/api/auth/token',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username, password: password, code: code, name: 'ncSender kiosk' })
  }, function (res) {
    var v = {};
    try { v = JSON.parse(res.body); } catch (e) { }
    if (res.ok && v.token) return finishLogin(server, String(v.username || username).toLowerCase(), v.token);
    if (v.totp_required === true && !code) {
      run.pendingLogin = { server: server, username: username, password: password, at: Date.now() };
      run.login = { state: 'needCode', error: null };
      return;
    }
    var message = v.error || (res.status ? 'Sign-in failed (' + res.status + ').' : explain(res, 'Sign-in'));
    // A wrong code: stay on the code step with the password still in hand.
    run.login = { state: code && run.pendingLogin ? 'needCode' : 'error', error: message };
  });
}

function browse(path) {
  var s = load();
  path = cleanFolder(path);
  run.browse = { path: path, state: 'working', folders: [], error: null };
  listFolder(s, path, function (res, children) {
    if (run.browse.path !== path) return;
    if (!res.ok) { run.browse = { path: path, state: 'error', folders: [], error: explain(res, 'The folder') }; return; }
    var folders = [], files = 0;
    for (var i = 0; i < children.length; i++) {
      if (children[i].folder) folders.push(children[i].name);
      else if (isGcode(children[i].name)) files++;
    }
    folders.sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
    run.browse = { path: path, state: 'ok', folders: folders, files: files, error: null };
  });
}

/* ---------- the plugin window ---------- */

function status() {
  var s = load();
  return {
    version: 1,
    kiosk: !!pluginContext.isKiosk,
    libraryPath: pluginContext.files.root,
    signedIn: signedIn(),
    server: s.server || '',
    username: s.username || '',
    folder: s.folder === undefined ? null : s.folder,
    localFolder: LOCAL_ROOT,
    auto: !!s.auto,
    phase: run.phase,
    busy: jobBusy(),
    error: run.error,
    warning: run.warning,
    progress: run.progress,
    lastSync: s.lastSync || null,
    recent: s.recent.slice(0, 12),
    login: run.login,
    browse: run.browse
  };
}

function onRequest(req) {
  if (!hasHost()) return { unsupported: true };
  var s = load();
  // Off a kiosk the window only shows how to install the Vaultix app.
  if (!pluginContext.isKiosk) return status();
  switch (req && req.action) {
    case 'login': login(req); break;
    case 'cancelLogin': run.pendingLogin = null; run.login = { state: 'idle', error: null }; break;
    case 'browse': if (signedIn()) browse(req.path); break;
    case 'setFolder':
      var folder = cleanFolder(req.folder);
      if (s.folder !== folder) { s.folder = folder; s.files = {}; s.lastSync = null; }
      save();
      syncNow();
      break;
    case 'changeFolder': s.folder = null; save(); break;
    case 'setAuto': s.auto = !!req.auto; save(); break;
    case 'syncNow': syncNow(); break;
    case 'signOut':
      store = { files: {}, recent: [], auto: true, server: s.server, username: s.username };
      save();
      run.login = { state: 'idle', error: null };
      run.error = null;
      run.warning = null;
      break;
  }
  return status();
}

if (typeof pluginContext !== 'undefined' && pluginContext && typeof pluginContext.setInterval === 'function') {
  pluginContext.setInterval(function () { tick(); }, TICK_MS);
}

export { planSync, parseMultistatus, conflictName, base64, cleanFolder, cleanServer, isGcode, onRequest, tick };
