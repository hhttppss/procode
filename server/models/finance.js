'use strict';

/**
 * Финансы: доходы (data/payments.json) и расходы (data/expenses.json).
 *
 * Суммы храним целыми рублями: копейки школе не нужны, а дробные числа
 * в JSON копят погрешность при сложении.
 *
 * Начисления сотрудникам считаются на лету по ставке, числу проведённых занятий
 * и месячному окладу (см. domain/payroll.js). В расходы они попадают только когда
 * администратор нажимает «Начислить» — тогда появляется запись категории payroll.
 * Её teacherId — любой сотрудник, а не обязательно преподаватель.
 */

const db = require('../db');
const catalog = require('../domain/catalog');

// ------------------------------------------------------------------ доходы

function normalizePayment(record) {
  if (!record || typeof record !== 'object') return null;

  const createdAt = db.asIsoDateTime(record.createdAt) || new Date().toISOString();
  const date = db.asDay(record.date) || createdAt.slice(0, 10);

  return {
    id: db.asText(record.id) || db.createId('pm'),
    createdAt,
    updatedAt: db.asIsoDateTime(record.updatedAt) || createdAt,
    date,
    studentId: db.asText(record.studentId),
    amount: db.asMoney(record.amount),
    method: db.oneOf(record.method, catalog.PAYMENT_METHOD_IDS, 'card'),
    lessonsPaid: db.asInt(record.lessonsPaid, 0) || 0,
    comment: db.asText(record.comment, 500),
    createdById: db.asText(record.createdById),
  };
}

const payments = db.collection('payments', { normalize: normalizePayment, prefix: 'pm' });

// ----------------------------------------------------------------- расходы

function normalizeExpense(record) {
  if (!record || typeof record !== 'object') return null;

  const createdAt = db.asIsoDateTime(record.createdAt) || new Date().toISOString();
  const date = db.asDay(record.date) || createdAt.slice(0, 10);

  return {
    id: db.asText(record.id) || db.createId('ex'),
    createdAt,
    updatedAt: db.asIsoDateTime(record.updatedAt) || createdAt,
    date,
    category: db.oneOf(record.category, catalog.EXPENSE_CATEGORY_IDS, 'other'),
    amount: db.asMoney(record.amount),
    teacherId: db.asText(record.teacherId),
    periodFrom: db.asDay(record.periodFrom),
    periodTo: db.asDay(record.periodTo),
    // Месяц оклада, 'YYYY-MM' — пусто, если в начислении оклада нет. Границ периода
    // для проверки «оклад за месяц уже выплачен» не хватает: их можно подвинуть,
    // а зарплата за август у сотрудника одна (см. domain/payroll.js).
    salaryMonth: db.asText(record.salaryMonth, 7),
    lessonsCount: db.asInt(record.lessonsCount, 0) || 0,
    comment: db.asText(record.comment, 500),
    createdById: db.asText(record.createdById),
  };
}

const expenses = db.collection('expenses', { normalize: normalizeExpense, prefix: 'ex' });

// ----------------------------------------------------------------- выборки

function inRange(item, fromDay, toDay) {
  if (fromDay && item.date < fromDay) return false;
  if (toDay && item.date > toDay) return false;
  return true;
}

async function paymentsBetween(fromDay, toDay) {
  return (await payments.filter((item) => inRange(item, fromDay, toDay))).sort((a, b) =>
    b.date.localeCompare(a.date)
  );
}

async function expensesBetween(fromDay, toDay) {
  return (await expenses.filter((item) => inRange(item, fromDay, toDay))).sort((a, b) =>
    b.date.localeCompare(a.date)
  );
}

async function paymentsByStudent(studentId) {
  return (await payments.filter((item) => item.studentId === studentId)).sort((a, b) =>
    b.date.localeCompare(a.date)
  );
}

function sum(items) {
  return items.reduce((total, item) => total + item.amount, 0);
}

/** Удаляет оплаты ученика вместе с его карточкой — иначе в отчётах остаётся «висящий» доход. */
async function removePaymentsOfStudent(studentId) {
  return payments.removeWhere((item) => item.studentId === studentId);
}

module.exports = {
  payments,
  expenses,
  async init() {
    await payments.init();
    await expenses.init();
  },
  paymentsBetween,
  expensesBetween,
  paymentsByStudent,
  removePaymentsOfStudent,
  sum,
};
