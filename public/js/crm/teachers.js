'use strict';

/**
 * Модуль «Сотрудники»: список учётных записей всех ролей, создание, блокировка.
 * Открывается только администратору — маршрут страницы и API закрыты проверкой роли.
 * Адреса остались прежними (/app/teachers): переименована подпись раздела, а не URL.
 */

import './shell.js';
import { api, byId, clear, debounce, emptyBlock, formatMoney, h, roleLabel, toast } from './core.js';
import { openTeacherForm } from './teacher-form.js';

let items = [];
let counts = { all: 0, active: 0, blocked: 0 };
let search = '';

/**
 * Тон бейджа роли. Справочник CATALOG.roles хранит только id и label (в отличие от
 * статусов, у которых есть tone) — раздел единственный, где роль показывается как
 * самостоятельный признак, поэтому цвет закреплён локально здесь же. Преподаватель —
 * самая частая роль в школе, ей оставлен нейтральный тон, чтобы не спорить с акцентом
 * на администраторе и управляющем.
 */
const ROLE_TONE = { admin: 'status-cobalt', manager: 'status-violet', teacher: 'status-slate' };

function roleBadge(role) {
  return h('span', { class: `status ${ROLE_TONE[role] || 'status-slate'}`, text: roleLabel(role) });
}

/**
 * Ставка «за занятие» и оклад «за период» — две разные схемы начисления. Раньше это
 * были соседние числовые столбцы без подписи: у преподавателя пусто в «Окладе», у
 * администратора пусто в «Ставке», и с одного взгляда не понять, что означает
 * заполненное число. Собираем обе величины в список строк с подписью схемы —
 * дальше решает вызывающий код, показывать их колонкой в таблице или строкой в карточке.
 */
function payLines(item) {
  const lines = [];
  if (Number(item.rate) > 0) lines.push({ value: formatMoney(item.rate), hint: 'за занятие' });
  if (Number(item.salary) > 0) lines.push({ value: formatMoney(item.salary), hint: 'оклад' });
  return lines;
}

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

/** Колонка «Оплата»: одна или две строки «сумма — схема начисления» вместо двух чисел без подписи. */
function payCell(item) {
  const lines = payLines(item);
  if (lines.length === 0) return h('td', { class: 'text-muted', text: '—' });

  return h(
    'td',
    { class: 'whitespace-nowrap' },
    lines.map((line, index) =>
      h('div', { class: index > 0 ? 'mt-0.5' : '' }, [
        h('span', { class: 'tnum font-medium', text: line.value }),
        h('span', { class: 'ml-1.5 text-2xs text-muted', text: line.hint }),
      ])
    )
  );
}

function createRow(item) {
  return h(
    'tr',
    { class: 'row-clickable', on: { click: () => openCard(item) } },
    [
      h('td', { class: 'font-medium', text: item.name }),
      h('td', {}, roleBadge(item.role)),
      h('td', { class: 'font-mono text-xs text-muted', text: item.login }),
      h('td', { class: 'max-w-[16rem] truncate text-sm text-muted', attrs: { title: (item.courses || []).join(', ') }, text: (item.courses || []).join(', ') || '—' }),
      h('td', { class: 'tnum', text: String(item.studentsCount) }),
      h('td', { class: 'tnum', text: String(item.stats.done) }),
      payCell(item),
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
        ]),
        accessBadge(item.active),
      ]),
      // Роль — отдельной строкой на всю ширину карточки, а не втиснута в узкую левую
      // колонку рядом с бейджем доступа: «Управляющий школы» в этой колонке на
      // телефоне не помещается и вылезает за пределы плитки.
      h('div', { class: 'mt-2' }, roleBadge(item.role)),
      // Учеников/проведено — равные половинки: числа короткие, «30» никогда не переносится.
      h('div', { class: 'mt-3 grid grid-cols-2 gap-2 text-center' }, [
        miniStat('Учеников', item.studentsCount),
        miniStat('Проведено', item.stats.done),
      ]),
      // Оплата — отдельная строка на всю ширину карточки, а не третья колонка сетки:
      // «30 000 ₽» в трети ширины телефона переносится посреди числа, а сумма — самое
      // важное значение в строке, ему нельзя ломаться.
      payMiniStat(item),
    ]
  );
}

function miniStat(label, value) {
  return h('div', { class: 'rounded-xl bg-mist/60 px-2 py-2' }, [
    h('span', { class: 'block font-mono text-sm font-semibold tnum', text: String(value) }),
    h('span', { class: 'mt-0.5 block text-[11px] text-muted', text: label }),
  ]);
}

function payMiniStat(item) {
  const lines = payLines(item);
  if (lines.length === 0) {
    return h('div', { class: 'mt-2 flex items-center justify-between rounded-xl bg-mist/60 px-3 py-2' }, [
      h('span', { class: 'text-[11px] text-muted', text: 'Оплата' }),
      h('span', { class: 'font-mono text-sm text-muted', text: '—' }),
    ]);
  }

  return h(
    'div',
    { class: 'mt-2 space-y-1 rounded-xl bg-mist/60 px-3 py-2' },
    lines.map((line) =>
      h('div', { class: 'flex items-center justify-between gap-3' }, [
        h('span', { class: 'text-[11px] text-muted', text: line.hint }),
        h('span', { class: 'font-mono text-sm font-semibold tnum', text: line.value }),
      ])
    )
  );
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
      stateBox.append(emptyBlock('Сотрудников пока нет', 'Заведите первую учётную запись сотрудника.'));
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
