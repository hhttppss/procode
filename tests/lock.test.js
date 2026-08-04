'use strict';

/**
 * scripts/lib/lock.js — файловая блокировка хранилища для backup/restore.
 *
 * Здесь гонки: два процесса создают один и тот же файл через 'wx', перехватывают
 * протухшую метку переименованием и снимают только свою (по токену). Проверяем именно
 * это поведение, а не факт создания файла: неверная блокировка означает два скрипта,
 * одновременно переписывающих data/.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lock = require('../scripts/lib/lock');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'procode-lock-'));

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** Свой файл блокировки на каждый тест — тесты не должны мешать друг другу. */
function lockFile(name) {
  return path.join(ROOT, name, 'app.sqlite.lock');
}

function recorder() {
  const lines = [];
  const log = (line) => lines.push(String(line));
  log.lines = lines;
  log.text = () => lines.join('\n');
  return log;
}

/** Чужая метка на диске: имитирует другой процесс, в том числе уже мёртвый. */
function writeForeignLock(file, info, ageMinutes = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof info === 'string' ? info : `${JSON.stringify(info, null, 2)}\n`);

  if (ageMinutes > 0) {
    const when = new Date(Date.now() - ageMinutes * 60000);
    fs.utimesSync(file, when, when);
  }
}

test('acquireLock создаёт файл блокировки с описанием операции', async () => {
  const file = lockFile('acquire');
  const log = recorder();

  const handle = await lock.acquireLock(file, { operation: 'backup', waitSeconds: 0, log });

  assert.equal(fs.existsSync(file), true);
  assert.equal(handle.file, file);
  assert.match(handle.token, /^[0-9a-f]{32}$/);

  const info = lock.readLockInfo(file);
  assert.equal(info.operation, 'backup');
  assert.equal(info.pid, process.pid);
  assert.equal(info.hostname, os.hostname());
  assert.equal(info.token, handle.token);
  assert.equal(Number.isNaN(Date.parse(info.startedAt)), false, 'startedAt должен быть разбираемой датой');

  assert.match(lock.describe(info), /операция: backup/);
  assert.match(lock.describe(info), new RegExp(`pid ${process.pid}`));
  assert.equal(lock.describe(null), 'неизвестно кем');
  assert.equal(log.lines.length, 0, 'при свободном хранилище говорить не о чем');

  handle.release();
  assert.equal(fs.existsSync(file), false, 'release должен удалить файл блокировки');
});

test('release идемпотентен и освобождает хранилище для следующего вызова', async () => {
  const file = lockFile('release');
  const log = recorder();

  const first = await lock.acquireLock(file, { operation: 'backup', waitSeconds: 0, log });
  first.release();
  first.release();
  first.release();
  assert.equal(fs.existsSync(file), false);

  const second = await lock.acquireLock(file, { operation: 'restore', waitSeconds: 0, log });
  assert.notEqual(second.token, first.token);
  assert.equal(lock.readLockInfo(file).operation, 'restore');

  second.release();
  assert.equal(fs.existsSync(file), false);
});

test('занятое хранилище: ожидание, затем понятная ошибка', async () => {
  const file = lockFile('busy');
  const log = recorder();

  const holder = await lock.acquireLock(file, { operation: 'backup', waitSeconds: 0, log });

  const startedAt = Date.now();
  await assert.rejects(
    () => lock.acquireLock(file, { operation: 'restore', waitSeconds: 1, staleMinutes: 60, log }),
    (error) => {
      assert.match(error.message, /Хранилище заблокировано/);
      assert.match(error.message, /операция: backup/, 'в ошибке видно, кто держит блокировку');
      assert.match(error.message, /--wait 60/);
      assert.match(error.message, /--force/);
      return true;
    }
  );

  const waited = Date.now() - startedAt;
  assert.ok(waited >= 900, `ожидание оборвалось раньше waitSeconds: ${waited} мс`);
  assert.match(log.text(), /Хранилище занято .*жду освобождения/);

  // Чужую блокировку неудачная попытка не тронула.
  assert.equal(lock.readLockInfo(file).token, holder.token);

  holder.release();
  const next = await lock.acquireLock(file, { operation: 'restore', waitSeconds: 0, log });
  next.release();
});

test('блокировка мёртвого процесса перехватывается без --force', async () => {
  const file = lockFile('stale-pid');
  const log = recorder();

  // Windows выдаёт pid кратными четырём, так что 999999 не существует; проверяем это явно,
  // чтобы тест падал с понятной причиной, а не «просто так».
  const deadPid = 999999;
  assert.equal(lock.isProcessAlive(deadPid), false);
  assert.equal(lock.isProcessAlive(process.pid), true);
  assert.equal(lock.isProcessAlive(0), false);
  assert.equal(lock.isProcessAlive(-1), false);
  assert.equal(lock.isProcessAlive('12'), false, 'pid строкой — не pid');

  writeForeignLock(file, {
    token: 'foreign-token',
    operation: 'backup',
    pid: deadPid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  });

  const handle = await lock.acquireLock(file, { operation: 'restore', waitSeconds: 0, staleMinutes: 60, log });

  assert.match(log.text(), /Блокировка протухла и перехвачена/);
  assert.match(log.text(), new RegExp(`процесс pid ${deadPid} больше не работает`));
  assert.match(log.text(), /Была операция: backup/);

  const info = lock.readLockInfo(file);
  assert.equal(info.token, handle.token, 'файл должен принадлежать новому владельцу');
  assert.equal(info.operation, 'restore');

  handle.release();
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.stale-${handle.token}`), false, 'временная копия чужой метки убрана');
});

test('блокировка старше staleMinutes перехватывается по возрасту файла', async () => {
  const file = lockFile('stale-age');
  const log = recorder();

  // Хост чужой — проверка pid не применяется, остаётся только возраст файла.
  writeForeignLock(
    file,
    {
      token: 'foreign-token',
      operation: 'backup',
      pid: process.pid,
      hostname: 'другая-машина',
      startedAt: new Date(Date.now() - 3600000).toISOString(),
    },
    60
  );

  const handle = await lock.acquireLock(file, { operation: 'restore', waitSeconds: 0, staleMinutes: 5, log });

  assert.match(log.text(), /файл не обновлялся 60 мин \(порог 5 мин\)/);
  assert.match(log.text(), /хост другая-машина/);
  assert.equal(lock.readLockInfo(file).token, handle.token);

  handle.release();
});

test('свежая чужая блокировка по возрасту не перехватывается', async () => {
  const file = lockFile('fresh-foreign');
  const log = recorder();

  writeForeignLock(file, {
    token: 'foreign-token',
    operation: 'backup',
    pid: process.pid,
    hostname: 'другая-машина',
    startedAt: new Date().toISOString(),
  });

  await assert.rejects(
    () => lock.acquireLock(file, { operation: 'restore', waitSeconds: 0, staleMinutes: 30, log }),
    /Хранилище заблокировано/
  );
  assert.equal(lock.readLockInfo(file).token, 'foreign-token', 'чужая свежая метка должна остаться на месте');
});

test('нечитаемый файл блокировки считается мусором и перехватывается', async () => {
  const file = lockFile('corrupt');
  const log = recorder();

  writeForeignLock(file, '{ "token": "оборван');

  const info = lock.readLockInfo(file);
  assert.equal(info.corrupt, true);
  assert.equal(lock.describe(info), 'нечитаемый файл блокировки');
  assert.equal(lock.readLockInfo(path.join(ROOT, 'corrupt', 'нет-такого.lock')), null);

  const handle = await lock.acquireLock(file, { operation: 'backup', waitSeconds: 0, staleMinutes: 30, log });
  assert.match(log.text(), /файл блокировки не читается/);
  assert.equal(lock.readLockInfo(file).token, handle.token);

  handle.release();
});

test('--force снимает даже живую чужую блокировку', async () => {
  const file = lockFile('force');
  const log = recorder();

  const holder = await lock.acquireLock(file, { operation: 'backup', waitSeconds: 0, log });

  const forced = await lock.acquireLock(file, { operation: 'restore', waitSeconds: 0, force: true, log });
  assert.match(log.text(), /Блокировка снята принудительно \(--force\)/);
  assert.equal(lock.readLockInfo(file).token, forced.token);

  // Прежний владелец снимает блокировку по токену, поэтому чужую метку он не тронет.
  holder.release();
  assert.equal(fs.existsSync(file), true, 'release прежнего владельца не должен снимать чужую блокировку');
  assert.equal(lock.readLockInfo(file).token, forced.token);

  forced.release();
  assert.equal(fs.existsSync(file), false);
});
