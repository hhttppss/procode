'use strict';

/**
 * Свой профиль. Доступен всем ролям, но набор полей и прав разный.
 *
 * Преподаватель видит здесь свои данные и статистику занятий, но не меняет ни личные
 * данные, ни пароль: его учётной записью полностью распоряжается администратор — так
 * контакты в карточке сотрудника совпадают с теми, по которым школа с ним связывается,
 * а перехваченная сессия не даёт сменить пароль и запереть владельца снаружи.
 * Ставку преподаватель не видит и не меняет (см. access.selfProfile), роль и доступ
 * к системе меняются только через модуль «Преподаватели».
 */

const express = require('express');

const access = require('../../domain/access');
const audit = require('../../models/audit');
const db = require('../../db');
const lessons = require('../../models/lessons');
const students = require('../../models/students');
const users = require('../../models/users');
const { wrap, fail, failValidation, bodyOf, fieldsOf, patchRejected, readPeriod } = require('./helpers');

const router = express.Router();

router.get(
  '/',
  wrap(async (req, res) => {
    const period = readPeriod(req.query);
    const payload = { ok: true, item: access.selfProfile(req.user), period };

    if (access.isTeacher(req.user)) {
      const [own, ownStudents] = await Promise.all([
        lessons.listByTeacher(req.user.id),
        students.listByTeacher(req.user.id),
      ]);

      const inPeriod = own.filter((lesson) => lesson.date >= period.from && lesson.date <= period.to);

      payload.stats = {
        studentsTotal: ownStudents.length,
        lessonsAllTime: own.length,
        doneAllTime: own.filter((lesson) => lesson.status === 'done').length,
        donePeriod: inPeriod.filter((lesson) => lesson.status === 'done').length,
        cancelledPeriod: inPeriod.filter((lesson) => lesson.status === 'cancelled').length,
        plannedAhead: own.filter((lesson) => lesson.status === 'planned').length,
      };
    }

    res.json(payload);
  })
);

router.patch(
  '/',
  wrap(async (req, res) => {
    if (!access.canEditOwnProfile(req.user)) {
      return fail(res, 403, 'Личные данные меняет администратор — обратитесь к нему.');
    }

    // Учётка из .env существует только до создания первого сотрудника — править её негде.
    if (req.user.fromEnv) {
      return fail(res, 400, 'Это временная учётная запись из .env. Заведите постоянного администратора.');
    }

    const body = bodyOf(req);
    const patch = {};
    const errors = {};
    const has = fieldsOf(body);

    if (has('name')) {
      patch.name = db.asText(body.name, 120);
      if (!patch.name) errors.name = 'Укажите ФИО.';
    }
    if (has('phone')) patch.phone = db.asText(body.phone, 40);
    if (has('email')) patch.email = db.asText(body.email, 120);

    if (patchRejected(res, errors, patch)) return;

    const updated = await users.update(req.user.id, patch);
    if (!updated) return fail(res, 404, 'Учётная запись не найдена.');

    res.json({ ok: true, item: access.selfProfile(updated) });
  })
);

router.post(
  '/password',
  wrap(async (req, res) => {
    if (!access.canChangeOwnPassword(req.user)) {
      return fail(res, 403, 'Пароль назначает администратор — обратитесь к нему.');
    }

    if (req.user.fromEnv) {
      return fail(res, 400, 'Пароль временной учётной записи меняется в файле .env.');
    }

    const body = bodyOf(req);

    // Текущий пароль обязателен: перехваченная сессия не должна давать смену пароля.
    const confirmed = await users.verify(req.user.login, body.current);
    if (!confirmed || confirmed.id !== req.user.id) {
      return failValidation(res, { current: 'Текущий пароль указан неверно.' });
    }

    const result = await users.setPassword(req.user.id, body.next);
    if (!result.ok) return failValidation(res, { next: Object.values(result.errors)[0] });

    await audit.log({
      entity: 'user',
      entityId: req.user.id,
      action: 'password',
      actor: req.user,
      comment: 'Пароль изменён владельцем учётной записи',
    });

    res.json({ ok: true });
  })
);

module.exports = router;
