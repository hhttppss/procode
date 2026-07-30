'use strict';

/**
 * Движок хранения: одна JSON-коллекция = один файл в data/.
 *
 * Правила, унаследованные от первой версии проекта (заявки) и распространённые на все данные:
 *  • запись атомарная (временный файл + rename) — файл нельзя получить наполовину записанным;
 *  • все изменяющие операции выстроены в общую промис-очередь — параллельные запросы не затирают друг друга;
 *  • битый JSON не роняет сервер: файл уходит в карантин, работа продолжается с пустым списком;
 *  • чтение кэшируется по mtime файла — дашборд читает пять коллекций и не упирается в диск.
 *
 * Очередь одна на все коллекции: операции на разных файлах не конфликтуют, но и не идут
 * настолько часто, чтобы последовательность стала узким местом. Зато нет шанса словить
 * гонку при связанных изменениях (например, «конвертировать заявку в ученика»).
 *
 * Очередь сериализует отдельные вызовы, но не связки «прочитать → проверить → записать»:
 * между двумя такими вызовами успевает пройти параллельный запрос. Для этого есть
 * transaction() — см. раздел «транзакции» ниже.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const DATA_DIR = path.join(__dirname, '..', 'data');

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

// ------------------------------------------------------------------ файлы

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

// ------------------------------------------------------------- коллекция

/**
 * Внутреннее устройство коллекций по имени: чтение и запись в обход очереди,
 * нормализация, префикс идентификаторов. Нужно транзакциям — они работают
 * с несколькими коллекциями внутри одного места в очереди.
 */
const registry = new Map();

/**
 * @param {string} name        имя файла без расширения (students → data/students.json)
 * @param {object} options
 * @param {Function} options.normalize  приводит запись к ожидаемой форме; вернуть null — запись отбрасывается
 * @param {string}  options.prefix      префикс идентификаторов (st, ls, pm…)
 */
function collection(name, { normalize, prefix } = {}) {
  // Две коллекции с одним именем — это два независимых кэша над одним файлом:
  // они будут затирать правки друг друга, поэтому такую ошибку ловим сразу.
  if (registry.has(name)) throw new Error(`Коллекция «${name}» уже объявлена.`);

  const file = path.join(DATA_DIR, `${name}.json`);
  const toRecord = typeof normalize === 'function' ? normalize : (item) => item;

  // Кэш живёт до изменения файла: правку JSON руками подхватываем без перезапуска сервера.
  let cache = { key: null, items: [] };

  function cacheKey() {
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  async function readAll() {
    const key = cacheKey();
    if (key === null) return [];
    if (key === cache.key) return cache.items;

    try {
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('ожидался массив записей');

      const items = parsed.map(toRecord).filter(Boolean);
      cache = { key, items };
      return items;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      await quarantine(file, error.message);
      cache = { key: null, items: [] };
      return [];
    }
  }

  async function writeAll(items) {
    await writeFileAtomic(file, items);
    cache = { key: null, items: [] }; // ключ пересчитается при следующем чтении
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

  /** Массовое создание одной записью в файл — для повторяющихся занятий. */
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

  async function remove(id) {
    return enqueue(async () => {
      const items = await readAll();
      const rest = items.filter((item) => item.id !== id);
      if (rest.length === items.length) return false;

      await writeAll(rest);
      return true;
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

  /** Создаёт файл, если его ещё нет. Вызывается один раз при старте сервера. */
  async function init() {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    try {
      await fsp.access(file);
    } catch {
      await enqueue(() => writeAll([]));
    }
  }

  registry.set(name, { name, prefix, toRecord, readAll, writeAll });

  return {
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
    remove,
    replaceAll,
  };
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
 * Файлы пишутся по одному (каждый — атомарно, через временный файл и rename).
 * Общего журнала на несколько файлов нет: если диск откажет между записями, часть
 * изменений уцелеет. Для школьной базы это приемлемо, а вот гонка — нет.
 *
 * @param {string[]} names  имена коллекций, к которым нужен доступ ('applications', 'students'…)
 * @param {(scope: Record<string, object>) => any} fn  вернуть можно что угодно — это станет результатом transaction
 * @returns {Promise<any>} результат fn; при исключении внутри fn файлы не меняются
 */
async function transaction(names, fn) {
  const targets = names.map((name) => {
    const internals = registry.get(name);
    if (!internals) throw new Error(`Коллекция «${name}» не объявлена — транзакция невозможна.`);
    return internals;
  });

  return enqueue(async () => {
    const states = [];
    const scope = {};

    for (const internals of targets) {
      // slice() — копия массива: сам кэш менять нельзя, пока транзакция не завершилась.
      const state = { internals, items: (await internals.readAll()).slice(), dirty: false };
      states.push(state);
      scope[internals.name] = transactionScope(state);
    }

    const result = await transactionContext.run({ names }, () => fn(scope));

    // Сохраняем только тронутые коллекции и только после успешного fn:
    // исключение внутри — правки остались в памяти и просто пропали вместе со scope.
    for (const state of states) {
      if (state.dirty) await state.internals.writeAll(state.items);
    }

    return result;
  });
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
  collection,
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
