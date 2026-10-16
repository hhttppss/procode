'use strict';

/**
 * Точка входа: лендинг «ПроКод», публичный API заявок и внутренняя платформа /app.
 * Запуск: npm start (или node server/index.js).
 */

const compression = require('compression');
const express = require('express');
const path = require('path');

// config подключается первым намеренно: он выставляет process.env.TZ, а всё,
// что считает «сегодня» и «эту неделю», должно увидеть уже правильный пояс.
const config = require('./config');
const assets = require('./assets');
const auth = require('./auth');
const csp = require('./csp');
const db = require('./db');
const models = require('./models');

// Через сколько мс после SIGTERM/SIGINT принудительно выйти, если что-то зависло
// (недобитое соединение, зависший файловый I/O). systemd Restart=on-failure/on-abnormal
// подхватит процесс дальше — важно не остаться висеть под старым PID.
const SHUTDOWN_TIMEOUT_MS = 10_000;

const PUBLIC_DIR = path.join(config.rootDir, 'public');
const LANDING_URL = '/index.html';

const app = express();

app.disable('x-powered-by');
// Доверять X-Forwarded-For только за обратным прокси — иначе лимиты по IP можно обойти.
app.set('trust proxy', config.trustProxy);

/**
 * Заголовки безопасности. Сама политика собрана в server/csp.js — там же объяснено,
 * почему в ней нет 'unsafe-inline' и как разрешены оба вида инлайновых блоков.
 *
 * Nonce выдаётся на каждый запрос, включая запросы за картинками и шрифтами, где он
 * никому не нужен. Это 16 случайных байт — дешевле, чем второй код-путь, в котором
 * легко забыть выдать nonce новой странице платформы.
 */
app.use((req, res, next) => {
  res.locals.cspNonce = csp.createNonce();

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', csp.policy(res.locals.cspNonce));
  next();
});

/**
 * Проверка живости для внешнего аптайм-мониторинга и локального check.sh.
 * Дешёвый настоящий запрос к БД (а не просто "процесс жив"): если файл базы
 * повреждён или залочен, это должно превратить /healthz в 503, а не в ложный ok.
 * Стоит до compression/static — ответ не должен зависеть от остального пайплайна.
 */
app.get('/healthz', (req, res) => {
  models.users
    .isEmpty()
    .then(() => res.status(200).type('text/plain').send('ok'))
    .catch((error) => {
      console.error('Healthcheck: БД недоступна:', error.message);
      res.status(503).type('text/plain').send('db error');
    });
});

/**
 * Сжатие ответов. Стоит до статики и до маршрутов: самое тяжёлое здесь — styles.css
 * и HTML лендинга, а они отдаются ниже.
 * За nginx этот слой лучше выключить и сжимать на прокси — см. README.
 */
app.use(compression());

app.use(express.json({ limit: '64kb' }));

/**
 * Статические страницы (public/*.html) отдаются не как есть, а с проставленными метками
 * версий у ссылок на CSS и JS — см. server/assets.js. Разметка размечена и разложена
 * по памяти при старте, здесь остаётся только отдать строку.
 *
 * Обработчик стоит перед express.static, иначе тот отдал бы index.html и oferta.html
 * в исходном виде, без меток. HTML по-прежнему `no-cache`: он и есть тот документ,
 * из которого браузер узнаёт актуальные метки, кэшировать его нельзя.
 * ETag и ответ 304 берёт на себя res.send.
 */
function sendPage(res, urlPath) {
  const html = assets.page(urlPath);
  if (html === null) return false;

  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
  return true;
}

app.get(['/', LANDING_URL], (req, res) => {
  if (sendPage(res, LANDING_URL)) return;
  // Лендинга нет на диске — платформа работает и без него, показываем заглушку.
  res.status(200).type('html').send(landingPlaceholder());
});

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!sendPage(res, req.path)) next();
});

/**
 * Наружу отдаётся только public/: data/, server/ и src/ остаются недоступны.
 *
 * Кэширование. Файл, запрошенный с меткой версии (`?v=<хэш содержимого>`), отдаётся
 * с годовым `immutable`: изменится файл — изменится и адрес в разметке, поэтому
 * перепроверять нечего. Без метки или с устаревшей — прежний `no-cache`: браузер
 * переспрашивает сервер и по ETag получает пустой 304. Так продолжают работать
 * старые ссылки, прямые заходы и относительные импорты внутри модулей платформы,
 * которым метку не проставить. Картинкам и шрифтам хватает часа: ссылок на них
 * в разметке нет (они подключаются из styles.css), метку ставить некуда.
 * Подробности и обоснование — в server/assets.js.
 */
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    maxAge: '1h',
    setHeaders: assets.setStaticHeaders,
  })
);

// Публичный API лендинга — без сессии.
app.use('/api', require('./routes/public'));

// Дальше идёт всё, что связано с сотрудниками: сначала определяем, кто пришёл.
app.use(auth.attachUser);
app.use(auth.sameOrigin);

app.use('/', require('./routes/auth'));

/**
 * Всё под /app — личное. В страницы инлайном уезжают имя, роль и права текущего
 * сотрудника, а ответы /app/api состоят из данных школы целиком. no-store запрещает
 * сохранять их и браузеру, и промежуточному прокси: иначе следующий человек за тем же
 * компьютером увидит чужую страницу кнопкой «Назад», а общий кэш офиса — чужие данные.
 * Один префикс покрывает и страницы, и API — заголовку незачем расползаться по обработчикам.
 */
app.use('/app', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, private');
  next();
});

app.use('/app/api', require('./routes/api'));
app.use('/app', require('./routes/pages'));

// Адреса первой версии проекта продолжают работать: старые закладки не ломаются.
app.get('/admin', (req, res) => res.redirect(301, '/app'));
app.get('/admin/login', (req, res) => res.redirect(301, '/login'));

// -------------------------------------------------------------- 404 и ошибки

function isApiRequest(req) {
  return req.path.startsWith('/api/') || req.path.startsWith('/app/api/');
}

function htmlPage({ title, heading, text, link }) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — ПроКод</title>
  <link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/css/styles.css${assets.query('/css/styles.css')}">
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
    text: 'Файл public/index.html не найден. Платформа уже работает — заявки принимаются и сохраняются.',
    link: { href: '/app', label: 'Открыть платформу' },
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
  await models.init();

  // Хэши статики и размеченные страницы считаются до первого запроса, а не в обработчике.
  const pages = assets.preload();

  const server = app.listen(config.port, () => {
    const base = `http://localhost:${config.port}`;

    console.log('');
    console.log('  ПроКод — сервер запущен');
    console.log(`  Лендинг:    ${base}/`);
    console.log(`  Платформа:  ${base}/app`);
    console.log(`  Вход:       ${base}/login`);
    // Пояс печатается на старте: после деплоя на UTC-сервер это первое, что стоит проверить.
    console.log(`  Часовой пояс: ${config.timezone}`);
    console.log('  Стили:      npm run css — пересобрать CSS после правок разметки');
    console.log(
      `  Версии статики: метки проставлены на ${pages} стр.${assets.watchMode ? ' (режим --watch: пересчёт на каждый запрос)' : ''}`
    );
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

  setupGracefulShutdown(server);

  return server;
}

/**
 * Graceful shutdown по SIGTERM (systemctl stop/restart) и SIGINT (Ctrl+C).
 *
 * server.close() перестаёт принимать новые соединения и ждёт завершения уже открытых
 * запросов, после чего закрывается соединение с БД (server/db.js — WAL-чекпоинт
 * и закрытие файла на sqlite). Без этого каждый деплой (systemctl restart) обрывал бы
 * активные запросы и sqlite-транзакции на середине.
 *
 * Таймер — подстраховка на случай зависшего keep-alive соединения или файлового I/O:
 * процесс обязан завершиться сам, а не остаться висеть под старым PID до SIGKILL.
 */
function setupGracefulShutdown(server) {
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n  Получен ${signal}, завершаю работу...`);

    const forceExit = setTimeout(() => {
      console.error(`  Не удалось завершиться за ${SHUTDOWN_TIMEOUT_MS}мс — принудительный выход.`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close((error) => {
      if (error) console.error('  Ошибка при остановке HTTP-сервера:', error.message);

      try {
        db.close();
      } catch (closeError) {
        console.error('  Ошибка при закрытии БД:', closeError.message);
      }

      clearTimeout(forceExit);
      process.exit(error ? 1 : 0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Не удалось запустить сервер:', error);
    process.exit(1);
  });
}

module.exports = app;
module.exports.start = start;
