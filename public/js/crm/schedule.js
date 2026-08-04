'use strict';

/**
 * Модуль «Расписание».
 *
 * С правом canManageLessons (администратор, управляющий): календарь день/неделя/месяц,
 * создание занятий (в том числе повторяющихся), перенос и удаление.
 * Без него (преподаватель): только свои занятия в видах «день» и «неделя», без
 * редактирования — доступна лишь отметка итога: проведено / отменено / перенесено,
 * комментарий и посещаемость. Набор полей ограничен и на сервере.
 */

import './shell.js';
import {
  CATALOG,
  WEEKDAYS_SHORT,
  api,
  byId,
  can,
  clear,
  confirmModal,
  emptyBlock,
  endOfMonth,
  field,
  formatDay,
  formatDayLong,
  h,
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
  done: 'cal-event bg-mint-100 text-mint-700',
  cancelled: 'cal-event bg-red-50 text-red-700 line-through',
  moved: 'cal-event bg-apricot-100 text-apricot-700',
};

const query = new URLSearchParams(window.location.search);

// Кто видит чужие занятия и фильтры по ним, кто правит календарь — решают права, а не роль.
const seesAllLessons = can('canViewAllLessons');
const managesLessons = can('canManageLessons');

const state = {
  view: 'week',
  anchor: query.get('date') || todayDay(),
  teacherId: seesAllLessons ? query.get('teacherId') || '' : '',
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
  const subtitle = [teacherName.get(lesson.teacherId), lesson.course, statusLabel(LESSON_FORMATS, lesson.format)]
    .filter(Boolean)
    .join(' · ');

  return h(
    'button',
    {
      class: 'flex w-full items-start gap-3 rounded-xl border border-ink/[0.07] bg-white p-3.5 text-left transition hover:border-cobalt/25 hover:bg-mist/40 sm:gap-4',
      attrs: { type: 'button' },
      on: { click: () => openLesson(lesson) },
    },
    [
      h('span', { class: 'w-16 shrink-0 sm:w-[5.5rem]' }, [
        h('span', { class: 'block font-mono text-sm font-semibold tnum', text: lesson.startTime }),
        h('span', { class: 'block font-mono text-[11px] text-muted tnum', text: `${lesson.durationMin} мин` }),
      ]),
      h('span', { class: 'min-w-0 flex-1' }, [
        h('span', { class: 'block truncate font-semibold', text: lessonTitle(lesson) }),
        h('span', { class: 'mt-0.5 block truncate text-sm text-muted', attrs: { title: subtitle }, text: subtitle }),
        // Бейдж статуса на телефоне уходит под текст: рядом с ним от названия занятия
        // оставалось около 40 px, и «Питон-про-пн-19:00» превращалось в «Пит…».
        h('span', { class: 'mt-2 block sm:hidden' }, statusBadge(LESSON_STATUSES, lesson.status)),
      ]),
      h('span', { class: 'hidden shrink-0 sm:block' }, statusBadge(LESSON_STATUSES, lesson.status)),
    ]
  );
}

// ------------------------------------------------------------------- виды

function renderDay() {
  const dayLessons = lessons.filter((lesson) => lesson.date === state.anchor);

  if (dayLessons.length === 0) {
    return emptyBlock('На этот день занятий нет', managesLessons ? 'Добавьте занятие кнопкой «Новое занятие».' : 'Свободный день.');
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

function renderMonthGrid() {
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

/**
 * Мобильный вид месяца: сетка 7×6 на узком экране либо сплющивается, либо требует
 * горизонтального скролла — у неё нет построчных данных, которые превращались бы
 * в карточки. Вместо этого — агенда-список дней с занятиями, тот же lessonRow,
 * что и в renderDay().
 */
function renderMonthAgenda() {
  const first = startOfMonth(state.anchor);
  const daysInMonth = Number(endOfMonth(state.anchor).slice(8, 10));
  const today = todayDay();

  const days = Array.from({ length: daysInMonth }, (unused, index) => shiftDay(first, index))
    .map((day) => ({ day, dayLessons: lessons.filter((lesson) => lesson.date === day) }))
    .filter(({ dayLessons }) => dayLessons.length > 0);

  if (days.length === 0) {
    return emptyBlock('В этом месяце занятий нет', managesLessons ? 'Добавьте занятие кнопкой «Новое занятие».' : 'Свободный месяц.');
  }

  return h(
    'div',
    { class: 'space-y-4' },
    days.map(({ day, dayLessons }) =>
      h('div', {}, [
        h(
          'button',
          {
            class: `mb-2 rounded-lg px-1 font-display text-sm font-semibold transition hover:text-cobalt ${
              day === today ? 'text-cobalt' : ''
            }`,
            attrs: { type: 'button' },
            text: formatDayLong(day),
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
        h('div', { class: 'space-y-2' }, dayLessons.map(lessonRow)),
      ])
    )
  );
}

function renderMonth() {
  return h('div', {}, [
    h('div', { class: 'hidden lg:block' }, renderMonthGrid()),
    h('div', { class: 'lg:hidden' }, renderMonthAgenda()),
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
    // Держим ссылку на самого ученика: сравнивать группу по тексту строки — значит
    // сломаться на первом же имени, где встретится название группы.
    row.student = student;
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

  /**
   * Отмечает состав выбранной группы и снимает отметки со всех остальных.
   * Пустое имя группы — снять все отметки. Возвращает количество отмеченных,
   * чтобы форма могла сказать человеку, что именно подставила.
   */
  wrapper.selectGroup = (groupName) => {
    const target = (groupName || '').trim();
    let matched = 0;
    let first = null;

    for (const row of rows) {
      const belongs = target !== '' && (row.student.group || '').trim() === target;
      row.input.checked = belongs;
      if (belongs) {
        matched += 1;
        if (!first) first = row;
      }
    }

    // Список прокручивается внутри себя, и отметки часто оказываются ниже видимой части:
    // без этого после выбора группы на экране визуально не менялось ничего.
    if (first) list.scrollTop += first.getBoundingClientRect().top - list.getBoundingClientRect().top - 8;

    return matched;
  };

  return wrapper;
}

// ------------------------------------------ создание занятия (canManageLessons)

/**
 * Отдельного справочника групп нет: группа — свободная строка в карточке ученика,
 * поэтому список собираем из уже загруженного справочника учеников.
 */
function studentGroups() {
  const unique = new Set();

  for (const student of students) {
    const group = (student.group || '').trim();
    if (group) unique.add(group);
  }

  return Array.from(unique).sort((left, right) => left.localeCompare(right, 'ru', { numeric: true }));
}

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
  const groupField = field({
    label: 'Группа',
    name: 'group',
    options: [{ value: '', label: 'Не указана' }, ...studentGroups().map((group) => ({ value: group, label: group }))],
  });
  const titleField = field({ label: 'Название', name: 'title', placeholder: 'Например, «Группа Python-3»', hint: 'Если не заполнить — покажем имена учеников' });
  const picker = studentPicker(state.studentId ? [state.studentId] : []);
  // Подсказка живёт в разметке всегда и до первого выбора группы пуста: пустой абзац
  // не занимает высоты, зато остаётся живой областью — иначе экранный диктор промолчит
  // о том, что состав учеников только что переписали.
  const groupHint = h('p', { class: 'field-hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  const commentField = field({ label: 'Заметка администратора', name: 'adminComment', type: 'textarea', rows: 2, hint: 'Преподаватель её не видит' });

  // Состав подставляется только по явной смене группы: молча затирать отметки,
  // которые человек уже расставил руками, нельзя — поэтому и пишем под списком,
  // что именно изменилось. Отметки после подстановки остаются редактируемыми.
  groupField.input.addEventListener('change', () => {
    const group = groupField.input.value;
    const matched = picker.selectGroup(group);

    groupHint.textContent = group
      ? `Подставлены ученики группы «${group}»: ${matched}`
      : 'Группа снята — отметки учеников очищены, отметьте нужных вручную.';
  });

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
    h('div', { class: 'grid gap-4 sm:grid-cols-2' }, [
      dateField,
      timeField,
      durationField,
      teacherField,
      formatField,
      courseField,
      groupField,
      linkField,
      titleField,
    ]),
    h('div', {}, [picker, groupHint]),
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
      group: values.group,
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
    kv('Группа', lesson.group || '—'),
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

  if (managesLessons) {
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

/** Перенос — это только дата, время, преподаватель и ссылка: состав и группу здесь не трогаем. */
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

  if (!(await confirmModal(question, { title: 'Удаление занятия' }))) {
    if (!inSeries) return;
    if (!(await confirmModal('Удалить всю серию, начиная с этой даты?', { title: 'Удаление серии занятий', confirmLabel: 'Удалить серию' }))) return;

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

  if (managesLessons) byId('addLesson')?.addEventListener('click', openLessonForm);

  if (seesAllLessons) {
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
  if (!seesAllLessons) return;

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
  // Месяц — только тем, кто видит всё расписание: преподавателю по требованиям
  // нужны виды «день» и «неделя», и кнопки «Месяц» у него в разметке нет.
  if (!seesAllLessons && state.view === 'month') state.view = 'week';

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
