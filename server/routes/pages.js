'use strict';

/**
 * Страницы платформы: /app/*
 *
 * Каждая страница — это общий каркас плюс разметка модуля. Данные подгружает
 * браузер через /app/api/*, поэтому сервер отдаёт лёгкий HTML без встроенных списков.
 * Роль проверяется дважды: здесь (чтобы не открылась чужая страница) и в API
 * (чтобы не помогло прямое обращение к данным).
 */

const express = require('express');

const access = require('../domain/access');
const auth = require('../auth');
const render = require('../views/render');
const { wrap } = require('./api/helpers');

const router = express.Router();

router.use(auth.requirePage);

/** Отдаёт страницу, если роль имеет к ней доступ; иначе уводит на главную. */
function page({ module: moduleName, view, script, title, heading, subheading, data }) {
  return wrap(async (req, res) => {
    if (!access.canOpenModule(req.user, moduleName)) {
      return res.redirect('/app');
    }

    const extra = typeof data === 'function' ? data(req) : data;

    res.type('html').send(
      await render.renderApp({
        user: req.user,
        module: moduleName,
        view: view || moduleName,
        script: script || `${view || moduleName}.js`,
        title,
        heading: typeof heading === 'function' ? heading(req) : heading,
        subheading,
        data: extra,
        // Nonce выдан общим middleware безопасности (server/index.js) на этот запрос
        // и уже стоит в заголовке CSP — без него инлайновый блок с данными сессии не выполнится.
        nonce: res.locals.cspNonce,
      })
    );
  });
}

router.get(
  '/',
  page({
    module: 'dashboard',
    title: 'Главная',
    heading: 'Главная',
    subheading: 'Сводка по школе и быстрый переход к работе',
  })
);

router.get(
  '/applications',
  page({
    module: 'applications',
    title: 'Заявки',
    heading: 'Заявки',
    subheading: 'Обращения с сайта: от первого звонка до зачисления',
  })
);

router.get(
  '/students',
  page({
    module: 'students',
    title: 'Ученики',
    heading: 'Ученики',
    subheading: 'Карточки, направления, преподаватели и статусы',
  })
);

router.get(
  '/students/:id',
  page({
    module: 'students',
    view: 'student-card',
    title: 'Карточка ученика',
    heading: 'Карточка ученика',
    subheading: 'Данные, посещаемость и история',
    data: (req) => ({ studentId: req.params.id }),
  })
);

router.get(
  '/teachers',
  page({
    module: 'teachers',
    title: 'Сотрудники',
    heading: 'Сотрудники',
    subheading: 'Учётные записи, роли, ставки и оклады',
  })
);

router.get(
  '/teachers/:id',
  page({
    module: 'teachers',
    view: 'teacher-card',
    title: 'Карточка сотрудника',
    heading: 'Карточка сотрудника',
    subheading: 'Профиль, начисление, ученики и статистика занятий',
    data: (req) => ({ teacherId: req.params.id }),
  })
);

router.get(
  '/schedule',
  page({
    module: 'schedule',
    title: 'Расписание',
    heading: 'Расписание',
    subheading: 'Календарь занятий и отметки о проведении',
  })
);

router.get(
  '/finance',
  page({
    module: 'finance',
    title: 'Финансы',
    heading: 'Финансы',
    subheading: 'Оборот, оплаты, расходы и начисления',
  })
);

router.get(
  '/profile',
  page({
    module: 'profile',
    title: 'Профиль',
    heading: 'Мой профиль',
    subheading: 'Личные данные, пароль и статистика',
  })
);

module.exports = router;
