'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const auth = require('./auth');
const db = require('./db');
const { Table, THEMES } = require('./engine/table');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

// ---------- the one table
const table = new Table(db.kvGet('tableSettings', {}));
table.customThemes = db.listThemes();
table.on('change', scheduleBroadcast);

// ---------- SSE hub
const clients = new Map(); // res -> { email, isAdmin }
function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
let broadcastPending = false;
function scheduleBroadcast() {
  if (broadcastPending) return;
  broadcastPending = true;
  setImmediate(() => {
    broadcastPending = false;
    for (const [res, c] of clients) {
      try { sseSend(res, 'state', table.stateFor(c.email, c.isAdmin)); } catch (e) { clients.delete(res); }
    }
  });
}
setInterval(() => { for (const res of clients.keys()) { try { res.write(': ping\n\n'); } catch { clients.delete(res); } } }, 20000);

function connectedCount(email) { let n = 0; for (const c of clients.values()) if (c.email === email) n++; return n; }

// ---------- helpers
function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function readBody(req, limit = 2200 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    fs.createReadStream(file).pipe(res);
  });
}

function playerProfile(identity) {
  const prof = db.getOrCreateProfile(identity.email);
  return { id: identity.email, name: prof.name, avatar: prof.avatar, profile: prof };
}

// ---------- actions
function handleAction(identity, body) {
  const id = identity.email;
  const t = table;
  const admin = () => { if (!identity.isAdmin) throw new Error('Admin only'); };
  switch (body.type) {
    case 'sit': { const pp = playerProfile(identity); return t.sit({ id, name: pp.name, avatar: pp.avatar }, body.seat); }
    case 'leave': return t.leave(id);
    case 'rebuy': return t.rebuy(id);
    case 'sitout': return t.sitOut(id, !!body.out);
    case 'theme': return t.queueTheme(id, body.theme);
    case 'act': return t.act(id, { action: body.action, amount: body.amount });
    case 'chat': {
      const pp = playerProfile(identity);
      if (!body.text || !String(body.text).trim()) return { error: 'Empty message' };
      t.addChat({ name: pp.name, avatar: pp.avatar }, String(body.text).trim());
      return { ok: true };
    }
    // ----- admin
    case 'settings': { admin(); const s = t.updateSettings(body.settings || {}); db.kvSet('tableSettings', s); return { ok: true, settings: s }; }
    case 'start': admin(); return t.startGame();
    case 'pause': admin(); return t.pauseGame(!!body.pause);
    case 'end': admin(); return t.endGame();
    case 'addBot': { const pp = playerProfile(identity); const r = t.addBot(body.level || 2); if (r.player) t.addLog(`${pp.name} added bot ${r.player.name} (L${r.player.botLevel})`); return r; }
    case 'botLevel': return t.setBotLevel(body.id, body.level);
    case 'kick': { const p = t.findPlayer(body.id); if (!p) return { error: 'No such player' }; if (!p.isBot) admin(); const pp = playerProfile(identity); return t.leave(body.id, p.isBot ? `was removed by ${pp.name}` : 'was kicked by the admin'); }
    case 'addTheme': {
      const pp = playerProfile(identity);
      const t = db.addTheme(identity.email, body.name, body.image);
      table.setCustomThemes(db.listThemes());
      table.addLog(`${pp.name} added a new theme "${t.name}"`, 'theme');
      return { ok: true, id: 'custom:' + t.id };
    }
    case 'deleteTheme': {
      admin();
      const id = String(body.id || '').replace(/^custom:/, '');
      if (!db.deleteTheme(id)) return { error: 'No such theme' };
      table.setCustomThemes(db.listThemes());
      return { ok: true };
    }
    case 'clearSummary': admin(); t.summary = null; t.emitChange(); return { ok: true };
    default: return { error: 'Unknown action type' };
  }
}

// ---------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/healthz') return json(res, 200, { ok: true, phase: table.phase, players: table.players().length });

    // dev-mode login page
    if (auth.MODE === 'dev' && p === '/dev/login') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+$/.test(email)) return json(res, 400, { error: 'Enter an email-like id' });
        res.writeHead(200, { 'Set-Cookie': `dev_user=${encodeURIComponent(email)}; Path=/; SameSite=Lax; Max-Age=2592000`, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      return serveStatic(req, res, '/dev-login.html');
    }
    if (p === '/dev/logout') {
      res.writeHead(302, { 'Set-Cookie': 'dev_user=; Path=/; Max-Age=0', Location: '/' });
      return res.end();
    }

    if (p.startsWith('/api/')) {
      const identity = await auth.identify(req);
      if (!identity) return json(res, 401, { error: 'unauthenticated', devMode: auth.MODE === 'dev' });

      if (p === '/api/me' && req.method === 'GET') {
        const prof = db.getOrCreateProfile(identity.email);
        return json(res, 200, { ...prof, isAdmin: identity.isAdmin, authMode: auth.MODE, avatars: db.DEFAULT_AVATARS, themes: THEMES });
      }
      if (p === '/api/profile' && req.method === 'POST') {
        const body = await readBody(req);
        const prof = db.updateProfile(identity.email, body);
        table.updateProfile(identity.email, { name: prof.name, avatar: prof.avatar });
        return json(res, 200, prof);
      }
      if (p === '/api/action' && req.method === 'POST') {
        const body = await readBody(req);
        let result;
        try { result = handleAction(identity, body); } catch (e) { result = { error: e.message }; }
        if (result && result.error) return json(res, 400, result);
        return json(res, 200, { ok: true, ...(result || {}) });
      }
      if (p === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
        });
        res.write(':ok\n\n');
        clients.set(res, { email: identity.email, isAdmin: identity.isAdmin });
        table.setConnected(identity.email, true);
        sseSend(res, 'state', table.stateFor(identity.email, identity.isAdmin));
        req.on('close', () => {
          clients.delete(res);
          if (connectedCount(identity.email) === 0) table.setConnected(identity.email, false);
        });
        return;
      }
      const tm = /^\/api\/theme-image\/([a-f0-9]{12})$/.exec(p);
      if (tm && req.method === 'GET') {
        const img = db.getThemeImage(tm[1]);
        if (!img) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': img.mime, 'Content-Length': img.image.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
        return res.end(Buffer.from(img.image));
      }
      return json(res, 404, { error: 'not found' });
    }
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message || 'server error' });
  }
});

server.listen(PORT, () => {
  console.log(`poker server listening on :${PORT}  auth=${auth.MODE}  admins=${auth.ADMIN_EMAILS.join(',') || '(none)'}  data=${db.DATA_DIR}`);
});
process.on('SIGTERM', () => { console.log('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); });
