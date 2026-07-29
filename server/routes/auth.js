'use strict';

/**
 * Вход и выход из платформы.
 *
 * Ответ на неудачную попытку намеренно одинаков и для несуществующего логина,
 * и для неверного пароля: подбирать логины по разнице сообщений нельзя.
 * Отдельно сообщается только о блокировке — иначе заблокированный преподаватель
 * будет думать, что забыл пароль.
 */

const express = require('express');
const path = require('path');

const auth = require('../auth');
const db = require('../db');
const users = require('../models/users');
const { wrap, bodyOf } = require('./api/helpers');

const router = express.Router();

const LOGIN_VIEW = path.join(__dirname, '..', 'views', 'login.html');

/** Возврат после входа разрешён только внутрь платформы: чужие адреса отбрасываем. */
function safeNext(value) {
  const target = db.asText(value, 200);
  return /^\/app(\/|$|\?)/.test(target) ? target : '/app';
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  return res.sendFile(LOGIN_VIEW);
});

router.post(
  '/login',
  wrap(async (req, res) => {
    const body = bodyOf(req);

    if (auth.isLoginBlocked(req)) {
      return res.status(429).json({
        ok: false,
        message: 'Слишком много неудачных попыток входа. Подождите 15 минут и попробуйте снова.',
      });
    }

    const result = await auth.checkCredentials(body.login, body.password);

    if (!result.ok) {
      auth.registerLoginFailure(req);

      if (result.reason === 'blocked') {
        return res.status(403).json({
          ok: false,
          message: 'Доступ к системе закрыт. Обратитесь к администратору школы.',
        });
      }

      return res.status(401).json({ ok: false, message: 'Неверный логин или пароль.' });
    }

    auth.registerLoginSuccess(req);
    auth.setSession(req, res, result.user);

    if (!result.user.fromEnv) await users.touchLogin(result.user.id);

    return res.json({ ok: true, redirect: safeNext(body.next) });
  })
);

router.post('/logout', (req, res) => {
  auth.clearSession(req, res);
  return res.json({ ok: true });
});

module.exports = router;
