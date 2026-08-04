'use strict';

/**
 * Минимальный, но корректный писатель и читатель ZIP на встроенном zlib.
 *
 * Зачем свой: в проекте по зависимостям только better-sqlite3, compression и express
 * (см. package.json). Тянуть archiver/adm-zip ради двух служебных скриптов незачем,
 * а формат ZIP в объёме «deflate + central directory» — это пара сотен строк.
 *
 * Что поддерживается:
 *  • методы 0 (store) и 8 (deflate-raw);
 *  • имена в UTF-8 с флагом 11 в general purpose bit flag — русские имена файлов
 *    читаются и «Проводником», и unzip;
 *  • каталоги (запись с именем, оканчивающимся на «/»).
 *
 * Чего нет намеренно:
 *  • Zip64 — вместо молчаливой порчи архива при выходе за 4 ГБ / 65535 записей
 *    бросается понятная ошибка (для data/ школы это заведомо недостижимо);
 *  • шифрование, многотомные архивы, кодировка cp437 в именах;
 *  • потоковая запись: каждый файл сжимается в память целиком, но по одному —
 *    в памяти одновременно живёт максимум один файл, а не весь архив.
 *
 * Читатель разбирает именно central directory, а не сканирует локальные заголовки:
 * central directory — единственная авторитетная опись архива, по локальным заголовкам
 * нельзя отличить настоящую запись от удалённой или от байтов внутри данных.
 * CRC32 каждой распакованной записи сверяется обязательно — это и есть проверка
 * целостности бэкапа перед восстановлением.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;

// Ограничения обычного (не Zip64) ZIP: счётчики записей 2 байта, размеры и смещения — 4.
const MAX_ENTRIES = 0xffff;
const MAX_UINT32 = 0xffffffff;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

// DOS-время не умеет годы до 1980 — файлы с более ранней меткой пишем как 1980-01-01.
const DOS_EPOCH = new Date(1980, 0, 1, 0, 0, 0);

// --------------------------------------------------------------------- CRC32

/** Таблица CRC-32 (полином 0xEDB88320) считается один раз при загрузке модуля. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** @returns {number} CRC-32 буфера как беззнаковое 32-битное число. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------ имена

/**
 * Проверка имени записи. Вызывается и при записи, и при чтении.
 *
 * При чтении это защита от zip slip: архив — внешние данные, и запись с именем
 * «../../server/index.js» или «C:\Windows\…» распаковалась бы мимо целевой папки.
 * Отвергаем такие записи ошибкой, а не «чиним» имя молча: подозрительный архив
 * лучше не восстанавливать вовсе.
 */
function assertSafeEntryName(name) {
  if (typeof name !== 'string' || name === '') {
    throw new Error('Пустое имя записи в архиве.');
  }
  if (name.includes('\0')) {
    throw new Error(`Имя записи «${name}» содержит нулевой байт.`);
  }
  if (name.includes('\\')) {
    throw new Error(`Имя записи «${name}» содержит обратный слэш — в ZIP разделитель только «/».`);
  }
  if (name.startsWith('/')) {
    throw new Error(`Имя записи «${name}» абсолютное — распаковка запрещена.`);
  }
  if (/^[a-zA-Z]:/.test(name)) {
    throw new Error(`Имя записи «${name}» начинается с буквы диска — распаковка запрещена.`);
  }
  // Двоеточие где угодно, а не только в позиции диска: на NTFS «файл.txt:поток» — это
  // альтернативный поток данных (ADS). Такой путь проходит проверку «остались внутри
  // папки», но пишет скрытые данные внутрь чужого файла. Создать файл с двоеточием
  // в имени Windows всё равно не даёт, так что законный бэкап это не затронет.
  if (name.includes(':')) {
    throw new Error(`Имя записи «${name}» содержит «:» — распаковка запрещена (поток NTFS).`);
  }
  if (name.split('/').includes('..')) {
    throw new Error(`Имя записи «${name}» выходит за пределы архива (..) — распаковка запрещена.`);
  }
  if (Buffer.byteLength(name, 'utf8') > 0xffff) {
    throw new Error(`Имя записи слишком длинное (${name.slice(0, 60)}…).`);
  }
  return name;
}

/** Путь ОС → имя внутри архива: только прямые слэши, иначе на Windows архив ломается. */
function toArchiveName(relativePath) {
  return relativePath.split(path.sep).join('/');
}

/** Целевой путь распаковки с повторной проверкой, что он не уехал из targetDir. */
function resolveInside(targetDir, name) {
  const root = path.resolve(targetDir);
  const full = path.resolve(root, name);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`Запись «${name}» распаковалась бы за пределы ${root} — архив отклонён.`);
  }
  return full;
}

// ------------------------------------------------------------ дата и время

function toDosDateTime(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const safe = date < DOS_EPOCH ? DOS_EPOCH : date;

  const time =
    (safe.getHours() << 11) | (safe.getMinutes() << 5) | Math.floor(safe.getSeconds() / 2);
  const day = ((safe.getFullYear() - 1980) << 9) | ((safe.getMonth() + 1) << 5) | safe.getDate();

  return { time: time & 0xffff, date: day & 0xffff };
}

function fromDosDateTime(time, date) {
  const year = 1980 + ((date >> 9) & 0x7f);
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  const hours = (time >> 11) & 0x1f;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;

  const parsed = new Date(year, month, day, hours, minutes, seconds);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

// ------------------------------------------------------------------ запись

/**
 * Писатель архива. Файлы добавляются по одному, смещения считаются на лету,
 * central directory и EOCD дописываются в close().
 *
 * @param {string} destPath путь создаваемого .zip
 */
function createZipWriter(destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const fd = fs.openSync(destPath, 'w');
  const entries = [];
  let offset = 0;
  let closed = false;

  function write(buffer) {
    let written = 0;
    while (written < buffer.length) {
      written += fs.writeSync(fd, buffer, written, buffer.length - written);
    }
    offset += buffer.length;
  }

  function assertOpen() {
    if (closed) throw new Error('Архив уже закрыт — добавлять записи нельзя.');
  }

  function addRecord(rawName, payload, mtime, isDirectory) {
    assertOpen();
    const name = assertSafeEntryName(isDirectory ? `${rawName.replace(/\/+$/, '')}/` : rawName);

    if (entries.length >= MAX_ENTRIES) {
      throw new Error(
        `В архиве уже ${MAX_ENTRIES} записей — больше обычный ZIP не адресует. ` +
          'Разбейте бэкап на части или используйте режим папки (--dir).'
      );
    }

    const data = isDirectory ? Buffer.alloc(0) : payload;
    if (data.length > MAX_UINT32) {
      throw new Error(`Файл «${name}» больше 4 ГБ — обычный ZIP такой размер не адресует (нужен Zip64).`);
    }

    const crc = isDirectory ? 0 : crc32(data);

    // Уже сжатые данные (SQLite с картинками, архивы) от deflate только растут —
    // в таком случае кладём как есть, метод store.
    let method = METHOD_STORE;
    let body = data;
    if (!isDirectory && data.length > 0) {
      const deflated = zlib.deflateRawSync(data);
      if (deflated.length < data.length) {
        method = METHOD_DEFLATE;
        body = deflated;
      }
    }

    if (body.length > MAX_UINT32) {
      throw new Error(`Сжатый размер «${name}» больше 4 ГБ — нужен Zip64.`);
    }

    const nameBuffer = Buffer.from(name, 'utf8');
    // Флаг UTF-8 ставим только для нелатинских имён: для ASCII он не нужен,
    // а некоторые старые распаковщики на него реагируют хуже, чем на его отсутствие.
    const flags = nameBuffer.length === name.length ? 0 : FLAG_UTF8;
    const { time, date } = toDosDateTime(mtime);

    const headerOffset = offset;
    if (headerOffset > MAX_UINT32) {
      throw new Error('Архив превысил 4 ГБ — обычный ZIP такие смещения не адресует (нужен Zip64).');
    }

    const header = Buffer.alloc(LOCAL_HEADER_SIZE);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4); // минимальная версия распаковщика: 2.0 (deflate)
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(0, 28); // extra field не используем

    write(header);
    write(nameBuffer);
    if (body.length > 0) write(body);

    entries.push({
      name,
      nameBuffer,
      flags,
      method,
      time,
      date,
      crc,
      compressedSize: body.length,
      size: data.length,
      headerOffset,
      isDirectory,
    });

    return { name, size: data.length, compressedSize: body.length, method };
  }

  return {
    /** Добавляет файл с диска. Читается целиком в память — по одному файлу за раз. */
    addFile(archiveName, sourcePath, mtime) {
      const stat = fs.statSync(sourcePath);
      return addRecord(toArchiveName(archiveName), fs.readFileSync(sourcePath), mtime || stat.mtime, false);
    },

    /** Добавляет запись из буфера или строки — для манифеста, который не лежит на диске. */
    addBuffer(archiveName, contents, mtime) {
      const data = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
      return addRecord(toArchiveName(archiveName), data, mtime || new Date(), false);
    },

    /** Добавляет пустой каталог: без него пустая папка из бэкапа не восстановится. */
    addDirectory(archiveName, mtime) {
      return addRecord(toArchiveName(archiveName), Buffer.alloc(0), mtime || new Date(), true);
    },

    /** Дописывает central directory и EOCD. @returns {{entries:number, bytes:number}} */
    close() {
      if (closed) throw new Error('Архив уже закрыт.');

      try {
        const centralOffset = offset;

        for (const entry of entries) {
          const record = Buffer.alloc(CENTRAL_HEADER_SIZE);
          record.writeUInt32LE(SIG_CENTRAL, 0);
          // «Версия создателя»: старший байт 0 = MS-DOS, значит внешние атрибуты — DOS-овские.
          record.writeUInt16LE(20, 4);
          record.writeUInt16LE(20, 6);
          record.writeUInt16LE(entry.flags, 8);
          record.writeUInt16LE(entry.method, 10);
          record.writeUInt16LE(entry.time, 12);
          record.writeUInt16LE(entry.date, 14);
          record.writeUInt32LE(entry.crc, 16);
          record.writeUInt32LE(entry.compressedSize, 20);
          record.writeUInt32LE(entry.size, 24);
          record.writeUInt16LE(entry.nameBuffer.length, 28);
          record.writeUInt16LE(0, 30); // extra
          record.writeUInt16LE(0, 32); // comment
          record.writeUInt16LE(0, 34); // номер диска
          record.writeUInt16LE(0, 36); // внутренние атрибуты
          record.writeUInt32LE(entry.isDirectory ? 0x10 : 0x20, 38); // DOS: directory / archive
          record.writeUInt32LE(entry.headerOffset, 42);

          write(record);
          write(entry.nameBuffer);
        }

        const centralSize = offset - centralOffset;
        if (centralOffset > MAX_UINT32 || centralSize > MAX_UINT32) {
          throw new Error('Опись архива не помещается в обычный ZIP — нужен Zip64.');
        }

        const eocd = Buffer.alloc(EOCD_SIZE);
        eocd.writeUInt32LE(SIG_EOCD, 0);
        eocd.writeUInt16LE(0, 4);
        eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(entries.length, 8);
        eocd.writeUInt16LE(entries.length, 10);
        eocd.writeUInt32LE(centralSize, 12);
        eocd.writeUInt32LE(centralOffset, 16);
        eocd.writeUInt16LE(0, 20); // комментарий архива

        write(eocd);

        // fsync перед закрытием: бэкап должен пережить внезапную перезагрузку,
        // иначе «успешно создан» окажется пустым файлом в кэше файловой системы.
        fs.fsyncSync(fd);
        return { entries: entries.length, bytes: offset };
      } finally {
        closed = true;
        fs.closeSync(fd);
      }
    },

    /** Аварийное закрытие: файл остаётся недописанным, вызывающий код его удаляет. */
    abort() {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
    },
  };
}

// ------------------------------------------------------------------ чтение

function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const chunk = fs.readSync(fd, buffer, read, length - read, position + read);
    if (chunk === 0) {
      throw new Error('Архив обрывается раньше, чем указано в его описи — файл повреждён.');
    }
    read += chunk;
  }
  return buffer;
}

/** Ищет EOCD с конца файла: после него может быть только комментарий (до 64 КБ). */
function findEndOfCentralDirectory(fd, fileSize) {
  if (fileSize < EOCD_SIZE) {
    throw new Error('Файл слишком мал, чтобы быть ZIP-архивом.');
  }

  const tailLength = Math.min(fileSize, 0xffff + EOCD_SIZE);
  const tail = readExact(fd, tailLength, fileSize - tailLength);

  for (let index = tail.length - EOCD_SIZE; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== SIG_EOCD) continue;

    const commentLength = tail.readUInt16LE(index + 20);
    if (index + EOCD_SIZE + commentLength !== tail.length) continue;

    // Локатор Zip64 стоит непосредственно перед EOCD. Такие архивы мы не пишем
    // и не читаем — честнее отказать, чем разобрать первые 4 ГБ и потерять остальное.
    if (index >= 20 && tail.readUInt32LE(index - 20) === SIG_ZIP64_LOCATOR) {
      throw new Error('Архив в формате Zip64 — этот распаковщик его не поддерживает.');
    }

    return {
      entries: tail.readUInt16LE(index + 10),
      centralSize: tail.readUInt32LE(index + 12),
      centralOffset: tail.readUInt32LE(index + 16),
    };
  }

  throw new Error('Не найдена опись архива (EOCD) — файл повреждён или это не ZIP.');
}

/**
 * Разбирает central directory архива.
 * @returns {{entries: Array<object>, close: Function}} записи и закрытие дескриптора
 */
function openZip(zipPath) {
  const fd = fs.openSync(zipPath, 'r');

  try {
    const fileSize = fs.fstatSync(fd).size;
    const eocd = findEndOfCentralDirectory(fd, fileSize);

    if (eocd.centralOffset + eocd.centralSize > fileSize) {
      throw new Error('Опись архива указывает за пределы файла — архив обрезан.');
    }

    const central = readExact(fd, eocd.centralSize, eocd.centralOffset);
    const entries = [];
    let cursor = 0;

    for (let index = 0; index < eocd.entries; index += 1) {
      if (cursor + CENTRAL_HEADER_SIZE > central.length) {
        throw new Error(`Опись архива обрывается на записи ${index + 1} из ${eocd.entries}.`);
      }
      if (central.readUInt32LE(cursor) !== SIG_CENTRAL) {
        throw new Error(`Повреждён заголовок записи ${index + 1} в описи архива.`);
      }

      const flags = central.readUInt16LE(cursor + 8);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const nameStart = cursor + CENTRAL_HEADER_SIZE;

      if (nameStart + nameLength > central.length) {
        throw new Error(`Имя записи ${index + 1} выходит за пределы описи архива.`);
      }

      if (flags & FLAG_ENCRYPTED) {
        throw new Error('Архив зашифрован — восстановление невозможно.');
      }

      const name = central.toString('utf8', nameStart, nameStart + nameLength);
      assertSafeEntryName(name);

      entries.push({
        name,
        method: central.readUInt16LE(cursor + 10),
        crc: central.readUInt32LE(cursor + 16) >>> 0,
        compressedSize: central.readUInt32LE(cursor + 20),
        size: central.readUInt32LE(cursor + 24),
        headerOffset: central.readUInt32LE(cursor + 42),
        mtime: fromDosDateTime(central.readUInt16LE(cursor + 12), central.readUInt16LE(cursor + 14)),
        isDirectory: name.endsWith('/'),
      });

      cursor = nameStart + nameLength + extraLength + commentLength;
    }

    /** Распаковывает одну запись и сверяет CRC32 и размер с описью. */
    function readEntry(entry) {
      if (entry.isDirectory) return Buffer.alloc(0);

      const local = readExact(fd, LOCAL_HEADER_SIZE, entry.headerOffset);
      if (local.readUInt32LE(0) !== SIG_LOCAL) {
        throw new Error(`Запись «${entry.name}»: повреждён локальный заголовок.`);
      }

      // Длины имени и extra в локальном заголовке могут отличаться от описи —
      // начало данных считаем именно по локальному заголовку.
      const dataOffset =
        entry.headerOffset + LOCAL_HEADER_SIZE + local.readUInt16LE(26) + local.readUInt16LE(28);

      if (dataOffset + entry.compressedSize > fileSize) {
        throw new Error(`Запись «${entry.name}» выходит за пределы архива — файл обрезан.`);
      }

      const raw = readExact(fd, entry.compressedSize, dataOffset);

      let data;
      if (entry.method === METHOD_STORE) {
        data = raw;
      } else if (entry.method === METHOD_DEFLATE) {
        try {
          data = zlib.inflateRawSync(raw);
        } catch (error) {
          throw new Error(`Запись «${entry.name}» не распаковывается: ${error.message}`);
        }
      } else {
        throw new Error(`Запись «${entry.name}»: метод сжатия ${entry.method} не поддерживается.`);
      }

      if (data.length !== entry.size) {
        throw new Error(
          `Запись «${entry.name}»: размер после распаковки ${data.length} Б вместо ${entry.size} Б.`
        );
      }

      const actual = crc32(data);
      if (actual !== entry.crc) {
        throw new Error(
          `Запись «${entry.name}»: контрольная сумма не совпала ` +
            `(${actual.toString(16)} вместо ${entry.crc.toString(16)}) — архив повреждён.`
        );
      }

      return data;
    }

    return {
      entries,
      readEntry,
      close() {
        fs.closeSync(fd);
      },
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/**
 * Читает и сверяет CRC каждой записи, ничего не записывая на диск.
 * @returns {{entries:number, bytes:number}}
 */
function verifyZip(zipPath, onEntry) {
  const archive = openZip(zipPath);
  try {
    let bytes = 0;
    for (const entry of archive.entries) {
      const data = archive.readEntry(entry);
      bytes += data.length;
      if (onEntry) onEntry(entry);
    }
    return { entries: archive.entries.length, bytes };
  } finally {
    archive.close();
  }
}

/**
 * Распаковывает архив в targetDir. CRC каждой записи проверяется по дороге,
 * поэтому отдельная проверка целостности не нужна: битый архив упадёт здесь.
 *
 * @returns {Array<{name:string, size:number}>} распакованные файлы
 */
function extractZip(zipPath, targetDir, onEntry) {
  const archive = openZip(zipPath);
  const written = [];

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    for (const entry of archive.entries) {
      const full = resolveInside(targetDir, entry.name);

      if (entry.isDirectory) {
        fs.mkdirSync(full, { recursive: true });
        continue;
      }

      const data = archive.readEntry(entry);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, data);
      try {
        fs.utimesSync(full, entry.mtime, entry.mtime);
      } catch {
        // Метка времени — украшение отчёта, а не данные. Не смогли — не беда.
      }

      written.push({ name: entry.name, size: data.length, path: full });
      if (onEntry) onEntry(entry);
    }

    return written;
  } finally {
    archive.close();
  }
}

module.exports = {
  crc32,
  createZipWriter,
  openZip,
  verifyZip,
  extractZip,
  assertSafeEntryName,
  toArchiveName,
};
