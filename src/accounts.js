import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const deriveKey = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const publicUser = user => ({ id: user.id, identifier: user.identifier, kind: user.kind, verified: false });

export function normalizeIdentifier(input) {
  if (typeof input !== 'string' || input.length > 254) throw fail(400, 'Enter a valid email or mobile number.');
  const value = input.trim();
  if (value.includes('@')) {
    if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value) || value.includes('..')) {
      throw fail(400, 'Enter a valid email address.');
    }
    return { identifier: value.toLowerCase(), kind: 'email' };
  }
  const mobile = value.replace(/[\s()-]/g, '');
  if (/^[6-9]\d{9}$/.test(mobile)) return { identifier: `+91${mobile}`, kind: 'mobile' };
  if (!/^\+[1-9]\d{7,14}$/.test(mobile) || (mobile.startsWith('+91') && !/^\+91[6-9]\d{9}$/.test(mobile))) {
    throw fail(400, 'Use a valid 10-digit Indian mobile number, or an international number with +country code (8–15 digits).');
  }
  return { identifier: mobile, kind: 'mobile' };
}

export function openAccounts(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, identifier TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS practices(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), question_numbers TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL DEFAULT 'in_progress');
    CREATE TABLE IF NOT EXISTS practice_answers(practice_id TEXT NOT NULL REFERENCES practices(id), number INTEGER NOT NULL, selected_option TEXT, reason TEXT NOT NULL, result TEXT NOT NULL, answered_at INTEGER NOT NULL, PRIMARY KEY(practice_id,number));
    CREATE INDEX IF NOT EXISTS user_practices ON practices(user_id, started_at);
  `);
  const attempts = new Map();
  function rateLimit(key) {
    const now = Date.now();
    for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
    const item = attempts.get(key) ?? { count: 0, until: now + 15 * 60000 };
    if (++item.count > 25) throw fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
    attempts.set(key, item);
  }
  const api = {
    close: () => db.close(),
    async register(body, ip) {
      rateLimit(`ip:${ip}`);
      const identity = normalizeIdentifier(body?.identifier);
      const password = body?.password;
      if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw fail(400, 'Use a password between 10 and 128 characters.');
      const salt = randomBytes(16).toString('hex');
      const key = await deriveKey(password, salt, 64, { N: 16384, r: 8, p: 1 });
      const user = { id: randomUUID(), ...identity };
      try {
        db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(user.id, user.identifier, user.kind, salt, key.toString('hex'), Date.now());
      } catch (error) {
        if (error.code?.includes('CONSTRAINT') || error.message.includes('UNIQUE')) throw fail(409, 'An account already uses this email or mobile. Please sign in.');
        throw error;
      }
      return publicUser(user);
    },
    async login(body, ip) {
      rateLimit(`ip:${ip}`);
      const { identifier } = normalizeIdentifier(body?.identifier);
      rateLimit(`account:${hash(identifier)}`);
      if (typeof body?.password !== 'string' || body.password.length > 128) throw fail(401, 'Email/mobile or password is incorrect.');
      const user = db.prepare('SELECT * FROM users WHERE identifier=?').get(identifier);
      // Derive even for missing accounts so a failed login takes a similar time.
      const candidate = await deriveKey(body.password, user?.salt ?? '00000000000000000000000000000000', 64, { N: 16384, r: 8, p: 1 });
      if (!user || !timingSafeEqual(candidate, Buffer.from(user.password_hash, 'hex'))) throw fail(401, 'Email/mobile or password is incorrect.');
      return publicUser(user);
    },
    issueSession(userId) {
      const token = randomBytes(32).toString('hex');
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), userId, Date.now() + 7 * 86400000);
      return token;
    },
    user(token) {
      if (!token) return null;
      const user = db.prepare('SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(token), Date.now());
      return user ? publicUser(user) : null;
    },
    logout(token) { if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token)); },
    createPractice(userId, questionNumbers) {
      const id = randomUUID();
      db.prepare('INSERT INTO practices(id,user_id,question_numbers,started_at) VALUES (?,?,?,?)').run(id, userId, JSON.stringify(questionNumbers), Date.now());
      return api.practice(userId, id);
    },
    practice(userId, id) {
      const row = db.prepare('SELECT * FROM practices WHERE user_id=? AND id=?').get(userId, id);
      if (!row) throw fail(404, 'Practice not found.');
      const questions = JSON.parse(row.question_numbers);
      const saved = db.prepare('SELECT * FROM practice_answers WHERE practice_id=? ORDER BY answered_at,number').all(id);
      const results = saved.map(a => ({ ...JSON.parse(a.result), reason: a.reason }));
      return { id: row.id, startedAt: row.started_at, finishedAt: row.finished_at, status: row.status, questionNumbers: questions,
        answers: saved.map(a => ({ number: a.number, selectedOption: a.selected_option, reason: a.reason })),
        report: { total: results.length, correct: results.filter(r => r.status === 'correct').length,
          incorrect: results.filter(r => r.status === 'incorrect').length, unanswered: results.filter(r => r.status === 'unanswered').length,
          score: results.reduce((s, r) => s + r.points, 0), maxScore: results.length * 4,
          scoring: { correct: 4, incorrect: -1, unanswered: 0 }, results } };
    },
    answer(userId, id, answer, result) {
      const practice = api.practice(userId, id);
      if (!practice.questionNumbers.includes(answer.number)) throw fail(400, 'Question is not in this practice.');
      const existing = practice.answers.find(a => a.number === answer.number);
      if (existing) {
        if (existing.selectedOption !== answer.selectedOption || existing.reason !== answer.reason) throw fail(409, 'This answer has already been recorded.');
        return practice.report.results.find(r => r.number === answer.number);
      }
      if (practice.status !== 'in_progress') throw fail(409, 'This practice has already finished.');
      db.prepare('INSERT INTO practice_answers VALUES (?,?,?,?,?,?)').run(id, answer.number, answer.selectedOption, answer.reason, JSON.stringify(result), Date.now());
      return { ...result, reason: answer.reason };
    },
    finish(userId, id) {
      const practice = api.practice(userId, id);
      if (!practice.answers.length) throw fail(400, 'Answer or skip a question before finishing.');
      db.prepare("UPDATE practices SET status='completed',finished_at=COALESCE(finished_at,?) WHERE id=? AND user_id=?").run(Date.now(), id, userId);
      return api.practice(userId, id);
    },
    list(userId) {
      return db.prepare('SELECT id FROM practices WHERE user_id=? ORDER BY started_at DESC LIMIT 100').all(userId).map(row => {
        const p = api.practice(userId, row.id);
        return { id: p.id, startedAt: p.startedAt, finishedAt: p.finishedAt, status: p.status,
          selectedCount: p.questionNumbers.length, total: p.report.total, score: p.report.score, maxScore: p.report.maxScore,
          correct: p.report.correct, incorrect: p.report.incorrect, unanswered: p.report.unanswered };
      });
    }
  };
  return api;
}
