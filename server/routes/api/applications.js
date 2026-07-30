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
// Карточки учеников здесь создаются транзакцией по имени коллекции, а не методами модели,
// но модуль всё равно нужен: именно он объявляет коллекцию «students».
require('../../models/students');
const users = require('../../models/users');
const { wrap, fail, failValidation, dayBoundsMs, bodyOf, patchRejected } = require('./helpers');

const router = express.Router();

const MAX_QUERY_LENGTH = 100;

/**
 * Потолок выдачи списка. Заявки — единственная коллекция, которая растёт без конца:
 * учеников и сотрудников ограничивает размер школы, история и уведомления обрезаются
 * в моделях, а занятия запрашиваются диапазоном дат. Здесь же за несколько лет
 * набегут тысячи записей, и без потолка их тянул бы каждый заход на страницу,
 * да ещё и фоновое обновление раз в 30 секунд.
 *
 * Полноценная пагинация со страницами тут была бы лишней: администратор работает
 * со свежими заявками, а старые ищет поиском и фильтром по датам — они уже есть.
 * Поэтому просто отдаём свежие 200 и честно говорим в интерфейсе, что показано не всё.
 * Выгрузка в CSV не ограничена: это и есть способ забрать вообще всё.
 */
const LIST_LIMIT = 200;

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
      items: selected.slice(0, LIST_LIMIT),
      total: selected.length,
      limited: selected.length > LIST_LIMIT,
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

    if (patchRejected(res, errors, patch)) return;

    const current = await applications.getById(req.params.id);
    if (!current) return fail(res, 404, 'Заявка не найдена.');

    // Статус заявки с карточкой ученика заморожен в обе стороны.
    // Без этого «Отказ» в заявке оставлял активного ученика с занятиями и оплатами:
    // в карточке ничего не менялось, и две записи об одном ребёнке говорили разное.
    // Комментарий менеджера при этом сохранять можно — блокируем только смену статуса.
    if (current.studentId && patch.status !== undefined && patch.status !== current.status) {
      return failValidation(res, {
        status: 'По заявке заведена карточка ученика — статус меняется в ней, а не здесь.',
      });
    }

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
    // Проверка «карточка ученика ещё жива» и удаление — одной транзакцией:
    // иначе между ними успевает пройти конвертация, и ученик остаётся со ссылкой
    // на несуществующую заявку. Ссылка без карточки (данные старых версий) не мешает:
    // удалять такую заявку можно.
    const result = await db.transaction(['applications', 'students'], (tx) => {
      const application = tx.applications.getById(req.params.id);
      if (!application) return { ok: false, status: 404, message: 'Заявка не найдена.' };

      if (application.studentId && tx.students.getById(application.studentId)) {
        return {
          ok: false,
          status: 409,
          message: 'По заявке заведена карточка ученика. Сначала удалите карточку — после этого заявка удалится.',
        };
      }

      tx.applications.remove(application.id);
      return { ok: true };
    });

    if (!result.ok) return fail(res, result.status, result.message);
    return res.json({ ok: true });
  })
);

// ------------------------------------------------- конвертация в ученика

router.post(
  '/:id/convert',
  wrap(async (req, res) => {
    const body = bodyOf(req);

    // Преподавателя проверяем до транзакции: коллекция users в неё не входит,
    // а на гонку эта проверка не влияет — сотрудника здесь только читают.
    const teacherId = db.asText(body.teacherId);
    if (teacherId) {
      const teacher = await users.getById(teacherId);
      if (!teacher || teacher.role !== 'teacher') return failValidation(res, { teacherId: 'Преподаватель не найден.' });
    }

    // Проверка «заявка ещё не сконвертирована», создание карточки и отметка в заявке —
    // одной транзакцией по двум коллекциям. Раздельными вызовами пять одновременных
    // запросов делали из одной заявки пять учеников.
    const result = await db.transaction(['applications', 'students'], (tx) => {
      const application = tx.applications.getById(req.params.id);
      if (!application) return { ok: false, status: 404, message: 'Заявка не найдена.' };
      if (application.studentId) {
        return { ok: false, status: 409, message: 'По этой заявке уже создана карточка ученика.' };
      }

      const name = db.asText(body.name, 120) || application.childName;
      if (!name) return { ok: false, errors: { name: 'Укажите имя ребёнка.' } };

      // Данные переносятся из заявки; администратор может уточнить их прямо в окне конвертации.
      const student = tx.students.insert({
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

      const linked = tx.applications.update(application.id, (current) =>
        applications.linkStudentChanges(current, student.id, req.user)
      );

      return { ok: true, student, item: linked };
    });

    if (!result.ok) {
      return result.errors ? failValidation(res, result.errors) : fail(res, result.status, result.message);
    }

    // Журнал и уведомление — уже после записи: они не критичны к гонке,
    // а держать на них очередь записи незачем.
    await audit.log({
      entity: 'student',
      entityId: result.student.id,
      action: 'create',
      actor: req.user,
      comment: 'Карточка создана из заявки с сайта',
    });

    if (teacherId) await notify.studentAssigned(result.student, teacherId);

    return res.status(201).json({ ok: true, studentId: result.student.id, item: result.item });
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
