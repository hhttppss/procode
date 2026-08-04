'use strict';

/**
 * Сборка API платформы: /app/api/*
 *
 * Здесь же расставлены проверки роли на уровне маршрутов. «Заявки» и «Финансы» открыты
 * администратору и управляющему, «Преподаватели» — только администратору: учётные записи,
 * роли и ставки остаются за ним. Ни один обработчик закрытого модуля не выполнится для
 * чужой роли, даже если запрос отправлен вручную.
 *
 * «Ученики» и «Расписание» открыты всем трём ролям, но внутри каждый обработчик
 * ограничивает выборку и набор полей по req.user (см. domain/access.js).
 */

const express = require('express');

const access = require('../../domain/access');
const auth = require('../../auth');
const students = require('../../models/students');
const users = require('../../models/users');
const { wrap } = require('./helpers');

const router = express.Router();

// Всё ниже требует входа в систему.
router.use(auth.requireApi);

router.use('/dashboard', require('./dashboard'));
router.use('/notifications', require('./notifications'));
router.use('/profile', require('./profile'));

router.use('/applications', auth.requireRoleApi('admin', 'manager'), require('./applications'));
router.use('/teachers', auth.requireAdminApi, require('./teachers'));
router.use('/finance', auth.requireRoleApi('admin', 'manager'), require('./finance'));

router.use('/students', require('./students'));
router.use('/lessons', require('./lessons'));

/**
 * Справочник для выпадающих списков: преподаватели и ученики одними именами.
 * Преподаватель получает здесь только своих учеников и краткие карточки коллег
 * (без ставок и контактов) — это нужно, чтобы в расписании отображались имена.
 * Ставок здесь нет ни для кого: они живут только в модуле «Преподаватели».
 */
router.get(
  '/directory',
  wrap(async (req, res) => {
    const seesEveryone = access.canViewAllStudents(req.user);

    const staff = await users.list();
    const studentList = seesEveryone ? await students.list() : await students.listByTeacher(req.user.id);

    res.json({
      ok: true,
      teachers: staff
        .filter((user) => user.role === 'teacher')
        .map((user) => (seesEveryone ? { ...access.staffBrief(user), courses: user.courses } : access.staffBrief(user)))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      students: studentList
        .map((student) => ({
          id: student.id,
          name: student.name,
          course: student.course,
          group: student.group,
          teacherId: student.teacherId,
          status: student.status,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    });
  })
);

module.exports = router;
