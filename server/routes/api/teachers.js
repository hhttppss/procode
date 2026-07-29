'use strict';

/**
 * Модуль «Преподаватели» — только для администратора (проверка стоит на роутере).
 * Здесь же заводятся учётные записи: логин, пароль, блокировка, ставка.
 */

const express = require('express');

const access = require('../../domain/access');
const audit = require('../../models/audit');
const db = require('../../db');
const lessons = require('../../models/lessons');
const notifications = require('../../models/notifications');
const students = require('../../models/students');
const users = require('../../models/users');
const { wrap, fail, failValidation, bodyOf, readPeriod } = require('./helpers');

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

    res.json({
      ok: true,
      item: access.staffForAdmin(teacher),
      students: ownStudents
        .map((student) => access.studentFor(req.user, student))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      stats,
      period,
      // Предварительный расчёт начисления: ставка × проведённые занятия за период.
      payroll: {
        rate: teacher.rate,
        lessons: doneInPeriod.length,
        amount: teacher.rate * doneInPeriod.length,
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
      role: body.role === 'admin' ? 'admin' : 'teacher',
      name: body.name,
      phone: body.phone,
      email: body.email,
      courses: Array.isArray(body.courses) ? body.courses : [],
      rate: body.rate,
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
    const has = (field) => Object.prototype.hasOwnProperty.call(body, field);

    if (has('name')) {
      patch.name = db.asText(body.name, 120);
      if (!patch.name) errors.name = 'Укажите ФИО сотрудника.';
    }
    if (has('phone')) patch.phone = db.asText(body.phone, 40);
    if (has('email')) patch.email = db.asText(body.email, 120);
    if (has('courses')) patch.courses = db.asStringArray(body.courses);
    if (has('rate')) patch.rate = db.asMoney(body.rate);
    if (has('note')) patch.note = db.asText(body.note, 2000);
    if (has('active')) patch.active = Boolean(body.active);

    if (has('role')) {
      if (!['admin', 'teacher'].includes(body.role)) errors.role = 'Неизвестная роль.';
      else patch.role = body.role;
    }

    // Последний администратор не должен уметь разжаловать или заблокировать сам себя:
    // иначе в систему будет некому войти.
    const losesAdmin = (patch.role && patch.role !== 'admin') || patch.active === false;
    if (current.role === 'admin' && losesAdmin) {
      const admins = await users.listByRole('admin');
      const otherActiveAdmins = admins.filter((user) => user.id !== current.id && user.active);
      if (otherActiveAdmins.length === 0) {
        errors.role = 'Это единственный активный администратор — сначала назначьте другого.';
      }
    }

    if (Object.keys(errors).length > 0) return failValidation(res, errors);
    if (Object.keys(patch).length === 0) return fail(res, 400, 'Нечего сохранять: не переданы изменения.');

    const updated = await users.update(current.id, patch);

    const changes = audit.diff(current, updated, [
      ...EDITABLE.map(({ field, label }) => {
        if (field === 'active') return { field, label, format: (value) => (value ? 'разрешён' : 'заблокирован') };
        if (field === 'courses') return { field, label, format: (value) => value.join(', ') };
        if (field === 'rate') return { field, label, format: (value) => `${value} ₽` };
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

    if (teacher.role === 'admin') {
      const admins = await users.listByRole('admin');
      if (admins.filter((user) => user.id !== teacher.id && user.active).length === 0) {
        return fail(res, 400, 'Это единственный активный администратор — сначала назначьте другого.');
      }
    }

    const teacherLessons = await lessons.listByTeacher(teacher.id);
    if (teacherLessons.some((lesson) => lesson.status === 'planned')) {
      return fail(
        res,
        409,
        'У сотрудника есть запланированные занятия. Перенесите их на другого преподавателя или отмените.'
      );
    }

    await students.detachTeacher(teacher.id);
    await notifications.removeForUser(teacher.id);
    await users.remove(teacher.id);
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
