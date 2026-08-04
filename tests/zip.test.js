'use strict';

/**
 * scripts/lib/zip.js — самописный ZIP (deflate + central directory).
 *
 * Формат бинарный и написан руками, поэтому проверяем не «функция вызвалась», а то,
 * ради чего он существует: файл, положенный в архив, возвращается из него побайтово
 * тем же самым, а порча архива обнаруживается, а не подсовывает мусор вместо данных.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const zip = require('../scripts/lib/zip');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'procode-zip-'));

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** Отдельная рабочая папка на каждый тест: тесты не должны видеть чужие файлы. */
function workspace(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(root, relative, contents) {
  const full = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

/** Начало данных записи в файле архива: extra field писатель не использует. */
function dataOffsetOf(entry) {
  return entry.headerOffset + 30 + Buffer.byteLength(entry.name, 'utf8');
}

function flipByte(file, offset) {
  const buffer = fs.readFileSync(file);
  buffer[offset] ^= 0xff;
  fs.writeFileSync(file, buffer);
}

test('crc32 совпадает с эталонными значениями CRC-32/ISO-HDLC', () => {
  // Контрольные векторы стандарта: если таблица или порядок байт съедут, тест это увидит.
  assert.equal(zip.crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
  assert.equal(zip.crc32(Buffer.from('The quick brown fox jumps over the lazy dog', 'ascii')), 0x414fa339);
  assert.equal(zip.crc32(Buffer.alloc(0)), 0);
});

test('round-trip: архив распаковывается побайтово в исходное содержимое', () => {
  const dir = workspace('roundtrip');
  const source = path.join(dir, 'src');
  const target = path.join(dir, 'out');
  const archive = path.join(dir, 'backup.zip');

  // Набор специально разный: сжимаемый текст, нечитаемый как текст бинарник,
  // кириллица в имени и в содержимом, вложенность и пустой файл.
  const files = {
    'readme.txt': Buffer.from('Повторяющийся текст, который deflate сожмёт. '.repeat(200), 'utf8'),
    'Отчёт по ученикам.txt': Buffer.from('Иванов Иван — 5 занятий\nПётр Петров — 3 занятия\n', 'utf8'),
    'вложенная/папка/данные.bin': crypto.randomBytes(4096),
    'empty.txt': Buffer.alloc(0),
  };

  for (const [name, contents] of Object.entries(files)) writeFile(source, name, contents);

  const manifest = Buffer.from(JSON.stringify({ format: 'procode-backup/1', файлов: 4 }), 'utf8');
  const stamp = new Date(2025, 7, 1, 12, 34, 56);

  const writer = zip.createZipWriter(archive);
  for (const name of Object.keys(files)) {
    writer.addFile(name, path.join(source, ...name.split('/')), stamp);
  }
  writer.addBuffer('manifest.json', manifest, stamp);
  writer.addDirectory('пустая папка', stamp);
  const closed = writer.close();

  assert.equal(closed.entries, 6);
  assert.equal(closed.bytes, fs.statSync(archive).size);

  // --- опись архива
  const opened = zip.openZip(archive);
  try {
    const byName = new Map(opened.entries.map((entry) => [entry.name, entry]));

    assert.deepEqual(
      [...byName.keys()].sort(),
      [
        'manifest.json',
        'readme.txt',
        'empty.txt',
        'Отчёт по ученикам.txt',
        'вложенная/папка/данные.bin',
        'пустая папка/',
      ].sort()
    );

    // Метод выбирается по результату: текст сжался, случайные байты — нет.
    assert.equal(byName.get('readme.txt').method, 8, 'повторяющийся текст должен уйти в deflate');
    assert.ok(byName.get('readme.txt').compressedSize < byName.get('readme.txt').size);
    assert.equal(byName.get('вложенная/папка/данные.bin').method, 0, 'случайные байты должны лечь как есть');
    assert.equal(byName.get('вложенная/папка/данные.bin').size, 4096);
    assert.equal(byName.get('пустая папка/').isDirectory, true);

    // DOS-время: разрешение две секунды, 56 в него укладывается без округления.
    assert.equal(byName.get('manifest.json').mtime.getTime(), stamp.getTime());

    // readEntry сверяет CRC и размер сам — на исправном архиве не должен ругаться.
    assert.ok(opened.readEntry(byName.get('readme.txt')).equals(files['readme.txt']));
  } finally {
    opened.close();
  }

  // --- проверка целостности без записи на диск
  const verified = zip.verifyZip(archive);
  const totalBytes = Object.values(files).reduce((sum, buffer) => sum + buffer.length, 0) + manifest.length;
  assert.deepEqual(verified, { entries: 6, bytes: totalBytes });

  // --- распаковка
  const written = zip.extractZip(archive, target);
  assert.equal(written.length, 5, 'папка в список распакованных файлов не попадает');

  for (const [name, contents] of Object.entries(files)) {
    const restored = fs.readFileSync(path.join(target, ...name.split('/')));
    assert.ok(restored.equals(contents), `содержимое «${name}» изменилось при распаковке`);
  }

  assert.ok(fs.readFileSync(path.join(target, 'manifest.json')).equals(manifest));
  assert.equal(fs.existsSync(path.join(target, 'пустая папка')), true, 'пустая папка не восстановлена');
  assert.equal(fs.statSync(path.join(target, 'пустая папка')).isDirectory(), true);

  // Кириллица в имени доехала как есть, а не как «????» или mojibake.
  assert.equal(
    fs.readdirSync(target).includes('Отчёт по ученикам.txt'),
    true,
    `в распакованном каталоге: ${fs.readdirSync(target).join(', ')}`
  );
});

test('порча байта в данных: CRC не сходится, файл не распаковывается', () => {
  const dir = workspace('corrupt-data');
  const archive = path.join(dir, 'backup.zip');
  const target = path.join(dir, 'out');

  const payload = crypto.randomBytes(4096); // не сожмётся — ляжет методом store
  const writer = zip.createZipWriter(archive);
  writer.addBuffer('data/app.sqlite', payload);
  writer.close();

  const opened = zip.openZip(archive);
  const entry = opened.entries[0];
  opened.close();

  assert.equal(entry.method, 0, 'тест рассчитан на запись без сжатия');

  flipByte(archive, dataOffsetOf(entry) + 100);

  assert.throws(
    () => zip.verifyZip(archive),
    /контрольная сумма не совпала/,
    'verifyZip обязан заметить испорченный байт'
  );

  assert.throws(() => zip.extractZip(archive, target), /контрольная сумма не совпала/);
  assert.equal(
    fs.existsSync(path.join(target, 'data', 'app.sqlite')),
    false,
    'битая запись не должна оказаться на диске'
  );
});

test('порча сжатых данных ловится до записи, а не после', () => {
  const dir = workspace('corrupt-deflate');
  const archive = path.join(dir, 'backup.zip');
  const target = path.join(dir, 'out');

  const writer = zip.createZipWriter(archive);
  writer.addBuffer('students.json', Buffer.from('[{"id":"st_1","name":"Иван"}]\n'.repeat(300), 'utf8'));
  writer.close();

  const opened = zip.openZip(archive);
  const entry = opened.entries[0];
  opened.close();
  assert.equal(entry.method, 8, 'тест рассчитан на сжатую запись');

  flipByte(archive, dataOffsetOf(entry) + 10);

  // Битый поток deflate падает либо на распаковке, либо на CRC — тихо отдать мусор нельзя.
  assert.throws(() => zip.extractZip(archive, target), /не распаковывается|контрольная сумма не совпала|размер после распаковки/);
  assert.equal(fs.existsSync(path.join(target, 'students.json')), false);
});

test('обрезанный архив и не-ZIP отвергаются с понятной ошибкой', () => {
  const dir = workspace('broken');
  const archive = path.join(dir, 'backup.zip');

  const writer = zip.createZipWriter(archive);
  writer.addBuffer('users.json', Buffer.from('[]', 'utf8'));
  writer.close();

  // Отрезаем EOCD — так выглядит бэкап, не долитый до конца при обрыве копирования.
  const full = fs.readFileSync(archive);
  const truncated = path.join(dir, 'truncated.zip');
  fs.writeFileSync(truncated, full.subarray(0, full.length - 10));
  assert.throws(() => zip.verifyZip(truncated), /Не найдена опись архива/);

  const garbage = path.join(dir, 'garbage.zip');
  fs.writeFileSync(garbage, crypto.randomBytes(2048));
  assert.throws(() => zip.openZip(garbage), /Не найдена опись архива/);

  const tiny = path.join(dir, 'tiny.zip');
  fs.writeFileSync(tiny, Buffer.from('PK', 'ascii'));
  assert.throws(() => zip.openZip(tiny), /слишком мал/);
});

test('опасные имена записей не принимаются ни при записи, ни при чтении', () => {
  const dir = workspace('zip-slip');
  const archive = path.join(dir, 'backup.zip');

  const writer = zip.createZipWriter(archive);
  assert.throws(() => writer.addBuffer('../evil.txt', 'x'), /выходит за пределы архива/);
  assert.throws(() => writer.addBuffer('data/../../evil.txt', 'x'), /выходит за пределы архива/);
  assert.throws(() => writer.addBuffer('/etc/passwd', 'x'), /абсолютное/);
  assert.throws(() => writer.addBuffer('C:/Windows/evil.txt', 'x'), /букв(ы|ой) диска|содержит «:»/);
  assert.throws(() => writer.addBuffer('data/app.sqlite:поток', 'x'), /содержит «:»/);

  // Отвергнутые записи в архив не попали — писатель остался пригодным.
  writer.addBuffer('ok.txt', 'ok');
  assert.equal(writer.close().entries, 1);
  assert.deepEqual(zip.extractZip(archive, path.join(dir, 'out')).map((item) => item.name), ['ok.txt']);

  assert.throws(() => zip.assertSafeEntryName('a/../../b'), /выходит за пределы архива/);
  assert.throws(() => zip.assertSafeEntryName('a\\b'), /обратный слэш/);
  assert.throws(() => zip.assertSafeEntryName(''), /Пустое имя записи/);
});
