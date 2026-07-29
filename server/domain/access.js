'use strict';

/**
 * Разграничение доступа — единственное место, где описано, что кому видно.
 *
 * Ключевая мысль: интерфейс ничего не «прячет». Данные, которых роль видеть не должна,
 * отсекаются здесь, до отправки ответа, — в JSON преподавателя контактов родителей
 * и ставок просто нет. Кнопки в интерфейсе — лишь отражение этих же правил.
 *
 * Правила:
 *   Администратор  — полный доступ ко всем модулям и полям.
 *   Преподаватель  — только свои ученики и своё расписание, без финансов,
 *                    без контактов родителей, без редактирования карточек.
 */

const students = require('../models/students');

function isAdmin(user) {
  return Boolean(user) && user.role === 'admin';
}

function isTeacher(user) {
  return Boolean(user) && user.role === 'teacher';
}

// ------------------------------------------------------- учётные записи

/** Данные о самом себе: пароль и служебные поля наружу не уходят никогда. */
function selfProfile(user) {
  const profile = {
    id: user.id,
    login: user.login,
    role: user.role,
    name: user.name,
    phone: user.phone,
    email: user.email,
    courses: user.courses,
    active: user.active,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };

  // Ставку видит и меняет только администратор — в том числе в собственном профиле преподавателя.
  if (isAdmin(user)) profile.rate = user.rate;
  return profile;
}

/** Карточка сотрудника для администратора: всё, кроме соли и хэша пароля. */
function staffForAdmin(user) {
  return {
    id: user.id,
    login: user.login,
    role: user.role,
    name: user.name,
    phone: user.phone,
    email: user.email,
    courses: user.courses,
    rate: user.rate,
    active: user.active,
    note: user.note,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}

/**
 * Преподаватель в чужих глазах (например, в карточке ученика): только имя и роль.
 * Ни ставки, ни контактов, ни логина.
 */
function staffBrief(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, role: user.role, active: user.active };
}

// -------------------------------------------------------------- ученики

/** Поля карточки ученика, доступные только администратору. */
const ADMIN_ONLY_STUDENT_FIELDS = [
  'parentName',
  'parentPhone',
  'parentEmail',
  'parentSecond',
  'adminNote',
  'lessonPrice',
  'applicationId',
];

function studentFor(user, student) {
  if (!student) return null;

  const view = {
    id: student.id,
    createdAt: student.createdAt,
    updatedAt: student.updatedAt,
    name: student.name,
    birthDate: student.birthDate,
    age: students.ageOf(student),
    course: student.course,
    group: student.group,
    teacherId: student.teacherId,
    traits: student.traits,
    status: student.status,
    startedAt: student.startedAt,
  };

  if (isAdmin(user)) {
    for (const field of ADMIN_ONLY_STUDENT_FIELDS) view[field] = student[field];
  }

  return view;
}

/** Преподаватель видит только закреплённых за ним учеников. */
function canViewStudent(user, student) {
  if (!student) return false;
  if (isAdmin(user)) return true;
  return isTeacher(user) && student.teacherId === user.id;
}

/** Редактировать карточки может только администратор. */
function canEditStudent(user) {
  return isAdmin(user);
}

// -------------------------------------------------------------- занятия

function lessonFor(user, lesson) {
  if (!lesson) return null;

  const view = {
    id: lesson.id,
    date: lesson.date,
    startTime: lesson.startTime,
    durationMin: lesson.durationMin,
    teacherId: lesson.teacherId,
    studentIds: lesson.studentIds,
    title: lesson.title,
    course: lesson.course,
    format: lesson.format,
    link: lesson.link,
    status: lesson.status,
    teacherComment: lesson.teacherComment,
    attendance: lesson.attendance,
    seriesId: lesson.seriesId,
    createdAt: lesson.createdAt,
    updatedAt: lesson.updatedAt,
  };

  // Внутренняя пометка администратора преподавателю не показывается.
  if (isAdmin(user)) view.adminComment = lesson.adminComment;

  return view;
}

function canViewLesson(user, lesson) {
  if (!lesson) return false;
  if (isAdmin(user)) return true;
  return isTeacher(user) && lesson.teacherId === user.id;
}

/** Создавать, переносить и удалять занятия может только администратор. */
function canManageLessons(user) {
  return isAdmin(user);
}

/**
 * Преподаватель отмечает итог своего занятия: статус, комментарий, посещаемость.
 * Дату, время, состав учеников и ссылку он менять не может.
 */
const TEACHER_LESSON_FIELDS = ['status', 'teacherComment', 'attendance'];

function canReportLesson(user, lesson) {
  if (!lesson) return false;
  if (isAdmin(user)) return true;
  return isTeacher(user) && lesson.teacherId === user.id;
}

// -------------------------------------------------------------- финансы

function canViewFinance(user) {
  return isAdmin(user);
}

/** Список ролей, которым доступен модуль. Используется и для меню, и для проверок. */
const MODULE_ACCESS = {
  dashboard: ['admin', 'teacher'],
  applications: ['admin'],
  students: ['admin', 'teacher'],
  teachers: ['admin'],
  schedule: ['admin', 'teacher'],
  finance: ['admin'],
  profile: ['admin', 'teacher'],
};

function canOpenModule(user, moduleName) {
  const allowed = MODULE_ACCESS[moduleName];
  return Boolean(user) && Array.isArray(allowed) && allowed.includes(user.role);
}

module.exports = {
  isAdmin,
  isTeacher,
  selfProfile,
  staffForAdmin,
  staffBrief,
  studentFor,
  canViewStudent,
  canEditStudent,
  ADMIN_ONLY_STUDENT_FIELDS,
  lessonFor,
  canViewLesson,
  canManageLessons,
  canReportLesson,
  TEACHER_LESSON_FIELDS,
  canViewFinance,
  MODULE_ACCESS,
  canOpenModule,
};
