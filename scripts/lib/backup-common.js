'use strict';

/**
 * Общее для scripts/backup.js и scripts/restore.js: корень проекта, обход папки data/,
 * онлайн-снимок SQLite, осмотр базы и разбор аргументов командной строки.
 *
 * Вынесено в отдельный модуль, чтобы два скрипта не расходились в мелочах — например,
 * в списке того, что не попадает в бэкап: разойдись он, restore начал бы удалять файлы,
 * которых backup не сохранял.
 */

const fs = require('fs');
const path = require('path');

/**
 * Коллекции приложения. Список продублирован здесь намеренно: backup и restore не
 * подключают server/models (это подняло бы соединение с базой и разовые миграции ещё
 * до того, как мы решили, что с базой делать). Сверяется с server/models/*.js и
 * scripts/migrate-json-to-sqlite.js.
 */
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

/** Человеческие названия для отчёта о восстановлении. */
const COLLECTION_TITLES = {
  applications: 'Заявки',
  audit: 'Журнал действий',
  expenses: 'Расходы',
  lessons: 'Занятия',
  notifications: 'Уведомления',
  payments: 'Платежи',
  students: 'Ученики',
  users: 'Сотрудники',
};

const BACKUP_DIR_NAME = 'backups';
const MANIFEST_NAME = 'manifest.json';
const MANIFEST_FORMAT = 'procode-backup/1';
const DATA_PREFIX = 'data';
const LOCK_FILE_NAME = 'app.sqlite.lock';

const BACKUP_NAME_PATTERN = /^backup_\d{8}_\d{6}$/;

/**
 * npm 11 отдаёт скрипту позиционные аргументы как есть, но флаги вида --force
 * перехватывает себе (проверено: `npm run backup --force` до скрипта не доходит).
 * Поэтому флаги передаются после разделителя `--`.
 */
const NPM_FLAG_HINT = 'флаги передавайте после «--», например: npm run backup -- --force';

// ---------------------------------------------------------------- корень проекта

/**
 * Корень проекта. Пользователь просил считать его от текущей папки, поэтому первым
 * кандидатом идёт process.cwd(); если скрипт запустили из другого места (например,
 * из data/), берём папку над scripts/ — иначе бэкап ушёл бы не туда.
 */
function resolveProjectRoot() {
  const candidates = [process.cwd(), path.resolve(__dirname, '..', '..')];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json')) && fs.existsSync(path.join(candidate, 'scripts'))) {
      return { root: candidate, fromCwd: candidate === path.resolve(process.cwd()) };
    }
  }

  throw new Error(
    `В текущей папке (${process.cwd()}) нет package.json и scripts/ — это не корень проекта «ПроКод». ` +
      'Перейдите в папку проекта и повторите команду.'
  );
}

// ------------------------------------------------------------------ аргументы

/**
 * Разбор argv: позиционные значения отдельно, известные флаги — отдельно.
 * Неизвестный флаг — ошибка, а не молчаливое игнорирование: опечатка в «--kepp 5»
 * не должна выглядеть как успешно применённая настройка.
 *
 * @param {string[]} argv
 * @param {{booleans?: string[], values?: string[]}} spec
 */
function parseArgs(argv, spec = {}) {
  const booleans = spec.booleans || [];
  const values = spec.values || [];

  const positional = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const separator = arg.indexOf('=');
    const name = separator === -1 ? arg.slice(2) : arg.slice(2, separator);

    if (booleans.includes(name)) {
      options[name] = true;
      continue;
    }

    if (values.includes(name)) {
      const value = separator === -1 ? argv[index + 1] : arg.slice(separator + 1);
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Флаг --${name} требует значения.`);
      }
      if (separator === -1) index += 1;
      options[name] = value;
      continue;
    }

    throw new Error(`Неизвестный флаг «${arg}». Подсказка: ${NPM_FLAG_HINT}.`);
  }

  return { positional, options };
}

function parseNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, label = 'значение' } = {}) {
  if (value === undefined) return fallback;

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Некорректное ${label}: «${value}». Ожидается целое число от ${min} до ${max}.`);
  }
  return parsed;
}

// ------------------------------------------------------------------ форматирование

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}

/** Метка времени YYYYMMDD_HHMMSS в поясе процесса (config выставляет TZ школы). */
function makeStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// ------------------------------------------------------------------ файлы data/

/**
 * Что из data/ в бэкап не попадает.
 *
 * • app.sqlite.lock — наш собственный флаг блокировки; восстанавливать чужую
 *   блокировку из архива бессмысленно и вредно;
 * • .restore-staging-*, .rollback-* и прочие скрытые папки — рабочий мусор
 *   восстановления, данными не являются;
 * • *.tmp — недописанные файлы атомарной записи из server/db.js (writeFileAtomic).
 *
 * Файлы -wal и -shm отсеиваются отдельно, в backup.js: решение зависит от того,
 * удался ли онлайн-снимок базы.
 */
function isExcludedFromBackup(relativePath) {
  const parts = relativePath.split(path.sep);
  if (parts.some((part) => part.startsWith('.'))) return true;

  const name = parts[parts.length - 1];
  return name === LOCK_FILE_NAME || name.endsWith('.lock') || name.endsWith('.tmp');
}

/**
 * Рекурсивный обход папки.
 * @returns {{files: Array<{relative:string, absolute:string, size:number, mtime:Date}>, emptyDirs: string[]}}
 */
function walkTree(root, { exclude } = {}) {
  const files = [];
  const emptyDirs = [];

  function visit(directory, prefix) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    let kept = 0;

    for (const entry of entries) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      if (exclude && exclude(relative)) continue;

      const absolute = path.join(directory, entry.name);

      // Симлинки не разыменовываем: в data/ их быть не должно, а разыменование
      // увело бы бэкап за пределы папки.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        kept += 1;
        visit(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;

      const stat = fs.statSync(absolute);
      files.push({ relative, absolute, size: stat.size, mtime: stat.mtime });
      kept += 1;
    }

    if (kept === 0 && prefix) emptyDirs.push(prefix);
  }

  visit(root, '');
  return { files, emptyDirs };
}

function directorySize(root) {
  try {
    return walkTree(root).files.reduce((sum, file) => sum + file.size, 0);
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ SQLite

/**
 * Онлайн-снимок базы средствами SQLite.
 *
 * Почему не копирование файла: база работает в режиме WAL (server/db.js: journal_mode = WAL),
 * и большая часть свежих изменений физически лежит не в app.sqlite, а в app.sqlite-wal.
 * Скопировав только app.sqlite, мы получили бы базу на момент последней контрольной точки —
 * то есть бэкап без последних дней работы школы. db.backup() проходит базу страницами
 * с учётом WAL и отдаёт цельный, самодостаточный файл, которому -wal и -shm уже не нужны.
 *
 * @returns {Promise<{ok: boolean, pages?: number, reason?: string}>}
 */
async function snapshotSqlite(sourcePath, destPath) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (error) {
    return { ok: false, reason: `драйвер better-sqlite3 не загружается (${error.message})` };
  }

  let connection = null;
  try {
    // Открываем на чтение-запись, а не readonly: readonly-подключение к базе в режиме WAL
    // не может восстановить журнал после аварийного завершения сервера и просто откажет.
    connection = new Database(sourcePath, { fileMustExist: true });
    connection.pragma('busy_timeout = 10000');

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const result = await connection.backup(destPath);

    return { ok: true, pages: result ? result.totalPages : undefined };
  } catch (error) {
    return { ok: false, reason: error.message };
  } finally {
    if (connection) {
      try {
        connection.close();
      } catch (closeError) {
        // Драйвер мог закрыть соединение сам при ошибке backup — тогда close() бросает
        // «database connection is not open». Для результата операции это неважно.
        void closeError;
      }
    }
  }
}

/**
 * Спутники базы в режиме WAL. Подключение только для чтения заводит их при открытии,
 * но не удаляет при закрытии (для этого нужна запись) — а оставленный рядом со снимком
 * пустой -wal при следующем открытии базы будет принят за её журнал.
 */
const SQLITE_SIDECARS = ['-wal', '-shm'];

/**
 * Осмотр базы: целостность, внешние ключи, таблицы, количество записей и роли сотрудников.
 * Используется и как проверка бэкапа перед заменой данных, и как отчёт после неё.
 *
 * После себя ничего не оставляет: -wal и -shm, которых до вызова не было, удаляются.
 * Те, что были (запасной режим бэкапа копирует базу вместе с журналом), не трогаются —
 * в них лежат данные.
 *
 * @returns {{integrity: string[], foreignKeyIssues: number, tables: string[],
 *            counts: Record<string, number|null>, roles: Record<string, number>}}
 */
function inspectSqlite(sqlitePath) {
  const Database = require('better-sqlite3');

  const preexisting = new Set(
    SQLITE_SIDECARS.filter((suffix) => fs.existsSync(`${sqlitePath}${suffix}`))
  );

  const connection = new Database(sqlitePath, { readonly: true, fileMustExist: true });

  try {
    // integrity_check сверяет страницы, индексы и внутренние ссылки; на исправной базе
    // возвращает единственную строку 'ok'. Это и есть проверка «архив довёз базу целиком».
    const integrity = connection.pragma('integrity_check').map((row) => row.integrity_check);
    const foreignKeyIssues = connection.pragma('foreign_key_check').length;

    const tables = connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);

    const known = new Set(tables);
    const counts = {};
    for (const name of COLLECTIONS) {
      // Имя подставляется в SQL напрямую (параметризовать имя таблицы SQLite не умеет),
      // но берётся оно только из закрытого списка COLLECTIONS — не из ввода пользователя.
      counts[name] = known.has(name)
        ? connection.prepare(`SELECT COUNT(*) AS total FROM "${name}"`).get().total
        : null;
    }

    // Роль — это поле пользователя (см. server/models/users.js: отдельных таблиц под роли нет).
    // Документ лежит одним JSON в колонке data, поэтому считаем в JS, не полагаясь на наличие
    // расширения JSON1 в сборке драйвера.
    //
    // Список ролей намеренно не зашит: считаем то, что реально встретилось в базе. Иначе
    // добавление роли в справочник пришлось бы дублировать здесь, а старый бэкап,
    // снятый до её появления, отчёт бы молча потерял.
    const roles = {};
    if (known.has('users')) {
      for (const row of connection.prepare('SELECT data FROM "users"').all()) {
        let role = null;
        try {
          role = JSON.parse(row.data).role;
        } catch (error) {
          void error; // битую строку считаем «прочей», отдельно она видна в counts.users
        }
        const key = typeof role === 'string' && role !== '' ? role : 'other';
        roles[key] = (roles[key] || 0) + 1;
      }
    }

    return { integrity, foreignKeyIssues, tables, counts, roles };
  } finally {
    connection.close();

    for (const suffix of SQLITE_SIDECARS) {
      if (preexisting.has(suffix)) continue;
      try {
        fs.rmSync(`${sqlitePath}${suffix}`, { force: true });
      } catch (error) {
        // Файл может держать другой процесс (запущенный рядом сервер). Это не наш
        // временный мусор, значит и убирать его не нам — просто идём дальше.
        void error;
      }
    }
  }
}

/** Количество записей в data/<коллекция>.json — запасной отчёт для движка json. */
function inspectJsonFiles(directory) {
  const counts = {};
  for (const name of COLLECTIONS) {
    const file = path.join(directory, `${name}.json`);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      counts[name] = Array.isArray(parsed) ? parsed.length : null;
    } catch (error) {
      counts[name] = error.code === 'ENOENT' ? null : Number.NaN;
    }
  }
  return counts;
}

// ------------------------------------------------------------------ бэкапы

/** Существующие бэкапы в backups/, новые сверху. */
function listBackups(backupsDir) {
  let entries;
  try {
    entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const result = [];
  for (const entry of entries) {
    const base = entry.name.endsWith('.zip') ? entry.name.slice(0, -4) : entry.name;
    if (!BACKUP_NAME_PATTERN.test(base)) continue;

    const full = path.join(backupsDir, entry.name);

    // Список бэкапов чаще всего печатается в сообщении об ошибке. Если файл исчез между
    // readdir и stat (параллельная очистка), уронить справку об ошибке было бы обидно.
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }

    result.push({
      name: entry.name,
      path: full,
      isDirectory: entry.isDirectory(),
      size: entry.isDirectory() ? directorySize(full) : stat.size,
      mtime: stat.mtime,
    });
  }

  return result.sort((a, b) => b.name.localeCompare(a.name));
}

function printBackupList(backups, log = console.log) {
  if (backups.length === 0) {
    log('  Бэкапов пока нет. Создайте первый: npm run backup');
    return;
  }

  log('  Доступные бэкапы:');
  for (const item of backups) {
    log(
      `    ${item.name.padEnd(30)} ${formatBytes(item.size).padStart(10)}   ` +
        `${item.mtime.toLocaleString('ru-RU')}${item.isDirectory ? '   (папка)' : ''}`
    );
  }
}

module.exports = {
  BACKUP_DIR_NAME,
  BACKUP_NAME_PATTERN,
  COLLECTIONS,
  COLLECTION_TITLES,
  DATA_PREFIX,
  LOCK_FILE_NAME,
  MANIFEST_FORMAT,
  MANIFEST_NAME,
  NPM_FLAG_HINT,
  directorySize,
  formatBytes,
  inspectJsonFiles,
  inspectSqlite,
  isExcludedFromBackup,
  listBackups,
  makeStamp,
  parseArgs,
  parseNumber,
  printBackupList,
  resolveProjectRoot,
  snapshotSqlite,
  walkTree,
};
