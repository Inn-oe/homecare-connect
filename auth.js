const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Signing secret: APP_SECRET env var, otherwise generated once and kept in .secret.
function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const file = path.join(__dirname, '.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret);
  return secret;
}
const SECRET = loadSecret();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const hmac = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');

function issueToken(user) {
  const body = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  return `${body}.${hmac(body)}`;
}

// Returns the token payload, or null if the token is missing, forged or expired.
function readToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, issueToken, readToken };
