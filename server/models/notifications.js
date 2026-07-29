'use strict';

/**
 * Уведомления внутри интерфейса: data/notifications.json.
 *
 * Внешних каналов (почта, мессенджеры) нет намеренно — им нужны сторонние сервисы
 * и ключи. Здесь достаточно значка в шапке: страница опрашивает /app/api/notifications
 * раз в полминуты и показывает непрочитанные.
 *
 * Каждое уведомление адресовано конкретному сотруднику: рассылка администраторам —
 * это несколько записей, по одной на каждого.
 */

const db = require('../db');

const MAX_PER_USER = 100;

const TYPES = ['application', 'lesson', 'student', 'system'];

function normalize(record) {
  if (!record || typeof record !== 'object') return null;
  if (!db.asText(record.userId)) return null;

  const createdAt = db.asIsoDateTime(record.createdAt) || new Date().toISOString();

  return {
    id: db.asText(record.id) || db.createId('nt'),
    createdAt,
    updatedAt: db.asIsoDateTime(record.updatedAt) || createdAt,
    userId: db.asText(record.userId),
    type: db.oneOf(record.type, TYPES, 'system'),
    title: db.asText(record.title, 160),
    text: db.asText(record.text, 500),
    link: db.asText(record.link, 300),
    read: db.asBool(record.read, false),
  };
}

const store = db.collection('notifications', { normalize, prefix: 'nt' });

async function listForUser(userId, { limit = 30 } = {}) {
  const items = await store.filter((item) => item.userId === userId);
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

async function countUnread(userId) {
  return store.count((item) => item.userId === userId && !item.read);
}

async function push(userId, { type, title, text, link }) {
  if (!userId) return null;
  return store.create({ userId, type, title, text, link, read: false });
}

/** Рассылка нескольким адресатам сразу — например, всем администраторам. */
async function pushMany(userIds, payload) {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return [];

  return store.createMany(
    unique.map((userId) => ({
      userId,
      type: payload.type,
      title: payload.title,
      text: payload.text,
      link: payload.link,
      read: false,
    }))
  );
}

async function markRead(id, userId) {
  const item = await store.getById(id);
  if (!item || item.userId !== userId) return null;
  return store.update(id, { read: true });
}

async function markAllRead(userId) {
  const items = await store.filter((item) => item.userId === userId && !item.read);
  for (const item of items) await store.update(item.id, { read: true });
  return items.length;
}

/** Подрезает историю, чтобы файл не рос бесконечно. Вызывается после рассылки. */
async function trim(userId) {
  const items = await store.filter((item) => item.userId === userId);
  if (items.length <= MAX_PER_USER) return 0;

  const extra = items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, items.length - MAX_PER_USER);
  for (const item of extra) await store.remove(item.id);
  return extra.length;
}

/** Удаляет уведомления сотрудника вместе с его учётной записью. */
async function removeForUser(userId) {
  const items = await store.filter((item) => item.userId === userId);
  for (const item of items) await store.remove(item.id);
  return items.length;
}

module.exports = {
  file: store.file,
  TYPES,
  init: store.init,
  list: store.list,
  listForUser,
  countUnread,
  push,
  pushMany,
  markRead,
  markAllRead,
  trim,
  removeForUser,
  replaceAll: store.replaceAll,
};
