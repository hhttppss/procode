'use strict';

/**
 * Учётные записи менеджеров: data/users.json.
 *
 * Пароли не хранятся: для каждого пользователя лежит случайная соль и scrypt-хэш.
 * Даже если файл попадёт не в те руки, восстановить пароль из него нельзя.
 *
 * Если файл отсутствует или пуст, вход работает по ADMIN_LOGIN/ADMIN_PASSWORD из .env —
 * чтобы свежескачанный проект запускался без настройки.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// N=16384 — около 50 мс на проверку. Это ощутимо замедляет перебор
// и незаметно для человека, который вводит пароль один раз.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD = 6;
const MAX_LOGIN = 64;

function hashPassword(password, salt) {
  return crypto
    .scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
    .toString('hex');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

/** Заглушка, чтобы неверный логин проверялся столько же времени, сколько верный. */
const DUMMY_SALT = makeSalt();
const DUMMY_HASH = hashPassword(crypto.randomBytes(32).toString('hex'), DUMMY_SALT);

function normalizeLogin(login) {
  return String(login == null ? '' : login).trim();
}

/** Логин — не секрет, поэтому сравниваем без учёта регистра: так менеджеру проще войти. */
function loginKey(login) {
  return normalizeLogin(login).toLowerCase();
}

// ------------------------------------------------------------------ чтение

// Файл крошечный, но читать его на каждый запрос незачем — кэшируем по времени изменения.
let cache = { mtimeMs: -1, users: [] };

function readSync() {
  let stat;
  try {
    stat = fs.statSync(USERS_FILE);
  } catch {
    cache = { mtimeMs: -1, users: [] };
    return cache.users;
  }

  if (stat.mtimeMs === cache.mtimeMs) return cache.users;

  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    const users = Array.isArray(parsed)
      ? parsed.filter((u) => u && typeof u.login === 'string' && typeof u.salt === 'string' && typeof u.hash === 'string')
      : [];
    cache = { mtimeMs: stat.mtimeMs, users };
  } catch (error) {
    console.error(`Файл ${USERS_FILE} повреждён (${error.message}). Вход по нему невозможен.`);
    cache = { mtimeMs: stat.mtimeMs, users: [] };
  }

  return cache.users;
}

async function writeAll(users) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const temp = `${USERS_FILE}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(temp, `${JSON.stringify(users, null, 2)}\n`, 'utf8');
    await fsp.rename(temp, USERS_FILE);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  cache = { mtimeMs: -1, users: [] };
}

// ------------------------------------------------------------------- API

function isEmpty() {
  return readSync().length === 0;
}

function list() {
  return readSync().map((u) => ({ login: u.login, createdAt: u.createdAt || null, updatedAt: u.updatedAt || null }));
}

function exists(login) {
  const key = loginKey(login);
  return readSync().some((u) => loginKey(u.login) === key);
}

/**
 * Проверяет пару логин/пароль.
 * @returns {string|null} логин в том виде, в каком он записан, либо null.
 */
function verify(login, password) {
  const key = loginKey(login);
  const user = readSync().find((u) => loginKey(u.login) === key);

  // Хэш считается всегда — по времени ответа нельзя понять, существует ли логин.
  const salt = user ? user.salt : DUMMY_SALT;
  const expected = user ? user.hash : DUMMY_HASH;
  const actual = hashPassword(password == null ? '' : password, salt);

  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);

  return match && user ? user.login : null;
}

/** Создаёт пользователя или меняет пароль существующему. */
async function upsert(login, password) {
  const clean = normalizeLogin(login);
  if (clean.length < 3 || clean.length > MAX_LOGIN) {
    throw new Error(`Логин должен быть от 3 до ${MAX_LOGIN} символов.`);
  }
  if (String(password == null ? '' : password).length < MIN_PASSWORD) {
    throw new Error(`Пароль должен быть не короче ${MIN_PASSWORD} символов.`);
  }

  const users = readSync().slice();
  const salt = makeSalt();
  const record = { login: clean, salt, hash: hashPassword(password, salt), updatedAt: new Date().toISOString() };

  const index = users.findIndex((u) => loginKey(u.login) === loginKey(clean));
  if (index === -1) {
    record.createdAt = record.updatedAt;
    users.push(record);
  } else {
    record.createdAt = users[index].createdAt || record.updatedAt;
    users[index] = record;
  }

  await writeAll(users);
  return { login: clean, created: index === -1 };
}

async function remove(login) {
  const users = readSync();
  const rest = users.filter((u) => loginKey(u.login) !== loginKey(login));
  if (rest.length === users.length) return false;
  await writeAll(rest);
  return true;
}

module.exports = {
  usersFile: USERS_FILE,
  MIN_PASSWORD,
  isEmpty,
  list,
  exists,
  verify,
  upsert,
  remove,
};
