'use strict';

/**
 * Единая точка доступа к данным: создание файлов при первом запуске и разовые миграции
 * со структуры первой версии проекта (лендинг + заявки) на структуру платформы.
 */

const applications = require('./applications');
const audit = require('./audit');
const finance = require('./finance');
const lessons = require('./lessons');
const notifications = require('./notifications');
const students = require('./students');
const users = require('./users');

async function init() {
  await users.init();
  await applications.init();
  await students.init();
  await lessons.init();
  await finance.init();
  await notifications.init();
  await audit.init();

  // Порядок важен: сначала учётки получают идентификаторы, потом на них ссылаются остальные данные.
  await users.migrate();
  await applications.migrate();
}

module.exports = {
  init,
  applications,
  audit,
  finance,
  lessons,
  notifications,
  students,
  users,
};
