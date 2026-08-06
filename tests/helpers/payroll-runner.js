'use strict';

/**
 * Дочерний процесс для tests/finance.test.js.
 *
 *   node tests/helpers/payroll-runner.js
 *
 * Зачем отдельный процесс: server/db.js выбирает движок и открывает хранилище один раз
 * при подключении, а SQLITE_STORAGE задаётся окружением — так сценарии работают
 * во временной базе и до боевой data/ не дотягиваются (см. tests/db-transaction.test.js).
 *
 * Роутеры подключаются настоящие, но монтируются напрямую, без server/routes/api/index.js:
 * там на модуль навешана проверка входа и роли (requireRoleApi('admin', 'manager')),
 * а проверять здесь нужно решения самого обработчика — кому он даёт начислить и сколько.
 * Роль запрашивающего подставляется заголовком x-who.
 *
 * Сам ничего не проверяет: выполняет сценарии и печатает отчёт строкой RESULT:<json>.
 * Все assert — в родительском тесте, там же и понятные сообщения об ошибках.
 */

const express = require('express');

const db = require('../../server/db');
const finance = require('../../server/models/finance');
const users = require('../../server/models/users');

const financeRouter = require('../../server/routes/api/finance');
const teachersRouter = require('../../server/routes/api/teachers');

const report = { engine: db.engine };
const staff = {};

async function seed() {
  const create = async (login, role, name, money) => {
    const result = await users.create({ login, password: 'secret12345', role, name, ...money });
    if (!result.ok) throw new Error(`${login}: ${Object.values(result.errors).join('; ')}`);
    staff[login] = result.user;
  };

  await create('boss', 'admin', 'Босс Боссов', { salary: 50000 });
  await create('olga', 'manager', 'Ольга Управляющая', { salary: 30000 });
  await create('orlova', 'teacher', 'Мария Орлова', { rate: 900, salary: 20000 });
  await create('kim', 'teacher', 'Антон Ким', { rate: 1000, salary: 15000 });

  await db.transaction(['lessons'], (tx) => {
    const lesson = (teacherId, date, status) => tx.lessons.insert({ teacherId, date, startTime: '17:00', status });

    // Орлова: три проведённых занятия в августе, одно запланированное (в расчёт не идёт)
    // и одно проведённое в ноябре — для проверки оклада, выплаченного другим периодом.
    lesson(staff.orlova.id, '2026-08-05', 'done');
    lesson(staff.orlova.id, '2026-08-12', 'done');
    lesson(staff.orlova.id, '2026-08-19', 'done');
    lesson(staff.orlova.id, '2026-08-26', 'planned');
    lesson(staff.orlova.id, '2026-11-10', 'done');

    // Ким: по одному занятию в каждой половине сентября и одно в октябре.
    lesson(staff.kim.id, '2026-09-05', 'done');
    lesson(staff.kim.id, '2026-09-20', 'done');
    lesson(staff.kim.id, '2026-10-07', 'done');
  });

  report.seed = {
    users: await users.list().then((list) => list.length),
    salaries: { boss: staff.boss.salary, olga: staff.olga.salary, orlova: staff.orlova.salary },
  };
}

// ------------------------------------------------------------------- стенд

function startServer() {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const actor = staff[req.get('x-who')];
    req.user = { id: actor.id, login: actor.login, role: actor.role, name: actor.name };
    next();
  });

  app.use('/api/finance', financeRouter);
  app.use('/api/teachers', teachersRouter);

  const server = app.listen(0);
  return new Promise((resolve) => server.once('listening', () => resolve(server)));
}

async function request(base, who, method, url, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-who': who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return { status: response.status, body: await response.json() };
}

/** Начисление: то, что проверяется в тестах, — без служебных полей записи. */
function payrollResult(answer) {
  const item = answer.body.item;
  return {
    status: answer.status,
    message: answer.body.message || (answer.body.errors && answer.body.errors.amount) || '',
    amount: item ? item.amount : null,
    salaryMonth: item ? item.salaryMonth : null,
    lessonsCount: item ? item.lessonsCount : null,
    comment: item ? item.comment : '',
  };
}

async function main() {
  await seed();

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const pay = async (who, target, from, to) =>
    payrollResult(await request(base, who, 'POST', '/api/finance/payroll', { teacherId: staff[target].id, from, to }));

  // --- (а) полный месяц: ставка × занятия плюс оклад
  report.fullMonth = await pay('boss', 'orlova', '2026-08-01', '2026-08-31');
  report.samePeriodAgain = await pay('boss', 'orlova', '2026-08-01', '2026-08-31');

  // --- (б) главный регресс: две половины месяца не должны выплатить оклад дважды
  report.firstHalf = await pay('boss', 'kim', '2026-09-01', '2026-09-15');
  report.secondHalf = await pay('boss', 'kim', '2026-09-16', '2026-09-30');

  const kimSeptember = (await finance.expenses.list()).filter(
    (item) => item.teacherId === staff.kim.id && item.date.startsWith('2026-09')
  );
  report.september = {
    paid: kimSeptember.reduce((total, item) => total + item.amount, 0),
    salaryMonths: kimSeptember.map((item) => item.salaryMonth),
  };

  // --- (в) неполный месяц у того, кому платят только окладом
  report.halfMonthSalaryOnly = await pay('boss', 'olga', '2026-09-01', '2026-09-15');

  // --- (г) оклад за месяц уже выплачен, но границы периода были другими
  await finance.expenses.create({
    date: '2026-11-29',
    amount: 20000,
    category: 'payroll',
    teacherId: staff.orlova.id,
    periodFrom: '2026-11-02',
    periodTo: '2026-11-29',
    salaryMonth: '2026-11',
    comment: 'начисление с другими границами периода',
  });
  await finance.expenses.create({
    date: '2026-11-29',
    amount: 30000,
    category: 'payroll',
    teacherId: staff.olga.id,
    periodFrom: '2026-11-02',
    periodTo: '2026-11-29',
    salaryMonth: '2026-11',
    comment: 'начисление с другими границами периода',
  });

  // У преподавателя остаются занятия — их начислить можно, оклад уже выплачен.
  report.salaryAlreadyPaidWithLessons = await pay('boss', 'orlova', '2026-11-01', '2026-11-30');
  // У управляющего занятий нет — начислять нечего.
  report.salaryAlreadyPaidNoLessons = await pay('boss', 'olga', '2026-11-01', '2026-11-30');

  // --- (д) чужая зарплата и управляющий
  report.managerPaysAdmin = await pay('olga', 'boss', '2026-08-01', '2026-08-31');
  report.managerPaysManager = await pay('olga', 'olga', '2026-08-01', '2026-08-31');
  report.managerPaysTeacher = await pay('olga', 'kim', '2026-10-01', '2026-10-31');

  // --- (е) что видно в расчёте: строки и признак «оклад войдёт»
  const summaryRow = (answer, target) => {
    const row = (answer.body.payroll || []).find((item) => item.teacherId === staff[target].id);
    return row ? { role: row.role, rate: row.rate, salary: row.salary, lessons: row.lessons, amount: row.amount, salaryApplies: row.salaryApplies } : null;
  };

  const adminAugust = await request(base, 'boss', 'GET', '/api/finance/summary?from=2026-08-01&to=2026-08-31');
  const managerAugust = await request(base, 'olga', 'GET', '/api/finance/summary?from=2026-08-01&to=2026-08-31');
  const adminHalf = await request(base, 'boss', 'GET', '/api/finance/summary?from=2026-09-01&to=2026-09-15');

  report.summary = {
    adminRoles: (adminAugust.body.payroll || []).map((row) => row.role).sort(),
    managerRoles: (managerAugust.body.payroll || []).map((row) => row.role).sort(),
    managerNames: (managerAugust.body.payroll || []).map((row) => row.name).sort(),
    adminBoss: summaryRow(adminAugust, 'boss'),
    fullMonthKim: summaryRow(adminAugust, 'kim'),
    halfMonthKim: summaryRow(adminHalf, 'kim'),
  };

  // --- (ж) карточка сотрудника обязана показывать ту же сумму, что и финансы
  const card = await request(base, 'boss', 'GET', `/api/teachers/${staff.orlova.id}?from=2026-08-01&to=2026-08-31`);
  const cardHalf = await request(base, 'boss', 'GET', `/api/teachers/${staff.orlova.id}?from=2026-08-01&to=2026-08-15`);
  report.card = { fullMonth: card.body.payroll, halfMonth: cardHalf.body.payroll };

  server.close();

  // stdout здесь — канал (pipe), Node пишет в него UTF-8 независимо от кодовой
  // страницы консоли, а родитель читает с encoding: 'utf8'. Кириллица доедет.
  console.log(`RESULT:${JSON.stringify(report)}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
