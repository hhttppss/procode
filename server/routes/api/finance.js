'use strict';

/**
 * Модуль «Финансы» — для администратора и управляющего (проверка стоит на роутере).
 *
 * Доходы — оплаты учеников. Расходы — начисления сотрудникам и прочие траты.
 * Начисление считается автоматически: ставка × число проведённых занятий за период
 * плюс месячный оклад (правила расчёта — в domain/payroll.js). Оклад есть у любой роли:
 * иначе администратору и управляющему, у которых занятий нет, начислять было бы нечего.
 * Пока «Начислить» не нажали, это лишь расчёт; после нажатия появляется запись расхода,
 * и повторно за тот же период начислить уже не предложат.
 *
 * Чужая зарплата — не для управляющего. Модуль открыт и ему, но с окладами
 * администраторов и управляющих работает только администратор: в расчёте эти строки
 * управляющему не показываются вовсе, а начислить их ему отвечают 403. Управляющий
 * ведёт преподавателей — тех, чьё начисление считается по занятиям.
 *
 * Ни ставку, ни оклад здесь не меняют ни при каких условиях: они правятся только
 * в модуле «Сотрудники» (/app/api/teachers), закрытом для управляющего. Здесь это
 * входные значения расчёта, а не настройки.
 */

const express = require('express');

const access = require('../../domain/access');
const audit = require('../../models/audit');
const catalog = require('../../domain/catalog');
const db = require('../../db');
const finance = require('../../models/finance');
const lessons = require('../../models/lessons');
const payroll = require('../../domain/payroll');
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

/**
 * Расчёт начислений: сколько причитается каждому сотруднику за период.
 *
 * Сумма считается тем же domain/payroll.js, что и при самом начислении, — в таблице
 * стоит ровно та цифра, которая уйдёт в расход по кнопке «Начислить». Отсюда же
 * приходит salaryApplies: за неполный месяц оклад не начисляется, и интерфейсу нужно
 * объяснить, почему сумма меньше ожидаемой.
 */
function payrollFor(staff, doneLessons, paidExpenses, period) {
  return staff
    .map((employee) => {
      const own = doneLessons.filter((lesson) => lesson.teacherId === employee.id);
      const alreadyPaid = paidExpenses
        .filter(
          (expense) =>
            expense.category === 'payroll' &&
            expense.teacherId === employee.id &&
            expense.periodFrom === period.from &&
            expense.periodTo === period.to
        )
        .reduce((total, expense) => total + expense.amount, 0);

      const calculated = payroll.calculate(employee, own.length, period);

      return {
        teacherId: employee.id,
        name: employee.name,
        role: employee.role,
        rate: calculated.rate,
        salary: calculated.salary,
        salaryMonth: calculated.salaryMonth,
        salaryApplies: calculated.salaryApplies,
        lessons: calculated.lessons,
        amount: calculated.amount,
        alreadyPaid,
      };
    })
    // Строка нужна, только когда есть за что платить или уже заплатили: иначе в таблицу
    // попал бы каждый сотрудник без ставки, оклада и занятий — строкой на ноль рублей.
    .filter((row) => row.lessons > 0 || row.salary > 0 || row.alreadyPaid > 0)
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

    // Отдельный список преподавателей нужен только отчёту по занятиям ниже:
    // начисления считаются по всем сотрудникам, а вести уроки может лишь преподаватель.
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

    // Начисления. Управляющему остаются только преподаватели: сколько получает
    // администратор — не его дело, поэтому строка убирается целиком, а не «очищается»
    // от ставки с окладом. Раз строки нет, то и кнопки «Начислить» в интерфейсе не будет,
    // но полагаемся мы не на это: POST /payroll проверяет то же право заново.
    const allPayroll = payrollFor(staff, doneLessons, expenses, period);
    const visiblePayroll = access.canManageRates(req.user)
      ? allPayroll
      : allPayroll.filter((row) => row.role === 'teacher');

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
      payroll: visiblePayroll,
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

// ---------------------------------------------------- начисление сотруднику

router.post(
  '/payroll',
  wrap(async (req, res) => {
    const body = bodyOf(req);
    const period = readPeriod(body);

    // Начислить можно любому сотруднику: у администратора и управляющего занятий нет,
    // но есть оклад. А вот кому именно — зависит от того, кто начисляет.
    const employee = await users.getById(db.asText(body.teacherId));
    if (!employee) return failValidation(res, { teacherId: 'Сотрудник не найден.' });

    // Зарплата администрации — только через администратора: управляющему модуль открыт,
    // но распоряжаться окладами тех, кто выше или равен ему, он не должен.
    if (employee.role !== 'teacher' && !access.canManageRates(req.user)) {
      return fail(res, 403, 'Начислять зарплату администраторам и управляющим может только администратор.');
    }

    const done = await lessons.listBetween(period.from, period.to, (lesson) => {
      return lesson.teacherId === employee.id && lesson.status === 'done';
    });

    const calculated = payroll.calculate(employee, done.length, period);

    // Отказ объясняем ровно той причиной, по которой вышел ноль: «начислять нечего»
    // не подсказывает, что делать, а «выберите месяц целиком» — подсказывает.
    if (calculated.amount <= 0) {
      if (calculated.salary > 0 && !calculated.salaryApplies) {
        return failValidation(res, {
          amount: 'Оклад начисляется только за полный календарный месяц — выберите месяц целиком.',
        });
      }
      if (calculated.rate > 0) {
        return failValidation(res, { amount: 'За этот период у сотрудника нет проведённых занятий.' });
      }
      return failValidation(res, {
        amount: 'Сотруднику не задан ни оклад, ни ставка за занятие — начислять нечего.',
      });
    }

    // Проверки «уже начисляли» и сама запись — одной транзакцией. Раздельными вызовами
    // двойной клик по «Начислить» успевал провести оплату дважды. Занятия читаем
    // до транзакции: в ней они не меняются.
    const result = await db.transaction(['expenses'], (tx) => {
      const paid = tx.expenses.filter((item) => item.category === 'payroll' && item.teacherId === employee.id);

      // Те же границы периода — то же начисление целиком, включая занятия.
      if (paid.some((item) => item.periodFrom === period.from && item.periodTo === period.to)) {
        return { ok: false, status: 409, message: 'За этот период начисление уже проведено.' };
      }

      // Оклад — один на календарный месяц, как бы ни двигали границы периода.
      // Занятия при этом начислить можно: за них платят отдельно, по факту проведения.
      const salaryPaid =
        calculated.salaryApplies && paid.some((item) => item.salaryMonth === calculated.salaryMonth);
      const salaryPart = salaryPaid ? 0 : calculated.salaryPart;
      const amount = calculated.byLessons + salaryPart;

      if (amount <= 0) {
        return { ok: false, status: 409, message: 'Оклад за этот месяц уже начислен, а проведённых занятий за период нет.' };
      }

      // Из чего сложилась сумма, видно только здесь: расход хранит итог, а ставка
      // и оклад к моменту следующего просмотра уже могут быть другими.
      const parts = [];
      if (calculated.byLessons > 0) parts.push(`${done.length} занятий × ${calculated.rate} ₽`);
      if (salaryPart > 0) parts.push(`оклад за месяц ${salaryPart} ₽`);

      return {
        ok: true,
        expense: tx.expenses.insert({
          date: period.to,
          amount,
          category: 'payroll',
          // Поле называется teacherId по историческим причинам: под ним уже лежат
          // проведённые начисления и по нему же ищутся дубли выше. Теперь здесь
          // может быть любой сотрудник, а не только преподаватель.
          teacherId: employee.id,
          periodFrom: period.from,
          periodTo: period.to,
          salaryMonth: salaryPart > 0 ? calculated.salaryMonth : '',
          lessonsCount: done.length,
          comment: `${employee.name}: ${parts.join(' + ')}`,
          createdById: req.user.id,
        }),
      };
    });

    if (!result.ok) return fail(res, result.status, result.message);

    res.status(201).json({ ok: true, item: result.expense });
  })
);

module.exports = router;
