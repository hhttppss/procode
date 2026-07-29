'use strict';

/**
 * Публичный API: приём заявок с лендинга.
 * Клиенту не доверяем — все проверки повторяются на сервере.
 *
 * Два ограничителя по IP:
 *   • attemptLimiter — на ВСЕ обращения к эндпоинту, включая неудачные.
 *     Без него бот мог бы бесконечно долбить форму заведомо неверными данными:
 *     записей бы не появилось, но и тормозов ему бы ничто не создавало.
 *   • submitLimiter  — на успешно принятые заявки: защита от потока мусорных обращений.
 */

const express = require('express');

const applications = require('../models/applications');
const { createRateLimiter, getClientIp } = require('../auth');
const notify = require('../domain/notify');

const router = express.Router();

const MAX_NAME = 60;
const MIN_NAME = 2;
const MAX_COURSE = 80;
const MAX_COMMENT = 1000;
const MAX_EMAIL = 120;
const MIN_AGE = 5;
const MAX_AGE = 19;

const SUBMIT_LIMIT = 5;
const ATTEMPT_LIMIT = 30;
const RATE_WINDOW_MS = 10 * 60 * 1000;

const submitLimiter = createRateLimiter({ limit: SUBMIT_LIMIT, windowMs: RATE_WINDOW_MS });
const attemptLimiter = createRateLimiter({ limit: ATTEMPT_LIMIT, windowMs: RATE_WINDOW_MS });

const TOO_MANY_MESSAGE =
  'Мы уже получили несколько заявок с этого устройства. Попробуйте позже или позвоните нам.';

/** Приводит значение к строке и убирает пробелы по краям. Ничего не обрезает: длину проверяем отдельно. */
function rawText(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * Оставляет только цифры и ведущий «+». Российские номера приводит к +7XXXXXXXXXX,
 * остальные оставляет как ввели (в очищенном виде).
 */
function normalizePhone(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const hasPlus = value.startsWith('+');
  const digits = value.replace(/\D/g, '');

  if (digits.length < 10 || digits.length > 15) return null;
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return `+7${digits.slice(1)}`;
  if (digits.length === 10 && digits[0] === '9') return `+7${digits}`;

  return hasPlus ? `+${digits}` : digits;
}

/** Проверка имени: одинаковая для родителя и ребёнка. */
function checkName(value, emptyMessage) {
  if (value.length === 0) return emptyMessage;
  if (value.length < MIN_NAME) return `Имя слишком короткое — минимум ${MIN_NAME} символа.`;
  if (value.length > MAX_NAME) return `Имя слишком длинное — не больше ${MAX_NAME} символов.`;
  return null;
}

function validateApplication(body) {
  const errors = {};

  const parentName = rawText(body.parentName);
  const parentNameError = checkName(parentName, 'Укажите, как вас зовут.');
  if (parentNameError) errors.parentName = parentNameError;

  const phone = normalizePhone(body.phone);
  if (!phone) {
    errors.phone = rawText(body.phone)
      ? 'Проверьте номер телефона: в нём должно быть от 10 до 15 цифр.'
      : 'Укажите телефон для связи.';
  }

  const childName = rawText(body.childName);
  const childNameError = checkName(childName, 'Укажите имя ребёнка.');
  if (childNameError) errors.childName = childNameError;

  // Number.parseInt('12abc') вернул бы 12 — сначала убеждаемся, что это действительно число.
  const ageSource = rawText(body.childAge);
  const childAge = /^\d{1,3}$/.test(ageSource) ? Number.parseInt(ageSource, 10) : NaN;
  if (!Number.isInteger(childAge) || childAge < MIN_AGE || childAge > MAX_AGE) {
    errors.childAge = `Возраст должен быть от ${MIN_AGE} до ${MAX_AGE} лет.`;
  }

  const course = rawText(body.course);
  if (!course) errors.course = 'Выберите направление обучения.';
  else if (course.length > MAX_COURSE) errors.course = 'Слишком длинное название направления.';

  // Email необязателен: телефона достаточно, но если его указали — проверим форму записи.
  const email = rawText(body.email);
  if (email) {
    if (email.length > MAX_EMAIL) errors.email = `Адрес слишком длинный — не больше ${MAX_EMAIL} символов.`;
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Проверьте адрес электронной почты.';
  }

  const comment = rawText(body.comment);
  if (comment.length > MAX_COMMENT) {
    errors.comment = `Комментарий слишком длинный — не больше ${MAX_COMMENT} символов.`;
  }

  if (body.consent !== true) {
    errors.consent = 'Нужно согласие на обработку персональных данных.';
  }

  return {
    errors,
    value: { parentName, phone, email, childName, childAge, course, comment },
  };
}

function logApplication(record) {
  const time = new Date(record.createdAt).toLocaleString('ru-RU');
  console.log(
    `[заявка] ${time} · ${record.parentName} · ${record.phone} · ${record.course} · ${record.childName}, ${record.childAge} лет`
  );
}

router.post('/applications', async (req, res, next) => {
  try {
    const ip = getClientIp(req);

    // Считаем любое обращение — иначе поток заведомо неверных запросов остаётся безнаказанным.
    if (attemptLimiter.isBlocked(ip)) {
      return res.status(429).json({ ok: false, message: TOO_MANY_MESSAGE });
    }
    attemptLimiter.hit(ip);

    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // Ханипот: поле website видно только ботам. Отвечаем как при успехе, но ничего не сохраняем.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      return res.status(201).json({ ok: true });
    }

    const { errors, value } = validateApplication(body);
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ ok: false, errors });
    }

    if (submitLimiter.isBlocked(ip)) {
      return res.status(429).json({ ok: false, message: TOO_MANY_MESSAGE });
    }
    // Отмечаем попытку до записи: иначе несколько одновременных запросов
    // успели бы пройти проверку раньше, чем счётчик увеличится.
    submitLimiter.hit(ip);

    const record = await applications.create({ ...value, source: 'landing' });
    logApplication(record);

    // Уведомление администраторам не должно задерживать ответ родителю и тем более его ломать.
    notify
      .newApplication(record)
      .catch((error) => console.error('Не удалось создать уведомление о заявке:', error.message));

    return res.status(201).json({ ok: true, id: record.id });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
