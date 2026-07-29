'use strict';

/**
 * Конфигурация приложения.
 * Значения берутся из .env в корне проекта, поверх — переменные окружения процесса.
 * Внешних зависимостей (dotenv) нет: парсер простой построчный.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env');

const DEFAULT_PASSWORD = 'procode2025';
const PLACEHOLDER_SECRET = 'change-me-to-a-long-random-string';

function parseEnvFile(content) {
  const result = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!key) continue;

    let value = line.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    result[key] = value;
  }

  return result;
}

function loadEnvFile() {
  try {
    // Читается один раз при старте процесса, не в обработчике запроса.
    return parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Не удалось прочитать .env: ${error.message}. Используются значения по умолчанию.`);
    }
    return {};
  }
}

const fileEnv = loadEnvFile();
const warnings = [];

function read(key, fallback) {
  const fromProcess = process.env[key];
  if (typeof fromProcess === 'string' && fromProcess !== '') return fromProcess;

  const fromFile = fileEnv[key];
  if (typeof fromFile === 'string' && fromFile !== '') return fromFile;

  return fallback;
}

function readFlag(key) {
  return ['1', 'true', 'yes', 'on'].includes(String(read(key, '')).toLowerCase());
}

const port = Number.parseInt(read('PORT', '3000'), 10) || 3000;
const adminLogin = read('ADMIN_LOGIN', 'admin');
const adminPassword = read('ADMIN_PASSWORD', DEFAULT_PASSWORD);

let sessionSecret = read('SESSION_SECRET', '');
if (!sessionSecret || sessionSecret === PLACEHOLDER_SECRET) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  warnings.push(
    'SESSION_SECRET не задан в .env — сгенерирован временный секрет. ' +
      'После перезапуска сервера вход в админку придётся выполнить заново.'
  );
}

if (adminPassword === DEFAULT_PASSWORD) {
  warnings.push(
    `ADMIN_PASSWORD остался стандартным («${DEFAULT_PASSWORD}»). ` +
      'Перед публикацией сайта задайте свой пароль в файле .env.'
  );
}

function printWarnings() {
  if (warnings.length === 0) return;

  console.warn('');
  console.warn('  ⚠  ВНИМАНИЕ');
  for (const warning of warnings) {
    console.warn(`     • ${warning}`);
  }
  console.warn('');
}

module.exports = {
  rootDir: ROOT_DIR,
  port,
  adminLogin,
  adminPassword,
  sessionSecret,
  // Включайте TRUST_PROXY=1, только если сайт стоит за nginx/Caddy:
  // иначе клиент сможет подделать X-Forwarded-For и обойти лимиты по IP.
  trustProxy: readFlag('TRUST_PROXY'),
  warnings,
  printWarnings,
};
