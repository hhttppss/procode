'use strict';

/**
 * Дочерний процесс для tests/db-transaction.test.js.
 *
 *   node tests/helpers/db-runner.js <путь к db.js>
 *
 * Зачем отдельный процесс: server/db.js выбирает движок один раз при подключении,
 * а очередь, кэши коллекций и реестр живут в переменных модуля. Прогнать в одном
 * процессе два движка (или дважды один и тот же набор коллекций) нельзя даже через
 * delete require.cache — better-sqlite3 останется с открытым соединением, а повторное
 * db.collection('tst_notes') сразу бросит «коллекция уже объявлена».
 *
 * Сам ничего не проверяет: выполняет сценарии и печатает отчёт строкой RESULT:<json>.
 * Все assert — в родительском тесте, там же и понятные сообщения об ошибках.
 */

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Не указан путь к модулю db.js');
  process.exit(2);
}

const db = require(dbPath);

const PARALLEL = 20;

/** Нормализация как в моделях приложения: запись без title отбрасывается. */
function normalize(record) {
  if (!record || typeof record !== 'object') return null;

  const title = db.asText(record.title, 120);
  if (!title) return null;

  return {
    id: record.id,
    title,
    amount: db.asInt(record.amount, 0),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const notes = db.collection('tst_notes', { normalize, prefix: 'nt' });
const tags = db.collection('tst_tags', { normalize, prefix: 'tg' });

const report = { engine: db.engine };

async function seed() {
  await notes.init();
  await tags.init();

  const created = await notes.create({ title: 'исходная запись', amount: 100 });
  report.seed = {
    id: created.id,
    notes: await notes.count(),
    tags: await tags.count(),
  };
}

/** (а) исключение внутри обработчика не должно менять данные ни в одной коллекции. */
async function rollback() {
  let message = null;

  try {
    await db.transaction(['tst_notes', 'tst_tags'], (tx) => {
      tx.tst_notes.insert({ title: 'запись из сорванной транзакции' });
      tx.tst_tags.insert({ title: 'метка из сорванной транзакции' });
      tx.tst_notes.update(report.seed.id, { amount: 999 });
      throw new Error('намеренный сбой внутри транзакции');
    });
  } catch (error) {
    message = error.message;
  }

  const seeded = await notes.getById(report.seed.id);
  report.rollback = {
    message,
    notes: await notes.count(),
    tags: await tags.count(),
    seedAmount: seeded ? seeded.amount : null,
    titles: (await notes.list()).map((item) => item.title),
  };
}

/** (б) успешная транзакция фиксирует изменения сразу во всех задействованных коллекциях. */
async function commit() {
  const result = await db.transaction(['tst_notes', 'tst_tags'], (tx) => {
    const note = tx.tst_notes.insert({ title: 'запись из транзакции', amount: 1 });
    const tag = tx.tst_tags.insert({ title: 'метка из транзакции' });

    // Правки внутри одной транзакции видны её же обработчику.
    tx.tst_notes.update(note.id, { amount: 7 });
    const removed = tx.tst_tags.remove('нет такого идентификатора');

    return {
      noteId: note.id,
      tagId: tag.id,
      seenInside: tx.tst_notes.getById(note.id).amount,
      listedInside: tx.tst_notes.list().length,
      removedMissing: removed,
    };
  });

  report.commit = {
    result,
    notes: await notes.count(),
    tags: await tags.count(),
    note: await notes.getById(result.noteId),
    tag: await tags.getById(result.tagId),
  };
}

/** Методы коллекции внутри транзакции встали бы в ту же очередь — это тупик, ловим ошибкой. */
async function guard() {
  let message = null;

  const returned = await db.transaction(['tst_notes'], (tx) => {
    void tx;
    // .catch вешаем сразу: иначе отклонённый промис останется необработанным и уронит процесс.
    notes.create({ title: 'нельзя изнутри транзакции' }).catch((error) => {
      message = error.message;
    });
    return 'обработчик отработал';
  });

  await new Promise((resolve) => setImmediate(resolve));
  report.guard = { message, returned, notes: await notes.count() };
}

/** (в) параллельные create не должны терять записи: общая очередь их сериализует. */
async function parallel() {
  const before = await notes.count();

  const created = await Promise.all(
    Array.from({ length: PARALLEL }, (unused, index) =>
      notes.create({ title: `параллельная ${index + 1}`, amount: index })
    )
  );

  const items = await notes.list();
  const landed = items.filter((item) => item.title.startsWith('параллельная'));

  report.parallel = {
    requested: PARALLEL,
    created: created.length,
    before,
    total: items.length,
    uniqueIds: new Set(items.map((item) => item.id)).size,
    landed: landed.length,
    distinctTitles: new Set(landed.map((item) => item.title)).size,
  };
}

async function main() {
  await seed();
  await rollback();
  await commit();
  await guard();
  await parallel();

  report.final = {
    notes: await notes.count(),
    tags: await tags.count(),
  };

  // stdout здесь — канал (pipe), Node пишет в него UTF-8 независимо от кодовой
  // страницы консоли, а родитель читает с encoding: 'utf8'. Кириллица доедет.
  console.log(`RESULT:${JSON.stringify(report)}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
