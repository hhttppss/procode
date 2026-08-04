'use strict';

/**
 * Окно создания и редактирования карточки ученика.
 * Вынесено отдельно, потому что открывается из двух мест: списка и самой карточки.
 * Форма открывается по праву canEditStudent — у преподавателя нет ни кнопки, ни права на запись.
 */

import {
  CATALOG,
  api,
  can,
  field,
  h,
  modalButton,
  openModal,
  readForm,
  setButtonLoading,
  showFieldErrors,
  toast,
} from './core.js';

const STATUSES = CATALOG.studentStatuses || [];
const COURSES = CATALOG.courses || [];

export function openStudentForm({ student = null, teachers = [], onSaved }) {
  const isEdit = Boolean(student);
  const value = student || {};
  const traits = value.traits || {};

  // Закрепление за преподавателем — отдельное право. Управляющий видит, кто ведёт
  // ученика, но менять закрепление не может: сервер такой запрос отклонит.
  const canAssignTeacher = can('canAssignTeacher');

  const main = h('div', { class: 'grid gap-4 sm:grid-cols-2' }, [
    field({ label: 'Имя ребёнка', name: 'name', value: value.name || '', required: true }),
    field({ label: 'Дата рождения', name: 'birthDate', type: 'date', value: value.birthDate || '' }),
    field({
      label: 'Возраст',
      name: 'age',
      type: 'number',
      min: 3,
      max: 25,
      value: value.age ?? '',
      hint: 'Заполняется, если дата рождения неизвестна',
    }),
    field({ label: 'Начало занятий', name: 'startedAt', type: 'date', value: value.startedAt || '' }),
    field({
      label: 'Направление',
      name: 'course',
      value: value.course || '',
      options: [{ value: '', label: 'Не выбрано' }, ...COURSES.map((course) => ({ value: course, label: course }))],
    }),
    field({ label: 'Группа', name: 'group', value: value.group || '', placeholder: 'Например, «Питон-вт-17:00»' }),
    field({
      label: 'Преподаватель',
      name: 'teacherId',
      value: value.teacherId || '',
      options: [
        { value: '', label: 'Не назначен' },
        ...teachers.map((teacher) => ({ value: teacher.id, label: teacher.name })),
      ],
      disabled: !canAssignTeacher,
      hint: canAssignTeacher ? '' : 'Закрепление меняет администратор',
    }),
    field({
      label: 'Статус',
      name: 'status',
      value: value.status || 'active',
      options: STATUSES.map((status) => ({ value: status.id, label: status.label })),
    }),
  ]);

  const parents = h('div', { class: 'grid gap-4 sm:grid-cols-2' }, [
    field({ label: 'ФИО родителя', name: 'parentName', value: value.parentName || '' }),
    field({ label: 'Телефон родителя', name: 'parentPhone', type: 'tel', value: value.parentPhone || '' }),
    field({ label: 'Email родителя', name: 'parentEmail', type: 'email', value: value.parentEmail || '' }),
    field({ label: 'Второй родитель', name: 'parentSecond', value: value.parentSecond || '', placeholder: 'ФИО и телефон' }),
    field({ label: 'Стоимость занятия, ₽', name: 'lessonPrice', type: 'number', min: 0, value: value.lessonPrice ?? '' }),
  ]);

  const traitFields = h('div', { class: 'grid gap-4 sm:grid-cols-2' }, [
    field({ label: 'Темп', name: 'pace', type: 'textarea', rows: 2, value: traits.pace || '', placeholder: 'Быстро схватывает, нужен запас задач…' }),
    field({ label: 'Поведение', name: 'behavior', type: 'textarea', rows: 2, value: traits.behavior || '', placeholder: 'Стесняется отвечать, отвлекается…' }),
    field({ label: 'Здоровье', name: 'health', type: 'textarea', rows: 2, value: traits.health || '', placeholder: 'Особенности, о которых важно знать' }),
    field({ label: 'Пожелания', name: 'wishes', type: 'textarea', rows: 2, value: traits.wishes || '', placeholder: 'Чего ждут от занятий ребёнок и родители' }),
  ]);

  const noteField = field({
    label: 'Заметка администратора',
    name: 'adminNote',
    type: 'textarea',
    rows: 3,
    value: value.adminNote || '',
    hint: 'Видна только администраторам',
  });

  const form = h('div', { class: 'space-y-5' }, [
    main,
    h('div', {}, [
      h('p', { class: 'kv-label mb-3', text: 'Родители и оплата — видит только администратор' }),
      parents,
    ]),
    h('div', {}, [h('p', { class: 'kv-label mb-3', text: 'Особенности ребёнка — видны и преподавателю' }), traitFields]),
    noteField,
  ]);

  const saveButton = modalButton(isEdit ? 'Сохранить' : 'Создать карточку', {
    kind: 'primary',
    loadingLabel: 'Сохраняем…',
  });

  const modal = openModal({
    title: isEdit ? `Карточка: ${value.name}` : 'Новый ученик',
    subtitle: isEdit ? 'Изменения попадут в историю карточки' : 'Заполните хотя бы имя — остальное можно добавить позже',
    size: 'max-w-3xl',
    body: form,
    actions: [saveButton, modalButton('Отмена', { onClick: () => modal.close() })],
  });

  saveButton.addEventListener('click', async () => {
    setButtonLoading(saveButton, true);
    showFieldErrors(modal.panel, null);

    const values = readForm(form);
    const payload = {
      name: values.name,
      birthDate: values.birthDate,
      age: values.age,
      startedAt: values.startedAt,
      course: values.course,
      group: values.group,
      status: values.status,
      parentName: values.parentName,
      parentPhone: values.parentPhone,
      parentEmail: values.parentEmail,
      parentSecond: values.parentSecond,
      lessonPrice: values.lessonPrice,
      adminNote: values.adminNote,
      traits: {
        pace: values.pace,
        behavior: values.behavior,
        health: values.health,
        wishes: values.wishes,
      },
    };

    // Без права закрепления поле вообще не уходит в запрос: readForm читает и
    // отключённые поля, а сервер отклонил бы всю форму из-за поля, менять которое нельзя.
    if (canAssignTeacher) payload.teacherId = values.teacherId;

    try {
      const data = isEdit
        ? await api(`/students/${encodeURIComponent(student.id)}`, { method: 'PATCH', body: payload })
        : await api('/students', { method: 'POST', body: payload });

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
