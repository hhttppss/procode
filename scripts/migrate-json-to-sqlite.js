'use strict';

/**
 * Разовый перенос данных из файлового хранилища (data/*.json) в SQLite (data/app.sqlite).
 *
 *   npm run migrate:sqlite
 *
 * Что делает: читает каждый data/<коллекция>.json напрямую с диска и записывает его
 * содержимое в соответствующую таблицу базы через ту же нормализацию, что и приложение
 * (normalize из моделей) — идентификаторы, даты и суммы приводятся к рабочему виду.
 *
 * Исходные JSON-файлы только читаются: скрипт ничего в них не пишет и не удаляет.
 * После успешного переноса их можно оставить как резервную копию — на движке sqlite
 * приложение в них не заглядывает.
 *
 * Скрипт разовый и не идемпотентный в смысле «дозаписи»: каждая коллекция базы
 * перезаписывается содержимым файла целиком. Повторный запуск просто вернёт базу
 * к состоянию файлов.
 *
 * Не запускайте параллельно с работающим сервером: перезапись коллекции целиком
 * может затереть изменения, которые сервер сделал в то же время. Остановите сервер,
 * перенесите данные, затем запустите сервер заново (по умолчанию уже на sqlite).
 */

// Движок фиксируется до config: переменная окружения перекрывает DATABASE_ENGINE из .env,
// и перенос всегда идёт именно в SQLite, каким бы ни был рабочий режим проекта.
process.env.DATABASE_ENGINE = 'sqlite';

// Config — первым: он выставляет process.env.TZ, а нормализация дат должна работать
// в том же поясе, в котором эти даты потом читает сервер.
const config = require('../server/config');

const fsp = require('fs/promises');
const path = require('path');

const db = require('../server/db');
// Побочный эффект нужен целиком: модули моделей объявляют все коллекции с их normalize.
require('../server/models');

const COLLECTIONS = [
  'applications',
  'audit',
  'expenses',
  'lessons',
  'notifications',
  'payments',
  'students',
  'users',
];

/** @returns {Array|null} записи файла либо null, если файла нет. */
async function readJsonFile(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Файл ${file} не содержит массив записей.`);
  }
  return parsed;
}

async function migrateCollection(name) {
  const store = db.collectionOf(name);

  // Таблица создаётся всегда, даже если переносить нечего: приложение ждёт её на месте.
  await store.init();

  // Путь строится напрямую от db.dataDir, а не берётся из store.file: на движке sqlite
  // store.file нарочно указывает на заведомо отсутствующий путь (см. legacyFileOf в
  // server/db.js) — это защита от того, чтобы легаси-миграция моделей (users.js,
  // applications.js) случайно не затёрла текущие данные бэкапом при обычном старте
  // сервера. Здесь же нам нужен именно реальный бэкап — он читается явно.
  const source = await readJsonFile(path.join(db.dataDir, `${name}.json`));
  if (source === null) {
    console.log(`  ${name.padEnd(14)} файла нет — пропускаю`);
    return { name, source: 0, stored: 0, skipped: true };
  }

  await store.replaceAll(source);

  // Сверка после записи: normalize отбраковывает записи, которые не удалось привести
  // к рабочему виду (вернул null). Молча потерять данные ученика — недопустимо.
  const stored = (await store.list()).length;
  if (stored !== source.length) {
    throw new Error(
      `Коллекция «${name}»: в файле ${source.length} записей, в базе оказалось ${stored}. ` +
        'Часть записей не прошла нормализацию — данные не перенесены полностью. ' +
        'Файлы data/*.json не изменены, база не годится к работе до выяснения причины.'
    );
  }

  console.log(`  ${name.padEnd(14)} ${String(source.length).padStart(5)} записей перенесено`);
  return { name, source: source.length, stored, skipped: false };
}

/**
 * Список COLLECTIONS ниже перечислен вручную и должен совпадать с тем, что модели
 * объявляют через db.collection(...). Если появится новая модель, а про перенос для неё
 * забудут — её данные молча не попадут в базу. Сверяем список с реестром движка сразу
 * после того, как require('../server/models') объявил все коллекции.
 */
function assertCollectionsListIsComplete() {
  const declared = new Set(db.collectionNames());
  const missing = [...declared].filter((name) => !COLLECTIONS.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `В моделях объявлены коллекции, которых нет в списке переноса: ${missing.join(', ')}. ` +
        'Добавьте их в COLLECTIONS в scripts/migrate-json-to-sqlite.js.'
    );
  }
}

async function main() {
  assertCollectionsListIsComplete();

  console.log('');
  console.log(`  Перенос данных в SQLite: ${config.sqliteStorage}`);
  console.log(`  Источник:                ${path.join(config.rootDir, 'data')}`);
  console.log('');

  const results = [];
  for (const name of COLLECTIONS) results.push(await migrateCollection(name));

  const moved = results.filter((item) => !item.skipped);
  const total = moved.reduce((sum, item) => sum + item.stored, 0);

  console.log('');
  console.log(`  Готово: ${total} записей в ${moved.length} коллекциях из ${COLLECTIONS.length}.`);
  console.log('  Исходные data/*.json не изменялись — оставьте их как резервную копию.');
  console.log('  Запуск сервера: npm start (DATABASE_ENGINE=sqlite по умолчанию).');
  console.log('');
}

main().catch((error) => {
  console.error('');
  console.error(`  Перенос не выполнен: ${error.message}`);
  console.error('');
  process.exitCode = 1;
});
