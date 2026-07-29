'use strict';

/**
 * Сессия администратора: подписанная HMAC-SHA256 cookie без внешних зависимостей.
 * Формат cookie pc_session:  base64url(JSON payload) + "." + base64url(подпись)
 * Payload: { login, exp } — срок жизни 12 часов.
 *
 * Здесь же живут общие средства защиты по IP (createRateLimiter, getClientIp):
 * их используют и вход в админку, и публичная форма заявок.
 */

const crypto = require('crypto');

const config = require('./config');
const users = require('./users');

const SESSION_COOKIE = 'pc_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const LOGIN_ATTEMPT_LIMIT = 8;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- утилиты IP

function getClientIp(req) {
  const raw = req.ip || req.socket?.remoteAddress || 'unknown';
  // ::ffff:127.0.0.1 → 127.0.0.1
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * Счётчик событий по ключу (обычно IP) в скользящем окне. Живёт в памяти:
 * при перезапуске сервера сбрасывается — для одного небольшого сайта этого достаточно.
 */
function createRateLimiter({ limit, windowMs, sweepMs = 60 * 1000 }) {
  const hits = new Map();
  let lastSweep = 0;

  function fresh(stamps, now) {
    return stamps.filter((stamp) => now - stamp < windowMs);
  }

  function sweep(now) {
    if (now - lastSweep < sweepMs) return;
    lastSweep = now;

    for (const [key, stamps] of hits) {
      const kept = fresh(stamps, now);
      if (kept.length > 0) hits.set(key, kept);
      else hits.delete(key);
    }
  }

  return {
    isBlocked(key) {
      const now = Date.now();
      sweep(now);
      return fresh(hits.get(key) || [], now).length >= limit;
    },

    hit(key) {
      const now = Date.now();
      sweep(now);
      const stamps = fresh(hits.get(key) || [], now);
      stamps.push(now);
      hits.set(key, stamps);
      return stamps.length;
    },

    reset(key) {
      hits.delete(key);
    },
  };
}

const loginLimiter = createRateLimiter({
  limit: LOGIN_ATTEMPT_LIMIT,
  windowMs: LOGIN_ATTEMPT_WINDOW_MS,
});

// ------------------------------------------------------- сравнения и подписи

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

/** Сравнение строк постоянного времени: длина скрывается за хэшированием. */
function safeCompare(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function sign(encodedPayload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(encodedPayload).digest('base64url');
}

function createToken(login) {
  const payload = { login, exp: Date.now() + SESSION_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

function readToken(token) {
  if (typeof token !== 'string') return null;

  const separator = token.indexOf('.');
  if (separator <= 0) return null;

  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!signature) return null;

  if (!safeCompare(signature, sign(encoded))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || typeof payload.login !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp <= Date.now()) return null;
    // Учётную запись удалили или переименовали — старые сессии сразу перестают действовать.
    if (!isKnownLogin(payload.login)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- cookies

function parseCookies(header) {
  const result = {};
  if (typeof header !== 'string' || header === '') return result;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const name = part.slice(0, separator).trim();
    if (!name) continue;

    const value = part.slice(separator + 1).trim();
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }

  return result;
}

function isSecureRequest(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function buildCookie(value, maxAgeSeconds, req) {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function setSession(req, res, login) {
  res.setHeader('Set-Cookie', buildCookie(createToken(login), Math.floor(SESSION_TTL_MS / 1000), req));
}

function clearSession(req, res) {
  res.setHeader('Set-Cookie', buildCookie('', 0, req));
}

function getSession(req) {
  if (req.pcSession !== undefined) return req.pcSession;

  const cookies = parseCookies(req.headers.cookie);
  req.pcSession = readToken(cookies[SESSION_COOKIE]);
  return req.pcSession;
}

// --------------------------------------------------------------- вход/выход

/** Есть ли такая учётная запись — из файла пользователей либо из .env, если файл пуст. */
function isKnownLogin(login) {
  if (users.isEmpty()) return login === config.adminLogin;
  return users.exists(login);
}

/**
 * Проверяет логин и пароль.
 * @returns {string|null} логин в каноническом виде (как записан) либо null.
 */
function checkCredentials(login, password) {
  if (!users.isEmpty()) return users.verify(login, password);

  // Запасной путь: пользователей ещё не завели, работает единственный админ из .env.
  // Оба сравнения выполняются всегда — время ответа не зависит от того, что именно неверно.
  const loginOk = safeCompare(typeof login === 'string' ? login : '', config.adminLogin);
  const passwordOk = safeCompare(typeof password === 'string' ? password : '', config.adminPassword);
  return loginOk && passwordOk ? config.adminLogin : null;
}

function isLoginBlocked(req) {
  return loginLimiter.isBlocked(getClientIp(req));
}

function registerLoginFailure(req) {
  loginLimiter.hit(getClientIp(req));
}

function registerLoginSuccess(req) {
  loginLimiter.reset(getClientIp(req));
}

// ------------------------------------------------------------- middleware

function requirePage(req, res, next) {
  if (getSession(req)) return next();
  return res.redirect('/admin/login');
}

function requireApi(req, res, next) {
  if (getSession(req)) return next();
  return res.status(401).json({ ok: false, message: 'Нужно войти в админ-панель.' });
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_ATTEMPT_WINDOW_MS,
  createRateLimiter,
  getClientIp,
  parseCookies,
  setSession,
  clearSession,
  getSession,
  checkCredentials,
  isKnownLogin,
  isLoginBlocked,
  registerLoginFailure,
  registerLoginSuccess,
  requirePage,
  requireApi,
};
