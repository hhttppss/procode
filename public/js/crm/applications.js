'use strict';

/**
 * Модуль «Заявки»: список, фильтры, работа с воронкой статусов
 * и превращение заявки в карточку ученика.
 */

import { POLL_EVENT } from './shell.js';
import {
  CATALOG,
  api,
  byId,
  can,
  clear,
  confirmModal,
  debounce,
  emptyBlock,
  field,
  formatDateTime,
  formatDay,
  h,
  isModalOpen,
  kv,
  modalButton,
  openModal,
  plural,
  readForm,
  setButtonLoading,
  showFieldErrors,
  statusBadge,
  statusLabel,
  toQuery,
  toast,
} from './core.js';

const STATUSES = CATALOG.applicationStatuses || [];

const DEFAULT_STATE = { status: 'all', q: '', from: '', to: '', sort: 'new' };
const MAX_QUERY_LENGTH = 100; // столько же принимает сервер (server/routes/api/applications.js)

const state = { ...DEFAULT_STATE };

let items = [];
let counts = { all: 0 };
// total — сколько заявок подошло под фильтр на сервере, limited — обрезал ли он выдачу.
let total = 0;
let limited = false;
let teachers = [];
let requestToken = 0;

const rows = byId('rows');
const cards = byId('cards');
const listPanel = byId('listPanel');
const stateBox = byId('stateBox');
const tilesRoot = byId('statusTiles');
const summary = byId('resultSummary');
const exportLink = byId('exportCsv');

const searchInput = byId('filterSearch');
const statusSelect = byId('filterStatus');
const sortSelect = byId('filterSort');
const fromInput = byId('filterFrom');
const toInput = byId('filterTo');

// ------------------------------------------------------------------ плитки

function buildTiles() {
  const tiles = [{ id: 'all', label: 'Все заявки' }, ...STATUSES];

  tilesRoot.replaceChildren(
    ...tiles.map((tile) =>
      h(
        'button',
        {
          class: 'tile tile-clickable',
          attrs: { type: 'button' },
          dataset: { status: tile.id },
          on: {
            click: () => {
              state.status = tile.id;
              statusSelect.value = tile.id;
              applyFilters();
            },
          },
        },
        [
          tile.id === 'all'
            ? h('span', { class: 'tile-label', text: tile.label })
            : statusBadge(STATUSES, tile.id),
          h('span', { class: 'tile-value', text: '0', dataset: { count: '' } }),
        ]
      )
    )
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

// ------------------------------------------------------------------ список

function childSummary(item) {
  if (!item.childName) return '—';
  return item.childAge ? `${item.childName}, ${item.childAge} ${plural(item.childAge, 'год', 'года', 'лет')}` : item.childName;
}

function createRow(item) {
  const openButton = h('button', {
    class: 'btn btn-outline btn-sm',
    attrs: { type: 'button', 'aria-label': `Открыть заявку: ${item.parentName || 'без имени'}` },
    text: 'Открыть',
  });

  const row = h(
    'tr',
    { class: 'row-clickable', on: { click: () => openCard(item) } },
    [
      h('td', { class: 'whitespace-nowrap font-mono tnum text-xs text-muted', text: formatDateTime(item.createdAt) }),
      h('td', { class: 'font-medium', text: item.parentName || '—' }),
      h('td', { class: 'whitespace-nowrap font-mono tnum text-xs', text: item.phone }),
      h('td', { class: 'text-muted', text: childSummary(item) }),
      h('td', { class: 'text-muted', text: item.course || '—' }),
      h('td', {}, statusBadge(STATUSES, item.status)),
      h('td', { class: 'text-right' }, openButton),
    ]
  );

  return row;
}

function createCard(item) {
  return h(
    'button',
    {
      class: 'tile tile-clickable block w-full',
      attrs: { type: 'button', 'aria-label': `Открыть заявку: ${item.parentName || 'без имени'}` },
      on: { click: () => openCard(item) },
    },
    [
      h('div', { class: 'flex items-center justify-between gap-3' }, [
        h('span', { class: 'font-mono tnum text-2xs text-muted', text: formatDateTime(item.createdAt) }),
        statusBadge(STATUSES, item.status),
      ]),
      h('div', { class: 'mt-3 space-y-1' }, [
        h('p', { class: 'font-display text-base font-semibold', text: item.parentName || 'Без имени' }),
        h('p', { class: 'font-mono tnum text-sm text-cobalt', text: item.phone }),
        h('p', { class: 'text-sm text-muted', text: childSummary(item) }),
        h('p', { class: 'text-sm text-muted', text: item.course || '—' }),
      ]),
    ]
  );
}

function render(errorMessage) {
  renderTiles();

  rows.replaceChildren(...items.map(createRow));
  cards.replaceChildren(...items.map(createCard));

  const isEmpty = items.length === 0;
  listPanel.hidden = isEmpty;
  clear(stateBox);

  if (isEmpty) {
    if (errorMessage) stateBox.append(emptyBlock('Не удалось загрузить заявки', errorMessage));
    else if ((counts.all ?? 0) === 0)
      stateBox.append(emptyBlock('Заявок пока нет', 'Как только с сайта придёт первая заявка, она появится здесь.'));
    else stateBox.append(emptyBlock('Ничего не нашлось', 'Измените условия поиска или сбросьте фильтры.'));
  }

  // Когда сервер обрезал выдачу, «из N» считаем по числу подошедших под фильтр,
  // а не по всем заявкам: иначе непонятно, сколько ещё осталось за кадром.
  const shown = `Показано ${items.length} ${plural(items.length, 'заявка', 'заявки', 'заявок')}`;
  summary.textContent = isEmpty
    ? ''
    : limited
      ? `${shown} из ${total} подходящих — уточните период или поиск, чтобы увидеть остальные`
      : `${shown} из ${counts.all ?? items.length}`;

  exportLink.href = `/app/api/applications/export/csv?${toQuery(state)}`;
}

async function load() {
  const token = ++requestToken;

  try {
    const data = await api('/applications', { query: state });
    if (token !== requestToken) return;

    items = data.items || [];
    counts = data.counts || { all: items.length };
    total = data.total ?? items.length;
    limited = Boolean(data.limited);
    render();
  } catch (error) {
    if (token !== requestToken) return;
    items = [];
    render(error.message);
  }
}

// -------------------------------------------------------- фоновое обновление

/** Слепок списка: по нему видно, изменилось ли что-нибудь на сервере. */
function signature(list, tally, count) {
  return `${tally ? tally.all : 0}|${count}|${list.map((item) => `${item.id}:${item.updatedAt}`).join(',')}`;
}

/**
 * Обновление по общему таймеру оболочки (30 с): новая заявка появляется в таблице сама,
 * а не только цифрой на колокольчике.
 *
 * Работа человека важнее свежести списка, поэтому обновление пропускается,
 * когда открыта карточка или когда фокус стоит внутри таблицы (перерисовка
 * уничтожила бы кнопку, на которой он стоит). Текст поиска, выбранные фильтры
 * и прокрутка не трогаются: запрос идёт с тем же state, поля ввода не переписываются,
 * а DOM обновляется только при реальных изменениях. Ошибка гасится молча —
 * список на экране остаётся прежним, следующий тик повторит попытку.
 */
async function refreshQuietly() {
  if (isModalOpen()) return;
  if (listPanel.contains(document.activeElement)) return;

  const token = ++requestToken;

  try {
    const data = await api('/applications', { query: state });
    if (token !== requestToken) return;

    const fresh = data.items || [];
    const tally = data.counts || { all: fresh.length };
    const freshTotal = data.total ?? fresh.length;
    // Число подошедших входит в слепок: за потолком выдачи заявки тоже прибавляются,
    // и строку «показано 200 из N» надо обновить, даже когда сама таблица не изменилась.
    if (signature(fresh, tally, freshTotal) === signature(items, counts, total)) return;

    items = fresh;
    counts = tally;
    total = freshTotal;
    limited = Boolean(data.limited);
    render();
  } catch {
    // Молча: фоновое обновление не должно показывать человеку ошибку поверх рабочего списка.
  }
}

// ------------------------------------------------------------ адресная строка

/**
 * Фильтры живут в адресе: ссылку на «новые заявки за июль» можно отправить коллеге
 * или оставить в закладках, а F5 не сбрасывает подбор.
 * replaceState, а не pushState: кнопка «Назад» должна уводить со страницы,
 * а не отматывать полтора десятка промежуточных состояний фильтра.
 */
function syncUrl() {
  const search = toQuery({ ...state, sort: state.sort === DEFAULT_STATE.sort ? '' : state.sort }).toString();
  window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
}

/** Читает фильтры из адреса. Всё, что не проходит проверку, молча заменяется значением по умолчанию. */
function readUrlState() {
  const params = new URLSearchParams(window.location.search);

  const status = params.get('status');
  if (status === 'all' || STATUSES.some((item) => item.id === status)) state.status = status;

  state.q = (params.get('q') || '').trim().slice(0, MAX_QUERY_LENGTH);

  for (const key of ['from', 'to']) {
    const value = params.get(key) || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) state[key] = value;
  }

  if (params.get('sort') === 'old') state.sort = 'old';
}

function applyStateToControls() {
  searchInput.value = state.q;
  statusSelect.value = state.status;
  sortSelect.value = state.sort;
  fromInput.value = state.from;
  toInput.value = state.to;
}

/** Единая точка смены фильтров: адрес и список всегда обновляются вместе. */
function applyFilters() {
  syncUrl();
  return load();
}

// ------------------------------------------------------------- карточка

function historyList(history) {
  if (!history || history.length === 0) {
    return h('p', { class: 'text-sm text-muted', text: 'Пока ничего не происходило.' });
  }

  return h(
    'ol',
    { class: 'space-y-2.5' },
    history
      .slice()
      .reverse()
      .map((entry) =>
        h('li', { class: 'border-l-2 border-cobalt/25 pl-3' }, [
          h('p', { class: 'text-sm', text: entry.text || '—' }),
          h('p', {
            class: 'mt-0.5 font-mono text-[11px] text-muted',
            text: `${formatDateTime(entry.at)} · ${entry.byName || 'система'}`,
          }),
        ])
      )
  );
}

function openCard(item) {
  const statusField = field({
    label: 'Статус',
    name: 'status',
    value: item.status,
    options: STATUSES.map((status) => ({ value: status.id, label: status.label })),
  });

  const commentField = field({
    label: 'Комментарий менеджера',
    name: 'managerComment',
    type: 'textarea',
    rows: 4,
    value: item.managerComment || '',
    placeholder: 'Что обсудили, когда перезвонить…',
  });

  const phoneHref = `tel:${(item.phone || '').replace(/[^\d+]/g, '')}`;

  const body = [
    h('dl', { class: 'grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2' }, [
      h('div', {}, [
        h('dt', { class: 'kv-label', text: 'Телефон' }),
        h('dd', { class: 'kv-value' }, h('a', { class: 'link-inline font-mono tnum', attrs: { href: phoneHref }, text: item.phone || '—' })),
      ]),
      item.email
        ? h('div', {}, [
            h('dt', { class: 'kv-label', text: 'Email' }),
            h('dd', { class: 'kv-value' }, h('a', { class: 'link-inline', attrs: { href: `mailto:${item.email}` }, text: item.email })),
          ])
        : kv('Email', '—'),
      kv('Ребёнок', childSummary(item)),
      kv('Направление', item.course || '—'),
      kv('Поступила', formatDateTime(item.createdAt), { mono: true }),
      kv('Обновлена', formatDateTime(item.updatedAt), { mono: true }),
    ]),

    h('div', {}, [
      h('p', { class: 'kv-label', text: 'Комментарий родителя' }),
      h('p', { class: 'mt-1 whitespace-pre-line rounded-xl bg-mist/70 px-4 py-3 text-sm', text: item.comment || '—' }),
    ]),

    statusField,
    commentField,

    item.studentId
      ? h('div', { class: 'rounded-xl border border-mint/30 bg-mint-100/60 px-4 py-3 text-sm' }, [
          h('span', { text: 'По заявке заведена карточка ученика. ' }),
          h('a', { class: 'link-inline font-semibold', attrs: { href: `/app/students/${item.studentId}` }, text: 'Открыть карточку' }),
        ])
      : null,

    h('div', { class: 'border-t border-ink/10 pt-4' }, [
      h('p', { class: 'kv-label mb-2', text: 'История' }),
      historyList(item.history),
    ]),
  ];

  const saveButton = modalButton('Сохранить', { kind: 'primary', loadingLabel: 'Сохраняем…' });
  const callButton = h('a', { class: 'btn btn-outline btn-sm', attrs: { href: phoneHref }, text: 'Позвонить' });
  const convertButton = item.studentId
    ? null
    : modalButton('В ученики', { kind: 'outline', onClick: () => openConvert(item, modal) });
  const deleteButton = modalButton('Удалить', { kind: 'danger' });

  const modal = openModal({
    title: item.parentName || 'Заявка без имени',
    subtitle: `${statusLabel(STATUSES, item.status)} · ${formatDay(item.createdAt.slice(0, 10))}`,
    body,
    actions: [saveButton, callButton, convertButton, deleteButton].filter(Boolean),
  });

  saveButton.addEventListener('click', async () => {
    setButtonLoading(saveButton, true);
    showFieldErrors(modal.panel, null);

    try {
      await api(`/applications/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: {
          status: statusField.input.value,
          managerComment: commentField.input.value,
        },
      });

      toast('Изменения сохранены');
      modal.close();
      await load();
    } catch (error) {
      showFieldErrors(modal.panel, error.errors);
      toast(error.message, 'error');
    } finally {
      setButtonLoading(saveButton, false);
    }
  });

  deleteButton.addEventListener('click', async () => {
    if (!(await confirmModal(`Удалить заявку от «${item.parentName || 'без имени'}»? Восстановить её будет нельзя.`, { title: 'Удаление заявки' }))) return;

    deleteButton.disabled = true;
    try {
      await api(`/applications/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      toast('Заявка удалена');
      modal.close();
      await load();
    } catch (error) {
      toast(error.message, 'error');
      deleteButton.disabled = false;
    }
  });
}

// --------------------------------------------------- конвертация в ученика

function openConvert(item, parentModal) {
  const nameField = field({ label: 'Имя ребёнка', name: 'name', value: item.childName, required: true, autocomplete: 'name' });
  const birthField = field({
    label: 'Дата рождения',
    name: 'birthDate',
    type: 'date',
    hint: 'Если известна — возраст будет считаться сам',
    autocomplete: 'bday',
  });
  const courseField = field({
    label: 'Направление',
    name: 'course',
    value: item.course,
    options: [{ value: '', label: 'Не выбрано' }, ...(CATALOG.courses || []).map((course) => ({ value: course, label: course }))],
  });
  const groupField = field({ label: 'Группа', name: 'group', placeholder: 'Например, «Питон-вт-17:00»' });

  // Конвертация — второй путь создания карточки, и закрепление за преподавателем
  // подчиняется тому же правилу, что и в обычной форме ученика: его назначает
  // администратор. Управляющий заявку зачисляет, преподавателя ей не выбирает.
  const canAssignTeacher = can('canAssignTeacher');
  const teacherField = field({
    label: 'Преподаватель',
    name: 'teacherId',
    options: [{ value: '', label: 'Пока не назначен' }, ...teachers.map((teacher) => ({ value: teacher.id, label: teacher.name }))],
    disabled: !canAssignTeacher,
    hint: canAssignTeacher ? '' : 'Преподавателя закрепит администратор',
  });
  const parentNameField = field({ label: 'ФИО родителя', name: 'parentName', value: item.parentName, autocomplete: 'name' });
  const parentPhoneField = field({ label: 'Телефон родителя', name: 'parentPhone', value: item.phone, autocomplete: 'tel' });
  const parentEmailField = field({ label: 'Email родителя', name: 'parentEmail', value: item.email, autocomplete: 'email' });
  const priceField = field({ label: 'Стоимость занятия, ₽', name: 'lessonPrice', type: 'number', min: 0, value: '' });

  const form = h('div', { class: 'grid gap-4 sm:grid-cols-2' }, [
    nameField,
    birthField,
    courseField,
    groupField,
    teacherField,
    priceField,
    parentNameField,
    parentPhoneField,
    parentEmailField,
  ]);

  const createButton = modalButton('Создать карточку', { kind: 'primary', loadingLabel: 'Создаём…' });

  const modal = openModal({
    title: 'Заявка → ученик',
    subtitle: 'Данные перенесены из заявки, их можно поправить',
    body: [
      h('p', { class: 'text-sm text-muted', text: 'После создания карточки заявка получит статус «Ученик зачислен».' }),
      form,
    ],
    actions: [createButton, modalButton('Отмена', { onClick: () => modal.close() })],
  });

  createButton.addEventListener('click', async () => {
    setButtonLoading(createButton, true);
    showFieldErrors(modal.panel, null);

    try {
      const values = readForm(form);
      // readForm читает и отключённые поля — без права закрепления teacherId
      // не должен уходить в запрос вовсе.
      if (!canAssignTeacher) delete values.teacherId;

      const data = await api(`/applications/${encodeURIComponent(item.id)}/convert`, { method: 'POST', body: values });

      toast('Карточка ученика создана');
      modal.close();
      parentModal.close();
      window.location.href = `/app/students/${data.studentId}`;
    } catch (error) {
      showFieldErrors(modal.panel, error.errors);
      toast(error.message, 'error');
      setButtonLoading(createButton, false);
    }
  });
}

// ----------------------------------------------------------------- фильтры

function initFilters() {
  statusSelect.replaceChildren(
    h('option', { text: 'Все статусы', attrs: { value: 'all' } }),
    ...STATUSES.map((status) => h('option', { text: status.label, attrs: { value: status.id } }))
  );

  searchInput.addEventListener(
    'input',
    debounce(() => {
      state.q = searchInput.value.trim().slice(0, MAX_QUERY_LENGTH);
      applyFilters();
    }, 250)
  );

  statusSelect.addEventListener('change', () => {
    state.status = statusSelect.value;
    applyFilters();
  });

  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value === 'old' ? 'old' : 'new';
    applyFilters();
  });

  fromInput.addEventListener('change', () => {
    state.from = fromInput.value;
    applyFilters();
  });

  toInput.addEventListener('change', () => {
    state.to = toInput.value;
    applyFilters();
  });

  byId('resetFilters').addEventListener('click', () => {
    Object.assign(state, DEFAULT_STATE);
    applyStateToControls();
    applyFilters();
  });

  byId('filters').addEventListener('submit', (event) => event.preventDefault());
}

// -------------------------------------------------------------------- старт

async function init() {
  buildTiles();
  initFilters();

  // Фильтры восстанавливаются до первого запроса: иначе список успел бы дважды моргнуть.
  readUrlState();
  applyStateToControls();

  try {
    const directory = await api('/directory');
    teachers = directory.teachers || [];
  } catch {
    teachers = [];
  }

  await load();

  // Ссылка из уведомления вида /app/applications?id=… сразу открывает нужную заявку.
  // Читается после загрузки списка и до первой правки адреса — syncUrl() уберёт id
  // только когда человек сам тронет фильтры.
  const requestedId = new URLSearchParams(window.location.search).get('id');
  if (requestedId) {
    const found = items.find((item) => item.id === requestedId);
    if (found) openCard(found);
  }

  document.addEventListener(POLL_EVENT, refreshQuietly);
}

init();
