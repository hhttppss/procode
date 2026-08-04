'use strict';

/**
 * Модуль «Преподаватели»: список сотрудников, создание учётных записей, блокировка.
 * Открывается только администратору — маршрут страницы и API закрыты проверкой роли.
 */

import './shell.js';
import { api, byId, clear, debounce, emptyBlock, formatMoney, h, roleLabel, toast } from './core.js';
import { openTeacherForm } from './teacher-form.js';

let items = [];
let counts = { all: 0, active: 0, blocked: 0 };
let search = '';

const rows = byId('rows');
const cards = byId('cards');
const stateBox = byId('stateBox');
const tilesRoot = byId('tiles');

function visibleItems() {
  if (!search) return items;
  const query = search.toLowerCase();
  return items.filter((item) =>
    [item.name, item.login, item.email, item.phone, (item.courses || []).join(' ')]
      .join(' ')
      .toLowerCase()
      .includes(query)
  );
}

// ------------------------------------------------------------------ плитки

function tile(label, value, hint) {
  return h('div', { class: 'tile' }, [
    h('span', { class: 'tile-label', text: label }),
    h('span', { class: 'tile-value', text: String(value) }),
    hint ? h('span', { class: 'tile-hint', text: hint }) : null,
  ]);
}

function renderTiles() {
  const lessonsDone = items.reduce((total, item) => total + item.stats.period.done, 0);
  const students = items.reduce((total, item) => total + item.studentsCount, 0);

  tilesRoot.replaceChildren(
    tile('Сотрудников', counts.all),
    tile('Доступ открыт', counts.active, counts.blocked > 0 ? `Заблокировано: ${counts.blocked}` : ''),
    tile('Закреплено учеников', students),
    tile('Занятий за месяц', lessonsDone, 'Проведено')
  );
}

// ------------------------------------------------------------------ список

const accessBadge = (active) =>
  h('span', {
    class: active ? 'status status-mint' : 'status status-red',
    text: active ? 'Открыт' : 'Заблокирован',
  });

function openCard(item) {
  window.location.href = `/app/teachers/${item.id}`;
}

function createRow(item) {
  return h(
    'tr',
    { class: 'row-clickable', on: { click: () => openCard(item) } },
    [
      h('td', {}, [
        h('span', { class: 'block font-medium', text: item.name }),
        // Подпись роли — только у тех, кто не просто преподаватель: строка «Преподаватель»
        // под каждым именем в списке преподавателей ничего не сообщает.
        item.role !== 'teacher'
          ? h('span', { class: 'text-2xs uppercase tracking-wider text-cobalt', text: roleLabel(item.role) })
          : null,
      ]),
      h('td', { class: 'font-mono text-xs text-muted', text: item.login }),
      h('td', { class: 'max-w-[16rem] truncate text-sm text-muted', attrs: { title: (item.courses || []).join(', ') }, text: (item.courses || []).join(', ') || '—' }),
      h('td', { class: 'tnum', text: String(item.studentsCount) }),
      h('td', { class: 'tnum', text: String(item.stats.done) }),
      h('td', { class: 'whitespace-nowrap tnum', text: item.rate ? formatMoney(item.rate) : '—' }),
      h('td', {}, accessBadge(item.active)),
      h(
        'td',
        { class: 'text-right' },
        h('button', { class: 'btn btn-outline btn-sm', attrs: { type: 'button' }, text: 'Открыть' })
      ),
    ]
  );
}

function createCard(item) {
  return h(
    'button',
    {
      class: 'tile tile-clickable block w-full',
      attrs: { type: 'button', 'aria-label': `Открыть карточку: ${item.name}` },
      on: { click: () => openCard(item) },
    },
    [
      h('div', { class: 'flex items-start justify-between gap-3' }, [
        h('div', { class: 'min-w-0' }, [
          h('p', { class: 'font-display text-base font-semibold', text: item.name }),
          h('p', { class: 'mt-0.5 font-mono text-xs text-muted', text: item.login }),
          // Та же подпись роли, что и в таблице: без неё на телефоне управляющий
          // и администратор выглядели преподавателями без учеников и ставки.
          item.role !== 'teacher'
            ? h('p', { class: 'mt-1 text-2xs uppercase tracking-wider text-cobalt', text: roleLabel(item.role) })
            : null,
        ]),
        accessBadge(item.active),
      ]),
      h('div', { class: 'mt-3 grid grid-cols-3 gap-2 text-center' }, [
        miniStat('Учеников', item.studentsCount),
        miniStat('Проведено', item.stats.done),
        miniStat('Ставка', item.rate ? `${item.rate} ₽` : '—'),
      ]),
    ]
  );
}

function miniStat(label, value) {
  return h('div', { class: 'rounded-xl bg-mist/60 px-2 py-2' }, [
    h('span', { class: 'block font-mono text-sm font-semibold tnum', text: String(value) }),
    h('span', { class: 'mt-0.5 block text-[11px] text-muted', text: label }),
  ]);
}

function render(errorMessage) {
  renderTiles();

  const visible = visibleItems();
  rows.replaceChildren(...visible.map(createRow));
  cards.replaceChildren(...visible.map(createCard));

  clear(stateBox);
  if (visible.length === 0) {
    if (errorMessage) stateBox.append(emptyBlock('Не удалось загрузить список', errorMessage));
    else if (items.length === 0)
      stateBox.append(emptyBlock('Сотрудников пока нет', 'Заведите первую учётную запись преподавателя.'));
    else stateBox.append(emptyBlock('Никого не нашлось', 'Измените поисковый запрос.'));
  }
}

async function load() {
  try {
    const data = await api('/teachers');
    items = data.items || [];
    counts = data.counts || counts;
    render();
  } catch (error) {
    items = [];
    render(error.message);
  }
}

// -------------------------------------------------------------------- старт

byId('filterSearch').addEventListener(
  'input',
  debounce((event) => {
    search = event.target.value.trim();
    render();
  }, 200)
);

byId('addTeacher').addEventListener('click', () => {
  openTeacherForm({
    onSaved: async (created) => {
      toast(`Учётная запись создана: ${created.login}`);
      await load();
    },
  });
});

load();
