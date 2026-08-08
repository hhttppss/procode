'use strict';

/**
 * Дочерний процесс для tests/last-admin.test.js.
 *
 *   node tests/helpers/last-admin-runner.js
 *
 * Зачем отдельный процесс: server/db.js выбирает движок и открывает хранилище один раз
 * при подключении, а SQLITE_STORAGE задаётся окружением — так сценарии работают
 * во временной базе и до боевой data/ не дотягиваются (см. tests/db-transaction.test.js).
 *
 * Роутер /teachers подключается настоящий, но монтируется напрямую, без
 * server/routes/api/index.js: там на модуль навешаны вход и проверка роли, а проверять
 * здесь нужно решения самого обработчика. Кто «пришёл» — задаётся заголовком x-who
 * (логин), запись читается из базы на каждый запрос, как это делает auth.attachUser.
 * Признак active у пришедшего намеренно не проверяется: сценарий (в) как раз про то,
 * что администратор успел отправить запрос, пока его собственная блокировка ещё не дошла.
 *
 * Сам ничего не проверяет: выполняет сценарии и печатает отчёт строкой RESULT:<json>.
 * Все assert — в родительском тесте, там же и понятные сообщения об ошибках.
 */

const express = require('express');

const db = require('../../server/db');
const models = require('../../server/models');
const users = require('../../server/models/users');

const teachersRouter = require('../../server/routes/api/teachers');

const report = { engine: db.engine };

async function addAdmin(login) {
  const result = await users.create({
    login,
    password: 'secret12345',
    role: 'admin',
    name: `Администратор ${login}`,
  });
  if (!result.ok) throw new Error(`${login}: ${Object.values(result.errors).join('; ')}`);
  return result.user;
}

/** Снимок учётных записей — по нему родительский тест и судит об итоге сценария. */
async function snapshot() {
  const list = await users.list();
  return {
    admins: list.filter((user) => user.role === 'admin').map((user) => user.login).sort(),
    activeAdmins: list.filter((user) => user.role === 'admin' && user.active).map((user) => user.login).sort(),
    logins: list.map((user) => user.login).sort(),
  };
}

// ------------------------------------------------------------------- стенд

/**
 * Стартовые ворота: обработчики не двинутся дальше, пока не соберётся вся группа.
 *
 * Без них гонки в тесте просто не случится. Обработчик укладывается в доли миллисекунды,
 * а второй запрос доезжает по сети через 1–3 мс — первый к тому времени уже всё записал,
 * и любая реализация, даже с проверкой вне транзакции, выглядит правильной. Ворота
 * отпускают оба запроса в одном такте цикла событий, и они входят в проверку одновременно —
 * ровно так, как это выглядит на боевом сервере под нагрузкой.
 *
 * @param {number} size сколько запросов ждать
 * @returns {() => Promise<void>} вызывается каждым запросом; ждёт остальных
 */
function startGate(size) {
  let arrived = 0;
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });

  return () => {
    arrived += 1;
    if (arrived >= size) open();
    return opened;
  };
}

let gate = null;

function startServer() {
  const app = express();
  app.use(express.json());

  app.use(async (req, res, next) => {
    try {
      const actor = await users.getByLogin(req.get('x-who'));
      if (!actor) return res.status(401).json({ ok: false, message: 'Неизвестный сотрудник.' });

      req.user = actor;
      // Ворота стоят последними: к моменту открытия запросы уже разобраны
      // и различаются только тем, что собираются изменить.
      if (gate) await gate();
      return next();
    } catch (error) {
      return next(error);
    }
  });

  app.use('/api/teachers', teachersRouter);

  const server = app.listen(0);
  return new Promise((resolve) => server.once('listening', () => resolve(server)));
}

/** Пара запросов, отпущенных в один такт. */
async function together(first, second) {
  gate = startGate(2);
  try {
    return await Promise.all([first(), second()]);
  } finally {
    gate = null;
  }
}

async function request(base, who, method, url, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-who': who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const answer = await response.json();
  return {
    status: response.status,
    ok: answer.ok === true,
    // Отказ приходит либо сообщением (DELETE), либо ошибкой поля (PATCH роли) —
    // родительскому тесту важен текст, а не то, каким из двух способов он доехал.
    message: answer.message || (answer.errors && answer.errors.role) || '',
  };
}

async function main() {
  await models.init();

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;

  const demote = (who, target) => request(base, who, 'PATCH', `/api/teachers/${target.id}`, { role: 'manager' });
  const promote = (who, target) => request(base, who, 'PATCH', `/api/teachers/${target.id}`, { role: 'admin' });
  const block = (who, target) => request(base, who, 'PATCH', `/api/teachers/${target.id}`, { active: false });
  const remove = (who, target) => request(base, who, 'DELETE', `/api/teachers/${target.id}`);

  // --- (а) контрольный случай: администраторов трое, двоих можно разжаловать разом
  const first = await addAdmin('alpha');
  const second = await addAdmin('beta');
  const third = await addAdmin('gamma');

  const spare = await together(
    () => demote('gamma', first),
    () => demote('gamma', second)
  );
  report.spare = { statuses: spare.map((answer) => answer.status).sort(), after: await snapshot() };

  // --- (б) два последних администратора разжалуют друг друга одновременно
  const fourth = await addAdmin('delta');
  const parallelDemote = await together(
    () => demote('gamma', third),
    () => demote('gamma', fourth)
  );

  report.demote = {
    statuses: parallelDemote.map((answer) => answer.status).sort(),
    refusals: parallelDemote.filter((answer) => !answer.ok).map((answer) => answer.message),
    after: await snapshot(),
  };

  // Возвращаем второго администратора: следующему сценарию снова нужны ровно двое.
  const survivor = (await users.list()).find((user) => user.role === 'admin' && user.active);
  if (!survivor) {
    // Дальше идти незачем: продолжение сценария всё равно упадёт на пустом survivor,
    // и родительский тест увидел бы TypeError вместо причины.
    throw new Error('После параллельного разжалования не осталось ни одного активного администратора.');
  }
  const demoted = [third, fourth].find((user) => user.id !== survivor.id);
  await promote(survivor.login, demoted);
  report.restored = await snapshot();

  // --- (в) администратор блокирует себя и одновременно удаляет второго.
  // Порознь обе операции законны, вместе оставили бы школу без администратора.
  const parallelMix = await together(
    () => block(survivor.login, survivor),
    () => remove(survivor.login, demoted)
  );

  report.blockAndDelete = {
    statuses: parallelMix.map((answer) => answer.status).sort(),
    refusals: parallelMix.filter((answer) => !answer.ok).map((answer) => answer.message),
    after: await snapshot(),
  };

  server.close();

  // stdout здесь — канал (pipe), Node пишет в него UTF-8 независимо от кодовой
  // страницы консоли, а родитель читает с encoding: 'utf8'. Кириллица доедет.
  console.log(`RESULT:${JSON.stringify(report)}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
