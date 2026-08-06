'use strict';

/**
 * Карточка сотрудника: профиль, ставка и оклад, ученики, статистика занятий
 * и предварительный расчёт начисления за период.
 */

import './shell.js';
import {
  CATALOG,
  PC,
  api,
  byId,
  clear,
  confirmModal,
  emptyBlock,
  endOfMonth,
  formatAge,
  formatDateTime,
  formatDay,
  formatMoney,
  h,
  kv,
  roleLabel,
  startOfMonth,
  statusBadge,
  todayDay,
  toast,
} from './core.js';
import { openPasswordForm, openTeacherForm } from './teacher-form.js';

const STUDENT_STATUSES = CATALOG.studentStatuses || [];
const LESSON_STATUSES = CATALOG.lessonStatuses || [];

/**
 * Тот же тон, что и в списке сотрудников (public/js/crm/teachers.js): справочник
 * CATALOG.roles не хранит tone, поэтому цвет закреплён локально здесь же —
 * единообразия ради важно, чтобы бейдж роли выглядел одинаково в списке и в карточке.
 */
const ROLE_TONE = { admin: 'status-cobalt', manager: 'status-violet', teacher: 'status-slate' };

function roleBadge(role) {
  return h('span', { class: `status ${ROLE_TONE[role] || 'status-slate'}`, text: roleLabel(role) });
}

const root = byId('cardRoot');
const stateBox = byId('stateBox');

const period = { from: startOfMonth(todayDay()), to: endOfMonth(todayDay()) };
let data = null;

function panel(title, body, actions = null) {
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [h('h2', { class: 'panel-title', text: title }), actions]),
    h('div', { class: 'panel-body' }, body),
  ]);
}

function tile(label, value, hint) {
  return h('div', { class: 'tile' }, [
    h('span', { class: 'tile-label', text: label }),
    h('span', { class: 'tile-value', text: String(value) }),
    hint ? h('span', { class: 'tile-hint', text: hint }) : null,
  ]);
}

function header(teacher) {
  return h('div', { class: 'panel p-5 sm:p-6' }, [
    h('div', { class: 'flex flex-wrap items-start justify-between gap-4' }, [
      h('div', { class: 'min-w-0' }, [
        h('div', { class: 'flex flex-wrap items-center gap-3' }, [
          h('h2', { class: 'font-display text-2xl font-semibold tracking-tight', text: teacher.name }),
          roleBadge(teacher.role),
          h('span', {
            class: teacher.active ? 'status status-mint' : 'status status-red',
            text: teacher.active ? 'Доступ открыт' : 'Заблокирован',
          }),
        ]),
        h('p', { class: 'mt-1.5 font-mono text-sm text-muted', text: teacher.login }),
      ]),
      h('div', { class: 'flex flex-wrap gap-2' }, [
        h('button', {
          class: 'btn btn-primary btn-sm',
          attrs: { type: 'button' },
          text: 'Редактировать',
          on: {
            click: () =>
              openTeacherForm({
                teacher,
                onSaved: async () => {
                  toast('Данные сотрудника обновлены');
                  await load();
                },
              }),
          },
        }),
        h('button', {
          class: 'btn btn-outline btn-sm',
          attrs: { type: 'button' },
          text: 'Сменить пароль',
          on: { click: () => openPasswordForm(teacher, load) },
        }),
        h('button', {
          class: 'btn btn-outline btn-sm',
          attrs: { type: 'button' },
          text: teacher.active ? 'Заблокировать' : 'Разблокировать',
          on: { click: () => toggleAccess(teacher) },
        }),
        h('button', {
          class: 'btn btn-sm btn-danger',
          attrs: { type: 'button' },
          text: 'Удалить',
          on: { click: () => removeTeacher(teacher) },
        }),
      ]),
    ]),
  ]);
}

function profileBlock(teacher) {
  return panel(
    'Профиль',
    h('dl', { class: 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3' }, [
      h('div', {}, [
        h('dt', { class: 'kv-label', text: 'Роль' }),
        h('dd', { class: 'kv-value' }, roleBadge(teacher.role)),
      ]),
      h('div', {}, [
        h('dt', { class: 'kv-label', text: 'Телефон' }),
        h(
          'dd',
          { class: 'kv-value' },
          teacher.phone
            ? h('a', { class: 'link-inline font-mono tnum', attrs: { href: `tel:${teacher.phone.replace(/[^\d+]/g, '')}` }, text: teacher.phone })
            : document.createTextNode('—')
        ),
      ]),
      h('div', {}, [
        h('dt', { class: 'kv-label', text: 'Email' }),
        h(
          'dd',
          { class: 'kv-value' },
          teacher.email
            ? h('a', { class: 'link-inline', attrs: { href: `mailto:${teacher.email}` }, text: teacher.email })
            : document.createTextNode('—')
        ),
      ]),
      kv('Ставка за занятие', teacher.rate ? formatMoney(teacher.rate) : 'не задана'),
      kv('Оклад за период', teacher.salary ? formatMoney(teacher.salary) : 'не задан'),
      kv('Последний вход', teacher.lastLoginAt ? formatDateTime(teacher.lastLoginAt) : 'ещё не входил', { mono: true }),
      kv('Учётка создана', formatDateTime(teacher.createdAt), { mono: true }),
      h('div', { class: 'sm:col-span-2 lg:col-span-3' }, [
        h('dt', { class: 'kv-label', text: 'Направления' }),
        h('dd', { class: 'mt-1.5 flex flex-wrap gap-1.5' }, (teacher.courses || []).length === 0
          ? h('span', { class: 'text-sm text-muted', text: '—' })
          : teacher.courses.map((course) => h('span', { class: 'chip', text: course }))),
      ]),
      teacher.note
        ? h('div', { class: 'sm:col-span-2 lg:col-span-3' }, [
            h('dt', { class: 'kv-label', text: 'Заметка' }),
            h('dd', { class: 'mt-1 whitespace-pre-line rounded-xl bg-mist/70 px-4 py-3 text-sm', text: teacher.note }),
          ])
        : null,
    ].filter(Boolean))
  );
}

/**
 * Расчёт начисления за период — общий блок для преподавателя (внутри статистики
 * занятий) и для роли без занятий (statsBlock туда вообще не попадает, см.
 * payrollOnlyBlock). Расшифровка суммы: у преподавателя это занятия по ставке,
 * у администратора и управляющего — только оклад, а бывает и то и другое сразу.
 */
function payrollBox(payroll) {
  const parts = [];
  if (payroll.lessons > 0 && payroll.rate > 0) {
    parts.push(`${payroll.lessons} ${payroll.lessons === 1 ? 'занятие' : 'занятий'} × ${formatMoney(payroll.rate)}`);
  }
  if (payroll.salary > 0) parts.push(`оклад ${formatMoney(payroll.salary)}`);

  return h('div', { class: 'mt-4 rounded-2xl border border-cobalt/20 bg-cobalt-100/40 p-4' }, [
    h('p', { class: 'kv-label', text: 'Расчёт начисления за период' }),
    h('p', { class: 'mt-1.5 font-display text-2xl font-semibold', text: formatMoney(payroll.amount) }),
    h('p', {
      class: 'mt-1 text-sm text-muted',
      text: parts.length > 0 ? parts.join(' + ') : 'Нет ни оклада, ни проведённых занятий по ставке',
    }),
    h('a', { class: 'btn btn-outline btn-sm mt-3', attrs: { href: '/app/finance' }, text: 'Начислить в финансах' }),
  ]);
}

function statsBlock(stats, payroll) {
  const tiles = h('div', { class: 'grid grid-cols-2 gap-3 lg:grid-cols-4' }, [
    tile('Проведено всего', stats.done),
    tile('Проведено за период', stats.period.done, `${formatDay(period.from)} — ${formatDay(period.to)}`),
    tile('Запланировано', stats.planned),
    tile('Отменено за период', stats.period.cancelled),
  ]);

  return panel('Статистика занятий', [tiles, payrollBox(payroll)]);
}

/**
 * Упрощённая замена statsBlock + studentsBlock + lessonsBlock для роли без занятий
 * (администратор, управляющий) — вместо четырёх нулевых плиток и двух пустых списков
 * показываем только то, что для этой роли реально есть: сумму и схему начисления.
 */
function payrollOnlyBlock(payroll) {
  return panel('Начисление', [
    h('p', {
      class: 'text-sm text-muted',
      text: 'У этой роли нет собственных занятий и учеников — начисление считается по окладу.',
    }),
    payrollBox(payroll),
  ]);
}

function studentsBlock(students) {
  const body =
    students.length === 0
      ? h('p', { class: 'text-sm text-muted', text: 'Пока никто не закреплён за этим сотрудником.' })
      : h('div', {}, [
          h('div', { class: 'table-scroll hidden lg:block' }, [
            h('table', { class: 'data-table min-w-[32rem]' }, [
              h('thead', {}, h('tr', {}, [
                h('th', { attrs: { scope: 'col' }, text: 'Имя' }),
                h('th', { attrs: { scope: 'col' }, text: 'Возраст' }),
                h('th', { attrs: { scope: 'col' }, text: 'Направление' }),
                h('th', { attrs: { scope: 'col' }, text: 'Статус' }),
              ])),
              h(
                'tbody',
                {},
                students.map((student) =>
                  h(
                    'tr',
                    {
                      class: 'row-clickable',
                      on: { click: () => (window.location.href = `/app/students/${student.id}`) },
                    },
                    [
                      h('td', { class: 'font-medium', text: student.name }),
                      h('td', { class: 'text-muted tnum', text: formatAge(student.age) || '—' }),
                      h('td', { class: 'text-muted', text: student.course || '—' }),
                      h('td', {}, statusBadge(STUDENT_STATUSES, student.status)),
                    ]
                  )
                )
              ),
            ]),
          ]),
          h(
            'div',
            { class: 'space-y-3 lg:hidden' },
            students.map((student) =>
              h(
                'button',
                {
                  class: 'tile tile-clickable block w-full',
                  attrs: { type: 'button', 'aria-label': `Открыть карточку: ${student.name}` },
                  on: { click: () => (window.location.href = `/app/students/${student.id}`) },
                },
                [
                  h('div', { class: 'flex items-start justify-between gap-3' }, [
                    h('div', { class: 'min-w-0' }, [
                      h('p', { class: 'font-display text-base font-semibold', text: student.name }),
                      h('p', { class: 'mt-0.5 text-sm text-muted', text: formatAge(student.age) || 'возраст не указан' }),
                    ]),
                    statusBadge(STUDENT_STATUSES, student.status),
                  ]),
                  h('p', { class: 'mt-2 text-sm text-muted', text: student.course || 'Направление не выбрано' }),
                ]
              )
            )
          ),
        ]);

  return panel(`Ученики (${students.length})`, body);
}

function lessonsBlock(lessons) {
  const body =
    lessons.length === 0
      ? h('p', { class: 'text-sm text-muted', text: 'Занятий пока не было.' })
      : h('div', {}, [
          h('div', { class: 'table-scroll hidden lg:block' }, [
            h('table', { class: 'data-table min-w-[30rem]' }, [
              h('thead', {}, h('tr', {}, [
                h('th', { attrs: { scope: 'col' }, text: 'Дата' }),
                h('th', { attrs: { scope: 'col' }, text: 'Время' }),
                h('th', { attrs: { scope: 'col' }, text: 'Статус' }),
                h('th', { attrs: { scope: 'col' }, text: 'Комментарий' }),
              ])),
              h(
                'tbody',
                {},
                lessons.map((lesson) =>
                  h('tr', {}, [
                    h('td', { class: 'whitespace-nowrap font-mono tnum text-xs', text: formatDay(lesson.date) }),
                    h('td', { class: 'whitespace-nowrap font-mono tnum text-xs text-muted', text: lesson.startTime }),
                    h('td', {}, statusBadge(LESSON_STATUSES, lesson.status)),
                    h('td', { class: 'max-w-[18rem] truncate text-sm text-muted', text: lesson.teacherComment || '—' }),
                  ])
                )
              ),
            ]),
          ]),
          h(
            'div',
            { class: 'space-y-3 lg:hidden' },
            lessons.map((lesson) =>
              h('div', { class: 'tile' }, [
                h('div', { class: 'flex items-start justify-between gap-3' }, [
                  h('div', { class: 'min-w-0' }, [
                    h('p', { class: 'font-display text-base font-semibold', text: formatDay(lesson.date) }),
                    h('p', { class: 'mt-0.5 font-mono text-xs tnum text-muted', text: lesson.startTime }),
                  ]),
                  statusBadge(LESSON_STATUSES, lesson.status),
                ]),
                lesson.teacherComment ? h('p', { class: 'mt-2 text-sm text-muted', text: lesson.teacherComment }) : null,
              ])
            )
          ),
        ]);

  const link = h('a', {
    class: 'btn btn-outline btn-sm',
    attrs: { href: `/app/schedule?teacherId=${encodeURIComponent(PC.teacherId)}` },
    text: 'В расписании',
  });

  return panel('Последние занятия', body, link);
}

// ------------------------------------------------------------------ действия

async function toggleAccess(teacher) {
  const next = !teacher.active;
  const question = next
    ? `Открыть доступ сотруднику «${teacher.name}»?`
    : `Заблокировать доступ сотруднику «${teacher.name}»? Он сразу выйдет из системы.`;
  const confirmed = next
    ? await confirmModal(question, { title: 'Открытие доступа', confirmLabel: 'Открыть', kind: 'primary' })
    : await confirmModal(question, { title: 'Блокировка доступа', confirmLabel: 'Заблокировать' });
  if (!confirmed) return;

  try {
    await api(`/teachers/${encodeURIComponent(teacher.id)}`, { method: 'PATCH', body: { active: next } });
    toast(next ? 'Доступ открыт' : 'Доступ заблокирован');
    await load();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function removeTeacher(teacher) {
  if (!(await confirmModal(`Удалить учётную запись «${teacher.name}»? Ученики останутся, но потеряют закрепление.`, { title: 'Удаление учётной записи' }))) return;

  try {
    await api(`/teachers/${encodeURIComponent(teacher.id)}`, { method: 'DELETE' });
    toast('Учётная запись удалена');
    window.location.href = '/app/teachers';
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ------------------------------------------------------------------- сборка

function render() {
  const teacher = data.item;
  const students = data.students || [];

  // Роль определяет ожидание («ведёт занятия» / «не ведёт»), но решает не она одна:
  // у сотрудника, которого перевели из преподавателей в управляющие, могут остаться
  // реальные исторические занятия и ученики — прятать их не нужно. Полный блок
  // статистики показывается преподавателю всегда и любой другой роли, если по ней
  // действительно есть данные; иначе — только расчёт начисления по окладу.
  const hasTeachingActivity = teacher.role === 'teacher' || data.stats.total > 0 || students.length > 0;

  const blocks = [header(teacher), profileBlock(teacher)];
  if (hasTeachingActivity) {
    blocks.push(statsBlock(data.stats, data.payroll), studentsBlock(students), lessonsBlock(data.recentLessons || []));
  } else {
    blocks.push(payrollOnlyBlock(data.payroll));
  }

  root.replaceChildren(...blocks);
}

async function load() {
  clear(stateBox);

  try {
    data = await api(`/teachers/${encodeURIComponent(PC.teacherId)}`, { query: period });
    render();
  } catch (error) {
    clear(root);
    stateBox.append(emptyBlock('Не удалось открыть карточку', error.message));
  }
}

load();
