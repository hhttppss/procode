'use strict';

/**
 * Управление учётными записями менеджеров.
 *
 *   node scripts/manage-users.js --list
 *   node scripts/manage-users.js --add <логин> <пароль>       создать или сменить пароль
 *   node scripts/manage-users.js --remove <логин>
 *
 * Пароль можно не писать в командной строке — тогда скрипт прочитает его
 * из стандартного ввода:  echo "мойпароль" | node scripts/manage-users.js --add ivan
 * Это надёжнее: аргументы командной строки попадают в историю оболочки.
 */

const users = require('../server/users');

function usage() {
  console.log('Использование:');
  console.log('  node scripts/manage-users.js --list');
  console.log('  node scripts/manage-users.js --add <логин> <пароль>');
  console.log('  node scripts/manage-users.js --remove <логин>');
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

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === '--list') {
    const all = users.list();
    if (all.length === 0) {
      console.log('Учётных записей нет. Пока работает вход из .env (ADMIN_LOGIN / ADMIN_PASSWORD).');
      return;
    }
    console.log(`Учётных записей: ${all.length}`);
    for (const u of all) {
      const created = u.createdAt ? new Date(u.createdAt).toLocaleString('ru-RU') : '—';
      const updated = u.updatedAt ? new Date(u.updatedAt).toLocaleString('ru-RU') : '—';
      console.log(`  ${u.login}\n      создан: ${created}   пароль менялся: ${updated}`);
    }
    console.log(`\nФайл: ${users.usersFile}`);
    return;
  }

  if (command === '--add') {
    const login = rest[0];
    const password = rest[1] !== undefined ? rest[1] : await readStdin();

    if (!login) {
      console.error('Не указан логин.');
      usage();
      process.exitCode = 1;
      return;
    }

    const result = await users.upsert(login, password);
    console.log(
      result.created
        ? `Создана учётная запись «${result.login}».`
        : `Пароль учётной записи «${result.login}» обновлён.`
    );
    console.log('Войти: http://localhost:3000/admin');
    return;
  }

  if (command === '--remove') {
    const login = rest[0];
    if (!login) {
      console.error('Не указан логин.');
      process.exitCode = 1;
      return;
    }
    const removed = await users.remove(login);
    console.log(removed ? `Учётная запись «${login}» удалена.` : `Учётной записи «${login}» нет.`);
    if (removed && users.isEmpty()) {
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
