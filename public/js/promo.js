'use strict';

/**
 * Промокод на скидку 15% — общая точка правды для двух скриптов лендинга:
 *   • landing.js — блоки-призывы (кнопка «забрать скидку» и их состояние);
 *   • form.js    — форма заявки, которая подставляет код в комментарий.
 *
 * Код живёт в localStorage, а не в переменной: родитель может уйти на
 * /privacy.html или /oferta.html и вернуться, и скидка должна его дождаться.
 *
 * Файл подключается ПЕРЕД landing.js и form.js — оба ждут готовый window.ProKodPromo.
 */
window.ProKodPromo = (function () {
  const KEY = 'prokod:promo';
  const CODE = 'PROKOD15';
  const PERCENT = 15;

  // Промокод не должен жить в браузере вечно: через месяц предложение уже другое,
  // и подставлять старый код в заявку честнее не пытаться.
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;

  const listeners = new Set();

  /**
   * localStorage бросает исключение в приватном режиме Safari и при запрете
   * хранилища в настройках. Скидка — не та функция, ради которой можно уронить
   * весь скрипт лендинга, поэтому любое обращение обёрнуто.
   */
  function readRaw() {
    try {
      return window.localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  function writeRaw(value) {
    try {
      window.localStorage.setItem(KEY, value);
      return true;
    } catch {
      return false;
    }
  }

  function removeRaw() {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // Нечего удалять — значит, и сохранить не удалось. Молча выходим.
    }
  }

  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Обработчик промокода упал:', error);
      }
    }
  }

  /**
   * Возвращает сохранённый промокод или null.
   * Заодно выбрасывает мусор: чужой код (акция сменилась), просроченный
   * и битый JSON — иначе они молча дожили бы до отправки заявки.
   */
  function read() {
    const raw = readRaw();
    if (!raw) return null;

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      removeRaw();
      return null;
    }

    if (!data || typeof data !== 'object' || data.code !== CODE) {
      removeRaw();
      return null;
    }

    const savedAt = Number(data.savedAt);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > TTL_MS) {
      removeRaw();
      return null;
    }

    return { code: CODE, percent: PERCENT, savedAt };
  }

  /** Сохраняет промокод. Возвращает его же — даже если хранилище недоступно. */
  function save() {
    const value = { code: CODE, percent: PERCENT, savedAt: Date.now() };
    writeRaw(JSON.stringify(value));
    notify();
    return value;
  }

  function clear() {
    removeRaw();
    notify();
  }

  /** Подписка на изменения: и в этой вкладке, и в соседних. */
  function onChange(listener) {
    if (typeof listener !== 'function') return;
    listeners.add(listener);
  }

  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) notify();
  });

  return { CODE, PERCENT, read, save, clear, onChange };
})();
