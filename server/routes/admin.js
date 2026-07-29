'use strict';

/**
 * Админ-панель: вход, список заявок, изменение статуса и выгрузка в CSV.
 * Все API-ответы имеют единый вид { ok: boolean, ... }.
 */

const express = require('express');
const fsp = require('fs/promises');
const path = require('path');

const auth = require('../auth');
const store = require('../store');

const router = express.Router();

const VIEWS_DIR = path.join(__dirname, '..', 'views');
const LOGIN_VIEW = path.join(VIEWS_DIR, 'login.html');
const ADMIN_VIEW = path.join(VIEWS_DIR, 'admin.html');

const MAX_MANAGER_COMMENT = 2000;
const MAX_QUERY_LENGTH = 100;

// ------------------------------------------------------------ фильтры списка

function parseDayBoundary(value, endOfDay) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  // Без указания зоны такая строка трактуется как местное время — как её и вводит менеджер.
  const parsed = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function matchesQuery(item, query) {
  const haystack = [item.parentName, item.childName, item.phone, item.course, item.comment, item.managerComment]
    .join(' ')
    .toLowerCase();

  if (haystack.includes(query)) return true;

  // Поиск по телефону без учёта форматирования: «8 (916) 555» найдёт +79165551122.
  const queryDigits = query.replace(/\D/g, '');
  if (queryDigits.length < 3) return false;

  const phoneDigits = item.phone.replace(/\D/g, '');
  if (phoneDigits.includes(queryDigits)) return true;

  // Менеджер набирает номер через 8, а храним мы его через 7.
  return queryDigits.startsWith('8') && phoneDigits.includes(`7${queryDigits.slice(1)}`);
}

function selectItems(items, query) {
  const status = typeof query.status === 'string' && store.isValidStatus(query.status) ? query.status : 'all';
  const search = typeof query.q === 'string' ? query.q.trim().slice(0, MAX_QUERY_LENGTH).toLowerCase() : '';
  const from = parseDayBoundary(query.from, false);
  const to = parseDayBoundary(query.to, true);
  const sort = query.sort === 'old' ? 'old' : 'new';

  const filtered = items.filter((item) => {
    if (status !== 'all' && item.status !== status) return false;

    const createdAt = new Date(item.createdAt).getTime();
    if (from !== null && (Number.isNaN(createdAt) || createdAt < from)) return false;
    if (to !== null && (Number.isNaN(createdAt) || createdAt > to)) return false;

    if (search && !matchesQuery(item, search)) return false;

    return true;
  });

  filtered.sort((a, b) => {
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return sort === 'old' ? diff : -diff;
  });

  return filtered;
}

/** Счётчики считаются по всей базе, а не по отфильтрованной выборке. */
function countByStatus(items) {
  const counts = { all: items.length };
  for (const status of store.STATUSES) counts[status.id] = 0;
  for (const item of items) {
    if (counts[item.status] !== undefined) counts[item.status] += 1;
  }
  return counts;
}

// ------------------------------------------------------------------- страницы

/** Список статусов уезжает в браузер вместе со страницей — админка не дублирует подписи. */
let adminTemplateCache = null;

async function loadAdminTemplate() {
  if (!adminTemplateCache) {
    const raw = await fsp.readFile(ADMIN_VIEW, 'utf8');
    const json = JSON.stringify(store.STATUSES).replace(/</g, '\\u003c');
    // Замена функцией, а не строкой: иначе последовательности вида $& в подстановке
    // были бы истолкованы как ссылки на совпадение.
    adminTemplateCache = raw.replace('<!--{{STATUSES}}-->', () => `<script>window.PC_STATUSES = ${json};</script>`);
  }
  return adminTemplateCache;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Логин попадает прямо в разметку, поэтому экранируем — даже собственные значения. */
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** Страница собирается под конкретного менеджера: в шапке показан его логин. */
async function renderAdminPage(login) {
  const template = await loadAdminTemplate();
  return template.replace('<!--{{USER}}-->', () => escapeHtml(login));
}

router.get('/login', (req, res) => {
  if (auth.getSession(req)) return res.redirect('/admin');
  return res.sendFile(LOGIN_VIEW);
});

router.post('/login', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (auth.isLoginBlocked(req)) {
    return res.status(429).json({
      ok: false,
      message: 'Слишком много неудачных попыток входа. Подождите 15 минут и попробуйте снова.',
    });
  }

  const login = auth.checkCredentials(body.login, body.password);
  if (!login) {
    auth.registerLoginFailure(req);
    return res.status(401).json({ ok: false, message: 'Неверный логин или пароль.' });
  }

  auth.registerLoginSuccess(req);
  // В сессию кладём логин в том виде, в каком он записан, а не как его набрали.
  auth.setSession(req, res, login);
  return res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  auth.clearSession(req, res);
  return res.json({ ok: true });
});

router.get('/', auth.requirePage, async (req, res, next) => {
  try {
    const session = auth.getSession(req);
    res.type('html').send(await renderAdminPage(session && session.login));
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------- API

router.get('/api/applications', auth.requireApi, async (req, res, next) => {
  try {
    const items = await store.list();
    const selected = selectItems(items, req.query);

    res.json({
      ok: true,
      items: selected,
      total: selected.length,
      counts: countByStatus(items),
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/api/applications/:id', auth.requireApi, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    const errors = {};

    if (body.status !== undefined) {
      if (!store.isValidStatus(body.status)) errors.status = 'Неизвестный статус заявки.';
      else patch.status = body.status;
    }

    if (body.managerComment !== undefined) {
      if (typeof body.managerComment !== 'string') {
        errors.managerComment = 'Комментарий должен быть текстом.';
      } else if (body.managerComment.trim().length > MAX_MANAGER_COMMENT) {
        errors.managerComment = `Комментарий слишком длинный — не больше ${MAX_MANAGER_COMMENT} символов.`;
      } else {
        patch.managerComment = body.managerComment.trim();
      }
    }

    if (Object.keys(errors).length > 0) return res.status(400).json({ ok: false, errors });
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ ok: false, message: 'Нечего сохранять: не переданы изменения.' });
    }

    const updated = await store.update(req.params.id, patch);
    if (!updated) return res.status(404).json({ ok: false, message: 'Заявка не найдена.' });

    return res.json({ ok: true, item: updated });
  } catch (error) {
    return next(error);
  }
});

router.delete('/api/applications/:id', auth.requireApi, async (req, res, next) => {
  try {
    const removed = await store.remove(req.params.id);
    if (!removed) return res.status(404).json({ ok: false, message: 'Заявка не найдена.' });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------- CSV

const CSV_COLUMNS = [
  ['Дата заявки', (item) => formatDateTime(item.createdAt)],
  ['Родитель', (item) => item.parentName],
  ['Телефон', (item) => item.phone],
  ['Ребёнок', (item) => item.childName],
  ['Возраст', (item) => (item.childAge === null ? '' : item.childAge)],
  ['Направление', (item) => item.course],
  ['Комментарий родителя', (item) => item.comment],
  ['Статус', (item) => store.statusLabel(item.status)],
  ['Комментарий менеджера', (item) => item.managerComment],
  ['Обновлено', (item) => formatDateTime(item.updatedAt)],
  ['Источник', (item) => item.source],
  ['ID', (item) => item.id],
];

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}, ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

const FORMULA_START = /^[=@\t\r]/;
const PHONE_LIKE = /^[+-][\d\s().-]+$/;

function csvCell(value) {
  const text = String(value ?? '');
  // Excel выполняет содержимое ячейки, начинающееся с = @ + -, поэтому такие значения гасим апострофом.
  // Телефон (+7 999 …) под это правило формально попадает, но формулой не является — его не трогаем.
  const looksLikeFormula = FORMULA_START.test(text) || (/^[+-]/.test(text) && !PHONE_LIKE.test(text));
  const safe = looksLikeFormula ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function buildCsv(items) {
  const rows = [CSV_COLUMNS.map(([title]) => csvCell(title)).join(';')];

  for (const item of items) {
    rows.push(CSV_COLUMNS.map(([, read]) => csvCell(read(item))).join(';'));
  }

  // BOM + разделитель «;» — чтобы Excel с русской локалью открыл файл без плясок с бубном.
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

router.get('/api/export.csv', auth.requireApi, async (req, res, next) => {
  try {
    const items = await store.list();
    const selected = selectItems(items, req.query);
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="procode-applications-${stamp}.csv"`);
    res.send(buildCsv(selected));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
