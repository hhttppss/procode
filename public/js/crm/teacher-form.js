'use strict';

/**
 * Окна работы с учётными записями сотрудников: создание, редактирование, смена пароля.
 * Открываются из списка преподавателей и из карточки — поэтому вынесены отдельно.
 * Весь модуль доступен только администратору: API отвечает преподавателю 403.
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
  });

  const passwordField = field({
    label: 'Пароль',
    name: 'password',
    type: 'password',
    hint: 'Минимум 6 символов. Передайте его сотруднику лично',
  });

  const roleField = field({
    label: 'Роль',
    name: 'role',
    value: value.role || 'teacher',
    options: (CATALOG.roles || []).map((role) => ({ value: role.id, label: role.label })),
    hint: 'Администратор видит все модули; управляющий — заявки, учеников, расписание и финансы, но не управляет учётными записями; преподаватель — только своих учеников и своё расписание',
  });

  const courses = coursesPicker(value.courses || []);

  const form = h('div', { class: 'space-y-4' }, [
    h('div', { class: 'grid gap-4 sm:grid-cols-2' }, [
      field({ label: 'ФИО', name: 'name', value: value.name || '', required: true }),
      roleField,
      loginField,
      isEdit ? null : passwordField,
      field({ label: 'Телефон', name: 'phone', type: 'tel', value: value.phone || '' }),
      field({ label: 'Email', name: 'email', type: 'email', value: value.email || '' }),
      field({
        label: 'Ставка за занятие, ₽',
        name: 'rate',
        type: 'number',
        min: 0,
        value: value.rate ?? '',
        hint: 'Видит и меняет только администратор',
      }),
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
    field({ label: 'Новый пароль', name: 'password', type: 'password', required: true, hint: 'Минимум 6 символов' }),
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
