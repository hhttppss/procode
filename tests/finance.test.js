'use strict';

/**
 * Начисление зарплаты: правила расчёта (server/domain/payroll.js) и решения обработчика
 * POST /app/api/finance/payroll — кому можно начислить и сколько.
 *
 * Почему именно это покрыто тестами: здесь считаются настоящие деньги, а два дефекта
 * стоили ровно по одному невидимому условию:
 *   • оклад выплачивался дважды за один месяц — сначала за 01–15, потом за 16–31:
 *     сумма фиксированная, а проверка «уже начисляли» сравнивала только точные границы;
 *   • управляющий видел оклад администратора в расчёте и мог его сам себе начислить —
 *     обработчик роль цели не проверял вовсе.
 *
 * Правила расчёта проверяются прямо здесь: domain/payroll.js — чистая арифметика
 * без хранилища. Сценарии с записью в базу выполняет дочерний процесс
 * (tests/helpers/payroll-runner.js) во временной базе SQLite: движок и путь к хранилищу
 * выбираются один раз при подключении server/db.js, поэтому в одном процессе с ним
 * не ужиться (см. tests/db-transaction.test.js).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const payroll = require('../server/domain/payroll');

const PROJECT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'helpers', 'payroll-runner.js');
const REAL_DATA = path.join(PROJECT, 'data');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'procode-payroll-'));

// Снимок боевой папки: ни один тест этого файла не имеет права её пополнить.
const realDataBefore = fs.existsSync(REAL_DATA) ? fs.readdirSync(REAL_DATA).sort() : null;

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// --------------------------------------------------- правила расчёта (без базы)

test('полным календарным месяцем считается только период 1-е — последнее число', () => {
  assert.equal(payroll.fullCalendarMonthOf({ from: '2026-08-01', to: '2026-08-31' }), '2026-08');
  assert.equal(payroll.fullCalendarMonthOf({ from: '2026-09-01', to: '2026-09-30' }), '2026-09');
  assert.equal(payroll.fullCalendarMonthOf({ from: '2026-02-01', to: '2026-02-28' }), '2026-02');
  assert.equal(
    payroll.fullCalendarMonthOf({ from: '2024-02-01', to: '2024-02-29' }),
    '2024-02',
    'високосный февраль заканчивается 29-м'
  );

  assert.equal(payroll.fullCalendarMonthOf({ from: '2026-08-01', to: '2026-08-30' }), null, 'месяц не дожит до конца');
  assert.equal(payroll.fullCalendarMonthOf({ from: '2026-08-02', to: '2026-08-31' }), null, 'месяц начат не с 1-го');
  assert.equal(payroll.fullCalendarMonthOf({ from: '2026-08-01', to: '2026-09-30' }), null, 'два месяца — не один');
  assert.equal(payroll.fullCalendarMonthOf({ from: '2026-02-01', to: '2026-02-29' }), null, '29 февраля в 2026-м нет');
  assert.equal(payroll.fullCalendarMonthOf({ from: '', to: '' }), null);
  assert.equal(payroll.fullCalendarMonthOf(null), null);
});

test('за полный месяц начисляются и занятия по ставке, и оклад', () => {
  const result = payroll.calculate({ rate: 900, salary: 20000 }, 3, { from: '2026-08-01', to: '2026-08-31' });

  assert.equal(result.byLessons, 2700);
  assert.equal(result.salaryPart, 20000);
  assert.equal(result.amount, 22700);
  assert.equal(result.salaryApplies, true);
  assert.equal(result.salaryMonth, '2026-08');
});

test('за неполный месяц оклад не начисляется — только занятия', () => {
  const result = payroll.calculate({ rate: 900, salary: 20000 }, 2, { from: '2026-08-01', to: '2026-08-15' });

  assert.equal(result.amount, 1800, 'оклад в сумму входить не должен');
  assert.equal(result.salaryPart, 0);
  assert.equal(result.salaryApplies, false);
  assert.equal(result.salaryMonth, '', 'месяц оклада пуст — по нему потом ищется дубль');
  assert.equal(result.salary, 20000, 'сам оклад сотрудника при этом никуда не делся');
});

test('без оклада расчёт остаётся прежним, без ставки — считается один оклад', () => {
  const teacher = payroll.calculate({ rate: 800, salary: 0 }, 5, { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(teacher.amount, 4000);
  assert.equal(teacher.salaryApplies, false, 'нечему применяться: оклад не задан');

  const admin = payroll.calculate({ rate: 0, salary: 50000 }, 0, { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(admin.amount, 50000, 'у администратора занятий нет — начисление идёт окладом');

  const nobody = payroll.calculate({}, 0, { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(nobody.amount, 0);
});

// ------------------------------------------------- сценарии с записью в базу

let report = null;

before(() => {
  const storage = path.join(ROOT, 'sqlite', 'app.sqlite');
  const result = spawnSync(process.execPath, [RUNNER], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_ENGINE: 'sqlite', SQLITE_STORAGE: storage },
  });

  assert.equal(result.error, undefined, `не удалось запустить дочерний процесс: ${result.error && result.error.message}`);
  assert.equal(result.status, 0, `сценарии упали (код ${result.status}):\n${result.stderr}\n${result.stdout}`);

  const line = (result.stdout || '').split(/\r?\n/).find((row) => row.startsWith('RESULT:'));
  assert.ok(line, `дочерний процесс не отдал отчёт:\n${result.stdout}\n${result.stderr}`);

  report = JSON.parse(line.slice('RESULT:'.length));
  assert.equal(report.engine, 'sqlite');
  assert.equal(fs.existsSync(storage), true, 'база должна быть создана во временной папке, а не в data/');
});

test('за полный месяц начисляются занятия и оклад одной записью', () => {
  assert.equal(report.fullMonth.status, 201, report.fullMonth.message);
  assert.equal(report.fullMonth.amount, 3 * 900 + 20000, 'ставка × проведённые занятия плюс оклад');
  assert.equal(report.fullMonth.lessonsCount, 3, 'запланированное занятие в начисление не идёт');
  assert.equal(report.fullMonth.salaryMonth, '2026-08', 'месяц оклада пишется в расход — по нему ловится повтор');
  assert.match(report.fullMonth.comment, /3 занятий × 900 ₽ \+ оклад за месяц 20000 ₽/);
});

test('повторное начисление за тот же период отклоняется', () => {
  assert.equal(report.samePeriodAgain.status, 409);
  assert.match(report.samePeriodAgain.message, /уже проведено/);
});

test('оклад не выплачивается дважды за один месяц двумя половинами периода', () => {
  assert.equal(report.firstHalf.status, 201, report.firstHalf.message);
  assert.equal(report.secondHalf.status, 201, report.secondHalf.message);

  assert.equal(report.firstHalf.amount, 1000, 'за 01–15 сентября начисляется только занятие по ставке');
  assert.equal(report.secondHalf.amount, 1000, 'за 16–30 сентября — тоже только занятие');
  assert.deepEqual(report.september.salaryMonths, ['', ''], 'ни одно из начислений не содержит оклада');
  assert.equal(
    report.september.paid,
    2000,
    'за сентябрь выплачены только занятия: оклад 15000 ₽ не должен уйти ни разу, тем более дважды'
  );
});

test('за неполный месяц сотруднику с одним окладом отказывают и объясняют, что делать', () => {
  assert.equal(report.halfMonthSalaryOnly.status, 400);
  assert.match(report.halfMonthSalaryOnly.message, /полный календарный месяц/);
});

test('оклад за месяц, выплаченный другими границами периода, второй раз не начисляется', () => {
  // Занятия начислить всё равно можно — за них платят по факту проведения.
  assert.equal(report.salaryAlreadyPaidWithLessons.status, 201, report.salaryAlreadyPaidWithLessons.message);
  assert.equal(report.salaryAlreadyPaidWithLessons.amount, 900, 'в сумму вошло занятие, но не оклад');
  assert.equal(report.salaryAlreadyPaidWithLessons.salaryMonth, '', 'оклад в этой записи не начислен');

  // А когда кроме оклада начислять нечего — отказ с точной причиной.
  assert.equal(report.salaryAlreadyPaidNoLessons.status, 409);
  assert.match(report.salaryAlreadyPaidNoLessons.message, /Оклад за этот месяц уже начислен/);
});

test('управляющий не может начислить зарплату администратору и самому себе', () => {
  assert.equal(report.managerPaysAdmin.status, 403);
  assert.match(report.managerPaysAdmin.message, /только администратор/);

  assert.equal(report.managerPaysManager.status, 403, 'себе — тоже нельзя');

  assert.equal(report.managerPaysTeacher.status, 201, 'преподавателей управляющий ведёт сам');
  assert.equal(report.managerPaysTeacher.amount, 1000 + 15000);
});

test('в расчёте управляющему видны только преподаватели', () => {
  assert.deepEqual(report.summary.adminRoles, ['admin', 'manager', 'teacher', 'teacher'], 'администратор видит всех');
  assert.deepEqual(report.summary.managerRoles, ['teacher', 'teacher']);
  assert.deepEqual(
    report.summary.managerNames,
    ['Антон Ким', 'Мария Орлова'],
    'ни администратора, ни собственной строки управляющий в расчёте не видит'
  );
});

test('расчёт показывает ту же сумму, которая уйдёт в расход', () => {
  assert.deepEqual(report.summary.adminBoss, {
    role: 'admin',
    rate: 0,
    salary: 50000,
    lessons: 0,
    amount: 50000,
    salaryApplies: true,
  });

  assert.equal(report.summary.fullMonthKim.amount, 15000, 'полный месяц: оклад входит');
  assert.equal(report.summary.fullMonthKim.salaryApplies, true);

  assert.equal(report.summary.halfMonthKim.amount, 1000, 'половина месяца: только занятие по ставке');
  assert.equal(report.summary.halfMonthKim.salaryApplies, false, 'интерфейсу нужно объяснить, почему оклада нет');
  assert.equal(report.summary.halfMonthKim.salary, 15000, 'сам оклад в строке остаётся — его показывают со сноской');
});

test('карточка сотрудника считает начисление тем же правилом, что и финансы', () => {
  assert.equal(report.card.fullMonth.amount, report.fullMonth.amount, 'карточка и расход обязаны сойтись до рубля');
  assert.equal(report.card.fullMonth.salaryApplies, true);

  assert.equal(report.card.halfMonth.amount, 2 * 900, 'за половину месяца оклада нет и в карточке');
  assert.equal(report.card.halfMonth.salaryApplies, false);
});

test('боевая папка data/ тестами не тронута', () => {
  const realDataAfter = fs.existsSync(REAL_DATA) ? fs.readdirSync(REAL_DATA).sort() : null;
  assert.deepEqual(realDataAfter, realDataBefore, 'тесты обязаны работать только во временных папках');
});
