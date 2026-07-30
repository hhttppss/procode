'use strict';

/**
 * Общие мелочи для API: разбор периодов, единый вид ошибок валидации,
 * обёртка асинхронных обработчиков.
 */

const db = require('../../db');

/** Оборачивает async-обработчик, чтобы отказ промиса уходил в обработчик ошибок Express. */
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function fail(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

function failValidation(res, errors) {
  return res.status(400).json({ ok: false, errors });
}

/** Один текст на все модули: PATCH без единого известного поля — это ошибка запроса, а не пустая правка. */
const NOTHING_TO_SAVE = 'Нечего сохранять: не переданы изменения.';

/**
 * Есть ли поле в теле запроса. Именно hasOwnProperty, а не проверка на undefined:
 * «стереть комментарий» приходит как { comment: '' }, а иногда и как { comment: null } —
 * такие поля надо принимать, а не считать непереданными.
 */
function hasField(body, field) {
  return Object.prototype.hasOwnProperty.call(body, field);
}

/** Читалка полей одного тела: const has = fieldsOf(body); if (has('name')) … */
function fieldsOf(body) {
  return (field) => hasField(body, field);
}

/**
 * Общий финал разбора PATCH-запроса.
 *
 * Порядок проверок важен и одинаков во всех модулях: сначала ошибки полей, потом
 * «нечего сохранять». Неверное значение в patch не попадает, поэтому обратный порядок
 * отвечал бы «не переданы изменения» на запрос с единственным неправильным полем.
 *
 * @returns {boolean} true — ответ уже отправлен, обработчику нужно сразу выйти.
 */
function patchRejected(res, errors, patch) {
  if (Object.keys(errors).length > 0) {
    failValidation(res, errors);
    return true;
  }

  if (Object.keys(patch).length === 0) {
    fail(res, 400, NOTHING_TO_SAVE);
    return true;
  }

  return false;
}

/** Календарная дата YYYY-MM-DD в местном времени. */
function today() {
  const now = new Date();
  return toDay(now);
}

function toDay(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftDay(day, deltaDays) {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + deltaDays);
  return toDay(date);
}

/** Понедельник недели, в которую попадает день. */
function startOfWeek(day) {
  const date = new Date(`${day}T00:00:00`);
  const weekday = (date.getDay() + 6) % 7; // 0 = понедельник
  date.setDate(date.getDate() - weekday);
  return toDay(date);
}

function startOfMonth(day) {
  return `${day.slice(0, 7)}-01`;
}

function endOfMonth(day) {
  const date = new Date(`${day.slice(0, 7)}-01T00:00:00`);
  date.setMonth(date.getMonth() + 1);
  date.setDate(0);
  return toDay(date);
}

/**
 * Период из query-параметров from/to. Если не заданы — текущий месяц.
 * Возвращает календарные дни, потому что все даты в базе хранятся так же.
 */
function readPeriod(query, { fallback = 'month' } = {}) {
  const from = db.asDay(query.from);
  const to = db.asDay(query.to);

  if (from && to) return from <= to ? { from, to } : { from: to, to: from };

  const now = today();
  if (from && !to) return { from, to: now < from ? from : now };
  if (!from && to) return { from: shiftDay(to, -29), to };

  if (fallback === 'week') return { from: startOfWeek(now), to: shiftDay(startOfWeek(now), 6) };
  return { from: startOfMonth(now), to: endOfMonth(now) };
}

/** Границы дня в миллисекундах — для полей, где хранится полная дата-время (заявки). */
function dayBoundsMs(fromDay, toDay) {
  const from = new Date(`${fromDay}T00:00:00.000`).getTime();
  const to = new Date(`${toDay}T23:59:59.999`).getTime();
  return { from, to };
}

/** Разбирает список идентификаторов из строки или массива. */
function readIds(value) {
  if (Array.isArray(value)) return db.asStringArray(value, 50, 60);
  const text = db.asText(value);
  return text ? db.asStringArray(text.split(','), 50, 60) : [];
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

module.exports = {
  wrap,
  fail,
  failValidation,
  NOTHING_TO_SAVE,
  hasField,
  fieldsOf,
  patchRejected,
  today,
  toDay,
  shiftDay,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  readPeriod,
  dayBoundsMs,
  readIds,
  bodyOf,
};
