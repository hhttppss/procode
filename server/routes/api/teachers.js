'use strict';

/**
 * Модуль «Сотрудники» — только для администратора (проверка стоит на роутере).
 * Здесь заводятся учётные записи любой роли: логин, пароль, блокировка, ставка, оклад.
 * Управляющему этот раздел закрыт целиком — сотрудниками распоряжается администратор.
 *
 * Путь остался /teachers: переименование URL сломало бы сохранённые ссылки и закладки,
 * а раздел от смены подписи в меню другим не стал.
 */

const express = require('express');

const access = require('../../domain/access');
const audit = require('../../models/audit');
const catalog = require('../../domain/catalog');
const db = require('../../db');
const lessons = require('../../models/lessons');
const notifications = require('../../models/notifications');
const payroll = require('../../domain/payroll');
const students = require('../../models/students');
const users = require('../../models/users');
const { wrap, fail, failValidation, bodyOf, fieldsOf, patchRejected, readPeriod } = require('./helpers');

const router = express.Router();

/** Статистика занятий преподавателя за всё время и за период. */
function lessonStats(teacherLessons, period) {
  const inPeriod = teacherLessons.filter((lesson) => lesson.date >= period.from && lesson.date <= period.to);

  const countBy = (items, status) => items.filter((lesson) => lesson.status === status).length;

  return {
    total: teacherLessons.length,
    done: countBy(teacherLessons, 'done'),
    planned: countBy(teacherLessons, 'planned'),
    cancelled: countBy(teacherLessons, 'cancelled'),
    period: {
      from: period.from,
      to: period.to,
      total: inPeriod.length,
      done: countBy(inPeriod, 'done'),
      cancelled: countBy(inPeriod, 'cancelled'),
    },
  };
}

// ---------------------------------------------------------------- список

router.get(
  '/',
  wrap(async (req, res) => {
    const period = readPeriod(req.query);
    const staff = await users.list();
    const allLessons = await lessons.list();
    const allStudents = await students.list();

    // По умолчанию показываем всех сотрудников: иначе созданная здесь же учётка
    // администратора пропадала бы из списка. ?role=teacher сужает выборку.
    const onlyTeachers = req.query.role === 'teacher';
    const visible = staff.filter((user) => (onlyTeachers ? user.role === 'teacher' : true));

    const items = visible
      .map((user) => {
        const own = allLessons.filter((lesson) => lesson.teacherId === user.id);
        return {
          ...access.staffForAdmin(user),
          studentsCount: allStudents.filter((student) => student.teacherId === user.id).length,
          stats: lessonStats(own, period),
        };
      })
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'ru'));

    res.json({
      ok: true,
      items,
      period,
      counts: {
        all: items.length,
        active: items.filter((item) => item.active).length,
        blocked: items.filter((item) => !item.active).length,
      },
    });
  })
);

// ------------------------------------------------------------- карточка

router.get(
  '/:id',
  wrap(async (req, res) => {
    const teacher = await users.getById(req.params.id);
    if (!teacher) return fail(res, 404, 'Сотрудник не найден.');

    const period = readPeriod(req.query);
    const own = await lessons.listByTeacher(teacher.id);
    const ownStudents = await students.listByTeacher(teacher.id);

    const stats = lessonStats(own, period);
    const doneInPeriod = own.filter(
      (lesson) => lesson.status === 'done' && lesson.date >= period.from && lesson.date <= period.to
    );

    // Считает тот же domain/payroll.js, что и «Финансы»: карточка обязана показывать
    // ровно ту сумму, которая уйдёт в расход по кнопке «Начислить». Карточка открывается
    // на текущем месяце, поэтому оклад в расчёт обычно входит; за произвольный период
    // (ссылка с другими from/to) он не начисляется — см. salaryApplies.
    const calculated = payroll.calculate(teacher, doneInPeriod.length, period);

    res.json({
      ok: true,
      item: access.staffForAdmin(teacher),
      students: ownStudents
        .map((student) => access.studentFor(req.user, student))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      stats,
      period,
      payroll: {
        rate: calculated.rate,
        salary: calculated.salary,
        salaryApplies: calculated.salaryApplies,
        lessons: calculated.lessons,
        amount: calculated.amount,
      },
      recentLessons: own.slice(-20).reverse(),
    });
  })
);

// -------------------------------------------------------------- создание

router.post(
  '/',
  wrap(async (req, res) => {
    const body = bodyOf(req);

    const result = await users.create({
      login: body.login,
      password: body.password,
      // Роль сверяется со справочником, а не с парой «админ или преподаватель»:
      // иначе новая роль молча превращалась бы в преподавателя.
      role: catalog.ROLE_IDS.includes(body.role) ? body.role : 'teacher',
      name: body.name,
      phone: body.phone,
      email: body.email,
      courses: Array.isArray(body.courses) ? body.courses : [],
      rate: body.rate,
      salary: body.salary,
      note: body.note,
      active: body.active === undefined ? true : Boolean(body.active),
    });

    if (!result.ok) return failValidation(res, result.errors);

    await audit.log({
      entity: 'user',
      entityId: result.user.id,
      action: 'create',
      actor: req.user,
      comment: `Создана учётная запись: ${result.user.login}`,
    });

    res.status(201).json({ ok: true, item: access.staffForAdmin(result.user) });
  })
);

// ------------------------------------------------------------ изменения

const EDITABLE = [
  { field: 'name', label: 'ФИО' },
  { field: 'phone', label: 'Телефон' },
  { field: 'email', label: 'Email' },
  { field: 'courses', label: 'Направления' },
  { field: 'rate', label: 'Ставка за занятие' },
  { field: 'salary', label: 'Оклад' },
  { field: 'note', label: 'Заметка' },
  { field: 'active', label: 'Доступ' },
  { field: 'role', label: 'Роль' },
];

router.patch(
  '/:id',
  wrap(async (req, res) => {
    const current = await users.getById(req.params.id);
    if (!current) return fail(res, 404, 'Сотрудник не найден.');

    const body = bodyOf(req);
    const patch = {};
    const errors = {};
    const has = fieldsOf(body);

    if (has('name')) {
      patch.name = db.asText(body.name, 120);
      if (!patch.name) errors.name = 'Укажите ФИО сотрудника.';
    }
    if (has('phone')) patch.phone = db.asText(body.phone, 40);
    if (has('email')) patch.email = db.asText(body.email, 120);
    if (has('courses')) patch.courses = db.asStringArray(body.courses);
    if (has('rate')) patch.rate = db.asMoney(body.rate);
    if (has('salary')) patch.salary = db.asMoney(body.salary);
    if (has('note')) patch.note = db.asText(body.note, 2000);
    if (has('active')) patch.active = Boolean(body.active);

    if (has('role')) {
      if (!catalog.ROLE_IDS.includes(body.role)) errors.role = 'Неизвестная роль.';
      else patch.role = body.role;
    }

    if (patchRejected(res, errors, patch)) return;

    // Последний администратор не должен уметь разжаловать или заблокировать сам себя —
    // проверка «остаётся ли ещё активный админ» и само изменение идут одной транзакцией:
    // раздельными вызовами два одновременных запроса могли разжаловать/заблокировать
    // обоих последних администраторов разом (в систему стало бы некому войти).
    const result = await db.transaction(['users'], (tx) => {
      const record = tx.users.getById(current.id);
      if (!record) return { ok: false, status: 404, message: 'Сотрудник не найден.' };

      // Условие смотрит не «стал ли преподавателем», а «перестал ли быть администратором»:
      // перевод в управляющие отнимает админские права ровно так же.
      const losesAdmin = (patch.role && patch.role !== 'admin') || patch.active === false;
      if (losesAdmin && access.isLastActiveAdmin(tx.users.list(), record.id)) {
        return {
          ok: false,
          errors: { role: 'Это единственный активный администратор — сначала назначьте другого.' },
        };
      }

      return { ok: true, before: record, updated: tx.users.update(record.id, patch) };
    });

    if (!result.ok) {
      if (result.errors) return failValidation(res, result.errors);
      return fail(res, result.status, result.message);
    }

    const { before, updated } = result;

    const changes = audit.diff(before, updated, [
      ...EDITABLE.map(({ field, label }) => {
        if (field === 'active') return { field, label, format: (value) => (value ? 'разрешён' : 'заблокирован') };
        if (field === 'courses') return { field, label, format: (value) => value.join(', ') };
        if (field === 'rate' || field === 'salary') return { field, label, format: (value) => `${value} ₽` };
        if (field === 'role') return { field, label, format: (value) => catalog.labelOf(catalog.ROLES, value) };
        return { field, label };
      }),
    ]);

    await audit.log({ entity: 'user', entityId: updated.id, action: 'update', actor: req.user, changes });

    res.json({ ok: true, item: access.staffForAdmin(updated), changes });
  })
);

router.post(
  '/:id/password',
  wrap(async (req, res) => {
    const teacher = await users.getById(req.params.id);
    if (!teacher) return fail(res, 404, 'Сотрудник не найден.');

    const result = await users.setPassword(teacher.id, bodyOf(req).password);
    if (!result.ok) return failValidation(res, result.errors);

    await audit.log({
      entity: 'user',
      entityId: teacher.id,
      action: 'password',
      actor: req.user,
      comment: 'Пароль изменён администратором',
    });

    res.json({ ok: true });
  })
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    const teacher = await users.getById(req.params.id);
    if (!teacher) return fail(res, 404, 'Сотрудник не найден.');

    if (teacher.id === req.user.id) return fail(res, 400, 'Нельзя удалить собственную учётную запись.');

    // Последний администратор не должен уметь удалить сам себя — проверка и удаление
    // идут одной транзакцией: раздельными вызовами два одновременных запроса могли
    // удалить обоих последних администраторов разом (в систему стало бы некому войти).
    //
    // Занятия читаются здесь же, а не отдельным вызовом до транзакции: порядок отказов
    // важен. Последний администратор с расписанием должен услышать «сначала назначьте
    // другого», а не «перенесите занятия» — перенос ему всё равно ничего не даст.
    const result = await db.transaction(['users', 'lessons'], (tx) => {
      const record = tx.users.getById(teacher.id);
      if (!record) return { ok: false, status: 404, message: 'Сотрудник не найден.' };

      if (access.isLastActiveAdmin(tx.users.list(), record.id)) {
        return { ok: false, status: 400, message: 'Это единственный активный администратор — сначала назначьте другого.' };
      }

      const planned = tx.lessons.find((lesson) => lesson.teacherId === record.id && lesson.status === 'planned');
      if (planned) {
        return {
          ok: false,
          status: 409,
          message: 'У сотрудника есть запланированные занятия. Перенесите их на другого преподавателя или отмените.',
        };
      }

      tx.users.remove(record.id);
      return { ok: true };
    });

    if (!result.ok) return fail(res, result.status, result.message);

    await students.detachTeacher(teacher.id);
    await notifications.removeForUser(teacher.id);
    await audit.log({
      entity: 'user',
      entityId: teacher.id,
      action: 'delete',
      actor: req.user,
      comment: `Учётная запись удалена: ${teacher.login}`,
    });

    res.json({ ok: true });
  })
);

module.exports = router;
