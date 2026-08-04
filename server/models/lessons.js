'use strict';

/**
 * Занятия: data/lessons.json.
 *
 * Занятие может быть индивидуальным или групповым — отличие только в длине studentIds,
 * отдельной сущности «группа» по-прежнему нет: у ученика есть текстовое поле «группа»,
 * а занятие просто ссылается на нескольких учеников. Для школы такого размера этого
 * достаточно и это не плодит связей, которые пришлось бы поддерживать вручную.
 *
 * У занятия тоже есть необязательное текстовое поле «группа» — то же самое значение,
 * что и у ученика. Оно нужно, чтобы состав занятия подтягивался автоматически: выбрал
 * группу — получил её учеников, а не отмечал каждого руками.
 *
 * Повторяющиеся занятия создаются пачкой и получают общий seriesId — чтобы серию
 * можно было удалить целиком.
 */

const db = require('../db');
const catalog = require('../domain/catalog');

const MAX_COMMENT = 2000;
const DEFAULT_DURATION = 60;
const MIN_DURATION = 15;
const MAX_DURATION = 300;

function normalizeAttendance(value, studentIds) {
  if (!value || typeof value !== 'object') return {};

  const result = {};
  for (const studentId of studentIds) {
    const mark = value[studentId];
    if (catalog.ATTENDANCE_IDS.includes(mark)) result[studentId] = mark;
  }
  return result;
}

function normalize(record) {
  if (!record || typeof record !== 'object') return null;

  const createdAt = db.asIsoDateTime(record.createdAt) || new Date().toISOString();
  const date = db.asDay(record.date);
  const startTime = db.asTime(record.startTime);
  if (!date || !startTime) return null; // занятие без даты и времени бессмысленно

  const studentIds = db.asStringArray(record.studentIds, 30, 60);
  const duration = db.asInt(record.durationMin, DEFAULT_DURATION);

  return {
    id: db.asText(record.id) || db.createId('ls'),
    createdAt,
    updatedAt: db.asIsoDateTime(record.updatedAt) || createdAt,

    date,
    startTime,
    durationMin: Math.min(Math.max(duration, MIN_DURATION), MAX_DURATION),
    teacherId: db.asText(record.teacherId),
    studentIds,
    title: db.asText(record.title, 120),
    course: db.asText(record.course, 120),
    group: db.asText(record.group, 80),
    format: db.oneOf(record.format, catalog.LESSON_FORMAT_IDS, 'online'),
    link: db.asText(record.link, 500),
    status: db.oneOf(record.status, catalog.LESSON_STATUS_IDS, catalog.DEFAULT_LESSON_STATUS),
    teacherComment: db.asText(record.teacherComment, MAX_COMMENT),
    adminComment: db.asText(record.adminComment, MAX_COMMENT),
    attendance: normalizeAttendance(record.attendance, studentIds),
    seriesId: db.asText(record.seriesId),
  };
}

const store = db.collection('lessons', { normalize, prefix: 'ls' });

/** Ключ сортировки: строки вида «2026-08-01 17:00» сравниваются лексикографически. */
function sortKey(lesson) {
  return `${lesson.date} ${lesson.startTime}`;
}

function byTime(a, b) {
  return sortKey(a).localeCompare(sortKey(b));
}

/** Момент начала занятия в местном времени — для «ближайшего занятия» и отчётов. */
function startsAt(lesson) {
  return new Date(`${lesson.date}T${lesson.startTime}:00`);
}

function endsAt(lesson) {
  return new Date(startsAt(lesson).getTime() + lesson.durationMin * 60 * 1000);
}

/**
 * Занятия в диапазоне дат включительно. Границы — календарные дни YYYY-MM-DD,
 * сравнение строковое: часовые пояса в расчёт не вмешиваются.
 */
async function listBetween(fromDay, toDay, extraFilter) {
  const items = await store.filter((lesson) => {
    if (fromDay && lesson.date < fromDay) return false;
    if (toDay && lesson.date > toDay) return false;
    if (extraFilter && !extraFilter(lesson)) return false;
    return true;
  });

  return items.sort(byTime);
}

async function listByTeacher(teacherId) {
  return (await store.filter((lesson) => lesson.teacherId === teacherId)).sort(byTime);
}

async function listByStudent(studentId) {
  return (await store.filter((lesson) => lesson.studentIds.includes(studentId))).sort(byTime);
}

/** Удаляет серию целиком (или её хвост с fromDay) одной перезаписью коллекции. */
async function removeSeries(seriesId, fromDay) {
  if (!seriesId) return 0;

  return store.removeWhere((lesson) => lesson.seriesId === seriesId && (!fromDay || lesson.date >= fromDay));
}

/**
 * Убирает ученика из всех занятий — когда карточку удаляют.
 * Патч свой для каждого занятия, поэтому вторым аргументом идёт функция от текущей записи.
 */
async function detachStudent(studentId) {
  const updated = await store.updateWhere(
    (lesson) => lesson.studentIds.includes(studentId),
    (lesson) => {
      const attendance = { ...lesson.attendance };
      delete attendance[studentId];
      return {
        studentIds: lesson.studentIds.filter((id) => id !== studentId),
        attendance,
      };
    }
  );

  return updated.length;
}

module.exports = {
  file: store.file,
  MAX_COMMENT,
  DEFAULT_DURATION,
  MIN_DURATION,
  MAX_DURATION,
  init: store.init,
  list: store.list,
  filter: store.filter,
  getById: store.getById,
  count: store.count,
  create: store.create,
  createMany: store.createMany,
  update: store.update,
  remove: store.remove,
  replaceAll: store.replaceAll,
  byTime,
  sortKey,
  startsAt,
  endsAt,
  listBetween,
  listByTeacher,
  listByStudent,
  removeSeries,
  detachStudent,
};
