'use strict';

/**
 * Модуль «Заявки» — только для администратора.
 * Проверка стоит на самом роутере (requireAdminApi), поэтому ни один обработчик
 * ниже не может быть вызван преподавателем даже прямым запросом к API.
 */

const express = require('express');

const applications = require('../../models/applications');
const audit = require('../../models/audit');
const catalog = require('../../domain/catalog');
const db = require('../../db');
const notify = require('../../domain/notify');
const students = require('../../models/students');
const users = require('../../models/users');
const { wrap, fail, failValidation, dayBoundsMs, bodyOf } = require('./helpers');

const router = express.Router();

const MAX_QUERY_LENGTH = 100;

// ------------------------------------------------------------ фильтры списка

function matchesQuery(item, query) {
  const haystack = [item.parentName, item.childName, item.phone, item.email, item.course, item.comment, item.managerComment]
    .join(' ')
    .toLowerCase();

  if (haystack.includes(query)) return true;

  // Поиск по телефону без учёта форматирования: «8 (916) 555» найдёт +79165551122.
  const queryDigits = query.replace(/\D/g, '');
  if (queryDigits.length < 3) return false;

  const phoneDigits = item.phone.replace(/\D/g, '');
  if (phoneDigits.includes(queryDigits)) return true;

  // Менеджер набирает номер через 8, а храним мы его через 7.
  return queryDigits.startsWith('8') && phoneDigits.includes(`7${queryDigits.slice(1)}`);
}

function selectItems(items, query) {
  const status = catalog.APPLICATION_STATUS_IDS.includes(query.status) ? query.status : 'all';
  const search = db.asText(query.q, MAX_QUERY_LENGTH).toLowerCase();
  const from = db.asDay(query.from);
  const to = db.asDay(query.to);
  const sort = query.sort === 'old' ? 'old' : 'new';

  const bounds = from || to ? dayBoundsMs(from || '1970-01-01', to || '2999-12-31') : null;

  const filtered = items.filter((item) => {
    if (status !== 'all' && item.status !== status) return false;

    if (bounds) {
      const createdAt = new Date(item.createdAt).getTime();
      if (!Number.isFinite(createdAt) || createdAt < bounds.from || createdAt > bounds.to) return false;
    }

    if (search && !matchesQuery(item, search)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return sort === 'old' ? diff : -diff;
  });

  return filtered;
}

/** Счётчики считаются по всей базе, а не по отфильтрованной выборке. */
function countByStatus(items) {
  const counts = { all: items.length };
  for (const status of catalog.APPLICATION_STATUSES) counts[status.id] = 0;
  for (const item of items) {
    if (counts[item.status] !== undefined) counts[item.status] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------- список

router.get(
  '/',
  wrap(async (req, res) => {
    const items = await applications.list();
    const selected = selectItems(items, req.query);

    res.json({
      ok: true,
      items: selected,
      total: selected.length,
      counts: countByStatus(items),
    });
  })
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const item = await applications.getById(req.params.id);
    if (!item) return fail(res, 404, 'Заявка не найдена.');
    return res.json({ ok: true, item });
  })
);

// ------------------------------------------------------------- изменение

router.patch(
  '/:id',
  wrap(async (req, res) => {
    const body = bodyOf(req);
    const patch = {};
    const errors = {};

    if (body.status !== undefined) {
      if (!catalog.APPLICATION_STATUS_IDS.includes(body.status)) errors.status = 'Неизвестный статус заявки.';
      else patch.status = body.status;
    }

    if (body.managerComment !== undefined) {
      if (typeof body.managerComment !== 'string') {
        errors.managerComment = 'Комментарий должен быть текстом.';
      } else if (body.managerComment.trim().length > applications.MAX_COMMENT) {
        errors.managerComment = `Комментарий слишком длинный — не больше ${applications.MAX_COMMENT} символов.`;
      } else {
        patch.managerComment = body.managerComment.trim();
      }
    }

    if (Object.keys(errors).length > 0) return failValidation(res, errors);
    if (Object.keys(patch).length === 0) return fail(res, 400, 'Нечего сохранять: не переданы изменения.');

    const current = await applications.getById(req.params.id);
    if (!current) return fail(res, 404, 'Заявка не найдена.');

    // Статус «Ученик зачислен» ставится только конвертацией — иначе заявка и карточка разойдутся.
    if (patch.status === 'enrolled' && !current.studentId) {
      return failValidation(res, {
        status: 'Чтобы поставить этот статус, конвертируйте заявку в карточку ученика.',
      });
    }

    const updated = await applications.applyChanges(req.params.id, patch, req.user);
    if (!updated) return fail(res, 404, 'Заявка не найдена.');

    return res.json({ ok: true, item: updated });
  })
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    const removed = await applications.remove(req.params.id);
    if (!removed) return fail(res, 404, 'Заявка не найдена.');
    return res.json({ ok: true });
  })
);

// ------------------------------------------------- конвертация в ученика

router.post(
  '/:id/convert',
  wrap(async (req, res) => {
    const application = await applications.getById(req.params.id);
    if (!application) return fail(res, 404, 'Заявка не найдена.');
    if (application.studentId) {
      return fail(res, 409, 'По этой заявке уже создана карточка ученика.');
    }

    const body = bodyOf(req);
    const errors = {};

    const name = db.asText(body.name, 120) || application.childName;
    if (!name) errors.name = 'Укажите имя ребёнка.';

    const teacherId = db.asText(body.teacherId);
    if (teacherId) {
      const teacher = await users.getById(teacherId);
      if (!teacher || teacher.role !== 'teacher') errors.teacherId = 'Преподаватель не найден.';
    }

    if (Object.keys(errors).length > 0) return failValidation(res, errors);

    // Данные переносятся из заявки; администратор может уточнить их прямо в окне конвертации.
    const student = await students.create({
      name,
      birthDate: db.asDay(body.birthDate),
      age: body.age === undefined ? application.childAge : db.asInt(body.age),
      course: db.asText(body.course, 120) || application.course,
      group: db.asText(body.group, 80),
      teacherId,
      status: 'active',
      startedAt: db.asDay(body.startedAt),
      parentName: db.asText(body.parentName, 120) || application.parentName,
      parentPhone: db.asText(body.parentPhone, 40) || application.phone,
      parentEmail: db.asText(body.parentEmail, 120) || application.email,
      lessonPrice: db.asMoney(body.lessonPrice),
      adminNote: application.comment ? `Комментарий из заявки: ${application.comment}` : '',
      applicationId: application.id,
      traits: {},
    });

    await applications.linkStudent(application.id, student.id, req.user);

    await audit.log({
      entity: 'student',
      entityId: student.id,
      action: 'create',
      actor: req.user,
      comment: 'Карточка создана из заявки с сайта',
    });

    if (teacherId) await notify.studentAssigned(student, teacherId);

    return res.status(201).json({ ok: true, studentId: student.id, item: await applications.getById(application.id) });
  })
);

// ---------------------------------------------------------------------- CSV

const CSV_COLUMNS = [
  ['Дата заявки', (item) => formatDateTime(item.createdAt)],
  ['Родитель', (item) => item.parentName],
  ['Телефон', (item) => item.phone],
  ['Email', (item) => item.email],
  ['Ребёнок', (item) => item.childName],
  ['Возраст', (item) => (item.childAge === null ? '' : item.childAge)],
  ['Направление', (item) => item.course],
  ['Комментарий родителя', (item) => item.comment],
  ['Статус', (item) => catalog.labelOf(catalog.APPLICATION_STATUSES, item.status)],
  ['Комментарий менеджера', (item) => item.managerComment],
  ['Обновлено', (item) => formatDateTime(item.updatedAt)],
  ['Источник', (item) => item.source],
  ['ID', (item) => item.id],
];

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}, ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

const FORMULA_START = /^[=@\t\r]/;
const PHONE_LIKE = /^[+-][\d\s().-]+$/;

function csvCell(value) {
  const text = String(value ?? '');
  // Excel выполняет содержимое ячейки, начинающееся с = @ + -, поэтому такие значения гасим апострофом.
  // Телефон (+7 999 …) под это правило формально попадает, но формулой не является — его не трогаем.
  const looksLikeFormula = FORMULA_START.test(text) || (/^[+-]/.test(text) && !PHONE_LIKE.test(text));
  const safe = looksLikeFormula ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function buildCsv(items) {
  const rows = [CSV_COLUMNS.map(([title]) => csvCell(title)).join(';')];
  for (const item of items) {
    rows.push(CSV_COLUMNS.map(([, read]) => csvCell(read(item))).join(';'));
  }
  // BOM + разделитель «;» — чтобы Excel с русской локалью открыл файл без плясок с бубном.
  return `﻿${rows.join('\r\n')}\r\n`;
}

router.get(
  '/export/csv',
  wrap(async (req, res) => {
    const items = await applications.list();
    const selected = selectItems(items, req.query);
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="procode-applications-${stamp}.csv"`);
    res.send(buildCsv(selected));
  })
);

module.exports = router;
module.exports.buildCsv = buildCsv;
module.exports.csvCell = csvCell;
module.exports.formatDateTime = formatDateTime;
