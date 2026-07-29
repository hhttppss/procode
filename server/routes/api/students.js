'use strict';

/**
 * Модуль «Ученики».
 *
 * Администратор — полный CRUD и все поля карточки.
 * Преподаватель — только просмотр закреплённых за ним учеников, и только тех полей,
 * которые ему положены: контакты родителей, оплаты и заметки администрации
 * отсекаются в domain/access.js ещё до формирования ответа.
 */

const express = require('express');

const access = require('../../domain/access');
const audit = require('../../models/audit');
const catalog = require('../../domain/catalog');
const db = require('../../db');
const finance = require('../../models/finance');
const lessons = require('../../models/lessons');
const notify = require('../../domain/notify');
const students = require('../../models/students');
const users = require('../../models/users');
const { wrap, fail, failValidation, bodyOf } = require('./helpers');

const router = express.Router();

/** Поля карточки и их подписи — используются и для истории изменений, и в валидации. */
const FIELDS = [
  { field: 'name', label: 'Имя ребёнка' },
  { field: 'birthDate', label: 'Дата рождения' },
  { field: 'age', label: 'Возраст' },
  { field: 'course', label: 'Направление' },
  { field: 'group', label: 'Группа' },
  { field: 'teacherId', label: 'Преподаватель' },
  { field: 'status', label: 'Статус' },
  { field: 'startedAt', label: 'Начало занятий' },
  { field: 'parentName', label: 'ФИО родителя' },
  { field: 'parentPhone', label: 'Телефон родителя' },
  { field: 'parentEmail', label: 'Email родителя' },
  { field: 'parentSecond', label: 'Второй родитель' },
  { field: 'lessonPrice', label: 'Стоимость занятия' },
  { field: 'adminNote', label: 'Заметка администратора' },
  { field: 'traits', label: 'Особенности' },
];

const TRAIT_FIELDS = ['pace', 'behavior', 'health', 'wishes'];

function traitsText(traits) {
  if (!traits || typeof traits !== 'object') return '';
  return TRAIT_FIELDS.map((key) => traits[key])
    .filter(Boolean)
    .join(' · ');
}

/** Собирает patch из тела запроса: игнорирует поля, которых там нет. */
function readPatch(body) {
  const patch = {};
  const errors = {};
  const has = (field) => Object.prototype.hasOwnProperty.call(body, field);

  if (has('name')) {
    patch.name = db.asText(body.name, 120);
    if (!patch.name) errors.name = 'Укажите имя ребёнка.';
  }

  if (has('birthDate')) {
    patch.birthDate = db.asDay(body.birthDate);
    if (body.birthDate && !patch.birthDate) errors.birthDate = 'Дата рождения указана неверно.';
  }

  if (has('age')) {
    const age = db.asInt(body.age);
    if (age !== null && (age < 3 || age > 25)) errors.age = 'Возраст должен быть от 3 до 25 лет.';
    else patch.age = age;
  }

  if (has('course')) patch.course = db.asText(body.course, 120);
  if (has('group')) patch.group = db.asText(body.group, 80);
  if (has('teacherId')) patch.teacherId = db.asText(body.teacherId);

  if (has('status')) {
    if (!catalog.STUDENT_STATUS_IDS.includes(body.status)) errors.status = 'Неизвестный статус ученика.';
    else patch.status = body.status;
  }

  if (has('startedAt')) patch.startedAt = db.asDay(body.startedAt);
  if (has('parentName')) patch.parentName = db.asText(body.parentName, 120);
  if (has('parentPhone')) patch.parentPhone = db.asText(body.parentPhone, 40);
  if (has('parentEmail')) patch.parentEmail = db.asText(body.parentEmail, 120);
  if (has('parentSecond')) patch.parentSecond = db.asText(body.parentSecond, 200);
  if (has('lessonPrice')) patch.lessonPrice = db.asMoney(body.lessonPrice);
  if (has('adminNote')) patch.adminNote = db.asText(body.adminNote, 4000);

  if (has('traits') && body.traits && typeof body.traits === 'object') {
    patch.traits = {};
    for (const key of TRAIT_FIELDS) patch.traits[key] = db.asText(body.traits[key], 500);
  }

  return { patch, errors };
}

async function ensureTeacherExists(teacherId) {
  if (!teacherId) return true;
  const teacher = await users.getById(teacherId);
  return Boolean(teacher) && teacher.role === 'teacher';
}

// ---------------------------------------------------------------- список

router.get(
  '/',
  wrap(async (req, res) => {
    const isAdmin = access.isAdmin(req.user);

    // Преподаватель физически не может расширить выборку: список берётся по его id,
    // а не по параметру из запроса.
    const all = isAdmin ? await students.list() : await students.listByTeacher(req.user.id);

    const search = db.asText(req.query.q, 100).toLowerCase();
    const course = db.asText(req.query.course, 120);
    const teacherId = isAdmin ? db.asText(req.query.teacherId) : '';
    const status = catalog.STUDENT_STATUS_IDS.includes(req.query.status) ? req.query.status : '';
    const ageFrom = db.asInt(req.query.ageFrom);
    const ageTo = db.asInt(req.query.ageTo);

    const filtered = all.filter((student) => {
      if (course && student.course !== course) return false;
      if (teacherId && student.teacherId !== teacherId) return false;
      if (status && student.status !== status) return false;

      const age = students.ageOf(student);
      if (ageFrom !== null && (age === null || age < ageFrom)) return false;
      if (ageTo !== null && (age === null || age > ageTo)) return false;

      if (search) {
        // Преподаватель ищет только по своим полям — по контактам родителей поиск ему недоступен.
        const haystack = isAdmin
          ? [student.name, student.course, student.group, student.parentName, student.parentPhone]
          : [student.name, student.course, student.group];
        if (!haystack.join(' ').toLowerCase().includes(search)) return false;
      }

      return true;
    });

    filtered.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    const counts = { all: all.length };
    for (const item of catalog.STUDENT_STATUSES) counts[item.id] = 0;
    for (const student of all) {
      if (counts[student.status] !== undefined) counts[student.status] += 1;
    }

    res.json({
      ok: true,
      items: filtered.map((student) => access.studentFor(req.user, student)),
      total: filtered.length,
      counts,
      byCourse: byCourseCounts(all),
    });
  })
);

function byCourseCounts(items) {
  const map = new Map();
  for (const student of items) {
    const key = student.course || 'Без направления';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([course, count]) => ({ course, count })).sort((a, b) => b.count - a.count);
}

// ------------------------------------------------------------- карточка

router.get(
  '/:id',
  wrap(async (req, res) => {
    const student = await students.getById(req.params.id);
    if (!student) return fail(res, 404, 'Ученик не найден.');
    if (!access.canViewStudent(req.user, student)) {
      return fail(res, 403, 'Этот ученик за вами не закреплён.');
    }

    const teacher = student.teacherId ? await users.getById(student.teacherId) : null;

    // Преподаватель видит только те занятия ученика, которые вёл сам.
    const allLessons = await lessons.listByStudent(student.id);
    const visibleLessons = access.isAdmin(req.user)
      ? allLessons
      : allLessons.filter((lesson) => lesson.teacherId === req.user.id);

    const done = visibleLessons.filter((lesson) => lesson.status === 'done');
    const attendance = { present: 0, late: 0, absent: 0 };
    for (const lesson of done) {
      const mark = lesson.attendance[student.id];
      if (mark && attendance[mark] !== undefined) attendance[mark] += 1;
    }

    const payload = {
      ok: true,
      item: access.studentFor(req.user, student),
      teacher: access.staffBrief(teacher),
      lessons: visibleLessons
        .slice()
        .reverse()
        .slice(0, 50)
        .map((lesson) => ({
          ...access.lessonFor(req.user, lesson),
          attendanceMark: lesson.attendance[student.id] || '',
        })),
      stats: {
        total: visibleLessons.length,
        done: done.length,
        cancelled: visibleLessons.filter((lesson) => lesson.status === 'cancelled').length,
        planned: visibleLessons.filter((lesson) => lesson.status === 'planned').length,
        attendance,
      },
    };

    // История оплат и история правок карточки — только администратору.
    if (access.isAdmin(req.user)) {
      payload.payments = await finance.paymentsByStudent(student.id);
      payload.paid = finance.sum(payload.payments);
      payload.history = await audit.listFor('student', student.id);
    }

    res.json(payload);
  })
);

// ------------------------------------------------------------- изменения

router.post(
  '/',
  wrap(async (req, res) => {
    if (!access.canEditStudent(req.user)) return fail(res, 403, 'Карточки учеников заводит администратор.');

    const { patch, errors } = readPatch(bodyOf(req));
    if (!patch.name) errors.name = errors.name || 'Укажите имя ребёнка.';
    if (patch.teacherId && !(await ensureTeacherExists(patch.teacherId))) {
      errors.teacherId = 'Преподаватель не найден.';
    }
    if (Object.keys(errors).length > 0) return failValidation(res, errors);

    const student = await students.create(patch);

    await audit.log({
      entity: 'student',
      entityId: student.id,
      action: 'create',
      actor: req.user,
      comment: 'Карточка создана вручную',
    });

    if (student.teacherId) await notify.studentAssigned(student, student.teacherId);

    res.status(201).json({ ok: true, item: access.studentFor(req.user, student) });
  })
);

router.patch(
  '/:id',
  wrap(async (req, res) => {
    if (!access.canEditStudent(req.user)) {
      return fail(res, 403, 'Редактировать карточки учеников может только администратор.');
    }

    const current = await students.getById(req.params.id);
    if (!current) return fail(res, 404, 'Ученик не найден.');

    const { patch, errors } = readPatch(bodyOf(req));
    if (Object.keys(patch).length === 0) return fail(res, 400, 'Нечего сохранять: не переданы изменения.');
    if (patch.teacherId && !(await ensureTeacherExists(patch.teacherId))) {
      errors.teacherId = 'Преподаватель не найден.';
    }
    if (Object.keys(errors).length > 0) return failValidation(res, errors);

    const updated = await students.update(current.id, patch);
    if (!updated) return fail(res, 404, 'Ученик не найден.');

    // Для истории подставляем человекочитаемые значения: имя преподавателя, а не его id.
    const teacherNames = new Map();
    for (const id of [current.teacherId, updated.teacherId].filter(Boolean)) {
      if (teacherNames.has(id)) continue;
      const teacher = await users.getById(id);
      teacherNames.set(id, teacher ? teacher.name : id);
    }

    const changes = audit.diff(current, updated, [
      ...FIELDS.map(({ field, label }) => {
        if (field === 'teacherId') {
          return { field, label, format: (value) => (value ? teacherNames.get(value) || value : 'не назначен') };
        }
        if (field === 'status') {
          return { field, label, format: (value) => catalog.labelOf(catalog.STUDENT_STATUSES, value) };
        }
        if (field === 'traits') return { field, label, format: traitsText };
        return { field, label };
      }),
    ]);

    await audit.log({ entity: 'student', entityId: updated.id, action: 'update', actor: req.user, changes });

    if (patch.teacherId && patch.teacherId !== current.teacherId) {
      await notify.studentAssigned(updated, patch.teacherId);
    }

    res.json({ ok: true, item: access.studentFor(req.user, updated), changes });
  })
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    if (!access.canEditStudent(req.user)) {
      return fail(res, 403, 'Удалять карточки учеников может только администратор.');
    }

    const student = await students.getById(req.params.id);
    if (!student) return fail(res, 404, 'Ученик не найден.');

    // Связанные данные убираем явно, иначе в расписании и отчётах останутся ссылки в никуда.
    await lessons.detachStudent(student.id);
    await finance.removePaymentsOfStudent(student.id);
    await students.remove(student.id);
    await audit.removeFor('student', student.id);

    res.json({ ok: true });
  })
);

module.exports = router;
