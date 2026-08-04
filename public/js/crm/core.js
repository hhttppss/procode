'use strict';

/**
 * Общий инструментарий страниц платформы: обращения к API, построение DOM,
 * форматирование, модальные окна и уведомления.
 *
 * Правило вывода: данные попадают в разметку только через textContent.
 * Свойство html разрешено использовать лишь для заранее написанной статичной вёрстки —
 * значений из базы там не бывает.
 */

/** Данные, которые сервер положил в страницу: текущий сотрудник, справочники, параметры. */
export const PC = window.PC || {};
export const USER = PC.user || {};
export const CATALOG = PC.catalog || {};

export const isAdmin = USER.role === 'admin';
export const isManager = USER.role === 'manager';
export const isTeacher = USER.role === 'teacher';

/**
 * Плоский набор булевых флагов от сервера: canManageUsers, canViewAllStudents и прочие.
 * Ролей стало три, и завязываться в интерфейсе на роль больше нельзя — иначе каждая
 * новая роль требует правки всех модулей. Роль остаётся только там, где ветка
 * действительно «чисто админская».
 */
export const PERMISSIONS = PC.permissions || {};

/** Есть ли право. Строгое сравнение: отсутствующий флаг — это «нельзя», а не undefined. */
export function can(name) {
  return PERMISSIONS[name] === true;
}

/**
 * Подпись роли по справочнику: захардкоженный тернарник «Администратор / Преподаватель»
 * подписывал бы управляющего преподавателем.
 */
export function roleLabel(role) {
  const found = (CATALOG.roles || []).find((item) => item.id === role);
  return found ? found.label : role || '—';
}

// ---------------------------------------------------------------- запросы

export class ApiError extends Error {
  constructor(message, { errors = null, status = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.errors = errors;
    this.status = status;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function firstErrorText(data) {
  if (data && data.errors && typeof data.errors === 'object') {
    const values = Object.values(data.errors);
    if (values.length > 0) return String(values[0]);
  }
  return data && data.message ? String(data.message) : '';
}

/** Убирает из query пустые значения — в адресе остаётся только то, что реально выбрано. */
export function toQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    search.set(key, String(value));
  }
  return search;
}

/**
 * Запрос к API платформы. Сам разбирает единый формат ответа { ok, ... },
 * уводит на страницу входа при истёкшей сессии и превращает ошибки в ApiError.
 */
export async function api(path, { method = 'GET', body, query } = {}) {
  const search = query ? toQuery(query).toString() : '';
  const url = `/app/api${path}${search ? `?${search}` : ''}`;

  const options = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new ApiError('Сервер не отвечает. Проверьте подключение.');
  }

  if (response.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    throw new ApiError('Сессия истекла.', { status: 401 });
  }

  const data = await readJson(response);
  if (!response.ok || !data.ok) {
    throw new ApiError(firstErrorText(data) || 'Не удалось выполнить запрос.', {
      errors: data.errors || null,
      status: response.status,
    });
  }

  return data;
}

// -------------------------------------------------------------------- DOM

/**
 * Создание элемента.
 * @param {string} tag
 * @param {object} options  class, text, html (только статика), attrs, dataset, on, props
 * @param {Array|Node|string} children
 */
export function h(tag, options = {}, children = []) {
  const node = document.createElement(tag);

  if (options.class) node.className = options.class;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.html !== undefined) node.innerHTML = options.html;

  for (const [key, value] of Object.entries(options.attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const [key, value] of Object.entries(options.dataset || {})) node.dataset[key] = String(value);
  for (const [key, value] of Object.entries(options.props || {})) node[key] = value;
  for (const [event, handler] of Object.entries(options.on || {})) node.addEventListener(event, handler);

  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }

  return node;
}

export function byId(id) {
  return document.getElementById(id);
}

export function clear(node) {
  if (node) node.replaceChildren();
}

/** Откладывает вызов, пока человек печатает. */
export function debounce(fn, delay = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ------------------------------------------------------------ уведомления

export function toast(message, kind = 'success') {
  const root = byId('toasts');
  if (!root) return;

  const tone = kind === 'error' ? 'bg-red-600' : kind === 'info' ? 'bg-cobalt' : 'bg-ink';
  const node = h('div', {
    class: `pointer-events-auto rounded-xl ${tone} px-4 py-3 text-sm font-medium text-white shadow-lift`,
    text: message,
  });

  root.append(node);
  setTimeout(() => node.remove(), 4000);
}

export function setButtonLoading(button, loading) {
  if (!button) return;
  const idle = button.dataset.labelIdle || button.textContent;
  if (!button.dataset.labelIdle) button.dataset.labelIdle = idle;
  button.disabled = loading;
  button.textContent = loading ? button.dataset.labelLoading || 'Подождите…' : button.dataset.labelIdle;
}

// ---------------------------------------------------------- форматирование

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const MONTHS_NOMINATIVE = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
export const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Календарная дата YYYY-MM-DD → 01.08.2026 */
export function formatDay(day) {
  if (!day) return '—';
  const [year, month, date] = day.split('-');
  return `${date}.${month}.${year}`;
}

/** Календарная дата → «1 авг» */
export function formatDayShort(day) {
  if (!day) return '';
  const [, month, date] = day.split('-');
  return `${Number(date)} ${MONTHS_SHORT[Number(month) - 1] || ''}`;
}

/** Календарная дата → «1 августа 2026» */
export function formatDayLong(day) {
  if (!day) return '—';
  const [year, month, date] = day.split('-');
  return `${Number(date)} ${MONTHS_FULL[Number(month) - 1] || ''} ${year}`;
}

export function monthTitle(day) {
  if (!day) return '';
  const [year, month] = day.split('-');
  return `${MONTHS_NOMINATIVE[Number(month) - 1] || ''} ${year}`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** «5 минут назад», «вчера» — для ленты уведомлений. */
export function formatRelative(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const diffMin = Math.round((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин назад`;
  if (diffMin < 24 * 60) return `${Math.round(diffMin / 60)} ч назад`;
  if (diffMin < 48 * 60) return 'вчера';
  return formatDay(toDay(date));
}

const MONEY = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

export function formatMoney(value) {
  return `${MONEY.format(Number(value) || 0)} ₽`;
}

export function formatNumber(value) {
  return MONEY.format(Number(value) || 0);
}

export function plural(count, one, few, many) {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return many;
  switch (count % 10) {
    case 1:
      return one;
    case 2:
    case 3:
    case 4:
      return few;
    default:
      return many;
  }
}

export function formatAge(age) {
  if (age === null || age === undefined || age === '') return '';
  return `${age} ${plural(age, 'год', 'года', 'лет')}`;
}

/** Конец занятия по времени начала и длительности — «17:00 – 18:00». */
export function timeRange(startTime, durationMin) {
  if (!startTime) return '';
  const [hours, minutes] = startTime.split(':').map(Number);
  const end = new Date(2000, 0, 1, hours, minutes + (durationMin || 0));
  return `${startTime} – ${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
}

// ------------------------------------------------------------ даты (дни)

export function toDay(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayDay() {
  return toDay(new Date());
}

export function shiftDay(day, deltaDays) {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + deltaDays);
  return toDay(date);
}

export function shiftMonth(day, deltaMonths) {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(1);
  date.setMonth(date.getMonth() + deltaMonths);
  return toDay(date);
}

export function startOfWeek(day) {
  const date = new Date(`${day}T00:00:00`);
  const weekday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - weekday);
  return toDay(date);
}

export function startOfMonth(day) {
  return `${day.slice(0, 7)}-01`;
}

export function endOfMonth(day) {
  const date = new Date(`${day.slice(0, 7)}-01T00:00:00`);
  date.setMonth(date.getMonth() + 1);
  date.setDate(0);
  return toDay(date);
}

// ---------------------------------------------------------------- статусы

/**
 * Классы перечислены буквально: Tailwind собирает CSS по тексту исходников
 * и не увидел бы имя, собранное конкатенацией.
 */
const TONE_CLASS = {
  cobalt: 'status status-cobalt',
  mint: 'status status-mint',
  apricot: 'status status-apricot',
  red: 'status status-red',
  violet: 'status status-violet',
  slate: 'status status-slate',
};

export function findStatus(list, id) {
  return (list || []).find((item) => item.id === id) || null;
}

export function statusLabel(list, id) {
  const found = findStatus(list, id);
  return found ? found.label : id || '—';
}

/** Готовый бейдж статуса по справочнику из window.PC.catalog. */
export function statusBadge(list, id) {
  const found = findStatus(list, id);
  return h('span', {
    class: TONE_CLASS[found ? found.tone : 'slate'] || TONE_CLASS.slate,
    text: found ? found.label : id || '—',
  });
}

// ------------------------------------------------------------------ формы

/**
 * Поле формы: подпись + элемент управления. Возвращает контейнер,
 * сам элемент управления доступен как node.input — так его удобно читать при сохранении.
 *
 * Имя именно input, а не control: контейнер — это <label>, а у него уже есть
 * встроенное свойство control, доступное только для чтения.
 */
export function field({
  label,
  name,
  type = 'text',
  value = '',
  options = null,
  placeholder = '',
  rows = 0,
  hint = '',
  required = false,
  disabled = false,
  className = '',
  min = null,
  max = null,
  step = null,
}) {
  const id = `f_${name}_${Math.random().toString(36).slice(2, 8)}`;
  // Подпись ошибки и подсказка связываются с полем через aria-describedby:
  // без этого скринридер читает «Имя ребёнка, поле ввода» и молчит о том, что не так.
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = hint ? `${hintId} ${errorId}` : errorId;
  let control;

  if (options) {
    control = h('select', { class: 'field-input', attrs: { id, name, 'aria-describedby': describedBy } });
    for (const option of options) {
      control.append(
        h('option', {
          text: option.label,
          attrs: { value: option.value },
          props: { selected: String(option.value) === String(value ?? '') },
        })
      );
    }
  } else if (type === 'textarea') {
    control = h('textarea', {
      class: 'field-input resize-y',
      attrs: { id, name, rows: rows || 3, placeholder, 'aria-describedby': describedBy },
      props: { value: value ?? '' },
    });
  } else if (type === 'checkbox') {
    control = h('input', {
      class: 'h-5 w-5 rounded border-ink/25 accent-cobalt',
      attrs: { id, name, type: 'checkbox', 'aria-describedby': describedBy },
      props: { checked: Boolean(value) },
    });
  } else {
    control = h('input', {
      class: 'field-input',
      attrs: { id, name, type, placeholder, 'aria-describedby': describedBy },
      props: { value: value ?? '' },
    });
    if (min !== null) control.min = min;
    if (max !== null) control.max = max;
    if (step !== null) control.step = step;
  }

  if (required) control.required = true;
  if (disabled) control.disabled = true;

  // role="alert" на пустом блоке безвреден: скринридер озвучит его в тот момент,
  // когда showFieldErrors положит туда текст.
  const errorNode = h('p', {
    class: 'field-error',
    attrs: { id: errorId, role: 'alert' },
    dataset: { errorFor: name },
  });

  const wrapper =
    type === 'checkbox'
      ? // Флажок обёрнут в контейнер, а не в один <label>: подпись ошибки должна вставать
        // под строкой с флажком, а не превращаться в соседнюю колонку flex-раскладки.
        h('div', { class: className }, [
          h('label', { class: 'flex cursor-pointer items-center gap-3 text-sm' }, [control, h('span', { text: label })]),
          hint ? h('p', { class: 'field-hint', attrs: { id: hintId }, text: hint }) : null,
          errorNode,
        ])
      : h('label', { class: `field ${className}`.trim(), attrs: { for: id } }, [
          h('span', { class: 'field-label', text: label }),
          control,
          hint ? h('p', { class: 'field-hint', attrs: { id: hintId }, text: hint }) : null,
          errorNode,
        ]);

  wrapper.input = control;
  return wrapper;
}

/** Показывает ошибки валидации, пришедшие с сервера, рядом с полями формы. */
export function showFieldErrors(root, errors) {
  for (const node of root.querySelectorAll('[data-error-for]')) {
    node.textContent = '';
    node.classList.remove('is-shown');
  }
  for (const node of root.querySelectorAll('[aria-invalid]')) node.removeAttribute('aria-invalid');

  if (!errors) return;

  for (const [name, message] of Object.entries(errors)) {
    const holder = root.querySelector(`[data-error-for="${name}"]`);
    if (holder) {
      holder.textContent = message;
      holder.classList.add('is-shown');
    }
    const control = root.querySelector(`[name="${name}"]`);
    if (control) control.setAttribute('aria-invalid', 'true');
  }
}

/** Собирает значения формы: чекбоксы — булевы, числа — числами. */
export function readForm(root) {
  const values = {};
  for (const control of root.querySelectorAll('input, select, textarea')) {
    if (!control.name) continue;
    if (control.type === 'checkbox') values[control.name] = control.checked;
    else if (control.type === 'number') values[control.name] = control.value === '' ? null : Number(control.value);
    else values[control.name] = control.value;
  }
  return values;
}

// --------------------------------------------------------- модальное окно

// Стек открытых модалок (в порядке открытия). Нужен вместо счётчика: если поверх модалки
// открыть ещё одну, обработчик клавиш нижней модалки не должен перехватывать Tab/Escape —
// иначе фокус запирается в уже неактивном окне и до элементов верхней модалки не добраться.
const modalStack = [];

/** Открыто ли сейчас модальное окно — фоновым обновлениям под ним делать нечего. */
export function isModalOpen() {
  return modalStack.length > 0;
}

/**
 * Модальное окно. Возвращает { close, panel, body }.
 * Фокус запирается внутри окна, Esc и клик по фону закрывают.
 */
export function openModal({ title, subtitle = '', body, actions = [], size = 'max-w-xl', onClose = null }) {
  const previousFocus = document.activeElement;
  const entry = {};

  const bodyNode = h('div', { class: 'modal-body' }, body);
  const footNode = actions.length > 0 ? h('div', { class: 'modal-foot' }, actions) : null;

  const closeButton = h('button', {
    class: 'icon-button -mr-1',
    attrs: { type: 'button', 'aria-label': 'Закрыть окно' },
    html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  });

  const panel = h('div', { class: `modal-panel ${size}`, attrs: { role: 'document' } }, [
    h('div', { class: 'modal-head' }, [
      h('div', { class: 'min-w-0' }, [
        h('h2', { class: 'font-display text-lg font-semibold tracking-tight', text: title }),
        subtitle ? h('p', { class: 'mt-1 text-sm text-muted', text: subtitle }) : null,
      ]),
      closeButton,
    ]),
    bodyNode,
    footNode,
  ]);

  const backdrop = h(
    'div',
    { class: 'modal-backdrop', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } },
    panel
  );

  function close() {
    // Фокус возвращаем, только если закрывается верхушка стека: если под этой модалкой
    // уже открыта другая (закрыли не по порядку), previousFocus указывает на элемент
    // за ещё активным окном — фокусом там владеет модалка, что осталась открытой сверху.
    const wasTop = modalStack[modalStack.length - 1] === entry;

    backdrop.remove();
    const index = modalStack.indexOf(entry);
    if (index !== -1) modalStack.splice(index, 1);
    if (modalStack.length === 0) document.body.classList.remove('overflow-hidden');
    document.removeEventListener('keydown', onKeyDown, true);
    if (wasTop && previousFocus && document.contains(previousFocus)) previousFocus.focus();
    if (onClose) onClose();
  }

  function focusable() {
    return Array.from(
      panel.querySelectorAll('a[href], button:not([disabled]), select, textarea, input:not([type="hidden"]), [tabindex]:not([tabindex="-1"])')
    ).filter((node) => node.offsetParent !== null);
  }

  function onKeyDown(event) {
    // Пока поверх этой модалки открыта другая, её обработчик молчит — активна
    // только верхушка стека.
    if (modalStack[modalStack.length - 1] !== entry) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const nodes = focusable();
    if (nodes.length === 0) return;

    const first = nodes[0];
    const last = nodes[nodes.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!panel.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  }

  closeButton.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKeyDown, true);

  document.body.append(backdrop);
  document.body.classList.add('overflow-hidden');
  modalStack.push(entry);

  const firstControl = focusable()[0];
  if (firstControl) firstControl.focus();

  return { close, panel, body: bodyNode };
}

/** Кнопка для модального окна — чтобы не повторять классы в каждом модуле. */
export function modalButton(label, { kind = 'outline', onClick, loadingLabel } = {}) {
  const classes = {
    primary: 'btn btn-primary btn-sm flex-1',
    outline: 'btn btn-outline btn-sm',
    danger: 'btn btn-sm btn-danger',
  };

  return h('button', {
    class: classes[kind] || classes.outline,
    attrs: { type: 'button' },
    dataset: loadingLabel ? { labelIdle: label, labelLoading: loadingLabel } : { labelIdle: label },
    text: label,
    on: onClick ? { click: onClick } : {},
  });
}

/**
 * Подтверждение важного действия (удаление, блокировка и т. п.) — стилизованная
 * замена window.confirm(): у него нет ни тёмной темы, ни фирменного вида, а на части
 * платформ подпись кнопок вообще не переводится на русский.
 *
 * Возвращает Promise<boolean>: true — нажали кнопку подтверждения. Отмена кнопкой
 * «Отмена», крестиком, Esc или кликом по подложке — во всех случаях false, как и
 * у window.confirm(). Поверх уже открытой модалки эта встаёт сама: стек модалок
 * из openModal уже поддерживает вложенность (тот же приём — openConvert в
 * applications.js), достаточно просто вызвать confirmModal изнутри обработчика.
 */
export function confirmModal(message, { title = 'Подтверждение', confirmLabel = 'Удалить', cancelLabel = 'Отмена', kind = 'danger' } = {}) {
  return new Promise((resolve) => {
    let settled = false;

    const confirmButton = modalButton(confirmLabel, {
      kind,
      onClick: () => {
        settled = true;
        resolve(true);
        modal.close();
      },
    });
    const cancelButton = modalButton(cancelLabel, {
      onClick: () => {
        settled = true;
        resolve(false);
        modal.close();
      },
    });

    const modal = openModal({
      title,
      body: h('p', { class: 'text-sm leading-relaxed text-ink/80', text: message }),
      actions: [confirmButton, cancelButton],
      onClose: () => {
        if (!settled) resolve(false);
      },
    });
  });
}

export function emptyBlock(title, text) {
  return h('div', { class: 'empty-block' }, [
    h('p', { class: 'font-display text-base font-semibold', text: title }),
    text ? h('p', { class: 'mx-auto mt-2 max-w-sm text-sm text-muted', text }) : null,
  ]);
}

/** Простая пара «подпись — значение» для карточек. */
export function kv(label, value, { mono = false, className = '' } = {}) {
  return h('div', { class: className }, [
    h('dt', { class: 'kv-label', text: label }),
    h('dd', { class: `kv-value ${mono ? 'font-mono tnum' : ''}`.trim(), text: value || '—' }),
  ]);
}
