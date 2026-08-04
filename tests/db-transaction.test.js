'use strict';

/**
 * server/db.js — очередь операций и транзакции, на обоих движках хранения.
 *
 * Изоляция от боевых данных:
 *  • sqlite — подключается настоящий server/db.js, но SQLITE_STORAGE указывает во временную
 *    папку; в этом режиме модуль в data/ вообще не ходит (json-файлы читает только движок json);
 *  • json — DATA_DIR в db.js вычисляется от __dirname и не настраивается, поэтому движок
 *    проверяется на копии server/config.js и server/db.js во временном «проекте».
 *    Копируется настоящий код: расхождение с оригиналом ловит проверка зависимостей ниже.
 *
 * Сценарии выполняет дочерний процесс (tests/helpers/db-runner.js) — движок выбирается
 * один раз при подключении модуля, и два движка в одном процессе не уживаются. Результат
 * приходит отчётом, а хранилище потом читается напрямую с диска: так проверяется, что данные
 * действительно записаны, а не просто лежат в кэше коллекции.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'helpers', 'db-runner.js');
const REAL_DB = path.join(PROJECT, 'server', 'db.js');
const REAL_DATA = path.join(PROJECT, 'data');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'procode-db-'));

// Снимок боевой папки: ни один тест этого файла не имеет права её пополнить.
const realDataBefore = fs.existsSync(REAL_DATA) ? fs.readdirSync(REAL_DATA).sort() : null;

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** Прогон сценариев в отдельном процессе. @returns {object} отчёт db-runner.js */
function runScenarios(dbPath, env) {
  const result = spawnSync(process.execPath, [RUNNER, dbPath], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

  assert.equal(result.error, undefined, `не удалось запустить дочерний процесс: ${result.error && result.error.message}`);
  assert.equal(result.status, 0, `сценарии упали (код ${result.status}):\n${result.stderr}\n${result.stdout}`);

  const line = (result.stdout || '').split(/\r?\n/).find((row) => row.startsWith('RESULT:'));
  assert.ok(line, `дочерний процесс не отдал отчёт:\n${result.stdout}\n${result.stderr}`);

  return JSON.parse(line.slice('RESULT:'.length));
}

/**
 * Временный «проект» для движка json: DATA_DIR в db.js — это <корень>/data от его __dirname,
 * другого способа увести файловое хранилище из боевой data/ у модуля нет.
 */
function makeJsonProject() {
  const root = path.join(ROOT, 'json-project');
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });

  // Если db.js обзаведётся ещё одной внутренней зависимостью, копию нужно расширить —
  // пусть тест скажет об этом прямо, а не падает загадочным MODULE_NOT_FOUND.
  const source = fs.readFileSync(REAL_DB, 'utf8');
  const localRequires = [...source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(localRequires)].sort(),
    ['./config'],
    'server/db.js подключает другие модули проекта — добавьте их в копию для теста'
  );

  for (const name of ['config.js', 'db.js']) {
    fs.copyFileSync(path.join(PROJECT, 'server', name), path.join(root, 'server', name));
  }

  return { db: path.join(root, 'server', 'db.js'), data: path.join(root, 'data') };
}

/** Записи коллекции, прочитанные с диска в обход модуля и его кэшей. */
function readJsonCollection(dataDir, name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8'));
}

function readSqliteCollection(file, name) {
  const Database = require('better-sqlite3');
  const connection = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return connection
      .prepare(`SELECT data FROM "${name}" ORDER BY rowid`)
      .all()
      .map((row) => JSON.parse(row.data));
  } finally {
    connection.close();
  }
}

/** Общие для обоих движков проверки отчёта. */
function assertScenarios(report, engine) {
  assert.equal(report.engine, engine);

  // --- стартовое состояние
  assert.deepEqual(report.seed.notes, 1);
  assert.deepEqual(report.seed.tags, 0);

  // --- (а) исключение внутри транзакции
  assert.equal(report.rollback.message, 'намеренный сбой внутри транзакции', 'ошибка обработчика должна дойти до вызывающего кода');
  assert.equal(report.rollback.notes, 1, 'вставка из сорванной транзакции не должна сохраниться');
  assert.equal(report.rollback.tags, 0, 'вторая коллекция тоже должна остаться нетронутой');
  assert.equal(report.rollback.seedAmount, 100, 'правка существующей записи должна откатиться');
  assert.deepEqual(report.rollback.titles, ['исходная запись']);

  // --- (б) успешная транзакция по двум коллекциям
  assert.equal(report.commit.result.seenInside, 7, 'внутри транзакции видны её собственные правки');
  assert.equal(report.commit.result.listedInside, 2);
  assert.equal(report.commit.result.removedMissing, false, 'remove несуществующего id возвращает false');
  assert.equal(report.commit.notes, 2);
  assert.equal(report.commit.tags, 1);
  assert.equal(report.commit.note.title, 'запись из транзакции');
  assert.equal(report.commit.note.amount, 7, 'зафиксироваться должно последнее состояние записи');
  assert.equal(report.commit.tag.title, 'метка из транзакции');
  assert.match(report.commit.result.noteId, /^nt_/, 'префикс идентификатора берётся из объявления коллекции');
  assert.match(report.commit.result.tagId, /^tg_/);
  assert.ok(report.commit.note.createdAt && report.commit.note.updatedAt, 'метки времени проставляются транзакцией');

  // --- методы коллекции внутри транзакции
  assert.match(
    report.guard.message,
    /Внутри транзакции нельзя вызывать методы коллекций/,
    'иначе вызов встал бы в ту же очередь и сервер завис бы намертво'
  );
  assert.equal(report.guard.returned, 'обработчик отработал', 'сама транзакция при этом должна дойти до конца');
  assert.equal(report.guard.notes, 2, 'отклонённый create ничего не записал');

  // --- (в) параллельные create
  assert.equal(report.parallel.created, 20);
  assert.equal(report.parallel.landed, 20, 'очередь обязана сериализовать записи: ни одна не должна потеряться');
  assert.equal(report.parallel.distinctTitles, 20, 'записи не должны затирать друг друга');
  assert.equal(report.parallel.total, report.parallel.before + 20);
  assert.equal(report.parallel.uniqueIds, report.parallel.total, 'идентификаторы уникальны');

  assert.deepEqual(report.final, { notes: 22, tags: 1 });
}

test('движок json: транзакции и очередь на файловом хранилище', () => {
  const project = makeJsonProject();
  const report = runScenarios(project.db, { DATABASE_ENGINE: 'json', SQLITE_STORAGE: '' });

  assertScenarios(report, 'json');

  // Независимая проверка: читаем файлы коллекций сами, без участия модуля.
  const notes = readJsonCollection(project.data, 'tst_notes');
  const tags = readJsonCollection(project.data, 'tst_tags');

  assert.equal(notes.length, 22, 'на диске должно лежать ровно столько же, сколько отдал модуль');
  assert.equal(tags.length, 1);
  assert.equal(notes.filter((item) => item.title.startsWith('параллельная')).length, 20);
  assert.equal(notes.some((item) => item.title.includes('сорванной')), false, 'откат должен был не дойти до диска');
  assert.equal(notes.find((item) => item.title === 'исходная запись').amount, 100);

  // Файловое хранилище держит только объявленные коллекции — мусора рядом не появилось.
  assert.deepEqual(fs.readdirSync(project.data).sort(), ['tst_notes.json', 'tst_tags.json']);
});

test('движок sqlite: транзакции и очередь на настоящем server/db.js', () => {
  const storage = path.join(ROOT, 'sqlite', 'app.sqlite');
  const report = runScenarios(REAL_DB, { DATABASE_ENGINE: 'sqlite', SQLITE_STORAGE: storage });

  assertScenarios(report, 'sqlite');

  assert.equal(fs.existsSync(storage), true, 'база должна быть создана во временной папке, а не в data/');

  const notes = readSqliteCollection(storage, 'tst_notes');
  const tags = readSqliteCollection(storage, 'tst_tags');

  assert.equal(notes.length, 22);
  assert.equal(tags.length, 1);
  assert.equal(notes.filter((item) => item.title.startsWith('параллельная')).length, 20);
  assert.equal(notes.some((item) => item.title.includes('сорванной')), false, 'BEGIN…COMMIT обязан был откатиться целиком');
  assert.equal(notes.find((item) => item.title === 'исходная запись').amount, 100);
});

test('боевая папка data/ тестами не тронута', () => {
  const realDataAfter = fs.existsSync(REAL_DATA) ? fs.readdirSync(REAL_DATA).sort() : null;
  assert.deepEqual(realDataAfter, realDataBefore, 'тесты обязаны работать только во временных папках');
});
