import type { Section } from './types';

type CurrentSection = {
  id: string;
  title: string;
  body: string[];
  startLine: number;
};

/**
 * Split Markdown by H2 headings. Content before the first H2 becomes a
 * special `__preamble__` section (no Viewed checkbox).
 */
export function splitBySections(source: string): Section[] {
  const result: Section[] = [];
  let preamble: string[] = [];
  const preambleStart = 1;
  let current: CurrentSection | null = null;

  const lines = source.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const lineNo = idx + 1;
    const m = line.match(/^## (.+)$/);
    if (m) {
      if (current) {
        result.push({
          id: current.id,
          title: current.title,
          body: current.body.join('\n'),
          startLine: current.startLine,
          endLine: lineNo - 1,
        });
      } else if (preamble.length > 0) {
        result.push({
          id: '__preamble__',
          title: '',
          body: preamble.join('\n'),
          startLine: preambleStart,
          endLine: lineNo - 1,
        });
        preamble = [];
      }
      const title = m[1].trim();
      current = { id: title, title, body: [line], startLine: lineNo };
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }

  if (current) {
    result.push({
      id: current.id,
      title: current.title,
      body: current.body.join('\n'),
      startLine: current.startLine,
      endLine: lines.length,
    });
  } else if (preamble.length > 0) {
    result.push({
      id: '__preamble__',
      title: '',
      body: preamble.join('\n'),
      startLine: preambleStart,
      endLine: lines.length,
    });
  }

  // Deduplicate IDs (if two sections share a title)
  const seen = new Set<string>();
  return result.map((s) => {
    if (s.id === '__preamble__') return s;
    let id = s.id;
    let n = 2;
    while (seen.has(id)) {
      id = `${s.id} (${n++})`;
    }
    seen.add(id);
    return { ...s, id };
  });
}
