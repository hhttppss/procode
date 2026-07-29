'use strict';

/**
 * Наполняет базу демонстрационными заявками, чтобы админку было на чём посмотреть.
 *
 *   node scripts/seed-demo.js            — добавить 10 заявок к тому, что уже есть
 *   node scripts/seed-demo.js --reset    — очистить базу и добавить 10 заявок
 *
 * Направления совпадают с каталогом на лендинге, возраст — 10–17 лет.
 */

const store = require('../server/store');

const DEMO_APPLICATIONS = [
  {
    daysAgo: 0,
    hour: 10,
    minute: 24,
    parentName: 'Анна Ковалёва',
    phone: '+79161234567',
    childName: 'Мирон',
    childAge: 11,
    course: 'Roblox Studio',
    comment: 'Сын целыми днями играет в Roblox, хочет делать свои карты. Удобнее заниматься после 17:00.',
    status: 'new',
    managerComment: '',
  },
  {
    daysAgo: 0,
    hour: 9,
    minute: 5,
    parentName: 'Дмитрий Соколов',
    phone: '+79031112233',
    childName: 'Алиса',
    childAge: 12,
    course: 'Python Junior',
    comment: 'Интересует подготовка к школьной олимпиаде по информатике.',
    status: 'new',
    managerComment: '',
  },
  {
    daysAgo: 1,
    hour: 19,
    minute: 8,
    parentName: 'Екатерина Лисовская',
    phone: '+79997654321',
    childName: 'Тимофей',
    childAge: 13,
    course: 'Создание сайтов',
    comment: '',
    status: 'thinking',
    managerComment: 'Смущает цена, обещала обсудить с мужем. Перезвонить в выходные.',
  },
  {
    daysAgo: 2,
    hour: 12,
    minute: 41,
    parentName: 'Ольга Мартынова',
    phone: '+79261010101',
    childName: 'Варвара',
    childAge: 15,
    course: 'UI/UX-дизайн',
    comment: 'Дочь много рисует, хочет попробовать дизайн приложений.',
    status: 'callback',
    managerComment: 'Просила набрать после 20:00 в будни.',
  },
  {
    daysAgo: 3,
    hour: 9,
    minute: 15,
    parentName: 'Сергей Гаврилов',
    phone: '+79052223344',
    childName: 'Егор',
    childAge: 10,
    course: 'Цифровая грамотность',
    comment: 'Друзья ходят к вам, ребёнок просится тоже.',
    status: 'agreed',
    managerComment: 'Вводный урок в понедельник в 18:00, тариф «Старт».',
  },
  {
    daysAgo: 4,
    hour: 21,
    minute: 3,
    parentName: 'Марина Белова',
    phone: '+79114445566',
    childName: 'Полина',
    childAge: 14,
    course: 'Веб-разработка (HTML, CSS, JavaScript)',
    comment: 'Дочь ведёт блог, хочет сделать сайт сама.',
    status: 'noanswer',
    managerComment: 'Два звонка — не берёт трубку. Написала в Telegram.',
  },
  {
    daysAgo: 6,
    hour: 14,
    minute: 52,
    parentName: 'Ильдар Хайруллин',
    phone: '+79876543210',
    childName: 'Амир',
    childAge: 16,
    course: 'Python Developer',
    comment: 'Хотим за год выйти на уровень для поступления в IT-класс.',
    status: 'agreed',
    managerComment: 'Взяли «Интенсив», преподаватель — Никита. Старт со следующей недели.',
  },
  {
    daysAgo: 8,
    hour: 16,
    minute: 30,
    parentName: 'Наталья Пименова',
    phone: '+79167778899',
    childName: 'Кира',
    childAge: 13,
    course: 'Основы ИИ (ChatGPT, Midjourney, нейросети)',
    comment: '',
    status: 'refused',
    managerComment: 'Выбрали кружок рядом с домом. Разрешила написать в сентябре.',
  },
  {
    daysAgo: 10,
    hour: 11,
    minute: 5,
    parentName: 'Павел Дроздов',
    phone: '+79993334455',
    childName: 'Матвей',
    childAge: 17,
    course: 'Предпринимательство',
    comment: 'Сын хочет запустить свой проект, ищем, где научат считать экономику.',
    status: 'thinking',
    managerComment: 'Отправила программу курса на почту, ждём ответа.',
  },
  {
    daysAgo: 12,
    hour: 18,
    minute: 47,
    parentName: 'Юлия Романенко',
    phone: '+79219998877',
    childName: 'София',
    childAge: 15,
    course: 'Unity Game Developer',
    comment: 'Дочка хочет делать игры, интересует портфолио на выходе.',
    status: 'agreed',
    managerComment: 'Тариф «Стандарт», занятия во вторник и четверг.',
  },
];

/** Собирает дату в прошлом; если время сегодняшнего дня ещё не наступило — сдвигает на сутки назад. */
function buildDate({ daysAgo, hour, minute }) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() > Date.now()) date.setDate(date.getDate() - 1);
  return date.toISOString();
}

async function main() {
  console.log('ВНИМАНИЕ: это тестовые (демонстрационные) заявки, а не реальные обращения с сайта.');

  const reset = process.argv.includes('--reset');

  await store.init();

  if (reset) {
    await store.replaceAll([]);
    console.log('База очищена: старые заявки удалены.');
  }

  for (const demo of DEMO_APPLICATIONS) {
    const createdAt = buildDate(demo);
    await store.create({
      createdAt,
      updatedAt: createdAt,
      parentName: demo.parentName,
      phone: demo.phone,
      childName: demo.childName,
      childAge: demo.childAge,
      course: demo.course,
      comment: demo.comment,
      status: demo.status,
      managerComment: demo.managerComment,
      source: 'demo',
    });
  }

  const all = await store.list();
  console.log(`Добавлено заявок: ${DEMO_APPLICATIONS.length}. Всего в базе: ${all.length}.`);
  console.log(`Файл: ${store.dataFile}`);
  console.log('Откройте /admin, чтобы посмотреть.');
  console.log('Перед публикацией сайта удалите демо-заявки в админке или очистите файл data/applications.json.');
}

main().catch((error) => {
  console.error('Не удалось создать демо-заявки:', error);
  process.exit(1);
});
