'use strict';

/**
 * Управление учётными записями сотрудников из командной строки.
 *
 *   node scripts/manage-users.js --list
 *   node scripts/manage-users.js --add <логин> <пароль> [--teacher] [--name "ФИО"]
 *   node scripts/manage-users.js --remove <логин> [--force]
 *
 * Без флага --teacher создаётся администратор.
 * Удаление отказывает, если у сотрудника есть запланированные занятия; --force снимает проверку.
 *
 * Пароль можно не писать в командной строке — тогда скрипт прочитает его
 * из стандартного ввода:  echo "мойпароль" | node scripts/manage-users.js --add ivan
 * Это надёжнее: аргументы командной строки попадают в историю оболочки.
 *
 * Повседневно преподавателей удобнее заводить в интерфейсе: /app/teachers.
 */

// Первым — config: он выставляет process.env.TZ, иначе даты создания учёток
// в списке печатались бы в поясе сервера, а не в том, в котором работает школа.
const config = require('../server/config');

const lessons = require('../server/models/lessons');
const models = require('../server/models');
const notifications = require('../server/models/notifications');
const students = require('../server/models/students');
const users = require('../server/models/users');

function usage() {
  console.log('Использование:');
  console.log('  node scripts/manage-users.js --list');
  console.log('  node scripts/manage-users.js --add <логин> <пароль> [--teacher] [--name "ФИО"]');
  console.log('  node scripts/manage-users.js --remove <логин> [--force]');
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
  });
}

/** Выделяет из аргументов флаги --teacher и --name, оставляя позиционные значения. */
function parseArgs(rest) {
  const positional = [];
  let role = 'admin';
  let name = '';

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--teacher') role = 'teacher';
    else if (arg === '--admin') role = 'admin';
    else if (arg === '--name') {
      name = rest[index + 1] || '';
      index += 1;
    } else positional.push(arg);
  }

  return { positional, role, name };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  await models.init();

  if (command === '--list') {
    const all = await users.list();

    if (all.length === 0) {
      console.log('Учётных записей нет. Пока работает вход из .env (ADMIN_LOGIN / ADMIN_PASSWORD).');
      return;
    }

    console.log(`Учётных записей: ${all.length}`);
    for (const user of all) {
      const created = user.createdAt ? new Date(user.createdAt).toLocaleString('ru-RU') : '—';
      const role = user.role === 'admin' ? 'администратор' : 'преподаватель';
      const access = user.active ? 'доступ открыт' : 'ЗАБЛОКИРОВАН';
      console.log(`  ${user.login}  —  ${user.name}`);
      console.log(`      ${role}, ${access}   создан: ${created}`);
    }
    console.log(
      `\nХранилище: ${config.databaseEngine === 'sqlite' ? config.sqliteStorage : users.file}`
    );
    return;
  }

  if (command === '--add') {
    const { positional, role, name } = parseArgs(rest);
    const login = positional[0];
    const password = positional[1] !== undefined ? positional[1] : await readStdin();

    if (!login) {
      console.error('Не указан логин.');
      usage();
      process.exitCode = 1;
      return;
    }

    const result = await users.upsertByLogin(login, password, { role, name: name || login });
    console.log(
      result.created
        ? `Создана учётная запись «${result.login}» (${role === 'admin' ? 'администратор' : 'преподаватель'}).`
        : `Пароль учётной записи «${result.login}» обновлён.`
    );
    console.log('Войти: http://localhost:3000/login');
    return;
  }

  if (command === '--remove') {
    const login = rest[0];
    if (!login) {
      console.error('Не указан логин.');
      process.exitCode = 1;
      return;
    }

    const user = await users.getByLogin(login);
    if (!user) {
      console.log(`Учётной записи «${login}» нет.`);
      return;
    }

    // Связанные данные подчищаем так же, как это делает удаление из интерфейса,
    // иначе в карточках учеников и в занятиях останутся ссылки на несуществующего сотрудника.
    const planned = (await lessons.listByTeacher(user.id)).filter((lesson) => lesson.status === 'planned');
    if (planned.length > 0 && !process.argv.includes('--force')) {
      console.error(
        `У сотрудника «${user.name}» есть запланированные занятия: ${planned.length}.\n` +
          'Перенесите их на другого преподавателя или отмените в разделе «Расписание».\n' +
          'Если занятия тоже больше не нужны, повторите команду с флагом --force.'
      );
      process.exitCode = 1;
      return;
    }

    const detached = await students.detachTeacher(user.id);
    await notifications.removeForUser(user.id);
    await users.remove(user.id);

    console.log(`Учётная запись «${user.login}» удалена.`);
    if (detached > 0) console.log(`Учеников осталось без преподавателя: ${detached} — назначьте им нового.`);
    if (planned.length > 0) console.log(`Запланированных занятий осталось без изменений: ${planned.length}.`);

    if (await users.isEmpty()) {
      console.log('Учётных записей не осталось — вход снова работает по ADMIN_LOGIN / ADMIN_PASSWORD из .env.');
    }
    return;
  }

  console.error(`Неизвестная команда: ${command}`);
  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Ошибка: ${error.message}`);
  process.exitCode = 1;
});
