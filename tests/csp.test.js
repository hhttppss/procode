'use strict';

/**
 * Политика безопасности контента (server/csp.js) и её связка со сборкой страниц платформы.
 *
 * Почему это покрыто тестами: ошибка здесь не видна ни на глаз, ни в логах сервера.
 * Забытый хэш инлайнового блока или потерянный nonce ломает страницу только в браузере
 * посетителя — сервер продолжает отдавать 200. А обратная ошибка (случайно вернувшийся
 * 'unsafe-inline') не ломает вообще ничего и потому живёт годами, отменяя всю защиту.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const csp = require('../server/csp');
const render = require('../server/views/render');

const INDEX_FILE = path.join(__dirname, '..', 'public', 'index.html');

/** Эталонный хэш «как посчитал бы браузер»: от текста скрипта, каким он попадает в DOM. */
function sha256(text) {
  return `sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

const USER = {
  id: 'us_test',
  login: 'tester',
  role: 'admin',
  name: 'Тест Тестов',
  phone: '',
  email: '',
  courses: [],
  active: true,
  createdAt: new Date(0).toISOString(),
  lastLoginAt: null,
};

// ------------------------------------------------------------------- хэши

test('inlineScriptHashes считает хэш ровно того текста, что стоит между тегами', () => {
  const html = '<head>\n<script type="application/ld+json">\n  {"a":1}\n</script>\n</head>';

  assert.deepEqual(csp.inlineScriptHashes(html), [sha256('\n  {"a":1}\n')]);
});

test('inlineScriptHashes пропускает внешние скрипты и не плодит дубли', () => {
  const html = `
    <script src="/js/landing.js" defer></script>
    <script>window.a = 1;</script>
    <script>window.a = 1;</script>
    <script async src="/js/form.js"></script>
  `;

  assert.deepEqual(csp.inlineScriptHashes(html), [sha256('window.a = 1;')], 'два одинаковых блока — один хэш');
});

test('inlineScriptHashes приводит CRLF к LF: иначе хэши не сойдутся на checkout с CRLF', () => {
  const unix = '<script>\nwindow.a = 1;\n</script>';
  const windows = '<script>\r\nwindow.a = 1;\r\n</script>';

  assert.deepEqual(csp.inlineScriptHashes(windows), csp.inlineScriptHashes(unix));
});

test('микроразметка лендинга разрешена хэшами', () => {
  const hashes = csp.inlineScriptHashes(fs.readFileSync(INDEX_FILE, 'utf8'));
  const policy = csp.policy('тест');

  assert.equal(hashes.length, 2, 'в index.html два инлайновых блока: EducationalOrganization и FAQPage');
  for (const hash of hashes) {
    assert.ok(policy.includes(`'${hash}'`), `политика не разрешает инлайновый блок лендинга (${hash})`);
  }
  assert.equal(csp.landingHashCount, hashes.length, 'хэши считаются при старте — счётчик обязан совпадать');
});

// ---------------------------------------------------------------- политика

test('в политике нет unsafe-inline и unsafe-eval', () => {
  const policy = csp.policy(csp.createNonce());

  assert.equal(policy.includes("'unsafe-inline'"), false, 'nonce и хэши существуют ровно ради этого');
  assert.equal(policy.includes("'unsafe-eval'"), false);
});

test('политика закрывает загрузку с чужих доменов и встраивание в чужой фрейм', () => {
  const policy = csp.policy('nonce123');
  const directives = new Map(
    policy.split('; ').map((item) => {
      const space = item.indexOf(' ');
      return [item.slice(0, space), item.slice(space + 1)];
    })
  );

  assert.equal(directives.get('default-src'), "'self'");
  assert.equal(directives.get('base-uri'), "'self'");
  assert.equal(directives.get('form-action'), "'self'");
  assert.equal(directives.get('object-src'), "'none'");
  assert.equal(directives.get('frame-ancestors'), "'none'");
  assert.equal(directives.get('frame-src'), "'none'");
  assert.equal(directives.get('worker-src'), "'none'");
  assert.equal(directives.get('style-src'), "'self'", 'инлайновых стилей в проекте не осталось');
  assert.equal(directives.get('font-src'), "'self'");
  assert.equal(directives.get('connect-src'), "'self'");
  assert.equal(directives.get('img-src'), "'self' data:", 'фоновые SVG в styles.css записаны как data:');
  assert.match(directives.get('script-src'), /^'self' 'nonce-nonce123'/);
});

test('nonce одноразовый: два вызова подряд дают разные значения', () => {
  const first = csp.createNonce();
  const second = csp.createNonce();

  assert.notEqual(first, second, 'постоянный nonce равносилен unsafe-inline — его скопирует и внедрённый скрипт');
  assert.ok(Buffer.from(first, 'base64').length >= 16, 'меньше 16 байт случайности брать нельзя');
});

// ------------------------------------------------- страницы платформы

test('страница платформы подставляет nonce в блок с данными сессии', async () => {
  const nonce = csp.createNonce();
  const html = await render.renderApp({
    user: USER,
    module: 'dashboard',
    view: 'dashboard',
    script: 'dashboard.js',
    title: 'Главная',
    nonce,
  });

  const inline = [...html.matchAll(/<script\b([^>]*)>/g)].map(([, attributes]) => attributes);
  const bootstrap = inline.filter((attributes) => !/\bsrc\s*=/.test(attributes));

  assert.equal(bootstrap.length, 1, 'инлайновый блок на странице платформы ровно один — с window.PC');
  assert.ok(bootstrap[0].includes(`nonce="${nonce}"`), 'без nonce браузер заблокирует данные сессии');
  assert.ok(csp.policy(nonce).includes(`'nonce-${nonce}'`), 'тот же nonce обязан быть в заголовке');
});

test('страницу платформы без nonce собрать нельзя', async () => {
  await assert.rejects(
    () => render.renderApp({ user: USER, module: 'dashboard', view: 'dashboard', title: 'Главная' }),
    /nonce/,
    'молчаливый пропуск обернулся бы пустой страницей у пользователя'
  );
});
