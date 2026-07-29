'use strict';

/**
 * Ученики: data/students.json.
 *
 * Часть полей карточки — персональные данные родителей и заметки администрации.
 * Здесь они хранятся целиком; отсечением по ролям занимается domain/access.js,
 * чтобы преподавателю они не уходили даже в JSON-ответе.
 */

const db = require('../db');
const catalog = require('../domain/catalog');

const MAX_NOTE = 4000;

/** Особенности ребёнка: темп, поведение, здоровье, пожелания. Видны обеим ролям. */
function normalizeTraits(traits) {
  const source = traits && typeof traits === 'object' ? traits : {};
  return {
    pace: db.asText(source.pace, 500),
    behavior: db.asText(source.behavior, 500),
    health: db.asText(source.health, 500),
    wishes: db.asText(source.wishes, 500),
  };
}

function normalize(record) {
  if (!record || typeof record !== 'object') return null;

  const createdAt = db.asIsoDateTime(record.createdAt) || new Date().toISOString();

  return {
    id: db.asText(record.id) || db.createId('st'),
    createdAt,
    updatedAt: db.asIsoDateTime(record.updatedAt) || createdAt,

    // Видно обеим ролям
    name: db.asText(record.name, 120),
    birthDate: db.asDay(record.birthDate),
    age: db.asInt(record.age),
    course: db.asText(record.course, 120),
    group: db.asText(record.group, 80),
    teacherId: db.asText(record.teacherId),
    traits: normalizeTraits(record.traits),
    status: db.oneOf(record.status, catalog.STUDENT_STATUS_IDS, catalog.DEFAULT_STUDENT_STATUS),
    startedAt: db.asDay(record.startedAt),

    // Только администратор
    parentName: db.asText(record.parentName, 120),
    parentPhone: db.asText(record.parentPhone, 40),
    parentEmail: db.asText(record.parentEmail, 120),
    parentSecond: db.asText(record.parentSecond, 200),
    adminNote: db.asText(record.adminNote, MAX_NOTE),
    lessonPrice: db.asMoney(record.lessonPrice),

    applicationId: db.asText(record.applicationId),
  };
}

const store = db.collection('students', { normalize, prefix: 'st' });

/**
 * Возраст: считается по дате рождения, если она есть, иначе берётся сохранённое число.
 * Так карточка не устаревает сама по себе, но и заявка без даты рождения не теряет возраст.
 */
function ageOf(student) {
  if (student.birthDate) {
    const born = new Date(`${student.birthDate}T00:00:00`);
    if (!Number.isNaN(born.getTime())) {
      const now = new Date();
      let age = now.getFullYear() - born.getFullYear();
      const monthDiff = now.getMonth() - born.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) age -= 1;
      if (age >= 0 && age < 120) return age;
    }
  }
  return Number.isInteger(student.age) ? student.age : null;
}

async function listByTeacher(teacherId) {
  return store.filter((student) => student.teacherId === teacherId);
}

async function countByCourse() {
  const items = await store.list();
  const result = new Map();

  for (const student of items) {
    const key = student.course || 'Без направления';
    result.set(key, (result.get(key) || 0) + 1);
  }

  return [...result.entries()]
    .map(([course, count]) => ({ course, count }))
    .sort((a, b) => b.count - a.count);
}

/** Снимает закрепление за преподавателем — вызывается, когда сотрудника удаляют. */
async function detachTeacher(teacherId) {
  const affected = await listByTeacher(teacherId);
  for (const student of affected) {
    await store.update(student.id, { teacherId: '' });
  }
  return affected.length;
}

module.exports = {
  file: store.file,
  init: store.init,
  list: store.list,
  filter: store.filter,
  getById: store.getById,
  count: store.count,
  create: store.create,
  update: store.update,
  remove: store.remove,
  replaceAll: store.replaceAll,
  ageOf,
  listByTeacher,
  countByCourse,
  detachTeacher,
};
