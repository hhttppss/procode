'use strict';

/**
 * Свой профиль: личные данные, смена пароля и — для преподавателя — его статистика.
 * Ставки здесь нет: сервер не присылает её никому, кроме администратора.
 *
 * Правка своих данных и пароля — тоже право: преподаватель видит профиль только
 * на чтение, менять его данные может администратор.
 */

import './shell.js';
import {
  USER,
  api,
  byId,
  can,
  field,
  formatDateTime,
  formatMoney,
  h,
  kv,
  readForm,
  roleLabel,
  setButtonLoading,
  showFieldErrors,
  toast,
} from './core.js';

let profile = null;

const canEditProfile = can('canEditOwnProfile');
const canChangePassword = can('canChangeOwnPassword');

const profileForm = byId('profileForm');
const profileFields = byId('profileFields');
const passwordForm = byId('passwordForm');
const passwordFields = byId('passwordFields');

function renderProfile() {
  // Без права правки — те же поля, но только на чтение: человек видит, что о нём знает
  // система, и понимает, к кому идти за изменениями.
  profileFields.replaceChildren(
    field({ label: 'ФИО', name: 'name', value: profile.name, required: true, disabled: !canEditProfile, autocomplete: 'name' }),
    field({ label: 'Телефон', name: 'phone', type: 'tel', value: profile.phone, disabled: !canEditProfile, autocomplete: 'tel' }),
    field({
      label: 'Email',
      name: 'email',
      type: 'email',
      value: profile.email,
      className: 'sm:col-span-2',
      disabled: !canEditProfile,
      autocomplete: 'email',
    })
  );
}

function renderPasswordFields() {
  passwordFields.replaceChildren(
    field({ label: 'Текущий пароль', name: 'current', type: 'password', required: true, autocomplete: 'current-password' }),
    field({ label: 'Новый пароль', name: 'next', type: 'password', required: true, hint: 'Минимум 6 символов', autocomplete: 'new-password' })
  );
}

function renderAccount() {
  const info = byId('accountInfo');

  info.replaceChildren(
    ...[
      kv('Логин', profile.login, { mono: true }),
      kv('Роль', roleLabel(USER.role)),
      profile.courses && profile.courses.length > 0 ? kv('Направления', profile.courses.join(', ')) : null,
      // Ставка и оклад приходят в ответе только администратору — у преподавателя строк не будет.
      profile.rate !== undefined ? kv('Ставка за занятие', profile.rate ? formatMoney(profile.rate) : 'не задана') : null,
      profile.salary !== undefined ? kv('Оклад за период', profile.salary ? formatMoney(profile.salary) : 'не задан') : null,
      kv('Последний вход', profile.lastLoginAt ? formatDateTime(profile.lastLoginAt) : 'это первый вход', { mono: true }),
    ].filter(Boolean)
  );
}

function renderStats(stats) {
  if (!stats) return;

  byId('statsPanel').hidden = false;
  byId('statsInfo').replaceChildren(
    kv('Закреплено учеников', String(stats.studentsTotal)),
    kv('Проведено за месяц', String(stats.donePeriod)),
    kv('Проведено всего', String(stats.doneAllTime)),
    kv('Отменено за месяц', String(stats.cancelledPeriod)),
    kv('Запланировано впереди', String(stats.plannedAhead))
  );
}

async function load() {
  try {
    const data = await api('/profile');
    profile = data.item;
    renderProfile();
    renderAccount();
    renderStats(data.stats);
  } catch (error) {
    toast(error.message, 'error');
  }
}

if (canEditProfile) {
  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const button = byId('profileSave');
    setButtonLoading(button, true);
    showFieldErrors(profileForm, null);

    try {
      const data = await api('/profile', { method: 'PATCH', body: readForm(profileFields) });
      profile = data.item;
      renderAccount();
      toast('Профиль сохранён');
    } catch (error) {
      showFieldErrors(profileForm, error.errors);
      toast(error.message, 'error');
    } finally {
      setButtonLoading(button, false);
    }
  });
} else {
  // Кнопки нет вовсе, а не disabled: неактивная кнопка выглядит как поломка.
  // Вместо неё — спокойное объяснение, кто меняет данные.
  byId('profileActions').replaceChildren(
    h('p', { class: 'text-sm text-muted', text: 'Личные данные и пароль меняет администратор.' })
  );
}

// Подзаголовок страницы обещает пароль, которого у преподавателя на этой странице нет:
// блок смены пароля из разметки удаляется. Правим текст, а не разметку сервера —
// так же, как это делает главная.
const subheading = document.querySelector('header p');
if (subheading) {
  subheading.textContent = canChangePassword ? 'Личные данные и пароль' : 'Ваши данные и статистика';
}

if (canChangePassword) {
  renderPasswordFields();

  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const button = byId('passwordSave');
    setButtonLoading(button, true);
    showFieldErrors(passwordForm, null);

    try {
      await api('/profile/password', { method: 'POST', body: readForm(passwordFields) });
      toast('Пароль изменён');
      renderPasswordFields();
    } catch (error) {
      showFieldErrors(passwordForm, error.errors);
      toast(error.message, 'error');
    } finally {
      setButtonLoading(button, false);
    }
  });
} else {
  // Блока смены пароля у такого сотрудника нет совсем — не скрытая форма, а её отсутствие.
  byId('passwordPanel').remove();
}

load();
