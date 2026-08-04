'use strict';

/**
 * Полный бэкап рабочих данных школы — папки data/ целиком.
 *
 *   npm run backup                      — архив backups/backup_YYYYMMDD_HHMMSS.zip
 *   npm run backup -- --dir             — то же самое обычной папкой, без архива
 *   npm run backup -- --wait 60         — ждать освобождения блокировки до 60 секунд
 *   npm run backup -- --force           — снять чужую блокировку принудительно
 *   npm run backup -- --out D:\backups  — сложить бэкап в другую папку
 *
 * Флаги передаются после «--»: npm 11 перехватывает `--force` себе и до скрипта его
 * не доносит, а позиционные аргументы проходят как есть. Напрямую скрипт запускается
 * без разделителя: node scripts/backup.js --dir
 *
 * ЧТО ПОПАДАЕТ В АРХИВ
 *   manifest.json   — опись: когда, чем, сколько файлов, состояние базы на момент снимка;
 *   data/…          — всё содержимое папки data: JSON-коллекции, база SQLite,
 *                     карантинные копии повреждённых файлов и любые другие файлы.
 * Не попадают: файл блокировки, недописанные *.tmp и служебные скрытые папки
 * восстановления (см. isExcludedFromBackup в scripts/lib/backup-common.js).
 *
 * ПОЧЕМУ БАЗА СНИМАЕТСЯ, А НЕ КОПИРУЕТСЯ
 * База работает в режиме WAL (server/db.js: journal_mode = WAL): свежие изменения лежат
 * в app.sqlite-wal и переезжают в app.sqlite только на контрольной точке. На момент
 * написания этих строк app.sqlite весил 217 КБ, а app.sqlite-wal — 828 КБ: копия одного
 * app.sqlite потеряла бы большую часть данных. Поэтому база снимается онлайн-бэкапом
 * SQLite (db.backup) в отдельный файл, и в архив кладётся уже он — цельный и
 * самодостаточный. Файлы -wal и -shm в архив при этом НЕ кладутся намеренно: рядом
 * со снимком они бессмысленны, а приложенные к нему «чужие» -wal/-shm при восстановлении
 * были бы применены поверх базы и испортили бы её.
 * Если драйвер better-sqlite3 не загружается или база занята намертво, скрипт переходит
 * в запасной режим: копирует .sqlite вместе с -wal и -shm (все три файла вместе дают
 * консистентную картину) и предупреждает об этом.
 *
 * Бэкап можно снимать при работающем сервере: онлайн-снимок отдаёт согласованное
 * состояние базы, а JSON-файлы пишутся атомарно (временный файл + rename).
 *
 * Побочный эффект, о котором стоит знать: чтобы снять базу, скрипт открывает её и потом
 * закрывает. Если сервер в этот момент не работает, наше подключение оказывается
 * последним, и SQLite при закрытии переносит журнал в основной файл, а app.sqlite-wal
 * и app.sqlite-shm удаляет. Это штатная контрольная точка — ровно то же самое делает
 * корректно остановленный сервер; данные при этом не теряются, а app.sqlite подрастает
 * на объём журнала.
 *
 * Блокировка data/app.sqlite.lock рекомендательная: она разводит между собой backup
 * и restore, но сервер про неё не знает — см. шапку scripts/lib/lock.js.
 */

// Config — первым: он выставляет process.env.TZ, а метка времени в имени бэкапа
// должна считаться в том же поясе, в котором школа видит даты в интерфейсе.
const config = require('../server/config');

const fs = require('fs');
const os = require('os');
const path = require('path');

const common = require('./lib/backup-common');
const zip = require('./lib/zip');
const { acquireLock } = require('./lib/lock');

const ARG_SPEC = {
  booleans: ['dir', 'force', 'help'],
  values: ['wait', 'out'],
};

function usage() {
  console.log('');
  console.log('  Бэкап данных школы «ПроКод».');
  console.log('');
  console.log('    npm run backup');
  console.log('    npm run backup -- --dir            бэкап папкой, без архива');
  console.log('    npm run backup -- --wait 60        ждать освобождения блокировки, сек');
  console.log('    npm run backup -- --force          снять чужую блокировку принудительно');
  console.log('    npm run backup -- --out <папка>    другая папка назначения');
  console.log('');
  console.log(`  ${common.NPM_FLAG_HINT}.`);
  console.log('');
}

/**
 * Файлы баз SQLite в data/. Ищем по расширению, а не по config.sqliteStorage:
 * так бэкап одинаково работает и когда база одна, и когда рядом лежит копия,
 * и когда скрипт запущен над другой копией проекта.
 */
function findSqliteFiles(files) {
  return files.filter((file) => file.relative.toLowerCase().endsWith('.sqlite'));
}

/** Снимает все найденные базы во временную папку. @returns {Promise<Array<object>>} */
async function snapshotDatabases(sqliteFiles, tempDir) {
  const results = [];

  for (const file of sqliteFiles) {
    const target = path.join(tempDir, file.relative);
    const snapshot = await common.snapshotSqlite(file.absolute, target);

    if (snapshot.ok) {
      const size = fs.statSync(target).size;
      console.log(`    ${file.relative.padEnd(28)} онлайн-снимок, ${common.formatBytes(size)}`);
      results.push({ ...file, mode: 'online', snapshotPath: target, snapshotSize: size });
      continue;
    }

    console.warn(`  ⚠  Онлайн-снимок «${file.relative}» не сделан: ${snapshot.reason}`);
    console.warn('     Запасной режим: в архив идут .sqlite, -wal и -shm вместе.');
    console.warn('     Такой бэкап тоже пригоден для восстановления, но снят не в одной точке времени —');
    console.warn('     проверьте базу после восстановления и по возможности повторите бэкап.');

    results.push({ ...file, mode: 'raw', snapshotPath: null, reason: snapshot.reason });
  }

  return results;
}

/** Отчёт по снимку базы: доказательство, что WAL слился и данные на месте. */
function reportSnapshot(snapshotPath) {
  try {
    const report = common.inspectSqlite(snapshotPath);
    const total = Object.values(report.counts).reduce((sum, value) => sum + (value || 0), 0);
    const parts = common.COLLECTIONS.filter((name) => report.counts[name] !== null).map(
      (name) => `${name} ${report.counts[name]}`
    );

    console.log(`    записей в снимке: ${total} (${parts.join(', ')})`);
    if (report.integrity[0] !== 'ok') {
      console.warn(`  ⚠  integrity_check снимка вернул: ${report.integrity.join('; ')}`);
    }
    return report;
  } catch (error) {
    console.warn(`  ⚠  Не удалось прочитать снимок базы для отчёта: ${error.message}`);
    return null;
  }
}

function buildManifest({ stamp, entries, databases, root }) {
  return {
    format: common.MANIFEST_FORMAT,
    createdAt: new Date().toISOString(),
    stamp,
    hostname: os.hostname(),
    node: process.version,
    timezone: config.timezone,
    databaseEngine: config.databaseEngine,
    projectRoot: root,
    databases: databases.map((item) => ({
      file: item.relative.split(path.sep).join('/'),
      mode: item.mode,
      reason: item.reason || undefined,
      counts: item.counts || undefined,
    })),
    files: entries.map((entry) => ({ name: entry.name, size: entry.size })),
    totals: {
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    },
  };
}

/** Пишет ZIP. @returns {{entries: Array, bytes: number}} */
function writeZipBackup(target, plan, manifestFor) {
  const writer = zip.createZipWriter(target);
  const written = [];

  try {
    for (const item of plan.files) {
      let info;
      try {
        info = writer.addFile(`${common.DATA_PREFIX}/${item.archiveName}`, item.sourcePath, item.mtime);
      } catch (error) {
        // Файл мог исчезнуть после обхода папки: рядом работает сервер, и он, например,
        // убрал карантинную копию. Это не повод терять весь бэкап.
        if (error.code !== 'ENOENT') throw error;
        console.warn(`  ⚠  ${item.archiveName} исчез во время упаковки — пропущен.`);
        continue;
      }

      written.push(info);
      console.log(
        `    ${info.name.padEnd(34)} ${common.formatBytes(info.size).padStart(10)} → ` +
          `${common.formatBytes(info.compressedSize)}`
      );
    }

    for (const dir of plan.emptyDirs) {
      writer.addDirectory(`${common.DATA_PREFIX}/${dir}`);
    }

    // Манифест дописывается последним: в нём перечислены реально попавшие в архив
    // файлы с их фактическими размерами, а не то, что мы планировали положить.
    const manifest = manifestFor(written);
    writer.addBuffer(common.MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = writer.close();
    return { ...result, manifest };
  } catch (error) {
    writer.abort();
    fs.rmSync(target, { force: true });
    throw error;
  }
}

/** Пишет бэкап обычной папкой. Полезно, когда архив негде распаковать. */
function writeDirBackup(target, plan, manifestFor) {
  if (fs.existsSync(target)) {
    throw new Error(`Папка ${target} уже существует — бэкап отменён.`);
  }

  const written = [];
  try {
    fs.mkdirSync(path.join(target, common.DATA_PREFIX), { recursive: true });

    for (const item of plan.files) {
      const destination = path.join(target, common.DATA_PREFIX, item.archiveName);
      fs.mkdirSync(path.dirname(destination), { recursive: true });

      try {
        fs.copyFileSync(item.sourcePath, destination);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        console.warn(`  ⚠  ${item.archiveName} исчез во время копирования — пропущен.`);
        continue;
      }

      const size = fs.statSync(destination).size;
      const name = `${common.DATA_PREFIX}/${item.archiveName.split(path.sep).join('/')}`;
      written.push({ name, size, compressedSize: size });
      console.log(`    ${name.padEnd(34)} ${common.formatBytes(size).padStart(10)}`);
    }

    for (const dir of plan.emptyDirs) {
      fs.mkdirSync(path.join(target, common.DATA_PREFIX, dir), { recursive: true });
    }

    const manifest = manifestFor(written);
    fs.writeFileSync(path.join(target, common.MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    return {
      entries: written.length + 1,
      bytes: written.reduce((sum, item) => sum + item.size, 0),
      manifest,
    };
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const { positional, options } = common.parseArgs(process.argv.slice(2), ARG_SPEC);

  if (options.help) {
    usage();
    return;
  }
  if (positional.length > 0) {
    throw new Error(
      `Лишний аргумент «${positional[0]}»: backup не принимает позиционных значений. ${common.NPM_FLAG_HINT}.`
    );
  }

  const waitSeconds = common.parseNumber(options.wait, 10, { max: 3600, label: 'ожидание --wait' });

  const { root, fromCwd } = common.resolveProjectRoot();
  const dataDir = path.join(root, 'data');
  const backupsDir = options.out ? path.resolve(process.cwd(), options.out) : path.join(root, common.BACKUP_DIR_NAME);

  if (!fs.existsSync(dataDir)) {
    throw new Error(`Папки с данными нет: ${dataDir}. Бэкапить нечего.`);
  }

  // Складывать бэкап внутрь data/ нельзя: имя архива не начинается с точки, поэтому
  // следующий restore посчитает его обычным файлом данных и удалит при замене. Ошибка
  // ручного запуска (--out data) не должна стоить пользователю всех бэкапов.
  const resolvedBackups = path.resolve(backupsDir);
  if (resolvedBackups === path.resolve(dataDir) || resolvedBackups.startsWith(path.resolve(dataDir) + path.sep)) {
    throw new Error(
      `Папка для бэкапов (${resolvedBackups}) находится внутри ${dataDir}. ` +
        'Бэкап нельзя хранить среди данных, которые он резервирует — укажите --out вне data/.'
    );
  }

  console.log('');
  console.log('  Бэкап данных «ПроКод»');
  console.log(`  Проект:   ${root}${fromCwd ? '' : '  (взят не из текущей папки — см. resolveProjectRoot)'}`);
  console.log(`  Источник: ${dataDir}`);
  console.log(`  Хранилище бэкапов: ${backupsDir}`);
  console.log('');

  // База вне data/ в бэкап не попадёт: архив описывает именно эту папку, и восстановление
  // кладёт файлы обратно в неё же. Молча оставить пользователя без базы нельзя.
  if (config.rootDir === root && !config.sqliteStorage.startsWith(dataDir + path.sep)) {
    console.warn(`  ⚠  SQLITE_STORAGE указывает вне data/: ${config.sqliteStorage}`);
    console.warn('     Эта база в бэкап НЕ войдёт — сохраните её отдельно.');
    console.warn('');
  }

  const stamp = common.makeStamp();
  const backupName = `backup_${stamp}`;
  const target = options.dir ? path.join(backupsDir, backupName) : path.join(backupsDir, `${backupName}.zip`);

  if (fs.existsSync(target)) {
    throw new Error(`Бэкап ${target} уже существует. Подождите секунду и повторите команду.`);
  }

  const lock = await acquireLock(path.join(dataDir, common.LOCK_FILE_NAME), {
    operation: 'backup',
    waitSeconds,
    force: Boolean(options.force),
  });

  const tempDir = path.join(backupsDir, `.snapshot_${stamp}`);

  try {
    fs.mkdirSync(backupsDir, { recursive: true });

    const initialScan = common.walkTree(dataDir, { exclude: common.isExcludedFromBackup });
    if (initialScan.files.length === 0) {
      throw new Error(`В ${dataDir} нет файлов для бэкапа.`);
    }

    console.log('  Снимок базы данных:');
    const sqliteFiles = findSqliteFiles(initialScan.files);
    if (sqliteFiles.length === 0) {
      console.log('    баз SQLite в data/ не найдено — бэкапятся только файлы');
    }

    const databases = await snapshotDatabases(sqliteFiles, tempDir);

    // Список файлов пересобираем ПОСЛЕ снимка: закрытие подключения переносит журнал
    // в основной файл и удаляет app.sqlite-wal / -shm. По списку, собранному до этого,
    // упаковка искала бы уже несуществующие файлы — особенно в запасном режиме,
    // где журналы должны были попасть в архив.
    const scan = common.walkTree(dataDir, { exclude: common.isExcludedFromBackup });

    // Подменяем источник для баз и выбрасываем журналы тех баз, что снялись онлайн:
    // рядом со снимком старый -wal — это чужой журнал, применение которого поверх
    // снимка при восстановлении испортило бы базу.
    const replacements = new Map();
    const skip = new Set();

    for (const database of databases) {
      if (database.mode !== 'online') continue;
      replacements.set(database.relative, database.snapshotPath);
      skip.add(`${database.relative}-wal`);
      skip.add(`${database.relative}-shm`);
      database.counts = (reportSnapshot(database.snapshotPath) || {}).counts;
    }

    const plan = {
      files: scan.files
        .filter((file) => !skip.has(file.relative))
        .map((file) => ({
          archiveName: file.relative.split(path.sep).join('/'),
          sourcePath: replacements.get(file.relative) || file.absolute,
          mtime: file.mtime,
        })),
      emptyDirs: scan.emptyDirs.map((dir) => dir.split(path.sep).join('/')),
    };

    console.log('');
    console.log(options.dir ? '  Копирование файлов:' : '  Упаковка файлов:');

    const manifestFor = (entries) => buildManifest({ stamp, entries, databases, root });
    const result = options.dir
      ? writeDirBackup(target, plan, manifestFor)
      : writeZipBackup(target, plan, manifestFor);

    // Самопроверка: перечитываем только что записанный архив и сверяем CRC каждой
    // записи. Битый бэкап, о котором узнаёшь в день аварии, хуже отсутствующего.
    if (!options.dir) {
      console.log('');
      console.log('  Проверка архива…');
      const verified = zip.verifyZip(target);
      if (verified.entries !== result.entries) {
        throw new Error(
          `После записи в архиве ${verified.entries} записей вместо ${result.entries} — архив не годится.`
        );
      }
      console.log(`    записей: ${verified.entries}, контрольные суммы совпали`);
    }

    const finalSize = options.dir ? common.directorySize(target) : fs.statSync(target).size;

    console.log('');
    console.log('  ✓ Бэкап создан');
    console.log(`    ${target}`);
    console.log(
      `    файлов: ${result.manifest.totals.files}, исходный объём: ` +
        `${common.formatBytes(result.manifest.totals.bytes)}, на диске: ${common.formatBytes(finalSize)}`
    );
    console.log('');
    console.log(`  Восстановление: npm run restore ${path.basename(target)}`);
    console.log('');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    lock.release();
  }
}

main().catch((error) => {
  console.error('');
  console.error(`  Бэкап не создан: ${error.message}`);
  console.error('');
  process.exitCode = 1;
});
