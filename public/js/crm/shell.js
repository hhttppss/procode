'use strict';

/**
 * Оболочка платформы: боковое меню на узких экранах, выход и уведомления.
 * Подключается каждой страницей — поведение шапки одинаково во всех модулях.
 */

import { api, byId, can, formatRelative, h, isAdmin, toast } from './core.js';

const POLL_INTERVAL_MS = 30000;

/**
 * Событие общего опроса. Один таймер на страницу: по нему обновляются и колокольчик,
 * и списки модулей (например, таблица заявок) — чтобы новые данные появлялись
 * без второго независимого интервала и без перезагрузки страницы.
 */
export const POLL_EVENT = 'crm:poll';

/**
 * Разметка приезжает скрытой и раскрывается по правам. Это лишь отражение серверных
 * проверок, а не защита: запрос без права всё равно вернёт 403.
 *
 * Два механизма, потому что случаи разные:
 * [data-admin-only]            — строго администратор (управление учётками и подобное);
 * [data-requires="имяФлага"]   — показываем, если сервер выдал такое право; так управляющий
 *                                получает блоки, не переписывая условия под каждую роль.
 */
function applyRoleVisibility() {
  if (isAdmin) {
    for (const node of document.querySelectorAll('[data-admin-only]')) node.hidden = false;
  }

  for (const node of document.querySelectorAll('[data-requires]')) {
    if (can(node.dataset.requires)) node.hidden = false;
  }
}

// ------------------------------------------------------------------- меню

const FOCUSABLE = 'a[href], button:not([disabled]), select, textarea, input:not([type="hidden"]), [tabindex]';

/**
 * Прячет содержимое страницы от клавиатуры и скринридера, пока боковое меню открыто
 * поверх него на узких экранах — тот же приём, что и в мобильном меню лендинга
 * (public/js/landing.js, createIsolation). Набор изолируемых узлов свой: там прячут
 * секции сайта позади выпадающего списка ссылок, здесь — шапку и рабочую область,
 * которые лежат в DOM рядом с самим меню (aside#sidebar), а не под ним.
 */
function createIsolation(nodes) {
  const supportsInert = 'inert' in HTMLElement.prototype;

  // Старым браузерам inert неизвестен: гасим табуляцию вручную, запоминая прежний
  // tabindex, чтобы вернуть его при закрытии, и прячем ветку из дерева доступности aria-hidden.
  function fallback(node, isolated) {
    if (isolated) {
      node.setAttribute('aria-hidden', 'true');
      for (const item of node.querySelectorAll(FOCUSABLE)) {
        if (item.dataset.navTabindex === undefined) {
          item.dataset.navTabindex = item.getAttribute('tabindex') ?? '';
        }
        item.setAttribute('tabindex', '-1');
      }
      return;
    }

    node.removeAttribute('aria-hidden');
    for (const item of node.querySelectorAll('[data-nav-tabindex]')) {
      const previous = item.dataset.navTabindex;
      if (previous) item.setAttribute('tabindex', previous);
      else item.removeAttribute('tabindex');
      delete item.dataset.navTabindex;
    }
  }

  return (isolated) => {
    for (const node of nodes) {
      if (supportsInert) node.inert = isolated;
      else fallback(node, isolated);
    }
  };
}

function initNav() {
  const sidebar = byId('sidebar');
  const backdrop = byId('navBackdrop');
  const openButton = byId('navOpen');
  const closeButton = byId('navClose');
  if (!sidebar || !backdrop) return;

  // Изолируем всё, что лежит вне бокового меню: на узких экранах оно выезжает поверх
  // шапки и рабочей области, а не рядом с ними. Без inert Tab уводил бы фокус под
  // панель, а скринридер продолжал бы озвучивать контент, скрытый за меню и подложкой.
  // Сама подложка (#navBackdrop) не изолируется — по клику на неё меню и так закрывается.
  const isolate = createIsolation([document.querySelector('header'), byId('appContent')].filter(Boolean));

  function open() {
    sidebar.classList.remove('-translate-x-full');
    backdrop.hidden = false;
    backdrop.classList.remove('hidden');
    document.body.classList.add('overflow-hidden', 'lg:overflow-auto');
    isolate(true);
    // Фокус — на кнопку закрытия: с inert на шапке и контенте единственная доступная
    // по Tab область — само меню, и Tab начинает естественно кружить внутри него.
    closeButton?.focus({ preventScroll: true });
  }

  function close() {
    sidebar.classList.add('-translate-x-full');
    backdrop.hidden = true;
    backdrop.classList.add('hidden');
    document.body.classList.remove('overflow-hidden', 'lg:overflow-auto');
    isolate(false);
    // Фокус возвращается на кнопку, открывшую меню: иначе он проваливается в body,
    // и следующий Tab начинает обход страницы заново, а не продолжает с этого места.
    openButton?.focus({ preventScroll: true });
  }

  openButton?.addEventListener('click', open);
  closeButton?.addEventListener('click', close);
  backdrop.addEventListener('click', close);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !backdrop.hidden) close();
  });

  // На широком экране меню всегда открыто правилом lg:translate-x-0, а изоляция шапки
  // и контента — нет: если открыть меню на телефоне и повернуть его или растянуть окно
  // до широкого экрана, шапка и контент остались бы недоступны насовсем.
  const desktop = window.matchMedia('(min-width: 1024px)');
  const onDesktop = (event) => {
    if (event.matches && !backdrop.hidden) close();
  };
  if (typeof desktop.addEventListener === 'function') desktop.addEventListener('change', onDesktop);
  else desktop.addListener(onDesktop);
}

// ------------------------------------------------------------------ выход

function initLogout() {
  const button = byId('logoutButton');
  if (!button) return;

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await fetch('/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    } catch {
      // Даже если запрос не дошёл, уводим на страницу входа: cookie перестанет действовать через 12 часов.
    } finally {
      window.location.href = '/login';
    }
  });
}

// ------------------------------------------------------------ уведомления

function notificationItem(item, onRead) {
  const node = h(
    'button',
    {
      class: item.read ? 'bell-item' : 'bell-item bell-unread',
      attrs: { type: 'button' },
      on: {
        click: async () => {
          if (!item.read) await onRead(item);
          if (item.link) window.location.href = item.link;
        },
      },
    },
    [
      h('span', {
        class: item.read ? 'mt-1.5 h-2 w-2 shrink-0 rounded-full bg-transparent' : 'mt-1.5 h-2 w-2 shrink-0 rounded-full bg-apricot',
      }),
      h('span', { class: 'min-w-0 flex-1' }, [
        h('span', { class: 'block text-sm font-semibold leading-snug', text: item.title }),
        item.text ? h('span', { class: 'mt-0.5 block truncate text-xs text-muted', text: item.text }) : null,
        h('span', { class: 'mt-1 block font-mono text-[11px] text-muted', text: formatRelative(item.createdAt) }),
      ]),
    ]
  );

  return node;
}

function initNotifications() {
  const button = byId('bellButton');
  const panel = byId('bellPanel');
  const list = byId('bellList');
  const counter = byId('bellCount');
  const readAll = byId('bellReadAll');
  if (!button || !panel || !list) return;

  let items = [];

  function renderCounter(unread) {
    if (!counter) return;
    counter.textContent = String(unread > 99 ? '99+' : unread);
    counter.hidden = unread === 0;

    // Значок «Заявки» в меню показывает, сколько новых обращений ещё не открыли.
    // Считаем по праву, а не по роли: заявками занимается и управляющий.
    const navBadge = document.querySelector('[data-nav-badge="applications"]');
    if (navBadge && can('canManageApplications')) {
      const applicationsUnread = items.filter((item) => item.type === 'application' && !item.read).length;
      navBadge.textContent = String(applicationsUnread);
      navBadge.hidden = applicationsUnread === 0;
    }

    document.title = unread > 0 ? `(${unread}) ${baseTitle}` : baseTitle;
  }

  const baseTitle = document.title;

  async function markRead(item) {
    item.read = true;
    try {
      await api(`/notifications/${encodeURIComponent(item.id)}/read`, { method: 'POST' });
    } catch {
      // Не критично: при следующем опросе состояние подтянется с сервера.
    }
    render();
  }

  function render() {
    list.replaceChildren();

    if (items.length === 0) {
      list.append(h('p', { class: 'px-4 py-8 text-center text-sm text-muted', text: 'Уведомлений пока нет' }));
    } else {
      for (const item of items) list.append(notificationItem(item, markRead));
    }

    renderCounter(items.filter((item) => !item.read).length);
  }

  async function load() {
    try {
      const data = await api('/notifications');
      items = data.items || [];
      render();
    } catch {
      // Молча: опрос повторится через полминуты, ошибку в шапке показывать незачем.
    }
  }

  function togglePanel(show) {
    const next = show === undefined ? panel.hidden : show;
    panel.hidden = !next;
    button.setAttribute('aria-expanded', String(next));
    if (next) load();
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    togglePanel();
  });

  document.addEventListener('click', (event) => {
    if (!panel.hidden && !panel.contains(event.target) && event.target !== button) togglePanel(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) togglePanel(false);
  });

  readAll?.addEventListener('click', async () => {
    try {
      await api('/notifications/read-all', { method: 'POST' });
      items = items.map((item) => ({ ...item, read: true }));
      render();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  load();
  document.addEventListener(POLL_EVENT, load);
}

// ------------------------------------------------------------------- опрос

/**
 * Опрос вместо постоянного соединения: нагрузка мизерная, а кода и зависимостей — ноль.
 * Таймер живёт отдельно от колокольчика, потому что на него подписаны и страницы:
 * страница без колокольчика всё равно должна обновляться.
 */
function initPolling() {
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    document.dispatchEvent(new CustomEvent(POLL_EVENT));
  }, POLL_INTERVAL_MS);
}

applyRoleVisibility();
initNav();
initLogout();
initNotifications();
initPolling();
