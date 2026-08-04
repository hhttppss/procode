'use strict';

/**
 * Кто и о чём получает уведомления.
 * Вынесено отдельно, чтобы правила рассылки не расползались по обработчикам маршрутов.
 */

const lessons = require('../models/lessons');
const notifications = require('../models/notifications');
const users = require('../models/users');

/**
 * Идентификаторы активных сотрудников перечисленных ролей.
 * Заблокированным не шлём: они всё равно не войдут, а лента копилась бы впустую.
 */
async function activeIdsByRoles(roles) {
  const found = [];
  for (const role of roles) {
    const staff = await users.listByRole(role);
    for (const user of staff) {
      if (user.active) found.push(user.id);
    }
  }
  return found;
}

function lessonWhen(lesson) {
  const [year, month, day] = lesson.date.split('-');
  return `${day}.${month}.${year} в ${lesson.startTime}`;
}

/**
 * Новая заявка с лендинга — администраторам и управляющим.
 * Список ролей повторяет MODULE_ACCESS.applications из domain/access.js: заявку получает тот,
 * кто может её открыть, иначе уведомление вело бы на страницу с редиректом на главную.
 */
async function newApplication(application) {
  const ids = await activeIdsByRoles(['admin', 'manager']);
  if (ids.length === 0) return;

  await notifications.pushMany(ids, {
    type: 'application',
    title: 'Новая заявка с сайта',
    text: `${application.parentName || 'Без имени'} · ${application.course || 'направление не выбрано'}`,
    link: `/app/applications?id=${application.id}`,
  });

  for (const id of ids) await notifications.trim(id);
}

/** Занятие назначено, изменено, отменено или удалено — преподавателю. */
async function lessonChanged(lesson, kind, { previous } = {}) {
  if (!lesson || !lesson.teacherId) return;

  const titles = {
    created: 'Новое занятие в расписании',
    updated: 'Занятие изменено',
    cancelled: 'Занятие отменено',
    removed: 'Занятие удалено из расписания',
  };

  let text = lessonWhen(lesson);
  if (kind === 'updated' && previous && (previous.date !== lesson.date || previous.startTime !== lesson.startTime)) {
    text = `${lessonWhen(previous)} → ${lessonWhen(lesson)}`;
  }

  await notifications.push(lesson.teacherId, {
    type: 'lesson',
    title: titles[kind] || 'Изменение в расписании',
    text,
    link: `/app/schedule?date=${lesson.date}`,
  });

  await notifications.trim(lesson.teacherId);
}

/** Массовое создание серии — одно уведомление вместо десятка. */
async function lessonsCreated(created) {
  if (!Array.isArray(created) || created.length === 0) return;
  if (created.length === 1) return lessonChanged(created[0], 'created');

  const byTeacher = new Map();
  for (const lesson of created) {
    if (!lesson.teacherId) continue;
    if (!byTeacher.has(lesson.teacherId)) byTeacher.set(lesson.teacherId, []);
    byTeacher.get(lesson.teacherId).push(lesson);
  }

  for (const [teacherId, items] of byTeacher) {
    const sorted = items.slice().sort(lessons.byTime);
    await notifications.push(teacherId, {
      type: 'lesson',
      title: `В расписание добавлено занятий: ${items.length}`,
      text: `С ${lessonWhen(sorted[0])} по ${lessonWhen(sorted[sorted.length - 1])}`,
      link: `/app/schedule?date=${sorted[0].date}`,
    });
    await notifications.trim(teacherId);
  }
}

/** Ученика закрепили за преподавателем. */
async function studentAssigned(student, teacherId) {
  if (!teacherId) return;

  await notifications.push(teacherId, {
    type: 'student',
    title: 'Вам закреплён новый ученик',
    text: `${student.name}${student.course ? ` · ${student.course}` : ''}`,
    link: `/app/students/${student.id}`,
  });
  await notifications.trim(teacherId);
}

module.exports = {
  newApplication,
  lessonChanged,
  lessonsCreated,
  studentAssigned,
};
