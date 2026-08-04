'use strict';

/**
 * Модуль «Ученики» — список и фильтры.
 *
 * Одна страница на все роли. Преподавателю сервер отдаёт только его учеников
 * и урезанный набор полей, поэтому в таблице для него просто нет колонок,
 * которых нет в данных. Что показывать, решают права (can), а не роль.
 */

import './shell.js';
import {
  CATALOG,
  api,
  byId,
  can,
  clear,
  debounce,
  emptyBlock,
  formatAge,
  h,
  plural,
  statusBadge,
  toast,
} from './core.js';
import { openStudentForm } from './student-form.js';

const STATUSES = CATALOG.studentStatuses || [];

/** Значение фильтра «Без группы» — то же, что понимает сервер. */
const NO_GROUP = '__none__';

/** Ключ хранилища: выбранная группа должна пережить перезагрузку и возврат из карточки. */
const GROUP_STORAGE_KEY = 'pc.students.group';

const state = { q: '', course: '', group: '', teacherId: '', status: '', ageFrom: '', ageTo: '' };

let items = [];
let counts = { all: 0 };
let byCourse = [];
let groups = [];
let withoutGroup = 0;
let teachers = [];
let requestToken = 0;

const rows = byId('rows');
const cards = byId('cards');
const listPanel = byId('listPanel');
const stateBox = byId('stateBox');
const tilesRoot = byId('statusTiles');
const summary = byId('resultSummary');

const searchInput = byId('filterSearch');
const courseSelect = byId('filterCourse');
const groupSelect = byId('filterGroup');
const teacherSelect = byId('filterTeacher');
const statusSelect = byId('filterStatus');
const ageFromInput = byId('filterAgeFrom');
const ageToInput = byId('filterAgeTo');

const teacherName = new Map();

// Всех учеников школы видят администратор и управляющий, преподаватель — только своих.
const seesAllStudents = can('canViewAllStudents');

// --------------------------------------------------- запоминание группы

/** Адрес важнее хранилища: ссылка на отфильтрованный список должна открываться как есть. */
function restoreGroup() {
  const fromUrl = new URLSearchParams(window.location.search).get('group');
  if (fromUrl !== null) return fromUrl;

  try {
    return window.localStorage.getItem(GROUP_STORAGE_KEY) || '';
  } catch {
    // Хранилище может быть недоступно (приватный режим) — тогда фильтр просто не переживёт перезагрузку.
    return '';
  }
}

function rememberGroup() {
  // replaceState, а не pushState: выбор фильтра не должен плодить записи в истории «назад».
  const url = new URL(window.location.href);
  if (state.group) url.searchParams.set('group', state.group);
  else url.searchParams.delete('group');
  window.history.replaceState(null, '', url);

  try {
    if (state.group) window.localStorage.setItem(GROUP_STORAGE_KEY, state.group);
    else window.localStorage.removeItem(GROUP_STORAGE_KEY);
  } catch {
    // Не беда: выбор всё равно остался в адресе страницы.
  }
}

// ------------------------------------------------------------------ плитки

function buildTiles() {
  const tiles = [{ id: 'all', label: seesAllStudents ? 'Всего учеников' : 'Мои ученики' }, ...STATUSES];

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
              state.status = tile.id === 'all' ? '' : tile.id;
              statusSelect.value = state.status;
              load();
            },
          },
        },
        [
          tile.id === 'all' ? h('span', { class: 'tile-label', text: tile.label }) : statusBadge(STATUSES, tile.id),
          h('span', { class: 'tile-value', text: '0', dataset: { count: '' } }),
        ]
      )
    )
  );
}

function renderTiles() {
  for (const tile of tilesRoot.children) {
    const id = tile.dataset.status;
    const active = id === (state.status || 'all');

    tile.querySelector('[data-count]').textContent = String(counts[id] ?? 0);
    tile.setAttribute('aria-pressed', String(active));
    tile.classList.toggle('border-cobalt', active);
    tile.classList.toggle('ring-2', active);
    tile.classList.toggle('ring-cobalt/25', active);
  }
}

// ------------------------------------------------------------------ список

function openCard(student) {
  window.location.href = `/app/students/${student.id}`;
}

function createRow(student) {
  return h(
    'tr',
    { class: 'row-clickable', on: { click: () => openCard(student) } },
    [
      h('td', { class: 'font-medium', text: student.name }),
      h('td', { class: 'whitespace-nowrap text-muted tnum', text: formatAge(student.age) || '—' }),
      h('td', { class: 'text-muted', text: student.course || '—' }),
      h('td', { class: 'text-muted', text: student.group || '—' }),
      h('td', { class: 'text-muted', text: teacherName.get(student.teacherId) || 'не назначен' }),
      h('td', {}, statusBadge(STATUSES, student.status)),
      h(
        'td',
        { class: 'text-right' },
        h('button', {
          class: 'btn btn-outline btn-sm',
          attrs: { type: 'button', 'aria-label': `Открыть карточку: ${student.name}` },
          text: 'Открыть',
        })
      ),
    ]
  );
}

function createCard(student) {
  return h(
    'button',
    {
      class: 'tile tile-clickable block w-full',
      attrs: { type: 'button', 'aria-label': `Открыть карточку: ${student.name}` },
      on: { click: () => openCard(student) },
    },
    [
      h('div', { class: 'flex items-start justify-between gap-3' }, [
        h('div', { class: 'min-w-0' }, [
          h('p', { class: 'font-display text-base font-semibold', text: student.name }),
          h('p', { class: 'mt-0.5 text-sm text-muted', text: formatAge(student.age) || 'возраст не указан' }),
        ]),
        statusBadge(STATUSES, student.status),
      ]),
      h(
        'div',
        { class: 'mt-3 space-y-1 text-sm text-muted' },
        [
          h('p', { text: student.course || 'Направление не выбрано' }),
          // Группа — только когда она есть: в мобильной карточке лишняя строка «—» бесполезна.
          student.group ? h('p', { text: `Группа: ${student.group}` }) : null,
          h('p', { text: teacherName.get(student.teacherId) || 'Преподаватель не назначен' }),
        ].filter(Boolean)
      ),
    ]
  );
}

function renderCourses() {
  const panel = byId('coursePanel');
  const list = byId('courseList');

  if (!byCourse || byCourse.length === 0) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  list.replaceChildren(
    ...byCourse.map((row) =>
      h(
        'button',
        {
          // min-w-0 и на кнопке, и на подписи: без него ни ячейка сетки, ни элемент flex
          // не сжимаются меньше своего текста, и «Веб-разработка (HTML, CSS, JavaScript)»
          // растягивает страницу вместо того, чтобы обрезаться многоточием.
          class: 'flex min-w-0 items-center justify-between gap-3 rounded-xl border border-ink/[0.07] px-3.5 py-2.5 text-left transition hover:border-cobalt/25 hover:bg-mist/50',
          attrs: { type: 'button', title: row.course },
          on: {
            click: () => {
              state.course = row.course === 'Без направления' ? '' : row.course;
              courseSelect.value = state.course;
              load();
            },
          },
        },
        [
          h('span', { class: 'min-w-0 truncate text-sm', text: row.course }),
          h('span', { class: 'shrink-0 font-mono text-sm font-semibold tnum', text: String(row.count) }),
        ]
      )
    )
  );
}

/**
 * Опции собираются из data.groups: справочника групп нет, группа — свободная строка
 * в карточке ученика. Список меняется вместе с остальными фильтрами, поэтому
 * пересобирается после каждой загрузки. Возвращает false, если выбранной группы
 * в новом списке уже нет.
 */
function renderGroupOptions() {
  const options = [
    h('option', { text: 'Все группы', attrs: { value: '' } }),
    ...groups.map((row) => h('option', { text: row.group, attrs: { value: row.group } })),
  ];

  if (withoutGroup > 0) options.push(h('option', { text: 'Без группы', attrs: { value: NO_GROUP } }));

  groupSelect.replaceChildren(...options);

  const exists = options.some((option) => option.value === state.group);
  groupSelect.value = exists ? state.group : '';
  return exists;
}

/** Пустой список звучит по-разному: у преподавателя это «никого не закрепили», у остальных — «никого нет». */
function emptyListBlock() {
  if (!seesAllStudents) {
    return emptyBlock('За вами пока никто не закреплён', 'Как только администратор закрепит за вами ученика, он появится здесь.');
  }

  return emptyBlock(
    'Учеников пока нет',
    can('canEditStudent')
      ? 'Заведите карточку вручную или конвертируйте заявку с сайта.'
      : 'Карточки появятся здесь, как только их заведут.'
  );
}

function render(errorMessage) {
  renderTiles();
  renderCourses();

  rows.replaceChildren(...items.map(createRow));
  cards.replaceChildren(...items.map(createCard));

  const isEmpty = items.length === 0;
  listPanel.hidden = isEmpty;
  clear(stateBox);

  if (isEmpty) {
    if (errorMessage) stateBox.append(emptyBlock('Не удалось загрузить учеников', errorMessage));
    else if ((counts.all ?? 0) === 0) stateBox.append(emptyListBlock());
    else stateBox.append(emptyBlock('Ничего не нашлось', 'Измените условия поиска или сбросьте фильтры.'));
  }

  summary.textContent = isEmpty
    ? ''
    : `Показано ${items.length} ${plural(items.length, 'ученик', 'ученика', 'учеников')} из ${counts.all ?? items.length}`;
}

async function load() {
  const token = ++requestToken;

  try {
    const data = await api('/students', { query: state });
    if (token !== requestToken) return;

    items = data.items || [];
    counts = data.counts || { all: items.length };
    byCourse = data.byCourse || [];
    groups = data.groups || [];
    withoutGroup = data.withoutGroup || 0;

    // Выбранная группа могла исчезнуть (последнего ученика из неё перевели) —
    // тогда фильтр сбрасывается и список перезагружается уже без него.
    if (!renderGroupOptions()) {
      state.group = '';
      rememberGroup();
      await load();
      return;
    }

    render();
  } catch (error) {
    if (token !== requestToken) return;
    items = [];
    render(error.message);
  }
}

// ----------------------------------------------------------------- фильтры

function initFilters() {
  courseSelect.replaceChildren(
    h('option', { text: 'Все направления', attrs: { value: '' } }),
    ...(CATALOG.courses || []).map((course) => h('option', { text: course, attrs: { value: course } }))
  );

  statusSelect.replaceChildren(
    h('option', { text: 'Все статусы', attrs: { value: '' } }),
    ...STATUSES.map((status) => h('option', { text: status.label, attrs: { value: status.id } }))
  );

  // Группы приезжают с данными, но до первой загрузки список не должен быть пустым.
  groupSelect.replaceChildren(h('option', { text: 'Все группы', attrs: { value: '' } }));

  searchInput.addEventListener(
    'input',
    debounce(() => {
      state.q = searchInput.value.trim();
      load();
    }, 250)
  );

  for (const [node, key] of [
    [courseSelect, 'course'],
    [statusSelect, 'status'],
    [teacherSelect, 'teacherId'],
  ]) {
    node.addEventListener('change', () => {
      state[key] = node.value;
      load();
    });
  }

  groupSelect.addEventListener('change', () => {
    state.group = groupSelect.value;
    rememberGroup();
    load();
  });

  for (const [node, key] of [
    [ageFromInput, 'ageFrom'],
    [ageToInput, 'ageTo'],
  ]) {
    node.addEventListener(
      'input',
      debounce(() => {
        state[key] = node.value;
        load();
      }, 350)
    );
  }

  byId('resetFilters').addEventListener('click', () => {
    Object.assign(state, { q: '', course: '', group: '', teacherId: '', status: '', ageFrom: '', ageTo: '' });
    searchInput.value = '';
    courseSelect.value = '';
    groupSelect.value = '';
    statusSelect.value = '';
    teacherSelect.value = '';
    ageFromInput.value = '';
    ageToInput.value = '';
    // Сброс чистит и адрес, и хранилище — иначе группа вернулась бы при следующем заходе.
    rememberGroup();
    load();
  });

  byId('filters').addEventListener('submit', (event) => event.preventDefault());

  byId('addStudent')?.addEventListener('click', () => {
    openStudentForm({
      teachers,
      onSaved: async () => {
        toast('Карточка ученика создана');
        await load();
      },
    });
  });
}

// -------------------------------------------------------------------- старт

async function init() {
  state.group = restoreGroup();

  buildTiles();
  initFilters();

  try {
    const directory = await api('/directory');
    teachers = directory.teachers || [];
    for (const teacher of teachers) teacherName.set(teacher.id, teacher.name);

    teacherSelect.replaceChildren(
      h('option', { text: 'Все преподаватели', attrs: { value: '' } }),
      ...teachers.map((teacher) => h('option', { text: teacher.name, attrs: { value: teacher.id } }))
    );
  } catch {
    teachers = [];
  }

  await load();
}

init();
