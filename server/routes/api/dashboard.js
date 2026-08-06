'use strict';

/**
 * Дашборд. Ответ зависит от роли:
 *   администратор и управляющий — сводка по школе (ученики, заявки, преподаватели,
 *     оборот, занятия); отличается только ключ role, по которому клиент выбирает вид;
 *   преподаватель — только его собственные показатели, без финансов.
 *
 * Ключ role в ответе есть всегда: без него клиент не знает, какую сводку ему прислали.
 */

const express = require('express');

const access = require('../../domain/access');
const applications = require('../../models/applications');
const catalog = require('../../domain/catalog');
const finance = require('../../models/finance');
const lessons = require('../../models/lessons');
const students = require('../../models/students');
const users = require('../../models/users');
const { wrap, readPeriod, dayBoundsMs, today } = require('./helpers');

const router = express.Router();

/**
 * Сводка по школе. Одна и та же для администратора и управляющего: оба ведут заявки,
 * учеников, расписание и финансы. Ставок, окладов и начислений по ним здесь нет —
 * эти цифры живут в модуле «Сотрудники», закрытом для управляющего.
 */
async function schoolDashboard(user, period) {
  const bounds = dayBoundsMs(period.from, period.to);

  const [allStudents, allApplications, staff, periodLessons, payments, expenses] = await Promise.all([
    students.list(),
    applications.list(),
    users.list(),
    lessons.listBetween(period.from, period.to),
    finance.paymentsBetween(period.from, period.to),
    finance.expensesBetween(period.from, period.to),
  ]);

  const newApplications = allApplications.filter((item) => {
    const at = new Date(item.createdAt).getTime();
    return Number.isFinite(at) && at >= bounds.from && at <= bounds.to;
  });

  const byCourse = new Map();
  for (const student of allStudents) {
    if (student.status !== 'active') continue;
    const key = student.course || 'Без направления';
    byCourse.set(key, (byCourse.get(key) || 0) + 1);
  }

  const teachers = staff.filter((item) => item.role === 'teacher');
  const income = finance.sum(payments);
  const expense = finance.sum(expenses);

  const statusCounts = {};
  for (const status of catalog.STUDENT_STATUSES) {
    statusCounts[status.id] = allStudents.filter((student) => student.status === status.id).length;
  }

  const applicationCounts = {};
  for (const status of catalog.APPLICATION_STATUSES) {
    applicationCounts[status.id] = newApplications.filter((item) => item.status === status.id).length;
  }

  return {
    role: access.isManager(user) ? 'manager' : 'admin',
    period,
    students: {
      total: allStudents.length,
      byStatus: statusCounts,
      byCourse: [...byCourse.entries()]
        .map(([course, count]) => ({ course, count }))
        .sort((a, b) => b.count - a.count),
    },
    applications: {
      period: newApplications.length,
      new: allApplications.filter((item) => item.status === 'new').length,
      byStatus: applicationCounts,
    },
    teachers: {
      total: teachers.length,
      active: teachers.filter((item) => item.active).length,
    },
    finance: {
      income,
      expense,
      profit: income - expense,
    },
    lessons: {
      total: periodLessons.length,
      done: periodLessons.filter((lesson) => lesson.status === 'done').length,
      planned: periodLessons.filter((lesson) => lesson.status === 'planned').length,
      cancelled: periodLessons.filter((lesson) => lesson.status === 'cancelled').length,
    },
  };
}

async function teacherDashboard(user, period) {
  const [ownStudents, ownLessons] = await Promise.all([
    students.listByTeacher(user.id),
    lessons.listByTeacher(user.id),
  ]);

  const inPeriod = ownLessons.filter((lesson) => lesson.date >= period.from && lesson.date <= period.to);
  const now = new Date();
  const from = today();

  const upcoming = ownLessons
    .filter((lesson) => lesson.status === 'planned' && lesson.date >= from && lessons.endsAt(lesson) >= now)
    .slice(0, 5);

  // Занятия, которые уже прошли, но итог по ним не отмечен, — главный «долг» преподавателя.
  const needsReport = ownLessons.filter(
    (lesson) => lesson.status === 'planned' && lessons.endsAt(lesson) < now
  );

  const statusCounts = {};
  for (const status of catalog.STUDENT_STATUSES) {
    statusCounts[status.id] = ownStudents.filter((student) => student.status === status.id).length;
  }

  return {
    role: 'teacher',
    period,
    students: {
      total: ownStudents.length,
      byStatus: statusCounts,
    },
    lessons: {
      total: inPeriod.length,
      done: inPeriod.filter((lesson) => lesson.status === 'done').length,
      planned: inPeriod.filter((lesson) => lesson.status === 'planned').length,
      cancelled: inPeriod.filter((lesson) => lesson.status === 'cancelled').length,
      doneAllTime: ownLessons.filter((lesson) => lesson.status === 'done').length,
    },
    upcoming: upcoming.map((lesson) => access.lessonFor(user, lesson)),
    needsReport: needsReport.slice(-10).reverse().map((lesson) => access.lessonFor(user, lesson)),
  };
}

router.get(
  '/',
  wrap(async (req, res) => {
    const period = readPeriod(req.query);

    // Выбор по праву на финансы, а не по роли: в сводке по школе есть оборот,
    // и это самая закрытая её часть.
    const payload = access.canViewFinance(req.user)
      ? await schoolDashboard(req.user, period)
      : await teacherDashboard(req.user, period);

    res.json({ ok: true, ...payload });
  })
);

module.exports = router;
