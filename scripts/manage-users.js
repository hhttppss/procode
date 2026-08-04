'use strict';

/**
 * Управление учётными записями сотрудников из командной строки.
 *
 *   node scripts/manage-users.js --list
 *   node scripts/manage-users.js --add <логин> <пароль> [--manager|--teacher] [--name "ФИО"]
 *   node scripts/manage-users.js --remove <логин> [--force]
 *
 * Без флага роли создаётся администратор. Роль можно задать и явно: --role <id>,
 * где id — одно из значений справочника ролей (server/domain/catalog.js).
 * Удаление отказывает, если у сотрудника есть запланированные занятия или он остался
 * единственным активным администратором; --force снимает обе проверки.
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

const access = require('../server/domain/access');
const catalog = require('../server/domain/catalog');
const db = require('../server/db');
const lessons = require('../server/models/lessons');
const models = require('../server/models');
const notifications = require('../server/models/notifications');
const students = require('../server/models/students');
const users = require('../server/models/users');

function usage() {
  console.log('Использование:');
  console.log('  node scripts/manage-users.js --list');
  console.log('  node scripts/manage-users.js --add <логин> <пароль> [--manager|--teacher] [--name "ФИО"]');
  console.log('  node scripts/manage-users.js --remove <логин> [--force]');
  console.log(`  Роли: ${catalog.ROLES.map((role) => `${role.id} — ${role.label.toLowerCase()}`).join(', ')}`);
}

/** Подпись роли из справочника: списки ролей нигде не дублируются. */
function roleLabel(role) {
  return catalog.labelOf(catalog.ROLES, role).toLowerCase();
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

/** Выделяет из аргументов флаги роли и --name, оставляя позиционные значения. */
function parseArgs(rest) {
  const positional = [];
  let role = 'admin';
  let name = '';

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--teacher') role = 'teacher';
    else if (arg === '--manager') role = 'manager';
    else if (arg === '--admin') role = 'admin';
    else if (arg === '--role') {
      // Явное указание роли: скрипт не придётся править, когда справочник пополнится.
      role = rest[index + 1] || '';
      index += 1;
    } else if (arg === '--name') {
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
      const role = roleLabel(user.role);
      const accessLabel = user.active ? 'доступ открыт' : 'ЗАБЛОКИРОВАН';
      console.log(`  ${user.login}  —  ${user.name}`);
      console.log(`      ${role}, ${accessLabel}   создан: ${created}`);
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

    if (!catalog.ROLE_IDS.includes(role)) {
      console.error(`Неизвестная роль «${role}». Допустимые: ${catalog.ROLE_IDS.join(', ')}.`);
      process.exitCode = 1;
      return;
    }

    const result = await users.upsertByLogin(login, password, { role, name: name || login });
    console.log(
      result.created
        ? `Создана учётная запись «${result.login}» (${roleLabel(role)}).`
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

    const force = process.argv.includes('--force');

    // Занятия читаются заранее, до транзакции: сама проверка идёт после проверки на
    // последнего администратора (порядок отказов тот же, что и в интерфейсе), но чтение
    // не должно разрывать связку «проверил администраторов → удалил». Риск гонки здесь
    // ниже: занятие, добавленное параллельно, не оставит школу без входа в систему.
    const planned = (await lessons.listByTeacher(user.id)).filter((lesson) => lesson.status === 'planned');

    // Та же защита, что и в интерфейсе (routes/api/teachers.js): без единого активного
    // администратора в систему станет некому войти. Запасной вход по ADMIN_LOGIN /
    // ADMIN_PASSWORD здесь не поможет — он включается, только когда не осталось вообще
    // ни одной учётной записи, а управляющие и преподаватели в базе остаются.
    //
    // Проверка и удаление идут одной транзакцией: скрипт запускают отдельным процессом
    // рядом с работающим сервером, и между раздельными вызовами кто-то успевал бы
    // заблокировать второго администратора через веб — каждая операция по отдельности
    // видела бы ещё живого коллегу, а в сумме активных администраторов не осталось бы.
    const result = await db.transaction(['users'], (tx) => {
      const record = tx.users.getById(user.id);
      if (!record) return { ok: false, reason: 'gone' };

      const lastAdmin = access.isLastActiveAdmin(tx.users.list(), record.id);
      if (lastAdmin && !force) return { ok: false, reason: 'last-admin', targetActive: record.active };
      if (planned.length > 0 && !force) return { ok: false, reason: 'planned' };

      tx.users.remove(record.id);
      return { ok: true, lastAdmin };
    });

    if (!result.ok) {
      if (result.reason === 'gone') {
        console.log(`Учётной записи «${login}» нет — её удалили, пока выполнялась команда.`);
        return;
      }

      if (result.reason === 'last-admin') {
        // Формулировка зависит от того, открыт ли доступ у самой удаляемой учётки:
        // заблокированный администратор «единственным активным» не является, но остаётся
        // последним, через кого вход в систему вообще можно вернуть.
        const reason = result.targetActive
          ? `«${user.name}» — единственный активный администратор, удалять его нельзя.`
          : `В системе не осталось ни одного активного администратора, а «${user.name}» — последняя ` +
            'учётная запись с ролью администратора: удалять её нельзя.';

        console.error(
          `${reason}\n` +
            'Сначала заведите другого: node scripts/manage-users.js --add <логин> <пароль>\n' +
            'Если вход в систему больше не нужен, повторите команду с флагом --force.'
        );
        process.exitCode = 1;
        return;
      }

      console.error(
        `У сотрудника «${user.name}» есть запланированные занятия: ${planned.length}.\n` +
          'Перенесите их на другого преподавателя или отмените в разделе «Расписание».\n' +
          'Если занятия тоже больше не нужны, повторите команду с флагом --force.'
      );
      process.exitCode = 1;
      return;
    }

    // Связанные данные подчищаем так же, как это делает удаление из интерфейса,
    // иначе в карточках учеников и в занятиях останутся ссылки на несуществующего сотрудника.
    const detached = await students.detachTeacher(user.id);
    await notifications.removeForUser(user.id);

    console.log(`Учётная запись «${user.login}» удалена.`);
    if (detached > 0) console.log(`Учеников осталось без преподавателя: ${detached} — назначьте им нового.`);
    if (planned.length > 0) console.log(`Запланированных занятий осталось без изменений: ${planned.length}.`);

    if (await users.isEmpty()) {
      console.log('Учётных записей не осталось — вход снова работает по ADMIN_LOGIN / ADMIN_PASSWORD из .env.');
    } else if (result.lastAdmin) {
      console.log(
        'Активных администраторов больше нет — войти в систему сейчас некому.\n' +
          'Заведите администратора: node scripts/manage-users.js --add <логин> <пароль>'
      );
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
