'use strict';

/**
 * Уведомления внутри интерфейса.
 * Каждый сотрудник видит только адресованные ему записи — выборка идёт по req.user.id,
 * идентификатор из запроса не принимается вовсе.
 */

const express = require('express');

const notifications = require('../../models/notifications');
const { wrap, fail } = require('./helpers');

const router = express.Router();

router.get(
  '/',
  wrap(async (req, res) => {
    const [items, unread] = await Promise.all([
      notifications.listForUser(req.user.id),
      notifications.countUnread(req.user.id),
    ]);

    res.json({ ok: true, items, unread });
  })
);

router.post(
  '/read-all',
  wrap(async (req, res) => {
    const count = await notifications.markAllRead(req.user.id);
    res.json({ ok: true, count });
  })
);

router.post(
  '/:id/read',
  wrap(async (req, res) => {
    const item = await notifications.markRead(req.params.id, req.user.id);
    if (!item) return fail(res, 404, 'Уведомление не найдено.');
    return res.json({ ok: true, item });
  })
);

module.exports = router;
