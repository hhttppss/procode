'use strict';

/**
 * Модуль «Ученики».
 *
 * Администратор — полный CRUD и все поля карточки.
 * Управляющий — то же самое, кроме одного: преподавателя ученику он не назначает.
 * Поле teacherId от него не принимается молча, а возвращается ошибкой — иначе
 * «сохранил, а закрепление не поменялось» выглядело бы как сбой.
 * Преподаватель — только просмотр закреплённых за ним учеников, и только тех полей,
 * которые ему положены: контакты родителей, оплаты и заметки администрации
 * отсекаются в domain/access.js ещё до формирования ответа.
 */

const express = require('express');

const access = require('../../domain/access');
// Заявку правим транзакцией по имени коллекции, но модуль нужен и сам по себе:
// он объявляет коллекцию «applications» и знает, каким патчем разрывать связь.
const applications = require('../../models/applications');
const audit = require('../../models/audit');
const catalog = require('../../domain/catalog');
const db = require('../../db');
const finance = require('../../models/finance');
const lessons = require('../../models/lessons');
const notify = require('../../domain/notify');
const students = require('../../models/students');
const users = require('../../models/users');
const { wrap, fail, failValidation, bodyOf, fieldsOf, hasField, patchRejected } = require('./helpers');

const router = express.Router();

/** Значение фильтра «ученики без группы»: пустая строка означала бы «любая группа». */
const NO_GROUP = '__none__';

const TEACHER_ASSIGN_DENIED = 'Назначать преподавателей ученикам может только администратор.';

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
  const has = fieldsOf(body);

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

/**
 * Прислал ли teacherId тот, кому назначать преподавателей нельзя.
 * Поле не отбрасывается молча: управляющий должен получить внятный отказ, а не карточку,
 * в которой сохранилось всё, кроме закрепления.
 *
 * @param {boolean} options.onlyFilled  при создании пустое значение — это «не назначен»,
 *                                      отказывать за него не за что; при правке даже снятие
 *                                      преподавателя меняет закрепление и потому запрещено.
 */
function teacherFieldDenied(user, body, { onlyFilled = false } = {}) {
  if (!hasField(body, 'teacherId')) return false;
  if (access.canAssignTeacher(user)) return false;
  if (onlyFilled && !db.asText(body.teacherId)) return false;
  return true;
}

// ---------------------------------------------------------------- список

router.get(
  '/',
  wrap(async (req, res) => {
    const seesEveryone = access.canViewAllStudents(req.user);
    const seesDetails = access.canViewStudentDetails(req.user);

    // Преподаватель физически не может расширить выборку: список берётся по его id,
    // а не по параметру из запроса.
    const all = seesEveryone ? await students.list() : await students.listByTeacher(req.user.id);

    const search = db.asText(req.query.q, 100).toLowerCase();
    const course = db.asText(req.query.course, 120);
    const group = db.asText(req.query.group, 80);
    const teacherId = seesEveryone ? db.asText(req.query.teacherId) : '';
    const status = catalog.STUDENT_STATUS_IDS.includes(req.query.status) ? req.query.status : '';
    const ageFrom = db.asInt(req.query.ageFrom);
    const ageTo = db.asInt(req.query.ageTo);

    const filtered = all.filter((student) => {
      if (course && student.course !== course) return false;
      if (teacherId && student.teacherId !== teacherId) return false;
      if (status && student.status !== status) return false;

      if (group === NO_GROUP) {
        if (student.group) return false;
      } else if (group && student.group !== group) return false;

      const age = students.ageOf(student);
      if (ageFrom !== null && (age === null || age < ageFrom)) return false;
      if (ageTo !== null && (age === null || age > ageTo)) return false;

      if (search) {
        // Преподаватель ищет только по своим полям — по контактам родителей поиск ему недоступен.
        const haystack = seesDetails
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
      // Списки для фильтров считаются по всей видимой области, а не по отфильтрованной
      // выборке: иначе выбранная группа осталась бы в списке единственным пунктом.
      groups: groupCounts(all),
      withoutGroup: all.filter((student) => !student.group).length,
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

/** Группы с числом учеников. Ученики без группы сюда не попадают — для них отдельный счётчик. */
function groupCounts(items) {
  const map = new Map();
  for (const student of items) {
    if (!student.group) continue;
    map.set(student.group, (map.get(student.group) || 0) + 1);
  }

  // numeric: иначе «Группа 10» встала бы перед «Группой 2» — строки сравниваются посимвольно.
  return [...map.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => a.group.localeCompare(b.group, 'ru', { numeric: true }));
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
    const visibleLessons = access.canViewAllLessons(req.user)
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

    // История оплат и история правок карточки — только тем, кому открыты и остальные
    // непубличные поля карточки (администратор, управляющий).
    if (access.canViewStudentDetails(req.user)) {
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
    if (!access.canEditStudent(req.user)) {
      return fail(res, 403, 'Заводить карточки учеников может администратор или управляющий.');
    }

    const body = bodyOf(req);
    if (teacherFieldDenied(req.user, body, { onlyFilled: true })) {
      return failValidation(res, { teacherId: TEACHER_ASSIGN_DENIED });
    }

    const { patch, errors } = readPatch(body);
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
      return fail(res, 403, 'Редактировать карточки учеников может администратор или управляющий.');
    }

    const body = bodyOf(req);
    if (teacherFieldDenied(req.user, body)) {
      return failValidation(res, { teacherId: TEACHER_ASSIGN_DENIED });
    }

    const current = await students.getById(req.params.id);
    if (!current) return fail(res, 404, 'Ученик не найден.');

    const { patch, errors } = readPatch(body);
    if (patch.teacherId && !(await ensureTeacherExists(patch.teacherId))) {
      errors.teacherId = 'Преподаватель не найден.';
    }

    if (patchRejected(res, errors, patch)) return;

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
      return fail(res, 403, 'Удалять карточки учеников может администратор или управляющий.');
    }

    const student = await students.getById(req.params.id);
    if (!student) return fail(res, 404, 'Ученик не найден.');

    // Связанные данные убираем явно, иначе в расписании и отчётах останутся ссылки в никуда.
    await lessons.detachStudent(student.id);
    await finance.removePaymentsOfStudent(student.id);

    // Удаление карточки и разрыв связи с заявкой — одной транзакцией по двум коллекциям:
    // заявка со ссылкой на удалённого ученика больше не конвертируется (её блокирует
    // проверка «карточка уже создана»), а между двумя отдельными записями успевает
    // пройти чужой запрос — и заявка осталась бы сиротой.
    await db.transaction(['students', 'applications'], (tx) => {
      tx.students.remove(student.id);

      // Ищем по обратной ссылке, а не по student.applicationId: так находится и заявка,
      // у которой связь проставлена только с её стороны.
      const source = tx.applications.find((item) => item.studentId === student.id);
      if (source) {
        tx.applications.update(source.id, (current) => applications.unlinkStudentChanges(current, req.user));
      }
    });

    await audit.removeFor('student', student.id);

    res.json({ ok: true });
  })
);

module.exports = router;
