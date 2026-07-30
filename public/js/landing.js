'use strict';

/**
 * Поведение лендинга «ПроКод».
 * Отправку формы заявки этот файл не трогает — она живёт в /js/form.js.
 */
(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------ шапка

  function initHeader() {
    const header = document.getElementById('siteHeader');
    if (!header) return;

    const apply = () => header.classList.toggle('is-scrolled', window.scrollY > 40);
    apply();
    window.addEventListener('scroll', apply, { passive: true });
  }

  // --------------------------------------------------------- мобильное меню

  const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';

  /**
   * Прячет содержимое страницы от клавиатуры и скринридера, пока открыто меню.
   * Основной путь — inert (браузер сам убирает ветку из фокуса и из дерева доступности).
   * Старым браузерам inert неизвестен: там гасим табуляцию вручную, запоминая прежний
   * tabindex, чтобы вернуть его при закрытии.
   */
  function createIsolation(nodes) {
    const supportsInert = 'inert' in HTMLElement.prototype;

    function fallback(node, isolated) {
      if (isolated) {
        node.setAttribute('aria-hidden', 'true');
        for (const item of node.querySelectorAll(FOCUSABLE)) {
          if (item.dataset.menuTabindex === undefined) {
            item.dataset.menuTabindex = item.getAttribute('tabindex') ?? '';
          }
          item.setAttribute('tabindex', '-1');
        }
        return;
      }

      node.removeAttribute('aria-hidden');
      for (const item of node.querySelectorAll('[data-menu-tabindex]')) {
        const previous = item.dataset.menuTabindex;
        if (previous) item.setAttribute('tabindex', previous);
        else item.removeAttribute('tabindex');
        delete item.dataset.menuTabindex;
      }
    }

    return (isolated) => {
      for (const node of nodes) {
        if (supportsInert) node.inert = isolated;
        else fallback(node, isolated);
      }
    };
  }

  function initMobileMenu() {
    const burger = document.getElementById('burger');
    const menu = document.getElementById('mobileMenu');
    if (!burger || !menu) return;

    // Шапку не изолируем: логотип, кнопка «Попробовать бесплатно» и сам бургер
    // остаются видимыми поверх меню, значит и доступными с клавиатуры.
    const isolate = createIsolation(
      [document.getElementById('main'), document.getElementById('contacts')].filter(Boolean)
    );

    const isOpen = () => !menu.classList.contains('hidden');

    const setOpen = (open) => {
      menu.classList.toggle('hidden', !open);
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
      document.body.classList.toggle('overflow-hidden', open);
      isolate(open);

      if (open) {
        const firstLink = menu.querySelector('a[href]');
        if (firstLink) firstLink.focus({ preventScroll: true });
        return;
      }

      // Фокус возвращается на бургер: закрытое меню нельзя оставлять с фокусом
      // на скрытой ссылке — он «проваливается» в body, и следующий Tab начинает
      // обход страницы заново. Исключение делает сам браузер: если меню закрыл клик
      // по пункту-якорю, переход к разделу переносит точку обхода к нему — так и нужно.
      // preventScroll — чтобы не отменить эту прокрутку к якорю.
      burger.focus({ preventScroll: true });
    };

    burger.addEventListener('click', () => setOpen(!isOpen()));
    menu.addEventListener('click', (event) => {
      if (event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen()) setOpen(false);
    });

    // На широком экране меню скрыто правилом lg:hidden, но изоляция осталась бы включённой
    // и страница стала бы недоступной. Поворот планшета закрывает меню принудительно.
    const desktop = window.matchMedia('(min-width: 1024px)');
    const onDesktop = (event) => {
      if (event.matches && isOpen()) setOpen(false);
    };
    if (typeof desktop.addEventListener === 'function') desktop.addEventListener('change', onDesktop);
    else desktop.addListener(onDesktop);
  }

  // ------------------------------------------------- переключатели вкладок

  /**
   * Связывает кнопки role="tab" с панелями role="tabpanel".
   * onSelect вызывается после переключения — им пользуется «экран ученика».
   */
  function initTabs(tabs, panels, onSelect) {
    if (tabs.length === 0 || tabs.length !== panels.length) return null;

    const select = (index, moveFocus) => {
      tabs.forEach((tab, i) => {
        const active = i === index;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        panels[i].hidden = !active;
      });
      if (moveFocus) tabs[index].focus();
      if (typeof onSelect === 'function') onSelect(index);
    };

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(index, false));
      tab.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (step === 0) return;
        event.preventDefault();
        select((index + step + tabs.length) % tabs.length, true);
      });
    });

    return select;
  }

  // ----------------------------------------------------- «экран ученика»

  const CODE_SAMPLES = [
    {
      lang: 'lua',
      // Строки намеренно короткие: панель кода узкая, длинные обрезались бы
      code: [
        'local part = Instance.new("Part")',
        'part.Size = Vector3.new(8, 1, 8)',
        'part.Anchored = true',
        'part.Parent = workspace',
        '',
        'part.Touched:Connect(function()',
        '  score += 1',
        'end)',
      ].join('\n'),
    },
    {
      lang: 'html',
      code: [
        '<section class="hero">',
        '  <h1>Мой первый сайт</h1>',
        '  <p>Проект для школы</p>',
        '  <a class="btn" href="#works">',
        '    Смотреть работы',
        '  </a>',
        '</section>',
      ].join('\n'),
    },
    {
      lang: 'python',
      code: [
        'import random',
        '',
        'secret = random.randint(1, 100)',
        'tries = 0',
        '',
        'while True:',
        '    guess = int(input("Число: "))',
        '    tries += 1',
        '    if guess == secret:',
        '        print("Угадал за", tries)',
        '        break',
      ].join('\n'),
    },
  ];

  const SYNTAX_RULES = {
    lua: [
      [/^--[^\n]*/, 'tok-com'],
      [/^"[^"]*"/, 'tok-str'],
      [/^\b(local|function|end|then|if|else|for|in|return|true|false|nil)\b/, 'tok-kw'],
      [/^\b\d+(?:\.\d+)?\b/, 'tok-num'],
      [/^[A-Za-z_]\w*(?=\()/, 'tok-fn'],
      [/^[(){}[\].,:;=+\-*/#]+/, 'tok-pun'],
    ],
    html: [
      [/^<\/?[\w-]+/, 'tok-kw'],
      [/^"[^"]*"/, 'tok-str'],
      [/^[\w-]+(?==)/, 'tok-fn'],
      [/^[<>/=]+/, 'tok-pun'],
    ],
    python: [
      [/^#[^\n]*/, 'tok-com'],
      [/^"[^"]*"/, 'tok-str'],
      [/^\b(import|from|while|for|if|elif|else|break|def|return|True|False|None|and|or|not|in)\b/, 'tok-kw'],
      [/^\b\d+\b/, 'tok-num'],
      [/^[A-Za-z_]\w*(?=\()/, 'tok-fn'],
      [/^[(){}[\]:,.=+\-*/<>!]+/, 'tok-pun'],
    ],
  };

  /** Разбивает код на пары «кусок текста → класс подсветки». */
  function tokenize(code, lang) {
    const rules = SYNTAX_RULES[lang] || [];
    const tokens = [];
    let rest = code;

    while (rest.length > 0) {
      let matched = null;

      for (const [pattern, cls] of rules) {
        const found = pattern.exec(rest);
        if (found && found[0].length > 0) {
          matched = { text: found[0], cls };
          break;
        }
      }

      if (!matched) matched = { text: rest[0], cls: '' };

      tokens.push(matched);
      rest = rest.slice(matched.text.length);
    }

    return tokens;
  }

  function initStudentScreen() {
    const screen = document.getElementById('studentScreen');
    const codeEl = document.getElementById('screenCode');
    if (!screen || !codeEl) return;

    const tabs = [0, 1, 2].map((i) => document.getElementById(`stab-${i}`));
    const panels = [0, 1, 2].map((i) => document.getElementById(`spanel-${i}`));
    if (tabs.some((el) => !el) || panels.some((el) => !el)) return;

    const samples = CODE_SAMPLES.map((sample) => tokenize(sample.code, sample.lang));

    const TYPE_MS = 22;
    const CHARS_PER_TICK = 3;
    const HOLD_MS = 4200;

    let current = 0;
    let paused = false;
    let manual = false;
    let typeTimer = null;
    let holdTimer = null;

    const clearTimers = () => {
      clearInterval(typeTimer);
      clearTimeout(holdTimer);
      typeTimer = null;
      holdTimer = null;
    };

    const render = (tokens, limit) => {
      const fragment = document.createDocumentFragment();
      let used = 0;

      for (const token of tokens) {
        if (used >= limit) break;
        const take = Math.min(token.text.length, limit - used);
        const span = document.createElement('span');
        if (token.cls) span.className = token.cls;
        span.textContent = token.text.slice(0, take);
        fragment.appendChild(span);
        used += take;
      }

      codeEl.replaceChildren(fragment);
    };

    const scheduleNext = () => {
      if (manual || paused) return;
      holdTimer = setTimeout(() => select((current + 1) % tabs.length, false), HOLD_MS);
    };

    const play = (index) => {
      clearTimers();

      const tokens = samples[index];
      const total = tokens.reduce((sum, token) => sum + token.text.length, 0);

      if (reduceMotion) {
        render(tokens, total);
        return;
      }

      let shown = 0;
      render(tokens, 0);

      typeTimer = setInterval(() => {
        shown = Math.min(shown + CHARS_PER_TICK, total);
        render(tokens, shown);
        if (shown >= total) {
          clearInterval(typeTimer);
          typeTimer = null;
          scheduleNext();
        }
      }, TYPE_MS);
    };

    const select = initTabs(tabs, panels, (index) => {
      current = index;
      play(index);
    });
    if (!select) return;

    tabs.forEach((tab) => tab.addEventListener('click', () => {
      // Ручной выбор отключает автопоказ: пользователь сам решил, что смотреть.
      manual = true;
      clearTimers();
    }));

    screen.addEventListener('mouseenter', () => {
      paused = true;
      clearTimeout(holdTimer);
    });
    screen.addEventListener('mouseleave', () => {
      paused = false;
      if (!typeTimer) scheduleNext();
    });
    screen.addEventListener('focusin', () => {
      paused = true;
      clearTimeout(holdTimer);
    });
    screen.addEventListener('focusout', () => {
      if (screen.contains(document.activeElement)) return;
      paused = false;
      if (!typeTimer) scheduleNext();
    });

    play(0);
  }

  // ------------------------------------------------- появление при скролле

  function initReveal() {
    const items = document.querySelectorAll('.reveal');
    if (items.length === 0) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      items.forEach((item) => item.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.05 }
    );

    items.forEach((item) => observer.observe(item));
  }

  // ------------------------------------------- переходы к форме и якорям

  function scrollToTarget(selector) {
    const target = document.querySelector(selector);
    if (!target) return;
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  function initCourseLinks() {
    const courseSelect = document.getElementById('course');

    document.querySelectorAll('[data-course]').forEach((button) => {
      button.addEventListener('click', () => {
        const { course } = button.dataset;

        if (courseSelect && [...courseSelect.options].some((option) => option.value === course)) {
          courseSelect.value = course;
          courseSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }

        scrollToTarget('#signup');

        const parentName = document.getElementById('parentName');
        if (!parentName) return;
        // Фокус после прокрутки, иначе браузер прервёт плавный переход.
        setTimeout(() => parentName.focus({ preventScroll: true }), reduceMotion ? 0 : 700);
      });
    });

    document.querySelectorAll('[data-scroll-to]').forEach((button) => {
      button.addEventListener('click', () => scrollToTarget(button.dataset.scrollTo));
    });
  }

  // --------------------------------------------------------------- FAQ

  function initFaq() {
    const list = document.getElementById('faqList');
    if (!list) return;

    const items = [...list.querySelectorAll('details')];
    items.forEach((item) => {
      item.addEventListener('toggle', () => {
        if (!item.open) return;
        items.forEach((other) => {
          if (other !== item) other.open = false;
        });
      });
    });
  }

  // ------------------------------------------------------------ мелочи

  function initYear() {
    const year = document.getElementById('year');
    if (year) year.textContent = String(new Date().getFullYear());
  }

  // ------------------------------------------------------------- запуск

  initHeader();
  initMobileMenu();
  initStudentScreen();
  initReveal();
  initCourseLinks();
  initFaq();
  initYear();
})();
