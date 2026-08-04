'use strict';

/**
 * scripts/restore.js — сверка движка хранения бэкапа с текущим DATABASE_ENGINE.
 *
 * Это защита от восстановления, которое отчитывается об успехе и молча уничтожает данные:
 * замена содержимого data/ идёт целиком, поэтому json-бэкап при DATABASE_ENGINE=sqlite
 * стирает рабочую базу и кладёт вместо неё файлы, которых сервер не читает.
 * Проверяется как случай с описью (manifest.databaseEngine), так и старые бэкапы без неё,
 * где движок определяется по содержимому.
 *
 * Тесты синхронные и без await: они подменяют config.databaseEngine и console на время
 * одного вызова, а значит не должны чередоваться с соседними тестами.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../server/config');
const restore = require('../scripts/restore');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'procode-restore-'));
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const original = { engine: config.databaseEngine, storage: config.sqliteStorage };

after(() => {
  config.databaseEngine = original.engine;
  config.sqliteStorage = original.storage;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** Текущее состояние проекта: движок и путь к базе, как их видит config. */
function currentEngine(engine, storage = path.join(DATA_DIR, 'app.sqlite')) {
  config.databaseEngine = engine;
  config.sqliteStorage = storage;
}

/**
 * Результат validateStaging в объёме, который читает проверка движка.
 * @param {{engine?: string|undefined, manifest?: boolean, sqlite?: string[], json?: string[]}} options
 */
function staging({ engine, manifest = true, sqlite = [], json = [] }) {
  return {
    manifest: manifest ? { format: 'procode-backup/1', createdAt: '2025-08-01T10:00:00.000Z', databaseEngine: engine } : null,
    databases: [],
    tolerated: [],
    files: sqlite.length + json.length,
    sqliteFiles: sqlite,
    jsonCollections: json,
  };
}

/** Выполняет fn с перехваченным выводом. @returns {{value: any, error: Error|null, output: string}} */
function capture(fn) {
  const lines = [];
  const write = (...args) => lines.push(args.map(String).join(' '));
  const console_ = { log: console.log, warn: console.warn, error: console.error };

  console.log = write;
  console.warn = write;
  console.error = write;

  try {
    return { value: fn(), error: null, output: lines.join('\n') };
  } catch (error) {
    return { value: null, error, output: lines.join('\n') };
  } finally {
    Object.assign(console, console_);
  }
}

/** Прогон проверки: сообщения — такая же часть поведения, как и сам отказ. */
function run(validation, { ignore = false, backupName = 'backup_20250801_123456.zip' } = {}) {
  const result = capture(() => restore.checkStorageEngine(validation, { dataDir: DATA_DIR, backupName, ignore }));
  return { bypassed: result.error ? null : result.value, error: result.error, output: result.output };
}

// ------------------------------------------------------------- expectedSqliteName

test('expectedSqliteName: имя базы внутри data/ как оно выглядит в бэкапе', () => {
  currentEngine('sqlite', path.join(DATA_DIR, 'app.sqlite'));
  assert.equal(restore.expectedSqliteName(DATA_DIR), 'app.sqlite');

  currentEngine('sqlite', path.join(DATA_DIR, 'db', 'school.sqlite'));
  assert.equal(restore.expectedSqliteName(DATA_DIR), 'db/school.sqlite', 'разделитель в архиве всегда «/»');

  // База вынесена за data/ (SQLITE_STORAGE): замена содержимого data/ её не касается.
  currentEngine('sqlite', path.join(ROOT, 'elsewhere', 'app.sqlite'));
  assert.equal(restore.expectedSqliteName(DATA_DIR), null);
});

// --------------------------------------------------- опись с databaseEngine

test('движок бэкапа совпадает с текущим — препятствий нет', () => {
  currentEngine('sqlite');
  const result = run(staging({ engine: 'sqlite', sqlite: ['app.sqlite'] }));

  assert.equal(result.error, null);
  assert.equal(result.bypassed, false);
  assert.match(result.output, /бэкап снят на движке sqlite, проект работает на sqlite — совпадает/);
});

test('регистр и пробелы в описи движок не меняют', () => {
  currentEngine('json');
  const result = run(staging({ engine: '  JSON  ', json: ['students.json'] }));

  assert.equal(result.error, null);
  assert.equal(result.bypassed, false);
  assert.match(result.output, /совпадает/);
});

test('json-бэкап при движке sqlite отклоняется с объяснением последствий', () => {
  currentEngine('sqlite');
  const result = run(staging({ engine: 'json', json: ['students.json', 'users.json'] }));

  assert.ok(result.error, 'восстановление обязано остановиться до замены данных');
  const message = result.error.message;

  assert.match(message, /Бэкап снят на движке хранения «json», а проект работает на «sqlite»/);
  assert.match(message, /DATABASE_ENGINE/);
  assert.match(message, /рабочая база будет удалена/, 'пользователь должен понимать, чем это кончится');
  assert.match(message, /DATABASE_ENGINE=json в \.env/, 'подсказан движок из описи бэкапа');
  assert.match(message, /npm run migrate:sqlite/, 'для json → sqlite подсказан перенос данных');
  assert.match(message, /npm run restore backup_20250801_123456\.zip -- --ignore-engine/);
});

test('sqlite-бэкап при движке json отклоняется, но без подсказки про миграцию', () => {
  currentEngine('json');
  const result = run(staging({ engine: 'sqlite', sqlite: ['app.sqlite'] }));

  assert.ok(result.error);
  assert.match(result.error.message, /«sqlite».*«json»/);
  assert.match(result.error.message, /базу app\.sqlite он не открывает/);
  assert.match(result.error.message, /DATABASE_ENGINE=sqlite в \.env/);
  assert.doesNotMatch(result.error.message, /migrate:sqlite/, 'обратного переноса sqlite → json у проекта нет');
});

test('--ignore-engine пропускает несовпадение, но громко предупреждает', () => {
  currentEngine('sqlite');
  const result = run(staging({ engine: 'json', json: ['students.json'] }), { ignore: true });

  assert.equal(result.error, null);
  assert.equal(result.bypassed, true, 'вызывающий код должен узнать, что проверка обойдена');
  assert.match(result.output, /Проверка отключена флагом --ignore-engine/);
  assert.match(result.output, /рабочая база будет удалена/);
  assert.match(result.output, /backups\/prerestore_\*/, 'обещание сохранить прежнее состояние');
});

// ------------------------------------------- опись без databaseEngine (старый формат)

test('старый бэкап без поля databaseEngine: содержимое подходит движку', () => {
  currentEngine('sqlite');
  const result = run(staging({ engine: undefined, sqlite: ['app.sqlite'], json: ['students.json'] }));

  assert.equal(result.error, null);
  assert.equal(result.bypassed, false);
  assert.match(result.output, /движок не указан \(бэкап старого формата\) — сужу по содержимому/);
  assert.match(result.output, /содержимое бэкапа движку sqlite подходит/);
});

test('старый бэкап без базы при движке sqlite распознаётся как json-бэкап', () => {
  currentEngine('sqlite');
  const result = run(staging({ engine: undefined, json: ['students.json', 'users.json'] }));

  assert.ok(result.error, 'иначе восстановление стёрло бы рабочую базу');
  assert.match(result.error.message, /В бэкапе нет базы «app\.sqlite»/);
  assert.match(result.error.message, /похоже, он снят на движке json/);
  assert.match(result.error.message, /DATABASE_ENGINE=json в \.env/, 'движок подсказан по содержимому');
});

test('бэкап без описи вовсе проверяется так же, по содержимому', () => {
  currentEngine('sqlite');
  const result = run(staging({ manifest: false, json: ['students.json'] }));

  assert.ok(result.error);
  assert.match(result.error.message, /В бэкапе нет базы «app\.sqlite»/);
});

test('в бэкапе чужая база, а нужной нет — отказ с перечислением найденного', () => {
  currentEngine('sqlite');
  const result = run(staging({ engine: undefined, sqlite: ['old/legacy.sqlite'] }));

  assert.ok(result.error);
  assert.match(result.error.message, /нет базы «app\.sqlite», которую читает сервер \(SQLITE_STORAGE\)/);
  assert.match(result.error.message, /есть только: old\/legacy\.sqlite/);
  assert.doesNotMatch(result.error.message, /DATABASE_ENGINE=json/, 'json-коллекций в бэкапе нет — советовать json нечего');
});

test('старый бэкап без json-коллекций при движке json распознаётся как sqlite-бэкап', () => {
  currentEngine('json');
  const result = run(staging({ engine: undefined, sqlite: ['app.sqlite'] }));

  assert.ok(result.error, 'движку json читать в таком бэкапе нечего');
  assert.match(result.error.message, /нет ни одного файла коллекции data\/<имя>\.json/);
  assert.match(result.error.message, /DATABASE_ENGINE=sqlite в \.env/);
  assert.match(result.error.message, /--ignore-engine/);
});

test('движок json, в бэкапе есть и json, и база — работаем, но предупреждаем об устаревших данных', () => {
  currentEngine('json');
  const result = run(staging({ engine: undefined, sqlite: ['app.sqlite'], json: ['students.json'] }));

  assert.equal(result.error, null);
  assert.equal(result.bypassed, false);
  assert.match(result.output, /В бэкапе есть база \(app\.sqlite\), но движок сейчас json/);
  assert.match(result.output, /могут быть устаревшими/);
});

test('база вне data/: проверка по содержимому невозможна и об этом сказано прямо', () => {
  const outside = path.join(ROOT, 'elsewhere', 'app.sqlite');
  currentEngine('sqlite', outside);

  const probe = capture(() => restore.findContentProblem(staging({ json: ['students.json'] }), DATA_DIR, 'sqlite'));
  assert.deepEqual(probe.value, { skipped: true });
  assert.match(probe.output, /Проверить бэкап по содержимому нельзя/);

  const result = run(staging({ engine: undefined, json: ['students.json'] }));
  assert.equal(result.error, null, 'восстановление data/ рабочую базу не затрагивает — отказывать не в чем');
  assert.equal(result.bypassed, false);
  assert.match(result.output, /База настроена вне data\//);
  assert.doesNotMatch(result.output, /содержимое бэкапа движку sqlite подходит/, 'содержимое не проверялось — так и надо писать');
});

// ------------------------------------------------------------------ тексты

test('findContentProblem возвращает null, когда препятствий нет', () => {
  currentEngine('sqlite');
  const check = (validation, engine) => capture(() => restore.findContentProblem(validation, DATA_DIR, engine)).value;

  assert.equal(check(staging({ sqlite: ['app.sqlite'] }), 'sqlite'), null);
  assert.equal(check(staging({ json: ['students.json'] }), 'json'), null);
  assert.equal(
    check(staging({ json: ['students.json'] }), 'неизвестный'),
    null,
    'о незнакомом движке судить нечем — препятствий не выдумываем'
  );
});

test('engineConsequence объясняет последствия для каждого движка', () => {
  assert.match(restore.engineConsequence('sqlite').join(' '), /файлы data\/\*\.json он игнорирует/);
  assert.match(restore.engineConsequence('json').join(' '), /базу app\.sqlite он не открывает/);
  assert.deepEqual(restore.engineConsequence('mongodb'), ['Движок «mongodb» эти данные не прочитает.']);
});

test('engineError: заголовок, последствия и оба выхода в одном сообщении', () => {
  const error = restore.engineError({
    headline: 'Заголовок проблемы.',
    current: 'sqlite',
    suggested: 'unknown-engine',
    backupName: 'backup_20250801_123456.zip',
  });

  assert.ok(error instanceof Error);
  const lines = error.message.split('\n');

  assert.equal(lines[0], 'Заголовок проблемы.');
  assert.match(error.message, /  Что делать:/);
  assert.doesNotMatch(error.message, /DATABASE_ENGINE=unknown-engine/, 'советовать неизвестный движок нельзя');
  assert.match(error.message, /npm run restore backup_20250801_123456\.zip -- --ignore-engine/);
  assert.match(error.message, /данные он не конвертирует/);
});
