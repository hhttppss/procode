'use strict';

/**
 * Сборка API платформы: /app/api/*
 *
 * Здесь же расставлены проверки роли на уровне маршрутов. «Заявки» и «Финансы» открыты
 * администратору и управляющему, «Сотрудники» (/teachers) — только администратору:
 * учётные записи, роли, ставки и оклады остаются за ним. Ни один обработчик закрытого
 * модуля не выполнится для чужой роли, даже если запрос отправлен вручную.
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
 * Справочник для выпадающих списков: преподаватели, все сотрудники и ученики одними именами.
 * Преподаватель получает здесь только своих учеников и краткие карточки коллег
 * (без ставок и контактов) — это нужно, чтобы в расписании отображались имена.
 * Ставок и окладов здесь нет ни для кого: они живут только в модуле «Сотрудники».
 *
 * teachers и staff — разные списки, а не один с фильтром: расписанию и карточке ученика
 * нужны именно преподаватели (закрепить ученика за администратором нельзя), а форме
 * расхода в «Финансах» — любой сотрудник, включая тех, кто занятий не ведёт.
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
      // Все сотрудники — для формы ручного расхода: привязать трату можно и к управляющему
      // с администратором, у которых занятий нет, а оклад есть. Список уходит только тем,
      // кому открыты финансы, — больше о коллегах никто отсюда не узнаёт. Тем, кому нельзя,
      // отдаём пустой массив, а не пропускаем поле: форма ответа одинакова для всех ролей,
      // и клиенту не приходится отличать «нет права» от «сотрудников нет вовсе».
      staff: access.canViewFinance(req.user)
        ? staff.map((user) => access.staffBrief(user)).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        : [],
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
