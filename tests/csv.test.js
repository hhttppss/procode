'use strict';

/**
 * server/routes/api/applications.js — экранирование выгрузки заявок в CSV.
 *
 * Файл открывают в Excel, а Excel исполняет содержимое ячейки, начинающееся с = @ + −.
 * Значения приходят из формы на лендинге, то есть от постороннего человека, — поэтому
 * тут проверяется именно граница «данные, а не формула», плюс кавычки и пустые значения.
 *
 * Подключение модуля роутера безопасно: модели только объявляют коллекции (db.collection),
 * ни один файл в data/ при require не читается и не создаётся — это проверяется тестом ниже.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const dataBefore = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR).sort() : null;

const { csvCell, buildCsv, formatDateTime } = require('../server/routes/api/applications');

const HEADERS = [
  'Дата заявки',
  'Родитель',
  'Телефон',
  'Email',
  'Ребёнок',
  'Возраст',
  'Направление',
  'Комментарий родителя',
  'Статус',
  'Комментарий менеджера',
  'Обновлено',
  'Источник',
  'ID',
];

test('подключение модуля не трогает data/', () => {
  const dataAfter = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR).sort() : null;
  assert.deepEqual(dataAfter, dataBefore, 'require роутера не должен создавать файлы хранилища');
});

test('обычные значения только заключаются в кавычки', () => {
  assert.equal(csvCell('Иванова Мария'), '"Иванова Мария"');
  assert.equal(csvCell('Python для детей'), '"Python для детей"');
  assert.equal(csvCell('mail@example.com'), '"mail@example.com"');
  assert.equal(csvCell(12), '"12"');
  assert.equal(csvCell(0), '"0"');
  assert.equal(csvCell(''), '""');
});

test('null и undefined превращаются в пустую ячейку, а не роняют выгрузку', () => {
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(), '""');
  assert.equal(csvCell(false), '"false"');
  assert.equal(csvCell({ toString: () => 'объект' }), '"объект"');
});

test('формулы Excel гасятся апострофом', () => {
  assert.equal(csvCell('=SUM(1,1)'), `"'=SUM(1,1)"`);
  assert.equal(csvCell('=1+1'), `"'=1+1"`);
  assert.equal(csvCell('@cmd'), `"'@cmd"`);
  assert.equal(csvCell('+1+1'), `"'+1+1"`);
  assert.equal(csvCell('-1+1'), `"'-1+1"`);
  assert.equal(csvCell('\t=HYPERLINK("http://evil","клик")'), `"'\t=HYPERLINK(""http://evil"",""клик"")"`);
  assert.equal(csvCell('\r=1+1'), `"'\r=1+1"`);

  // Классическая атака через DDE: без апострофа Excel предложит запустить cmd.
  assert.equal(
    csvCell('=cmd|\' /C calc\'!A0'),
    `"'=cmd|' /C calc'!A0"`,
    'значение должно начинаться с апострофа, иначе Excel увидит формулу'
  );
});

test('телефон формулой не считается — но только в своей колонке', () => {
  // Второй аргумент csvCell — признак колонки «Телефон»; buildCsv ставит его только ей.
  assert.equal(csvCell('+79991234567', true), '"+79991234567"', 'ровно то, что кладёт в базу normalizePhone');
  assert.equal(csvCell('+7 999 123-45-67', true), '"+7 999 123-45-67"');
  assert.equal(csvCell('+7 (916) 555.11.22', true), '"+7 (916) 555.11.22"');

  // Номер с восьмёрки не начинается ни с «+», ни с «−», поэтому под правило не попадает нигде.
  assert.equal(csvCell('8 (916) 555-11-22'), '"8 (916) 555-11-22"');

  // Тот же номер в любой другой колонке — просто значение со знаком, гасим.
  assert.equal(csvCell('+7 999 123-45-67'), `"'+7 999 123-45-67"`);
});

test('свободный ввод из цифр и знаков гасится даже там, где похож на номер', () => {
  // «-1-1» — валидное вычитание: Excel показал бы −2 вместо того, что ввёл родитель.
  // В свободных колонках («Родитель», «Комментарий») это и есть закрытая дыра.
  assert.equal(csvCell('-1-1'), `"'-1-1"`);
  assert.equal(csvCell('--1'), `"'--1"`);
  assert.equal(csvCell('-1-1-1-1-1-1-1-1-1-1'), `"'-1-1-1-1-1-1-1-1-1-1"`, 'длина не делает из вычитания телефон');

  // И в колонке «Телефон» тоже: с минуса номер не начинается, а цифр для номера мало.
  assert.equal(csvCell('-1-1', true), `"'-1-1"`);
  assert.equal(csvCell('--1', true), `"'--1"`);
  assert.equal(csvCell('+1-1', true), `"'+1-1"`);

  // А как только появляется символ, которого в номере быть не может, — это снова формула.
  assert.equal(csvCell('+1*2', true), `"'+1*2"`);
  assert.equal(csvCell('-A1', true), `"'-A1"`);
});

test('кавычки внутри значения удваиваются', () => {
  assert.equal(csvCell('он сказал "да"'), '"он сказал ""да"""');
  assert.equal(csvCell('"'), '""""');
  assert.equal(csvCell('a"b"c'), '"a""b""c"');
  assert.equal(csvCell('=""'), `"'="""""`);
});

test('перевод строки и разделитель остаются внутри одной ячейки', () => {
  // Кавычки вокруг значения — единственное, что удерживает многострочный комментарий
  // родителя в одной ячейке и не даёт «;» разъехаться на колонки.
  assert.equal(csvCell('первая строка\nвторая строка'), '"первая строка\nвторая строка"');
  assert.equal(csvCell('цена; скидка'), '"цена; скидка"');
});

test('buildCsv: BOM, разделитель «;», CRLF и полный набор колонок', () => {
  const csv = buildCsv([]);

  assert.equal(csv.charCodeAt(0), 0xfeff, 'без BOM Excel с русской локалью читает файл как cp1251');

  const body = csv.slice(1);
  assert.ok(body.endsWith('\r\n'), 'строки разделяются CRLF');

  const rows = body.split('\r\n').filter((row) => row !== '');
  assert.equal(rows.length, 1, 'без заявок в файле только заголовок');
  assert.deepEqual(
    rows[0].split(';'),
    HEADERS.map((title) => `"${title}"`)
  );
});

test('buildCsv: строка заявки идёт в том же порядке, что и заголовки', () => {
  const item = {
    id: 'ap_test1',
    createdAt: '2025-08-01T09:05:00.000Z',
    updatedAt: '2025-08-02T18:40:00.000Z',
    parentName: 'Иванова Мария',
    phone: '+7 999 123-45-67',
    email: 'maria@example.com',
    childName: 'Иван',
    childAge: 9,
    course: 'Scratch',
    comment: 'Хотим "по вторникам"; можно вечером',
    managerComment: null,
    status: 'new',
    source: '=WEBSERVICE("http://evil")',
  };

  const rows = buildCsv([item]).slice(1).split('\r\n').filter((row) => row !== '');
  assert.equal(rows.length, 2);

  const cells = rows[1].split(';');
  assert.equal(cells.length, HEADERS.length + 1, 'точка с запятой внутри комментария даёт лишний фрагмент');

  // Первая колонка — дата в поясе школы (config выставляет TZ=Europe/Moscow).
  assert.equal(cells[0], `"${formatDateTime(item.createdAt)}"`);
  assert.equal(cells[0], '"01.08.2025, 12:05"');
  assert.equal(cells[1], '"Иванова Мария"');
  assert.equal(cells[2], '"+7 999 123-45-67"');
  assert.equal(cells[3], '"maria@example.com"');
  assert.equal(cells[4], '"Иван"');
  assert.equal(cells[5], '"9"');
  assert.equal(cells[6], '"Scratch"');
  // Комментарий с «;» и кавычками: экранирование должно вернуть его целиком.
  assert.equal(`${cells[7]};${cells[8]}`, '"Хотим ""по вторникам""; можно вечером"');
  assert.equal(cells[9], '"Новая"', 'статус выгружается человеческой подписью из справочника');
  assert.equal(cells[10], '""', 'пустой комментарий менеджера — пустая ячейка');
  assert.equal(cells[11], '"02.08.2025, 21:40"');
  assert.equal(cells[12], `"'=WEBSERVICE(""http://evil"")"`, 'источник тоже приходит извне и тоже гасится');
  assert.equal(cells[13], '"ap_test1"');
});

test('buildCsv: послабление для номера действует только в колонке «Телефон»', () => {
  // Одно и то же значение во всех текстовых полях: проверяем, какая колонка его пропустит.
  const attack = '-1-1';
  const rows = buildCsv([
    {
      id: attack,
      createdAt: '2025-08-01T09:05:00.000Z',
      updatedAt: '2025-08-01T09:05:00.000Z',
      parentName: attack,
      phone: '+79991234567',
      email: attack,
      childName: attack,
      childAge: null,
      course: attack,
      comment: attack,
      managerComment: attack,
      status: 'new',
      source: attack,
    },
  ])
    .slice(1)
    .split('\r\n')
    .filter((row) => row !== '');

  const cells = rows[1].split(';');
  assert.equal(cells.length, HEADERS.length);
  assert.equal(cells[HEADERS.indexOf('Телефон')], '"+79991234567"', 'телефон остаётся как есть');

  const freeText = [
    'Родитель',
    'Email',
    'Ребёнок',
    'Направление',
    'Комментарий родителя',
    'Комментарий менеджера',
    'Источник',
    'ID',
  ];
  for (const title of freeText) {
    assert.equal(cells[HEADERS.indexOf(title)], `"'${attack}"`, `колонка «${title}» обязана гасить формулу`);
  }
});

test('buildCsv: пустой возраст и битая дата не ломают строку', () => {
  const rows = buildCsv([
    {
      id: 'ap_test2',
      createdAt: 'не дата',
      updatedAt: '',
      parentName: '',
      phone: '',
      email: '',
      childName: '',
      childAge: null,
      course: '',
      comment: '',
      managerComment: '',
      status: 'неизвестный',
      source: '',
    },
  ])
    .slice(1)
    .split('\r\n')
    .filter((row) => row !== '');

  const cells = rows[1].split(';');
  assert.equal(cells.length, HEADERS.length);
  assert.equal(cells[0], '""', 'нераспознанная дата — пустая ячейка, а не Invalid Date');
  assert.equal(cells[5], '""', 'возраст null — пустая ячейка, а не «null»');
  assert.equal(cells[8], '"неизвестный"', 'неизвестный статус печатается своим идентификатором');
  assert.equal(cells[10], '""', 'пустая дата обновления — пустая ячейка');
  assert.equal(cells[12], '"ap_test2"');
});
