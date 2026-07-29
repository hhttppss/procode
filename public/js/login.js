'use strict';

/**
 * Страница входа для сотрудников. Ничего, кроме отправки формы, здесь не происходит:
 * решение о том, куда пустить человека, принимает сервер по его роли.
 */

(() => {
  const form = document.getElementById('loginForm');
  if (!form) return;

  const submit = document.getElementById('loginSubmit');
  const errorBox = document.getElementById('loginError');

  /** Адрес, на который нужно вернуться после входа, приходит в ?next= — сервер его проверяет. */
  const next = new URLSearchParams(window.location.search).get('next') || '';

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('is-shown');
  }

  function hideError() {
    errorBox.textContent = '';
    errorBox.classList.remove('is-shown');
  }

  function setLoading(loading) {
    if (!submit) return;
    submit.disabled = loading;
    submit.textContent = loading ? submit.dataset.labelLoading : submit.dataset.labelIdle;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideError();

    const login = form.elements.login.value.trim();
    const password = form.elements.password.value;

    if (!login || !password) {
      showError('Введите логин и пароль.');
      (login ? form.elements.password : form.elements.login).focus();
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password, next }),
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (response.ok && data.ok) {
        window.location.href = data.redirect || '/app';
        return;
      }

      showError(data.message || 'Не удалось войти. Попробуйте ещё раз.');
      form.elements.password.value = '';
      form.elements.password.focus();
    } catch {
      showError('Сервер не отвечает. Проверьте подключение и попробуйте снова.');
    } finally {
      setLoading(false);
    }
  });
})();
