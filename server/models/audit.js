'use strict';

/**
 * История изменений: data/audit.json.
 *
 * Одна запись = одно действие сотрудника над сущностью (карточкой ученика, занятием,
 * учётной записью). Хранится отдельно от самих данных, чтобы карточка не распухала,
 * а историю можно было показать одинаково для любого модуля.
 */

const db = require('../db');

const MAX_ENTRIES = 5000;

function normalizeChange(change) {
  if (!change || typeof change !== 'object') return null;
  const field = db.asText(change.field, 60);
  if (!field) return null;

  return {
    field,
    label: db.asText(change.label, 120) || field,
    from: db.asText(change.from, 300),
    to: db.asText(change.to, 300),
  };
}

function normalize(record) {
  if (!record || typeof record !== 'object') return null;

  const createdAt = db.asIsoDateTime(record.createdAt) || new Date().toISOString();

  return {
    id: db.asText(record.id) || db.createId('au'),
    createdAt,
    updatedAt: createdAt,
    entity: db.asText(record.entity, 40),
    entityId: db.asText(record.entityId),
    action: db.asText(record.action, 40) || 'update',
    byId: db.asText(record.byId),
    byName: db.asText(record.byName, 120) || 'система',
    comment: db.asText(record.comment, 500),
    changes: Array.isArray(record.changes) ? record.changes.map(normalizeChange).filter(Boolean) : [],
  };
}

const store = db.collection('audit', { normalize, prefix: 'au' });

/**
 * Сравнивает две версии записи по описанию полей и возвращает список изменений.
 * @param {object} before
 * @param {object} after
 * @param {Array<{field: string, label: string, format?: Function}>} fields
 */
function diff(before, after, fields) {
  const changes = [];

  for (const { field, label, format } of fields) {
    const from = before ? before[field] : undefined;
    const to = after ? after[field] : undefined;

    const asString = (value) => {
      if (value === undefined || value === null) return '';
      if (format) return String(format(value) ?? '');
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    };

    const fromText = asString(from);
    const toText = asString(to);
    if (fromText === toText) continue;

    changes.push({ field, label, from: fromText, to: toText });
  }

  return changes;
}

async function log({ entity, entityId, action, actor, changes, comment }) {
  if (Array.isArray(changes) && changes.length === 0 && action === 'update') return null;

  const entry = await store.create({
    entity,
    entityId,
    action: action || 'update',
    byId: actor ? actor.id : '',
    byName: actor ? actor.name || actor.login : 'система',
    comment: comment || '',
    changes: changes || [],
  });

  await trim();
  return entry;
}

async function listFor(entity, entityId, { limit = 50 } = {}) {
  const items = await store.filter((item) => item.entity === entity && item.entityId === entityId);
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** Не даём файлу расти бесконечно: держим последние MAX_ENTRIES событий. */
let trimming = false;

async function trim() {
  if (trimming) return 0;
  trimming = true;

  try {
    const items = await store.list();
    if (items.length <= MAX_ENTRIES) return 0;

    const kept = items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(items.length - MAX_ENTRIES);
    await store.replaceAll(kept);
    return items.length - kept.length;
  } finally {
    trimming = false;
  }
}

/** Стирает историю удалённой сущности — одной перезаписью коллекции. */
async function removeFor(entity, entityId) {
  return store.removeWhere((item) => item.entity === entity && item.entityId === entityId);
}

module.exports = {
  file: store.file,
  init: store.init,
  diff,
  log,
  listFor,
  removeFor,
  replaceAll: store.replaceAll,
};
