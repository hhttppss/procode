'use strict';

/**
 * «Последний администратор» — защита от того, чтобы школа осталась без входа в систему.
 *
 * Порознь каждая операция законна: разжаловать администратора можно, заблокировать можно,
 * удалить можно. Опасны они парами, отправленными одновременно: если проверка «остался ли
 * ещё активный администратор» и сама запись идут разными обращениями к хранилищу, два
 * запроса успевают пройти проверку до того, как хоть один из них что-то изменит, — и оба
 * оказываются последними. Поэтому проверка и запись живут в одной транзакции
 * (server/routes/api/teachers.js, server/db.js), а тест проверяет именно исход гонки,
 * а не наличие транзакции в коде.
 *
 * Сценарии выполняет дочерний процесс (tests/helpers/last-admin-runner.js) во временной
 * базе SQLite: движок и путь к хранилищу выбираются один раз при подключении server/db.js,
 * поэтому в одном процессе с ним не ужиться (см. tests/db-transaction.test.js).
 * Движок json той же гарантией обязан общей очереди db.js — она проверяется там же,
 * в tests/db-transaction.test.js, на обоих движках.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'helpers', 'last-admin-runner.js');
const REAL_DATA = path.join(PROJECT, 'data');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'procode-last-admin-'));

// Снимок боевой папки: ни один тест этого файла не имеет права её пополнить.
const realDataBefore = fs.existsSync(REAL_DATA) ? fs.readdirSync(REAL_DATA).sort() : null;

let report = null;

before(() => {
  const result = spawnSync(process.execPath, [RUNNER], {
    encoding: 'utf8',
    // Сценарии держат запросы на «стартовых воротах» до прихода всей группы:
    // если группа почему-то не соберётся, процесс должен умереть, а не висеть вечно.
    timeout: 30000,
    env: {
      ...process.env,
      DATABASE_ENGINE: 'sqlite',
      SQLITE_STORAGE: path.join(ROOT, 'app.sqlite'),
    },
  });

  assert.equal(result.error, undefined, `не удалось запустить дочерний процесс: ${result.error && result.error.message}`);
  assert.equal(result.status, 0, `сценарии упали (код ${result.status}):\n${result.stderr}\n${result.stdout}`);

  const line = (result.stdout || '').split(/\r?\n/).find((row) => row.startsWith('RESULT:'));
  assert.ok(line, `дочерний процесс не отдал отчёт:\n${result.stdout}\n${result.stderr}`);

  report = JSON.parse(line.slice('RESULT:'.length));
  assert.equal(report.engine, 'sqlite');
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('пока администраторов больше двух, одновременное разжалование двоих проходит', () => {
  assert.deepEqual(report.spare.statuses, [200, 200], 'защита не должна мешать штатной работе');
  assert.deepEqual(report.spare.after.activeAdmins, ['gamma']);
});

test('двое последних администраторов не могут разжаловать друг друга одновременно', () => {
  assert.deepEqual(report.demote.statuses, [200, 400], 'ровно один запрос должен получить отказ');
  assert.equal(report.demote.refusals.length, 1);
  assert.match(report.demote.refusals[0], /единственный активный администратор/);

  assert.equal(
    report.demote.after.activeAdmins.length,
    1,
    'после гонки в школе обязан остаться администратор — иначе в систему некому войти'
  );
});

test('одновременные «заблокировать себя» и «удалить второго» тоже оставляют администратора', () => {
  assert.deepEqual(report.restored.activeAdmins.length, 2, 'сценарию нужны ровно два активных администратора');

  assert.deepEqual(report.blockAndDelete.statuses, [200, 400], 'ровно один запрос должен получить отказ');
  assert.equal(report.blockAndDelete.refusals.length, 1);
  assert.match(report.blockAndDelete.refusals[0], /единственный активный администратор/);

  assert.equal(report.blockAndDelete.after.activeAdmins.length, 1);
});

test('боевая папка data/ тестами не тронута', () => {
  const realDataAfter = fs.existsSync(REAL_DATA) ? fs.readdirSync(REAL_DATA).sort() : null;
  assert.deepEqual(realDataAfter, realDataBefore, 'тесты обязаны работать только во временных папках');
});
