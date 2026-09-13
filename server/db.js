'use strict';
// Player profiles + persisted table settings, in SQLite via Node's built-in node:sqlite (no native deps).
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'poker.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS profiles (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner TEXT NOT NULL,
    mime TEXT NOT NULL,
    image BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const DEFAULT_AVATARS = ['🐻', '🦊', '🐯', '🦁', '🐸', '🐵', '🐼', '🦉', '🐺', '🦈', '🐉', '🦅', '🐙', '🦕', '🐲', '👑', '🎩', '🃏', '🎲', '💎'];

const stmts = {
  get: db.prepare('SELECT * FROM profiles WHERE email = ?'),
  insert: db.prepare('INSERT INTO profiles (email, name, avatar, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
  update: db.prepare('UPDATE profiles SET name = ?, avatar = ?, settings = ?, updated_at = ? WHERE email = ?'),
  kvGet: db.prepare('SELECT value FROM kv WHERE key = ?'),
  themeList: db.prepare('SELECT t.id, t.name, t.owner, t.created_at, p.name AS ownerName FROM themes t LEFT JOIN profiles p ON p.email = t.owner ORDER BY t.created_at'),
  themeCount: db.prepare('SELECT COUNT(*) AS n FROM themes'),
  themeInsert: db.prepare('INSERT INTO themes (id, name, owner, mime, image, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  themeImage: db.prepare('SELECT mime, image FROM themes WHERE id = ?'),
  themeDelete: db.prepare('DELETE FROM themes WHERE id = ?'),
  kvSet: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};

function rowToProfile(r) { return { email: r.email, name: r.name, avatar: r.avatar, settings: JSON.parse(r.settings || '{}') }; }

function getOrCreateProfile(email) {
  const r = stmts.get.get(email);
  if (r) return rowToProfile(r);
  const local = email.split('@')[0];
  const name = local.replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 24) || 'Player';
  // deterministic default avatar per email
  let h = 0; for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const avatar = DEFAULT_AVATARS[h % DEFAULT_AVATARS.length];
  const now = Date.now();
  stmts.insert.run(email, name, avatar, '{}', now, now);
  return { email, name, avatar, settings: {} };
}

function updateProfile(email, patch) {
  const cur = getOrCreateProfile(email);
  const name = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim().slice(0, 24) : cur.name;
  let avatar = cur.avatar;
  if (typeof patch.avatar === 'string' && patch.avatar) {
    if (patch.avatar.startsWith('data:image/')) {
      if (patch.avatar.length > 200 * 1024) throw new Error('Avatar image too large (max ~150KB)');
      avatar = patch.avatar;
    } else avatar = patch.avatar.slice(0, 8); // emoji / short text
  }
  const settings = { ...cur.settings, ...(patch.settings && typeof patch.settings === 'object' ? patch.settings : {}) };
  stmts.update.run(name, avatar, JSON.stringify(settings), Date.now(), email);
  return { email, name, avatar, settings };
}

function kvGet(key, fallback) {
  const r = stmts.kvGet.get(key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return fallback; }
}
function kvSet(key, value) { stmts.kvSet.run(key, JSON.stringify(value)); }

// ---------- custom (image) themes
const MAX_THEMES = 24;
function listThemes() { return stmts.themeList.all().map(r => ({ id: r.id, name: r.name, owner: r.owner, ownerName: r.ownerName || r.owner.split('@')[0] })); }
function addTheme(owner, name, dataUrl) {
  if (stmts.themeCount.get().n >= MAX_THEMES) throw new Error(`Theme limit reached (${MAX_THEMES}); ask the admin to delete one`);
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Upload must be a JPEG, PNG or WebP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 1.5 * 1024 * 1024) throw new Error('Image too large (max 1.5 MB after resize)');
  const id = require('node:crypto').randomBytes(6).toString('hex');
  const clean = String(name || '').trim().slice(0, 24) || 'Custom theme';
  stmts.themeInsert.run(id, clean, owner, m[1], buf, Date.now());
  return { id, name: clean, owner };
}
function getThemeImage(id) { const r = stmts.themeImage.get(id); return r ? { mime: r.mime, image: r.image } : null; }
function deleteTheme(id) { return stmts.themeDelete.run(id).changes > 0; }

module.exports = { getOrCreateProfile, updateProfile, kvGet, kvSet, DEFAULT_AVATARS, DATA_DIR, listThemes, addTheme, getThemeImage, deleteTheme };
