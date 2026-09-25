import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createReportPdf } from './report.js';
import { openAccounts } from './accounts.js';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/enhancements.css', ['enhancements.css', 'text/css; charset=utf-8']],
  ['/stethoscope.svg', ['stethoscope.svg', 'image/svg+xml']]
]);

export const bank = JSON.parse(readFileSync(new URL('../data/questions.json', import.meta.url), 'utf8'));
const byNumber = new Map(bank.questions.map(q => [q.number, q]));
const maxQuestionNumber = Math.max(...bank.questions.map(q => q.number));
const fail = (status, message) => Object.assign(new Error(message), { status });

function integer(value, fallback, min, max, name) {
  if (value === null || value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw fail(400, `${name} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

function boolean(value, fallback, name) {
  if (value === null) return fallback;
  if (value !== 'true' && value !== 'false') throw fail(400, `${name} must be true or false`);
  return value === 'true';
}

function publicQuestion(q) {
  return { id: q.id, paperId: q.paperId, number: q.number, question: q.question,
    content: q.content, options: q.options, origin: q.source.type === 'supplemental' ? 'supplemental' : 'document' };
}

async function readBody(req) {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw fail(415, 'Content-Type must be application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw fail(413, 'JSON body exceeds 64 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'Invalid JSON body'); }
}

function grade(body) {
  if (!body || !Array.isArray(body.answers) || body.answers.length < 1 || body.answers.length > 300) {
    throw fail(400, 'answers must contain between 1 and 300 entries');
  }
  const seen = new Set();
  const results = body.answers.map(answer => {
    if (!answer || !Number.isInteger(answer.number)) throw fail(400, 'Each answer needs an integer number');
    const q = byNumber.get(answer.number);
    if (!q) throw fail(400, `Unknown question ${answer.number}`);
    if (seen.has(q.number)) throw fail(400, `Duplicate question ${q.number}`);
    seen.add(q.number);
    if (!q.quality.quizEligible) throw fail(422, `Question ${q.number} has no valid source answer and cannot be scored`);
    const selected = answer.selectedOption;
    if (selected !== null && !q.options.some(o => o.label === selected)) {
      throw fail(400, `Question ${q.number}: selectedOption must be an available uppercase label or null`);
    }
    const status = selected === null ? 'unanswered' : selected === q.correctOption ? 'correct' : 'incorrect';
    return { number: q.number, selectedOption: selected, status,
      points: status === 'correct' ? 4 : status === 'incorrect' ? -1 : 0,
      correctOption: q.correctOption, explanation: q.explanation, reference: q.reference,
      source: q.source };
  });
  return { total: results.length, correct: results.filter(r => r.status === 'correct').length,
    incorrect: results.filter(r => r.status === 'incorrect').length,
    unanswered: results.filter(r => r.status === 'unanswered').length,
    score: results.reduce((s, r) => s + r.points, 0), maxScore: results.length * 4,
    scoring: { correct: 4, incorrect: -1, unanswered: 0 }, results };
}

export function createServer({ apiKey = process.env.API_KEY ?? '', corsOrigin = process.env.CORS_ORIGIN ?? '',
  dbPath = process.env.DB_PATH ?? fileURLToPath(new URL('../storage/practice.sqlite', import.meta.url)),
  secureCookies = process.env.NODE_ENV === 'production' } = {}) {
  const accounts = openAccounts(dbPath);
  const cookie = (token, age = 604800) => `neet_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secureCookies ? '; Secure' : ''}`;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');
    if (corsOrigin && req.headers.origin === corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    const send = (status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (path === '/health' && req.method === 'GET') return send(200, { status: 'ok', questions: bank.questions.length });
      if (staticFiles.has(path) && req.method === 'GET') {
        const [file, type] = staticFiles.get(path);
        res.setHeader('Content-Type', type);
        res.writeHead(200);
        return res.end(readFileSync(new URL(`../public/${file}`, import.meta.url)));
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
        const expectedOrigin = process.env.APP_ORIGIN ?? `${secureCookies ? 'https' : 'http'}://${req.headers.host}`;
        if (req.headers.origin !== expectedOrigin) throw fail(403, 'Cross-origin form submission is not allowed.');
      }
      const token = (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith('neet_session='))?.slice('neet_session='.length);
      const user = accounts.user(token);
      if (path === '/api/v1/auth/me' && req.method === 'GET') return send(200, { user });
      if (['/api/v1/auth/register', '/api/v1/auth/login'].includes(path) && req.method === 'POST') {
        const body = await readBody(req);
        const account = path.endsWith('register') ? await accounts.register(body, req.socket.remoteAddress) : await accounts.login(body, req.socket.remoteAddress);
        accounts.logout(token);
        res.setHeader('Set-Cookie', cookie(accounts.issueSession(account.id)));
        return send(path.endsWith('register') ? 201 : 200, { user: account });
      }
      if (path === '/api/v1/auth/logout' && req.method === 'POST') {
        accounts.logout(token); res.setHeader('Set-Cookie', cookie('', 0)); return send(200, { user: null });
      }
      if (path === '/api/v1/practices' || path.startsWith('/api/v1/practices/')) {
        if (!user) throw fail(401, 'Please sign in to access saved practice records.');
        if (path === '/api/v1/practices' && req.method === 'GET') return send(200, { data: accounts.list(user.id) });
        if (path === '/api/v1/practices' && req.method === 'POST') {
          const body = await readBody(req), numbers = body?.questionNumbers;
          if (!Array.isArray(numbers) || !numbers.length || numbers.length > 300 || new Set(numbers).size !== numbers.length || numbers.some(n => !Number.isInteger(n) || !byNumber.get(n)?.quality.quizEligible)) {
            throw fail(400, 'Choose 1–300 unique, scorable question numbers.');
          }
          return send(201, { data: accounts.createPractice(user.id, numbers) });
        }
        const match = path.match(/^\/api\/v1\/practices\/([a-f0-9-]{36})(?:\/(answers|finish|report.pdf))?$/);
        if (!match) throw fail(404, 'Endpoint not found');
        const [, id, action] = match;
        // Ownership is checked before any grading or data is returned.
        const practice = accounts.practice(user.id, id);
        if (!action && req.method === 'GET') return send(200, { data: {
          ...practice, questions: practice.questionNumbers.map(n => publicQuestion(byNumber.get(n)))
        } });
        if (action === 'answers' && req.method === 'POST') {
          const answer = await readBody(req);
          if (!['answered', 'skipped', 'timeout'].includes(answer?.reason) || (answer.reason === 'answered') !== (answer.selectedOption !== null)) throw fail(400, 'Answer reason must match the selection.');
          const graded = grade({ answers: [answer] }).results[0];
          return send(200, { results: [accounts.answer(user.id, id, answer, graded)] });
        }
        if (action === 'finish' && req.method === 'POST') return send(200, { data: accounts.finish(user.id, id) });
        if (action === 'report.pdf' && req.method === 'GET') {
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', 'attachment; filename="neet-quiz-report.pdf"');
          res.writeHead(200); return res.end(createReportPdf(practice.report));
        }
        throw fail(405, 'Method not allowed');
      }
      if (apiKey && !(user && path.startsWith('/api/v1/quiz/'))) {
        const expected = Buffer.from(`Bearer ${apiKey}`);
        const actual = Buffer.from(req.headers.authorization ?? '');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          res.setHeader('WWW-Authenticate', 'Bearer');
          throw fail(401, 'A valid bearer API key is required');
        }
      }
      if (path === '/' && req.method === 'GET') return send(200, {
        name: 'NEET Quiz API', version: '1.0.0', endpoints: ['/health', '/api/v1/papers',
          '/api/v1/questions', '/api/v1/questions/1', '/api/v1/quiz/questions', '/api/v1/quiz/grade'],
        note: 'Study endpoints include answers. Quiz endpoints omit answers until grading. See README.md.'
      });
      if (path === '/api/v1/papers' && req.method === 'GET') return send(200, { data: [{
        id: bank.paperId, title: bank.title, totalQuestions: bank.questions.length,
        quizEligible: bank.questions.filter(q => q.quality.quizEligible).length,
        missingReferences: bank.questions.filter(q => !q.reference).length,
        sourceFile: bank.sourceFile, sourceSha256: bank.sourceSha256
      }] });
      if (['/api/v1/questions', '/api/v1/quiz/questions'].includes(path) && req.method === 'GET') {
        const params = url.searchParams;
        const quiz = path.includes('/quiz/');
        const eligible = quiz || boolean(params.get('eligibleOnly'), false, 'eligibleOnly');
        const page = integer(params.get('page'), 1, 1, 100000, 'page');
        const limit = integer(params.get('limit'), 20, 1, bank.questions.length, 'limit');
        const from = integer(params.get('from'), 1, 1, maxQuestionNumber, 'from');
        const to = integer(params.get('to'), maxQuestionNumber, 1, maxQuestionNumber, 'to');
        if (from > to) throw fail(400, 'from must not exceed to');
        const random = boolean(params.get('random'), false, 'random');
        const search = (params.get('search') ?? '').toLowerCase();
        let items = bank.questions.filter(q => q.number >= from && q.number <= to &&
          (!eligible || q.quality.quizEligible) && (!search ||
            `${q.question} ${q.options.map(o => o.text).join(' ')}`.toLowerCase().includes(search)));
        if (random) {
          for (let i = items.length - 1; i > 0; i--) {
            const j = randomInt(i + 1);
            [items[i], items[j]] = [items[j], items[i]];
          }
        }
        const total = items.length;
        items = items.slice((page - 1) * limit, page * limit);
        return send(200, { paperId: bank.paperId, page, limit, total,
          totalPages: Math.ceil(total / limit), data: quiz ? items.map(publicQuestion) : items });
      }
      const detail = path.match(/^\/api\/v1\/questions\/(\d+)$/);
      if (detail && req.method === 'GET') {
        const q = byNumber.get(Number(detail[1]));
        if (!q) throw fail(404, 'Question not found');
        return send(200, { data: q });
      }
      if (path === '/api/v1/quiz/grade' && req.method === 'POST') return send(200, grade(await readBody(req)));
      if (path === '/api/v1/quiz/report.pdf' && req.method === 'POST') {
        const pdf = createReportPdf(grade(await readBody(req)));
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="neet-quiz-report.pdf"');
        res.writeHead(200);
        return res.end(pdf);
      }
      const known = ['/', '/health', '/api/v1/papers', '/api/v1/questions',
        '/api/v1/quiz/questions', '/api/v1/quiz/grade', '/api/v1/quiz/report.pdf'].includes(path) || detail;
      if (known) {
        res.setHeader('Allow', /\/(grade|report.pdf)$/.test(path) ? 'POST, OPTIONS' : 'GET, OPTIONS');
        throw fail(405, 'Method not allowed');
      }
      throw fail(404, 'Endpoint not found');
    } catch (error) {
      if (!res.headersSent) send(error.status ?? 500, { error: {
        status: error.status ?? 500, message: error.status ? error.message : 'Internal server error' } });
      else res.end();
    }
  });
  server.on('close', () => accounts.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = integer(process.env.PORT, 3000, 1, 65535, 'PORT');
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`NEET Quiz API: http://${host}:${port} (${bank.questions.length} questions)`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
