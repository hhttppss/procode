'use strict';

/**
 * Главная страница. Одна разметка на все роли, но наборы блоков разные:
 * администратор и управляющий видят сводку по школе, преподаватель — свои занятия
 * и учеников. Разделение делает сервер: /app/api/dashboard просто не присылает
 * финансы преподавателю, а роль в ответе говорит, какую сводку рисовать.
 */

import './shell.js';
import {
  CATALOG,
  USER,
  api,
  byId,
  can,
  clear,
  emptyBlock,
  endOfMonth,
  formatDay,
  formatDayLong,
  formatMoney,
  h,
  plural,
  shiftDay,
  shiftMonth,
  startOfMonth,
  startOfWeek,
  statusBadge,
  statusLabel,
  timeRange,
  todayDay,
} from './core.js';

const STUDENT_STATUSES = CATALOG.studentStatuses || [];
const LESSON_FORMATS = CATALOG.lessonFormats || [];

const period = { from: startOfMonth(todayDay()), to: endOfMonth(todayDay()) };
let current = 'month';

const tilesRoot = byId('tiles');
const panelsRoot = byId('panels');
const periodLabel = byId('periodLabel');

// -------------------------------------------------------------------- блоки

function tile(label, value, hint, href) {
  const children = [
    h('span', { class: 'tile-label', text: label }),
    h('span', { class: 'tile-value', text: String(value) }),
    hint ? h('span', { class: 'tile-hint', text: hint }) : null,
  ];

  return href
    ? h('a', { class: 'tile tile-clickable block', attrs: { href } }, children)
    : h('div', { class: 'tile' }, children);
}

function panel(title, body, link) {
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [
      h('h2', { class: 'panel-title', text: title }),
      link ? h('a', { class: 'text-sm font-medium text-cobalt transition hover:underline', attrs: { href: link.href }, text: link.label }) : null,
    ]),
    h('div', { class: 'panel-body' }, body),
  ]);
}

function barList(rows, { valueFormat = String } = {}) {
  if (!rows || rows.length === 0) {
    return h('p', { class: 'text-sm text-muted', text: 'Пока нет данных.' });
  }

  const max = Math.max(...rows.map((row) => row.value), 1);

  return h(
    'ul',
    { class: 'space-y-2.5' },
    rows.map((row) => {
      // Ширину полосы задаём через CSSOM (bar.style.width), а не attrs.style: CSP
      // (style-src без 'unsafe-inline') блокирует и style="..." в разметке, и
      // setAttribute('style', ...) из JS — h() как раз делает это через setAttribute.
      // Индивидуальное свойство CSSOM политика не трогает.
      const bar = h('div', { class: 'h-full rounded-full bg-cobalt' });
      bar.style.width = `${Math.round((row.value / max) * 100)}%`;

      return h('li', {}, [
        h('div', { class: 'flex items-baseline justify-between gap-3' }, [
          // min-w-0 обязателен: без него truncate не срабатывает — элемент flex
          // не сжимается меньше своего текста, и длинное направление растягивает панель.
          h('span', { class: 'min-w-0 truncate text-sm', attrs: { title: row.label }, text: row.label }),
          h('span', { class: 'shrink-0 font-mono text-sm font-semibold tnum', text: valueFormat(row.value) }),
        ]),
        h('div', { class: 'mt-1 h-1.5 overflow-hidden rounded-full bg-mist' }, bar),
      ]);
    })
  );
}

// ------------------------------------------ сводка по школе (админ, управляющий)

function renderAdmin(data) {
  // Плитка «Преподаватели» ведёт в модуль учётных записей — управляющему он закрыт,
  // поэтому у него на её месте ничего нет, а не ссылка в 403.
  // Сетку подгоняем под число плиток: три штуки в четырёх колонках оставляли
  // на широком экране пустую четверть ряда. Классы записаны целиком — Tailwind
  // ищет их в тексте исходника и склеенное имя не увидит.
  tilesRoot.className = can('canManageUsers')
    ? 'grid grid-cols-2 gap-3 lg:grid-cols-4'
    : 'grid grid-cols-2 gap-3 lg:grid-cols-3';

  tilesRoot.replaceChildren(
    ...[
      tile('Учеников всего', data.students.total, `Активных: ${data.students.byStatus.active || 0}`, '/app/students'),
      tile('Новых заявок', data.applications.period, `Не обработано: ${data.applications.new}`, '/app/applications'),
      can('canManageUsers')
        ? tile('Преподавателей', data.teachers.total, `Доступ открыт: ${data.teachers.active}`, '/app/teachers')
        : null,
      tile('Оборот за период', formatMoney(data.finance.income), `Прибыль: ${formatMoney(data.finance.profit)}`, '/app/finance'),
    ].filter(Boolean)
  );

  const lessons = data.lessons;

  panelsRoot.replaceChildren(
    panel(
      'Занятия за период',
      h('div', { class: 'grid grid-cols-2 gap-3 sm:grid-cols-4' }, [
        miniStat('Всего', lessons.total),
        miniStat('Проведено', lessons.done),
        miniStat('Запланировано', lessons.planned),
        miniStat('Отменено', lessons.cancelled),
      ]),
      { href: '/app/schedule', label: 'Расписание' }
    ),

    panel(
      'Ученики по направлениям',
      barList(data.students.byCourse.map((row) => ({ label: row.course, value: row.count }))),
      { href: '/app/students', label: 'Все ученики' }
    ),

    panel(
      'Заявки по статусам',
      h(
        'ul',
        { class: 'space-y-2' },
        (CATALOG.applicationStatuses || []).map((status) =>
          h('li', { class: 'flex items-center justify-between gap-3' }, [
            statusBadge(CATALOG.applicationStatuses, status.id),
            h('span', { class: 'font-mono text-sm font-semibold tnum', text: String(data.applications.byStatus[status.id] || 0) }),
          ])
        )
      ),
      { href: '/app/applications', label: 'Все заявки' }
    ),

    panel(
      'Финансы за период',
      h('dl', { class: 'space-y-3' }, [
        moneyRow('Доход', data.finance.income, 'text-mint-700'),
        moneyRow('Расход', data.finance.expense, 'text-apricot-700'),
        moneyRow('Прибыль', data.finance.profit, data.finance.profit < 0 ? 'text-red-600' : ''),
      ]),
      { href: '/app/finance', label: 'Подробно' }
    )
  );
}

function miniStat(label, value) {
  return h('div', { class: 'rounded-xl bg-mist/60 px-3 py-3 text-center' }, [
    h('span', { class: 'block font-display text-xl font-semibold tnum', text: String(value) }),
    h('span', { class: 'mt-0.5 block text-xs text-muted', text: label }),
  ]);
}

function moneyRow(label, value, tone) {
  return h('div', { class: 'flex items-baseline justify-between gap-3 border-b border-ink/[0.06] pb-2.5 last:border-0 last:pb-0' }, [
    h('dt', { class: 'text-sm text-muted', text: label }),
    h('dd', { class: `font-display text-lg font-semibold tnum ${tone}`.trim(), text: formatMoney(value) }),
  ]);
}

// ------------------------------------------------------------ преподаватель

function lessonRow(lesson) {
  return h(
    'a',
    {
      class: 'flex items-start gap-3 rounded-xl border border-ink/[0.07] p-3 transition hover:border-cobalt/25 hover:bg-mist/40',
      attrs: { href: `/app/schedule?date=${lesson.date}` },
    },
    [
      h('span', { class: 'w-24 shrink-0' }, [
        h('span', { class: 'block font-mono text-sm font-semibold tnum', text: lesson.startTime }),
        h('span', { class: 'block font-mono text-[11px] text-muted tnum', text: formatDay(lesson.date) }),
      ]),
      h('span', { class: 'min-w-0 flex-1' }, [
        h('span', { class: 'block truncate font-medium', text: lesson.title || lesson.course || 'Занятие' }),
        h('span', {
          class: 'mt-0.5 block truncate text-xs text-muted',
          text: `${lesson.studentIds.length} ${plural(lesson.studentIds.length, 'ученик', 'ученика', 'учеников')} · ${statusLabel(
            LESSON_FORMATS,
            lesson.format
          )}`,
        }),
      ]),
    ]
  );
}

function renderTeacher(data) {
  const next = data.upcoming[0];

  tilesRoot.replaceChildren(
    tile('Моих учеников', data.students.total, `Активных: ${data.students.byStatus.active || 0}`, '/app/students'),
    tile('Проведено за период', data.lessons.done, `Всего за время работы: ${data.lessons.doneAllTime}`),
    tile('Запланировано', data.lessons.planned, 'За выбранный период', '/app/schedule'),
    tile('Отменено за период', data.lessons.cancelled)
  );

  const nextBlock = next
    ? h('div', { class: 'rounded-2xl border border-cobalt/20 bg-cobalt-100/40 p-4' }, [
        h('p', { class: 'kv-label', text: 'Ближайшее занятие' }),
        h('p', { class: 'mt-1.5 font-display text-lg font-semibold', text: formatDayLong(next.date) }),
        h('p', { class: 'mt-0.5 font-mono text-sm tnum', text: timeRange(next.startTime, next.durationMin) }),
        h('p', { class: 'mt-2 text-sm text-muted', text: next.title || next.course || 'Занятие' }),
        next.link
          ? h('a', { class: 'btn btn-primary btn-sm mt-3', attrs: { href: next.link, target: '_blank', rel: 'noopener noreferrer' }, text: 'Подключиться' })
          : null,
      ])
    : emptyBlock('Ближайших занятий нет', 'Как только администратор поставит занятие, оно появится здесь.');

  panelsRoot.replaceChildren(
    panel('Что дальше', [nextBlock, ...(data.upcoming.length > 1 ? [h('div', { class: 'mt-3 space-y-2' }, data.upcoming.slice(1).map(lessonRow))] : [])], {
      href: '/app/schedule',
      label: 'Всё расписание',
    }),

    panel(
      'Нужно отметить итог',
      data.needsReport.length === 0
        ? h('p', { class: 'text-sm text-muted', text: 'Все прошедшие занятия отмечены. Спасибо!' })
        : h('div', { class: 'space-y-2' }, data.needsReport.map(lessonRow)),
      { href: '/app/schedule', label: 'Открыть' }
    ),

    panel(
      'Мои ученики по статусам',
      h(
        'ul',
        { class: 'space-y-2' },
        STUDENT_STATUSES.map((status) =>
          h('li', { class: 'flex items-center justify-between gap-3' }, [
            statusBadge(STUDENT_STATUSES, status.id),
            h('span', { class: 'font-mono text-sm font-semibold tnum', text: String(data.students.byStatus[status.id] || 0) }),
          ])
        )
      ),
      { href: '/app/students', label: 'Список' }
    )
  );
}

// -------------------------------------------------------------------- старт

async function load() {
  periodLabel.textContent = `${formatDay(period.from)} — ${formatDay(period.to)}`;

  try {
    const data = await api('/dashboard', { query: period });
    clear(panelsRoot);
    // У управляющего payload такой же, как у администратора, — и сводка та же.
    if (data.role === 'admin' || data.role === 'manager') renderAdmin(data);
    else renderTeacher(data);
  } catch (error) {
    tilesRoot.replaceChildren(emptyBlock('Не удалось загрузить сводку', error.message));
    clear(panelsRoot);
  }
}

function setPeriod(name) {
  const today = todayDay();
  current = name;

  if (name === 'week') {
    period.from = startOfWeek(today);
    period.to = shiftDay(period.from, 6);
  } else if (name === 'month') {
    period.from = startOfMonth(today);
    period.to = endOfMonth(today);
  } else if (name === 'quarter') {
    period.from = startOfMonth(shiftMonth(today, -2));
    period.to = endOfMonth(today);
  } else {
    period.from = `${today.slice(0, 4)}-01-01`;
    period.to = `${today.slice(0, 4)}-12-31`;
  }

  for (const button of document.querySelectorAll('[data-period]')) {
    button.setAttribute('aria-pressed', String(button.dataset.period === current));
  }

  load();
}

for (const button of document.querySelectorAll('[data-period]')) {
  button.addEventListener('click', () => setPeriod(button.dataset.period));
}

// Приветствие в подзаголовке страницы делает главную чуть менее казённой.
// Ветка — по праву видеть всех учеников: сводка по школе есть у всех, кто видит школу целиком.
const subheading = document.querySelector('header p');
if (subheading && USER.name) {
  subheading.textContent = can('canViewAllStudents')
    ? `${USER.name} · сводка по школе`
    : `${USER.name} · ваши занятия и ученики`;
}

setPeriod('month');
