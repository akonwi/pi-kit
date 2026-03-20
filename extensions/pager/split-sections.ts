/**
 * Split markdown text into sections at heading boundaries.
 * Nested headings (e.g. ### under ##) inherit the parent heading
 * as a persistent section title.
 * Ported from `v2/src/features/pager/split-sections.ts`.
 */

export type PagerSection = {
  /** The specific heading for this page (e.g. "### Setup") */
  title: string;
  /** Parent heading shown persistently across pages in this group (e.g. "## Architecture") */
  sectionTitle: string;
  /** Full markdown body for this page */
  body: string;
};

type HeadingChunk = {
  level: number;
  title: string;
  body: string;
};

function parseHeadingChunks(text: string): HeadingChunk[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const chunks: HeadingChunk[] = [];
  const rawChunks = normalized.split(/\n(?=#+\s+)/g);

  for (const raw of rawChunks) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^(#+)\s+(.*)/);
    if (match) {
      const level = match[1].length;
      const title = match[2].trim();
      chunks.push({ level, title, body: trimmed });
    } else {
      chunks.push({ level: 0, title: "Introduction", body: trimmed });
    }
  }

  return chunks;
}

function fallbackParagraphSplit(text: string): PagerSection[] {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n\n+/g)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length < 2) {
    return [{ title: "Response", sectionTitle: "", body: text.trim() }];
  }

  return paragraphs.map((body, idx) => ({
    title: body.match(/^[^.!?\n]{4,70}/)?.[0]?.trim() || `Section ${idx + 1}`,
    sectionTitle: "",
    body,
  }));
}

export function splitSections(text: string): PagerSection[] {
  const chunks = parseHeadingChunks(text);

  if (chunks.length === 0) return [];
  if (chunks.length === 1) {
    return [{ title: chunks[0].title, sectionTitle: "", body: chunks[0].body }];
  }

  const levels = chunks.filter((c) => c.level > 0).map((c) => c.level);
  if (levels.length === 0) {
    return fallbackParagraphSplit(text);
  }

  const uniqueLevels = [...new Set(levels)].sort((a, b) => a - b);

  if (uniqueLevels.length === 1) {
    return chunks.map((c) => ({
      title: c.title,
      sectionTitle: "",
      body: c.body,
    }));
  }

  const parentLevel = uniqueLevels[0];

  const sections: PagerSection[] = [];
  let currentParentTitle = "";

  for (const chunk of chunks) {
    if (chunk.level > 0 && chunk.level <= parentLevel) {
      currentParentTitle = chunk.title;
    }

    sections.push({
      title: chunk.title,
      sectionTitle: chunk.level > parentLevel ? currentParentTitle : "",
      body: chunk.body,
    });
  }

  return sections;
}
