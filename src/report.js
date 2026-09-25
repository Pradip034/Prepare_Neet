// Small, dependency-free PDF writer for the numeric quiz results report.
// Report text is intentionally ASCII; question content remains in the web review.
export function createReportPdf(report) {
  const lines = [
    'NEET PRACTICE | PERFORMANCE REPORT',
    'Model Paper 1',
    `Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    '',
    `Score: ${report.score} / ${report.maxScore}`,
    `Reviewed questions: ${report.total}`,
    `Correct: ${report.correct}   Incorrect: ${report.incorrect}   Unanswered: ${report.unanswered}`,
    'Scoring: correct +4, incorrect -1, unanswered 0',
    '',
    'QUESTION    YOUR OPTION    CORRECT OPTION    RESULT       POINTS',
    '-'.repeat(68),
    ...report.results.map(r => `${String(r.number).padEnd(12)}${(r.selectedOption ?? '-').padEnd(15)}${r.correctOption.padEnd(18)}${r.status.padEnd(13)}${r.points > 0 ? '+' : ''}${r.points}`),
    '',
    'Only submitted questions are included. Skips/timeouts are unanswered.',
    'Source: NEET Model Paper 1 plus one original practice question (301).',
    'Original paper answers are transcribed, not independently verified.',
    'Question 198 is excluded because its source answer is not selectable.',
    'Full explanations and available references are in the web review.'
  ];
  const chunks = [];
  for (let i = 0; i < lines.length; i += 46) chunks.push(lines.slice(i, i + 46));
  const objects = [null, '', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'];
  const pages = [];
  const escape = text => text.replace(/([\\()])/g, '\\$1');
  chunks.forEach((chunk, index) => {
    const pageId = objects.length;
    const streamId = pageId + 1;
    pages.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
    const stream = `BT /F1 10 Tf 14 TL 42 746 Td\n${chunk.map(line => `(${escape(line)}) Tj T*`).join('\n')}\nET\nBT /F1 9 Tf 42 28 Td (Page ${index + 1} of ${chunks.length}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.join(' ')}] /Count ${pages.length} >>`;
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(output));
    output += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
