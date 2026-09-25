"""Import this model paper without third-party Python packages.

Preserves document order, matching tables, and numbered statements.
The source is content only; no embedded instruction is executed.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def text(element):
    return ''.join(n.text or '' if n.tag == W + 't' else '\n' if n.tag in
                   (W + 'br', W + 'cr') else '\t' if n.tag == W + 'tab' else ''
                   for n in element.iter()).strip()


def extract(path):
    with ZipFile(path) as archive:
        root = ET.fromstring(archive.read('word/document.xml'))
        if any(n.tag.endswith(('}drawing', '}oMath', '}imagedata', '}textbox')) for n in root.iter()):
            raise ValueError('Embedded images/equations require manual extraction before import.')
        numbering = ET.fromstring(archive.read('word/numbering.xml'))
    starts = {}
    abstracts = {n.get(W + 'abstractNumId'): n for n in numbering.findall(W + 'abstractNum')}
    for n in numbering.findall(W + 'num'):
        aid = n.find(W + 'abstractNumId').get(W + 'val')
        for level in abstracts[aid].findall(W + 'lvl'):
            idx = level.get(W + 'ilvl')
            start = int(level.find(W + 'start').get(W + 'val'))
            override = n.find(f"{W}lvlOverride[@{W}ilvl='{idx}']/{W}startOverride")
            starts[(n.get(W + 'numId'), idx)] = int(override.get(W + 'val')) if override is not None else start
    questions, keys, current = [], {}, None
    phase = 'outside'
    counters = {}
    for block_index, block in enumerate(root.find(W + 'body')):
        if block.tag == W + 'tbl':
            rows = [[ '\n'.join(text(p) for p in c.findall(W + 'p'))
                      for c in row.findall(W + 'tc')] for row in block.findall(W + 'tr')]
            if rows and rows[0][:2] == ['Q', 'Ans']:
                for row in rows[1:]:
                    for i in range(0, len(row), 2):
                        keys[int(row[i])] = row[i + 1]
            elif current and phase == 'prompt':
                current['content'].append({'type': 'table', 'headers': rows[0], 'rows': rows[1:]})
            else:
                raise ValueError(f'Unexpected table at block {block_index}')
            continue
        if block.tag != W + 'p':
            continue
        value = text(block)
        if not value:
            continue
        match = re.match(r'^Q(\d+)\.\s*(.*)', value, re.S)
        if match:
            current = {'id': f'model-paper-1-q{int(match[1]):03}', 'number': int(match[1]),
                       'paperId': 'model-paper-1', 'question': '',
                       'content': [{'type': 'paragraph', 'text': match[2]}],
                       'options': [], 'correctOption': None, 'sourceAnswer': None,
                       'explanation': None, 'reference': None, 'notes': [],
                       'source': {'file': path.name, 'questionNumber': int(match[1]), 'bodyBlockIndex': block_index}}
            questions.append(current)
            phase, counters = 'prompt', {}
        elif current and re.match(r'^[A-E]\.\s', value) and phase in ('prompt', 'options'):
            for part in re.split(r'\n(?=[A-E]\.\s)', value):
                label, option = re.match(r'^([A-E])\.\s*(.*)', part, re.S).groups()
                current['options'].append({'label': label, 'text': option.strip()})
            phase = 'options'
        elif current and value.startswith('Answer:'):
            current['sourceAnswer'] = value.partition(':')[2].strip()
            if re.fullmatch('[A-E]', current['sourceAnswer']):
                current['correctOption'] = current['sourceAnswer']
            phase = 'answer'
        elif current and value.startswith('Explanation:'):
            current['explanation'] = value.partition(':')[2].strip()
            phase = 'explanation'
        elif current and value.startswith('NCERT Reference:'):
            current['reference'] = value.partition(':')[2].strip()
            phase = 'reference'
        elif current and value.startswith('NEET Trap:'):
            current['notes'].append(value)
        elif current and phase == 'prompt':
            num = block.find(f'{W}pPr/{W}numPr')
            if num is not None:
                key = (num.find(W + 'numId').get(W + 'val'), num.find(W + 'ilvl').get(W + 'val'))
                counters[key] = counters.get(key, starts.get(key, 1) - 1) + 1
                value = f'{counters[key]}. {value}'
            current['content'].append({'type': 'paragraph', 'text': value})
        elif current and value.startswith('Species →'):
            current['explanation'] += '\n' + value
        # Section headings, progress messages and answer-key headings are not question content.
    for q in questions:
        q['question'] = '\n'.join(b['text'] if b['type'] == 'paragraph' else
                                   '\n'.join(' | '.join(row) for row in [b['headers'], *b['rows']])
                                   for b in q['content'])
        warnings = []
        if q['correctOption'] not in [o['label'] for o in q['options']]:
            warnings.append('source_answer_not_selectable')
        if not q['reference']:
            warnings.append('reference_not_provided')
        if not q['explanation']:
            warnings.append('explanation_not_provided')
        if q['number'] in keys and q['correctOption'] and keys[q['number']] != q['correctOption']:
            warnings.append('answer_key_conflict')
        q['quality'] = {'quizEligible': bool(q['correctOption']) and not any(
            w in warnings for w in ('source_answer_not_selectable', 'answer_key_conflict')),
            'warnings': warnings, 'verification': 'transcribed_from_source_not_independently_fact_checked'}
    assert [q['number'] for q in questions] == list(range(1, 301)), 'Expected questions 1–300 exactly once'
    assert all(len(q['options']) in (4, 5) for q in questions), 'Unexpected option count'
    assert all(len(set(o['label'] for o in q['options'])) == len(q['options']) for q in questions)
    supplemental_path = Path(__file__).resolve().parents[1] / 'data/supplemental-questions.json'
    supplemental = json.loads(supplemental_path.read_text(encoding='utf-8'))
    questions.extend(supplemental)
    assert len({q['number'] for q in questions}) == len(questions), 'Duplicate question number'
    assert len({q['id'] for q in questions}) == len(questions), 'Duplicate question ID'
    assert all(q['correctOption'] in [o['label'] for o in q['options']] and
               q['explanation'] and q['reference'] and q['source']['type'] == 'supplemental'
               for q in supplemental), 'Incomplete supplemental question'
    return {'paperId': 'model-paper-1', 'title': 'NEET Model Paper 1',
            'sourceFile': path.name, 'sourceSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'questions': questions}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'data/questions.json')
    args = parser.parse_args()
    dataset = extract(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    report = {'total': len(dataset['questions']),
              'supplementalQuestions': [q['number'] for q in dataset['questions'] if q['source'].get('type') == 'supplemental'],
              'quizEligible': sum(q['quality']['quizEligible'] for q in dataset['questions']),
              'missingReferences': [q['number'] for q in dataset['questions'] if not q['reference']],
              'excludedFromScoring': [q['number'] for q in dataset['questions'] if not q['quality']['quizEligible']],
              'tablesPreserved': sum(b['type'] == 'table' for q in dataset['questions'] for b in q['content'])}
    args.output.with_name('import-report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))
