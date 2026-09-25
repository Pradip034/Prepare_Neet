const $ = id => document.getElementById(id);
let questions = [], index = 0, answers = [], results = [], score = 0;
let phase = 'setup', deadline = 0, interval, apiKey = '', pending = null, report = null, startedAt;
let advanceTimer, scoreAnimation, speechSequence = 0;
let currentUser = null, activePracticeId = null, authMode = 'login', finishedAt = null;
const speechSupported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
const notice = text => { $('notice').textContent = text; };
const show = screen => ['setup', 'quiz', 'report', 'history'].forEach(id => { $(id).hidden = id !== screen; });
function stopSpeech() {
  speechSequence++;
  $('question').classList.remove('speaking');
  if (speechSupported) window.speechSynthesis.cancel();
}
function speak(text, highlightQuestion = false) {
  if (!speechSupported) return notice('Text-to-speech is not available in this browser. You can read all content on screen.');
  stopSpeech();
  const sequence = speechSequence;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-IN'; utterance.rate = 0.95;
  const voices = window.speechSynthesis.getVoices();
  utterance.voice = voices.find(v => v.lang === 'en-IN') ?? voices.find(v => v.lang.startsWith('en')) ?? null;
  if (highlightQuestion) $('question').classList.add('speaking');
  const finishSpeech = () => { if (sequence === speechSequence) $('question').classList.remove('speaking'); };
  utterance.onend = finishSpeech;
  utterance.onerror = event => { finishSpeech(); if (!['canceled', 'interrupted'].includes(event.error)) notice('Audio could not play. Try the speaker button again.'); };
  window.speechSynthesis.speak(utterance);
}

function animateScore(points, selectedOption) {
  const balloon = $('score-burst');
  scoreAnimation?.cancel();
  $('scoreboard').classList.remove('pulse');
  const source = selectedOption ? document.querySelector(`.option[data-label="${selectedOption}"]`) : $('question');
  const rect = source.getBoundingClientRect(), destination = $('scoreboard').getBoundingClientRect();
  const x = Math.max(60, Math.min(window.innerWidth - 60, rect.left + rect.width / 2));
  const y = Math.max(110, Math.min(window.innerHeight - 110, rect.top + rect.height / 2));
  const dx = destination.left + destination.width / 2 - x;
  const dy = destination.top + destination.height / 2 - y;
  balloon.textContent = points > 0 ? '+4' : points < 0 ? '−1' : '0';
  balloon.className = `score-balloon ${points > 0 ? 'positive' : points < 0 ? 'negative' : 'neutral'}`;
  balloon.style.left = `${x}px`; balloon.style.top = `${y}px`;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !balloon.animate) {
    // Keep feedback clear without motion for users requesting reduced animation.
    balloon.style.opacity = '1';
    setTimeout(() => { balloon.style.opacity = '0'; }, 500);
    return;
  }
  balloon.style.opacity = '';
  scoreAnimation = balloon.animate([
    { opacity: 0, transform: 'translate(-50%, -50%) scale(.5)' },
    { opacity: 1, transform: 'translate(-50%, -70%) scale(1.15)', offset: .2 },
    { opacity: 1, transform: `translate(calc(-50% + ${dx * .45 - 30}px), calc(-50% + ${Math.min(-75, dy * .45)}px)) scale(1)`, offset: .55 },
    { opacity: 0, transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.18)` }
  ], { duration: 1150, easing: 'cubic-bezier(.2,.7,.3,1)' });
  scoreAnimation.onfinish = () => $('scoreboard').classList.add('pulse');
}

function advanceQuestion() {
  if (phase !== 'resolved') return;
  clearTimeout(advanceTimer);
  if (index === questions.length - 1) return finish();
  index++; renderQuestion(); window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function request(path, body, pdf = false) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message ?? `Request failed (${response.status})`);
  }
  return pdf ? response.blob() : response.json();
}
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function renderContent(container, question) {
  container.replaceChildren();
  for (const block of question.content) {
    if (block.type === 'paragraph') container.append(element('p', block.text));
    else {
      const wrap = element('div', undefined, 'table-wrap'), table = element('table');
      const head = element('thead'), row = element('tr'), body = element('tbody');
      block.headers.forEach(text => { const th = element('th', text); th.scope = 'col'; row.append(th); });
      head.append(row);
      block.rows.forEach(cells => { const tr = element('tr'); cells.forEach(text => tr.append(element('td', text))); body.append(tr); });
      table.append(head, body); wrap.append(table); container.append(wrap);
    }
  }
}
function controls() {
  $('skip').disabled = phase !== 'active';
  $('next').disabled = phase !== 'resolved';
  $('finish').disabled = !['active', 'resolved'].includes(phase);
  document.querySelectorAll('.option-choice').forEach(button => { button.disabled = phase !== 'active'; });
  const inPractice = ['active', 'checking', 'resolved', 'retry', 'finishing', 'starting'].includes(phase);
  for (const id of ['history-button', 'logout-button', 'login-button']) $(id).disabled = inPractice;
}
function tick() {
  if (phase !== 'active') return;
  const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  $('seconds').textContent = remaining;
  $('timer').classList.toggle('urgent', remaining <= 5);
  if (remaining === 0) void submit(null, 'timeout');
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

function renderQuestion() {
  stopSpeech(); clearInterval(interval); clearTimeout(advanceTimer); notice('');
  phase = 'active'; pending = null;
  const q = questions[index];
  $('counter').textContent = `Q${String(index + 1).padStart(2, '0')}/${questions.length}`;
  $('source-number').textContent = `${q.origin === 'supplemental' ? 'Supplementary practice' : 'Original paper'} · Question ${q.number}`;
  $('score').textContent = score > 0 ? `+${score}` : score;
  $('max-score').textContent = ` / ${questions.length * 4}`;
  $('progress').style.width = `${index / questions.length * 100}%`;
  $('explanation').hidden = true; $('retry-area').hidden = true;
  $('next').textContent = index === questions.length - 1 ? 'View report →' : 'Next →';
  renderContent($('question'), q);
  $('options').replaceChildren();
  q.options.forEach(option => {
    const row = element('div', undefined, 'option'); row.dataset.label = option.label;
    const button = element('button', undefined, 'option-choice'); button.type = 'button';
    const image = document.createElement('img'); image.src = '/stethoscope.svg'; image.alt = ''; image.className = 'option-image';
    const text = element('span'); text.append(element('span', `${option.label}.`, 'option-label'), document.createTextNode(option.text));
    button.append(image, text); button.onclick = () => submit(option.label, 'answered');
    const audio = element('button', '🔊', 'sound'); audio.setAttribute('aria-label', `Read option ${option.label} aloud`);
    audio.onclick = () => speak(`Option ${option.label}. ${option.text}`);
    row.append(button, audio); $('options').append(row);
  });
  deadline = Date.now() + 30000; tick(); interval = setInterval(tick, 200); controls();
  $('question').focus({ preventScroll: true });
  $('question').classList.remove('question-arrive');
  void $('question').offsetWidth;
  $('question').classList.add('question-arrive');
  try { speak(q.question, true); }
  catch { notice('Use the question speaker button to start audio.'); }
}

$('start-form').onsubmit = async event => {
  event.preventDefault(); $('start').disabled = true; notice('Loading your questions…');
  phase = 'starting'; controls();
  apiKey = $('api-key').value.trim();
  try {
    const data = await request(`/api/v1/quiz/questions?limit=${$('count').value}&random=${$('order').value}`);
    if (!data.data.length) throw new Error('No questions are available.');
    activePracticeId = null;
    if (currentUser) {
      const saved = await request('/api/v1/practices', { questionNumbers: data.data.map(q => q.number) });
      activePracticeId = saved.data.id;
    }
    questions = data.data; index = 0; answers = []; results = []; score = 0; report = null; startedAt = Date.now(); finishedAt = null;
    show('quiz'); window.scrollTo({ top: 0, behavior: 'instant' }); renderQuestion();
  } catch (error) { phase = 'setup'; controls(); notice(`Could not start: ${error.message}`); }
  finally { $('start').disabled = false; }
};

async function submit(selectedOption, reason) {
  if (phase !== 'active') return false;
  // Enforce the deadline even when the browser has throttled the interval.
  if (Date.now() >= deadline) { selectedOption = null; reason = 'timeout'; }
  pending = { number: questions[index].number, selectedOption, reason };
  clearInterval(interval); stopSpeech(); phase = 'checking'; controls(); notice('Checking answer…');
  return checkPending();
}
async function checkPending() {
  phase = 'checking'; controls(); $('retry-area').hidden = true;
  try {
    const data = activePracticeId
      ? await request(`/api/v1/practices/${activePracticeId}/answers`, pending)
      : await request('/api/v1/quiz/grade', { answers: [{ number: pending.number, selectedOption: pending.selectedOption }] });
    const result = { ...data.results[0], reason: pending.reason };
    answers.push({ number: pending.number, selectedOption: pending.selectedOption }); results.push(result);
    score += result.points; phase = 'resolved'; controls(); notice('');
    $('score').textContent = score > 0 ? `+${score}` : score;
    $('progress').style.width = `${(index + 1) / questions.length * 100}%`;
    $('timer').classList.remove('urgent');
    document.querySelectorAll('.option').forEach(row => {
      if (row.dataset.label === result.correctOption) row.classList.add('correct');
      if (row.dataset.label === result.selectedOption && result.status === 'incorrect') row.classList.add('wrong');
    });
    const label = result.status === 'correct' ? 'Correct · +4 points' : result.status === 'incorrect' ? 'Incorrect · −1 point' : result.reason === 'timeout' ? 'Time is up · 0 points' : 'Skipped · 0 points';
    $('outcome').textContent = label;
    const option = questions[index].options.find(o => o.label === result.correctOption);
    $('correct-answer').textContent = `Right answer: ${result.correctOption}. ${option.text}`;
    $('explanation-text').textContent = result.explanation ?? 'No explanation supplied.';
    $('reference').textContent = result.reference ? `Reference (NCERT): ${result.reference}` : 'Reference: Not provided in the source document.';
    $('explanation').hidden = false;
    animateScore(result.points, result.selectedOption);
    notice(label);
    // Selected answers always receive spoken feedback. The optional setting
    // controls manual skips. Highlighting and explanation render first.
    if (result.reason !== 'timeout' && (result.status !== 'unanswered' || $('auto-speak').checked)) {
      const explanation = result.explanation ?? 'No explanation supplied.';
      const narration = result.status === 'correct'
        ? `Correct Answer selected. ${explanation}`
        : `${result.status === 'incorrect' ? 'This answer is wrong.' : `${label}.`} ${$('correct-answer').textContent}. Explanation: ${explanation}`;
      try {
        speak(narration);
      } catch {
        // Speech failure must not turn a successfully scored answer into a retry.
        notice(`${label}. Audio could not play. Use the explanation speaker button to retry.`);
      }
    }
    if (result.reason === 'timeout') {
      notice(index === questions.length - 1 ? 'Time is up. Opening your report…' : 'Time is up. Moving to the next question…');
      advanceTimer = setTimeout(advanceQuestion, 1200);
    }
    return true;
  } catch (error) {
    phase = 'retry'; controls(); $('retry-area').hidden = false;
    notice(`Could not check the answer: ${error.message}. The timer is stopped.`);
    return false;
  }
}
$('retry').onclick = () => { if (phase === 'retry') void checkPending(); };
$('skip').onclick = () => submit(null, 'skipped');
$('next').onclick = advanceQuestion;
$('speak-question').onclick = () => {
  const q = questions[index]; speak(`${q.question}. ${q.options.map(o => `Option ${o.label}. ${o.text}`).join('. ')}`, true);
};
$('speak-explanation').onclick = () => speak(`${$('correct-answer').textContent}. ${$('explanation-text').textContent}. ${$('reference').textContent}`);
$('stop-speech').onclick = stopSpeech;
$('finish').onclick = async () => {
  if (!['active', 'resolved'].includes(phase)) return;
  if (!window.confirm('Finish this practice and view your report? The current unanswered question counts as skipped; future questions are not scored.')) return;
  if (phase === 'active' && !await submit(null, 'skipped')) return;
  await finish();
};
async function finish() {
  if (phase !== 'resolved') return;
  phase = 'finishing'; controls(); clearInterval(interval); clearTimeout(advanceTimer); stopSpeech(); notice('Preparing your report…');
  try {
    if (activePracticeId) {
      const saved = await request(`/api/v1/practices/${activePracticeId}/finish`, {});
      report = saved.data.report; finishedAt = saved.data.finishedAt;
    } else { report = await request('/api/v1/quiz/grade', { answers }); finishedAt = Date.now(); }
    renderReport();
  } catch (error) { phase = 'resolved'; controls(); notice(`Report unavailable: ${error.message}. Use Finish practice to retry.`); }
}
function renderReport() {
    phase = 'report'; show('report'); controls(); notice('');
    $('report-status').textContent = finishedAt ? 'PRACTICE COMPLETE' : 'SAVED PRACTICE';
    $('share-fallback').hidden = true;
    $('saved-indicator').textContent = activePracticeId ? '✓ Saved to your account · Available in My practice' : 'Guest practice · Download your report to keep a copy';
    $('report-score').textContent = report.score;
    $('report-max').textContent = `/ ${report.maxScore} points`;
    $('report-subtitle').textContent = `${report.total} of ${questions.length} selected questions reviewed · ${finishedAt ? `${Math.max(1, Math.round((finishedAt - startedAt) / 60000))} min practice` : 'Saved progress — not completed'}`;
    const timedOut = results.filter(r => r.reason === 'timeout').length;
    $('report-stats').replaceChildren();
    for (const [value, label, color] of [[report.correct, 'Correct', 'green'], [report.incorrect, 'Incorrect', 'red'], [report.unanswered, 'Skipped / unanswered', ''], [timedOut, 'Of these: timed out', '']]) {
      const stat = element('div', undefined, 'stat'); stat.append(element('strong', value, color), element('span', label)); $('report-stats').append(stat);
    }
    $('review').replaceChildren();
    report.results.forEach((r, i) => {
      const q = questions.find(q => q.number === r.number);
      const detail = element('details', undefined, 'review-item');
      detail.append(element('summary', `Q${r.number} · ${results[i].reason === 'timeout' ? 'Timed out' : r.status} · ${r.points > 0 ? '+' : ''}${r.points} points`));
      const prompt = element('div'); renderContent(prompt, q); detail.append(prompt);
      q.options.forEach(o => detail.append(element('p', `${o.label}. ${o.text}${o.label === r.correctOption ? ' ✓ Correct' : ''}${o.label === r.selectedOption ? ' · Your selection' : ''}`, o.label === r.correctOption ? 'green' : '')));
      detail.append(element('p', r.explanation), element('p', r.reference ? `NCERT reference: ${r.reference}` : 'Textbook reference not provided in the source document.', 'reference muted'));
      const audio = element('button', '🔊 Read explanation', 'secondary'); audio.onclick = () => speak(r.explanation); detail.append(audio); $('review').append(detail);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function reportFile() {
  const blob = activePracticeId ? await request(`/api/v1/practices/${activePracticeId}/report.pdf`, undefined, true)
    : await request('/api/v1/quiz/report.pdf', { answers }, true);
  return new File([blob], 'neet-quiz-report.pdf', { type: 'application/pdf' });
}
$('download').onclick = async () => {
  $('download').disabled = true; notice('Creating PDF…');
  try {
    const file = await reportFile(), url = URL.createObjectURL(file);
    const link = document.createElement('a'); link.href = url; link.download = file.name;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); notice('PDF report downloaded.');
  } catch (error) { notice(`PDF download failed: ${error.message}`); }
  finally { $('download').disabled = false; }
};
$('share').onclick = async () => {
  const text = `NEET Practice — Model Paper 1\nScore: ${report.score}/${report.maxScore}\nReviewed: ${report.total}/${questions.length}\nCorrect: ${report.correct} | Incorrect: ${report.incorrect} | Unanswered: ${report.unanswered}\nScoring: +4 correct, −1 incorrect, 0 unanswered.`;
  // Invoke the native sheet directly from the user gesture; some browsers lose
  // transient activation if file generation/network requests happen first.
  try {
    if (navigator.share) { await navigator.share({ title: 'My NEET practice report', text }); notice('Report shared.'); }
    else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); notice('Report summary copied. Paste it into your preferred app.'); }
    else throw new Error('Clipboard unavailable');
  } catch (error) {
    if (error.name === 'AbortError') return;
    $('share-fallback').hidden = false; $('share-fallback').open = true; $('share-text').value = text; $('share-text').select();
    notice('Copy the report summary below. You can also download and attach the PDF.');
  }
};
$('restart').onclick = resetSetup;
function resetSetup() {
  stopSpeech(); clearInterval(interval); clearTimeout(advanceTimer); phase = 'setup'; activePracticeId = null;
  show('setup'); controls(); $('share-fallback').hidden = true; notice('');
}

function updateAccount() {
  $('account-name').textContent = currentUser?.identifier ?? 'Guest practice';
  $('login-button').hidden = !!currentUser;
  $('logout-button').hidden = !currentUser;
  $('history-button').hidden = !currentUser;
  $('save-note').textContent = currentUser
    ? '✓ Signed in. Every answer and completed practice is saved to your account.'
    : 'Log in with your email or mobile to save your practice history. You can also practice as a guest.';
}
function configureAuth() {
  $('auth-title').textContent = authMode === 'login' ? 'Welcome back.' : 'Your journey starts here.';
  $('auth-submit').textContent = authMode === 'login' ? 'Log in →' : 'Create account →';
  $('auth-switch').textContent = authMode === 'login' ? 'New here? Create an account' : 'Already have an account? Log in';
  $('password').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  $('auth-error').textContent = '';
}
$('login-button').onclick = () => { authMode = 'login'; configureAuth(); $('auth-dialog').showModal(); };
$('auth-close').onclick = () => $('auth-dialog').close();
$('auth-switch').onclick = () => { authMode = authMode === 'login' ? 'register' : 'login'; configureAuth(); };
$('auth-form').onsubmit = async event => {
  event.preventDefault(); $('auth-submit').disabled = true; $('auth-switch').disabled = true; $('auth-error').textContent = '';
  try {
    const response = await request(`/api/v1/auth/${authMode}`, { identifier: $('identifier').value, password: $('password').value });
    currentUser = response.user; $('password').value = ''; $('auth-dialog').close(); updateAccount();
    notice('You are signed in. Your next practice will be saved automatically.');
  } catch (error) { $('auth-error').textContent = error.message; }
  finally { $('auth-submit').disabled = false; $('auth-switch').disabled = false; }
};
$('logout-button').onclick = async () => {
  try { await request('/api/v1/auth/logout', {}); currentUser = null; updateAccount(); resetSetup(); notice('Signed out. Your saved records remain in your account.'); }
  catch (error) { notice(`Could not log out: ${error.message}`); }
};
$('history-button').onclick = async () => {
  stopSpeech(); phase = 'history'; show('history'); controls(); notice('Loading saved practice…');
  try {
    const { data } = await request('/api/v1/practices');
    $('history-list').replaceChildren();
    $('history-summary').textContent = `${data.length} saved practice sessions · ${data.reduce((n, p) => n + p.total, 0)} questions reviewed (latest 100 sessions)`;
    if (!data.length) $('history-list').append(element('p', 'Your first session is waiting. Start a practice to build your history.', 'history-empty'));
    data.forEach(p => {
      const card = element('article', undefined, 'history-card'), info = element('div');
      info.append(element('h3', new Date(p.startedAt).toLocaleString()), element('p', `${p.total}/${p.selectedCount} questions · ${p.status === 'completed' ? 'Completed' : 'In progress'}`), element('p', `${p.correct} correct · ${p.incorrect} incorrect · ${p.unanswered} unanswered`));
      const score = element('div', `${p.score} / ${p.maxScore}`, 'history-score');
      const view = element('button', 'View report ↗', 'secondary');
      view.onclick = async () => {
        view.disabled = true;
        try {
          const { data: saved } = await request(`/api/v1/practices/${p.id}`);
          activePracticeId = saved.id; questions = saved.questions; answers = saved.answers; results = saved.report.results;
          report = saved.report; startedAt = saved.startedAt; finishedAt = saved.finishedAt; renderReport();
        } catch (error) { notice(`Could not open report: ${error.message}`); }
        finally { view.disabled = false; }
      };
      card.append(info, score, view); $('history-list').append(card);
    });
    notice('');
  } catch (error) { notice(`Could not load practice history: ${error.message}`); }
};
$('history-back').onclick = resetSetup;
// Restore the cookie session without exposing a session token to JavaScript.
$('start').disabled = true;
request('/api/v1/auth/me').then(({ user }) => { currentUser = user; updateAccount(); })
  .catch(() => notice('Could not check your login. Refresh before starting if you want to save practice.'))
  .finally(() => { $('start').disabled = false; });
window.addEventListener('pagehide', stopSpeech);
