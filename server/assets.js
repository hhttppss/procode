'use strict';

/**
 * Версионирование статики: /css/styles.css → /css/styles.css?v=a1b2c3d4
 *
 * Зачем. Браузер кэширует HTML и CSS независимо друг от друга. После выкладки он может
 * взять новую разметку и старый styles.css из своего кэша — и показать белый экран.
 * Метка в адресе делает такую пару невозможной: изменился файл — изменился адрес,
 * старый ответ из кэша к новому адресу не подходит.
 *
 * Метка считается от СОДЕРЖИМОГО (первые 8 hex-символов sha256), а не от времени файла.
 * Выкладка идёт через `git reset --hard`, после которой mtime обновляется у всех файлов
 * подряд, включая неизменившиеся, — метка по времени заставляла бы перекачивать всю
 * статику после каждого деплоя. По содержимому метка меняется ровно тогда, когда
 * меняется сам файл. 8 символов = 32 бита: коллизия на десятке файлов невозможна
 * практически, а адрес остаётся читаемым в логах.
 *
 * Хэши и готовая размеченная разметка считаются один раз при старте процесса
 * (см. preload) и живут в памяти: на каждый запрос диск не читается.
 *
 * Заголовки. Файл, запрошенный с меткой, совпадающей с текущим содержимым, отдаётся
 * с `immutable` на год — его больше незачем перепроверять. Любой другой случай (метки
 * нет, метка чужая, метка устарела) — прежний `no-cache`: браузер спросит сервер и
 * получит 304 по ETag. Именно поэтому метка сверяется с содержимым, а не просто
 * проверяется на формат: старая ссылка `?v=<прошлый хэш>` ведёт уже на новый файл,
 * и пометить такой ответ вечным кэшем значило бы закрепить у человека несоответствие
 * навсегда.
 *
 * Модули платформы (public/js/crm/*.js) импортируют друг друга по относительным путям,
 * и запрос строки в адресе на импорты не переносится: метку получает только точка входа
 * из <script type="module">, а её зависимости продолжают ревалидироваться по ETag.
 * Это осознанный компромисс — подстановка версий внутрь самих модулей это работа
 * сборщика, которого в проекте намеренно нет. Белый экран такой размен не возвращает:
 * ревалидация гарантирует свежесть, версия лишь снимает лишние запросы.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('./config');

const PUBLIC_DIR = path.join(config.rootDir, 'public');

/** Длина метки в hex-символах. Меняется вместе с VERSION_VALUE. */
const HASH_LENGTH = 8;
const VERSION_VALUE = /^[0-9a-f]{8}$/;

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

/** Версионируется только то, на что есть ссылки в разметке. Шрифты и картинки
 *  подключаются из CSS, отдельной метки им не поставить — им остаётся maxAge статики. */
const VERSIONED = new Set(['.css', '.js']);

/**
 * Ссылка на свою статику в атрибуте href/src. Список файлов нигде не перечислен:
 * что подключено в разметке, то и получит метку. Адрес с уже существующей строкой
 * запроса не трогаем — `[^"?#]` не пускает внутрь «?» и «#».
 */
const ASSET_REF = /\b(href|src)="(\/(?:css|js)\/[^"?#]+\.(?:css|js))"/gi;

/**
 * Режим разработки (`npm run dev` — node --watch). Здесь кэш метки и разметки
 * пересчитывается на каждый запрос: --watch перезапускает процесс только при правке
 * подключённых модулей, а public/index.html, layout.html и собранный styles.css
 * (npm run css:watch пишет его на лету) модулями не являются. Без пересчёта метка
 * в разметке отстала бы от файла, который браузер уже успел закэшировать как immutable,
 * и правки CSS переставали бы появляться на экране до перезапуска и жёсткой перезагрузки.
 * В бою (`npm start`) ни одного из признаков нет — работает обычный кэш.
 *
 * Признаков два, потому что watch-режим запускает скрипт в дочернем процессе: у ребёнка
 * execArgv уже пуст (проверено на Node 24), зато выставлена служебная переменная
 * WATCH_REPORT_DEPENDENCIES, которой он отчитывается о подключённых файлах. Проверяем оба,
 * чтобы не зависеть от версии Node. Если однажды не сработает ни один — сломается только
 * удобство разработки (после правки CSS понадобится перезапуск и жёсткая перезагрузка),
 * на боевую отдачу это не влияет.
 */
const WATCH_MODE =
  process.execArgv.some((argument) => argument.startsWith('--watch')) ||
  Boolean(process.env.WATCH_REPORT_DEPENDENCIES);

// -------------------------------------------------------------------- метки

/** Хэш содержимого файла без кэша. null — файла нет или он нечитаем. */
function fileVersion(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, HASH_LENGTH);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Версия статики: не удалось прочитать ${file} (${error.message}) — файл пойдёт без метки.`);
    }
    return null;
  }
}

const versions = new Map();

/** Хэш содержимого файла, посчитанный один раз за жизнь процесса. */
function versionOf(file) {
  if (!WATCH_MODE && versions.has(file)) return versions.get(file);

  const value = fileVersion(file);
  versions.set(file, value);
  return value;
}

/**
 * Абсолютный путь к файлу внутри public/ по адресу из разметки или из запроса.
 * Всё, что выводит за пределы public/ (../, отдельный диск в Windows), отсекается.
 */
function resolvePublic(urlPath) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/')) return null;

  const clean = urlPath.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return null; // битая процентная последовательность — не наш файл
  }

  const target = path.resolve(PUBLIC_DIR, `.${decoded}`);
  return target.startsWith(PUBLIC_DIR + path.sep) ? target : null;
}

/** Метка файла по адресу из разметки: '?v=a1b2c3d4' или '' , если файла нет. */
function query(urlPath) {
  const file = resolvePublic(urlPath);
  if (!file) return '';

  const version = versionOf(file);
  return version ? `?v=${version}` : '';
}

/** Проставляет метки во все ссылки на /css/… и /js/… в готовой разметке. */
function stamp(html) {
  return String(html).replace(ASSET_REF, (match, attribute, url) => `${attribute}="${url}${query(url)}"`);
}

/** Метка из запроса указывает ровно на то содержимое, которое сейчас лежит в файле? */
function isCurrent(file, value) {
  if (typeof value !== 'string' || !VERSION_VALUE.test(value)) return false;
  return value === versionOf(file);
}

// ------------------------------------------------------------- заголовки

/**
 * Cache-Control для express.static. Вызывается только для существующих файлов —
 * путь приходит от самого express.static, проверять его на выход за public/ не нужно.
 */
function setStaticHeaders(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();

  // HTML не кэшируется никогда: он и есть источник актуальных меток.
  if (extension === '.html') {
    res.setHeader('Cache-Control', NO_CACHE);
    return;
  }

  // Картинки и шрифты остаются на maxAge из express.static.
  if (!VERSIONED.has(extension)) return;

  const requested = res.req && res.req.query ? res.req.query.v : undefined;
  res.setHeader('Cache-Control', isCurrent(filePath, requested) ? IMMUTABLE : NO_CACHE);
}

// --------------------------------------------------------------- разметка

const templates = new Map();

/**
 * Содержимое HTML-файла с проставленными метками. Читается с диска один раз
 * (в режиме --watch — каждый раз). null — файла нет.
 *
 * Кэшируются только успешные чтения: иначе запросами к несуществующим адресам
 * можно было бы наращивать эту таблицу до бесконечности.
 */
function template(file) {
  if (!WATCH_MODE && templates.has(file)) return templates.get(file);

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Версия статики: не удалось прочитать разметку ${file} (${error.message}).`);
    }
    return null;
  }

  const html = stamp(raw);
  templates.set(file, html);
  return html;
}

/** Готовая страница из public/ по адресу запроса. null — это не наш HTML. */
function page(urlPath) {
  const file = resolvePublic(urlPath);
  if (!file || path.extname(file).toLowerCase() !== '.html') return null;
  return template(file);
}

/** Все .html внутри public/ (страниц три, но перечислять их в коде незачем). */
function* htmlFilesIn(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return;
  }

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* htmlFilesIn(full);
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.html') yield full;
  }
}

/**
 * Прогрев при старте: читаем и размечаем все статические страницы, попутно считая
 * хэши всей статики, на которую они ссылаются. К первому запросу диск уже не нужен.
 * @returns {number} сколько страниц разобрано — печатается в лог запуска
 */
function preload() {
  let count = 0;
  for (const file of htmlFilesIn(PUBLIC_DIR)) {
    if (template(file) !== null) count += 1;
  }
  return count;
}

module.exports = {
  publicDir: PUBLIC_DIR,
  watchMode: WATCH_MODE,
  fileVersion,
  versionOf,
  query,
  stamp,
  isCurrent,
  setStaticHeaders,
  template,
  page,
  preload,
};
