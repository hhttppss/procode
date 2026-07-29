'use strict';

/**
 * Хранилище заявок в JSON-файле.
 *
 * Особенности:
 *  • запись атомарная (временный файл + rename), чтобы файл нельзя было получить наполовину записанным;
 *  • все изменяющие операции выстроены в промис-очередь — параллельные запросы не затирают друг друга;
 *  • битый JSON не роняет сервер: файл уходит в карантин, работа продолжается с пустым списком.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'applications.json');

/**
 * Единый список статусов: используется сервером (валидация, CSV) и админкой
 * (плитки, фильтры, выпадающие списки). Порядок = порядок вывода в интерфейсе.
 */
const STATUSES = [
  { id: 'new', label: 'Новая' },
  { id: 'agreed', label: 'Согласился' },
  { id: 'thinking', label: 'Думает' },
  { id: 'callback', label: 'Перезвонить' },
  { id: 'noanswer', label: 'Недозвон' },
  { id: 'refused', label: 'Отказ' },
];

const STATUS_IDS = STATUSES.map((status) => status.id);
const DEFAULT_STATUS = 'new';
const DEFAULT_SOURCE = 'landing';

/** Поля, которые разрешено менять через update() — защита от подмены createdAt и id. */
const EDITABLE_FIELDS = ['status', 'managerComment'];

function isValidStatus(id) {
  return STATUS_IDS.includes(id);
}

function statusLabel(id) {
  const found = STATUSES.find((status) => status.id === id);
  return found ? found.label : id;
}

function createId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function asAge(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/** Приводит запись к ожидаемой форме — на случай ручной правки JSON владельцем. */
function normalize(record) {
  if (!record || typeof record !== 'object') return null;

  const createdAt = asText(record.createdAt) || new Date(0).toISOString();

  return {
    id: asText(record.id) || createId(),
    createdAt,
    updatedAt: asText(record.updatedAt) || createdAt,
    parentName: asText(record.parentName),
    phone: asText(record.phone),
    childName: asText(record.childName),
    childAge: asAge(record.childAge),
    course: asText(record.course),
    comment: asText(record.comment),
    status: isValidStatus(record.status) ? record.status : DEFAULT_STATUS,
    managerComment: asText(record.managerComment),
    source: asText(record.source) || DEFAULT_SOURCE,
  };
}

async function quarantineFile(reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(DATA_DIR, `applications.corrupt-${stamp}.json`);

  console.error(`Файл ${DATA_FILE} повреждён (${reason}). Сохраняю копию: ${target}`);

  try {
    await fsp.rename(DATA_FILE, target);
  } catch (error) {
    console.error(`Не удалось переименовать повреждённый файл: ${error.message}`);
  }
}

async function readAll() {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('ожидался массив заявок');
    return parsed.map(normalize).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    await quarantineFile(error.message);
    return [];
  }
}

async function writeAll(items) {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  const tempFile = `${DATA_FILE}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;

  try {
    await fsp.writeFile(tempFile, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
    await fsp.rename(tempFile, DATA_FILE);
  } catch (error) {
    await fsp.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

/** Очередь записи: следующая операция стартует только после завершения предыдущей. */
let writeQueue = Promise.resolve();

function enqueue(task) {
  const result = writeQueue.then(task, task);
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Создаёт файл и папку, если их ещё нет. Вызывается один раз при старте сервера. */
async function init() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(DATA_FILE);
  } catch {
    await enqueue(() => writeAll([]));
  }
}

async function list() {
  return readAll();
}

async function getById(id) {
  const items = await readAll();
  return items.find((item) => item.id === id) || null;
}

function buildRecord(data) {
  const now = new Date().toISOString();
  const createdAt = asText(data.createdAt) || now;

  return {
    id: createId(),
    createdAt,
    updatedAt: asText(data.updatedAt) || createdAt,
    parentName: asText(data.parentName),
    phone: asText(data.phone),
    childName: asText(data.childName),
    childAge: asAge(data.childAge),
    course: asText(data.course),
    comment: asText(data.comment),
    status: isValidStatus(data.status) ? data.status : DEFAULT_STATUS,
    managerComment: asText(data.managerComment),
    source: asText(data.source) || DEFAULT_SOURCE,
  };
}

async function create(data) {
  return enqueue(async () => {
    const items = await readAll();
    const record = buildRecord(data);
    items.push(record);
    await writeAll(items);
    return record;
  });
}

async function update(id, patch) {
  return enqueue(async () => {
    const items = await readAll();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return null;

    const updated = { ...items[index] };
    for (const field of EDITABLE_FIELDS) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, field)) {
        updated[field] = patch[field];
      }
    }
    updated.updatedAt = new Date().toISOString();

    items[index] = normalize(updated);
    await writeAll(items);
    return items[index];
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

/** Полная перезапись — только для служебных скриптов (seed-demo). */
async function replaceAll(items) {
  return enqueue(async () => {
    const normalized = items.map(normalize).filter(Boolean);
    await writeAll(normalized);
    return normalized;
  });
}

module.exports = {
  STATUSES,
  STATUS_IDS,
  DEFAULT_STATUS,
  dataFile: DATA_FILE,
  isValidStatus,
  statusLabel,
  init,
  list,
  getById,
  create,
  update,
  remove,
  replaceAll,
};
