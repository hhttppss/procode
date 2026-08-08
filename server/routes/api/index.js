'use strict';

/**
 * Сборка API платформы: /app/api/*
 *
 * Здесь же расставлены проверки роли на уровне маршрутов. «Заявки» и «Финансы» открыты
 * администратору и управляющему, «Сотрудники» (/teachers) — только администратору:
 * учётные записи, роли, ставки и оклады остаются за ним. Ни один обработчик закрытого
 * модуля не выполнится для чужой роли, даже если запрос отправлен вручную.
 *
 * «Ученики» и «Расписание» открыты всем трём ролям, но внутри каждый обработчик
 * ограничивает выборку и набор полей по req.user (см. domain/access.js).
 *
 * Перед проверками стоит ограничитель частоты — единственное место, где он есть
 * у внутреннего API.
 */

const express = require('express');

const access = require('../../domain/access');
const auth = require('../../auth');
const students = require('../../models/students');
const users = require('../../models/users');
const { wrap } = require('./helpers');

const router = express.Router();

// ------------------------------------------------------- ограничение частоты

/**
 * Ограничитель обращений к внутреннему API.
 *
 * Ключ — идентификатор сотрудника, а не IP: за одним офисным адресом (или мобильным NAT)
 * сидит вся школа, и лимит по IP отнимал бы место у коллег. Для тех, кто ещё не вошёл,
 * остаётся IP — иначе поток запросов без сессии не считался бы вовсе. По той же причине
 * ограничитель стоит ДО requireApi: чужие запросы отсекаются 401-м, но их всё равно надо считать.
 *
 * Откуда числа. Обычная сессия менеджера: при заходе на раздел 2–3 запроса (данные раздела,
 * справочник, уведомления), дальше фоновое обновление раз в 30 секунд — уведомления плюс
 * список раздела, то есть 4 запроса в минуту, 20 за окно. С переходами между разделами,
 * фильтрами и открытыми в двух вкладках разделами выходит меньше сотни за пять минут.
 * 300 оставляет тройной запас и при этом не даёт выкачивать базу тысячами запросов.
 *
 * Изменения считаются отдельно и строже: их делает человек руками через модальные окна,
 * и даже быстрая правка расписания — это единицы запросов в минуту. Отдельный счётчик
 * важнее общего: чтение — это лишний трафик, а поток POST/PATCH/DELETE меняет данные
 * и запускает уведомления с записями в журнал.
 */
const RATE_WINDOW_MS = 5 * 60 * 1000;
const REQUEST_LIMIT = 300;
const WRITE_LIMIT = 90;

const requestLimiter = auth.createRateLimiter({ limit: REQUEST_LIMIT, windowMs: RATE_WINDOW_MS });
const writeLimiter = auth.createRateLimiter({ limit: WRITE_LIMIT, windowMs: RATE_WINDOW_MS });

function limitKey(req) {
  return req.user ? `u:${req.user.id}` : `ip:${auth.getClientIp(req)}`;
}

function waitPhrase(seconds) {
  return seconds <= 60 ? 'около минуты' : `около ${Math.ceil(seconds / 60)} минут`;
}

/** Ответ 429 в общем для API виде — клиент (public/js/crm/core.js) покажет message как есть. */
function tooManyRequests(res, limiter, key, message) {
  const seconds = limiter.retryAfter(key);
  res.setHeader('Retry-After', String(Math.max(seconds, 1)));
  return res.status(429).json({ ok: false, message: message(waitPhrase(seconds)) });
}

router.use((req, res, next) => {
  const key = limitKey(req);
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

  if (requestLimiter.isBlocked(key)) {
    return tooManyRequests(
      res,
      requestLimiter,
      key,
      (wait) => `Слишком много запросов к платформе. Подождите ${wait} и обновите страницу.`
    );
  }

  if (writing && writeLimiter.isBlocked(key)) {
    return tooManyRequests(
      res,
      writeLimiter,
      key,
      (wait) => `Слишком много изменений подряд. Подождите ${wait} и повторите сохранение.`
    );
  }

  // Отмечаем до обработчика: иначе несколько одновременных запросов успели бы
  // пройти проверку раньше, чем счётчик увеличится.
  requestLimiter.hit(key);
  if (writing) writeLimiter.hit(key);

  return next();
});

// Всё ниже требует входа в систему.
router.use(auth.requireApi);

router.use('/dashboard', require('./dashboard'));
router.use('/notifications', require('./notifications'));
router.use('/profile', require('./profile'));

router.use('/applications', auth.requireRoleApi('admin', 'manager'), require('./applications'));
router.use('/teachers', auth.requireAdminApi, require('./teachers'));
router.use('/finance', auth.requireRoleApi('admin', 'manager'), require('./finance'));

router.use('/students', require('./students'));
router.use('/lessons', require('./lessons'));

/**
 * Справочник для выпадающих списков: преподаватели, все сотрудники и ученики одними именами.
 * Преподаватель получает здесь только своих учеников и краткие карточки коллег
 * (без ставок и контактов) — это нужно, чтобы в расписании отображались имена.
 * Ставок и окладов здесь нет ни для кого: они живут только в модуле «Сотрудники».
 *
 * teachers и staff — разные списки, а не один с фильтром: расписанию и карточке ученика
 * нужны именно преподаватели (закрепить ученика за администратором нельзя), а форме
 * расхода в «Финансах» — любой сотрудник, включая тех, кто занятий не ведёт.
 */
router.get(
  '/directory',
  wrap(async (req, res) => {
    const seesEveryone = access.canViewAllStudents(req.user);

    const staff = await users.list();
    const studentList = seesEveryone ? await students.list() : await students.listByTeacher(req.user.id);

    res.json({
      ok: true,
      teachers: staff
        .filter((user) => user.role === 'teacher')
        .map((user) => (seesEveryone ? { ...access.staffBrief(user), courses: user.courses } : access.staffBrief(user)))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      // Все сотрудники — для формы ручного расхода: привязать трату можно и к управляющему
      // с администратором, у которых занятий нет, а оклад есть. Список уходит только тем,
      // кому открыты финансы, — больше о коллегах никто отсюда не узнаёт. Тем, кому нельзя,
      // отдаём пустой массив, а не пропускаем поле: форма ответа одинакова для всех ролей,
      // и клиенту не приходится отличать «нет права» от «сотрудников нет вовсе».
      staff: access.canViewFinance(req.user)
        ? staff.map((user) => access.staffBrief(user)).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        : [],
      students: studentList
        .map((student) => ({
          id: student.id,
          name: student.name,
          course: student.course,
          group: student.group,
          teacherId: student.teacherId,
          status: student.status,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    });
  })
);

module.exports = router;
