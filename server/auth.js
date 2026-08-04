'use strict';

/**
 * Сессия сотрудника: подписанная HMAC-SHA256 cookie без внешних зависимостей.
 * Формат cookie pc_session:  base64url(JSON payload) + "." + base64url(подпись)
 * Payload: { uid, login, role, exp } — срок жизни 12 часов.
 *
 * Роль в токене лежит только для быстрой отбраковки: настоящая проверка прав всегда
 * идёт по свежей записи из data/users.json (attachUser). Поэтому заблокированный
 * сотрудник теряет доступ сразу, не дожидаясь истечения cookie.
 *
 * Здесь же живут общие средства защиты по IP (createRateLimiter, getClientIp):
 * их используют и вход в систему, и публичная форма заявок.
 */

const crypto = require('crypto');

const config = require('./config');
const users = require('./models/users');

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
 * при перезапуске сервера сбрасывается — для одной небольшой школы этого достаточно.
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

function createToken(user) {
  const payload = { uid: user.id, login: user.login, role: user.role, exp: Date.now() + SESSION_TTL_MS };
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
    if (!payload || typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
    if (typeof payload.login !== 'string' && typeof payload.uid !== 'string') return null;
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
  const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function setSession(req, res, user) {
  res.setHeader('Set-Cookie', buildCookie(createToken(user), Math.floor(SESSION_TTL_MS / 1000), req));
}

function clearSession(req, res) {
  res.setHeader('Set-Cookie', buildCookie('', 0, req));
}

// --------------------------------------------------------------- вход/выход

/**
 * Проверяет логин и пароль.
 * @returns {Promise<{ok: true, user: object} | {ok: false, reason: string}>}
 */
async function checkCredentials(login, password) {
  if (!(await users.isEmpty())) {
    const user = await users.verify(login, password);
    if (!user) return { ok: false, reason: 'credentials' };
    if (!user.active) return { ok: false, reason: 'blocked' };
    return { ok: true, user };
  }

  // Запасной путь: сотрудников ещё не завели, работает единственный админ из .env.
  // Оба сравнения выполняются всегда — время ответа не зависит от того, что именно неверно.
  const loginOk = safeCompare(typeof login === 'string' ? login : '', config.adminLogin);
  const passwordOk = safeCompare(typeof password === 'string' ? password : '', config.adminPassword);
  if (!loginOk || !passwordOk) return { ok: false, reason: 'credentials' };

  return {
    ok: true,
    user: {
      id: 'env-admin',
      login: config.adminLogin,
      role: 'admin',
      name: config.adminLogin,
      active: true,
      fromEnv: true,
    },
  };
}

/** Учётка из .env: существует, пока data/users.json пуст. */
function envAdmin() {
  return {
    id: 'env-admin',
    login: config.adminLogin,
    role: 'admin',
    name: config.adminLogin,
    phone: '',
    email: '',
    courses: [],
    rate: 0,
    active: true,
    note: '',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastLoginAt: null,
    fromEnv: true,
  };
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

/**
 * Кладёт в req.user актуальную запись сотрудника (или null).
 * Ставится один раз в начале цепочки — дальше все проверки прав синхронные.
 */
async function attachUser(req, res, next) {
  try {
    req.user = null;

    const payload = readToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!payload) return next();

    // Учётка из .env действует, только пока не заведён ни один сотрудник.
    if (payload.uid === 'env-admin') {
      if (await users.isEmpty()) req.user = envAdmin();
      return next();
    }

    // По идентификатору — основной путь; по логину — для сессий, выданных до обновления.
    const user = (payload.uid ? await users.getById(payload.uid) : null) || (await users.getByLogin(payload.login));

    // Учётку удалили или заблокировали — сессия перестаёт действовать немедленно.
    if (user && user.active) req.user = user;

    return next();
  } catch (error) {
    return next(error);
  }
}

function loginRedirect(req, res) {
  const target = req.originalUrl && req.originalUrl.startsWith('/app') ? req.originalUrl : '';
  const suffix = target ? `?next=${encodeURIComponent(target)}` : '';
  return res.redirect(`/login${suffix}`);
}

function requirePage(req, res, next) {
  if (req.user) return next();
  return loginRedirect(req, res);
}

function requireApi(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ ok: false, message: 'Нужно войти в систему.' });
}

/**
 * Ограничение целого раздела по ролям: auth.requireRoleApi('admin', 'manager').
 *
 * Перечень ролей стоит один раз на роутере (см. routes/api/index.js), поэтому
 * обработчики модуля пишутся уже без проверок «а можно ли сюда вообще» — они
 * занимаются только тем, что доступно не всякому, кто раздел открыл.
 */
function requireRoleApi(...roles) {
  return function checkRole(req, res, next) {
    if (!req.user) return res.status(401).json({ ok: false, message: 'Нужно войти в систему.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, message: 'Недостаточно прав для этого раздела.' });
    }
    return next();
  };
}

/** Частый случай — раздел целиком администраторский. */
const requireAdminApi = requireRoleApi('admin');

/**
 * Защита от подделки запросов с чужого сайта.
 * SameSite=Lax уже отсекает межсайтовые POST из форм; здесь добавлена проверка Origin
 * для случаев, когда запрос всё же долетел (старый браузер, редирект).
 */
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const origin = req.headers.origin;
  if (!origin) return next(); // curl и серверные вызовы заголовок не шлют

  let host;
  try {
    host = new URL(origin).host;
  } catch {
    host = '';
  }

  if (host && host === req.headers.host) return next();
  return res.status(403).json({ ok: false, message: 'Запрос отклонён: неизвестный источник.' });
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
  checkCredentials,
  envAdmin,
  isLoginBlocked,
  registerLoginFailure,
  registerLoginSuccess,
  attachUser,
  requirePage,
  requireApi,
  requireRoleApi,
  requireAdminApi,
  sameOrigin,
};
