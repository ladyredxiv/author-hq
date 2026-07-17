import crypto from 'node:crypto';
import { getSetting } from './config.js';

const cookieName = 'author_hq_auth';

export function requireAuth(req, res, next) {
  const passphrase = getSetting('AUTH_PASSPHRASE');
  if (!passphrase || passphrase === 'change-me') return next();
  if (isValidCookie(req)) return next();
  res.redirect('/login');
}

export function loginPage(message = '') {
  return `<!doctype html>
  <html><head><title>Author HQ Login</title><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#faf8f5;color:#1a1612}form{width:min(360px,90vw);background:white;border:1px solid #e2ddd6;border-radius:8px;padding:24px}input,button{width:100%;box-sizing:border-box;padding:10px;margin-top:10px}button{background:#8b4a2f;color:white;border:0;border-radius:6px}</style></head>
  <body><form method="post" action="/login"><h1>Author HQ</h1>${message ? `<p>${message}</p>` : ''}<input type="password" name="passphrase" placeholder="Passphrase" autofocus><button>Enter</button></form></body></html>`;
}

export function handleLogin(req, res) {
  if (req.body.passphrase !== getSetting('AUTH_PASSPHRASE')) {
    res.status(401).send(loginPage('Nope. Try the other magic words.'));
    return;
  }
  res.cookie(cookieName, sign('ok'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30
  });
  res.redirect('/');
}

export function handleLogout(req, res) {
  res.clearCookie(cookieName);
  res.redirect('/login');
}

function isValidCookie(req) {
  const raw = req.headers.cookie || '';
  const value = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
  if (!value) return false;
  return value.slice(cookieName.length + 1) === sign('ok');
}

function sign(value) {
  const secret = getSetting('COOKIE_SECRET', 'dev-secret');
  const sig = crypto.createHmac('sha256', secret).update(value).digest('hex');
  return `${value}.${sig}`;
}
