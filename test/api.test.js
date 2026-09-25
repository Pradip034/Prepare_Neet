import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, bank } from '../src/server.js';

let server, base;
before(async () => {
  server = createServer({ apiKey: '', corsOrigin: 'http://localhost:5173', dbPath: ':memory:' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));
const get = async path => (await fetch(base + path)).json();
const post = (body, raw = false) => fetch(base + '/api/v1/quiz/grade', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ? body : JSON.stringify(body)
});

test('preserves 300 source records and adds one original question for 300 playable questions', () => {
  assert.deepEqual(bank.questions.map(q => q.number), Array.from({ length: 301 }, (_, i) => i + 1));
  for (const q of bank.questions) {
    assert.ok(q.question && q.explanation && q.sourceAnswer);
    assert.ok(q.options.length >= 4);
    assert.ok(q.options.every(o => o.label && o.text));
    if (q.source.type !== 'supplemental') assert.equal(q.source.questionNumber, q.number);
  }
  assert.equal(bank.questions.filter(q => q.quality.quizEligible).length, 300);
});

test('preserves tables, numbered statements, five options, and Unicode', async () => {
  const q3 = (await get('/api/v1/questions/3')).data;
  assert.equal(q3.content[1].type, 'table');
  assert.deepEqual(q3.content[1].rows[3], ['S. Animalia', 'Eukaryotic', 'Cellulose']);
  assert.match(bank.questions[0].question, /1\. Prokaryotes/);
  assert.match(bank.questions[0].question, /4\. Organisms/);
  assert.equal(bank.questions[38].options.length, 5);
  assert.equal(bank.questions[38].correctOption, 'E');
  assert.ok(bank.questions.some(q => q.question.includes('CO₂')));
  assert.equal(bank.questions.flatMap(q => q.content).filter(b => b.type === 'table').length, 4);
});

test('study endpoint returns answers and honest null references', async () => {
  const result = await get('/api/v1/questions?limit=301');
  assert.equal(result.total, 301);
  assert.equal(result.data.length, 301);
  assert.equal(result.data[0].correctOption, 'A');
  assert.ok(result.data[0].reference.includes('Biological Classification'));
  assert.equal(result.data[49].reference, null);
  assert.equal(result.data[197].correctOption, null);
  assert.equal(result.data[197].quality.quizEligible, false);
});

test('quiz questions hide all answer-bearing fields and exclude invalid question', async () => {
  const { data, total } = await get('/api/v1/quiz/questions?limit=300&random=true');
  assert.equal(total, 300);
  assert.equal(new Set(data.map(q => q.number)).size, 300);
  assert.ok(data.some(q => q.number === 301 && q.origin === 'supplemental'));
  assert.ok(!data.some(q => q.number === 198));
  for (const q of data) {
    for (const key of ['correctOption', 'explanation', 'sourceAnswer', 'notes', 'reference']) assert.equal(key in q, false);
  }
});

test('pagination, range, search and errors', async () => {
  const result = await get('/api/v1/questions?from=10&to=20&page=2&limit=5');
  assert.equal(result.total, 11);
  assert.deepEqual(result.data.map(q => q.number), [15, 16, 17, 18, 19]);
  assert.ok((await get('/api/v1/questions?search=ribosome')).total > 0);
  for (const query of ['limit=0', 'page=abc', 'from=20&to=10', 'random=maybe', 'eligibleOnly=1', 'limit=302']) {
    assert.equal((await fetch(base + '/api/v1/questions?' + query)).status, 400);
  }
  assert.equal((await fetch(base + '/api/v1/questions/999')).status, 404);
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.equal((await fetch(base + '/api/v1/papers', { method: 'POST' })).status, 405);
});

test('grading supports correct, incorrect, skipped and fifth-option answers', async () => {
  const response = await post({ answers: [{ number: 1, selectedOption: 'A' },
    { number: 2, selectedOption: 'B' }, { number: 3, selectedOption: null }, { number: 39, selectedOption: 'E' }] });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.score, 7);
  assert.equal(result.maxScore, 16);
  assert.equal(result.correct, 2);
  assert.equal(result.unanswered, 1);
  assert.ok(result.results[0].explanation);
});

test('grading rejects malformed, duplicate, invalid and ungradable submissions', async () => {
  assert.equal((await post('{', true)).status, 400);
  assert.equal((await post({ answers: [] })).status, 400);
  assert.equal((await post({ answers: [{ number: 1, selectedOption: 'Z' }] })).status, 400);
  assert.equal((await post({ answers: [{ number: 1 }] })).status, 400);
  assert.equal((await post({ answers: [{ number: 999, selectedOption: 'A' }] })).status, 400);
  assert.equal((await post({ answers: [{ number: 198, selectedOption: 'A' }] })).status, 422);
  assert.equal((await post({ answers: [{ number: 1, selectedOption: 'A' }, { number: 1, selectedOption: 'B' }] })).status, 400);
  assert.equal((await post(JSON.stringify({ extra: 'x'.repeat(66000) }), true)).status, 413);
  assert.equal((await fetch(base + '/api/v1/quiz/grade', { method: 'POST', body: '{}' })).status, 415);
});

test('explicit CORS origin and preflight', async () => {
  const response = await fetch(base + '/api/v1/questions', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const denied = await fetch(base + '/health', { headers: { Origin: 'https://other.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('optional bearer authentication protects question and grading endpoints', async () => {
  const secured = createServer({ apiKey: 'test-secret', dbPath: ':memory:' });
  await new Promise(resolve => secured.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${secured.address().port}`;
  try {
    assert.equal((await fetch(url + '/health')).status, 200);
    assert.equal((await fetch(url + '/api/v1/questions')).status, 401);
    assert.equal((await fetch(url + '/api/v1/questions', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(url + '/api/v1/questions', { headers: { Authorization: 'Bearer test-secret' } })).status, 200);
  } finally { await new Promise(resolve => secured.close(resolve)); }
});

test('serves frontend and option artwork with correct MIME types', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css'], ['/stethoscope.svg', 'image/svg+xml']]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.ok((await response.text()).length > 20);
  }
  assert.equal((await fetch(base + '/src/server.js')).status, 404);
});

test('PDF report is generated from server grading with valid cross-reference offsets', async () => {
  const answers = bank.questions.filter(q => q.quality.quizEligible).map(q => ({ number: q.number, selectedOption: q.correctOption }));
  const response = await fetch(base + '/api/v1/quiz/report.pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.match(response.headers.get('content-disposition'), /attachment/);
  const pdf = await response.text();
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.match(pdf, /Score: 1200 \/ 1200/);
  assert.match(pdf, /\/Count 7/);
  const offset = Number(pdf.match(/startxref\n(\d+)/)[1]);
  assert.equal(pdf.slice(offset, offset + 4), 'xref');
  const invalid = await fetch(base + '/api/v1/quiz/report.pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: [{ number: 198, selectedOption: 'A' }] }) });
  assert.equal(invalid.status, 422);
});

test('supplemental question is reachable, has honest provenance, and grades normally', async () => {
  const { data: q } = await get('/api/v1/questions/301');
  assert.equal(q.correctOption, 'C');
  assert.equal(q.source.type, 'supplemental');
  assert.equal(q.source.file, null);
  assert.match(q.reference, /19\.2\.8/);
  assert.ok(q.explanation);
  const ranged = await get('/api/v1/quiz/questions?from=301&to=301');
  assert.equal(ranged.total, 1);
  const response = await post({ answers: [{ number: 301, selectedOption: 'C' }] });
  assert.equal((await response.json()).score, 4);
});
