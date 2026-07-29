'use strict';

/**
 * Модуль «Расписание».
 *
 * Администратор: создание (в том числе повторяющихся серий), правка, перенос, удаление.
 * Преподаватель: видит только свои занятия и отмечает их итог — проведено / отменено /
 * перенесено, комментарий и посещаемость. Дату, состав учеников и ссылку он не меняет:
 * список разрешённых полей задан в domain/access.js и проверяется здесь.
 */

const express = require('express');

const access = require('../../domain/access');
const audit = require('../../models/audit');
const catalog = require('../../domain/catalog');
const db = require('../../db');
const lessons = require('../../models/lessons');
const notify = require('../../domain/notify');
const students = require('../../models/students');
const users = require('../../models/users');
const { wrap, fail, failValidation, bodyOf, today, toDay } = require('./helpers');

const router = express.Router();

const MAX_SERIES_LESSONS = 200;

// ------------------------------------------------------------- валидация

async function validateLesson(body, { partial = false } = {}) {
  const errors = {};
  const value = {};
  const has = (field) => Object.prototype.hasOwnProperty.call(body, field);

  if (!partial || has('date')) {
    value.date = db.asDay(body.date);
    if (!value.date) errors.date = 'Укажите дату занятия.';
  }

  if (!partial || has('startTime')) {
    value.startTime = db.asTime(body.startTime);
    if (!value.startTime) errors.startTime = 'Укажите время начала в формате ЧЧ:ММ.';
  }

  if (!partial || has('durationMin')) {
    const duration = db.asInt(body.durationMin, lessons.DEFAULT_DURATION);
    if (duration < lessons.MIN_DURATION || duration > lessons.MAX_DURATION) {
      errors.durationMin = `Длительность — от ${lessons.MIN_DURATION} до ${lessons.MAX_DURATION} минут.`;
    } else {
      value.durationMin = duration;
    }
  }

  if (!partial || has('teacherId')) {
    value.teacherId = db.asText(body.teacherId);
    if (!value.teacherId) {
      errors.teacherId = 'Выберите преподавателя.';
    } else {
      const teacher = await users.getById(value.teacherId);
      if (!teacher || teacher.role !== 'teacher') errors.teacherId = 'Преподаватель не найден.';
      else if (!teacher.active) errors.teacherId = 'Учётная запись преподавателя заблокирована.';
    }
  }

  if (!partial || has('studentIds')) {
    const ids = db.asStringArray(body.studentIds, 30, 60);
    const known = [];
    for (const id of ids) {
      const student = await students.getById(id);
      if (student) known.push(student.id);
    }
    if (known.length !== ids.length) errors.studentIds = 'Часть выбранных учеников не найдена.';
    value.studentIds = known;
  }

  if (!partial || has('format')) {
    value.format = catalog.LESSON_FORMAT_IDS.includes(body.format) ? body.format : 'online';
  }

  if (has('title')) value.title = db.asText(body.title, 120);
  if (has('course')) value.course = db.asText(body.course, 120);
  if (has('adminComment')) value.adminComment = db.asText(body.adminComment, lessons.MAX_COMMENT);

  if (!partial || has('link')) {
    const link = db.asText(body.link, 500);
    // Пускаем только http(s): иначе ссылка вида javascript:… уедет в чужой браузер.
    if (link && !/^https?:\/\//i.test(link)) errors.link = 'Ссылка должна начинаться с http:// или https://';
    else value.link = link;
  }

  if (has('status')) {
    if (!catalog.LESSON_STATUS_IDS.includes(body.status)) errors.status = 'Неизвестный статус занятия.';
    else value.status = body.status;
  }

  return { value, errors };
}

/**
 * Даты повторяющейся серии: от первой даты до конечной, по выбранным дням недели.
 * Дни недели — числа 1 (понедельник) … 7 (воскресенье).
 */
function seriesDates(firstDay, weekdays, untilDay) {
  const result = [];
  const cursor = new Date(`${firstDay}T00:00:00`);
  const until = new Date(`${untilDay}T00:00:00`);
  const wanted = new Set(weekdays);

  while (cursor <= until && result.length < MAX_SERIES_LESSONS) {
    const weekday = cursor.getDay() === 0 ? 7 : cursor.getDay();
    if (wanted.has(weekday)) result.push(toDay(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return result;
}

// ---------------------------------------------------------------- список

router.get(
  '/',
  wrap(async (req, res) => {
    const from = db.asDay(req.query.from);
    const to = db.asDay(req.query.to);
    const status = catalog.LESSON_STATUS_IDS.includes(req.query.status) ? req.query.status : '';
    const studentId = db.asText(req.query.studentId);

    // Преподаватель получает только свои занятия — параметр teacherId для него игнорируется.
    const teacherId = access.isAdmin(req.user) ? db.asText(req.query.teacherId) : req.user.id;

    const items = await lessons.listBetween(from, to, (lesson) => {
      if (teacherId && lesson.teacherId !== teacherId) return false;
      if (status && lesson.status !== status) return false;
      if (studentId && !lesson.studentIds.includes(studentId)) return false;
      return true;
    });

    res.json({
      ok: true,
      items: items.map((lesson) => access.lessonFor(req.user, lesson)),
      total: items.length,
    });
  })
);

/** Ближайшее занятие текущего сотрудника — для напоминания на главной. */
router.get(
  '/upcoming',
  wrap(async (req, res) => {
    const now = new Date();
    const from = today();

    const scope = access.isAdmin(req.user)
      ? await lessons.listBetween(from, null)
      : (await lessons.listByTeacher(req.user.id)).filter((lesson) => lesson.date >= from);

    const upcoming = scope
      .filter((lesson) => lesson.status === 'planned' && lessons.endsAt(lesson) >= now)
      .slice(0, 5);

    res.json({ ok: true, items: upcoming.map((lesson) => access.lessonFor(req.user, lesson)) });
  })
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const lesson = await lessons.getById(req.params.id);
    if (!lesson) return fail(res, 404, 'Занятие не найдено.');
    if (!access.canViewLesson(req.user, lesson)) return fail(res, 403, 'Это занятие ведёт другой преподаватель.');

    res.json({ ok: true, item: access.lessonFor(req.user, lesson) });
  })
);

// -------------------------------------------------------------- создание

router.post(
  '/',
  wrap(async (req, res) => {
    if (!access.canManageLessons(req.user)) return fail(res, 403, 'Расписание составляет администратор.');

    const body = bodyOf(req);
    const { value, errors } = await validateLesson(body);

    // Повторяющиеся занятия: те же поля + дни недели и дата окончания.
    const repeat = body.repeat && typeof body.repeat === 'object' ? body.repeat : null;
    let dates = [];

    if (repeat) {
      const weekdays = Array.isArray(repeat.weekdays)
        ? [...new Set(repeat.weekdays.map((day) => db.asInt(day)).filter((day) => day >= 1 && day <= 7))]
        : [];
      const until = db.asDay(repeat.until);

      if (weekdays.length === 0) errors.weekdays = 'Выберите хотя бы один день недели.';
      if (!until) errors.until = 'Укажите, до какой даты повторять занятия.';
      else if (value.date && until < value.date) errors.until = 'Дата окончания раньше даты начала.';

      if (weekdays.length > 0 && until && value.date) {
        dates = seriesDates(value.date, weekdays, until);
        if (dates.length === 0) errors.weekdays = 'В выбранном периоде нет таких дней недели.';
      }
    } else if (value.date) {
      dates = [value.date];
    }

    if (Object.keys(errors).length > 0) return failValidation(res, errors);

    const base = {
      startTime: value.startTime,
      durationMin: value.durationMin,
      teacherId: value.teacherId,
      studentIds: value.studentIds,
      title: value.title || '',
      course: value.course || '',
      format: value.format,
      link: value.link || '',
      adminComment: value.adminComment || '',
      status: 'planned',
      attendance: {},
    };

    const seriesId = repeat ? db.createId('sr') : '';
    const created = await lessons.createMany(dates.map((date) => ({ ...base, date, seriesId })));

    await notify.lessonsCreated(created);

    res.status(201).json({
      ok: true,
      items: created.map((lesson) => access.lessonFor(req.user, lesson)),
      created: created.length,
    });
  })
);

// ------------------------------------------------------------ изменение

router.patch(
  '/:id',
  wrap(async (req, res) => {
    const current = await lessons.getById(req.params.id);
    if (!current) return fail(res, 404, 'Занятие не найдено.');
    if (!access.canReportLesson(req.user, current)) {
      return fail(res, 403, 'Это занятие ведёт другой преподаватель.');
    }

    const body = bodyOf(req);
    const isAdmin = access.isAdmin(req.user);

    // Преподавателю оставляем ровно три поля. Всё остальное из тела запроса отбрасывается,
    // даже если он отправит его вручную.
    const source = isAdmin
      ? body
      : Object.fromEntries(
          Object.entries(body).filter(([key]) => access.TEACHER_LESSON_FIELDS.includes(key))
        );

    if (Object.keys(source).length === 0) return fail(res, 400, 'Нечего сохранять: не переданы изменения.');

    const { value, errors } = await validateLesson(source, { partial: true });
    const patch = {};

    for (const [key, val] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(source, key)) patch[key] = val;
    }

    if (Object.prototype.hasOwnProperty.call(source, 'teacherComment')) {
      patch.teacherComment = db.asText(source.teacherComment, lessons.MAX_COMMENT);
    }

    if (Object.prototype.hasOwnProperty.call(source, 'attendance')) {
      const marks = source.attendance && typeof source.attendance === 'object' ? source.attendance : {};
      const studentIds = patch.studentIds || current.studentIds;
      const attendance = {};
      for (const studentId of studentIds) {
        if (catalog.ATTENDANCE_IDS.includes(marks[studentId])) attendance[studentId] = marks[studentId];
      }
      patch.attendance = attendance;
    }

    if (Object.keys(errors).length > 0) return failValidation(res, errors);
    if (Object.keys(patch).length === 0) return fail(res, 400, 'Нечего сохранять: не переданы изменения.');

    const updated = await lessons.update(current.id, patch);
    if (!updated) return fail(res, 404, 'Занятие не найдено.');

    const changes = audit.diff(current, updated, [
      { field: 'date', label: 'Дата' },
      { field: 'startTime', label: 'Время' },
      { field: 'durationMin', label: 'Длительность' },
      { field: 'teacherId', label: 'Преподаватель' },
      { field: 'format', label: 'Формат', format: (v) => catalog.labelOf(catalog.LESSON_FORMATS, v) },
      { field: 'status', label: 'Статус', format: (v) => catalog.labelOf(catalog.LESSON_STATUSES, v) },
      { field: 'link', label: 'Ссылка' },
      { field: 'teacherComment', label: 'Комментарий преподавателя' },
    ]);

    await audit.log({ entity: 'lesson', entityId: updated.id, action: 'update', actor: req.user, changes });

    // Преподавателя предупреждаем только об изменениях, сделанных администратором.
    if (isAdmin) {
      const moved = current.date !== updated.date || current.startTime !== updated.startTime;
      const teacherChanged = current.teacherId !== updated.teacherId;

      if (teacherChanged) {
        await notify.lessonChanged({ ...current }, 'removed');
        await notify.lessonChanged(updated, 'created');
      } else if (updated.status === 'cancelled' && current.status !== 'cancelled') {
        await notify.lessonChanged(updated, 'cancelled');
      } else if (moved || Object.keys(patch).some((key) => key !== 'status')) {
        await notify.lessonChanged(updated, 'updated', { previous: current });
      }
    }

    res.json({ ok: true, item: access.lessonFor(req.user, updated) });
  })
);

// -------------------------------------------------------------- удаление

router.delete(
  '/:id',
  wrap(async (req, res) => {
    if (!access.canManageLessons(req.user)) return fail(res, 403, 'Удалять занятия может только администратор.');

    const lesson = await lessons.getById(req.params.id);
    if (!lesson) return fail(res, 404, 'Занятие не найдено.');

    // ?series=1 — удалить всю оставшуюся серию, начиная с этой даты.
    if (req.query.series === '1' && lesson.seriesId) {
      const removed = await lessons.removeSeries(lesson.seriesId, lesson.date);
      await notify.lessonChanged(lesson, 'removed');
      return res.json({ ok: true, removed });
    }

    await lessons.remove(lesson.id);
    await audit.removeFor('lesson', lesson.id);
    await notify.lessonChanged(lesson, 'removed');

    return res.json({ ok: true, removed: 1 });
  })
);

module.exports = router;
