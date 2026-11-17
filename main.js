'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');   // лише promise-версія fs
const path = require('node:path');
const { once } = require('node:events'); 
const { program, InvalidArgumentError } = require('commander');

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

// єдиний дозволений колбек, це обробник запиту, тому він async
const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_METHODS.includes(req.method)) {
      return send(res, 405, `Метод ${req.method} не підтримується\n`, {
        Allow: ALLOWED_METHODS.join(', '),
      });
    }
    return send(res, 501, 'Ще не реалізовано\n');
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