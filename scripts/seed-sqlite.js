'use strict';

/**
 * Демо-данные в базу SQLite, каким бы ни был DATABASE_ENGINE в .env.
 *
 *   npm run seed:sqlite              — добавить демо-данные
 *   npm run seed:sqlite -- --reset   — очистить рабочие данные и создать демо заново
 *
 * Обёртка нужна из-за окружения: `DATABASE_ENGINE=sqlite node …` работает в POSIX-оболочке
 * и не работает в cmd.exe, а тянуть ради одной переменной cross-env незачем.
 * Отдельный процесс, а не require: seed-demo.js запускает себя только при прямом вызове
 * (проверка require.main === module).
 *
 * Не запускайте параллельно с работающим сервером: обе стороны пишут в один файл
 * data/app.sqlite через собственную очередь внутри своего процесса, но между процессами
 * порядок записи ничем не гарантирован — можно потерять чужие изменения. Остановите
 * сервер перед сидированием и запустите его заново после.
 */

const path = require('path');
const { fork } = require('child_process');

const target = path.join(__dirname, 'seed-demo.js');

const child = fork(target, process.argv.slice(2), {
  env: { ...process.env, DATABASE_ENGINE: 'sqlite' },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 0;
});

child.on('error', (error) => {
  console.error(`Не удалось запустить ${target}: ${error.message}`);
  process.exitCode = 1;
});
