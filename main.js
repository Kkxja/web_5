'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');   // лише promise-версія fs
const path = require('node:path');
const { once } = require('node:events'); 
const { program, InvalidArgumentError } = require('commander');
const superagent = require('superagent');

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError('порт має бути цілим числом від 0 до 65535');
  }
  return port;
}

program
  .helpOption('--help', 'показати довідку')
  .requiredOption('-h, --host <address>', 'адреса, на якій працює сервер')
  .requiredOption('-p, --port <number>', 'порт сервера', parsePort)
  .requiredOption('-c, --cache <path>', 'шлях до теки з кешем картинок');

program.parse(process.argv);
const options = program.opts();   // { host, port, cache }

const CACHE_DIR = path.resolve(options.cache);        // абсолютний шлях до теки кешу
const ALLOWED_METHODS = ['GET', 'PUT', 'DELETE'];

// універсальна відправка відповіді: статус, тіло, заголовки
function send(res, status, body = '', headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
    ...headers,
  });
  res.end(payload);
}

function parseCode(req) {
  const { pathname } = new URL(req.url, 'http://localhost');  // відкидаємо ?query
  const match = /^\/(\d{3})$/.exec(pathname);
  return match ? match[1] : null;
}

function cacheFile(code) {
  return path.join(CACHE_DIR, `${code}.jpg`);   // один код = один файл
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);                // шматки приходять як Buffer
  }
  return Buffer.concat(chunks);        // склеюємо в один Buffer, байти не змінюються
}

// rename атомарний, тому інші запити бачать або старий файл, або повний новий
async function writeCache(code, data) {
  const target = cacheFile(code);
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});   // прибираємо тимчасовий файл при збої
    throw err;
  }
}

// Повертає Buffer з картинкою або null при помилці
async function fetchFromHttpCat(code) {
  try {
    const response = await superagent
      .get(`https://http.cat/${code}`)
      .buffer(true)
      .parse(superagent.parse.image)                   // тіло відповіді як Buffer, без змін
      .timeout({ response: 5000, deadline: 10000 });   // щоб запит не висів вічно

    const type = response.headers['content-type'] || '';
    if (!type.startsWith('image/') || !Buffer.isBuffer(response.body) || response.body.length === 0) {
      return null;                                     // прийшло не зображення
    }
    return response.body;
  } catch (err) {
    // superagent відхиляє проміс на 4xx/5xx (є err.status), на мережевих помилках і таймаутах
    return null;
  }
}

async function handleGet(res, code) {
    try {
    const cached = await fs.readFile(cacheFile(code));
    return send(res, 200, cached, { 'Content-Type': 'image/jpeg', 'X-Image-Source': 'cache' });
    }
    catch (err) {
    if (err.code !== 'ENOENT') throw err;    // ENOENT пропускаємо далі - це промах кешу
    }

    const image = await fetchFromHttpCat(code);
    if (!image) {
        return send(res, 404, `Картинку для коду ${code} не знайдено\n`);  // у кеш нічого не пишемо
    }

    await writeCache(code, image);             // зберігаємо в кеш
    return send(res, 200, image, {             // віддаємо клієнтові
        'Content-Type': 'image/jpeg',
        'X-Image-Source': 'http.cat',
    });
}

async function handlePut(req, res, code) {
  const body = await readBody(req);
  if (body.length === 0) {
    return send(res, 400, 'Тіло запиту порожнє: очікується двійкове зображення\n');
  }
  await writeCache(code, body);        // записує нову або замінює наявну картинку
  return send(res, 201, `Картинку для коду ${code} збережено в кеш\n`);
}

// єдиний дозволений колбек, це обробник запиту, тому він async
const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_METHODS.includes(req.method)) {
      return send(res, 405, `Метод ${req.method} не підтримується\n`, {
        Allow: ALLOWED_METHODS.join(', '),
      });
    }

    const code = parseCode(req);
    if (!code) {
      return send(res, 400, 'Некоректний шлях: очікується /<код з трьох цифр>, наприклад /404\n');
    }

    switch (req.method) {
        case 'GET':
            return await handleGet(res, code);
        case 'PUT':
            return await handlePut(req, res, code);
         default:
            return send(res, 501, 'Ще не реалізовано\n');
    }

  } catch (err) {
    console.error('Помилка обробки запиту:', err);
    if (!res.headersSent) send(res, 500, 'Внутрішня помилка сервера\n');
    else res.end();
  }
});

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true });  // не помилка, якщо тека вже є
  server.listen(options.port, options.host);       // host і port з командного рядка
  await once(server, 'listening');                 // проміс виконається, коли сервер слухає
                                                   // відхилиться, якщо буде 'error' (порт зайнято)
  console.log(`Сервер: http://${options.host}:${options.port}, кеш: ${CACHE_DIR}`);
}

main().catch((err) => {
  console.error('Не вдалося запустити сервер:', err.message);
  process.exit(1);
});