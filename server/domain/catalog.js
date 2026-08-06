'use strict';

/**
 * Справочники предметной области: роли, направления, статусы.
 *
 * Единственный источник правды и для сервера (валидация, отчёты), и для интерфейса —
 * списки уезжают в браузер вместе со страницей, поэтому подписи нигде не дублируются.
 */

// ------------------------------------------------------------------- роли

/** Порядок — по убыванию полномочий: он же порядок в выпадающих списках интерфейса. */
const ROLES = [
  { id: 'admin', label: 'Администратор' },
  { id: 'manager', label: 'Управляющий школы' },
  { id: 'teacher', label: 'Преподаватель' },
];

const ROLE_IDS = ROLES.map((role) => role.id);

// ------------------------------------------------------------ направления

/** Совпадает с каталогом на лендинге: заявка приходит с точным названием направления. */
const COURSES = [
  'Roblox Studio',
  'Создание сайтов',
  'Python Junior',
  'Цифровая грамотность',
  'Python Developer',
  'Веб-разработка (HTML, CSS, JavaScript)',
  'Unity Game Developer',
  'Основы ИИ (ChatGPT, Midjourney, нейросети)',
  'Предпринимательство',
  'UI/UX-дизайн',
];

// -------------------------------------------------------- статусы заявок

/**
 * Воронка обработки заявки: Новая → В обработке → Назначено вводное → Зачислен / Отказ.
 * tone — имя цветовой темы; классы перечислены буквально в CSS и в клиентском коде,
 * потому что Tailwind собирает стили по тексту исходников.
 */
const APPLICATION_STATUSES = [
  { id: 'new', label: 'Новая', tone: 'cobalt' },
  { id: 'processing', label: 'В обработке', tone: 'apricot' },
  { id: 'trial', label: 'Назначено вводное', tone: 'violet' },
  { id: 'enrolled', label: 'Ученик зачислен', tone: 'mint' },
  { id: 'refused', label: 'Отказ', tone: 'red' },
];

const APPLICATION_STATUS_IDS = APPLICATION_STATUSES.map((status) => status.id);
const DEFAULT_APPLICATION_STATUS = 'new';

/**
 * Старые статусы первой версии админки → новая воронка.
 * Нужен при миграции data/applications.json; после неё в базе только новые значения.
 */
const LEGACY_APPLICATION_STATUS = {
  new: 'new',
  thinking: 'processing',
  callback: 'processing',
  noanswer: 'processing',
  agreed: 'trial',
  refused: 'refused',
};

// ------------------------------------------------------- статусы учеников

const STUDENT_STATUSES = [
  { id: 'active', label: 'Активен', tone: 'mint' },
  { id: 'paused', label: 'Приостановлен', tone: 'apricot' },
  { id: 'expelled', label: 'Отчислен', tone: 'red' },
  { id: 'graduated', label: 'Выпустился', tone: 'cobalt' },
];

const STUDENT_STATUS_IDS = STUDENT_STATUSES.map((status) => status.id);
const DEFAULT_STUDENT_STATUS = 'active';

// ------------------------------------------------------- статусы занятий

const LESSON_STATUSES = [
  { id: 'planned', label: 'Запланировано', tone: 'cobalt' },
  { id: 'done', label: 'Проведено', tone: 'mint' },
  { id: 'cancelled', label: 'Отменено', tone: 'red' },
  { id: 'moved', label: 'Перенесено', tone: 'apricot' },
];

const LESSON_STATUS_IDS = LESSON_STATUSES.map((status) => status.id);
const DEFAULT_LESSON_STATUS = 'planned';

const LESSON_FORMATS = [
  { id: 'online', label: 'Онлайн' },
  { id: 'offline', label: 'Оффлайн' },
];

const LESSON_FORMAT_IDS = LESSON_FORMATS.map((format) => format.id);

// ---------------------------------------------------------- посещаемость

const ATTENDANCE = [
  { id: 'present', label: 'Был', tone: 'mint' },
  { id: 'late', label: 'Опоздал', tone: 'apricot' },
  { id: 'absent', label: 'Пропустил', tone: 'red' },
];

const ATTENDANCE_IDS = ATTENDANCE.map((item) => item.id);

// ------------------------------------------------------------- финансы

const PAYMENT_METHODS = [
  { id: 'card', label: 'Карта' },
  { id: 'cash', label: 'Наличные' },
  { id: 'transfer', label: 'Перевод' },
  { id: 'other', label: 'Другое' },
];

const PAYMENT_METHOD_IDS = PAYMENT_METHODS.map((method) => method.id);

const EXPENSE_CATEGORIES = [
  // id менять нельзя: он уже лежит в записях расходов и по нему ищутся проведённые
  // начисления. Подпись общая — в эту категорию попадают и ставки преподавателей,
  // и оклады управляющих и администраторов.
  { id: 'payroll', label: 'Зарплата сотрудникам' },
  { id: 'marketing', label: 'Реклама и продвижение' },
  { id: 'software', label: 'Сервисы и лицензии' },
  { id: 'other', label: 'Прочее' },
];

const EXPENSE_CATEGORY_IDS = EXPENSE_CATEGORIES.map((category) => category.id);

// ----------------------------------------------------------------- утилиты

function labelOf(list, id) {
  const found = list.find((item) => item.id === id);
  return found ? found.label : id || '';
}

/** Набор справочников, который страница отдаёт в браузер. */
function clientCatalog() {
  return {
    roles: ROLES,
    courses: COURSES,
    applicationStatuses: APPLICATION_STATUSES,
    studentStatuses: STUDENT_STATUSES,
    lessonStatuses: LESSON_STATUSES,
    lessonFormats: LESSON_FORMATS,
    attendance: ATTENDANCE,
    paymentMethods: PAYMENT_METHODS,
    expenseCategories: EXPENSE_CATEGORIES,
  };
}

module.exports = {
  ROLES,
  ROLE_IDS,
  COURSES,
  APPLICATION_STATUSES,
  APPLICATION_STATUS_IDS,
  DEFAULT_APPLICATION_STATUS,
  LEGACY_APPLICATION_STATUS,
  STUDENT_STATUSES,
  STUDENT_STATUS_IDS,
  DEFAULT_STUDENT_STATUS,
  LESSON_STATUSES,
  LESSON_STATUS_IDS,
  DEFAULT_LESSON_STATUS,
  LESSON_FORMATS,
  LESSON_FORMAT_IDS,
  ATTENDANCE,
  ATTENDANCE_IDS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_IDS,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_IDS,
  labelOf,
  clientCatalog,
};
