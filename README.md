# NEET Quiz REST API

A runnable Node.js service and responsive quiz frontend with 300 playable questions: 299 valid questions from **MODEL PAPER- 1 MCQs for NEET APPLICATION - Copy.docx** plus one original supplementary question. The invalid source question is retained for review, making 301 stored records. Uses Node's built-in HTTP server and SQLite: no npm dependencies or separate database installation are required. Requires Node.js 22.13 or newer; Node.js 24 is recommended.

## Quiz application

Open http://localhost:3000 after starting the server. The dark interface includes:

- A choice of 10, 25, 50 or all 300 scorable questions, in paper order or random order. The full quiz has a maximum score of 1,200.
- Question count, original source number, progress bar, and large +4/−1/0 balloons that float from the answer toward the scoreboard. Buttons have gradients, hover shine, elevation and focus effects.
- Starting practice highlights and reads the question automatically. Each new question is narrated; the speaker button additionally reads all options. Stop audio cancels narration.
- A 30-second deadline for each question. Selection locks immediately; skipping and timeout score zero. Timeout briefly shows the zero-point balloon, then automatically advances after 1.2 seconds, or opens the report on the last question. It does not wait for explanation narration. Time spent reading or listening counts toward the deadline.
- A stethoscope image on every option, including questions with five options.
- Animated correct-answer explanations and question/option/explanation text-to-speech. Correct selections automatically say "Correct Answer selected" followed by the explanation, without repeating the option or score. Wrong selections immediately highlight the correct option after grading, automatically say "This answer is wrong," and read the correct answer and explanation aloud. The NCERT reference appears below the explanation, or a missing-reference message when absent. The optional narration checkbox applies only to manual skips; Stop audio cancels narration.
- A results screen with expandable explanations and references, a downloadable multi-page PDF score report, and native share-sheet or copy-text fallback.
- Keyboard focus styling, mobile layout and support for reduced-motion preferences.

Text-to-speech uses the browser's installed voices; voice availability depends on the browser and device. Sharing uses the native share sheet when supported, otherwise the clipboard/manual copy fallback. Share sends the summary; use Download PDF to attach the full results report. No external speech service or CDN is required by the application.

Guest practice is kept in memory and resets on reload. Signed-in practice starts a server record, and every checked answer is saved immediately. Interrupted sessions remain available as in-progress reports in My practice; this version does not resume the question timer after reload. Finish practice allows early completion: the current unanswered question is skipped; future questions are not scored. API outages stop the timer and preserve the pending answer for retry without charging another penalty. The PDF includes scores and one result row per reviewed question; complete explanations remain in the web review.

If `API_KEY` is enabled, signed-in learners can use the quiz routes with their cookie session. Guest/API clients need the bearer key for the original API routes. Connection settings remain available for trusted local testing. Do not distribute a shared API key in a public frontend bundle.

## Accounts and saved records

Use **Log in / Sign up** to create an account with an email or mobile number and a password of 10–128 characters. Indian mobiles accept 10 digits starting with 6–9, normalized to +91. Other numbers require +country code and 8–15 digits. These checks validate format only, not ownership, deliverability or carrier status. Email/SMS OTP and password recovery are not included; they require a separately configured delivery provider. OpenAI credit does not configure such a provider.

Passwords use salted scrypt hashes. Sessions are random opaque tokens, stored hashed in SQLite and sent in HttpOnly, SameSite=Strict cookies with a seven-day expiry. Log out revokes the session. Sign-in/registration are rate limited; records are always scoped to their authenticated owner. Scores are computed on the server; repeated delivery of the same answer is idempotent. The countdown is a practice feature, not a server-enforced examination timer.

The database is created automatically at `storage/practice.sqlite`. **Keep the storage directory when updating the app.** Set `DB_PATH` to a persistent disk location for cloud hosting; ephemeral storage will lose accounts and history on redeploy. Back up the database using SQLite-aware tooling. This setup is intended for one Node.js application instance on a persistent disk. Test accounts and storage files are excluded from the downloadable source ZIP.

For an HTTPS deployment, set `NODE_ENV=production` (Secure cookies) and `APP_ORIGIN` to the exact public origin, such as `https://quiz.example.com`. Local HTTP testing uses the default non-Secure cookie. Mutating browser requests must come from the app's own origin; cross-origin cookie login is intentionally unsupported.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/v1/auth/register` | `{ "identifier": "you@example.com", "password": "..." }`; creates account and session |
| POST | `/api/v1/auth/login` | Same credentials shape; creates session |
| GET | `/api/v1/auth/me` | Current user or null |
| POST | `/api/v1/auth/logout` | Revokes session |
| POST | `/api/v1/practices` | `{ "questionNumbers": [1,2,3] }`; creates a saved practice |
| GET | `/api/v1/practices` | Latest 100 records for the current account |
| GET | `/api/v1/practices/:id` | Saved questions, answers, reasons and report |
| POST | `/api/v1/practices/:id/answers` | `{ "number": 1, "selectedOption": "A", "reason": "answered" }`; grades and stores once |
| POST | `/api/v1/practices/:id/finish` | Completes the record; safe to retry |
| GET | `/api/v1/practices/:id/report.pdf` | PDF of the stored results |

An unanswered submission uses `selectedOption: null` and `reason: "skipped"` or `"timeout"`. The server never accepts client-supplied scores. Saved records retain graded explanations and references as they were when the answer was submitted.

## Run

Open a terminal in this folder:

```powershell
npm start
```

Or run `node src/server.js`. Open http://localhost:3000/health.

Run tests with `npm test` or `node --test`.

## Endpoints

| Method | URL | Result |
| --- | --- | --- |
| GET | `/health` | Health and question count |
| GET | `/api/v1/papers` | Paper metadata and data-quality counts |
| GET | `/api/v1/questions` | Questions with options, correct answer, explanation, reference, and provenance |
| GET | `/api/v1/questions/39` | One question, including all five options and answer E |
| GET | `/api/v1/quiz/questions` | Scorable questions with answers and explanations hidden |
| POST | `/api/v1/quiz/grade` | Validate and grade submitted answers; return explanations and references |
| POST | `/api/v1/quiz/report.pdf` | Accept the same answers body and download a server-scored PDF report |

List endpoints accept:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `page` | `1` | Page number |
| `limit` | `20` | Questions per page, 1–301 |
| `from`, `to` | `1`, `301` | Inclusive question-number range; 301 is supplementary |
| `search` | empty | Case-insensitive search of question and option text |
| `random` | `false` | Shuffle before selecting a page |
| `eligibleOnly` | `false` | Exclude invalid source questions from the study endpoint; always enabled for quiz endpoint |

Random requests produce independent samples. Use `page=1&limit=N&random=true` once and retain those question numbers in the client; separate random pages are not a stable quiz session.

```powershell
Invoke-RestMethod 'http://localhost:3000/api/v1/questions?limit=301'
Invoke-RestMethod 'http://localhost:3000/api/v1/questions/1'
Invoke-RestMethod 'http://localhost:3000/api/v1/quiz/questions?limit=10&random=true'
```

## Question format

The following is an abbreviated example; the API returns the complete text:

```json
{
  "data": {
    "id": "model-paper-1-q002",
    "paperId": "model-paper-1",
    "number": 2,
    "question": "Which combination correctly represents the major criteria used by Whittaker for the five-kingdom classification?",
    "options": [
      { "label": "A", "text": "Cell structure, body organisation, nutrition, reproduction and phylogenetic relationships" },
      { "label": "B", "text": "Habitat, locomotion, colour, nutrition and reproduction" },
      { "label": "C", "text": "Cell size, habitat, metabolism, locomotion and phylogeny" },
      { "label": "D", "text": "Cell wall, body size, habitat, reproduction and locomotion" }
    ],
    "correctOption": "A",
    "explanation": "Whittaker's classification considered cell structure, body organisation, mode of nutrition, reproduction and phylogenetic relationships.",
    "reference": "Biological Classification, p. 11."
  }
}
```

Additional fields:

- `content`: Ordered paragraph/table blocks. Render these for matching questions; render `question` as a plain-text fallback. Do not render both, which would duplicate the prompt.
- `source`: Document filename, original question number, and zero-based OOXML body-block index (not a page number). For the original supplementary question, these are null; `type: "supplemental"` and `referenceUrl` identify its provenance.
- `sourceAnswer`: Original answer wording, including the invalid answer in question 198.
- `notes`: Source notes, when present.
- `quality`: Scoring eligibility, missing-data warnings, and verification status.

Table blocks use `{ "type": "table", "headers": [...], "rows": [[...]] }`. All four matching tables (Q3, Q9, Q207, Q296) are preserved. Numbered statement lists are preserved in the prompt.

## Grade a quiz

```powershell
$body = @{
  answers = @(
    @{ number = 1; selectedOption = 'A' }
    @{ number = 2; selectedOption = 'B' }
    @{ number = 3; selectedOption = $null }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/v1/quiz/grade' `
  -ContentType 'application/json' -Body $body
```

The implemented scoring policy is +4 for correct, -1 for incorrect, and 0 for unanswered. This example scores 3 out of 12. `selectedOption` must be an available uppercase option label or `null`. Include every question in your quiz, using `null` for unanswered questions: omitted questions are not counted. Duplicate submissions within one request are rejected.

The original `/quiz/grade` endpoint remains stateless and grades only the submitted question numbers. Signed-in frontend sessions use the saved-practice endpoints above instead. The document's answer key and explanations are transcribed, not independently verified against textbooks. The new supplementary question was checked against its linked NCERT section.

For browser integration:

```js
const response = await fetch('http://localhost:3000/api/v1/quiz/questions?limit=10');
if (!response.ok) throw new Error('Could not load questions');
const { data: questions } = await response.json();
```

Configure `CORS_ORIGIN` to the exact frontend origin before using a different browser origin.

## Source quality

- 300 source questions imported plus one original supplementary question; 300 are eligible for scoring.
- Q39 has five options, A–E, and the source answer is E. Clients must not assume four options.
- Q198 asks for an incorrect statement, but the source says all four are correct. It remains visible in study responses with `correctOption: null`; quiz lists omit it and grading returns HTTP 422. No replacement option was invented.
- 98 source questions have an explicit NCERT reference; the supplementary question has a verified chapter reference and URL, bringing referenced questions to 99. The remaining 202 return `reference: null` and a `reference_not_provided` warning. Provenance is recorded in `source`.
- Supplementary question 301 covers pancreatic alpha/beta cells and their hormones. Its reference is [NCERT Class XI Biology, section 19.2.8, pp. 245–246, reprint 2026–27](https://ncert.nic.in/textbook/pdf/kebo119.pdf). In paper order it is the 300th playable question; original source numbers are preserved.
- Page references are copied exactly from the source, with no assumed textbook edition or fabricated links.
- The import cross-checks available answer-key tables against per-question answers.

See `data/import-report.json` for the affected question numbers. Review the academic content before releasing an assessment product.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listening port |
| `HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` when deploying behind a hosting platform/proxy |
| `CORS_ORIGIN` | unset | One exact permitted frontend origin, such as `http://localhost:5173` |
| `API_KEY` | unset | Optional bearer token for original study/quiz API routes; account sessions can access quiz routes |
| `DB_PATH` | `storage/practice.sqlite` in the project | Persistent SQLite database path |
| `NODE_ENV` | unset | Set to `production` to require Secure session cookies |
| `APP_ORIGIN` | Derived from protocol/Host | Exact public HTTPS origin for browser request checks |

PowerShell example:

```powershell
$env:CORS_ORIGIN = 'http://localhost:5173'
$env:API_KEY = 'replace-with-a-long-random-secret'
npm start
```

When enabled, send `Authorization: Bearer <API_KEY>`. Keep a backend service key on your application server, not in a public frontend bundle. CORS is a browser policy, not authentication.

This is a practice/study application, not an exam-proctoring system. Study routes intentionally reveal answers, even though quiz routes hide them; protect study routes with `API_KEY` if needed. Registered users have private saved practice records, but the existing stateless endpoints are still available for practice. Use your hosting platform's HTTPS endpoint and persistent storage for deployment.

## Re-import the document

Python is required only to rebuild the JSON data. The service runs without Python and without access to the original DOCX.

```powershell
python scripts/import_docx.py 'C:\path\MODEL PAPER- 1 MCQs for NEET APPLICATION - Copy.docx'
npm test
```

The importer uses only Python's standard library. It is designed for this paper's Q1–Q300 layout and rejects unexpected question counts, option counts, and embedded images/equations. It appends `data/supplemental-questions.json` after import so the original supplementary question survives re-imports. Section headings and progress messages are excluded; they are not treated as instructions. Source data lives in `data/questions.json`; restarting the server loads changes.

## Files

```text
data/questions.json       Imported question bank
data/import-report.json   Data-quality report
scripts/import_docx.py    Repeatable DOCX import
src/server.js             REST service
src/accounts.js           Accounts, sessions and saved practice in SQLite
src/report.js             PDF report generation
public/                   Quiz frontend, styles and stethoscope icon
test/api.test.js          HTTP integration and data checks
test/accounts.test.js     Authentication and persistence checks
package.json              Start/test commands
```

Errors return `{ "error": { "status": 400, "message": "..." } }`. Statuses include 400 (invalid input), 401 (invalid token), 404 (missing resource), 405 (wrong method), 413 (body over 64 KiB), 415 (non-JSON submission), and 422 (ungradable source question).
