'use strict';

/**
 * Разграничение доступа — единственное место, где описано, что кому видно.
 *
 * Ключевая мысль: интерфейс ничего не «прячет». Данные, которых роль видеть не должна,
 * отсекаются здесь, до отправки ответа, — в JSON преподавателя контактов родителей,
 * ставок и окладов просто нет. Кнопки в интерфейсе — лишь отражение этих же правил.
 *
 * Роли:
 *   Администратор     — полный доступ ко всем модулям и полям.
 *   Управляющий школы — ежедневная работа: заявки, ученики, расписание, финансы.
 *                       Модуль «Сотрудники» ему закрыт целиком: он не заводит
 *                       учётные записи, не назначает преподавателя ученику и не
 *                       настраивает ставки и оклады — всё, что касается сотрудников
 *                       и денег, которые им платят, остаётся за администратором.
 *   Преподаватель     — только свои ученики и своё расписание, без финансов,
 *                       без контактов родителей, без редактирования карточек.
 *                       Свой профиль и пароль он тоже не меняет — учётной записью
 *                       полностью распоряжается администратор.
 *
 * Проверки написаны как возможности (canViewFinance, canEditStudent…), а не как сравнение
 * с ролью: появление четвёртой роли меняет этот файл, а не два десятка обработчиков.
 */

const students = require('../models/students');

function isAdmin(user) {
  return Boolean(user) && user.role === 'admin';
}

function isManager(user) {
  return Boolean(user) && user.role === 'manager';
}

function isTeacher(user) {
  return Boolean(user) && user.role === 'teacher';
}

// ---------------------------------------------------------------- возможности

/** Учётные записи сотрудников: создание, удаление, смена роли и пароля. */
function canManageUsers(user) {
  return isAdmin(user);
}

/** Ставка за занятие и оклад — часть договорённости с сотрудником, их меняет только администратор. */
function canManageRates(user) {
  return isAdmin(user);
}

/** Кто ведёт ученика — решение администратора: от этого зависят нагрузка и начисления. */
function canAssignTeacher(user) {
  return isAdmin(user);
}

function canManageApplications(user) {
  return isAdmin(user) || isManager(user);
}

function canViewAllStudents(user) {
  return isAdmin(user) || isManager(user);
}

/** Контакты родителей, стоимость занятия, заметки, оплаты и история правок карточки. */
function canViewStudentDetails(user) {
  return isAdmin(user) || isManager(user);
}

function canEditStudent(user) {
  return isAdmin(user) || isManager(user);
}

function canViewAllLessons(user) {
  return isAdmin(user) || isManager(user);
}

/** Составление расписания: создание, перенос, правка чужих занятий, удаление. */
function canManageLessons(user) {
  return isAdmin(user) || isManager(user);
}

function canViewFinance(user) {
  return isAdmin(user) || isManager(user);
}

/** Преподавателю профиль доступен только на чтение: ФИО и контакты правит администратор. */
function canEditOwnProfile(user) {
  return isAdmin(user) || isManager(user);
}

/** Пароль преподавателю назначает администратор — так учётка не уходит из-под его контроля. */
function canChangeOwnPassword(user) {
  return isAdmin(user) || isManager(user);
}

/**
 * Плоский набор флагов, который уезжает в браузер вместе со страницей.
 * Интерфейс рисуется по нему — но это лишь отражение правил, описанных выше:
 * каждый запрос к API проверяет права заново, независимо от того, что показано на экране.
 */
function clientPermissions(user) {
  return {
    canManageUsers: canManageUsers(user),
    canManageRates: canManageRates(user),
    canAssignTeacher: canAssignTeacher(user),
    canManageApplications: canManageApplications(user),
    canViewAllStudents: canViewAllStudents(user),
    canViewStudentDetails: canViewStudentDetails(user),
    canEditStudent: canEditStudent(user),
    canViewAllLessons: canViewAllLessons(user),
    canManageLessons: canManageLessons(user),
    canViewFinance: canViewFinance(user),
    canEditOwnProfile: canEditOwnProfile(user),
    canChangeOwnPassword: canChangeOwnPassword(user),
  };
}

// ------------------------------------------------------- учётные записи

/**
 * «Кроме этой учётной записи активных администраторов не осталось».
 *
 * Одна проверка на три операции, после которых в систему может стать некому войти:
 * блокировка администратора, перевод его в другую роль и удаление учётки. Запасной
 * вход по ADMIN_LOGIN/ADMIN_PASSWORD здесь не спасает — он включается, только когда
 * учётных записей не осталось вовсе (см. auth.checkCredentials), а управляющие
 * и преподаватели в базе остаются.
 *
 * Собственный признак active у цели намеренно не учитывается: заблокированный
 * администратор — тоже единственный, и последнюю учётную запись с этой ролью терять
 * нельзя. Через веб-интерфейс до этой ветки не дойти — если активных администраторов
 * не осталось, выполнить запрос уже некому; работает она в CLI (scripts/manage-users.js),
 * где команды «разблокировать» нет вовсе и доступ восстанавливают созданием нового
 * администратора (--add).
 *
 * Функция синхронная и получает список готовым: её вызывают внутри транзакции,
 * где проверка и изменение обязаны идти в одном месте очереди (см. server/db.js).
 *
 * @param {object[]} users список учётных записей — весь, включая проверяемую
 * @param {string} targetUserId учётка, которую блокируют, разжалуют или удаляют
 */
function isLastActiveAdmin(users, targetUserId) {
  const target = users.find((user) => user.id === targetUserId);
  if (!isAdmin(target)) return false;

  return !users.some((user) => user.id !== targetUserId && isAdmin(user) && user.active);
}

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

  // Ставку и оклад видит и меняет только администратор — в том числе в собственном
  // профиле преподавателя.
  if (isAdmin(user)) {
    profile.rate = user.rate;
    profile.salary = user.salary;
  }
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
    salary: user.salary,
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

/** Поля карточки ученика, закрытые от преподавателя. */
const PRIVILEGED_STUDENT_FIELDS = [
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

  if (canViewStudentDetails(user)) {
    for (const field of PRIVILEGED_STUDENT_FIELDS) view[field] = student[field];
  }

  return view;
}

/** Преподаватель видит только закреплённых за ним учеников. */
function canViewStudent(user, student) {
  if (!student) return false;
  if (canViewAllStudents(user)) return true;
  return isTeacher(user) && student.teacherId === user.id;
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
    group: lesson.group,
    format: lesson.format,
    link: lesson.link,
    status: lesson.status,
    teacherComment: lesson.teacherComment,
    attendance: lesson.attendance,
    seriesId: lesson.seriesId,
    createdAt: lesson.createdAt,
    updatedAt: lesson.updatedAt,
  };

  // Внутренняя пометка администрации преподавателю не показывается.
  if (canManageLessons(user)) view.adminComment = lesson.adminComment;

  return view;
}

function canViewLesson(user, lesson) {
  if (!lesson) return false;
  if (canViewAllLessons(user)) return true;
  return isTeacher(user) && lesson.teacherId === user.id;
}

/**
 * Преподаватель отмечает итог своего занятия: статус, комментарий, посещаемость.
 * Дату, время, состав учеников и ссылку он менять не может.
 */
const TEACHER_LESSON_FIELDS = ['status', 'teacherComment', 'attendance'];

function canReportLesson(user, lesson) {
  if (!lesson) return false;
  if (canViewAllLessons(user)) return true;
  return isTeacher(user) && lesson.teacherId === user.id;
}

// ---------------------------------------------------------------- модули

/** Список ролей, которым доступен модуль. Используется и для меню, и для проверок. */
const MODULE_ACCESS = {
  dashboard: ['admin', 'manager', 'teacher'],
  applications: ['admin', 'manager'],
  students: ['admin', 'manager', 'teacher'],
  teachers: ['admin'],
  schedule: ['admin', 'manager', 'teacher'],
  finance: ['admin', 'manager'],
  profile: ['admin', 'manager', 'teacher'],
};

function canOpenModule(user, moduleName) {
  const allowed = MODULE_ACCESS[moduleName];
  return Boolean(user) && Array.isArray(allowed) && allowed.includes(user.role);
}

module.exports = {
  isAdmin,
  isManager,
  isTeacher,
  canManageUsers,
  canManageRates,
  canAssignTeacher,
  canManageApplications,
  canViewAllStudents,
  canViewStudentDetails,
  canEditStudent,
  canViewAllLessons,
  canManageLessons,
  canViewFinance,
  canEditOwnProfile,
  canChangeOwnPassword,
  clientPermissions,
  isLastActiveAdmin,
  selfProfile,
  staffForAdmin,
  staffBrief,
  studentFor,
  canViewStudent,
  PRIVILEGED_STUDENT_FIELDS,
  lessonFor,
  canViewLesson,
  canReportLesson,
  TEACHER_LESSON_FIELDS,
  MODULE_ACCESS,
  canOpenModule,
};
