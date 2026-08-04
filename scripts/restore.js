'use strict';

/**
 * Восстановление данных школы из бэкапа, созданного scripts/backup.js.
 *
 *   npm run restore backup_20250801_123456.zip
 *   npm run restore backup_20250801_123456          — расширение можно не писать
 *   npm run restore D:\archive\backup_20250801_123456.zip
 *   npm run restore backup_20250801_123456 -- --prune --keep 5
 *
 * Позиционное имя бэкапа npm 11 передаёт скрипту как есть, а флаги (--prune, --keep,
 * --force, --wait, --ignore-engine) перехватывает себе — их пишите после «--». Напрямую
 * разделитель не нужен: node scripts/restore.js backup_20250801_123456 --prune --keep 5
 *
 * ПЕРЕД ЗАПУСКОМ ОСТАНОВИТЕ СЕРВЕР. Блокировка data/app.sqlite.lock рекомендательная:
 * она разводит между собой backup и restore, но работающий сервер про неё не знает,
 * держит открытый дескриптор базы и продолжает в неё писать. Подмена файла базы под
 * работающим сервером приводит к порче данных — этого не предотвратит никакой флаг.
 *
 * ПОРЯДОК ДЕЙСТВИЙ (оригиналы трогаются только на шаге 5)
 *   1. Найти бэкап. Нет — понятная ошибка со списком доступных.
 *   2. Распаковать во временную папку data/.restore-staging-<метка>/. CRC каждой
 *      записи архива сверяется при распаковке: битый архив падает здесь, до замены.
 *   3. Проверить распакованное: PRAGMA integrity_check и foreign_key_check на базе,
 *      наличие ожидаемых таблиц, разбор каждого JSON с проверкой, что это массив.
 *   4. Сверить движок хранения бэкапа с текущим DATABASE_ENGINE. Данные «чужого»
 *      движка сервер просто не читает, поэтому такое восстановление отклоняется
 *      здесь — до замены. Осознанный обход: --ignore-engine.
 *   5. Сохранить текущие данные в откатную копию, заменить содержимое data/,
 *      при любой ошибке — автоматический откат.
 *   6. Контрольное чтение восстановленной базы и отчёт по коллекциям.
 *
 * Откатная копия остаётся на диске как backups/prerestore_<метка>/ — это состояние
 * данных ровно перед восстановлением. Удаляйте её вручную, когда убедитесь, что всё
 * на месте: автоматическая очистка (--prune) её не трогает.
 *
 * ЗАМЕНА ИДЁТ ЦЕЛИКОМ: всё содержимое data/, кроме файла блокировки и служебных
 * скрытых папок, удаляется и заменяется содержимым бэкапа. Это осознанно — иначе
 * рядом с восстановленной базой остались бы её старые -wal и -shm, и SQLite применил бы
 * старый журнал поверх восстановленных данных. Ничего не теряется: всё, что было,
 * лежит в откатной копии.
 */

// Config — первым: он выставляет process.env.TZ, метки времени в отчёте и в имени
// откатной копии должны быть в поясе школы. Оттуда же берётся текущий движок хранения:
// с ним сверяется движок, на котором снят бэкап (checkStorageEngine).
const config = require('../server/config');

const fs = require('fs');
const path = require('path');

const common = require('./lib/backup-common');
const zip = require('./lib/zip');
const { acquireLock } = require('./lib/lock');

const ARG_SPEC = {
  booleans: ['force', 'prune', 'help', 'ignore-engine'],
  values: ['wait', 'keep'],
};

const DEFAULT_KEEP = 5;

/**
 * Движки хранения, которые понимает приложение. Список повторяет DATABASE_ENGINES из
 * server/config.js по той же причине, что и COLLECTIONS в backup-common.js: скрипт не
 * должен подключать модули приложения. Нужен он только для подсказки «поставьте
 * DATABASE_ENGINE=…»: незнакомое значение в описи бэкапа мы всё равно покажем как есть.
 */
const KNOWN_ENGINES = ['sqlite', 'json'];

function usage() {
  console.log('');
  console.log('  Восстановление данных школы «ПроКод» из бэкапа.');
  console.log('');
  console.log('    npm run restore <имя-бэкапа>');
  console.log('    npm run restore backup_20250801_123456.zip');
  console.log('    npm run restore backup_20250801_123456 -- --prune --keep 5');
  console.log('');
  console.log('    --wait <сек>     ждать освобождения блокировки (по умолчанию 10)');
  console.log('    --force          снять чужую блокировку принудительно');
  console.log('    --prune          удалить старые бэкапы после успешного восстановления');
  console.log(`    --keep <N>       сколько бэкапов оставить при --prune (по умолчанию ${DEFAULT_KEEP})`);
  console.log('    --ignore-engine  восстановить бэкап, снятый на другом DATABASE_ENGINE');
  console.log('');
  console.log(`  ${common.NPM_FLAG_HINT}.`);
  console.log('');
}

/** Ищет бэкап: как указано, с добавленным .zip, и то же самое внутри backups/. */
function resolveBackupPath(name, backupsDir) {
  const cleaned = name.replace(/[\\/]+$/, '');
  const candidates = [
    path.resolve(process.cwd(), cleaned),
    path.resolve(process.cwd(), `${cleaned}.zip`),
    path.join(backupsDir, cleaned),
    path.join(backupsDir, `${cleaned}.zip`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------- распаковка

/** Кладёт бэкап в staging. Оригиналы в data/ на этом шаге не затрагиваются. */
function unpackToStaging(source, stagingDir) {
  fs.mkdirSync(stagingDir, { recursive: true });

  if (fs.statSync(source).isDirectory()) {
    console.log('    источник — папка, копирую как есть');
    fs.cpSync(source, stagingDir, { recursive: true });
    const scan = common.walkTree(stagingDir);
    console.log(`    файлов: ${scan.files.length}`);
    return { files: scan.files.length, checked: false };
  }

  let count = 0;
  const extracted = zip.extractZip(source, stagingDir, () => {
    count += 1;
  });

  console.log(`    распаковано записей: ${count}, контрольные суммы сверены`);
  return { files: extracted.length, checked: true };
}

// ----------------------------------------------------------------- проверка

/**
 * Проверка распакованного бэкапа ДО замены оригиналов. Любая неудача здесь — отказ
 * восстанавливать: рабочие данные остаются нетронутыми.
 */
function validateStaging(stagingDir) {
  const dataDir = path.join(stagingDir, common.DATA_PREFIX);

  const manifestPath = path.join(stagingDir, common.MANIFEST_NAME);
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`Опись бэкапа (${common.MANIFEST_NAME}) не читается: ${error.message}`);
    }
    if (typeof manifest.format !== 'string' || !manifest.format.startsWith('procode-backup/')) {
      throw new Error(
        `Это не бэкап «ПроКод»: в описи format = «${manifest.format}», ожидается ${common.MANIFEST_FORMAT}.`
      );
    }
    console.log(`    опись: создан ${new Date(manifest.createdAt).toLocaleString('ru-RU')}, файлов ${manifest.totals.files}`);
  } else {
    console.warn(`  ⚠  В бэкапе нет ${common.MANIFEST_NAME} — проверяю только по содержимому.`);
  }

  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new Error(
      `В бэкапе нет папки «${common.DATA_PREFIX}/» — восстанавливать нечего. ` +
        'Похоже, это архив другого происхождения.'
    );
  }

  const scan = common.walkTree(dataDir);
  if (scan.files.length === 0) {
    throw new Error(`Папка «${common.DATA_PREFIX}/» в бэкапе пуста — восстанавливать нечего.`);
  }

  // --- базы SQLite
  //
  // Строгость разная. База, которую backup снял онлайн-бэкапом (mode: online в описи),
  // на момент бэкапа была заведомо исправна — если она не открывается сейчас, бэкап
  // испорчен, и восстанавливать его нельзя. А файл .sqlite, который и при бэкапе не
  // открывался (mode: raw), — это уже сломанные данные пользователя; он попал в архив
  // «как есть», и отказываться из-за него восстанавливать всё остальное неправильно.
  const snapshotted = manifest
    ? new Set((manifest.databases || []).filter((item) => item.mode === 'online').map((item) => item.file))
    : null;

  // Все .sqlite-файлы бэкапа, включая нерабочие — не путать с `usable` ниже
  // (только исправные) и с полем `databases` результата (тоже только исправные).
  const allSqliteFiles = scan.files.filter((file) => file.relative.toLowerCase().endsWith('.sqlite'));
  const usable = [];
  // Базы, которые мы сознательно восстанавливаем «как есть», несмотря на их состояние.
  // Список нужен финальной проверке: она не должна объявлять восстановление неудачным
  // из-за дефекта, о котором мы уже предупредили и который приняли.
  const tolerated = [];

  for (const database of allSqliteFiles) {
    const archiveName = database.relative.split(path.sep).join('/');
    const mustBeValid = snapshotted === null || snapshotted.has(archiveName);

    let report;
    try {
      report = common.inspectSqlite(database.absolute);
    } catch (error) {
      if (mustBeValid) {
        throw new Error(`База «${archiveName}» из бэкапа не открывается: ${error.message}`);
      }
      console.warn(`  ⚠  Файл «${archiveName}» не открывается как база (${error.message}).`);
      console.warn('     Он и в бэкап попал таким — восстанавливается как есть.');
      tolerated.push(archiveName);
      continue;
    }

    // mustBeValid действует и здесь, а не только на открытии файла: база может
    // открыться, но не пройти integrity_check — для raw-копии это ожидаемо (её сняли
    // без чекпоинта), и отказывать из-за неё во всём восстановлении нельзя.
    if (report.integrity.length !== 1 || report.integrity[0] !== 'ok') {
      if (mustBeValid) {
        throw new Error(
          `База «${archiveName}» повреждена, PRAGMA integrity_check: ${report.integrity.join('; ')}`
        );
      }
      console.warn(`  ⚠  База «${archiveName}» не проходит integrity_check: ${report.integrity.join('; ')}`);
      console.warn('     Она и в бэкап попала такой — восстанавливается как есть, проверьте её после.');
      tolerated.push(archiveName);
      continue;
    }
    if (report.foreignKeyIssues > 0) {
      if (mustBeValid) {
        throw new Error(
          `В базе «${archiveName}» ${report.foreignKeyIssues} нарушений внешних ключей (foreign_key_check).`
        );
      }
      console.warn(
        `  ⚠  В базе «${archiveName}» ${report.foreignKeyIssues} нарушений внешних ключей — восстанавливается как есть.`
      );
      tolerated.push(archiveName);
      continue;
    }

    const present = common.COLLECTIONS.filter((name) => report.counts[name] !== null);
    if (present.length === 0) {
      console.warn(`  ⚠  В базе «${archiveName}» нет ни одной таблицы приложения — восстанавливается как есть.`);
      continue;
    }

    const missing = common.COLLECTIONS.filter((name) => report.counts[name] === null);
    if (missing.length > 0) {
      console.warn(
        `  ⚠  В базе «${archiveName}» нет таблиц: ${missing.join(', ')} — приложение создаст их пустыми при старте.`
      );
    }

    console.log(
      `    ${archiveName.padEnd(24)} integrity_check: ok, таблиц ${report.tables.length}, ` +
        `записей ${present.reduce((sum, name) => sum + report.counts[name], 0)}`
    );
    usable.push({ file: archiveName, report });
  }

  // --- JSON-коллекции
  const jsonFiles = scan.files.filter((file) => file.relative.toLowerCase().endsWith('.json'));
  let jsonRecords = 0;
  // Коллекции движка json — только файлы вида data/<коллекция>.json в корне data/.
  // Посторонний JSON рядом (карантинная копия, чей-то экспорт) хранилищем не является
  // и не должен убеждать проверку движка, что данные для json в бэкапе есть.
  const jsonCollections = jsonFiles
    .filter((file) => common.COLLECTIONS.includes(path.basename(file.relative, '.json')))
    .filter((file) => !file.relative.includes(path.sep))
    .map((file) => file.relative);

  for (const file of jsonFiles) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file.absolute, 'utf8'));
    } catch (error) {
      throw new Error(`Файл «${file.relative}» из бэкапа не разбирается как JSON: ${error.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Файл «${file.relative}» из бэкапа не содержит массив записей.`);
    }
    jsonRecords += parsed.length;
  }

  if (jsonFiles.length > 0) {
    console.log(`    JSON-файлов: ${jsonFiles.length}, записей в них: ${jsonRecords}`);
  }

  // Последний рубеж: восстанавливать имеет смысл, только если в бэкапе есть хотя бы
  // один источник данных приложения — исправная база с его таблицами или JSON-коллекции.
  if (usable.length === 0 && jsonFiles.length === 0) {
    throw new Error(
      'В бэкапе нет ни исправной базы с таблицами приложения, ни JSON-коллекций — восстанавливать нечего.'
    );
  }

  return {
    manifest,
    databases: usable,
    tolerated,
    files: scan.files.length,
    // Все .sqlite из бэкапа, а не только исправные: для проверки движка важно само
    // наличие файла базы — «база есть, но битая» и «базы нет вовсе» это разные разговоры.
    sqliteFiles: allSqliteFiles.map((file) => file.relative.split(path.sep).join('/')),
    jsonCollections,
  };
}

// ------------------------------------------------------------ движок хранения

/*
 * Сверка движка хранения бэкапа с текущим DATABASE_ENGINE — до необратимых операций.
 *
 * Зачем. Движки не читают данные друг друга (server/db.js): sqlite берёт записи только
 * из config.sqliteStorage, json — только из data/<коллекция>.json. Замена в data/ идёт
 * целиком, поэтому восстановление json-бэкапа при DATABASE_ENGINE=sqlite удаляет рабочую
 * базу, кладёт вместо неё файлы, которых сервер не видит, и отчитывается об успехе:
 * на следующем npm start SQLite создаёт новую пустую базу. Ровно то, ради чего
 * восстановление и запускали, оно и уничтожает — молча.
 *
 * Обратная совместимость. Бэкапы, снятые до появления поля databaseEngine в описи (и
 * бэкапы вообще без описи), пропускать нельзя: именно они и остались у школ после
 * перехода json → sqlite, то есть проверка была бы отключена ровно в том сценарии, для
 * которого написана. Поэтому для них движок определяется по содержимому — по тем самым
 * файлам, которые сервер будет искать. Это не эвристика «на глазок»: вопрос «прочитает
 * ли текущий движок восстановленное» решается именно наличием этих файлов, а опись лишь
 * отвечает на него быстрее и точнее.
 */

/**
 * Что именно случится, если восстановить «чужие» данные. Отдельными строками, а не одной:
 * текст показывается и в ошибке, и в предупреждении --ignore-engine — с разными отступами.
 */
function engineConsequence(current) {
  if (current === 'sqlite') {
    return [
      'Движок sqlite читает только базу, файлы data/*.json он игнорирует.',
      'Замена данных идёт целиком: рабочая база будет удалена, а на её месте окажется то,',
      'чего сервер не видит — при следующем npm start SQLite создаст новую пустую базу.',
    ];
  }
  if (current === 'json') {
    return [
      'Движок json читает только data/<коллекция>.json, базу app.sqlite он не открывает.',
      'После восстановления в платформе будут пустые списки или устаревшие данные.',
    ];
  }
  return [`Движок «${current}» эти данные не прочитает.`];
}

/**
 * Ошибка отказа: причина, последствия и выходы. Формат — как у lock.js: продолжение
 * с отступом в два пробела, перечисление — маркерами.
 */
function engineError({ headline, current, suggested, backupName }) {
  const lines = [headline, ...engineConsequence(current).map((line) => `  ${line}`), '  Что делать:'];

  if (suggested && suggested !== current && KNOWN_ENGINES.includes(suggested)) {
    lines.push(`    • вернуть проект на движок бэкапа: DATABASE_ENGINE=${suggested} в .env, затем повторить команду;`);
    if (suggested === 'json' && current === 'sqlite') {
      lines.push('      перенести восстановленные данные обратно в базу поможет npm run migrate:sqlite');
      lines.push('      (после переноса верните DATABASE_ENGINE=sqlite);');
    }
  }

  lines.push('    • либо восстановить как есть, приняв последствия:');
  lines.push(`      npm run restore ${backupName} -- --ignore-engine`);
  lines.push('      Флаг отключает только эту проверку, данные он не конвертирует.');

  return new Error(lines.join('\n'));
}

/** Имя файла базы внутри data/ так, как оно выглядит в бэкапе, либо null — если база вне data/. */
function expectedSqliteName(dataDir) {
  const relative = path.relative(dataDir, config.sqliteStorage);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/**
 * Причина отказа по содержимому бэкапа — для описей без databaseEngine.
 * @returns {{headline: string, suggested: string|null}|null} null — препятствий нет
 */
function findContentProblem(validation, dataDir, current) {
  const hasJson = validation.jsonCollections.length > 0;
  const hasSqlite = validation.sqliteFiles.length > 0;

  if (current === 'sqlite') {
    const expected = expectedSqliteName(dataDir);
    if (expected === null) {
      // База лежит вне data/ (SQLITE_STORAGE), значит замена содержимого data/ её и не
      // затронет: сценарий «восстановление стёрло рабочую базу» здесь невозможен, а по
      // содержимому бэкапа судить не о чем — базы в нём быть и не должно.
      console.warn(`  ⚠  База настроена вне data/ (${config.sqliteStorage}) — восстановление её не затрагивает.`);
      console.warn('     Проверить бэкап по содержимому нельзя; сервер продолжит работать с текущей базой.');
      return { skipped: true };
    }
    if (validation.sqliteFiles.includes(expected)) return null;

    return {
      headline: hasSqlite
        ? `В бэкапе нет базы «${expected}», которую читает сервер (SQLITE_STORAGE), ` +
          `есть только: ${validation.sqliteFiles.join(', ')}.`
        : `В бэкапе нет базы «${expected}» — похоже, он снят на движке json (в нём только data/*.json).`,
      suggested: hasJson ? 'json' : null,
    };
  }

  if (current === 'json') {
    if (hasJson) {
      if (hasSqlite) {
        console.warn(`  ⚠  В бэкапе есть база (${validation.sqliteFiles.join(', ')}), но движок сейчас json.`);
        console.warn('     Будут прочитаны только data/*.json — если школа работала на sqlite,');
        console.warn('     эти файлы могут быть устаревшими. Сверьте цифры в отчёте ниже.');
      }
      return null;
    }
    return {
      headline: 'В бэкапе нет ни одного файла коллекции data/<имя>.json — движку json читать нечего.',
      suggested: hasSqlite ? 'sqlite' : null,
    };
  }

  return null;
}

/**
 * @param {object} validation результат validateStaging
 * @param {{dataDir: string, backupName: string, ignore: boolean}} options
 * @returns {boolean} true — несовпадение есть, но его обошли флагом --ignore-engine
 */
function checkStorageEngine(validation, { dataDir, backupName, ignore }) {
  const current = config.databaseEngine;
  const raw = validation.manifest ? validation.manifest.databaseEngine : undefined;
  const declared = typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toLowerCase() : null;

  let problem = null;

  if (declared === null) {
    console.log('    в описи бэкапа движок не указан (бэкап старого формата) — сужу по содержимому');
    const result = findContentProblem(validation, dataDir, current);
    if (result && result.skipped) {
      // findContentProblem уже объяснил(а), почему проверка невозможна — печатать
      // «содержимое подходит» здесь было бы неверно: содержимое не проверялось.
    } else if (result) {
      problem = result;
    } else {
      console.log(`    содержимое бэкапа движку ${current} подходит`);
    }
  } else if (declared === current) {
    console.log(`    бэкап снят на движке ${declared}, проект работает на ${current} — совпадает`);
  } else {
    problem = {
      headline: `Бэкап снят на движке хранения «${declared}», а проект работает на «${current}» (DATABASE_ENGINE в .env).`,
      suggested: declared,
    };
  }

  if (!problem) return false;

  if (ignore) {
    console.warn(`  ⚠  ${problem.headline}`);
    for (const line of engineConsequence(current)) console.warn(`     ${line}`);
    console.warn('     Проверка отключена флагом --ignore-engine — продолжаю по вашему решению.');
    console.warn('     Прежнее состояние data/ останется в backups/prerestore_* — не удаляйте его.');
    return true;
  }

  throw engineError({ ...problem, current, backupName });
}

// ------------------------------------------------------------------ замена

/**
 * Содержимое data/, которое участвует в замене. Файл блокировки исключён (он наш,
 * прямо сейчас), скрытые папки — тоже: это staging и откатные копии этого же запуска.
 */
function replaceableEntries(dataDir) {
  return fs
    .readdirSync(dataDir)
    .filter((name) => name !== common.LOCK_FILE_NAME && !name.startsWith('.'));
}

function removeEntries(dataDir, names) {
  for (const name of names) {
    fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  }
}

function copyEntries(sourceDir, targetDir, names) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of names) {
    fs.cpSync(path.join(sourceDir, name), path.join(targetDir, name), { recursive: true });
  }
}

/**
 * Возврат data/ к состоянию откатной копии.
 *
 * Порядок «сначала вернуть, потом убрать лишнее», а не «сначала очистить, потом
 * вернуть»: если на очистке что-то не удалится (файл держит открытым другой процесс —
 * на Windows это обычное дело), данные уже будут на месте, а разбираться останется
 * только с мусором.
 *
 * @returns {string[]} записи, которые вернуть не удалось; пустой массив — откат полный
 */
function rollbackFromCopy(dataDir, rollbackDir) {
  const original = fs.readdirSync(rollbackDir);
  const originalNames = new Set(original);
  const failures = [];

  for (const name of original) {
    try {
      fs.cpSync(path.join(rollbackDir, name), path.join(dataDir, name), { recursive: true });
    } catch (error) {
      // Копия не легла — но, возможно, оригинал и не удалялся: тогда всё в порядке.
      if (!fs.existsSync(path.join(dataDir, name))) failures.push(`${name}: ${error.message}`);
    }
  }

  for (const name of replaceableEntries(dataDir)) {
    if (originalNames.has(name)) continue;
    try {
      fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
    } catch (error) {
      console.error(`     Не удалось убрать «${name}» из data/: ${error.message}. Удалите файл вручную.`);
    }
  }

  return failures;
}

/**
 * Замена содержимого data/ данными из staging с автоматическим откатом.
 *
 * Откатная копия делается копированием, а не переносом: при переносе неудача на
 * середине оставила бы data/ полупустой, и откатывать было бы уже нечем.
 */
function replaceData(dataDir, stagingDataDir, rollbackDir) {
  const current = replaceableEntries(dataDir);

  console.log(`    откатная копия: ${rollbackDir}`);
  copyEntries(dataDir, rollbackDir, current);

  const incoming = fs.readdirSync(stagingDataDir);

  try {
    // Сначала полностью убираем старое. Это единственный способ гарантированно
    // избавиться от старых app.sqlite-wal и app.sqlite-shm: оставь мы их рядом
    // с восстановленной базой, SQLite при первом же открытии применил бы старый
    // журнал поверх восстановленных данных и получилась бы смесь двух состояний.
    removeEntries(dataDir, current);

    for (const name of incoming) {
      const source = path.join(stagingDataDir, name);
      const destination = path.join(dataDir, name);
      try {
        fs.renameSync(source, destination);
      } catch (error) {
        // Сейчас staging лежит внутри data/, то есть заведомо на одном томе с ней,
        // и эта ветка недостижима. Оставлена защитой на случай, если staging когда-нибудь
        // переедет (например, в системный temp): тогда rename начнёт падать с EXDEV,
        // и лучше молча скопировать, чем оборвать восстановление на середине.
        if (error.code !== 'EXDEV') throw error;
        fs.cpSync(source, destination, { recursive: true });
      }
    }

    console.log(`    заменено записей в data/: ${incoming.length}`);
    return { removed: current.length, restored: incoming.length };
  } catch (error) {
    console.error('');
    console.error(`  ⚠  Ошибка при замене данных: ${error.message}`);
    console.error('     Откатываю data/ к состоянию до восстановления…');

    let failures;
    try {
      failures = rollbackFromCopy(dataDir, rollbackDir);
    } catch (rollbackError) {
      failures = [rollbackError.message];
    }

    if (failures.length === 0) {
      console.error('     Откат выполнен: данные вернулись в исходное состояние.');
    } else {
      // Худший случай: не удалось ни заменить, ни откатить. Молчать здесь нельзя —
      // пользователь должен узнать, где лежит единственная целая копия.
      console.error('     ОТКАТ НЕ ПОЛНЫЙ, не вернулись:');
      for (const failure of failures) console.error(`       • ${failure}`);
      console.error(`     Ваши данные до восстановления целиком лежат в ${rollbackDir} —`);
      console.error('     скопируйте их в data/ вручную и не запускайте сервер до этого.');
    }

    throw error;
  }
}

// ------------------------------------------------------------------- отчёт

/**
 * Подписи ролей во множественном числе. Список повторяет server/domain/catalog.js,
 * но связью не является: скрипт восстановления должен работать и с бэкапом, снятым
 * версией с другим набором ролей, — незнакомая роль печатается своим идентификатором.
 */
const ROLE_TITLES = {
  admin: 'администраторов',
  manager: 'управляющих',
  teacher: 'преподавателей',
  other: 'прочих',
};

/** «администраторов: 1, управляющих: 2» — нули пропускаем, чтобы строка не пухла. */
function describeRoles(roles) {
  const known = Object.keys(ROLE_TITLES).filter((role) => roles[role] > 0);
  const unknown = Object.keys(roles)
    .filter((role) => !ROLE_TITLES[role] && roles[role] > 0)
    .sort();

  return [...known, ...unknown].map((role) => `${ROLE_TITLES[role] || role}: ${roles[role]}`).join(', ');
}

function printCounts(title, counts, roles) {
  console.log(`  ${title}`);
  for (const name of common.COLLECTIONS) {
    const value = counts[name];
    const shown = value === null || value === undefined ? '—' : Number.isNaN(value) ? 'ошибка чтения' : String(value);

    let suffix = '';
    if (name === 'users' && roles) {
      const parts = describeRoles(roles);
      if (parts) suffix = `   (${parts})`;
    }
    console.log(`    ${common.COLLECTION_TITLES[name].padEnd(18)} ${shown.padStart(6)}${suffix}`);
  }
}

/** Контрольное чтение уже восстановленных данных — «своими глазами», а не по манифесту. */
function verifyRestored(dataDir, tolerated = []) {
  const scan = common.walkTree(dataDir, { exclude: common.isExcludedFromBackup });

  for (const file of scan.files) {
    if (!file.relative.toLowerCase().endsWith('.sqlite')) continue;

    let report;
    try {
      report = common.inspectSqlite(file.absolute);
    } catch (error) {
      // О таком файле уже предупредили на этапе проверки — ищем дальше.
      void error;
      continue;
    }

    // Отчёт делаем по той базе, в которой действительно лежат данные приложения:
    // рядом может лежать посторонний .sqlite.
    if (common.COLLECTIONS.every((name) => report.counts[name] === null)) continue;

    if (report.integrity[0] !== 'ok') {
      // Если база и в бэкапе была такой, мы это уже показали и приняли решение
      // восстанавливать её как есть. Объявлять теперь всё восстановление неудачным
      // нельзя: файлы уже заменены, и данные из бэкапа лежат на месте.
      if (!tolerated.includes(file.relative.split(path.sep).join('/'))) {
        throw new Error(`База после восстановления не проходит integrity_check: ${report.integrity.join('; ')}`);
      }
      console.warn(`  ⚠  База ${file.relative} не проходит integrity_check: ${report.integrity.join('; ')}`);
      console.warn('     Она пришла такой из бэкапа. Данные ниже прочитаны, но базу стоит проверить.');
    }

    printCounts(`Данные в базе ${file.relative}:`, report.counts, report.roles);
    return;
  }

  // Базы в data/ нет. Для движка json это норма, для sqlite — нет: сюда можно попасть
  // только через --ignore-engine либо когда база настроена вне data/ (SQLITE_STORAGE).
  // В обоих случаях цифры ниже — это НЕ то, что увидит сервер, и говорить об этом надо прямо.
  if (config.databaseEngine === 'json') {
    console.log('  Базы приложения в data/ нет — читаю JSON-коллекции (движок json).');
  } else {
    console.log(
      `  Базы приложения в data/ нет — читаю JSON-коллекции, но движок ${config.databaseEngine} их не читает:`
    );
    console.log('  цифры ниже показывают содержимое файлов, а не то, что откроется в платформе.');
  }
  printCounts('Данные в JSON-файлах:', common.inspectJsonFiles(dataDir), null);
}

// ------------------------------------------------------------------ очистка

/** Свободное имя: base, base-2, base-3… Ничего не перезаписываем. */
function uniquePath(base) {
  if (!fs.existsSync(base)) return base;

  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Не удалось подобрать свободное имя рядом с ${base}.`);
}

/**
 * Уводит откатную копию из data/ в backups/prerestore_<метка>/.
 *
 * Внутри data/ ей оставаться нельзя: следующий бэкап её не возьмёт (скрытые папки
 * исключены), а место она займёт навсегда. Вызывается на любом исходе — и после
 * успешной замены, и после отката: в обоих случаях это состояние данных «как было».
 */
function preserveRollback(rollbackDir, backupsDir, stamp) {
  if (!fs.existsSync(rollbackDir)) return;

  try {
    fs.mkdirSync(backupsDir, { recursive: true });
    // Метка времени с точностью до секунды: два восстановления подряд дают одно имя,
    // а переименование папки поверх существующей на Windows падает с EPERM.
    const target = uniquePath(path.join(backupsDir, `prerestore_${stamp}`));
    try {
      fs.renameSync(rollbackDir, target);
    } catch (error) {
      // EXDEV: data/ смонтирована отдельным томом от корня проекта — обычное дело
      // в контейнерах и на VPS. Без запасного пути откатная копия осталась бы скрытой
      // папкой внутри data/: её не видят ни бэкап (скрытые папки исключены), ни очистка,
      // и она тихо занимала бы место в самом ценном каталоге.
      if (error.code !== 'EXDEV') throw error;
      fs.cpSync(rollbackDir, target, { recursive: true });
      fs.rmSync(rollbackDir, { recursive: true, force: true });
    }
    console.log(`  Состояние данных до восстановления сохранено: ${target}`);
    console.log('  Удалите эту папку вручную, когда убедитесь, что всё на месте (--prune её не трогает).');
  } catch (error) {
    console.warn(`  ⚠  Не удалось перенести откатную копию в backups/: ${error.message}`);
    console.warn(`     Она осталась в ${rollbackDir} — перенесите или удалите её вручную.`);
  }
}

/**
 * Удаляет старые бэкапы, оставляя keep самых свежих. Только по явному флагу.
 *
 * Бэкап, из которого только что восстановились, не удаляется никогда, даже если он
 * старше лимита: иначе после отката к давнему состоянию исчез бы единственный
 * источник, из которого это состояние можно повторить. Откатные копии
 * (prerestore_*) под очистку не подпадают — listBackups их не видит.
 */
function pruneBackups(backupsDir, keep, protectedPath) {
  const backups = common.listBackups(backupsDir);
  const survivors = new Set(backups.slice(0, keep).map((item) => path.resolve(item.path)));
  survivors.add(path.resolve(protectedPath));

  const doomed = backups.filter((item) => !survivors.has(path.resolve(item.path)));

  if (doomed.length === 0) {
    console.log(`  Очистка: бэкапов ${backups.length}, лимит ${keep} — удалять нечего.`);
    return;
  }

  console.log(`  Очистка: удаляю ${doomed.length}, останется ${backups.length - doomed.length} (лимит ${keep}):`);
  for (const item of doomed) {
    fs.rmSync(item.path, { recursive: true, force: true });
    console.log(`    удалён ${item.name} (${common.formatBytes(item.size)})`);
  }
  console.log('    восстановленный бэкап и откатные копии prerestore_* не удаляются.');
}

// -------------------------------------------------------------------- main

// Замена состоялась: файлы в data/ уже из бэкапа. Нужно итоговому обработчику ошибок —
// он не должен уверять, что данные не тронуты, если они тронуты.
let dataReplaced = false;

async function main() {
  const { positional, options } = common.parseArgs(process.argv.slice(2), ARG_SPEC);

  if (options.help) {
    usage();
    return;
  }

  const { root, fromCwd } = common.resolveProjectRoot();
  const dataDir = path.join(root, 'data');
  const backupsDir = path.join(root, common.BACKUP_DIR_NAME);

  if (positional.length === 0) {
    console.error('');
    console.error('  Не указано имя бэкапа.');
    console.error('    npm run restore backup_20250801_123456.zip');
    console.error('');
    common.printBackupList(common.listBackups(backupsDir), console.error);
    console.error('');
    process.exitCode = 1;
    return;
  }
  if (positional.length > 1) {
    throw new Error(`Лишний аргумент «${positional[1]}». Бэкап указывается один. ${common.NPM_FLAG_HINT}.`);
  }

  const waitSeconds = common.parseNumber(options.wait, 10, { max: 3600, label: 'ожидание --wait' });
  const keep = common.parseNumber(options.keep, DEFAULT_KEEP, { min: 1, max: 1000, label: 'значение --keep' });
  const shouldPrune = Boolean(options.prune) || options.keep !== undefined;

  const source = resolveBackupPath(positional[0], backupsDir);
  if (!source) {
    console.error('');
    console.error(`  Бэкап «${positional[0]}» не найден.`);
    console.error(`  Искал в текущей папке (${process.cwd()}) и в ${backupsDir}.`);
    console.error('');
    common.printBackupList(common.listBackups(backupsDir), console.error);
    console.error('');
    process.exitCode = 1;
    return;
  }

  // Бэкап внутри самой data/ восстанавливать нельзя: замена начинается с очистки папки,
  // и источник исчезнет прямо посреди операции.
  if (path.resolve(source).startsWith(path.resolve(dataDir) + path.sep)) {
    throw new Error(
      `Бэкап лежит внутри ${dataDir} — восстанавливать из него нельзя. Перенесите файл в ${backupsDir}.`
    );
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const sourceSize = fs.statSync(source).isDirectory() ? common.directorySize(source) : fs.statSync(source).size;

  console.log('');
  console.log('  Восстановление данных «ПроКод»');
  console.log(`  Проект:  ${root}${fromCwd ? '' : '  (взят не из текущей папки — см. resolveProjectRoot)'}`);
  console.log(`  Бэкап:   ${source} (${common.formatBytes(sourceSize)})`);
  console.log(`  Цель:    ${dataDir}`);
  console.log('');
  console.log('  ⚠  Сервер должен быть остановлен: подмена файла базы под работающим');
  console.log('     процессом портит данные. Текущее состояние data/ будет сохранено.');
  console.log('');

  const lock = await acquireLock(path.join(dataDir, common.LOCK_FILE_NAME), {
    operation: 'restore',
    waitSeconds,
    force: Boolean(options.force),
  });

  const stamp = common.makeStamp();
  const stagingDir = path.join(dataDir, `.restore-staging-${stamp}`);
  const rollbackDir = path.join(dataDir, `.rollback-${stamp}`);

  try {
    console.log('  1/5  Распаковка во временную папку (оригиналы не тронуты)');
    unpackToStaging(source, stagingDir);

    console.log('');
    console.log('  2/5  Проверка содержимого бэкапа');
    const validation = validateStaging(stagingDir);

    // Последняя проверка перед необратимым: дальше data/ очищается.
    console.log('');
    console.log('  3/5  Движок хранения');
    const engineBypassed = checkStorageEngine(validation, {
      dataDir,
      backupName: path.basename(source),
      ignore: Boolean(options['ignore-engine']),
    });

    console.log('');
    console.log('  4/5  Замена данных');
    replaceData(dataDir, path.join(stagingDir, common.DATA_PREFIX), rollbackDir);
    dataReplaced = true;

    console.log('');
    console.log('  5/5  Контрольное чтение восстановленных данных');
    verifyRestored(dataDir, validation.tolerated);

    // Уводим откатную копию сразу, чтобы сообщение о ней попало в отчёт до итога.
    // Повторный вызов в finally после этого ничего не делает — папки уже нет.
    console.log('');
    preserveRollback(rollbackDir, backupsDir, stamp);

    if (shouldPrune) {
      console.log('');
      pruneBackups(backupsDir, keep, source);
    }

    console.log('');
    if (engineBypassed) {
      // Файлы на месте, но сервер их не прочитает. Бодрое «✓ завершено» здесь было бы
      // тем же самым обманом, от которого защищает проверка, — только за флагом.
      console.log('  ✓ Файлы из бэкапа восстановлены, но движок хранения не совпадает');
      console.log(`    Проверка отключена флагом --ignore-engine: сервер на движке ${config.databaseEngine}`);
      console.log('    этих данных не увидит. НЕ запускайте сервер, пока не приведёте в соответствие');
      console.log('    данные и DATABASE_ENGINE в .env — иначе хранилище будет создано заново, пустым.');
      console.log('    Прежнее состояние data/ лежит в backups/prerestore_* (путь указан выше).');
    } else {
      console.log('  ✓ Восстановление завершено');
      console.log('    Запустите сервер: npm start');
    }
    console.log('');
  } finally {
    // Staging — чистый временный мусор: всё ценное из него уже переехало в data/.
    fs.rmSync(stagingDir, { recursive: true, force: true });
    // А откатная копия ценна всегда — её не удаляем, а уводим в backups/.
    preserveRollback(rollbackDir, backupsDir, stamp);
    lock.release();
  }
}

/**
 * Проверка движка хранения — чистые функции без обращения к диску и без состояния.
 * Экспортируются только ради tests/restore-engine.test.js: она защищает от восстановления,
 * которое молча уничтожает данные, и должна проверяться автоматически, а не «на глаз».
 * Всё остальное — работа со staging, заменой и откатом (replaceData, rollbackFromCopy,
 * preserveRollback) — автотестами не покрыто: это проверялось только вручную, реальными
 * прогонами при разработке checkStorageEngine (см. историю задачи). Самая необратимая часть
 * скрипта остаётся без регрессионной защиты — кандидат на отдельный e2e-тест позже.
 */
module.exports = {
  checkStorageEngine,
  findContentProblem,
  expectedSqliteName,
  engineConsequence,
  engineError,
};

// Восстановление запускается только при прямом вызове скрипта: подключение файла
// через require не должно ничего делать с данными (иначе тест, подключивший его
// ради функций выше, начал бы настоящее восстановление).
if (require.main === module) {
  main().catch((error) => {
    console.error('');
    console.error(`  Восстановление не выполнено: ${error.message}`);

    if (dataReplaced) {
      // Замена прошла, споткнулись уже на контрольном чтении. Данные в data/ — из бэкапа,
      // и говорить «ничего не изменилось» здесь было бы прямой ложью.
      console.error('  ВНИМАНИЕ: файлы в data/ УЖЕ заменены данными из бэкапа — ошибка возникла на проверке после замены.');
      console.error('  Прежнее состояние данных сохранено в backups/prerestore_* (путь указан выше).');
    } else {
      // Все проверки идут до замены, поэтому здесь data/ действительно не тронута.
      // Если замена начиналась и сорвалась, откат уже отработал и отчитался сам.
      console.error('  Рабочие данные в data/ не изменены — если замена уже начиналась, об её итоге сказано выше.');
    }
    console.error('');
    process.exitCode = 1;
  });
}
