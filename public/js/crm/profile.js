'use strict';

/**
 * Свой профиль: личные данные, смена пароля и — для преподавателя — его статистика.
 * Ставки здесь нет: сервер не присылает её никому, кроме администратора.
 */

import './shell.js';
import {
  api,
  byId,
  field,
  formatDateTime,
  formatMoney,
  isAdmin,
  kv,
  readForm,
  setButtonLoading,
  showFieldErrors,
  toast,
} from './core.js';

let profile = null;

const profileForm = byId('profileForm');
const profileFields = byId('profileFields');
const passwordForm = byId('passwordForm');
const passwordFields = byId('passwordFields');

function renderProfile() {
  profileFields.replaceChildren(
    field({ label: 'ФИО', name: 'name', value: profile.name, required: true }),
    field({ label: 'Телефон', name: 'phone', type: 'tel', value: profile.phone }),
    field({ label: 'Email', name: 'email', type: 'email', value: profile.email, className: 'sm:col-span-2' })
  );
}

function renderPasswordFields() {
  passwordFields.replaceChildren(
    field({ label: 'Текущий пароль', name: 'current', type: 'password', required: true }),
    field({ label: 'Новый пароль', name: 'next', type: 'password', required: true, hint: 'Минимум 6 символов' })
  );
}

function renderAccount() {
  const info = byId('accountInfo');

  info.replaceChildren(
    ...[
      kv('Логин', profile.login, { mono: true }),
      kv('Роль', isAdmin ? 'Администратор' : 'Преподаватель'),
      profile.courses && profile.courses.length > 0 ? kv('Направления', profile.courses.join(', ')) : null,
      // Ставка приходит в ответе только администратору — у преподавателя строки не будет.
      profile.rate !== undefined ? kv('Ставка за занятие', profile.rate ? formatMoney(profile.rate) : 'не задана') : null,
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

renderPasswordFields();
load();
