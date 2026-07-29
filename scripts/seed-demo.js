'use strict';

/**
 * Демонстрационные данные: заявки, преподаватели, ученики, расписание, финансы.
 * Нужны, чтобы платформу было на чём посмотреть и чтобы проверить работу под обеими ролями.
 *
 *   node scripts/seed-demo.js            — добавить демо-данные к тому, что уже есть
 *   node scripts/seed-demo.js --reset    — очистить рабочие данные и создать демо заново
 *
 * Учётные записи владельца скрипт не трогает: --reset очищает заявки, учеников,
 * занятия, финансы, уведомления и историю, но не файл data/users.json.
 * Демо-преподаватели создаются с известными паролями — они нужны для проверки ролей.
 */

const models = require('../server/models');
const applications = require('../server/models/applications');
const audit = require('../server/models/audit');
const finance = require('../server/models/finance');
const lessons = require('../server/models/lessons');
const notifications = require('../server/models/notifications');
const students = require('../server/models/students');
const users = require('../server/models/users');

const DEMO_PASSWORD = 'demo12345';

// ------------------------------------------------------------------ даты

function pad(value) {
  return String(value).padStart(2, '0');
}

function toDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayOffset(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return toDay(date);
}

function isoOffset({ daysAgo = 0, hour = 12, minute = 0 }) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function weekdayOf(day) {
  const date = new Date(`${day}T00:00:00`);
  return date.getDay() === 0 ? 7 : date.getDay();
}

// ------------------------------------------------------------- содержимое

const DEMO_TEACHERS = [
  {
    login: 'orlova',
    name: 'Орлова Мария Сергеевна',
    phone: '+79161112233',
    email: 'orlova@prokod.example',
    courses: ['Python Junior', 'Python Developer'],
    rate: 900,
  },
  {
    login: 'kim',
    name: 'Ким Артём Денисович',
    phone: '+79262223344',
    email: 'kim@prokod.example',
    courses: ['Roblox Studio', 'Unity Game Developer'],
    rate: 850,
  },
  {
    login: 'volkova',
    name: 'Волкова Дарья Игоревна',
    phone: '+79033334455',
    email: 'volkova@prokod.example',
    courses: ['Создание сайтов', 'UI/UX-дизайн'],
    rate: 800,
  },
];

const DEMO_STUDENTS = [
  {
    name: 'Мирон Ковалёв', birthDate: '2015-03-12', course: 'Roblox Studio', group: 'Роблокс-пн-17:00',
    teacher: 'kim', status: 'active', weekday: 1, time: '17:00',
    parentName: 'Ковалёва Анна Петровна', parentPhone: '+79161234567', parentEmail: 'anna.k@example.com',
    lessonPrice: 1400,
    traits: { pace: 'Схватывает быстро, нужен запас задач на урок.', wishes: 'Хочет опубликовать свою игру для друзей.' },
  },
  {
    name: 'Алиса Соколова', birthDate: '2014-07-04', course: 'Python Junior', group: 'Питон-вт-16:00',
    teacher: 'orlova', status: 'active', weekday: 2, time: '16:00',
    parentName: 'Соколов Дмитрий Игоревич', parentPhone: '+79031112233', parentEmail: 'sokolov@example.com',
    lessonPrice: 1400,
    traits: { pace: 'Средний темп, важно проговаривать задачу вслух.', wishes: 'Готовится к школьной олимпиаде по информатике.' },
  },
  {
    name: 'Тимофей Лисовский', birthDate: '2013-11-20', course: 'Создание сайтов', group: 'Веб-ср-18:00',
    teacher: 'volkova', status: 'active', weekday: 3, time: '18:00',
    parentName: 'Лисовская Екатерина Юрьевна', parentPhone: '+79997654321', parentEmail: '',
    lessonPrice: 1400,
    traits: { behavior: 'Стесняется отвечать при новых людях, лучше идёт один на один.' },
  },
  {
    name: 'Варвара Мартынова', birthDate: '2012-05-30', course: 'UI/UX-дизайн', group: 'Дизайн-чт-17:00',
    teacher: 'volkova', status: 'active', weekday: 4, time: '17:00',
    parentName: 'Мартынова Ольга Львовна', parentPhone: '+79261010101', parentEmail: 'martynova@example.com',
    lessonPrice: 1500,
    traits: { wishes: 'Собирает портфолио для поступления в художественный колледж.' },
  },
  {
    name: 'Егор Дьяченко', birthDate: '2011-09-08', course: 'Python Developer', group: 'Питон-про-пн-19:00',
    teacher: 'orlova', status: 'active', weekday: 1, time: '19:00',
    parentName: 'Дьяченко Сергей Павлович', parentPhone: '+79154445566', parentEmail: 'dyachenko@example.com',
    lessonPrice: 1600,
    traits: { pace: 'Опережает программу, стоит давать дополнительные задачи.' },
  },
  {
    name: 'София Белова', birthDate: '2014-01-17', course: 'Roblox Studio', group: 'Роблокс-пн-17:00',
    teacher: 'kim', status: 'active', weekday: 1, time: '17:00',
    parentName: 'Белова Ирина Андреевна', parentPhone: '+79165556677', parentEmail: '',
    lessonPrice: 1400,
    traits: { health: 'Носит очки, важно крупно показывать код на экране.' },
  },
  {
    name: 'Лев Григорьев', birthDate: '2012-12-02', course: 'Unity Game Developer', group: 'Юнити-сб-12:00',
    teacher: 'kim', status: 'active', weekday: 6, time: '12:00',
    parentName: 'Григорьева Наталья Олеговна', parentPhone: '+79167778899', parentEmail: 'grigoreva@example.com',
    lessonPrice: 1600,
    traits: {},
  },
  {
    name: 'Ульяна Зотова', birthDate: '2015-06-25', course: 'Python Junior', group: 'Питон-вт-16:00',
    teacher: 'orlova', status: 'paused', weekday: 2, time: '16:00',
    parentName: 'Зотов Максим Русланович', parentPhone: '+79168889900', parentEmail: '',
    lessonPrice: 1400,
    traits: { wishes: 'Пауза до конца летних каникул, вернутся в сентябре.' },
  },
  {
    name: 'Даниил Ерохин', birthDate: '2010-04-14', course: 'Веб-разработка (HTML, CSS, JavaScript)', group: '',
    teacher: 'volkova', status: 'graduated', weekday: 5, time: '18:00',
    parentName: 'Ерохина Светлана Владимировна', parentPhone: '+79169990011', parentEmail: 'erohina@example.com',
    lessonPrice: 1600,
    traits: { wishes: 'Курс окончен, сделал портфолио из трёх сайтов.' },
  },
  {
    name: 'Ника Савельева', birthDate: '2013-08-19', course: 'Цифровая грамотность', group: '',
    teacher: '', status: 'expelled', weekday: 0, time: '',
    parentName: 'Савельев Роман Игоревич', parentPhone: '+79160001122', parentEmail: '',
    lessonPrice: 1200,
    traits: {},
  },
];

const DEMO_APPLICATIONS = [
  {
    daysAgo: 0, hour: 10, minute: 24,
    parentName: 'Анна Ковалёва', phone: '+79161234567', email: 'anna.k@example.com',
    childName: 'Мирон', childAge: 11, course: 'Roblox Studio',
    comment: 'Сын целыми днями играет в Roblox, хочет делать свои карты. Удобнее заниматься после 17:00.',
    status: 'new',
  },
  {
    daysAgo: 0, hour: 9, minute: 5,
    parentName: 'Дмитрий Соколов', phone: '+79031112233', email: '',
    childName: 'Алиса', childAge: 12, course: 'Python Junior',
    comment: 'Интересует подготовка к школьной олимпиаде по информатике.',
    status: 'new',
  },
  {
    daysAgo: 1, hour: 19, minute: 8,
    parentName: 'Екатерина Лисовская', phone: '+79997654321', email: '',
    childName: 'Тимофей', childAge: 13, course: 'Создание сайтов',
    comment: '', status: 'processing',
    managerComment: 'Смущает цена, обещала обсудить с мужем. Перезвонить в выходные.',
  },
  {
    daysAgo: 2, hour: 12, minute: 41,
    parentName: 'Ольга Мартынова', phone: '+79261010101', email: 'martynova@example.com',
    childName: 'Варвара', childAge: 14, course: 'UI/UX-дизайн',
    comment: 'Дочь рисует в Procreate, хочет попробовать интерфейсы.',
    status: 'trial', managerComment: 'Вводное назначено на пятницу, 17:00. Ссылку отправила.',
  },
  {
    daysAgo: 3, hour: 15, minute: 12,
    parentName: 'Сергей Дьяченко', phone: '+79154445566', email: 'dyachenko@example.com',
    childName: 'Егор', childAge: 15, course: 'Python Developer',
    comment: 'Уже проходил основы на курсах в школе, нужен уровень посильнее.',
    status: 'processing', managerComment: 'Позвонить после 18:00.',
  },
  {
    daysAgo: 4, hour: 11, minute: 3,
    parentName: 'Ирина Белова', phone: '+79165556677', email: '',
    childName: 'София', childAge: 12, course: 'Roblox Studio',
    comment: '', status: 'trial', managerComment: 'Вводное в четверг. Предупредить преподавателя про очки.',
  },
  {
    daysAgo: 6, hour: 20, minute: 47,
    parentName: 'Наталья Григорьева', phone: '+79167778899', email: 'grigoreva@example.com',
    childName: 'Лев', childAge: 14, course: 'Unity Game Developer',
    comment: 'Хочет делать игры «как в Стиме». Компьютер игровой, мощный.',
    status: 'processing', managerComment: 'Ждём ответа по расписанию на субботу.',
  },
  {
    daysAgo: 8, hour: 13, minute: 30,
    parentName: 'Максим Зотов', phone: '+79168889900', email: '',
    childName: 'Ульяна', childAge: 11, course: 'Python Junior',
    comment: 'Пробовали бесплатные уроки на видеохостинге, не пошло без преподавателя.',
    status: 'processing', managerComment: 'Уточнить, готовы ли заниматься дважды в неделю.',
  },
  {
    daysAgo: 11, hour: 16, minute: 18,
    parentName: 'Роман Савельев', phone: '+79160001122', email: '',
    childName: 'Ника', childAge: 13, course: 'Ещё не выбрали',
    comment: 'Не понимаем, что подойдёт. Нужна консультация.',
    status: 'refused', managerComment: 'Выбрали другую школу ближе к дому.',
  },
  {
    daysAgo: 14, hour: 10, minute: 2,
    parentName: 'Светлана Ерохина', phone: '+79169990011', email: 'erohina@example.com',
    childName: 'Даниил', childAge: 16, course: 'Веб-разработка (HTML, CSS, JavaScript)',
    comment: 'Готовимся к поступлению на программиста.',
    status: 'refused', managerComment: 'Взяли паузу до осени, договорились созвониться в августе.',
  },
];

const DEMO_EXPENSES = [
  { daysAgo: 12, category: 'marketing', amount: 18000, comment: 'Реклама в родительских сообществах' },
  { daysAgo: 20, category: 'software', amount: 4900, comment: 'Подписка на сервис видеосвязи' },
  { daysAgo: 5, category: 'other', amount: 2500, comment: 'Канцелярия и распечатка методичек' },
];

// ------------------------------------------------------------------ сборка

async function ensureTeachers() {
  const created = [];
  const byLogin = new Map();

  for (const demo of DEMO_TEACHERS) {
    let user = await users.getByLogin(demo.login);

    if (!user) {
      const result = await users.create({
        login: demo.login,
        password: DEMO_PASSWORD,
        role: 'teacher',
        name: demo.name,
        phone: demo.phone,
        email: demo.email,
        courses: demo.courses,
        rate: demo.rate,
      });

      if (!result.ok) throw new Error(Object.values(result.errors)[0]);
      user = result.user;
      created.push(user.login);
    }

    byLogin.set(demo.login, user);
  }

  return { created, byLogin };
}

/**
 * Заявки записываются целым списком, а не через create(): демо-заявкам нужны даты
 * в прошлом, а обычное создание всегда ставит текущий момент — и правильно делает,
 * иначе дату поступления заявки можно было бы подделать.
 */
async function seedApplications() {
  const existing = await applications.list();

  const drafts = DEMO_APPLICATIONS.map((demo) => {
    const createdAt = isoOffset(demo);
    return {
      createdAt,
      updatedAt: createdAt,
      parentName: demo.parentName,
      phone: demo.phone,
      email: demo.email,
      childName: demo.childName,
      childAge: demo.childAge,
      course: demo.course,
      comment: demo.comment,
      status: demo.status,
      managerComment: demo.managerComment || '',
      source: 'demo',
      history: [],
    };
  });

  await applications.replaceAll([...existing, ...drafts]);
  return drafts;
}

async function seedStudents(teachersByLogin) {
  const created = [];

  for (const demo of DEMO_STUDENTS) {
    const teacher = demo.teacher ? teachersByLogin.get(demo.teacher) : null;

    const student = await students.create({
      name: demo.name,
      birthDate: demo.birthDate,
      course: demo.course,
      group: demo.group,
      teacherId: teacher ? teacher.id : '',
      status: demo.status,
      startedAt: dayOffset(-90),
      parentName: demo.parentName,
      parentPhone: demo.parentPhone,
      parentEmail: demo.parentEmail,
      lessonPrice: demo.lessonPrice,
      traits: demo.traits,
    });

    created.push({ record: student, demo, teacher });
  }

  return created;
}

/** Занятия за последние шесть недель и на две недели вперёд, по одному в неделю на ученика. */
async function seedLessons(seededStudents) {
  const drafts = [];

  for (const { record, demo, teacher } of seededStudents) {
    if (!teacher || !demo.weekday || demo.status === 'expelled') continue;

    const seriesId = `sr_demo_${record.id}`;

    for (let offset = -42; offset <= 14; offset += 1) {
      const day = dayOffset(offset);
      if (weekdayOf(day) !== demo.weekday) continue;

      // Выпустившийся ученик занимался только в прошлом, приостановленный — до паузы.
      if (demo.status === 'graduated' && offset > -14) continue;
      if (demo.status === 'paused' && offset > -21) continue;

      const past = offset < 0;
      let status = 'planned';
      if (past) status = offset === -14 && demo.status === 'active' ? 'cancelled' : 'done';

      const attendance = {};
      if (status === 'done') attendance[record.id] = offset === -28 ? 'late' : 'present';

      drafts.push({
        date: day,
        startTime: demo.time,
        durationMin: 60,
        teacherId: teacher.id,
        studentIds: [record.id],
        title: demo.group,
        course: demo.course,
        format: 'online',
        link: 'https://meet.example.com/prokod-demo',
        status,
        teacherComment: status === 'done' ? 'Разобрали тему, задание выполнено.' : '',
        attendance,
        seriesId,
      });
    }
  }

  return lessons.createMany(drafts);
}

async function seedPayments(seededStudents, admin) {
  const created = [];

  for (const { record, demo } of seededStudents) {
    if (demo.status === 'expelled') continue;

    const dates = demo.status === 'active' ? [-35, -5] : [-45];
    for (const offset of dates) {
      created.push(
        await finance.payments.create({
          studentId: record.id,
          amount: demo.lessonPrice * 4,
          date: dayOffset(offset),
          method: 'card',
          lessonsPaid: 4,
          comment: 'Абонемент на 4 занятия',
          createdById: admin ? admin.id : '',
        })
      );
    }
  }

  return created;
}

async function seedExpenses(admin) {
  const created = [];

  for (const demo of DEMO_EXPENSES) {
    created.push(
      await finance.expenses.create({
        date: dayOffset(-demo.daysAgo),
        category: demo.category,
        amount: demo.amount,
        comment: demo.comment,
        createdById: admin ? admin.id : '',
      })
    );
  }

  return created;
}

async function reset() {
  await applications.replaceAll([]);
  await students.replaceAll([]);
  await lessons.replaceAll([]);
  await finance.payments.replaceAll([]);
  await finance.expenses.replaceAll([]);
  await notifications.replaceAll([]);
  await audit.replaceAll([]);
  console.log('Рабочие данные очищены (учётные записи сохранены).');
}

async function main() {
  const shouldReset = process.argv.includes('--reset');

  await models.init();
  if (shouldReset) await reset();

  const admins = await users.listByRole('admin');
  const admin = admins.find((user) => user.active) || null;

  const teachers = await ensureTeachers();
  const seededApplications = await seedApplications();
  const seededStudents = await seedStudents(teachers.byLogin);
  const seededLessons = await seedLessons(seededStudents);
  const seededPayments = await seedPayments(seededStudents, admin);
  const seededExpenses = await seedExpenses(admin);

  console.log('');
  console.log('  Демо-данные готовы');
  console.log(`  Заявок:      ${seededApplications.length}`);
  console.log(`  Учеников:    ${seededStudents.length}`);
  console.log(`  Занятий:     ${seededLessons.length}`);
  console.log(`  Оплат:       ${seededPayments.length}`);
  console.log(`  Расходов:    ${seededExpenses.length}`);
  console.log('');

  if (teachers.created.length > 0) {
    console.log('  Созданы демонстрационные преподаватели (пароль у всех одинаковый):');
    for (const login of teachers.created) console.log(`    логин: ${login}   пароль: ${DEMO_PASSWORD}`);
  } else {
    console.log(`  Демо-преподаватели уже существовали. Пароль по умолчанию: ${DEMO_PASSWORD}`);
  }
  console.log('');

  if (!admin) {
    console.log('  Администратора в базе нет — вход работает по ADMIN_LOGIN / ADMIN_PASSWORD из .env.');
    console.log('');
  }

  console.log('  Открыть платформу: http://localhost:3000/app');
  console.log('');
}

main().catch((error) => {
  console.error('Не удалось создать демо-данные:', error.message);
  process.exitCode = 1;
});
