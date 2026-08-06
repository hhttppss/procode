'use strict';

/**
 * Окна работы с учётными записями сотрудников: создание, редактирование, смена пароля.
 * Открываются из списка сотрудников и из карточки — поэтому вынесены отдельно.
 * Весь модуль доступен только администратору: API отвечает остальным 403.
 */

import {
  CATALOG,
  api,
  field,
  h,
  modalButton,
  openModal,
  readForm,
  setButtonLoading,
  showFieldErrors,
  toast,
} from './core.js';

const COURSES = CATALOG.courses || [];

/** Направления выбираются флажками: так видно весь список сразу. */
function coursesPicker(selected = []) {
  const chosen = new Set(selected);

  const boxes = COURSES.map((course) =>
    h('label', { class: 'flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm transition hover:bg-mist/60' }, [
      h('input', {
        class: 'mt-0.5 h-4 w-4 shrink-0 rounded border-ink/25 accent-cobalt',
        attrs: { type: 'checkbox', value: course },
        props: { checked: chosen.has(course) },
      }),
      h('span', { text: course }),
    ])
  );

  const wrapper = h('div', {}, [
    h('span', { class: 'field-label', text: 'Направления' }),
    h('div', { class: 'max-h-48 space-y-0.5 overflow-y-auto rounded-xl border border-ink/15 bg-white p-2' }, boxes),
  ]);

  wrapper.read = () =>
    boxes.map((box) => box.querySelector('input')).filter((input) => input.checked).map((input) => input.value);

  return wrapper;
}

export function openTeacherForm({ teacher = null, onSaved }) {
  const isEdit = Boolean(teacher);
  const value = teacher || {};

  const loginField = field({
    label: 'Логин',
    name: 'login',
    value: value.login || '',
    required: !isEdit,
    disabled: isEdit,
    hint: isEdit ? 'Логин менять нельзя' : 'Латиница и цифры, минимум 3 символа',
    // Логин чужой учётной записи, а не своей: 'off', чтобы браузер администратора
    // не подставлял сюда сохранённый логин самого администратора.
    autocomplete: 'off',
  });

  const passwordField = field({
    label: 'Пароль',
    name: 'password',
    type: 'password',
    hint: 'Минимум 6 символов. Передайте его сотруднику лично',
    // 'new-password', а не 'current-password': администратор задаёт пароль
    // другому сотруднику, а не вводит свой собственный.
    autocomplete: 'new-password',
  });

  const roleField = field({
    label: 'Роль',
    name: 'role',
    value: value.role || 'teacher',
    options: (CATALOG.roles || []).map((role) => ({ value: role.id, label: role.label })),
    hint: 'Администратор видит все модули; управляющий — заявки, учеников, расписание и финансы, но не управляет учётными записями; преподаватель — только своих учеников и своё расписание',
  });

  const courses = coursesPicker(value.courses || []);

  const rateField = field({
    label: 'Ставка за занятие, ₽',
    name: 'rate',
    type: 'number',
    min: 0,
    value: value.rate ?? '',
    hint: 'Начисляется за каждое проведённое занятие',
  });

  const salaryField = field({
    label: 'Оклад за период, ₽',
    name: 'salary',
    type: 'number',
    min: 0,
    value: value.salary ?? '',
    hint: 'Фиксированная сумма за период. Для администратора и управляющего — основная форма начисления',
  });

  const form = h('div', { class: 'space-y-4' }, [
    h('div', { class: 'grid gap-4 sm:grid-cols-2' }, [
      field({ label: 'ФИО', name: 'name', value: value.name || '', required: true, autocomplete: 'name' }),
      roleField,
      loginField,
      isEdit ? null : passwordField,
      field({ label: 'Телефон', name: 'phone', type: 'tel', value: value.phone || '', autocomplete: 'tel' }),
      field({ label: 'Email', name: 'email', type: 'email', value: value.email || '', autocomplete: 'email' }),
      rateField,
      salaryField,
      field({
        label: 'Доступ к системе',
        name: 'active',
        type: 'checkbox',
        value: isEdit ? value.active : true,
        className: 'sm:self-end sm:pb-3',
      }),
    ].filter(Boolean)),
    courses,
    field({ label: 'Заметка', name: 'note', type: 'textarea', rows: 2, value: value.note || '' }),
  ]);

  /**
   * Направления и ставка за занятие имеют смысл только для роли «Преподаватель»:
   * администратор и управляющий уроков не ведут. Оклад, наоборот, не прячем ни для
   * кого — штатному преподавателю его тоже иногда назначают, просто редко.
   *
   * Поля не очищаются при скрытии, только визуально прячутся через [hidden]: readForm()
   * всё равно читает их текущее значение при сохранении, поэтому уже заполненные
   * направления или ставка сотрудника, которого временно перевели в управляющие,
   * не теряются молча — просто не участвуют в форме, пока роль не «Преподаватель».
   */
  function applyRoleVisibility() {
    const hideTeacherOnly = roleField.input.value !== 'teacher';

    // [hidden] сам уводит фокус в document.body, а не на следующий осмысленный элемент —
    // если фокус был внутри поля, которое вот-вот скроется, возвращаем его на селект
    // роли: именно из-за его смены поля пропадают.
    if (
      hideTeacherOnly &&
      document.activeElement &&
      (rateField.contains(document.activeElement) || courses.contains(document.activeElement))
    ) {
      roleField.input.focus();
    }

    rateField.hidden = hideTeacherOnly;
    courses.hidden = hideTeacherOnly;
  }

  applyRoleVisibility();
  roleField.input.addEventListener('change', applyRoleVisibility);

  const saveButton = modalButton(isEdit ? 'Сохранить' : 'Создать сотрудника', {
    kind: 'primary',
    loadingLabel: 'Сохраняем…',
  });

  const modal = openModal({
    title: isEdit ? `Сотрудник: ${value.name}` : 'Новый сотрудник',
    subtitle: isEdit ? 'Логин остаётся прежним, пароль меняется отдельной кнопкой' : 'Учётная запись заработает сразу',
    size: 'max-w-2xl',
    body: form,
    actions: [saveButton, modalButton('Отмена', { onClick: () => modal.close() })],
  });

  saveButton.addEventListener('click', async () => {
    setButtonLoading(saveButton, true);
    showFieldErrors(modal.panel, null);

    const values = readForm(form);
    const payload = {
      name: values.name,
      role: values.role,
      phone: values.phone,
      email: values.email,
      rate: values.rate === null ? 0 : values.rate,
      salary: values.salary === null ? 0 : values.salary,
      active: values.active,
      note: values.note,
      courses: courses.read(),
    };

    try {
      const data = isEdit
        ? await api(`/teachers/${encodeURIComponent(teacher.id)}`, { method: 'PATCH', body: payload })
        : await api('/teachers', { method: 'POST', body: { ...payload, login: values.login, password: values.password } });

      modal.close();
      if (onSaved) await onSaved(data.item);
    } catch (error) {
      showFieldErrors(modal.panel, error.errors);
      toast(error.message, 'error');
      setButtonLoading(saveButton, false);
    }
  });

  return modal;
}

export function openPasswordForm(teacher, onSaved) {
  const form = h('div', { class: 'space-y-4' }, [
    field({
      label: 'Новый пароль',
      name: 'password',
      type: 'password',
      required: true,
      hint: 'Минимум 6 символов',
      autocomplete: 'new-password',
    }),
  ]);

  const saveButton = modalButton('Задать пароль', { kind: 'primary', loadingLabel: 'Сохраняем…' });

  const modal = openModal({
    title: 'Смена пароля',
    subtitle: `${teacher.name} · ${teacher.login}`,
    body: [
      h('p', {
        class: 'text-sm text-muted',
        text: 'Старый пароль знать не нужно. Сообщите новый сотруднику лично — в системе он больше нигде не отображается.',
      }),
      form,
    ],
    actions: [saveButton, modalButton('Отмена', { onClick: () => modal.close() })],
  });

  saveButton.addEventListener('click', async () => {
    setButtonLoading(saveButton, true);
    showFieldErrors(modal.panel, null);

    try {
      await api(`/teachers/${encodeURIComponent(teacher.id)}/password`, {
        method: 'POST',
        body: { password: readForm(form).password },
      });

      toast('Пароль изменён');
      modal.close();
      if (onSaved) await onSaved();
    } catch (error) {
      showFieldErrors(modal.panel, error.errors);
      toast(error.message, 'error');
      setButtonLoading(saveButton, false);
    }
  });

  return modal;
}
