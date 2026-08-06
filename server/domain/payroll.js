'use strict';

/**
 * Расчёт начисления сотруднику за период — одно место на карточку сотрудника и «Финансы».
 *
 * Начисление складывается из двух частей:
 *   ставка × проведённые занятия — считается за любой отрезок, каким его выбрали в отчёте;
 *   оклад                        — величина месячная и неделимая, поэтому входит в сумму
 *                                  только тогда, когда период — полный календарный месяц.
 *
 * Почему оклад привязан к месяцу. Границы периода в «Финансах» вводятся руками двумя
 * <input type="date">. Пока оклад начислялся за любой отрезок, его хватало выплатить
 * дважды: сначала за 01–15 августа, потом за 16–31 — суммы фиксированные, а проверка
 * «уже начисляли» сравнивала только точные границы периода и разные отрезки за дубль
 * не считала. Теперь оклад привязан к месяцу (salaryMonth в записи расхода), и второй
 * раз за тот же месяц он не начислится, как бы ни двигали даты.
 *
 * Делить оклад пропорционально дням намеренно не стали: «половина оклада за полмесяца» —
 * это уже договорённость с сотрудником, а не арифметика, и школа её не заключала.
 */

/**
 * Месяц периода, если период — ровно один календарный месяц целиком.
 * @param {{from: string, to: string}} period календарные дни YYYY-MM-DD
 * @returns {string|null} 'YYYY-MM' либо null, если период неполный или охватывает не месяц
 */
function fullCalendarMonthOf(period) {
  const from = period && typeof period.from === 'string' ? period.from : '';
  const to = period && typeof period.to === 'string' ? period.to : '';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  if (from.slice(0, 7) !== to.slice(0, 7)) return null;
  if (from.slice(8) !== '01') return null;

  // Нулевой день следующего месяца — это последний день текущего: так календарь
  // сам разбирается с февралём и високосными годами.
  const lastDay = new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 0).getDate();
  if (Number(to.slice(8)) !== lastDay) return null;

  return from.slice(0, 7);
}

/**
 * Что причитается сотруднику за период.
 *
 * Возвращает не только итог, но и его части: интерфейсу нужно объяснить, из чего
 * сложилась сумма и почему оклад в неё мог не войти, а обработчику начисления —
 * записать месяц оклада в расход.
 *
 * @param {object} employee учётная запись: используются rate и salary
 * @param {number} lessonsCount проведённые занятия сотрудника за период
 * @param {{from: string, to: string}} period
 */
function calculate(employee, lessonsCount, period) {
  const rate = Number(employee && employee.rate) || 0;
  const salary = Number(employee && employee.salary) || 0;
  const lessons = Number(lessonsCount) || 0;

  const month = fullCalendarMonthOf(period);
  const salaryApplies = Boolean(month) && salary > 0;

  const byLessons = rate * lessons;
  const salaryPart = salaryApplies ? salary : 0;

  return {
    rate,
    salary,
    lessons,
    // Месяц, за который идёт оклад. Пустая строка, когда оклада в начислении нет, —
    // по этому же полю расход ищется при проверке «оклад за месяц уже начислен».
    salaryMonth: salaryApplies ? month : '',
    salaryApplies,
    byLessons,
    salaryPart,
    amount: byLessons + salaryPart,
  };
}

module.exports = {
  fullCalendarMonthOf,
  calculate,
};
