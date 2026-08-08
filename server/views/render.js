'use strict';

/**
 * Сборка страниц платформы: общий каркас (layout.html) + разметка модуля (views/pages/*.html).
 *
 * Меню рисуется на сервере по роли: в HTML преподавателя ссылок на «Заявки», «Сотрудников»
 * и «Финансы» просто нет. Это не заменяет проверок в API, а дополняет их — интерфейс
 * не показывает того, чего человек всё равно не сможет открыть.
 *
 * По той же причине вместе со страницей уезжает permissions — набор флагов из domain/access.js.
 * Интерфейс рисует кнопки и поля по ним, но это лишь отражение серверных правил:
 * API проверяет права заново на каждом запросе, независимо от того, что показано на экране.
 *
 * Шаблоны читаются с диска один раз и кэшируются: страниц немного, а лишние обращения
 * к файловой системе на каждый запрос ни к чему.
 */

const fsp = require('fs/promises');
const path = require('path');

const access = require('../domain/access');
const catalog = require('../domain/catalog');

const VIEWS_DIR = __dirname;
const PAGES_DIR = path.join(VIEWS_DIR, 'pages');

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Любые значения, приходящие из данных, попадают в разметку только через эту функцию. */
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/**
 * JSON внутри <script>: закрывающий тег и разделители строк экранируются,
 * иначе строка вида "</script>" в данных разорвала бы блок.
 */
function escapeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ------------------------------------------------------------------- меню

const ICONS = {
  dashboard: '<path d="M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10"/>',
  applications: '<path d="M8 4h8a2 2 0 0 1 2 2v14l-6-3-6 3V6a2 2 0 0 1 2-2z"/>',
  students: '<path d="M12 3 2 8l10 5 10-5-10-5zM6 10.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5"/>',
  teachers: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 11.2a3 3 0 1 0-2-5.3M18 20h3.5a5.5 5.5 0 0 0-3.8-5.2"/>',
  schedule: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  finance: '<path d="M3 17l5-6 4 4 4-6 5 5"/><path d="M3 21h18"/>',
  profile: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
};

const NAV_ITEMS = [
  { module: 'dashboard', href: '/app', label: 'Главная' },
  { module: 'applications', href: '/app/applications', label: 'Заявки' },
  { module: 'students', href: '/app/students', label: 'Ученики' },
  { module: 'teachers', href: '/app/teachers', label: 'Сотрудники' },
  { module: 'schedule', href: '/app/schedule', label: 'Расписание' },
  { module: 'finance', href: '/app/finance', label: 'Финансы' },
  { module: 'profile', href: '/app/profile', label: 'Профиль' },
];

function navHtml(user, activeModule) {
  return NAV_ITEMS.filter((item) => access.canOpenModule(user, item.module))
    .map((item) => {
      const active = item.module === activeModule;
      const className = active ? 'nav-item nav-item-active' : 'nav-item';
      const badge =
        item.module === 'applications'
          ? '<span class="nav-badge" data-nav-badge="applications" hidden>0</span>'
          : '';

      return `<a href="${item.href}" class="${className}"${active ? ' aria-current="page"' : ''}>
        <svg viewBox="0 0 24 24" class="h-[18px] w-[18px] shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
          ICONS[item.module] || ''
        }</svg>
        <span class="flex-1">${escapeHtml(item.label)}</span>${badge}
      </a>`;
    })
    .join('\n');
}

function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// ------------------------------------------------------------- шаблоны

const cache = new Map();

async function readTemplate(file) {
  if (cache.has(file)) return cache.get(file);
  const raw = await fsp.readFile(file, 'utf8');
  cache.set(file, raw);
  return raw;
}

/**
 * Подстановка через функцию, а не строку: иначе последовательности вида $& в данных
 * были бы истолкованы как ссылки на совпадение.
 */
function fill(template, values) {
  return template.replace(/<!--\{\{(\w+)\}\}-->/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : ''
  );
}

/**
 * Собирает страницу платформы.
 * @param {object} options.user       текущий сотрудник
 * @param {string} options.module     раздел меню, который надо подсветить
 * @param {string} options.view       имя файла в views/pages без расширения
 * @param {string} options.script     имя модуля в public/js/crm
 * @param {object} options.data       дополнительные данные для window.PC
 * @param {string} options.nonce      res.locals.cspNonce текущего запроса — без него
 *                                    блок с данными сессии заблокирует CSP (см. server/csp.js)
 */
async function renderApp({ user, module: moduleName, view, script, title, heading, subheading, data = {}, nonce }) {
  const pageView = view || moduleName;

  // Молчаливой замены нет намеренно: страница без nonce открылась бы пустой оболочкой
  // (window.PC не выполнился, модули упали), и искать причину пришлось бы в консоли браузера.
  if (!nonce) throw new Error('renderApp: не передан nonce — страницу платформы без него собирать нельзя.');

  const [layout, content] = await Promise.all([
    readTemplate(path.join(VIEWS_DIR, 'layout.html')),
    readTemplate(path.join(PAGES_DIR, `${pageView}.html`)),
  ]);

  const bootstrap = {
    user: access.selfProfile(user),
    permissions: access.clientPermissions(user),
    catalog: catalog.clientCatalog(),
    page: pageView,
    ...data,
  };

  return fill(layout, {
    TITLE: escapeHtml(title || heading || 'Платформа'),
    HEADING: escapeHtml(heading || title || ''),
    SUBHEADING: escapeHtml(subheading || ''),
    NAV: navHtml(user, moduleName),
    USER_NAME: escapeHtml(user.name || user.login),
    USER_ROLE: escapeHtml(catalog.labelOf(catalog.ROLES, user.role)),
    USER_INITIALS: escapeHtml(initials(user.name || user.login)),
    CONTENT: content,
    BOOTSTRAP: `<script nonce="${escapeHtml(nonce)}">window.PC = ${escapeJson(bootstrap)};</script>`,
    SCRIPT: escapeHtml(script || `${pageView}.js`),
  });
}

module.exports = {
  renderApp,
  escapeHtml,
  escapeJson,
  navHtml,
  initials,
};
