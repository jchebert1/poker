// Verifies the Cloudflare Access JWT check with a locally generated RSA key (no network).
process.env.AUTH_MODE = 'cloudflare'; process.env.CF_TEAM_DOMAIN = 'team.cloudflareaccess.com'; process.env.CF_POLICY_AUD = 'aud123'; process.env.ADMIN_EMAILS = 'admin@gmail.com';
const crypto = require('node:crypto');
const assert = require('node:assert');
const auth = require('../server/auth');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
auth._test.setJwks([jwk]);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload, key = privateKey, kid = 'k1') {
  const h = b64({ alg: 'RS256', kid }), p = b64(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), key).toString('base64url');
  return `${h}.${p}.${sig}`;
}
const now = Math.floor(Date.now() / 1000);
const good = { email: 'Admin@gmail.com', aud: ['aud123'], iss: 'https://team.cloudflareaccess.com', exp: now + 600, iat: now };
(async () => {
  const id = await auth.identify({ headers: { 'cf-access-jwt-assertion': sign(good) } });
  assert.deepStrictEqual(id, { email: 'admin@gmail.com', isAdmin: true });
  const cookieId = await auth.identify({ headers: { cookie: 'CF_Authorization=' + sign({ ...good, email: 'friend@gmail.com' }) } });
  assert.deepStrictEqual(cookieId, { email: 'friend@gmail.com', isAdmin: false });
  assert.strictEqual(await auth.identify({ headers: {} }), null, 'no token');
  assert.strictEqual(await auth.identify({ headers: { 'cf-access-jwt-assertion': sign({ ...good, exp: now - 10 }) } }), null, 'expired');
  assert.strictEqual(await auth.identify({ headers: { 'cf-access-jwt-assertion': sign({ ...good, aud: ['other'] }) } }), null, 'wrong aud');
  assert.strictEqual(await auth.identify({ headers: { 'cf-access-jwt-assertion': sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }) } }), null, 'wrong iss');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.strictEqual(await auth.identify({ headers: { 'cf-access-jwt-assertion': sign(good, other) } }), null, 'wrong key');
  const t = sign(good); const tampered = t.slice(0, -4) + 'AAAA';
  assert.strictEqual(await auth.identify({ headers: { 'cf-access-jwt-assertion': tampered } }), null, 'tampered');
  console.log('auth tests OK');
})().catch(e => { console.error(e); process.exit(1); });
