'use strict';

/**
 * Движок хранения данных. Одна «коллекция» — один набор записей (students, lessons…).
 *
 * Физически коллекции лежат в одном из двух хранилищ (DATABASE_ENGINE в .env):
 *  • sqlite — таблица «id TEXT PRIMARY KEY, data TEXT» в data/app.sqlite (по умолчанию);
 *  • json   — файл data/<коллекция>.json, как в первых версиях проекта.
 *
 * Наружу оба движка отдают один и тот же интерфейс: collection() и transaction().
 * Модели, роуты и служебные скрипты о выборе хранилища не знают.
 *
 * Правила, общие для обоих движков:
 *  • все изменяющие операции выстроены в общую промис-очередь — параллельные запросы
 *    не затирают друг друга;
 *  • запись коллекции целиком: наружу нельзя получить наполовину сохранённый список
 *    (json — временный файл + rename, sqlite — транзакция);
 *  • повреждённые данные не роняют сервер (json — файл уходит в карантин,
 *    sqlite — нечитаемая строка пропускается с сообщением в лог);
 *  • чтение кэшируется до ближайшего изменения хранилища — дашборд читает пять
 *    коллекций и не упирается в диск.
 *
 * Очередь одна на все коллекции: операции на разных коллекциях не конфликтуют, но и не
 * идут настолько часто, чтобы последовательность стала узким местом. Зато нет шанса
 * словить гонку при связанных изменениях (например, «конвертировать заявку в ученика»).
 *
 * Очередь сериализует отдельные вызовы, но не связки «прочитать → проверить → записать»:
 * между двумя такими вызовами успевает пройти параллельный запрос. Для этого есть
 * transaction() — см. раздел «транзакции» ниже.
 *
 * Документ целиком (нормализованный объект записи) хранится одним JSON-значением,
 * без разбора на колонки. Так сделано осознанно: filter/find/count принимают
 * произвольные JS-предикаты, а не запросы — перевод их в SQL WHERE это отдельная
 * задача, а не смена движка. Выборка и сортировка остаются в JS и не меняются.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Имя коллекции подставляется в путь файла и в SQL как имя таблицы (параметризовать
// имена таблиц SQLite не умеет), поэтому список допустимых символов закрытый.
const COLLECTION_NAME = /^[a-z][a-z0-9_]*$/;

function assertCollectionName(name) {
  if (typeof name !== 'string' || !COLLECTION_NAME.test(name)) {
    throw new Error(
      `Недопустимое имя коллекции «${name}»: разрешены строчные латинские буквы, цифры и подчёркивание, первый символ — буква.`
    );
  }
  return name;
}

/** Уникальный идентификатор: время (для сортировки) + случайная часть (для уникальности). */
function createId(prefix) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
  return prefix ? `${prefix}_${id}` : id;
}

// ------------------------------------------------------------------- очередь

let queue = Promise.resolve();

// Метка «мы сейчас внутри transaction()». Хранится в контексте асинхронного вызова,
// а не в обычной переменной: параллельные запросы не должны видеть чужую транзакцию.
const transactionContext = new AsyncLocalStorage();

/** Ставит операцию в общую очередь: следующая стартует только после завершения предыдущей. */
function enqueue(task) {
  // Очередь одна на все коллекции, поэтому вызов store.create() внутри транзакции
  // ждал бы её завершения, а транзакция — его: сервер встал бы намертво.
  // Понятная ошибка лучше зависшего процесса.
  if (transactionContext.getStore()) {
    return Promise.reject(
      new Error(
        'Внутри транзакции нельзя вызывать методы коллекций и открывать вложенную транзакцию — используйте объект, который transaction() передаёт в обработчик.'
      )
    );
  }

  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// -------------------------------------------------------------- файловый движок

async function quarantine(file, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file.replace(/\.json$/, '')}.corrupt-${stamp}.json`;

  console.error(`Файл ${file} повреждён (${reason}). Сохраняю копию: ${target}`);

  try {
    await fsp.rename(file, target);
  } catch (error) {
    console.error(`Не удалось переименовать повреждённый файл: ${error.message}`);
  }
}

async function writeFileAtomic(file, items) {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  const temp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(temp, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Путь к файлу коллекции. Остаётся прежним и на sqlite — см. комментарий у collection(). */
function fileOf(name) {
  return path.join(DATA_DIR, `${assertCollectionName(name)}.json`);
}

/**
 * Хранилище «коллекция = JSON-файл».
 *
 * Каждый файл пишется атомарно (временный файл + rename), но общего журнала на несколько
 * файлов нет: если диск откажет между записями транзакции, часть изменений уцелеет.
 */
function createJsonBackend() {
  async function ensure(name) {
    const file = fileOf(name);
    await fsp.mkdir(DATA_DIR, { recursive: true });
    try {
      await fsp.access(file);
    } catch {
      await writeFileAtomic(file, []);
    }
  }

  /** Ключ кэша — отпечаток файла: правку JSON руками подхватываем без перезапуска сервера. */
  function revision(name) {
    try {
      const stat = fs.statSync(fileOf(name));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  async function readRows(name) {
    const file = fileOf(name);
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('ожидался массив записей');
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      await quarantine(file, error.message);
      return [];
    }
  }

  async function writeRows(name, rows) {
    await writeFileAtomic(fileOf(name), rows);
  }

  /** Транзакция файлового движка: одно место в очереди, запись только тронутых коллекций. */
  async function runTransaction(targets, session) {
    const loaded = [];
    for (const internals of targets) loaded.push(await internals.readAll());
    session.load(loaded);

    const result = await session.run();

    // Сохраняем только тронутые коллекции и только после успешного обработчика:
    // исключение внутри — правки остались в памяти и просто пропали вместе со scope.
    for (const state of session.dirtyStates()) await state.internals.writeAll(state.items);

    return result;
  }

  return { id: 'json', sync: false, ensure, revision, readRows, writeRows, runTransaction };
}

// --------------------------------------------------------------- движок sqlite

/**
 * Хранилище «коллекция = таблица (id, data)» в одном файле SQLite.
 *
 * Драйвер better-sqlite3 синхронный: чтение и запись возвращают результат сразу,
 * без промисов. Благодаря этому транзакция по нескольким коллекциям целиком
 * помещается в один BEGIN…COMMIT — при исключении откатываются все коллекции разом.
 */
function createSqliteBackend(file) {
  let conn = null;
  let tableExists = null;
  const known = new Set(); // таблицы, существование которых уже подтверждено
  const statements = new Map();

  function connect() {
    if (conn) return conn;

    let Database;
    try {
      // Требуется внутри, а не наверху модуля: на движке json нативный драйвер не нужен.
      Database = require('better-sqlite3');
    } catch (error) {
      throw new Error(
        `Не удалось загрузить драйвер better-sqlite3 (${error.message}). ` +
          'Выполните npm install. Если нативный модуль не собирается, временно переключитесь ' +
          'на файловое хранилище: DATABASE_ENGINE=json в .env.'
      );
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    conn = new Database(file);

    // WAL: читатели не блокируют писателя, и база переживает падение процесса.
    conn.pragma('journal_mode = WAL');
    // NORMAL при WAL безопасен для отката транзакций и заметно экономит fsync.
    conn.pragma('synchronous = NORMAL');
    // Если файл занят другим процессом (запущен seed рядом с сервером) — подождать, а не падать.
    conn.pragma('busy_timeout = 5000');

    tableExists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    return conn;
  }

  function ensure(name) {
    assertCollectionName(name);
    if (known.has(name)) return;

    connect().exec(`CREATE TABLE IF NOT EXISTS "${name}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    known.add(name);
  }

  function hasTable(name) {
    if (known.has(name)) return true;

    connect();
    if (!tableExists.get(assertCollectionName(name))) return false;

    known.add(name);
    return true;
  }

  function prepared(name) {
    let set = statements.get(name);
    if (set) return set;

    assertCollectionName(name);
    const db = connect();
    set = {
      // rowid хранит порядок вставки — списки читаются в том же порядке, что и раньше.
      select: db.prepare(`SELECT id, data FROM "${name}" ORDER BY rowid`),
      insert: db.prepare(`INSERT INTO "${name}" (id, data) VALUES (?, ?)`),
      clear: db.prepare(`DELETE FROM "${name}"`),
    };
    statements.set(name, set);
    return set;
  }

  /**
   * Ключ кэша. data_version меняется, когда в базу записал ДРУГОЙ процесс
   * (например, запущенный рядом seed) — свои записи сбрасывают кэш сами.
   */
  function revision(name) {
    if (!hasTable(name)) return null;
    return `v${connect().pragma('data_version', { simple: true })}`;
  }

  function readRows(name) {
    if (!hasTable(name)) return [];

    const rows = [];
    for (const row of prepared(name).select.all()) {
      try {
        rows.push(JSON.parse(row.data));
      } catch (error) {
        // Одна битая строка не должна прятать остальные записи коллекции.
        console.error(`Запись ${row.id} коллекции «${name}» не читается (${error.message}) — пропущена.`);
      }
    }
    return rows;
  }

  /**
   * Полная перезапись коллекции. Списки школьного масштаба (сотни записей) переписываются
   * целиком: это ровно та же семантика, что у файлового движка, и не требует диффа.
   * Вложенная транзакция превращается в SAVEPOINT, поэтому вызов изнутри runTransaction безопасен.
   */
  function writeRows(name, rows) {
    const db = connect();
    const write = db.transaction(() => {
      ensure(name);
      const { insert, clear } = prepared(name);
      clear.run();

      for (const item of rows) {
        const id = item && typeof item.id === 'string' ? item.id : '';
        if (!id) throw new Error(`Запись коллекции «${name}» без идентификатора — сохранить её нельзя.`);

        try {
          insert.run(id, JSON.stringify(item));
        } catch (error) {
          if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
            throw new Error(`В коллекции «${name}» две записи с одним идентификатором «${id}».`);
          }
          throw error;
        }
      }
    });

    write();
  }

  function save(session) {
    for (const state of session.dirtyStates()) state.internals.writeAllSync(state.items);
  }

  /**
   * Транзакция sqlite: чтение коллекций, обработчик и запись «грязных» коллекций —
   * один BEGIN…COMMIT. Исключение внутри обработчика откатывает изменения по всем
   * коллекциям сразу, а не по одной, как это было у файлового движка.
   *
   * Обработчик обязан быть синхронным (как и везде в проекте сегодня — ни один вызов
   * db.transaction() не передаёт async fn): better-sqlite3 не умеет ждать промис внутри
   * своей транзакции. Более ранний вариант этого кода умел «откатить чтение и досчитать
   * запись отдельным BEGIN» для async-обработчика, но между этими двумя транзакциями
   * оставалось окно без блокировки — параллельная запись в ту же коллекцию потерялась бы
   * молча (classic lost update), а комментарий рядом обещал полную атомарность. Ложная
   * гарантия хуже явной ошибки, поэтому вместо неё — понятный отказ.
   */
  async function runTransaction(targets, session) {
    const commit = connect().transaction(() => {
      session.load(targets.map((internals) => internals.readAllSync()));

      const result = session.run();
      if (result && typeof result.then === 'function') {
        throw new Error(
          'db.transaction: обработчик вернул Promise — асинхронные обработчики транзакций ' +
            'не поддерживаются на движке sqlite (see server/db.js: runTransaction).'
        );
      }

      save(session);
      return result;
    });

    return commit();
  }

  return { id: 'sqlite', sync: true, ensure, revision, readRows, writeRows, runTransaction };
}

const backend = config.databaseEngine === 'json' ? createJsonBackend() : createSqliteBackend(config.sqliteStorage);

/**
 * Путь, который видят разовые легаси-миграции моделей (users.js, applications.js) —
 * они делают fsp.readFile(store.file, 'utf8') и, если содержимое похоже на структуру
 * первой версии проекта, тихо переписывают текущее хранилище этим снимком
 * (store.replaceAll(raw)).
 *
 * На движке json это ровно активный файл коллекции — миграция должна его видеть.
 *
 * На движке sqlite активное хранилище — таблица в data/app.sqlite, а на диске почти
 * всегда остаётся нетронутый бэкап data/<name>.json (scripts/migrate-json-to-sqlite.js
 * намеренно ничего в нём не меняет — это и есть путь отката). Если легаси-код увидит
 * этот бэкап как «требующий обновления», он молча затрёт текущие данные sqlite снимком
 * из бэкапа — вплоть до потери всего, что накопилось в приложении после переноса.
 * Поэтому на sqlite здесь заведомо не существующий путь: чтение всегда падает ENOENT,
 * и легаси-миграция безопасно ничего не делает — так и должно быть, раз данные уже
 * перенесены и нормализованы.
 */
function legacyFileOf(name) {
  if (backend.id === 'sqlite') {
    return path.join(DATA_DIR, '.sqlite-legacy-disabled', `${assertCollectionName(name)}.json`);
  }
  return fileOf(name);
}

// ------------------------------------------------------------- коллекция

/**
 * Внутреннее устройство коллекций по имени: чтение и запись в обход очереди,
 * нормализация, префикс идентификаторов. Нужно транзакциям — они работают
 * с несколькими коллекциями внутри одного места в очереди.
 */
const registry = new Map();

const EMPTY_CACHE = { key: null, items: [] };

/**
 * @param {string} name        имя коллекции (students → таблица students / data/students.json)
 * @param {object} options
 * @param {Function} options.normalize  приводит запись к ожидаемой форме; вернуть null — запись отбрасывается
 * @param {string}  options.prefix      префикс идентификаторов (st, ls, pm…)
 */
function collection(name, { normalize, prefix } = {}) {
  assertCollectionName(name);

  // Две коллекции с одним именем — это два независимых кэша над одними данными:
  // они будут затирать правки друг друга, поэтому такую ошибку ловим сразу.
  if (registry.has(name)) throw new Error(`Коллекция «${name}» уже объявлена.`);

  const file = legacyFileOf(name);
  const toRecord = typeof normalize === 'function' ? normalize : (item) => item;

  // Кэш живёт до изменения хранилища.
  let cache = EMPTY_CACHE;

  function absorb(key, rows) {
    const items = rows.map(toRecord).filter(Boolean);
    cache = { key, items };
    return items;
  }

  /** Синхронное чтение — только для синхронного движка (sqlite). Нужно транзакциям. */
  function readAllSync() {
    const key = backend.revision(name);
    if (key === null) return [];
    if (key === cache.key) return cache.items;
    return absorb(key, backend.readRows(name));
  }

  async function readAll() {
    if (backend.sync) return readAllSync();

    const key = backend.revision(name);
    if (key === null) return [];
    if (key === cache.key) return cache.items;
    return absorb(key, await backend.readRows(name));
  }

  /** Синхронная запись — только для синхронного движка (sqlite). Нужно транзакциям. */
  function writeAllSync(items) {
    backend.writeRows(name, items);
    cache = EMPTY_CACHE; // ключ пересчитается при следующем чтении
  }

  async function writeAll(items) {
    await backend.writeRows(name, items);
    cache = EMPTY_CACHE;
  }

  /** Копия списка — вызывающий код не должен менять кэш по ссылке. */
  async function list() {
    return (await readAll()).map((item) => ({ ...item }));
  }

  async function getById(id) {
    if (typeof id !== 'string' || !id) return null;
    const found = (await readAll()).find((item) => item.id === id);
    return found ? { ...found } : null;
  }

  async function find(predicate) {
    const found = (await readAll()).find(predicate);
    return found ? { ...found } : null;
  }

  async function filter(predicate) {
    return (await readAll()).filter(predicate).map((item) => ({ ...item }));
  }

  async function count(predicate) {
    const items = await readAll();
    return predicate ? items.filter(predicate).length : items.length;
  }

  async function create(data) {
    return enqueue(async () => {
      const items = (await readAll()).slice();
      const now = new Date().toISOString();
      const record = toRecord({ ...data, id: createId(prefix), createdAt: now, updatedAt: now });
      if (!record) throw new Error(`Не удалось создать запись в «${name}».`);

      items.push(record);
      await writeAll(items);
      return { ...record };
    });
  }

  /** Массовое создание одной записью — для повторяющихся занятий. */
  async function createMany(list_) {
    return enqueue(async () => {
      const items = (await readAll()).slice();
      const now = new Date().toISOString();

      const created = list_
        .map((data) => toRecord({ ...data, id: createId(prefix), createdAt: now, updatedAt: now }))
        .filter(Boolean);

      items.push(...created);
      await writeAll(items);
      return created.map((item) => ({ ...item }));
    });
  }

  /**
   * Обновляет запись. patch — либо объект с полями, либо функция (current) => патч.
   * Поля id и createdAt защищены от перезаписи.
   */
  async function update(id, patch) {
    return enqueue(async () => {
      const items = (await readAll()).slice();
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return null;

      const current = items[index];
      const changes = typeof patch === 'function' ? patch({ ...current }) : patch;
      if (!changes) return { ...current };

      const merged = { ...current, ...changes, id: current.id, createdAt: current.createdAt };
      merged.updatedAt = new Date().toISOString();

      const record = toRecord(merged);
      if (!record) return null;

      items[index] = record;
      await writeAll(items);
      return { ...record };
    });
  }

  /**
   * Массовое обновление по предикату: одно место в очереди и одна перезапись коллекции.
   *
   * Зачем отдельный метод: update() в цикле — это N мест в очереди, и каждое из них заново
   * читает и целиком переписывает коллекцию (снятие ученика с полусотни занятий переписывало
   * lessons полсотни раз и всё это время держало очередь записи занятой).
   *
   * patch — объект с полями либо функция (current) => патч, как в update(). Функция,
   * вернувшая falsy, оставляет свою запись без изменений — в ответ она не попадёт.
   * Поля id и createdAt защищены от перезаписи.
   *
   * @returns {Promise<object[]>} копии изменённых записей (пустой массив — коллекция не тронута)
   */
  async function updateWhere(predicate, patch) {
    return enqueue(async () => {
      const items = (await readAll()).slice();
      const now = new Date().toISOString();
      const updated = [];

      for (let index = 0; index < items.length; index += 1) {
        const current = items[index];
        if (!predicate(current)) continue;

        const changes = typeof patch === 'function' ? patch({ ...current }) : patch;
        if (!changes) continue;

        const merged = { ...current, ...changes, id: current.id, createdAt: current.createdAt };
        merged.updatedAt = now;

        const record = toRecord(merged);
        if (!record) continue; // запись не прошла нормализацию — оставляем как была

        // Запись подменяется целиком, а не правится по месту: тот же объект лежит в кэше.
        items[index] = record;
        updated.push({ ...record });
      }

      if (updated.length === 0) return [];

      await writeAll(items);
      return updated;
    });
  }

  async function remove(id) {
    return enqueue(async () => {
      const items = await readAll();
      const rest = items.filter((item) => item.id !== id);
      if (rest.length === items.length) return false;

      await writeAll(rest);
      return true;
    });
  }

  /**
   * Массовое удаление по предикату: одно место в очереди и одна перезапись коллекции —
   * в отличие от remove() в цикле, где каждая итерация читает и переписывает коллекцию заново
   * (удаление серии из двухсот занятий выходило в двести полных перезаписей lessons).
   *
   * @returns {Promise<number>} сколько записей удалено (0 — коллекция не тронута)
   */
  async function removeWhere(predicate) {
    return enqueue(async () => {
      const items = await readAll();
      const rest = items.filter((item) => !predicate(item));
      if (rest.length === items.length) return 0;

      await writeAll(rest);
      return items.length - rest.length;
    });
  }

  /** Полная перезапись — для миграций и служебных скриптов (seed). */
  async function replaceAll(items) {
    return enqueue(async () => {
      const normalized = items.map(toRecord).filter(Boolean);
      await writeAll(normalized);
      return normalized.map((item) => ({ ...item }));
    });
  }

  /** Создаёт хранилище коллекции, если его ещё нет. Вызывается один раз при старте сервера. */
  async function init() {
    await enqueue(() => backend.ensure(name));
  }

  const api = {
    name,
    file,
    init,
    list,
    getById,
    find,
    filter,
    count,
    create,
    createMany,
    update,
    updateWhere,
    remove,
    removeWhere,
    replaceAll,
  };

  registry.set(name, { name, prefix, toRecord, readAll, writeAll, readAllSync, writeAllSync, api });

  return api;
}

/**
 * Уже объявленная коллекция по имени.
 *
 * Нужна служебным скриптам, которым требуется доступ ко всем коллекциям разом —
 * в том числе к тем, чья модель не отдаёт наружу низкоуровневые методы
 * (например, users не экспортирует replaceAll). В коде приложения не используется:
 * там коллекция всегда приходит из своей модели.
 */
function collectionOf(name) {
  const internals = registry.get(name);
  if (!internals) throw new Error(`Коллекция «${name}» не объявлена.`);
  return internals.api;
}

/** Имена всех объявленных на момент вызова коллекций — для скриптов вроде переноса данных. */
function collectionNames() {
  return [...registry.keys()];
}

// ------------------------------------------------------------- транзакции

/**
 * Доступ к одной коллекции внутри транзакции. Работает с массивом в памяти,
 * поэтому все методы синхронные — очередь и диск здесь не участвуют.
 * Правила движка те же, что у коллекции: нормализация, префикс id, метки времени,
 * защита id и createdAt, копии записей наружу.
 */
function transactionScope(state) {
  const { internals } = state;
  const indexOf = (id) => state.items.findIndex((item) => item.id === id);
  const copy = (item) => ({ ...item });

  return {
    list: () => state.items.map(copy),
    getById: (id) => {
      const found = typeof id === 'string' && id ? state.items.find((item) => item.id === id) : null;
      return found ? copy(found) : null;
    },
    find: (predicate) => {
      const found = state.items.find(predicate);
      return found ? copy(found) : null;
    },
    filter: (predicate) => state.items.filter(predicate).map(copy),

    insert(data) {
      const now = new Date().toISOString();
      const record = internals.toRecord({
        ...data,
        id: createId(internals.prefix),
        createdAt: now,
        updatedAt: now,
      });
      if (!record) throw new Error(`Не удалось создать запись в «${internals.name}».`);

      state.items.push(record);
      state.dirty = true;
      return copy(record);
    },

    /** patch — объект с полями либо функция (current) => патч, как в collection.update. */
    update(id, patch) {
      const index = indexOf(id);
      if (index === -1) return null;

      const current = state.items[index];
      const changes = typeof patch === 'function' ? patch(copy(current)) : patch;
      if (!changes) return copy(current);

      const merged = { ...current, ...changes, id: current.id, createdAt: current.createdAt };
      merged.updatedAt = new Date().toISOString();

      const record = internals.toRecord(merged);
      if (!record) return null;

      // Запись подменяется целиком, а не правится по месту: тот же объект лежит в кэше.
      state.items[index] = record;
      state.dirty = true;
      return copy(record);
    },

    remove(id) {
      const index = indexOf(id);
      if (index === -1) return false;

      state.items.splice(index, 1);
      state.dirty = true;
      return true;
    },
  };
}

/**
 * Ход транзакции, одинаковый для обоих движков: собрать scope из прочитанных записей,
 * выполнить обработчик, отдать список тронутых коллекций. Чтением и записью занимается
 * движок — он же решает, чем их обернуть.
 */
function openTransaction(names, targets, fn) {
  const states = [];
  const scope = {};

  return {
    /** @param {Array<Array<object>>} loaded записи коллекций в порядке targets */
    load(loaded) {
      targets.forEach((internals, index) => {
        // slice() — копия массива: сам кэш менять нельзя, пока транзакция не завершилась.
        const state = { internals, items: loaded[index].slice(), dirty: false };
        states.push(state);
        scope[internals.name] = transactionScope(state);
      });
    },
    run() {
      return transactionContext.run({ names }, () => fn(scope));
    },
    dirtyStates() {
      return states.filter((state) => state.dirty);
    },
  };
}

/**
 * Транзакция уровня модуля: одна постановка в очередь на несколько коллекций.
 *
 * Зачем: методы коллекции сами встают в очередь, поэтому связка «прочитать → проверить →
 * записать» из двух вызовов не атомарна — между ними проходит параллельный запрос
 * (двойной клик по «Начислить» заводил два начисления, конвертация одной заявки —
 * несколько карточек ученика). Транзакция читает и пишет всё в одном месте очереди.
 *
 * Внутри обработчика доступны только коллекции из scope: обычные методы моделей
 * (store.create и т. п.) снова встанут в очередь и получат ошибку из enqueue.
 *
 * На sqlite чтение, обработчик и запись идут одним BEGIN…COMMIT: при исключении
 * откатываются все коллекции разом. На json каждая коллекция пишется атомарно сама
 * по себе, но общего журнала на несколько файлов нет — если диск откажет между
 * записями, часть изменений уцелеет.
 *
 * @param {string[]} names  имена коллекций, к которым нужен доступ ('applications', 'students'…)
 * @param {(scope: Record<string, object>) => any} fn  вернуть можно что угодно — это станет результатом transaction
 * @returns {Promise<any>} результат fn; при исключении внутри fn данные не меняются
 */
async function transaction(names, fn) {
  const targets = names.map((name) => {
    const internals = registry.get(name);
    if (!internals) throw new Error(`Коллекция «${name}» не объявлена — транзакция невозможна.`);
    return internals;
  });

  return enqueue(() => backend.runTransaction(targets, openTransaction(names, targets, fn)));
}

// ----------------------------------------------------------- общие утилиты

function asText(value, maxLength = 0) {
  let text;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else text = '';

  text = text.trim();
  return maxLength > 0 ? text.slice(0, maxLength) : text;
}

function asInt(value, fallback = null) {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Деньги храним в рублях целым числом: копейки школе не нужны, а float даёт погрешность. */
function asMoney(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
}

function asBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  return fallback;
}

function asIsoDateTime(value, fallback = null) {
  const text = asText(value);
  if (!text) return fallback;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Календарная дата YYYY-MM-DD без времени и часового пояса.
 *
 * Формата мало: ему одинаково соответствуют 2026-02-30 и 2026-13-01, а такая «дата»
 * потом молча уезжала в занятие или в период отчёта. Поэтому день сверяется с календарём.
 * Считаем сами, без new Date(): конструктор переносит лишние дни на следующий месяц
 * (2026-02-30 → 2 марта) и по-своему трактует годы 0–99.
 */
function asDay(value) {
  const text = asText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';

  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));

  if (month < 1 || month > 12 || day < 1) return '';

  const limit = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= limit ? text : '';
}

/** Время HH:MM в 24-часовом формате. */
function asTime(value) {
  const text = asText(value);
  if (!/^\d{1,2}:\d{2}$/.test(text)) return '';

  const [hours, minutes] = text.split(':').map((part) => Number.parseInt(part, 10));
  if (hours > 23 || minutes > 59) return '';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function asStringArray(value, maxItems = 50, maxLength = 120) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];

  for (const item of value) {
    const text = asText(item, maxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maxItems) break;
  }

  return result;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

module.exports = {
  dataDir: DATA_DIR,
  engine: backend.id,
  collection,
  collectionOf,
  collectionNames,
  transaction,
  createId,
  enqueue,
  asText,
  asInt,
  asMoney,
  asBool,
  asIsoDateTime,
  asDay,
  asTime,
  asStringArray,
  oneOf,
};
