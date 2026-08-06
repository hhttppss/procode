'use strict';

/**
 * Учётные записи сотрудников: data/users.json.
 * Одна коллекция на обе роли — администраторов и преподавателей.
 *
 * Пароли не хранятся: для каждого пользователя лежит случайная соль и scrypt-хэш.
 * Даже если файл попадёт не в те руки, восстановить пароль из него нельзя.
 *
 * Если файл отсутствует или пуст, вход работает по ADMIN_LOGIN/ADMIN_PASSWORD из .env —
 * чтобы свежескачанный проект запускался без настройки.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const util = require('util');

const db = require('../db');
const catalog = require('../domain/catalog');

const scrypt = util.promisify(crypto.scrypt);

// N=16384 — около 50 мс на проверку. Это ощутимо замедляет перебор
// и незаметно для человека, который вводит пароль один раз.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const MIN_PASSWORD = 6;
const MIN_LOGIN = 3;
const MAX_LOGIN = 64;

function normalize(record) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.login !== 'string' || !record.login.trim()) return null;

  const createdAt = db.asIsoDateTime(record.createdAt) || new Date().toISOString();

  return {
    // Записи первой версии проекта идентификатора не имели — выдаём его при миграции.
    id: db.asText(record.id) || db.createId('us'),
    login: db.asText(record.login, MAX_LOGIN),
    salt: db.asText(record.salt),
    hash: db.asText(record.hash),
    // Роль по умолчанию — администратор: так учётки из первой версии сохраняют полный доступ.
    role: db.oneOf(record.role, catalog.ROLE_IDS, 'admin'),
    name: db.asText(record.name, 120) || db.asText(record.login, MAX_LOGIN),
    phone: db.asText(record.phone, 40),
    email: db.asText(record.email, 120),
    courses: db.asStringArray(record.courses),
    // Ставка за одно проведённое занятие, ₽. Видит и меняет только администратор.
    rate: db.asMoney(record.rate),
    // Оклад за период, ₽ — фиксированная сумма, в отличие от rate (ставки за одно занятие).
    // У администратора и управляющего занятий нет, поэтому начисление им идёт окладом.
    salary: db.asMoney(record.salary),
    active: db.asBool(record.active, true),
    note: db.asText(record.note, 2000),
    createdAt,
    updatedAt: db.asIsoDateTime(record.updatedAt) || createdAt,
    lastLoginAt: db.asIsoDateTime(record.lastLoginAt),
  };
}

const store = db.collection('users', { normalize, prefix: 'us' });

// ------------------------------------------------------------------ пароли

async function hashPassword(password, salt) {
  const key = await scrypt(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return key.toString('hex');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

/** Заглушка, чтобы неверный логин проверялся столько же времени, сколько верный. */
const DUMMY_SALT = makeSalt();
let dummyHashPromise = null;

function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(crypto.randomBytes(32).toString('hex'), DUMMY_SALT);
  return dummyHashPromise;
}

/** Логин — не секрет, поэтому сравниваем без учёта регистра: так сотруднику проще войти. */
function loginKey(login) {
  return String(login == null ? '' : login)
    .trim()
    .toLowerCase();
}

function checkPasswordRules(password) {
  if (String(password == null ? '' : password).length < MIN_PASSWORD) {
    return `Пароль должен быть не короче ${MIN_PASSWORD} символов.`;
  }
  return null;
}

function checkLoginRules(login) {
  const clean = db.asText(login);
  if (clean.length < MIN_LOGIN || clean.length > MAX_LOGIN) {
    return `Логин должен быть от ${MIN_LOGIN} до ${MAX_LOGIN} символов.`;
  }
  if (/\s/.test(clean)) return 'В логине не должно быть пробелов.';
  return null;
}

// ------------------------------------------------------------------ чтение

async function isEmpty() {
  return (await store.count()) === 0;
}

async function list() {
  return store.list();
}

async function listByRole(role) {
  return store.filter((user) => user.role === role);
}

async function getById(id) {
  return store.getById(id);
}

async function getByLogin(login) {
  const key = loginKey(login);
  if (!key) return null;
  return store.find((user) => loginKey(user.login) === key);
}

async function exists(login) {
  return (await getByLogin(login)) !== null;
}

/**
 * Проверяет пару логин/пароль.
 * @returns {object|null} запись пользователя либо null.
 */
async function verify(login, password) {
  const user = await getByLogin(login);

  // Хэш считается всегда — по времени ответа нельзя понять, существует ли логин.
  const salt = user ? user.salt : DUMMY_SALT;
  const expected = user ? user.hash : await dummyHash();
  const actual = await hashPassword(password == null ? '' : password, salt);

  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  const match = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);

  if (!match || !user) return null;
  return user;
}

// ------------------------------------------------------------------ запись

/**
 * Создаёт учётную запись.
 * @returns {{ok: true, user: object} | {ok: false, errors: object}}
 */
async function create({ login, password, role, name, phone, email, courses, rate, salary, note, active }) {
  const errors = {};

  const loginError = checkLoginRules(login);
  if (loginError) errors.login = loginError;

  const passwordError = checkPasswordRules(password);
  if (passwordError) errors.password = passwordError;

  if (!db.asText(name)) errors.name = 'Укажите ФИО сотрудника.';
  if (!catalog.ROLE_IDS.includes(role)) errors.role = 'Выберите роль.';

  // Ранняя проверка — ради формы: занятый логин показывается вместе с остальными
  // ошибками полей и не заставляет считать хэш зря. Настоящая гарантия — в транзакции ниже.
  if (!loginError && (await exists(login))) errors.login = 'Такой логин уже занят.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // scrypt считается до транзакции: он занимает около 50 мс, и всё это время
  // общая очередь записи стояла бы занятой.
  const salt = makeSalt();
  const hash = await hashPassword(password, salt);

  // Проверка занятости логина и создание записи — одной транзакцией: раздельными
  // вызовами пять одновременных запросов заводили пять сотрудников с одним логином.
  const key = loginKey(login);
  const user = await db.transaction(['users'], (tx) => {
    if (tx.users.find((item) => loginKey(item.login) === key)) return null;

    return tx.users.insert({
      login: db.asText(login),
      salt,
      hash,
      role,
      name,
      phone,
      email,
      courses,
      rate,
      salary,
      note,
      active: active === undefined ? true : active,
    });
  });

  if (!user) return { ok: false, errors: { login: 'Такой логин уже занят.' } };

  return { ok: true, user };
}

/** Обновляет профиль. Пароль здесь не меняется — для него отдельная функция. */
async function update(id, patch) {
  const allowed = ['name', 'phone', 'email', 'courses', 'rate', 'salary', 'active', 'note', 'role'];
  const changes = {};

  for (const field of allowed) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, field)) changes[field] = patch[field];
  }

  if (Object.keys(changes).length === 0) return store.getById(id);
  return store.update(id, changes);
}

async function setPassword(id, password) {
  const error = checkPasswordRules(password);
  if (error) return { ok: false, errors: { password: error } };

  const salt = makeSalt();
  const user = await store.update(id, { salt, hash: await hashPassword(password, salt) });
  if (!user) return { ok: false, errors: { password: 'Сотрудник не найден.' } };

  return { ok: true, user };
}

async function setActive(id, active) {
  return store.update(id, { active: Boolean(active) });
}

async function touchLogin(id) {
  return store.update(id, { lastLoginAt: new Date().toISOString() });
}

async function remove(id) {
  return store.remove(id);
}

/**
 * Создаёт или обновляет учётку по логину. Используется скриптом управления пользователями:
 * там достаточно пары логин/пароль, а роль задаётся отдельным аргументом.
 */
async function upsertByLogin(login, password, { role = 'admin', name } = {}) {
  const existing = await getByLogin(login);

  if (!existing) {
    const result = await create({ login, password, role, name: name || db.asText(login) });
    if (!result.ok) throw new Error(Object.values(result.errors)[0]);
    return { login: result.user.login, created: true };
  }

  const result = await setPassword(existing.id, password);
  if (!result.ok) throw new Error(Object.values(result.errors)[0]);
  if (name) await update(existing.id, { name });

  return { login: existing.login, created: false };
}

// --------------------------------------------------------------- миграция

/**
 * Приводит файл первой версии проекта к новой форме: раздаёт идентификаторы
 * и роль «администратор». Пароли не трогает. Выполняется один раз при старте.
 */
async function migrate() {
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(store.file, 'utf8'));
  } catch {
    return false;
  }

  if (!Array.isArray(raw) || raw.length === 0) return false;

  const needsMigration = raw.some(
    (record) => record && typeof record === 'object' && (!record.id || !record.role)
  );
  if (!needsMigration) return false;

  await store.replaceAll(raw);
  console.log(`Учётные записи обновлены под новую структуру (${raw.length} шт.): роль «Администратор».`);
  return true;
}

module.exports = {
  file: store.file,
  MIN_PASSWORD,
  MIN_LOGIN,
  MAX_LOGIN,
  init: store.init,
  migrate,
  isEmpty,
  list,
  listByRole,
  getById,
  getByLogin,
  exists,
  verify,
  create,
  update,
  setPassword,
  setActive,
  touchLogin,
  remove,
  upsertByLogin,
  checkPasswordRules,
  checkLoginRules,
};
