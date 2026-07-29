'use strict';

/**
 * Модуль «Расписание».
 *
 * Администратор: календарь день/неделя/месяц, создание занятий (в том числе
 * повторяющихся), перенос и удаление.
 * Преподаватель: только свои занятия в видах «день» и «неделя», без редактирования —
 * ему доступна лишь отметка итога: проведено / отменено / перенесено, комментарий
 * и посещаемость. Набор полей ограничен и на сервере.
 */

import './shell.js';
import {
  CATALOG,
  WEEKDAYS_SHORT,
  api,
  byId,
  clear,
  emptyBlock,
  endOfMonth,
  field,
  formatDay,
  formatDayLong,
  h,
  isAdmin,
  kv,
  modalButton,
  monthTitle,
  openModal,
  readForm,
  setButtonLoading,
  shiftDay,
  shiftMonth,
  showFieldErrors,
  startOfMonth,
  startOfWeek,
  statusBadge,
  statusLabel,
  timeRange,
  toast,
  todayDay,
} from './core.js';

const LESSON_STATUSES = CATALOG.lessonStatuses || [];
const LESSON_FORMATS = CATALOG.lessonFormats || [];
const ATTENDANCE = CATALOG.attendance || [];

/** Классы перечислены буквально — иначе Tailwind не соберёт их в CSS. */
const EVENT_CLASS = {
  planned: 'cal-event bg-cobalt-100 text-cobalt-700',
  done: 'cal-event bg-mint-100 text-mint-600',
  cancelled: 'cal-event bg-red-50 text-red-600 line-through',
  moved: 'cal-event bg-apricot-100 text-apricot-600',
};

const query = new URLSearchParams(window.location.search);

const state = {
  view: 'week',
  anchor: query.get('date') || todayDay(),
  teacherId: isAdmin ? query.get('teacherId') || '' : '',
  studentId: query.get('studentId') || '',
  status: '',
};

let lessons = [];
let teachers = [];
let students = [];
const teacherName = new Map();
const studentName = new Map();

const calendar = byId('calendar');
const stateBox = byId('stateBox');
const periodTitle = byId('periodTitle');

// ------------------------------------------------------------------ период

function periodRange() {
  if (state.view === 'day') return { from: state.anchor, to: state.anchor };
  if (state.view === 'week') {
    const from = startOfWeek(state.anchor);
    return { from, to: shiftDay(from, 6) };
  }
  return { from: startOfMonth(state.anchor), to: endOfMonth(state.anchor) };
}

function periodTitleText() {
  const { from, to } = periodRange();
  if (state.view === 'day') return formatDayLong(from);
  if (state.view === 'week') return `${formatDay(from)} — ${formatDay(to)}`;
  return monthTitle(from);
}

function shiftPeriod(direction) {
  if (state.view === 'day') state.anchor = shiftDay(state.anchor, direction);
  else if (state.view === 'week') state.anchor = shiftDay(state.anchor, direction * 7);
  else state.anchor = shiftMonth(state.anchor, direction);
  load();
}

// ---------------------------------------------------------------- карточки

function lessonTitle(lesson) {
  if (lesson.title) return lesson.title;
  const names = lesson.studentIds.map((id) => studentName.get(id)).filter(Boolean);
  if (names.length === 0) return lesson.course || 'Занятие';
  if (names.length <= 2) return names.join(', ');
  return `${names[0]} +${names.length - 1}`;
}

function eventChip(lesson) {
  return h('button', {
    class: EVENT_CLASS[lesson.status] || EVENT_CLASS.planned,
    attrs: { type: 'button', title: `${lesson.startTime} · ${lessonTitle(lesson)}` },
    text: `${lesson.startTime} ${lessonTitle(lesson)}`,
    on: { click: () => openLesson(lesson) },
  });
}

function lessonRow(lesson) {
  return h(
    'button',
    {
      class: 'flex w-full items-start gap-4 rounded-xl border border-ink/[0.07] bg-white p-3.5 text-left transition hover:border-cobalt/25 hover:bg-mist/40',
      attrs: { type: 'button' },
      on: { click: () => openLesson(lesson) },
    },
    [
      h('span', { class: 'w-[5.5rem] shrink-0' }, [
        h('span', { class: 'block font-mono text-sm font-semibold tnum', text: lesson.startTime }),
        h('span', { class: 'block font-mono text-[11px] text-muted tnum', text: `${lesson.durationMin} мин` }),
      ]),
      h('span', { class: 'min-w-0 flex-1' }, [
        h('span', { class: 'block truncate font-semibold', text: lessonTitle(lesson) }),
        h('span', {
          class: 'mt-0.5 block truncate text-sm text-muted',
          text: [teacherName.get(lesson.teacherId), lesson.course, statusLabel(LESSON_FORMATS, lesson.format)]
            .filter(Boolean)
            .join(' · '),
        }),
      ]),
      statusBadge(LESSON_STATUSES, lesson.status),
    ]
  );
}

// ------------------------------------------------------------------- виды

function renderDay() {
  const dayLessons = lessons.filter((lesson) => lesson.date === state.anchor);

  if (dayLessons.length === 0) {
    return emptyBlock('На этот день занятий нет', isAdmin ? 'Добавьте занятие кнопкой «Новое занятие».' : 'Свободный день.');
  }

  return h('div', { class: 'space-y-2' }, dayLessons.map(lessonRow));
}

function renderWeek() {
  const from = startOfWeek(state.anchor);
  const today = todayDay();

  const columns = Array.from({ length: 7 }, (unused, index) => {
    const day = shiftDay(from, index);
    const dayLessons = lessons.filter((lesson) => lesson.date === day);

    return h('div', { class: 'min-w-0' }, [
      h(
        'button',
        {
          class: `flex w-full items-baseline justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-mist/60 ${
            day === today ? 'bg-cobalt-100/60' : ''
          }`,
          attrs: { type: 'button' },
          on: {
            click: () => {
              state.view = 'day';
              state.anchor = day;
              syncViewButtons();
              load();
            },
          },
        },
        [
          h('span', { class: 'text-2xs font-semibold uppercase tracking-wider text-muted', text: WEEKDAYS_SHORT[index] }),
          h('span', { class: 'font-mono text-sm font-semibold tnum', text: day.slice(8) }),
        ]
      ),
      h(
        'div',
        { class: 'mt-1.5 space-y-1 rounded-xl bg-mist/40 p-1.5 sm:min-h-[8rem]' },
        dayLessons.length === 0
          ? h('p', { class: 'px-1 py-2 text-center text-[11px] text-muted', text: '—' })
          : dayLessons.map(eventChip)
      ),
    ]);
  });

  return h('div', { class: 'grid gap-2 sm:grid-cols-7' }, columns);
}

function renderMonth() {
  const first = startOfMonth(state.anchor);
  const gridStart = startOfWeek(first);
  const today = todayDay();
  const month = first.slice(0, 7);

  const headers = WEEKDAYS_SHORT.map((label) => h('div', { class: 'cal-head', text: label }));

  const cells = Array.from({ length: 42 }, (unused, index) => {
    const day = shiftDay(gridStart, index);
    const dayLessons = lessons.filter((lesson) => lesson.date === day);
    const outside = day.slice(0, 7) !== month;

    const classes = ['cal-day'];
    if (outside) classes.push('cal-day-muted');
    if (day === today) classes.push('cal-day-today');

    return h('div', { class: classes.join(' ') }, [
      h(
        'button',
        {
          class: 'mb-1 block w-full text-right font-mono text-xs font-semibold tnum text-muted transition hover:text-ink',
          attrs: { type: 'button' },
          text: day.slice(8),
          on: {
            click: () => {
              state.view = 'day';
              state.anchor = day;
              syncViewButtons();
              load();
            },
          },
        }
      ),
      ...dayLessons.slice(0, 3).map(eventChip),
      dayLessons.length > 3
        ? h('p', { class: 'px-1.5 pt-0.5 text-[11px] text-muted', text: `ещё ${dayLessons.length - 3}` })
        : null,
    ]);
  });

  return h('div', {}, [
    h('div', { class: 'grid grid-cols-7 gap-1' }, headers),
    h('div', { class: 'mt-1 grid grid-cols-7 gap-1' }, cells),
  ]);
}

function render(errorMessage) {
  periodTitle.textContent = periodTitleText();
  clear(stateBox);

  if (errorMessage) {
    clear(calendar);
    stateBox.append(emptyBlock('Не удалось загрузить расписание', errorMessage));
    return;
  }

  const view = state.view === 'day' ? renderDay() : state.view === 'week' ? renderWeek() : renderMonth();
  calendar.replaceChildren(view);
}

async function load() {
  const range = periodRange();

  try {
    const data = await api('/lessons', {
      query: {
        from: range.from,
        to: range.to,
        teacherId: state.teacherId,
        studentId: state.studentId,
        status: state.status,
      },
    });
    lessons = data.items || [];
    render();
  } catch (error) {
    lessons = [];
    render(error.message);
  }
}

// -------------------------------------------------- выбор учеников в форме

function studentPicker(selectedIds = []) {
  const chosen = new Set(selectedIds);

  const search = h('input', {
    class: 'field-input mb-2',
    attrs: { type: 'search', placeholder: 'Поиск по имени' },
  });

  const list = h('div', { class: 'max-h-52 space-y-0.5 overflow-y-auto rounded-xl border border-ink/15 bg-white p-2' });

  const rows = students.map((student) => {
    const input = h('input', {
      class: 'mt-0.5 h-4 w-4 shrink-0 rounded border-ink/25 accent-cobalt',
      attrs: { type: 'checkbox', value: student.id },
      props: { checked: chosen.has(student.id) },
    });

    const row = h(
      'label',
      { class: 'flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm transition hover:bg-mist/60' },
      [
        input,
        h('span', { class: 'min-w-0' }, [
          h('span', { class: 'block truncate', text: student.name }),
          h('span', { class: 'block truncate text-xs text-muted', text: [student.course, student.group].filter(Boolean).join(' · ') }),
        ]),
      ]
    );

    row.input = input;
    row.haystack = `${student.name} ${student.course} ${student.group}`.toLowerCase();
    return row;
  });

  list.append(...rows);

  search.addEventListener('input', () => {
    const query_ = search.value.trim().toLowerCase();
    for (const row of rows) row.hidden = Boolean(query_) && !row.haystack.includes(query_);
  });

  const wrapper = h('div', {}, [h('span', { class: 'field-label', text: 'Ученики' }), search, list]);
  wrapper.read = () => rows.filter((row) => row.input.checked).map((row) => row.input.value);
  return wrapper;
}

// ------------------------------------------------- создание занятия (админ)

function openLessonForm() {
  const dateField = field({ label: 'Дата', name: 'date', type: 'date', value: state.anchor, required: true });
  const timeField = field({ label: 'Время начала', name: 'startTime', type: 'time', value: '17:00', required: true });
  const durationField = field({ label: 'Длительность, мин', name: 'durationMin', type: 'number', min: 15, max: 300, value: 60 });
  const teacherField = field({
    label: 'Преподаватель',
    name: 'teacherId',
    value: state.teacherId,
    options: [{ value: '', label: 'Выберите преподавателя' }, ...teachers.map((t) => ({ value: t.id, label: t.name }))],
  });
  const formatField = field({
    label: 'Формат',
    name: 'format',
    options: LESSON_FORMATS.map((format) => ({ value: format.id, label: format.label })),
  });
  const linkField = field({ label: 'Ссылка на созвон', name: 'link', placeholder: 'https://…' });
  const courseField = field({
    label: 'Направление',
    name: 'course',
    options: [{ value: '', label: 'Не указано' }, ...(CATALOG.courses || []).map((course) => ({ value: course, label: course }))],
  });
  const titleField = field({ label: 'Название', name: 'title', placeholder: 'Например, «Группа Python-3»', hint: 'Если не заполнить — покажем имена учеников' });
  const picker = studentPicker(state.studentId ? [state.studentId] : []);
  const commentField = field({ label: 'Заметка администратора', name: 'adminComment', type: 'textarea', rows: 2, hint: 'Преподаватель её не видит' });

  // -------- повторение
  const repeatToggle = h('input', {
    class: 'h-5 w-5 rounded border-ink/25 accent-cobalt',
    attrs: { type: 'checkbox', id: 'repeatToggle' },
  });

  const weekdayButtons = WEEKDAYS_SHORT.map((label, index) => {
    const input = h('input', { attrs: { type: 'checkbox', value: String(index + 1) }, class: 'sr-only' });
    const box = h('label', { class: 'cursor-pointer rounded-lg border border-ink/15 px-3 py-1.5 text-sm font-medium transition hover:border-cobalt/40' }, [
      input,
      h('span', { text: label }),
    ]);

    input.addEventListener('change', () => {
      box.classList.toggle('bg-ink', input.checked);
      box.classList.toggle('text-white', input.checked);
      box.classList.toggle('border-ink', input.checked);
    });

    box.input = input;
    return box;
  });

  const untilField = field({ label: 'Повторять до', name: 'until', type: 'date', value: shiftDay(state.anchor, 56) });

  const repeatBox = h('div', { class: 'mt-3 space-y-3', attrs: { hidden: true } }, [
    h('div', {}, [
      h('span', { class: 'field-label', text: 'Дни недели' }),
      h('div', { class: 'flex flex-wrap gap-1.5' }, weekdayButtons),
    ]),
    untilField,
    h('p', { class: 'field-hint', text: 'Занятия создадутся на все выбранные дни недели до указанной даты (не больше 200 штук).' }),
  ]);

  repeatToggle.addEventListener('change', () => {
    repeatBox.hidden = !repeatToggle.checked;
  });

  const form = h('div', { class: 'space-y-4' }, [
    h('div', { class: 'grid gap-4 sm:grid-cols-2' }, [dateField, timeField, durationField, teacherField, formatField, courseField, linkField, titleField]),
    picker,
    commentField,
    h('div', { class: 'rounded-2xl border border-ink/10 bg-mist/40 p-4' }, [
      h('label', { class: 'flex cursor-pointer items-center gap-3 text-sm font-medium', attrs: { for: 'repeatToggle' } }, [
        repeatToggle,
        h('span', { text: 'Повторять еженедельно' }),
      ]),
      repeatBox,
    ]),
  ]);

  const saveButton = modalButton('Создать', { kind: 'primary', loadingLabel: 'Создаём…' });

  const modal = openModal({
    title: 'Новое занятие',
    subtitle: 'Преподаватель получит уведомление',
    size: 'max-w-2xl',
    body: form,
    actions: [saveButton, modalButton('Отмена', { onClick: () => modal.close() })],
  });

  saveButton.addEventListener('click', async () => {
    setButtonLoading(saveButton, true);
    showFieldErrors(modal.panel, null);

    const values = readForm(form);
    const payload = {
      date: values.date,
      startTime: values.startTime,
      durationMin: values.durationMin,
      teacherId: values.teacherId,
      format: values.format,
      course: values.course,
      link: values.link,
      title: values.title,
      adminComment: values.adminComment,
      studentIds: picker.read(),
    };

    if (repeatToggle.checked) {
      payload.repeat = {
        weekdays: weekdayButtons.filter((box) => box.input.checked).map((box) => Number(box.input.value)),
        until: values.until,
      };
    }

    try {
      const data = await api('/lessons', { method: 'POST', body: payload });
      toast(`Создано занятий: ${data.created}`);
      modal.close();
      await load();
    } catch (error) {
      showFieldErrors(modal.panel, error.errors);
      toast(error.message, 'error');
      setButtonLoading(saveButton, false);
    }
  });
}

// ------------------------------------------------------ карточка занятия

function attendancePicker(lesson) {
  const rows = lesson.studentIds.map((studentId) => {
    const select = h('select', { class: 'field-input py-2' }, [
      h('option', { text: 'Не отмечено', attrs: { value: '' } }),
      ...ATTENDANCE.map((mark) =>
        h('option', {
          text: mark.label,
          attrs: { value: mark.id },
          props: { selected: lesson.attendance[studentId] === mark.id },
        })
      ),
    ]);

    const row = h('div', { class: 'flex items-center justify-between gap-3' }, [
      h('span', { class: 'min-w-0 flex-1 truncate text-sm', text: studentName.get(studentId) || 'Ученик удалён' }),
      h('div', { class: 'w-40 shrink-0' }, select),
    ]);

    row.studentId = studentId;
    row.select = select;
    return row;
  });

  const wrapper = h('div', {}, [
    h('span', { class: 'field-label', text: 'Посещаемость' }),
    rows.length === 0
      ? h('p', { class: 'text-sm text-muted', text: 'К занятию не привязаны ученики.' })
      : h('div', { class: 'space-y-2' }, rows),
  ]);

  wrapper.read = () => {
    const result = {};
    for (const row of rows) {
      if (row.select.value) result[row.studentId] = row.select.value;
    }
    return result;
  };

  return wrapper;
}

function openLesson(lesson) {
  const info = h('dl', { class: 'grid gap-4 sm:grid-cols-2' }, [
    kv('Дата', formatDayLong(lesson.date)),
    kv('Время', timeRange(lesson.startTime, lesson.durationMin), { mono: true }),
    kv('Преподаватель', teacherName.get(lesson.teacherId) || '—'),
    kv('Формат', statusLabel(LESSON_FORMATS, lesson.format)),
    kv('Направление', lesson.course || '—'),
    h('div', {}, [
      h('dt', { class: 'kv-label', text: 'Ссылка' }),
      h(
        'dd',
        { class: 'kv-value truncate' },
        lesson.link
          ? h('a', { class: 'link-inline', attrs: { href: lesson.link, target: '_blank', rel: 'noopener noreferrer' }, text: lesson.link })
          : document.createTextNode('—')
      ),
    ]),
    h('div', { class: 'sm:col-span-2' }, [
      h('dt', { class: 'kv-label', text: 'Ученики' }),
      h(
        'dd',
        { class: 'mt-1.5 flex flex-wrap gap-1.5' },
        lesson.studentIds.length === 0
          ? h('span', { class: 'text-sm text-muted', text: '—' })
          : lesson.studentIds.map((id) =>
              h('a', {
                class: 'chip transition hover:bg-ink/10',
                attrs: { href: `/app/students/${id}` },
                text: studentName.get(id) || 'Ученик удалён',
              })
            )
      ),
    ]),
  ]);

  const statusField = field({
    label: 'Итог занятия',
    name: 'status',
    value: lesson.status,
    options: LESSON_STATUSES.map((status) => ({ value: status.id, label: status.label })),
  });

  const commentField = field({
    label: 'Комментарий по итогам',
    name: 'teacherComment',
    type: 'textarea',
    rows: 3,
    value: lesson.teacherComment || '',
    placeholder: 'Что прошли, что задано, на что обратить внимание',
  });

  const attendance = attendancePicker(lesson);

  const saveButton = modalButton('Сохранить', { kind: 'primary', loadingLabel: 'Сохраняем…' });
  const actions = [saveButton];

  if (isAdmin) {
    actions.push(
      modalButton('Перенести', { onClick: () => openRescheduleForm(lesson, modal) }),
      modalButton('Удалить', { kind: 'danger', onClick: () => removeLesson(lesson, modal) })
    );
  }

  const body = [
    info,
    lesson.adminComment
      ? h('div', {}, [
          h('p', { class: 'kv-label', text: 'Заметка администратора' }),
          h('p', { class: 'mt-1 whitespace-pre-line rounded-xl bg-mist/70 px-4 py-3 text-sm', text: lesson.adminComment }),
        ])
      : null,
    h('div', { class: 'border-t border-ink/10 pt-4' }, [statusField]),
    commentField,
    attendance,
  ].filter(Boolean);

  const modal = openModal({
    title: lessonTitle(lesson),
    subtitle: `${formatDay(lesson.date)} · ${timeRange(lesson.startTime, lesson.durationMin)}`,
    size: 'max-w-2xl',
    body,
    actions,
  });

  saveButton.addEventListener('click', async () => {
    setButtonLoading(saveButton, true);
    showFieldErrors(modal.panel, null);

    try {
      await api(`/lessons/${encodeURIComponent(lesson.id)}`, {
        method: 'PATCH',
        body: {
          status: statusField.input.value,
          teacherComment: commentField.input.value,
          attendance: attendance.read(),
        },
      });

      toast('Занятие обновлено');
      modal.close();
      await load();
    } catch (error) {
      showFieldErrors(modal.panel, error.errors);
      toast(error.message, 'error');
      setButtonLoading(saveButton, false);
    }
  });
}

function openRescheduleForm(lesson, parentModal) {
  const dateField = field({ label: 'Новая дата', name: 'date', type: 'date', value: lesson.date });
  const timeField = field({ label: 'Новое время', name: 'startTime', type: 'time', value: lesson.startTime });
  const durationField = field({ label: 'Длительность, мин', name: 'durationMin', type: 'number', min: 15, max: 300, value: lesson.durationMin });
  const teacherField = field({
    label: 'Преподаватель',
    name: 'teacherId',
    value: lesson.teacherId,
    options: teachers.map((teacher) => ({ value: teacher.id, label: teacher.name })),
  });
  const linkField = field({ label: 'Ссылка на созвон', name: 'link', value: lesson.link || '' });

  const form = h('div', { class: 'grid gap-4 sm:grid-cols-2' }, [dateField, timeField, durationField, teacherField, linkField]);
  const saveButton = modalButton('Перенести', { kind: 'primary', loadingLabel: 'Переносим…' });

  const modal = openModal({
    title: 'Перенос занятия',
    subtitle: 'Преподаватель получит уведомление об изменении',
    body: form,
    actions: [saveButton, modalButton('Отмена', { onClick: () => modal.close() })],
  });

  saveButton.addEventListener('click', async () => {
    setButtonLoading(saveButton, true);
    showFieldErrors(modal.panel, null);

    try {
      await api(`/lessons/${encodeURIComponent(lesson.id)}`, { method: 'PATCH', body: readForm(form) });
      toast('Занятие перенесено');
      modal.close();
      parentModal.close();
      await load();
    } catch (error) {
      showFieldErrors(modal.panel, error.errors);
      toast(error.message, 'error');
      setButtonLoading(saveButton, false);
    }
  });
}

async function removeLesson(lesson, modal) {
  const inSeries = Boolean(lesson.seriesId);
  const question = inSeries
    ? 'Удалить это занятие? Нажмите «Отмена», если хотите удалить всю серию — для этого будет отдельный вопрос.'
    : 'Удалить занятие? Восстановить его будет нельзя.';

  if (!window.confirm(question)) {
    if (!inSeries) return;
    if (!window.confirm('Удалить всю серию, начиная с этой даты?')) return;

    try {
      const data = await api(`/lessons/${encodeURIComponent(lesson.id)}?series=1`, { method: 'DELETE' });
      toast(`Удалено занятий: ${data.removed}`);
      modal.close();
      await load();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }

  try {
    await api(`/lessons/${encodeURIComponent(lesson.id)}`, { method: 'DELETE' });
    toast('Занятие удалено');
    modal.close();
    await load();
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ----------------------------------------------------------------- элементы

function syncViewButtons() {
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  }
}

function initControls() {
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      syncViewButtons();
      load();
    });
  }

  byId('prevPeriod').addEventListener('click', () => shiftPeriod(-1));
  byId('nextPeriod').addEventListener('click', () => shiftPeriod(1));
  byId('todayButton').addEventListener('click', () => {
    state.anchor = todayDay();
    load();
  });

  byId('addLesson')?.addEventListener('click', openLessonForm);

  if (isAdmin) {
    for (const [id, key] of [
      ['filterTeacher', 'teacherId'],
      ['filterStudent', 'studentId'],
      ['filterStatus', 'status'],
    ]) {
      byId(id).addEventListener('change', (event) => {
        state[key] = event.target.value;
        load();
      });
    }
  }

  syncViewButtons();
}

function fillFilters() {
  if (!isAdmin) return;

  const teacherSelect = byId('filterTeacher');
  teacherSelect.replaceChildren(
    h('option', { text: 'Все преподаватели', attrs: { value: '' } }),
    ...teachers.map((teacher) =>
      h('option', { text: teacher.name, attrs: { value: teacher.id }, props: { selected: teacher.id === state.teacherId } })
    )
  );

  const studentSelect = byId('filterStudent');
  studentSelect.replaceChildren(
    h('option', { text: 'Все ученики', attrs: { value: '' } }),
    ...students.map((student) =>
      h('option', { text: student.name, attrs: { value: student.id }, props: { selected: student.id === state.studentId } })
    )
  );

  const statusSelect = byId('filterStatus');
  statusSelect.replaceChildren(
    h('option', { text: 'Все статусы', attrs: { value: '' } }),
    ...LESSON_STATUSES.map((status) => h('option', { text: status.label, attrs: { value: status.id } }))
  );
}

async function init() {
  // Преподавателю месяц недоступен: по требованиям ему нужны виды «день» и «неделя».
  if (!isAdmin && state.view === 'month') state.view = 'week';

  initControls();

  try {
    const directory = await api('/directory');
    teachers = directory.teachers || [];
    students = directory.students || [];
    for (const teacher of teachers) teacherName.set(teacher.id, teacher.name);
    for (const student of students) studentName.set(student.id, student.name);
    fillFilters();
  } catch {
    teachers = [];
    students = [];
  }

  await load();
}

init();
