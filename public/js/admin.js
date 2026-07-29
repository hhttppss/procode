'use strict';

/**
 * Админ-панель «ПроКод»: вход и работа со списком заявок.
 * Один файл на две страницы — лишний код просто не находит своих элементов и молча выходит.
 *
 * Правило вывода: любые данные заявки попадают в DOM только через textContent.
 */

(() => {
  const STATUSES = Array.isArray(window.PC_STATUSES) ? window.PC_STATUSES : [];

  /**
   * Классы статусов перечислены буквально: Tailwind собирает CSS по тексту исходников
   * и не увидел бы имя, собранное конкатенацией.
   */
  const STATUS_CLASS = {
    new: 'status status-new',
    agreed: 'status status-agreed',
    thinking: 'status status-thinking',
    callback: 'status status-callback',
    noanswer: 'status status-noanswer',
    refused: 'status status-refused',
  };

  // ------------------------------------------------------------- утилиты

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function statusLabel(id) {
    const found = STATUSES.find((status) => status.id === id);
    return found ? found.label : id;
  }

  function formatDateTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function setButtonLoading(button, loading) {
    if (!button) return;
    const idle = button.dataset.labelIdle || button.textContent;
    const busy = button.dataset.labelLoading || 'Подождите…';
    button.disabled = loading;
    button.textContent = loading ? busy : idle;
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  function firstErrorText(data) {
    if (data && data.errors && typeof data.errors === 'object') {
      const values = Object.values(data.errors);
      if (values.length > 0) return String(values[0]);
    }
    return data && data.message ? String(data.message) : '';
  }

  // ------------------------------------------------------- страница входа

  function initLogin() {
    const form = document.getElementById('loginForm');
    if (!form) return;

    const submit = document.getElementById('loginSubmit');
    const errorBox = document.getElementById('loginError');

    function showError(message) {
      errorBox.textContent = message;
      errorBox.classList.add('is-shown');
    }

    function hideError() {
      errorBox.textContent = '';
      errorBox.classList.remove('is-shown');
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError();

      const login = form.elements.login.value.trim();
      const password = form.elements.password.value;

      if (!login || !password) {
        showError('Введите логин и пароль.');
        (login ? form.elements.password : form.elements.login).focus();
        return;
      }

      setButtonLoading(submit, true);

      try {
        const response = await fetch('/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login, password }),
        });
        const data = await readJson(response);

        if (response.ok && data.ok) {
          window.location.href = '/admin';
          return;
        }

        showError(data.message || 'Не удалось войти. Попробуйте ещё раз.');
        form.elements.password.value = '';
        form.elements.password.focus();
      } catch {
        showError('Сервер не отвечает. Проверьте подключение и попробуйте снова.');
      } finally {
        setButtonLoading(submit, false);
      }
    });
  }

  // ------------------------------------------------------ страница заявок

  function initApplications() {
    const tableBody = document.getElementById('applicationsBody');
    if (!tableBody) return;

    const tilesRoot = document.getElementById('statusTiles');
    const tableWrapper = document.getElementById('tableWrapper');
    const cardsRoot = document.getElementById('applicationsCards');
    const emptyState = document.getElementById('emptyState');
    const loadingState = document.getElementById('loadingState');
    const summary = document.getElementById('resultSummary');
    const toasts = document.getElementById('toasts');

    const searchInput = document.getElementById('filterSearch');
    const statusFilter = document.getElementById('filterStatus');
    const fromInput = document.getElementById('filterFrom');
    const toInput = document.getElementById('filterTo');
    const sortSelect = document.getElementById('filterSort');
    const resetButton = document.getElementById('resetFilters');
    const exportLink = document.getElementById('exportCsv');
    const logoutButton = document.getElementById('logoutButton');

    const drawer = document.getElementById('drawer');
    const drawerPanel = document.getElementById('drawerPanel');
    const drawerBackdrop = document.getElementById('drawerBackdrop');
    const drawerClose = document.getElementById('drawerClose');
    const drawerStatus = document.getElementById('drawerStatus');
    const drawerManagerComment = document.getElementById('drawerManagerComment');
    const drawerSave = document.getElementById('drawerSave');
    const drawerDelete = document.getElementById('drawerDelete');
    const drawerCall = document.getElementById('drawerCall');

    const state = { status: 'all', q: '', from: '', to: '', sort: 'new' };
    let items = [];
    let counts = { all: 0 };
    let requestToken = 0;
    let firstLoadDone = false;

    // --------------------------------------------------------- уведомления

    function toast(message, kind = 'success') {
      const tone = kind === 'error' ? 'bg-red-600' : 'bg-ink';
      const node = el(
        'div',
        `pointer-events-auto rounded-xl ${tone} px-4 py-3 text-sm font-medium text-white shadow-lift`,
        message
      );
      toasts.append(node);
      setTimeout(() => node.remove(), 3500);
    }

    // ------------------------------------------------------------ загрузка

    function buildQuery() {
      const params = new URLSearchParams();
      if (state.status !== 'all') params.set('status', state.status);
      if (state.q) params.set('q', state.q);
      if (state.from) params.set('from', state.from);
      if (state.to) params.set('to', state.to);
      if (state.sort !== 'new') params.set('sort', state.sort);
      return params;
    }

    function goToLogin() {
      window.location.href = '/admin/login';
    }

    async function load() {
      const token = ++requestToken;
      if (!firstLoadDone) loadingState.hidden = false;

      try {
        const response = await fetch(`/admin/api/applications?${buildQuery()}`, {
          headers: { Accept: 'application/json' },
        });

        if (response.status === 401) return goToLogin();

        const data = await readJson(response);
        if (!response.ok || !data.ok) throw new Error(data.message || 'Не удалось загрузить заявки.');
        if (token !== requestToken) return; // пришёл ответ на устаревший запрос

        items = Array.isArray(data.items) ? data.items : [];
        counts = data.counts || { all: items.length };
        firstLoadDone = true;
        render();
      } catch (error) {
        if (token !== requestToken) return;

        const message = error.message || 'Сервер не отвечает.';
        toast(message, 'error');
        // Первая загрузка упала — вместо пустого экрана объясняем, что произошло.
        if (!firstLoadDone) {
          items = [];
          render(message);
        }
      } finally {
        if (token === requestToken) loadingState.hidden = true;
      }
    }

    // ------------------------------------------------------------- плитки

    function buildTiles() {
      const tiles = [{ id: 'all', label: 'Всего' }, ...STATUSES];

      tilesRoot.replaceChildren(
        ...tiles.map((tile) => {
          const button = el('button', 'card card-hover p-4 text-left');
          button.type = 'button';
          button.dataset.status = tile.id;

          const label =
            tile.id === 'all'
              ? el('span', 'badge bg-ink/5 text-ink', tile.label)
              : el('span', STATUS_CLASS[tile.id] || 'badge bg-ink/5 text-ink', tile.label);

          const count = el('span', 'mt-3 block font-mono tnum text-2xl font-semibold', '0');
          count.dataset.count = '';

          button.append(label, count);
          button.addEventListener('click', () => {
            state.status = tile.id;
            statusFilter.value = tile.id;
            load();
          });

          return button;
        })
      );
    }

    function renderTiles() {
      for (const tile of tilesRoot.children) {
        const id = tile.dataset.status;
        const active = id === state.status;

        tile.querySelector('[data-count]').textContent = String(counts[id] ?? 0);
        tile.setAttribute('aria-pressed', String(active));
        tile.classList.toggle('border-cobalt', active);
        tile.classList.toggle('ring-2', active);
        tile.classList.toggle('ring-cobalt/25', active);
      }
    }

    // ------------------------------------------------------- список заявок

    function childSummary(item) {
      if (!item.childName) return '—';
      return item.childAge ? `${item.childName}, ${item.childAge} лет` : item.childName;
    }

    function statusBadge(status) {
      return el('span', STATUS_CLASS[status] || 'status status-noanswer', statusLabel(status));
    }

    function cell(text, className) {
      return el('td', `px-5 py-3.5 align-middle ${className || ''}`.trim(), text);
    }

    function createRow(item) {
      const row = el('tr', 'cursor-pointer transition hover:bg-mist/50');

      row.append(
        cell(formatDateTime(item.createdAt), 'whitespace-nowrap font-mono tnum text-xs text-muted'),
        cell(item.parentName, 'font-medium'),
        cell(item.phone, 'whitespace-nowrap font-mono tnum text-xs'),
        cell(childSummary(item), 'text-muted'),
        cell(item.course, 'text-muted')
      );

      const statusCell = cell('', '');
      statusCell.append(statusBadge(item.status));
      row.append(statusCell);

      const actionCell = cell('', 'text-right');
      const openButton = el('button', 'btn btn-outline btn-sm', 'Открыть');
      openButton.type = 'button';
      openButton.setAttribute('aria-label', `Открыть заявку: ${item.parentName}`);
      actionCell.append(openButton);
      row.append(actionCell);

      row.addEventListener('click', () => openDrawer(item, openButton));
      return row;
    }

    function createCard(item) {
      const card = el('button', 'card card-hover block w-full p-4 text-left');
      card.type = 'button';
      card.setAttribute('aria-label', `Открыть заявку: ${item.parentName}`);

      const top = el('div', 'flex items-center justify-between gap-3');
      top.append(el('span', 'font-mono tnum text-2xs text-muted', formatDateTime(item.createdAt)), statusBadge(item.status));

      const body = el('div', 'mt-3 space-y-1');
      body.append(
        el('p', 'font-display text-base font-semibold', item.parentName),
        el('p', 'font-mono tnum text-sm text-cobalt', item.phone),
        el('p', 'text-sm text-muted', childSummary(item)),
        el('p', 'text-sm text-muted', item.course)
      );

      card.append(top, body);
      card.addEventListener('click', () => openDrawer(item, card));
      return card;
    }

    function renderEmptyState(errorMessage) {
      const noDataAtAll = (counts.all ?? 0) === 0;

      let title = 'Ничего не нашлось';
      let text = 'Попробуйте изменить условия поиска или сбросить фильтры.';

      if (errorMessage) {
        title = 'Не удалось загрузить заявки';
        text = errorMessage;
      } else if (noDataAtAll) {
        title = 'Заявок пока нет';
        text = 'Как только с сайта придёт первая заявка, она появится здесь.';
      }

      emptyState.querySelector('[data-empty-title]').textContent = title;
      emptyState.querySelector('[data-empty-text]').textContent = text;
    }

    function render(errorMessage) {
      renderTiles();

      tableBody.replaceChildren(...items.map(createRow));
      cardsRoot.replaceChildren(...items.map(createCard));

      const isEmpty = items.length === 0;
      // «!hidden» — важность нужна, чтобы перебить адаптивные lg:block / lg:hidden.
      tableWrapper.classList.toggle('lg:!hidden', isEmpty);
      cardsRoot.classList.toggle('!hidden', isEmpty);
      emptyState.hidden = !isEmpty;
      if (isEmpty) renderEmptyState(errorMessage);

      summary.textContent = isEmpty
        ? ''
        : `Показано ${items.length} ${pluralApplications(items.length)} из ${counts.all ?? items.length}`;

      exportLink.href = `/admin/api/export.csv?${buildQuery()}`;
    }

    function pluralApplications(count) {
      const tail = count % 100;
      if (tail >= 11 && tail <= 14) return 'заявок';
      switch (count % 10) {
        case 1:
          return 'заявка';
        case 2:
        case 3:
        case 4:
          return 'заявки';
        default:
          return 'заявок';
      }
    }

    // ------------------------------------------------------------- фильтры

    function buildStatusFilterOptions() {
      const all = el('option', null, 'Все статусы');
      all.value = 'all';

      statusFilter.replaceChildren(
        all,
        ...STATUSES.map((status) => {
          const option = el('option', null, status.label);
          option.value = status.id;
          return option;
        })
      );

      drawerStatus.replaceChildren(
        ...STATUSES.map((status) => {
          const option = el('option', null, status.label);
          option.value = status.id;
          return option;
        })
      );
    }

    let searchTimer = null;

    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = searchInput.value.trim();
        load();
      }, 250);
    });

    statusFilter.addEventListener('change', () => {
      state.status = statusFilter.value;
      load();
    });

    fromInput.addEventListener('change', () => {
      state.from = fromInput.value;
      load();
    });

    toInput.addEventListener('change', () => {
      state.to = toInput.value;
      load();
    });

    sortSelect.addEventListener('change', () => {
      state.sort = sortSelect.value;
      load();
    });

    resetButton.addEventListener('click', () => {
      state.status = 'all';
      state.q = '';
      state.from = '';
      state.to = '';
      state.sort = 'new';

      searchInput.value = '';
      statusFilter.value = 'all';
      fromInput.value = '';
      toInput.value = '';
      sortSelect.value = 'new';

      load();
    });

    document.getElementById('filtersForm').addEventListener('submit', (event) => event.preventDefault());

    logoutButton.addEventListener('click', async () => {
      logoutButton.disabled = true;
      try {
        await fetch('/admin/logout', { method: 'POST' });
      } catch {
        // Даже если запрос не дошёл, уводим на страницу входа: cookie перестанет действовать через 12 часов.
      } finally {
        goToLogin();
      }
    });

    // -------------------------------------------------------------- drawer

    let currentItem = null;
    let lastTrigger = null;
    let hideTimer = null;

    function focusable() {
      return Array.from(
        drawerPanel.querySelectorAll('a[href], button:not([disabled]), select, textarea, input, [tabindex]:not([tabindex="-1"])')
      ).filter((node) => node.offsetParent !== null);
    }

    function fillDrawer(item) {
      const set = (field, value) => {
        const node = drawerPanel.querySelector(`[data-field="${field}"]`);
        if (node) node.textContent = value;
      };

      set('parentName', item.parentName || 'Без имени');
      set('createdAt', formatDateTime(item.createdAt));
      set('child', childSummary(item));
      set('course', item.course || '—');
      set('comment', item.comment || '—');
      set('createdAtFull', formatDateTime(item.createdAt));
      set('updatedAtFull', formatDateTime(item.updatedAt));

      const telHref = `tel:${(item.phone || '').replace(/[^\d+]/g, '')}`;
      const phoneLink = drawerPanel.querySelector('[data-field="phoneLink"]');
      phoneLink.textContent = item.phone || '—';
      phoneLink.href = telHref;
      drawerCall.href = telHref;

      drawerStatus.value = item.status;
      drawerManagerComment.value = item.managerComment || '';
    }

    function openDrawer(item, trigger) {
      currentItem = item;
      lastTrigger = trigger || null;
      fillDrawer(item);

      clearTimeout(hideTimer);
      drawer.hidden = false;
      document.body.classList.add('overflow-hidden');

      requestAnimationFrame(() => {
        drawerPanel.classList.remove('translate-x-full');
        drawerBackdrop.classList.remove('opacity-0');
      });

      drawerStatus.focus();
    }

    function closeDrawer() {
      if (drawer.hidden) return;

      drawerPanel.classList.add('translate-x-full');
      drawerBackdrop.classList.add('opacity-0');
      document.body.classList.remove('overflow-hidden');

      hideTimer = setTimeout(() => {
        drawer.hidden = true;
      }, 300);

      currentItem = null;

      if (lastTrigger && document.contains(lastTrigger)) lastTrigger.focus();
      else searchInput.focus();
      lastTrigger = null;
    }

    drawerClose.addEventListener('click', closeDrawer);
    drawerBackdrop.addEventListener('click', closeDrawer);

    document.addEventListener('keydown', (event) => {
      if (drawer.hidden) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawer();
        return;
      }

      if (event.key !== 'Tab') return;

      // Фокус не должен уходить из открытой панели.
      const nodes = focusable();
      if (nodes.length === 0) return;

      const first = nodes[0];
      const last = nodes[nodes.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!drawerPanel.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    });

    drawerSave.addEventListener('click', async () => {
      if (!currentItem) return;

      const id = currentItem.id;
      setButtonLoading(drawerSave, true);

      try {
        const response = await fetch(`/admin/api/applications/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: drawerStatus.value, managerComment: drawerManagerComment.value }),
        });

        if (response.status === 401) return goToLogin();

        const data = await readJson(response);
        if (!response.ok || !data.ok) throw new Error(firstErrorText(data) || 'Не удалось сохранить заявку.');

        currentItem = data.item;
        toast('Изменения сохранены');
        await load();
      } catch (error) {
        toast(error.message || 'Не удалось сохранить заявку.', 'error');
      } finally {
        setButtonLoading(drawerSave, false);
      }
    });

    drawerDelete.addEventListener('click', async () => {
      if (!currentItem) return;

      const name = currentItem.parentName || 'без имени';
      if (!window.confirm(`Удалить заявку от «${name}»? Восстановить её будет нельзя.`)) return;

      const id = currentItem.id;
      drawerDelete.disabled = true;

      try {
        const response = await fetch(`/admin/api/applications/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (response.status === 401) return goToLogin();

        const data = await readJson(response);
        if (!response.ok || !data.ok) throw new Error(data.message || 'Не удалось удалить заявку.');

        closeDrawer();
        toast('Заявка удалена');
        await load();
      } catch (error) {
        toast(error.message || 'Не удалось удалить заявку.', 'error');
      } finally {
        drawerDelete.disabled = false;
      }
    });

    // ---------------------------------------------------------------- старт

    buildStatusFilterOptions();
    buildTiles();
    load();
  }

  initLogin();
  initApplications();
})();
