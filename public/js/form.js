'use strict';

/**
 * Форма заявки на лендинге: проверка на клиенте, маска телефона, отправка на POST /api/applications.
 * Разметка формы живёт в public/index.html — здесь только поведение.
 * Если формы на странице нет, скрипт молча выходит.
 */

(function setupApplicationForm() {
  const form = document.getElementById('applicationForm');
  if (!form) {
    // Скрипт мог подключиться раньше разметки — дождёмся готового DOM и попробуем ещё раз.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setupApplicationForm, { once: true });
    }
    return;
  }

  const submitButton = document.getElementById('applicationSubmit');
  const successBox = document.getElementById('applicationSuccess');
  const errorBox = document.getElementById('applicationError');

  // Порядок важен: по нему выбирается поле, на которое ставится фокус при ошибке.
  const FIELDS = ['parentName', 'phone', 'email', 'childName', 'childAge', 'course', 'comment', 'consent'];

  const MIN_NAME = 2;
  const MAX_NAME = 60;
  const MAX_COURSE = 80;
  const MAX_COMMENT = 1000;
  const MAX_EMAIL = 120;

  // Диапазон списка «Возраст ребёнка» на странице. Сервер принимает шире (5–19),
  // чтобы не отклонять заявки из других источников, но родителю мы называем
  // тот диапазон, который он реально видит в форме.
  const MIN_AGE = 10;
  const MAX_AGE = 17;

  // ------------------------------------------------------------- телефон

  function normalizePhone(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    const hasPlus = value.startsWith('+');
    const digits = value.replace(/\D/g, '');

    if (digits.length < 10 || digits.length > 15) return null;
    if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return `+7${digits.slice(1)}`;
    if (digits.length === 10 && digits[0] === '9') return `+7${digits}`;

    return hasPlus ? `+${digits}` : digits;
  }

  function formatRussian(rest) {
    let out = '+7';
    if (rest.length > 0) out += ` (${rest.slice(0, 3)}`;
    if (rest.length > 3) out += `) ${rest.slice(3, 6)}`;
    if (rest.length > 6) out += `-${rest.slice(6, 8)}`;
    if (rest.length > 8) out += `-${rest.slice(8, 10)}`;
    return out;
  }

  function maskPhone(value) {
    const hasPlus = value.trim().startsWith('+');
    const digits = value.replace(/\D/g, '');

    if (!digits) return hasPlus ? '+' : '';
    if (digits[0] === '7' || digits[0] === '8') return formatRussian(digits.slice(1, 11));
    if (!hasPlus && digits[0] === '9') return formatRussian(digits.slice(0, 10));

    return `+${digits.slice(0, 15)}`;
  }

  function countDigits(text) {
    return (text.match(/\d/g) || []).length;
  }

  function caretAfterDigits(text, digitCount) {
    if (digitCount <= 0) return 0;

    let seen = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] >= '0' && text[index] <= '9') {
        seen += 1;
        if (seen === digitCount) return index + 1;
      }
    }
    return text.length;
  }

  function attachPhoneMask(input) {
    if (!input) return;

    input.addEventListener('input', () => {
      const previous = input.value;
      const caret = input.selectionStart === null ? previous.length : input.selectionStart;
      const formatted = maskPhone(previous);
      if (formatted === previous) return;

      const atEnd = caret >= previous.length;
      const target = countDigits(previous.slice(0, caret)) + (countDigits(formatted) - countDigits(previous));

      input.value = formatted;

      try {
        const position = atEnd ? formatted.length : caretAfterDigits(formatted, target);
        input.setSelectionRange(position, position);
      } catch {
        // Некоторые типы полей не поддерживают выделение — не страшно, значение уже проставлено.
      }
    });
  }

  // ----------------------------------------------------------- промокод

  const promo = window.ProKodPromo || null;
  const promoBox = document.getElementById('promoApplied');
  const promoBoxCode = document.getElementById('promoAppliedCode');
  const promoRemove = document.getElementById('promoRemove');

  function activePromo() {
    return promo ? promo.read() : null;
  }

  /**
   * Хвост, которым промокод уезжает менеджеру. Отдельного поля под него
   * в /api/applications нет, и заводить его ради одной акции не стоит,
   * поэтому код дописывается в конец комментария.
   */
  function promoSuffix() {
    const active = activePromo();
    return active ? `Промокод: ${active.code} (скидка ${active.percent}% на первый месяц)` : '';
  }

  /**
   * Сколько символов остаётся родителю под собственный текст.
   * Пока промокод активен, часть лимита занята хвостом с кодом — и предупредить
   * об этом надо ДО отправки. Иначе длинный комментарий приводил бы к выбору из
   * двух плохих исходов: либо сервер отвечает 400 на длину, которую родитель не
   * превышал, либо код тихо не дописывается, а форма продолжает обещать скидку.
   */
  function commentLimit() {
    const suffix = promoSuffix();
    // 2 — длина разделителя '\n\n' между комментарием и хвостом
    return suffix ? MAX_COMMENT - suffix.length - 2 : MAX_COMMENT;
  }

  /** Вызывается только после validate(), поэтому в лимит гарантированно укладывается. */
  function withPromo(comment) {
    const suffix = promoSuffix();
    if (!suffix) return comment;

    return comment ? `${comment}\n\n${suffix}` : suffix;
  }

  function paintPromo() {
    const active = activePromo();
    if (promoBoxCode && active) promoBoxCode.textContent = active.code;
    if (promoBox) promoBox.hidden = active === null;
  }

  if (promoRemove && promo) {
    promoRemove.addEventListener('click', () => {
      promo.clear();
      // Освободившийся лимит снимает ошибку «текст не поместится вместе с промокодом».
      clearFieldError('comment');
    });
  }

  if (promo) promo.onChange(paintPromo);
  paintPromo();

  // ---------------------------------------------------------- валидация

  function fieldNode(name) {
    const node = form.elements[name];
    return node instanceof RadioNodeList ? node[0] : node || null;
  }

  function errorNode(name) {
    return (
      form.querySelector(`[data-error-for="${name}"]`) || document.querySelector(`[data-error-for="${name}"]`)
    );
  }

  function readValues() {
    const values = {};

    for (const name of [...FIELDS, 'website']) {
      const node = fieldNode(name);
      if (!node) continue;
      values[name] = node.type === 'checkbox' ? node.checked : node.value;
    }

    return values;
  }

  /** Тексты совпадают с серверными (server/routes/public.js), чтобы человек не видел разных формулировок. */
  function checkName(value, emptyMessage) {
    if (!value) return emptyMessage;
    if (value.length < MIN_NAME) return `Имя слишком короткое — минимум ${MIN_NAME} символа.`;
    if (value.length > MAX_NAME) return `Имя слишком длинное — не больше ${MAX_NAME} символов.`;
    return null;
  }

  function validate(values) {
    const errors = {};

    const parentNameError = checkName(String(values.parentName || '').trim(), 'Укажите, как вас зовут.');
    if (parentNameError) errors.parentName = parentNameError;

    const rawPhone = String(values.phone || '').trim();
    if (!rawPhone) errors.phone = 'Укажите телефон для связи.';
    else if (!normalizePhone(rawPhone)) errors.phone = 'Проверьте номер телефона: в нём должно быть от 10 до 15 цифр.';

    // Email необязателен — проверяем, только если его заполнили.
    const email = String(values.email || '').trim();
    if (email) {
      if (email.length > MAX_EMAIL) errors.email = `Адрес слишком длинный — не больше ${MAX_EMAIL} символов.`;
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Проверьте адрес электронной почты.';
    }

    const childNameError = checkName(String(values.childName || '').trim(), 'Укажите имя ребёнка.');
    if (childNameError) errors.childName = childNameError;

    const ageSource = String(values.childAge || '').trim();
    if (!ageSource) {
      errors.childAge = 'Выберите возраст ребёнка.';
    } else {
      const childAge = Number.parseInt(ageSource, 10);
      if (!Number.isInteger(childAge) || childAge < MIN_AGE || childAge > MAX_AGE) {
        errors.childAge = `Укажите возраст от ${MIN_AGE} до ${MAX_AGE} лет.`;
      }
    }

    const course = String(values.course || '').trim();
    if (!course) errors.course = 'Выберите направление обучения.';
    else if (course.length > MAX_COURSE) errors.course = 'Слишком длинное название направления.';

    const comment = String(values.comment || '').trim();
    const limit = commentLimit();
    if (comment.length > limit) {
      errors.comment =
        limit === MAX_COMMENT
          ? `Комментарий слишком длинный — не больше ${MAX_COMMENT} символов.`
          : `Вместе с промокодом в комментарий помещается не больше ${limit} символов. Сократите текст или уберите промокод.`;
    }

    if (values.consent !== true) errors.consent = 'Нужно согласие на обработку персональных данных.';

    return errors;
  }

  function showFieldError(name, message) {
    const node = fieldNode(name);
    const error = errorNode(name);

    if (node) node.setAttribute('aria-invalid', 'true');
    if (error) {
      error.textContent = message;
      error.classList.add('is-shown');
    }
  }

  function clearFieldError(name) {
    const node = fieldNode(name);
    const error = errorNode(name);

    if (node) node.removeAttribute('aria-invalid');
    if (error) {
      error.textContent = '';
      error.classList.remove('is-shown');
    }
  }

  function showErrors(errors) {
    for (const name of FIELDS) {
      if (errors[name]) showFieldError(name, errors[name]);
      else clearFieldError(name);
    }

    const firstInvalid = FIELDS.find((name) => errors[name]);
    if (!firstInvalid) return;

    const node = fieldNode(firstInvalid);
    if (node && typeof node.focus === 'function') node.focus({ preventScroll: false });
  }

  // ----------------------------------------------------------- отправка

  function showGeneralError(message) {
    if (!errorBox) return;
    const target = errorBox.querySelector('[data-error-message]');
    if (target) target.textContent = message;
    errorBox.hidden = false;
  }

  function hideGeneralError() {
    if (errorBox) errorBox.hidden = true;
  }

  function showSuccess() {
    form.hidden = true;
    if (!successBox) return;

    successBox.hidden = false;
    successBox.setAttribute('tabindex', '-1');
    successBox.focus({ preventScroll: true });
    successBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function setLoading(loading) {
    if (!submitButton) return;
    const idle = submitButton.dataset.labelIdle || 'Отправить заявку';
    const busy = submitButton.dataset.labelLoading || 'Отправляем…';
    submitButton.disabled = loading;
    submitButton.textContent = loading ? busy : idle;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitButton && submitButton.disabled) return;

    hideGeneralError();

    const values = readValues();
    const errors = validate(values);
    if (Object.keys(errors).length > 0) {
      showErrors(errors);
      return;
    }
    showErrors({});

    const payload = {
      parentName: String(values.parentName).trim(),
      phone: normalizePhone(values.phone),
      email: String(values.email || '').trim(),
      childName: String(values.childName).trim(),
      childAge: Number.parseInt(values.childAge, 10),
      course: String(values.course).trim(),
      comment: withPromo(String(values.comment || '').trim()),
      consent: true,
      website: String(values.website || ''),
    };

    setLoading(true);

    try {
      const response = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (response.ok && data.ok) {
        showSuccess();
        return;
      }

      if (response.status === 400 && data.errors) {
        showErrors(data.errors);
        return;
      }

      showGeneralError(
        data.message || 'Не удалось отправить заявку. Попробуйте ещё раз или позвоните нам — мы поможем.'
      );
    } catch {
      showGeneralError('Похоже, пропала связь. Проверьте интернет и попробуйте отправить заявку ещё раз.');
    } finally {
      setLoading(false);
    }
  });

  // Ошибка исчезает, как только человек начал исправлять поле.
  for (const name of FIELDS) {
    const node = fieldNode(name);
    if (!node) continue;

    const eventName = node.tagName === 'SELECT' || node.type === 'checkbox' ? 'change' : 'input';
    node.addEventListener(eventName, () => clearFieldError(name));
  }

  attachPhoneMask(fieldNode('phone'));
})();
