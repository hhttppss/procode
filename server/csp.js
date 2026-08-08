'use strict';

/**
 * Content-Security-Policy — одна политика на лендинг и на платформу.
 *
 * Почему server/csp.js, а не server/config/csp.js: рядом уже лежит файл server/config.js.
 * Появись каталог server/config/, и require('./config') стал бы двусмысленным для читателя —
 * Node предпочтёт файл, но по коду этого не видно. Папка server/ намеренно плоская
 * (auth.js, config.js, db.js), csp.js встаёт в тот же ряд.
 *
 * 'unsafe-inline' здесь нет ни в script-src, ни в style-src. Инлайновый код в проекте
 * ровно двух видов, и у каждого свой способ разрешения:
 *
 *  • страницы платформы — <script> с данными сессии, который собирает views/render.js.
 *    На каждый запрос выдаётся новый nonce (см. middleware в server/index.js), он же
 *    подставляется в атрибут скрипта. Nonce обязан быть одноразовым: постоянное значение
 *    равносильно 'unsafe-inline' — внедрённый скрипт просто скопирует его из разметки.
 *
 *  • лендинг public/index.html — два блока <script type="application/ld+json">
 *    с микроразметкой. Файл статический и отдаётся как есть (res.sendFile), шаблонизатора
 *    для него нет и заводить его ради nonce незачем, поэтому в политику попадают
 *    sha256-хэши содержимого блоков. Браузеры применяют script-src и к ld+json:
 *    без хэша микроразметка будет заблокирована, а поисковик её не увидит.
 *
 * ВАЖНО: хэши считаются один раз при старте сервера. Поправили инлайновый блок
 * в index.html — перезапустите сервер (при npm run dev автоперезапуск на этот файл
 * не срабатывает: --watch следит только за подключёнными модулями). Иначе браузер
 * заблокирует блок и напишет об этом в консоли, а страница в остальном будет работать.
 *
 * Как только в script-src появляются nonce или хэш, браузер игнорирует 'unsafe-inline'
 * целиком — старым браузерам, которые про nonce не знают, подстраховку дал бы
 * 'unsafe-inline' в конце списка, но такие браузеры платформа и без того не тянет
 * (нативные ES-модули).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('./config');

const INDEX_FILE = path.join(config.rootDir, 'public', 'index.html');

// Атрибуты и тело блока. Ленивый квантификатор — чтобы не съесть всё до последнего </script>.
// Разбор регулярным выражением, а не парсером, здесь достаточен: файл свой, в нём нет
// ни «>» внутри значений атрибутов, ни строки «</script>» внутри кода — на таком HTML
// точно так же споткнулся бы и браузер.
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const HAS_SRC = /\bsrc\s*=/i;

/**
 * sha256-хэши инлайновых <script> из HTML в формате, который понимает CSP.
 *
 * Переводы строк приводятся к \n: парсер HTML нормализует CRLF ещё до того, как текст
 * скрипта попадёт в хэш, — иначе на checkout'е с CRLF (core.autocrlf в Windows) хэши
 * не сошлись бы с тем, что посчитал браузер.
 *
 * @param {string} html содержимое файла
 * @returns {string[]} значения вида sha256-<base64>, по одному на блок, без повторов
 */
function inlineScriptHashes(html) {
  const hashes = new Set();

  for (const [, attributes, code] of String(html).matchAll(SCRIPT_TAG)) {
    if (HAS_SRC.test(attributes)) continue; // внешний файл — его покрывает 'self'

    const source = code.replace(/\r\n?/g, '\n');
    hashes.add(`sha256-${crypto.createHash('sha256').update(source, 'utf8').digest('base64')}`);
  }

  return [...hashes];
}

/**
 * Хэши инлайновых блоков лендинга. Файла может не быть вовсе: сервер в этом случае
 * показывает заглушку (см. landingPlaceholder в index.js), инлайновых блоков в ней нет
 * и разрешать нечего.
 */
function readLandingHashes(file) {
  try {
    return inlineScriptHashes(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`CSP: не удалось прочитать ${file} (${error.message}) — микроразметка лендинга будет заблокирована.`);
    }
    return [];
  }
}

/**
 * Директивы, не зависящие от запроса.
 *
 * frame-src и worker-src перекрывают default-src не «на всякий случай»: ни одного <iframe>
 * и ни одного Worker в проекте нет, а внедрённый фрейм с data:-документом или воркер
 * из blob: — это обходной путь для script-src. media-src и manifest-src не перечислены
 * намеренно: ни видео, ни манифеста на страницах нет, их закрывает default-src 'self',
 * и отдельный 'none' только молча сломал бы их появление, ничего не добавив к защите.
 *
 * upgrade-insecure-requests не добавляется: все ссылки на ресурсы относительные, апгрейдить
 * нечего, а в разработке сервер поднимается по http://localhost. За HTTPS-прокси уместнее
 * HSTS на самом прокси.
 */
const STATIC_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'self'",
  // data: — для встроенных SVG-иконок в фонах (src/input.css), они не выносятся в файлы.
  "img-src 'self' data:",
  // Шрифты лежат на своём домене (public/fonts), @font-face — в styles.css.
  // Вернутся в Google Fonts — сюда придётся дописать их домены, иначе браузер молча
  // заблокирует загрузку.
  "style-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
].join('; ');

const LANDING_HASHES = readLandingHashes(INDEX_FILE)
  .map((hash) => ` '${hash}'`)
  .join('');

/** Одноразовый nonce для инлайнового блока с данными сессии. */
function createNonce() {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Готовое значение заголовка Content-Security-Policy.
 * @param {string} nonce значение из createNonce() — своё на каждый запрос
 */
function policy(nonce) {
  return `${STATIC_DIRECTIVES}; script-src 'self' 'nonce-${nonce}'${LANDING_HASHES}`;
}

module.exports = {
  createNonce,
  policy,
  inlineScriptHashes,
  // Для диагностики и тестов: сколько инлайновых блоков лендинга разрешено хэшами.
  landingHashCount: LANDING_HASHES ? LANDING_HASHES.trim().split(' ').length : 0,
};
