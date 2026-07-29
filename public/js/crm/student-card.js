'use strict';

/**
 * Карточка ученика.
 *
 * Блоки «Родители», «Оплаты» и «История» строятся только тогда, когда сервер прислал
 * соответствующие данные. Преподавателю он их не присылает — значит, у него этих блоков
 * нет вовсе, а не «скрыты стилями».
 */

import './shell.js';
import {
  CATALOG,
  PC,
  api,
  byId,
  clear,
  emptyBlock,
  field,
  formatAge,
  formatDay,
  formatDayLong,
  formatDateTime,
  formatMoney,
  h,
  isAdmin,
  kv,
  modalButton,
  openModal,
  readForm,
  setButtonLoading,
  showFieldErrors,
  statusBadge,
  statusLabel,
  timeRange,
  toast,
} from './core.js';
import { openStudentForm } from './student-form.js';

const STUDENT_STATUSES = CATALOG.studentStatuses || [];
const LESSON_STATUSES = CATALOG.lessonStatuses || [];
const ATTENDANCE = CATALOG.attendance || [];

const root = byId('cardRoot');
const stateBox = byId('stateBox');

let data = null;
let teachers = [];

// -------------------------------------------------------------------- блоки

function panel(title, body, actions = null) {
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [h('h2', { class: 'panel-title', text: title }), actions]),
    h('div', { class: 'panel-body' }, body),
  ]);
}

function header(student) {
  const actions = [];

  if (isAdmin) {
    actions.push(
      h('button', {
        class: 'btn btn-primary btn-sm',
        attrs: { type: 'button' },
        text: 'Редактировать',
        on: {
          click: () =>
            openStudentForm({
              student,
              teachers,
              onSaved: async () => {
                toast('Карточка обновлена');
                await load();
              },
            }),
        },
      }),
      h('button', {
        class: 'btn btn-outline btn-sm',
        attrs: { type: 'button' },
        text: 'Добавить оплату',
        on: { click: () => openPaymentForm(student) },
      }),
      h('button', {
        class: 'btn btn-sm btn-danger',
        attrs: { type: 'button' },
        text: 'Удалить',
        on: { click: () => removeStudent(student) },
      })
    );
  }

  return h('div', { class: 'panel p-5 sm:p-6' }, [
    h('div', { class: 'flex flex-wrap items-start justify-between gap-4' }, [
      h('div', { class: 'min-w-0' }, [
        h('div', { class: 'flex flex-wrap items-center gap-3' }, [
          h('h2', { class: 'font-display text-2xl font-semibold tracking-tight', text: student.name }),
          statusBadge(STUDENT_STATUSES, student.status),
        ]),
        h('p', { class: 'mt-1.5 text-sm text-muted', text: [formatAge(student.age), student.course, student.group].filter(Boolean).join(' · ') || 'Данные пока не заполнены' }),
      ]),
      actions.length > 0 ? h('div', { class: 'flex flex-wrap gap-2' }, actions) : null,
    ]),
  ]);
}

function mainInfo(student, teacher) {
  return panel(
    'Основное',
    h('dl', { class: 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3' }, [
      kv('Дата рождения', student.birthDate ? formatDayLong(student.birthDate) : '—'),
      kv('Возраст', formatAge(student.age) || '—'),
      kv('Направление', student.course || '—'),
      kv('Группа', student.group || '—'),
      kv('Преподаватель', teacher ? teacher.name : 'не назначен'),
      kv('Начало занятий', student.startedAt ? formatDay(student.startedAt) : '—'),
      isAdmin ? kv('Стоимость занятия', student.lessonPrice ? formatMoney(student.lessonPrice) : '—') : null,
      kv('Карточка создана', formatDateTime(student.createdAt), { mono: true }),
    ].filter(Boolean))
  );
}

function traitsBlock(student) {
  const traits = student.traits || {};
  const labels = [
    ['pace', 'Темп'],
    ['behavior', 'Поведение'],
    ['health', 'Здоровье'],
    ['wishes', 'Пожелания'],
  ];

  const filled = labels.filter(([key]) => traits[key]);

  return panel(
    'Особенности',
    filled.length === 0
      ? h('p', { class: 'text-sm text-muted', text: 'Пока ничего не отмечено.' })
      : h(
          'dl',
          { class: 'grid gap-4 sm:grid-cols-2' },
          filled.map(([key, label]) =>
            h('div', {}, [
              h('dt', { class: 'kv-label', text: label }),
              h('dd', { class: 'mt-1 whitespace-pre-line text-sm', text: traits[key] }),
            ])
          )
        )
  );
}

/** Блок родителей строится, только если сервер прислал эти поля (то есть для администратора). */
function parentsBlock(student) {
  const phone = student.parentPhone;

  return panel(
    'Родители и контакты',
    h('dl', { class: 'grid gap-4 sm:grid-cols-2' }, [
      kv('ФИО родителя', student.parentName || '—'),
      h('div', {}, [
        h('dt', { class: 'kv-label', text: 'Телефон' }),
        h(
          'dd',
          { class: 'kv-value' },
          phone
            ? h('a', {
                class: 'link-inline font-mono tnum',
                attrs: { href: `tel:${phone.replace(/[^\d+]/g, '')}` },
                text: phone,
              })
            : document.createTextNode('—')
        ),
      ]),
      h('div', {}, [
        h('dt', { class: 'kv-label', text: 'Email' }),
        h(
          'dd',
          { class: 'kv-value' },
          student.parentEmail
            ? h('a', { class: 'link-inline', attrs: { href: `mailto:${student.parentEmail}` }, text: student.parentEmail })
            : document.createTextNode('—')
        ),
      ]),
      kv('Второй родитель', student.parentSecond || '—'),
      student.adminNote
        ? h('div', { class: 'sm:col-span-2' }, [
            h('dt', { class: 'kv-label', text: 'Заметка администратора' }),
            h('dd', { class: 'mt-1 whitespace-pre-line rounded-xl bg-mist/70 px-4 py-3 text-sm', text: student.adminNote }),
          ])
        : null,
    ].filter(Boolean))
  );
}

function attendanceBlock(stats, lessons, studentId) {
  const tiles = h('div', { class: 'grid grid-cols-2 gap-3 sm:grid-cols-4' }, [
    tile('Всего занятий', stats.total),
    tile('Проведено', stats.done),
    tile('Был на занятии', stats.attendance.present),
    tile('Пропустил', stats.attendance.absent),
  ]);

  const list =
    lessons.length === 0
      ? h('p', { class: 'mt-4 text-sm text-muted', text: 'Занятий пока не было.' })
      : h('div', { class: 'table-scroll mt-4' }, [
          h('table', { class: 'data-table min-w-[34rem]' }, [
            h('thead', {}, h('tr', {}, [
              h('th', { attrs: { scope: 'col' }, text: 'Дата' }),
              h('th', { attrs: { scope: 'col' }, text: 'Время' }),
              h('th', { attrs: { scope: 'col' }, text: 'Статус' }),
              h('th', { attrs: { scope: 'col' }, text: 'Посещение' }),
              h('th', { attrs: { scope: 'col' }, text: 'Комментарий' }),
            ])),
            h(
              'tbody',
              {},
              lessons.map((lesson) =>
                h('tr', {}, [
                  h('td', { class: 'whitespace-nowrap font-mono tnum text-xs', text: formatDay(lesson.date) }),
                  h('td', { class: 'whitespace-nowrap font-mono tnum text-xs text-muted', text: timeRange(lesson.startTime, lesson.durationMin) }),
                  h('td', {}, statusBadge(LESSON_STATUSES, lesson.status)),
                  h('td', { class: 'text-sm text-muted', text: lesson.attendanceMark ? statusLabel(ATTENDANCE, lesson.attendanceMark) : '—' }),
                  h('td', { class: 'max-w-[18rem] truncate text-sm text-muted', attrs: { title: lesson.teacherComment || '' }, text: lesson.teacherComment || '—' }),
                ])
              )
            ),
          ]),
        ]);

  const scheduleLink = h('a', {
    class: 'btn btn-outline btn-sm',
    attrs: { href: `/app/schedule?studentId=${encodeURIComponent(studentId)}` },
    text: 'В расписании',
  });

  return panel('Посещаемость и прогресс', [tiles, list], scheduleLink);
}

function tile(label, value, hint) {
  return h('div', { class: 'tile' }, [
    h('span', { class: 'tile-label', text: label }),
    h('span', { class: 'tile-value', text: String(value ?? 0) }),
    hint ? h('span', { class: 'tile-hint', text: hint }) : null,
  ]);
}

function paymentsBlock(payments, paid, student) {
  const addButton = h('button', {
    class: 'btn btn-outline btn-sm',
    attrs: { type: 'button' },
    text: 'Добавить оплату',
    on: { click: () => openPaymentForm(student) },
  });

  const body =
    payments.length === 0
      ? h('p', { class: 'text-sm text-muted', text: 'Оплат пока не было.' })
      : h('div', {}, [
          h('p', { class: 'mb-3 text-sm' }, [
            h('span', { class: 'text-muted', text: 'Оплачено всего: ' }),
            h('span', { class: 'font-display text-base font-semibold', text: formatMoney(paid) }),
          ]),
          h('div', { class: 'table-scroll' }, [
            h('table', { class: 'data-table min-w-[30rem]' }, [
              h('thead', {}, h('tr', {}, [
                h('th', { attrs: { scope: 'col' }, text: 'Дата' }),
                h('th', { attrs: { scope: 'col' }, text: 'Сумма' }),
                h('th', { attrs: { scope: 'col' }, text: 'Способ' }),
                h('th', { attrs: { scope: 'col' }, text: 'Комментарий' }),
              ])),
              h(
                'tbody',
                {},
                payments.map((payment) =>
                  h('tr', {}, [
                    h('td', { class: 'whitespace-nowrap font-mono tnum text-xs', text: formatDay(payment.date) }),
                    h('td', { class: 'whitespace-nowrap font-semibold tnum', text: formatMoney(payment.amount) }),
                    h('td', { class: 'text-sm text-muted', text: statusLabel(CATALOG.paymentMethods || [], payment.method) }),
                    h('td', { class: 'text-sm text-muted', text: payment.comment || '—' }),
                  ])
                )
              ),
            ]),
          ]),
        ]);

  return panel('История оплат', body, addButton);
}

function historyBlock(history) {
  const body =
    !history || history.length === 0
      ? h('p', { class: 'text-sm text-muted', text: 'Карточку ещё не меняли.' })
      : h(
          'ol',
          { class: 'space-y-3' },
          history.map((entry) =>
            h('li', { class: 'border-l-2 border-cobalt/25 pl-3' }, [
              h('p', { class: 'font-mono text-[11px] text-muted', text: `${formatDateTime(entry.createdAt)} · ${entry.byName}` }),
              entry.comment ? h('p', { class: 'mt-1 text-sm', text: entry.comment }) : null,
              entry.changes && entry.changes.length > 0
                ? h(
                    'ul',
                    { class: 'mt-1 space-y-0.5' },
                    entry.changes.map((change) =>
                      h('li', { class: 'text-sm' }, [
                        h('span', { class: 'text-muted', text: `${change.label}: ` }),
                        h('span', { class: 'line-through decoration-ink/30', text: change.from || 'пусто' }),
                        h('span', { class: 'text-muted', text: ' → ' }),
                        h('span', { class: 'font-medium', text: change.to || 'пусто' }),
                      ])
                    )
                  )
                : null,
            ])
          )
        );

  return panel('История изменений', body);
}

// ------------------------------------------------------------------ оплата

function openPaymentForm(student) {
  const today = new Date().toISOString().slice(0, 10);

  const form = h('div', { class: 'grid gap-4 sm:grid-cols-2' }, [
    field({ label: 'Сумма, ₽', name: 'amount', type: 'number', min: 1, required: true }),
    field({ label: 'Дата', name: 'date', type: 'date', value: today }),
    field({
      label: 'Способ',
      name: 'method',
      options: (CATALOG.paymentMethods || []).map((method) => ({ value: method.id, label: method.label })),
    }),
    field({ label: 'Оплачено занятий', name: 'lessonsPaid', type: 'number', min: 0, hint: 'Необязательно' }),
    field({ label: 'Комментарий', name: 'comment', className: 'sm:col-span-2' }),
  ]);

  const saveButton = modalButton('Записать оплату', { kind: 'primary', loadingLabel: 'Сохраняем…' });

  const modal = openModal({
    title: 'Оплата',
    subtitle: student.name,
    body: form,
    actions: [saveButton, modalButton('Отмена', { onClick: () => modal.close() })],
  });

  saveButton.addEventListener('click', async () => {
    setButtonLoading(saveButton, true);
    showFieldErrors(modal.panel, null);

    try {
      await api('/finance/payments', { method: 'POST', body: { ...readForm(form), studentId: student.id } });
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

async function removeStudent(student) {
  if (!window.confirm(`Удалить карточку «${student.name}»? Занятия и оплаты по ней тоже будут удалены.`)) return;

  try {
    await api(`/students/${encodeURIComponent(student.id)}`, { method: 'DELETE' });
    toast('Карточка удалена');
    window.location.href = '/app/students';
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ------------------------------------------------------------------- сборка

function render() {
  const { item: student, teacher, stats, lessons, payments, paid, history } = data;

  const blocks = [
    header(student),
    mainInfo(student, teacher),
    traitsBlock(student),
    // Эти поля приходят только администратору — у преподавателя блока просто нет.
    Object.prototype.hasOwnProperty.call(student, 'parentPhone') ? parentsBlock(student) : null,
    attendanceBlock(stats, lessons, student.id),
    payments ? paymentsBlock(payments, paid, student) : null,
    history ? historyBlock(history) : null,
  ].filter(Boolean);

  root.replaceChildren(...blocks);
}

async function load() {
  clear(stateBox);

  try {
    data = await api(`/students/${encodeURIComponent(PC.studentId)}`);
    render();
  } catch (error) {
    clear(root);
    stateBox.append(
      emptyBlock(error.status === 403 ? 'Нет доступа' : 'Не удалось открыть карточку', error.message)
    );
  }
}

async function init() {
  if (isAdmin) {
    try {
      const directory = await api('/directory');
      teachers = directory.teachers || [];
    } catch {
      teachers = [];
    }
  }

  await load();
}

init();
