'use strict';

/**
 * Модуль «Финансы»: оборот за период, оплаты, расходы, автоматический расчёт
 * начислений преподавателям и отчёт по занятиям.
 *
 * График рисуется вручную в SVG — без внешних библиотек: политика безопасности
 * страницы запрещает грузить скрипты с чужих доменов, да и один столбчатый график
 * того не стоит.
 */

import './shell.js';
import {
  CATALOG,
  api,
  byId,
  emptyBlock,
  endOfMonth,
  field,
  formatDay,
  formatMoney,
  h,
  modalButton,
  openModal,
  readForm,
  setButtonLoading,
  shiftMonth,
  showFieldErrors,
  startOfMonth,
  toast,
  todayDay,
} from './core.js';

const period = { from: startOfMonth(todayDay()), to: endOfMonth(todayDay()) };

let summary = null;
let students = [];
let teachers = [];

const fromInput = byId('periodFrom');
const toInput = byId('periodTo');

// ------------------------------------------------------------------ плитки

function tile(label, value, hint, tone = '') {
  return h('div', { class: 'tile' }, [
    h('span', { class: 'tile-label', text: label }),
    h('span', { class: `tile-value ${tone}`.trim(), text: value }),
    hint ? h('span', { class: 'tile-hint', text: hint }) : null,
  ]);
}

function renderTiles() {
  const { totals } = summary;

  byId('tiles').replaceChildren(
    tile('Доход', formatMoney(totals.income), `${totals.payments} ${totals.payments === 1 ? 'оплата' : 'оплат'}`),
    tile('Расход', formatMoney(totals.expense)),
    tile('Прибыль', formatMoney(totals.profit), '', totals.profit < 0 ? 'text-red-600' : 'text-mint-700'),
    tile('Проведено занятий', String(totals.lessonsDone), `Всего в расписании: ${totals.lessonsTotal}`)
  );
}

// ------------------------------------------------------------------ график

function renderChart() {
  const points = summary.series.points || [];
  const root = byId('chart');

  if (points.length === 0) {
    root.replaceChildren(emptyBlock('Нет данных за период', 'Добавьте оплату или расход, чтобы увидеть динамику.'));
    return;
  }

  const max = Math.max(1, ...points.map((point) => Math.max(point.income, point.expense)));
  const width = Math.max(points.length * 42, 320);
  const height = 200;
  const barWidth = 14;
  const gap = 4;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height + 28}`);
  svg.setAttribute('class', 'h-56 w-full');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Доходы и расходы по периодам');

  const ns = 'http://www.w3.org/2000/svg';

  // Горизонтальные направляющие
  for (let index = 0; index <= 4; index += 1) {
    const y = height - (height / 4) * index;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('x2', String(width));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    line.setAttribute('stroke', 'rgba(15,18,34,0.07)');
    line.setAttribute('stroke-width', '1');
    svg.append(line);
  }

  points.forEach((point, index) => {
    const centre = (index + 0.5) * (width / points.length);

    const bars = [
      { value: point.income, fill: '#3FBF8F', offset: -(barWidth + gap) / 2 },
      { value: point.expense, fill: '#FF9E64', offset: (barWidth + gap) / 2 },
    ];

    for (const bar of bars) {
      const barHeight = Math.round((bar.value / max) * (height - 8));
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(centre + bar.offset - barWidth / 2));
      rect.setAttribute('y', String(height - barHeight));
      rect.setAttribute('width', String(barWidth));
      rect.setAttribute('height', String(Math.max(barHeight, bar.value > 0 ? 2 : 0)));
      rect.setAttribute('rx', '3');
      rect.setAttribute('fill', bar.fill);

      const title = document.createElementNS(ns, 'title');
      title.textContent = `${labelOfPoint(point.key)}: ${formatMoney(bar.value)}`;
      rect.append(title);

      svg.append(rect);
    }

    // Подписи ставим не подряд, иначе на длинном периоде они наезжают друг на друга.
    const every = Math.ceil(points.length / 12);
    if (index % every === 0) {
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(centre));
      label.setAttribute('y', String(height + 18));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '10');
      label.setAttribute('fill', '#5A6079');
      label.textContent = labelOfPoint(point.key);
      svg.append(label);
    }
  });

  root.replaceChildren(svg);
}

/** Ключ точки — «2026-08» для месяцев и «2026-08-01» для дней. */
function labelOfPoint(key) {
  if (summary.series.byMonth) return `${key.slice(5, 7)}.${key.slice(2, 4)}`;
  return `${key.slice(8)}.${key.slice(5, 7)}`;
}

// ------------------------------------------------------------- начисления

function renderPayroll() {
  const rows = byId('payrollRows');
  const items = summary.payroll || [];

  if (items.length === 0) {
    rows.replaceChildren(
      h('tr', {}, h('td', { class: 'py-6 text-center text-sm text-muted', attrs: { colspan: '6' }, text: 'За период нет проведённых занятий.' }))
    );
    return;
  }

  rows.replaceChildren(
    ...items.map((row) => {
      const done = row.alreadyPaid > 0;

      const button = h('button', {
        class: done ? 'btn btn-outline btn-sm' : 'btn btn-primary btn-sm',
        attrs: { type: 'button' },
        dataset: { labelIdle: done ? 'Начислено' : 'Начислить', labelLoading: 'Начисляем…' },
        props: { disabled: done || row.amount <= 0 },
        text: done ? 'Начислено' : 'Начислить',
        on: { click: () => createPayroll(row, button) },
      });

      return h('tr', {}, [
        h('td', { class: 'font-medium', text: row.name }),
        h('td', { class: 'whitespace-nowrap tnum', text: row.rate ? formatMoney(row.rate) : '— ставка не задана' }),
        h('td', { class: 'tnum', text: String(row.lessons) }),
        h('td', { class: 'whitespace-nowrap font-semibold tnum', text: formatMoney(row.amount) }),
        h('td', { class: 'whitespace-nowrap tnum text-muted', text: row.alreadyPaid ? formatMoney(row.alreadyPaid) : '—' }),
        h('td', { class: 'text-right' }, button),
      ]);
    })
  );
}

async function createPayroll(row, button) {
  if (!window.confirm(`Начислить ${formatMoney(row.amount)} преподавателю «${row.name}» за период ${formatDay(period.from)} — ${formatDay(period.to)}?`)) {
    return;
  }

  // Кнопка блокируется на время запроса: без этого второй клик успевал уйти на сервер
  // раньше, чем таблица перерисуется, и начисление проводилось дважды.
  setButtonLoading(button, true);

  try {
    await api('/finance/payroll', { method: 'POST', body: { teacherId: row.teacherId, from: period.from, to: period.to } });
    toast('Начисление записано в расходы');
    await load(); // строка перерисуется целиком — возвращать кнопку в исходный вид не нужно
  } catch (error) {
    toast(error.message, 'error');
    setButtonLoading(button, false);
  }
}

// ------------------------------------------------------- оплаты и расходы

function renderPayments() {
  const rows = byId('paymentRows');
  const items = summary.payments || [];

  if (items.length === 0) {
    rows.replaceChildren(
      h('tr', {}, h('td', { class: 'py-6 text-center text-sm text-muted', attrs: { colspan: '4' }, text: 'Оплат за период нет.' }))
    );
    return;
  }

  rows.replaceChildren(
    ...items.map((payment) =>
      h('tr', {}, [
        h('td', { class: 'whitespace-nowrap font-mono tnum text-xs', text: formatDay(payment.date) }),
        h('td', {}, [
          h('span', { class: 'block', text: payment.studentName }),
          payment.comment ? h('span', { class: 'block truncate text-xs text-muted', text: payment.comment }) : null,
        ]),
        h('td', { class: 'whitespace-nowrap font-semibold tnum', text: formatMoney(payment.amount) }),
        h(
          'td',
          { class: 'text-right' },
          h('button', {
            class: 'btn btn-sm btn-danger',
            attrs: { type: 'button' },
            text: 'Удалить',
            on: { click: () => removeEntry('payments', payment.id, 'Удалить эту оплату?') },
          })
        ),
      ])
    )
  );
}

function renderExpenses() {
  const rows = byId('expenseRows');
  const items = summary.expenses || [];

  if (items.length === 0) {
    rows.replaceChildren(
      h('tr', {}, h('td', { class: 'py-6 text-center text-sm text-muted', attrs: { colspan: '4' }, text: 'Расходов за период нет.' }))
    );
    return;
  }

  rows.replaceChildren(
    ...items.map((expense) =>
      h('tr', {}, [
        h('td', { class: 'whitespace-nowrap font-mono tnum text-xs', text: formatDay(expense.date) }),
        h('td', {}, [
          h('span', { class: 'block', text: expense.categoryLabel }),
          h('span', { class: 'block truncate text-xs text-muted', text: expense.comment || expense.teacherName || '' }),
        ]),
        h('td', { class: 'whitespace-nowrap font-semibold tnum', text: formatMoney(expense.amount) }),
        h(
          'td',
          { class: 'text-right' },
          h('button', {
            class: 'btn btn-sm btn-danger',
            attrs: { type: 'button' },
            text: 'Удалить',
            on: { click: () => removeEntry('expenses', expense.id, 'Удалить эту запись о расходе?') },
          })
        ),
      ])
    )
  );
}

function renderLessonReport() {
  const rows = byId('lessonReportRows');
  const items = summary.byTeacher || [];

  if (items.length === 0) {
    rows.replaceChildren(
      h('tr', {}, h('td', { class: 'py-6 text-center text-sm text-muted', attrs: { colspan: '4' }, text: 'За период занятий не было.' }))
    );
    return;
  }

  rows.replaceChildren(
    ...items.map((row) =>
      h('tr', { class: 'row-clickable', on: { click: () => (window.location.href = `/app/teachers/${row.teacherId}`) } }, [
        h('td', { class: 'font-medium', text: row.name }),
        h('td', { class: 'tnum', text: String(row.total) }),
        h('td', { class: 'tnum text-mint-700', text: String(row.done) }),
        h('td', { class: 'tnum text-muted', text: String(row.cancelled) }),
      ])
    )
  );
}

async function removeEntry(kind, id, question) {
  if (!window.confirm(question)) return;

  try {
    await api(`/finance/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Запись удалена');
    await load();
  } catch (error) {
    toast(error.message, 'error');
  }
}

// -------------------------------------------------------------------- формы

function openPaymentForm() {
  const form = h('div', { class: 'grid gap-4 sm:grid-cols-2' }, [
    field({
      label: 'Ученик',
      name: 'studentId',
      required: true,
      options: [{ value: '', label: 'Выберите ученика' }, ...students.map((student) => ({ value: student.id, label: student.name }))],
    }),
    field({ label: 'Сумма, ₽', name: 'amount', type: 'number', min: 1, required: true }),
    field({ label: 'Дата', name: 'date', type: 'date', value: todayDay() }),
    field({
      label: 'Способ',
      name: 'method',
      options: (CATALOG.paymentMethods || []).map((method) => ({ value: method.id, label: method.label })),
    }),
    field({ label: 'Оплачено занятий', name: 'lessonsPaid', type: 'number', min: 0 }),
    field({ label: 'Комментарий', name: 'comment' }),
  ]);

  const saveButton = modalButton('Записать оплату', { kind: 'primary', loadingLabel: 'Сохраняем…' });

  const modal = openModal({
    title: 'Новая оплата',
    body: form,
    actions: [saveButton, modalButton('Отмена', { onClick: () => modal.close() })],
  });

  saveButton.addEventListener('click', async () => {
    setButtonLoading(saveButton, true);
    showFieldErrors(modal.panel, null);

    try {
      await api('/finance/payments', { method: 'POST', body: readForm(form) });
      toast('Оплата записана');
      modal.close();
      await load();
    } catch (error) {
      showFieldErrors(modal.panel, error.errors);
      toast(error.message, 'error');
      setButtonLoading(saveButton, false);
    }
  });
}

function openExpenseForm() {
  const teacherField = field({
    label: 'Сотрудник',
    name: 'teacherId',
    options: [{ value: '', label: 'Не связан с сотрудником' }, ...teachers.map((teacher) => ({ value: teacher.id, label: teacher.name }))],
  });

  const form = h('div', { class: 'grid gap-4 sm:grid-cols-2' }, [
    field({
      label: 'Категория',
      name: 'category',
      options: (CATALOG.expenseCategories || []).map((category) => ({ value: category.id, label: category.label })),
    }),
    field({ label: 'Сумма, ₽', name: 'amount', type: 'number', min: 1, required: true }),
    field({ label: 'Дата', name: 'date', type: 'date', value: todayDay() }),
    teacherField,
    field({ label: 'Комментарий', name: 'comment', className: 'sm:col-span-2' }),
  ]);

  const saveButton = modalButton('Записать расход', { kind: 'primary', loadingLabel: 'Сохраняем…' });

  const modal = openModal({
    title: 'Новый расход',
    subtitle: 'Начисления преподавателям удобнее делать кнопкой «Начислить» в таблице выше',
    body: form,
    actions: [saveButton, modalButton('Отмена', { onClick: () => modal.close() })],
  });

  saveButton.addEventListener('click', async () => {
    setButtonLoading(saveButton, true);
    showFieldErrors(modal.panel, null);

    try {
      await api('/finance/expenses', { method: 'POST', body: readForm(form) });
      toast('Расход записан');
      modal.close();
      await load();
    } catch (error) {
      showFieldErrors(modal.panel, error.errors);
      toast(error.message, 'error');
      setButtonLoading(saveButton, false);
    }
  });
}

// -------------------------------------------------------------------- старт

async function load() {
  fromInput.value = period.from;
  toInput.value = period.to;

  try {
    summary = await api('/finance/summary', { query: period });
    renderTiles();
    renderChart();
    renderPayroll();
    renderPayments();
    renderExpenses();
    renderLessonReport();
  } catch (error) {
    byId('tiles').replaceChildren(emptyBlock('Не удалось загрузить финансы', error.message));
  }
}

function initControls() {
  fromInput.addEventListener('change', () => {
    period.from = fromInput.value || period.from;
    load();
  });

  toInput.addEventListener('change', () => {
    period.to = toInput.value || period.to;
    load();
  });

  for (const button of document.querySelectorAll('[data-quick]')) {
    button.addEventListener('click', () => {
      const today = todayDay();

      if (button.dataset.quick === 'month') {
        period.from = startOfMonth(today);
        period.to = endOfMonth(today);
      } else if (button.dataset.quick === 'prev-month') {
        const prev = shiftMonth(today, -1);
        period.from = startOfMonth(prev);
        period.to = endOfMonth(prev);
      } else {
        period.from = `${today.slice(0, 4)}-01-01`;
        period.to = `${today.slice(0, 4)}-12-31`;
      }

      load();
    });
  }

  byId('addPayment').addEventListener('click', openPaymentForm);
  byId('addExpense').addEventListener('click', openExpenseForm);
}

async function init() {
  initControls();

  try {
    const directory = await api('/directory');
    students = directory.students || [];
    teachers = directory.teachers || [];
  } catch {
    students = [];
    teachers = [];
  }

  await load();
}

init();
