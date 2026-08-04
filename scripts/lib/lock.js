'use strict';

/**
 * Рекомендательная блокировка хранилища: флаг-файл data/app.sqlite.lock.
 *
 * ЧЕСТНО О ГРАНИЦАХ. Блокировка рекомендательная (advisory) и работает только между
 * теми процессами, которые сами её проверяют, — то есть между backup.js и restore.js.
 * Работающий сервер про этот файл ничего не знает и продолжит писать в базу.
 * Что это значит на практике:
 *   • backup при живом сервере безопасен и без блокировки — снимок SQLite делается
 *     онлайн-бэкапом, который отдаёт консистентное состояние базы (см. backup.js);
 *   • restore при живом сервере НЕ безопасен ни с какой блокировкой: сервер держит
 *     открытый дескриптор базы, и подмена файла под ним приводит к порче данных.
 *     Поэтому restore требует остановленного сервера — это условие эксплуатации,
 *     а не то, что обеспечивает этот модуль.
 * Задача файла скромнее: не дать двум служебным скриптам работать одновременно
 * и оставить след «кто и что делает с данными прямо сейчас».
 *
 * Устройство:
 *   • файл создаётся через fs.openSync(path, 'wx') — атомарное «создать, если нет»,
 *     без гонки «проверил → создал»;
 *   • внутри JSON: pid, hostname, время старта, операция и случайный токен;
 *   • снимаем блокировку только если токен в файле наш — иначе можно снести чужую,
 *     например ту, что перехватила нашу как протухшую;
 *   • протухшей считается блокировка мёртвого процесса на этой же машине либо
 *     файл старше staleMinutes.
 *
 * Ctrl+C блокировку снимает: обработчики SIGINT/SIGTERM и process.on('exit') убирают
 * файл. А вот жёсткое завершение (kill -9, «Снять задачу» в диспетчере, отключение
 * питания) обработчики не выполняет — файл останется. Именно на этот случай и нужно
 * определение протухшей блокировки: следующий запуск увидит мёртвый pid и перехватит её
 * сам, без --force. На Windows SIGTERM процессу не доставляется вовсе (ограничение
 * платформы), так что там страховкой служит только эта проверка.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_STALE_MINUTES = 30;
const POLL_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readLockInfo(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // Файл есть, но нечитаем: обрезанная запись после падения процесса.
    // Это не «чужая блокировка», а мусор — вызывающий код решит по возрасту файла.
    return { corrupt: true, reason: error.message };
  }
}

/**
 * Жив ли процесс. Сигнал 0 ничего не посылает, только проверяет доступность:
 * ESRCH — процесса нет, EPERM — процесс есть, но чужой.
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function ageMinutes(file) {
  try {
    return (Date.now() - fs.statSync(file).mtimeMs) / 60000;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function describe(info) {
  if (!info) return 'неизвестно кем';
  if (info.corrupt) return 'нечитаемый файл блокировки';

  const parts = [];
  if (info.operation) parts.push(`операция: ${info.operation}`);
  if (info.pid) parts.push(`pid ${info.pid}`);
  if (info.hostname) parts.push(`хост ${info.hostname}`);
  if (info.startedAt) parts.push(`с ${new Date(info.startedAt).toLocaleString('ru-RU')}`);
  return parts.join(', ') || 'без подробностей';
}

/**
 * Причина, по которой чужую блокировку можно перехватить, либо null.
 * Проверка pid имеет смысл только на той же машине: на другой это чужой номер.
 */
function staleReason(file, info, staleMinutes) {
  const age = ageMinutes(file);

  if (info && info.corrupt) {
    return `файл блокировки не читается (${info.reason})`;
  }
  if (info && info.hostname === os.hostname() && !isProcessAlive(info.pid)) {
    return `процесс pid ${info.pid} больше не работает`;
  }
  if (age > staleMinutes) {
    return `файл не обновлялся ${Math.round(age)} мин (порог ${staleMinutes} мин)`;
  }
  return null;
}

/**
 * Захватывает блокировку. При занятости ждёт до waitSeconds, затем бросает ошибку.
 *
 * @param {string} file путь к флаг-файлу
 * @param {object} options
 * @param {string} options.operation      'backup' | 'restore' — попадёт в файл и в сообщения
 * @param {number} [options.waitSeconds]  сколько ждать освобождения, 0 — не ждать
 * @param {boolean} [options.force]       снести чужую блокировку принудительно
 * @param {number} [options.staleMinutes] возраст, после которого блокировка считается протухшей
 * @param {Function} [options.log]        куда писать предупреждения
 * @returns {Promise<{release: Function, file: string, token: string}>}
 */
async function acquireLock(file, options = {}) {
  const {
    operation = 'operation',
    waitSeconds = 10,
    force = false,
    staleMinutes = DEFAULT_STALE_MINUTES,
    log = console.log,
  } = options;

  const token = crypto.randomBytes(16).toString('hex');
  const payload = `${JSON.stringify(
    {
      token,
      operation,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    },
    null,
    2
  )}\n`;

  fs.mkdirSync(path.dirname(file), { recursive: true });

  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  let waitedMessageShown = false;

  for (;;) {
    let fd;
    try {
      // 'wx' = O_CREAT | O_EXCL: если файл уже есть, получаем EEXIST, а не перезаписываем чужую метку.
      fd = fs.openSync(file, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new Error(`Не удалось создать файл блокировки ${file}: ${error.message}`);
      }

      const info = readLockInfo(file);

      // Наш же токен в файле — значит, блокировку взял этот процесс и не снял.
      // Такого быть не должно, но перехватывать её как чужую точно не нужно.
      if (info && info.token === token) {
        throw new Error(`Файл блокировки ${file} уже содержит наш токен — внутренняя ошибка.`);
      }

      const stale = staleReason(file, info, staleMinutes);
      if (force || stale) {
        // Снимаем чужую метку переименованием, а не unlink. Между «прочитали файл и
        // решили, что он протух» и «удалили» другой процесс мог решить то же самое,
        // успеть удалить файл и создать свою свежую блокировку — простой unlink снёс бы
        // её, и оба процесса считали бы себя единственными. Переименовать один и тот же
        // файл может только кто-то один: проигравший получит ENOENT и пойдёт на новый
        // круг, где увидит уже чужую свежую метку и станет её ждать.
        const parked = `${file}.stale-${token}`;
        try {
          fs.renameSync(file, parked);
        } catch (renameError) {
          if (renameError.code === 'ENOENT') continue; // перехватил кто-то другой
          throw new Error(`Не удалось снять блокировку ${file}: ${renameError.message}`);
        }

        log(
          force
            ? `  ⚠  Блокировка снята принудительно (--force): ${describe(info)}.`
            : `  ⚠  Блокировка протухла и перехвачена: ${stale}. Была ${describe(info)}.`
        );
        fs.rmSync(parked, { force: true });
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Хранилище заблокировано (${describe(info)}).\n` +
            `  Файл блокировки: ${file}\n` +
            '  Дождитесь окончания операции, либо увеличьте ожидание (-- --wait 60),\n' +
            '  либо снимите блокировку принудительно (-- --force), если уверены, что процесса нет.'
        );
      }

      if (!waitedMessageShown) {
        log(`  Хранилище занято (${describe(info)}) — жду освобождения…`);
        waitedMessageShown = true;
      }

      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    try {
      fs.writeSync(fd, payload);
    } finally {
      fs.closeSync(fd);
    }

    return createHandle(file, token, log);
  }
}

/** Снимает блокировку только если токен в файле наш. @returns {boolean} сняли ли */
function releaseIfOurs(file, token) {
  const info = readLockInfo(file);
  if (!info) return false;
  if (info.token !== token) return false;

  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Оборачивает снятие блокировки: идемпотентный release() плюс страховка на случай
 * Ctrl+C и падения. Без неё прерванный бэкап оставлял бы висящий lock, и следующий
 * запуск ждал бы полчаса до срабатывания проверки протухания.
 */
function createHandle(file, token, log) {
  let released = false;

  function release() {
    if (released) return;
    released = true;

    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);

    try {
      releaseIfOurs(file, token);
    } catch (error) {
      log(`  ⚠  Не удалось снять блокировку ${file}: ${error.message}. Удалите файл вручную.`);
    }
  }

  function onExit() {
    // Внутри 'exit' допустимы только синхронные вызовы — releaseIfOurs синхронный.
    if (released) return;
    released = true;
    try {
      releaseIfOurs(file, token);
    } catch {
      // На выходе из процесса жаловаться уже некому.
    }
  }

  function onSignal(signal) {
    release();
    // Код 130/143 — принятое обозначение «прерван сигналом». Свои обработчики
    // сняты, поэтому повторная отправка сигнала завершит процесс штатно.
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    process.kill(process.pid, signal);
  }

  process.once('exit', onExit);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return { file, token, release };
}

module.exports = {
  acquireLock,
  readLockInfo,
  isProcessAlive,
  describe,
  DEFAULT_STALE_MINUTES,
};
