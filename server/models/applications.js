'use strict';

/**
 * Заявки с лендинга: data/applications.json.
 *
 * Воронка: Новая → В обработке → Назначено вводное → Ученик зачислен / Отказ.
 * Каждое изменение статуса и каждый комментарий менеджера ложатся в history —
 * так видно, кто и когда что сделал с заявкой.
 */

const fsp = require('fs/promises');

const db = require('../db');
const catalog = require('../domain/catalog');

const MAX_COMMENT = 2000;
const MAX_HISTORY = 60;

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const at = db.asIsoDateTime(entry.at);
  if (!at) return null;

  return {
    at,
    byId: db.asText(entry.byId),
    byName: db.asText(entry.byName, 120),
    action: db.asText(entry.action, 40) || 'comment',
    text: db.asText(entry.text, MAX_COMMENT),
  };
}

function normalize(record) {
  if (!record || typeof record !== 'object') return null;

  const createdAt = db.asIsoDateTime(record.createdAt) || new Date(0).toISOString();

  // Статусы первой версии («Думает», «Недозвон»…) переводим в новую воронку.
  const rawStatus = db.asText(record.status);
  const status = catalog.APPLICATION_STATUS_IDS.includes(rawStatus)
    ? rawStatus
    : catalog.LEGACY_APPLICATION_STATUS[rawStatus] || catalog.DEFAULT_APPLICATION_STATUS;

  return {
    id: db.asText(record.id) || db.createId('ap'),
    createdAt,
    updatedAt: db.asIsoDateTime(record.updatedAt) || createdAt,
    parentName: db.asText(record.parentName, 120),
    phone: db.asText(record.phone, 40),
    email: db.asText(record.email, 120),
    childName: db.asText(record.childName, 120),
    childAge: db.asInt(record.childAge),
    course: db.asText(record.course, 120),
    comment: db.asText(record.comment, MAX_COMMENT),
    status,
    managerComment: db.asText(record.managerComment, MAX_COMMENT),
    source: db.asText(record.source, 40) || 'landing',
    // Заполняется при конвертации в ученика — повторно заявку уже не конвертировать.
    studentId: db.asText(record.studentId),
    history: Array.isArray(record.history)
      ? record.history.map(normalizeHistoryEntry).filter(Boolean).slice(-MAX_HISTORY)
      : [],
  };
}

const store = db.collection('applications', { normalize, prefix: 'ap' });

function historyEntry(actor, action, text) {
  return {
    at: new Date().toISOString(),
    byId: actor ? actor.id : '',
    byName: actor ? actor.name || actor.login : 'система',
    action,
    text: text || '',
  };
}

/** Добавляет запись в историю, не давая ей расти бесконечно. */
function appendHistory(current, entry) {
  return [...(current.history || []), entry].slice(-MAX_HISTORY);
}

async function create(data) {
  return store.create({ ...data, history: [] });
}

/**
 * Меняет статус и/или комментарий менеджера, попутно записывая событие в историю.
 * @param {object} actor  сотрудник, выполняющий действие
 */
async function applyChanges(id, { status, managerComment }, actor) {
  return store.update(id, (current) => {
    const changes = {};
    let history = current.history || [];

    if (status !== undefined && status !== current.status) {
      changes.status = status;
      history = appendHistory(
        { history },
        historyEntry(
          actor,
          'status',
          `${catalog.labelOf(catalog.APPLICATION_STATUSES, current.status)} → ${catalog.labelOf(
            catalog.APPLICATION_STATUSES,
            status
          )}`
        )
      );
    }

    if (managerComment !== undefined && managerComment !== current.managerComment) {
      changes.managerComment = managerComment;
      history = appendHistory({ history }, historyEntry(actor, 'comment', managerComment || '(комментарий очищен)'));
    }

    if (Object.keys(changes).length === 0) return null;

    changes.history = history;
    return changes;
  });
}

/** Отмечает заявку как превращённую в карточку ученика. */
async function linkStudent(id, studentId, actor) {
  return store.update(id, (current) => ({
    studentId,
    status: 'enrolled',
    history: appendHistory(current, historyEntry(actor, 'convert', 'Заявка превращена в карточку ученика')),
  }));
}

/** Сколько заявок пришло за период (для дашборда). */
async function countCreatedBetween(fromMs, toMs) {
  return store.count((item) => {
    const at = new Date(item.createdAt).getTime();
    return Number.isFinite(at) && at >= fromMs && at <= toMs;
  });
}

// --------------------------------------------------------------- миграция

/** Разово переписывает файл первой версии: старые статусы → новая воронка. */
async function migrate() {
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(store.file, 'utf8'));
  } catch {
    return false;
  }

  if (!Array.isArray(raw) || raw.length === 0) return false;

  const needsMigration = raw.some(
    (record) =>
      record &&
      typeof record === 'object' &&
      (!catalog.APPLICATION_STATUS_IDS.includes(record.status) || !Array.isArray(record.history))
  );
  if (!needsMigration) return false;

  await store.replaceAll(raw);
  console.log(`Заявки переведены на новую воронку статусов (${raw.length} шт.).`);
  return true;
}

module.exports = {
  file: store.file,
  MAX_COMMENT,
  init: store.init,
  migrate,
  list: store.list,
  filter: store.filter,
  getById: store.getById,
  count: store.count,
  create,
  update: store.update,
  remove: store.remove,
  replaceAll: store.replaceAll,
  applyChanges,
  linkStudent,
  countCreatedBetween,
};
