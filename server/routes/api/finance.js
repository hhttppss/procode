'use strict';

/**
 * Модуль «Финансы» — для администратора и управляющего (проверка стоит на роутере).
 *
 * Доходы — оплаты учеников. Расходы — начисления преподавателям и прочие траты.
 * Начисление считается автоматически: ставка преподавателя × число проведённых занятий
 * за период. Пока «Начислить» не нажали, это лишь расчёт; после нажатия появляется
 * запись расхода, и повторно за тот же период начислить уже не предложат.
 *
 * Саму ставку здесь не меняют ни при каких условиях: она правится только в модуле
 * «Преподаватели» (/app/api/teachers), закрытом для управляющего. Здесь ставка —
 * входное значение расчёта, а не настройка.
 */

const express = require('express');

const audit = require('../../models/audit');
const catalog = require('../../domain/catalog');
const db = require('../../db');
const finance = require('../../models/finance');
const lessons = require('../../models/lessons');
const students = require('../../models/students');
const users = require('../../models/users');
const { wrap, fail, failValidation, bodyOf, readPeriod } = require('./helpers');

const router = express.Router();

// ------------------------------------------------------------------ отчёт

/** Ряд для графика: суммы по месяцам, если период длинный, иначе по дням. */
function buildSeries(period, payments, expenses) {
  const spanDays = Math.round(
    (new Date(`${period.to}T00:00:00`) - new Date(`${period.from}T00:00:00`)) / 86400000
  );
  const byMonth = spanDays > 62;
  const keyOf = (day) => (byMonth ? day.slice(0, 7) : day);

  const buckets = new Map();
  const touch = (key) => {
    if (!buckets.has(key)) buckets.set(key, { key, income: 0, expense: 0 });
    return buckets.get(key);
  };

  // Заранее создаём пустые интервалы, иначе на графике будут дыры.
  const cursor = new Date(`${period.from}T00:00:00`);
  const until = new Date(`${period.to}T00:00:00`);
  let guard = 0;
  while (cursor <= until && guard < 800) {
    const day = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(
      cursor.getDate()
    ).padStart(2, '0')}`;
    touch(keyOf(day));
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }

  for (const payment of payments) touch(keyOf(payment.date)).income += payment.amount;
  for (const expense of expenses) touch(keyOf(expense.date)).expense += expense.amount;

  return { byMonth, points: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

/** Расчёт начислений: сколько причитается каждому преподавателю за период. */
function payrollFor(teachers, doneLessons, paidExpenses, period) {
  return teachers
    .map((teacher) => {
      const own = doneLessons.filter((lesson) => lesson.teacherId === teacher.id);
      const alreadyPaid = paidExpenses
        .filter(
          (expense) =>
            expense.category === 'payroll' &&
            expense.teacherId === teacher.id &&
            expense.periodFrom === period.from &&
            expense.periodTo === period.to
        )
        .reduce((total, expense) => total + expense.amount, 0);

      return {
        teacherId: teacher.id,
        name: teacher.name,
        rate: teacher.rate,
        lessons: own.length,
        amount: teacher.rate * own.length,
        alreadyPaid,
      };
    })
    .filter((row) => row.lessons > 0 || row.alreadyPaid > 0)
    .sort((a, b) => b.amount - a.amount);
}

router.get(
  '/summary',
  wrap(async (req, res) => {
    const period = readPeriod(req.query);

    const [payments, expenses, allLessons, allStudents, staff] = await Promise.all([
      finance.paymentsBetween(period.from, period.to),
      finance.expensesBetween(period.from, period.to),
      lessons.listBetween(period.from, period.to),
      students.list(),
      users.list(),
    ]);

    const teachers = staff.filter((user) => user.role === 'teacher');
    const doneLessons = allLessons.filter((lesson) => lesson.status === 'done');

    const income = finance.sum(payments);
    const expenseTotal = finance.sum(expenses);

    const studentName = new Map(allStudents.map((student) => [student.id, student.name]));
    const teacherName = new Map(staff.map((user) => [user.id, user.name]));

    // Доход в разрезе учеников
    const byStudent = new Map();
    for (const payment of payments) {
      const key = payment.studentId || 'unknown';
      const row = byStudent.get(key) || { studentId: payment.studentId, name: studentName.get(key) || 'Без ученика', amount: 0, count: 0 };
      row.amount += payment.amount;
      row.count += 1;
      byStudent.set(key, row);
    }

    // Расход в разрезе категорий
    const byCategory = new Map();
    for (const expense of expenses) {
      const row = byCategory.get(expense.category) || {
        category: expense.category,
        label: catalog.labelOf(catalog.EXPENSE_CATEGORIES, expense.category),
        amount: 0,
        count: 0,
      };
      row.amount += expense.amount;
      row.count += 1;
      byCategory.set(expense.category, row);
    }

    // Занятия в разрезе преподавателей
    const byTeacher = teachers
      .map((teacher) => {
        const own = allLessons.filter((lesson) => lesson.teacherId === teacher.id);
        return {
          teacherId: teacher.id,
          name: teacher.name,
          total: own.length,
          done: own.filter((lesson) => lesson.status === 'done').length,
          cancelled: own.filter((lesson) => lesson.status === 'cancelled').length,
        };
      })
      .filter((row) => row.total > 0)
      .sort((a, b) => b.done - a.done);

    res.json({
      ok: true,
      period,
      totals: {
        income,
        expense: expenseTotal,
        profit: income - expenseTotal,
        payments: payments.length,
        lessonsDone: doneLessons.length,
        lessonsTotal: allLessons.length,
      },
      series: buildSeries(period, payments, expenses),
      byStudent: [...byStudent.values()].sort((a, b) => b.amount - a.amount),
      byCategory: [...byCategory.values()].sort((a, b) => b.amount - a.amount),
      byTeacher,
      payroll: payrollFor(teachers, doneLessons, expenses, period),
      payments: payments.map((payment) => ({ ...payment, studentName: studentName.get(payment.studentId) || '—' })),
      expenses: expenses.map((expense) => ({
        ...expense,
        teacherName: expense.teacherId ? teacherName.get(expense.teacherId) || '—' : '',
        categoryLabel: catalog.labelOf(catalog.EXPENSE_CATEGORIES, expense.category),
      })),
    });
  })
);

/** Отчёт по занятиям: по школе, преподавателю или ученику. */
router.get(
  '/lessons-report',
  wrap(async (req, res) => {
    const period = readPeriod(req.query);
    const teacherId = db.asText(req.query.teacherId);
    const studentId = db.asText(req.query.studentId);

    const items = await lessons.listBetween(period.from, period.to, (lesson) => {
      if (teacherId && lesson.teacherId !== teacherId) return false;
      if (studentId && !lesson.studentIds.includes(studentId)) return false;
      return true;
    });

    const [staff, allStudents] = await Promise.all([users.list(), students.list()]);
    const teacherName = new Map(staff.map((user) => [user.id, user.name]));
    const studentName = new Map(allStudents.map((student) => [student.id, student.name]));

    const counts = { total: items.length };
    for (const status of catalog.LESSON_STATUSES) {
      counts[status.id] = items.filter((lesson) => lesson.status === status.id).length;
    }

    res.json({
      ok: true,
      period,
      counts,
      items: items.map((lesson) => ({
        ...lesson,
        teacherName: teacherName.get(lesson.teacherId) || '—',
        studentNames: lesson.studentIds.map((id) => studentName.get(id) || '—'),
      })),
    });
  })
);

// ------------------------------------------------------------------ оплаты

router.post(
  '/payments',
  wrap(async (req, res) => {
    const body = bodyOf(req);
    const errors = {};

    const studentId = db.asText(body.studentId);
    if (!studentId) errors.studentId = 'Выберите ученика.';
    else if (!(await students.getById(studentId))) errors.studentId = 'Ученик не найден.';

    const amount = db.asMoney(body.amount);
    if (amount <= 0) errors.amount = 'Сумма должна быть больше нуля.';

    const date = db.asDay(body.date);
    if (!date) errors.date = 'Укажите дату оплаты.';

    if (Object.keys(errors).length > 0) return failValidation(res, errors);

    const payment = await finance.payments.create({
      studentId,
      amount,
      date,
      method: body.method,
      lessonsPaid: db.asInt(body.lessonsPaid, 0),
      comment: db.asText(body.comment, 500),
      createdById: req.user.id,
    });

    res.status(201).json({ ok: true, item: payment });
  })
);

router.delete(
  '/payments/:id',
  wrap(async (req, res) => {
    const payment = await finance.payments.getById(req.params.id);
    if (!payment) return fail(res, 404, 'Оплата не найдена.');

    // Гонка двух одновременных запросов на удаление одной и той же записи: getById
    // выше её ещё видит у обоих, а remove() — уже нет у второго. Без этой проверки
    // оба ответили бы ok:true и оба написали бы audit.log об одном и том же удалении.
    if (!(await finance.payments.remove(payment.id))) return fail(res, 404, 'Оплата не найдена.');

    // Логируем на карточке ученика — там уже есть история изменений (историю оплаты
    // после удаления самой оплаты иначе нигде не найти).
    const student = await students.getById(payment.studentId);
    await audit.log({
      entity: 'student',
      entityId: payment.studentId,
      action: 'delete',
      actor: req.user,
      comment: `Удалена оплата ${payment.amount} ₽ от ${payment.date}${student ? '' : ' (ученик не найден)'}`,
    });

    return res.json({ ok: true });
  })
);

// ----------------------------------------------------------------- расходы

router.post(
  '/expenses',
  wrap(async (req, res) => {
    const body = bodyOf(req);
    const errors = {};

    const amount = db.asMoney(body.amount);
    if (amount <= 0) errors.amount = 'Сумма должна быть больше нуля.';

    const date = db.asDay(body.date);
    if (!date) errors.date = 'Укажите дату расхода.';

    const category = catalog.EXPENSE_CATEGORY_IDS.includes(body.category) ? body.category : 'other';

    const teacherId = db.asText(body.teacherId);
    if (teacherId && !(await users.getById(teacherId))) errors.teacherId = 'Сотрудник не найден.';

    if (Object.keys(errors).length > 0) return failValidation(res, errors);

    const expense = await finance.expenses.create({
      date,
      amount,
      category,
      teacherId,
      comment: db.asText(body.comment, 500),
      createdById: req.user.id,
    });

    res.status(201).json({ ok: true, item: expense });
  })
);

router.delete(
  '/expenses/:id',
  wrap(async (req, res) => {
    const expense = await finance.expenses.getById(req.params.id);
    if (!expense) return fail(res, 404, 'Расход не найден.');

    // См. комментарий в DELETE /payments/:id — та же гонка на удвоение audit.log.
    if (!(await finance.expenses.remove(expense.id))) return fail(res, 404, 'Расход не найден.');

    // entity 'expense' пока нигде не отображается (нет карточки/истории расходов) —
    // как и записи с entity 'user' (teachers.js), это задел под будущий общий журнал.
    const categoryLabel = catalog.labelOf(catalog.EXPENSE_CATEGORIES, expense.category);
    await audit.log({
      entity: 'expense',
      entityId: expense.id,
      action: 'delete',
      actor: req.user,
      comment: `Удалён расход: ${categoryLabel}, ${expense.amount} ₽ от ${expense.date}`,
    });

    return res.json({ ok: true });
  })
);

// -------------------------------------------------- начисление преподавателю

router.post(
  '/payroll',
  wrap(async (req, res) => {
    const body = bodyOf(req);
    const period = readPeriod(body);

    const teacher = await users.getById(db.asText(body.teacherId));
    if (!teacher || teacher.role !== 'teacher') return failValidation(res, { teacherId: 'Преподаватель не найден.' });

    const done = await lessons.listBetween(period.from, period.to, (lesson) => {
      return lesson.teacherId === teacher.id && lesson.status === 'done';
    });

    const amount = teacher.rate * done.length;
    if (amount <= 0) {
      return failValidation(res, {
        amount: 'За этот период начислять нечего: нет проведённых занятий или не задана ставка.',
      });
    }

    // Проверка «за этот период уже начисляли» и сама запись — одной транзакцией.
    // Раздельными вызовами двойной клик по «Начислить» успевал провести оплату дважды.
    // Занятия читаем до транзакции: в ней они не меняются.
    const expense = await db.transaction(['expenses'], (tx) => {
      const already = tx.expenses.filter(
        (item) =>
          item.category === 'payroll' &&
          item.teacherId === teacher.id &&
          item.periodFrom === period.from &&
          item.periodTo === period.to
      );
      if (already.length > 0) return null;

      return tx.expenses.insert({
        date: period.to,
        amount,
        category: 'payroll',
        teacherId: teacher.id,
        periodFrom: period.from,
        periodTo: period.to,
        lessonsCount: done.length,
        comment: `${teacher.name}: ${done.length} занятий × ${teacher.rate} ₽`,
        createdById: req.user.id,
      });
    });

    if (!expense) return fail(res, 409, 'За этот период начисление уже проведено.');

    res.status(201).json({ ok: true, item: expense });
  })
);

module.exports = router;
