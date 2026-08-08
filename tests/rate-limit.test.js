'use strict';

/**
 * Счётчик обращений в скользящем окне (server/auth.js: createRateLimiter).
 *
 * На нём держатся три защиты: подбор пароля на входе, поток заявок с лендинга
 * и частота обращений к внутреннему API. Ошибка в арифметике окна либо снимает защиту
 * молча, либо запирает живого сотрудника — и то и другое обнаруживается уже в бою.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../server/auth');

test('лимит срабатывает ровно после указанного числа обращений', () => {
  const limiter = createRateLimiter({ limit: 3, windowMs: 10000 });

  assert.equal(limiter.isBlocked('ключ'), false);
  assert.equal(limiter.hit('ключ'), 1);
  assert.equal(limiter.hit('ключ'), 2);
  assert.equal(limiter.isBlocked('ключ'), false, 'третье обращение ещё разрешено');

  assert.equal(limiter.hit('ключ'), 3);
  assert.equal(limiter.isBlocked('ключ'), true);
});

test('ключи не мешают друг другу: за одним NAT сидят разные сотрудники', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 10000 });

  limiter.hit('u:первый');

  assert.equal(limiter.isBlocked('u:первый'), true);
  assert.equal(limiter.isBlocked('u:второй'), false);
});

test('retryAfter показывает, когда освободится место, и обнуляется до лимита', () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 10000 });

  limiter.hit('ключ');
  assert.equal(limiter.retryAfter('ключ'), 0, 'ждать нечего, пока лимит не исчерпан');

  limiter.hit('ключ');
  const wait = limiter.retryAfter('ключ');
  assert.ok(wait > 0 && wait <= 10, `ожидание должно уложиться в окно, получено ${wait}`);
});

test('отметки уходят из окна, а reset снимает ограничение сразу', async () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 40, sweepMs: 0 });

  limiter.hit('ключ');
  assert.equal(limiter.isBlocked('ключ'), true);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(limiter.isBlocked('ключ'), false, 'скользящее окно обязано отпускать старые отметки');

  limiter.hit('ключ');
  limiter.reset('ключ');
  assert.equal(limiter.isBlocked('ключ'), false, 'reset нужен успешному входу — иначе он копил бы чужие неудачи');
});
