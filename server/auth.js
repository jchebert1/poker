'use strict';
/**
 * Identity comes from Cloudflare Access. Every request that reaches this app through the
 * tunnel carries a JWT (header `Cf-Access-Jwt-Assertion`, also cookie `CF_Authorization`).
 * We verify it against the team's public keys, per Cloudflare's docs:
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 *
 * AUTH_MODE=dev bypasses this for LAN testing: identity is a `dev_user` cookie you pick on a login page.
 */
const crypto = require('node:crypto');
const https = require('node:https');

const MODE = (process.env.AUTH_MODE || 'cloudflare').toLowerCase();
const TEAM_DOMAIN = (process.env.CF_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const POLICY_AUD = process.env.CF_POLICY_AUD || '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

if (MODE === 'cloudflare' && (!TEAM_DOMAIN || !POLICY_AUD)) {
  console.error('FATAL: CF_TEAM_DOMAIN and CF_POLICY_AUD are required when AUTH_MODE=cloudflare (set AUTH_MODE=dev for local testing)');
  process.exit(1);
}

let jwks = { keys: [], fetchedAt: 0 };
function fetchJwks() {
  return new Promise((resolve, reject) => {
    const url = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;
    https.get(url, { timeout: 8000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          jwks = { keys: j.keys || [], fetchedAt: Date.now() };
          resolve(jwks);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getKey(kid) {
  const stale = Date.now() - jwks.fetchedAt > 3600 * 1000;
  let k = jwks.keys.find(x => x.kid === kid);
  if (!k || stale) {
    try { await fetchJwks(); } catch (e) { if (!k) throw e; console.warn('JWKS refresh failed, using cached keys:', e.message); }
    k = jwks.keys.find(x => x.kid === kid);
  }
  return k;
}

function b64url(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

const verifyCache = new Map(); // token -> { email, exp }

async function verifyAccessJwt(token) {
  const cached = verifyCache.get(token);
  if (cached && cached.exp * 1000 > Date.now()) return cached;
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(b64url(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64url(parts[1]).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('unexpected alg');
  const key = await getKey(header.kid);
  if (!key) throw new Error('unknown kid');
  const pub = crypto.createPublicKey({ key, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), pub, b64url(parts[2]));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('expired');
  if (payload.nbf && payload.nbf > now + 60) throw new Error('not yet valid');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(POLICY_AUD)) throw new Error('aud mismatch');
  if (payload.iss !== `https://${TEAM_DOMAIN}`) throw new Error('iss mismatch');
  if (!payload.email) throw new Error('no email in token');
  const id = { email: String(payload.email).toLowerCase(), exp: payload.exp };
  if (verifyCache.size > 500) verifyCache.clear();
  verifyCache.set(token, id);
  return id;
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Resolve the caller's identity. Returns { email, isAdmin } or null. */
async function identify(req) {
  const cookies = parseCookies(req);
  if (MODE === 'dev') {
    const email = (cookies.dev_user || '').toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return null;
    return { email, isAdmin: ADMIN_EMAILS.length === 0 || ADMIN_EMAILS.includes(email) };
  }
  const token = req.headers['cf-access-jwt-assertion'] || cookies.CF_Authorization;
  if (!token) return null;
  try {
    const { email } = await verifyAccessJwt(token);
    return { email, isAdmin: ADMIN_EMAILS.includes(email) };
  } catch (e) {
    console.warn('Access JWT rejected:', e.message);
    return null;
  }
}

module.exports = { identify, parseCookies, MODE, ADMIN_EMAILS, verifyAccessJwt, _test: { setJwks: (k) => { jwks = { keys: k, fetchedAt: Date.now() }; } } };
