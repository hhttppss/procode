'use strict';

/**
 * Модуль «Ученики» — список и фильтры.
 *
 * Одна страница на две роли. Преподавателю сервер отдаёт только его учеников
 * и урезанный набор полей, поэтому в таблице для него просто нет колонок,
 * которых нет в данных.
 */

import './shell.js';
import {
  CATALOG,
  api,
  byId,
  clear,
  debounce,
  emptyBlock,
  formatAge,
  h,
  isAdmin,
  plural,
  statusBadge,
  toast,
} from './core.js';
import { openStudentForm } from './student-form.js';

const STATUSES = CATALOG.studentStatuses || [];

const state = { q: '', course: '', teacherId: '', status: '', ageFrom: '', ageTo: '' };

let items = [];
let counts = { all: 0 };
let byCourse = [];
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
const teacherSelect = byId('filterTeacher');
const statusSelect = byId('filterStatus');
const ageFromInput = byId('filterAgeFrom');
const ageToInput = byId('filterAgeTo');

const teacherName = new Map();

// ------------------------------------------------------------------ плитки

function buildTiles() {
  const tiles = [{ id: 'all', label: isAdmin ? 'Всего учеников' : 'Мои ученики' }, ...STATUSES];

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
      h('div', { class: 'mt-3 space-y-1 text-sm text-muted' }, [
        h('p', { text: student.course || 'Направление не выбрано' }),
        h('p', { text: teacherName.get(student.teacherId) || 'Преподаватель не назначен' }),
      ]),
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
          class: 'flex items-center justify-between gap-3 rounded-xl border border-ink/[0.07] px-3.5 py-2.5 text-left transition hover:border-cobalt/25 hover:bg-mist/50',
          attrs: { type: 'button' },
          on: {
            click: () => {
              state.course = row.course === 'Без направления' ? '' : row.course;
              courseSelect.value = state.course;
              load();
            },
          },
        },
        [
          h('span', { class: 'truncate text-sm', text: row.course }),
          h('span', { class: 'font-mono text-sm font-semibold tnum', text: String(row.count) }),
        ]
      )
    )
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
    else if ((counts.all ?? 0) === 0)
      stateBox.append(
        emptyBlock(
          isAdmin ? 'Учеников пока нет' : 'За вами пока никто не закреплён',
          isAdmin
            ? 'Заведите карточку вручную или конвертируйте заявку с сайта.'
            : 'Как только администратор закрепит за вами ученика, он появится здесь.'
        )
      );
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
    Object.assign(state, { q: '', course: '', teacherId: '', status: '', ageFrom: '', ageTo: '' });
    searchInput.value = '';
    courseSelect.value = '';
    statusSelect.value = '';
    teacherSelect.value = '';
    ageFromInput.value = '';
    ageToInput.value = '';
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
