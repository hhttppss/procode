'use strict';

/**
 * Точка входа: лендинг «ПроКод», публичный API заявок и админ-панель.
 * Запуск: npm start (или node server/index.js).
 */

const express = require('express');
const path = require('path');

const config = require('./config');
const store = require('./store');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');

const PUBLIC_DIR = path.join(config.rootDir, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

const app = express();

app.disable('x-powered-by');
// Доверять X-Forwarded-For только за обратным прокси — иначе лимиты по IP можно обойти.
app.set('trust proxy', config.trustProxy);

/**
 * Политика безопасности контента.
 *
 * 'unsafe-inline' в script-src нужен из-за инлайновых блоков на страницах:
 * микроразметки JSON-LD в index.html и списка статусов, который сервер
 * подставляет в админку. Убрать его можно, только перейдя на nonce, а для
 * этого index.html придётся отдавать через шаблонизатор, а не как статический файл.
 * Даже в таком виде политика запрещает загрузку скриптов и стилей с чужих доменов,
 * подмену <base> и встраивание сайта в чужой фрейм.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

app.use(express.json({ limit: '32kb' }));

// Наружу отдаётся только public/: data/, server/ и src/ остаются недоступны.
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get('/', (req, res, next) => {
  res.sendFile(INDEX_FILE, (error) => {
    if (!error) return;
    if (error.code === 'ENOENT') return res.status(200).type('html').send(landingPlaceholder());
    next(error);
  });
});

app.use('/api', publicRoutes);
app.use('/admin', adminRoutes);

// -------------------------------------------------------------- 404 и ошибки

function isApiRequest(req) {
  return req.path.startsWith('/api/') || req.path.startsWith('/admin/api/');
}

function htmlPage({ title, heading, text, link }) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — ПроКод</title>
  <link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/css/styles.css">
</head>
<body class="bg-paper">
  <main class="shell flex min-h-screen flex-col items-center justify-center py-16 text-center">
    <p class="eyebrow">ПроКод</p>
    <h1 class="mt-4 font-display text-4xl">${heading}</h1>
    <p class="mt-4 max-w-md text-muted">${text}</p>
    <a class="btn btn-primary mt-8" href="${link.href}">${link.label}</a>
  </main>
</body>
</html>`;
}

function landingPlaceholder() {
  return htmlPage({
    title: 'Лендинг ещё не собран',
    heading: 'Страница сайта пока не готова',
    text: 'Файл public/index.html не найден. Админ-панель уже работает — заявки принимаются и сохраняются.',
    link: { href: '/admin', label: 'Открыть админ-панель' },
  });
}

app.use((req, res) => {
  if (isApiRequest(req)) {
    return res.status(404).json({ ok: false, message: 'Такого метода нет.' });
  }

  return res
    .status(404)
    .type('html')
    .send(
      htmlPage({
        title: 'Страница не найдена',
        heading: 'Такой страницы нет',
        text: 'Возможно, ссылка устарела или в адресе опечатка.',
        link: { href: '/', label: 'На главную' },
      })
    );
});

// eslint-disable-next-line no-unused-vars -- четвёртый аргумент обязателен, иначе Express не считает это обработчиком ошибок
app.use((error, req, res, next) => {
  console.error(`Ошибка на ${req.method} ${req.originalUrl}:`, error.stack || error);

  if (res.headersSent) return;

  // Тело запроса не разобралось (битый JSON или превышен лимит) — это ошибка клиента.
  const badBody = error.type === 'entity.parse.failed' || error.type === 'entity.too.large';
  const status = badBody ? (error.type === 'entity.too.large' ? 413 : 400) : 500;

  if (isApiRequest(req)) {
    const message = badBody
      ? 'Не удалось разобрать запрос. Проверьте данные и попробуйте ещё раз.'
      : 'Внутренняя ошибка сервера. Попробуйте позже.';
    res.status(status).json({ ok: false, message });
    return;
  }

  res
    .status(status)
    .type('html')
    .send(
      htmlPage({
        title: 'Ошибка',
        heading: 'Что-то пошло не так',
        text: 'Мы уже знаем о проблеме. Попробуйте обновить страницу через минуту.',
        link: { href: '/', label: 'На главную' },
      })
    );
});

// ------------------------------------------------------------------- запуск

async function start() {
  await store.init();

  const server = app.listen(config.port, () => {
    const base = `http://localhost:${config.port}`;

    console.log('');
    console.log('  ПроКод — сервер запущен');
    console.log(`  Лендинг:      ${base}/`);
    console.log(`  Админ-панель: ${base}/admin  (логин: ${config.adminLogin})`);
    console.log('  Стили:        npm run css — пересобрать CSS после правок разметки');
    console.log('');

    config.printWarnings();
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `Порт ${config.port} уже занят. Закройте другой запущенный сервер или укажите свободный порт в .env (PORT=…).`
      );
      process.exit(1);
    }
    throw error;
  });

  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Не удалось запустить сервер:', error);
    process.exit(1);
  });
}

module.exports = app;
module.exports.start = start;
