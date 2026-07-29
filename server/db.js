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
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

/** Уникальный идентификатор: время (для сортировки) + случайная часть (для уникальности). */
function createId(prefix) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
  return prefix ? `${prefix}_${id}` : id;
}

// ------------------------------------------------------------------- очередь

let queue = Promise.resolve();

/** Ставит операцию в общую очередь: следующая стартует только после завершения предыдущей. */
function enqueue(task) {
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
 * @param {string} name        имя файла без расширения (students → data/students.json)
 * @param {object} options
 * @param {Function} options.normalize  приводит запись к ожидаемой форме; вернуть null — запись отбрасывается
 * @param {string}  options.prefix      префикс идентификаторов (st, ls, pm…)
 */
function collection(name, { normalize, prefix } = {}) {
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

/** Календарная дата YYYY-MM-DD без времени и часового пояса. */
function asDay(value) {
  const text = asText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
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
