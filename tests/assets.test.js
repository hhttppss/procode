'use strict';

/**
 * Версионирование статики (server/assets.js) и заголовки кэширования.
 *
 * Почему это покрыто тестами: ошибка здесь не видна ни в логах, ни на машине
 * разработчика с пустым кэшем. Она проявляется у постороннего человека после выкладки —
 * новая разметка и старый styles.css из его кэша дают белый экран. Ровно это и случилось
 * однажды в бою. Второй сорт ошибок опаснее: `immutable` на файле без метки закрепит
 * старую версию у людей на год, и починить это с сервера будет уже нечем.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const assets = require('../server/assets');
const csp = require('../server/csp');
const render = require('../server/views/render');
const app = require('../server/index');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSIONED_LINK = /(?:href|src)="(\/(?:css|js)\/[^"]+)"/g;

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

/** Все ссылки на свои CSS и JS в разметке. */
function assetLinks(html) {
  return [...html.matchAll(VERSIONED_LINK)].map(([, url]) => url);
}

function versionIn(url) {
  const match = /[?&]v=([^&]*)$/.exec(url);
  return match ? match[1] : null;
}

// ------------------------------------------------------- метка по содержимому

test('метка — первые 8 hex-символов sha256 от содержимого файла', () => {
  const file = path.join(PUBLIC_DIR, 'css', 'styles.css');
  const expected = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8);

  assert.equal(assets.fileVersion(file), expected);
  assert.match(assets.fileVersion(file), /^[0-9a-f]{8}$/);
});

test('метка меняется от содержимого и не зависит от времени файла', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'procode-assets-'));
  const file = path.join(dir, 'sample.css');

  try {
    fs.writeFileSync(file, '.a{color:red}');
    const first = assets.fileVersion(file);

    // Выкладка через `git reset --hard` обновляет mtime у всех файлов подряд —
    // метка по времени заставила бы перекачивать и то, что не менялось.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    assert.equal(assets.fileVersion(file), first, 'от одного лишь mtime метка меняться не должна');

    fs.writeFileSync(file, '.a{color:blue}');
    assert.notEqual(assets.fileVersion(file), first, 'изменилось содержимое — обязана измениться метка');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('метки несуществующего файла нет, и разметка от этого не ломается', () => {
  assert.equal(assets.query('/css/нет-такого.css'), '');
  assert.equal(assets.stamp('<link href="/css/нет-такого.css">'), '<link href="/css/нет-такого.css">');
});

test('за пределы public/ метку не выдать', () => {
  assert.equal(assets.query('/css/../../.env'), '');
  assert.equal(assets.query('/js/../../server/config.js'), '');
  assert.equal(assets.page('/../server/views/layout.html'), null);
});

// -------------------------------------------------------------- подстановка

test('stamp размечает свои CSS и JS и не трогает остальное', () => {
  const html = [
    '<link rel="stylesheet" href="/css/styles.css">',
    '<script src="/js/landing.js" defer></script>',
    '<link rel="icon" href="/img/favicon.svg">',
    '<link rel="preload" as="font" href="/fonts/onest-cyrillic.woff2">',
    '<a href="https://example.com/css/other.css">чужое</a>',
    '<link rel="stylesheet" href="/css/styles.css?v=deadbeef">',
  ].join('\n');

  const stamped = assets.stamp(html);

  assert.match(stamped, /href="\/css\/styles\.css\?v=[0-9a-f]{8}"/);
  assert.match(stamped, /src="\/js\/landing\.js\?v=[0-9a-f]{8}"/);
  assert.ok(stamped.includes('href="/img/favicon.svg"'), 'картинки не версионируются');
  assert.ok(stamped.includes('href="/fonts/onest-cyrillic.woff2"'), 'шрифты не версионируются');
  assert.ok(stamped.includes('href="https://example.com/css/other.css"'), 'чужие домены не трогаем');
  assert.ok(stamped.includes('href="/css/styles.css?v=deadbeef"'), 'готовую строку запроса не переписываем');
});

test('в разметке лендинга все свои CSS и JS получили метку', () => {
  const html = assets.page('/index.html');
  const links = assetLinks(html);

  assert.ok(links.length >= 4, 'на лендинге подключены styles.css и три скрипта');
  for (const url of links) {
    assert.match(url, /\?v=[0-9a-f]{8}$/, `ссылка без метки: ${url}`);
  }
  assert.equal(versionIn(links.find((url) => url.startsWith('/css/'))), assets.fileVersion(path.join(PUBLIC_DIR, 'css', 'styles.css')));
});

test('оферта и политика тоже размечены', () => {
  for (const page of ['/oferta.html', '/privacy.html']) {
    const links = assetLinks(assets.page(page));
    assert.ok(links.length > 0, `${page}: ссылок на статику не нашлось — тест смотрит не туда`);
    for (const url of links) assert.match(url, /\?v=[0-9a-f]{8}$/, `${page}: ссылка без метки — ${url}`);
  }
});

test('страница платформы размечает и стили, и точку входа своего модуля', async () => {
  const html = await render.renderApp({
    user: USER,
    module: 'dashboard',
    view: 'dashboard',
    script: 'dashboard.js',
    title: 'Главная',
    nonce: csp.createNonce(),
  });

  const links = assetLinks(html);
  for (const url of links) assert.match(url, /\?v=[0-9a-f]{8}$/, `ссылка без метки: ${url}`);

  const entry = links.find((url) => url.startsWith('/js/crm/'));
  assert.ok(entry, 'на странице платформы должен быть модуль-точка входа');
  assert.equal(
    versionIn(entry),
    assets.fileVersion(path.join(PUBLIC_DIR, 'js', 'crm', 'dashboard.js')),
    'метка точки входа обязана совпадать с содержимым файла модуля'
  );
});

test('подстановка меток не меняет инлайновые блоки лендинга — CSP остаётся в силе', () => {
  const raw = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const stamped = assets.page('/index.html');

  assert.notEqual(stamped, raw, 'разметка обязана отличаться — иначе метки не проставились');
  assert.deepEqual(
    csp.inlineScriptHashes(stamped),
    csp.inlineScriptHashes(raw),
    'хэши считаются по файлу с диска: тронув инлайновый блок, мы выключили бы микроразметку'
  );

  const policy = csp.policy('test-nonce');
  for (const hash of csp.inlineScriptHashes(stamped)) {
    assert.ok(policy.includes(`'${hash}'`), `политика не разрешает блок отданной страницы (${hash})`);
  }
});

// ------------------------------------------------------------- HTTP-ответы

const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

after(() => server.close());

const CURRENT_CSS_VERSION = assets.fileVersion(path.join(PUBLIC_DIR, 'css', 'styles.css'));

test('лендинг отдаётся с метками и без кэша', async () => {
  const response = await fetch(`${base}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-cache', 'HTML — источник актуальных меток, кэшировать нельзя');
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(html, /href="\/css\/styles\.css\?v=[0-9a-f]{8}"/);
  assert.ok(response.headers.get('etag'), 'ETag нужен для пустого 304 при повторном заходе');
});

test('/index.html отдаётся так же, как /', async () => {
  const [root, direct] = await Promise.all([fetch(`${base}/`), fetch(`${base}/index.html`)]);

  assert.equal(direct.status, 200);
  assert.equal(direct.headers.get('cache-control'), 'no-cache');
  assert.equal(await direct.text(), await root.text(), 'прямой заход не должен обходить подстановку меток');
});

test('файл с верной меткой кэшируется навсегда', async () => {
  const response = await fetch(`${base}/css/styles.css?v=${CURRENT_CSS_VERSION}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(response.headers.get('content-type'), /text\/css/);
});

test('файл без метки по-прежнему ревалидируется', async () => {
  const response = await fetch(`${base}/css/styles.css`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-cache', 'старые ссылки и прямые заходы обязаны работать как раньше');
});

test('чужая, устаревшая или кривая метка не даёт вечного кэша', async () => {
  for (const value of ['deadbeef', 'ZZZZZZZZ', '', '1234567', `${CURRENT_CSS_VERSION}x`]) {
    const response = await fetch(`${base}/css/styles.css?v=${value}`);

    assert.equal(
      response.headers.get('cache-control'),
      'no-cache',
      `метка «${value}» не отвечает содержимому — закреплять такой ответ на год нельзя`
    );
  }
});

test('модуль платформы с меткой кэшируется, а его импорты ревалидируются', async () => {
  const version = assets.fileVersion(path.join(PUBLIC_DIR, 'js', 'crm', 'dashboard.js'));

  const entry = await fetch(`${base}/js/crm/dashboard.js?v=${version}`);
  const imported = await fetch(`${base}/js/crm/core.js`);

  assert.equal(entry.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(imported.headers.get('cache-control'), 'no-cache', 'относительным импортам метку не проставить');
});

test('картинкам и шрифтам оставлен прежний час', async () => {
  const image = await fetch(`${base}/img/favicon.svg`);
  const font = await fetch(`${base}/fonts/onest-cyrillic.woff2`);

  assert.equal(image.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(font.headers.get('cache-control'), 'public, max-age=3600');
});

test('страница входа размечена и не кэшируется', async () => {
  const response = await fetch(`${base}/login`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.match(html, /href="\/css\/styles\.css\?v=[0-9a-f]{8}"/);
  assert.match(html, /src="\/js\/login\.js\?v=[0-9a-f]{8}"/);
});

test('платформа без сессии по-прежнему уводит на вход', async () => {
  const response = await fetch(`${base}/app`, { redirect: 'manual' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login?next=%2Fapp');
});

test('заголовок CSP цел: nonce на месте, unsafe-inline не появился', async () => {
  const response = await fetch(`${base}/`);
  const policy = response.headers.get('content-security-policy');

  assert.ok(policy, 'без CSP страница отдаётся беззащитной');
  assert.equal(policy.includes("'unsafe-inline'"), false);
  assert.match(policy, /script-src 'self' 'nonce-[^']+'( 'sha256-[^']+')+/, 'nonce и хэши микроразметки обязаны остаться');

  for (const hash of csp.inlineScriptHashes(await response.text())) {
    assert.ok(policy.includes(`'${hash}'`), `инлайновый блок отданной страницы не разрешён политикой (${hash})`);
  }
});

test('страница 404 тоже ссылается на стили с меткой', async () => {
  const response = await fetch(`${base}/такой-страницы-нет`);

  assert.equal(response.status, 404);
  assert.match(await response.text(), /href="\/css\/styles\.css\?v=[0-9a-f]{8}"/);
});
