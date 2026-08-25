#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SECTION_KEYS = {
  '01': 'imageGoal', '02': 'identity', '03': 'face', '04': 'hair', '05': 'body',
  '06': 'skin', '08': 'pose', '09': 'expression', '10': 'composition',
  '11': 'cameraAngle', '12': 'lens', '13': 'scene', '14': 'lighting', '16': 'photographicTexture',
};

function slug(value) {
  return value.normalize('NFKC').replace(/[（(].*?[）)]/g, '').replace(/[\s/]+/g, '_').replace(/[^\p{L}\p{N}_+-]/gu, '').toLowerCase();
}

function parseSections(markdown, prefix) {
  const result = {};
  let heading = null;
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^## (.+)$/);
    if (match) { heading = match[1].trim(); continue; }
    const item = line.match(/^(?:- |\d+\. )(?!\*\*)(.+)$/);
    if (!heading || !item || ['用途', '核心欄位', '組合模板', '範例', '高辨識度組合範例', '常用組合', '常用質感預設', '真實透視描述', '禁止失真控制', '禁止塑膠感描述', '真實光影描述'].some((x) => heading.startsWith(x))) continue;
    const key = slug(heading);
    result[key] ??= [];
    result[key].push({ id: `${prefix}.${key}.${String(result[key].length + 1).padStart(3, '0')}`, text: item[1].trim() });
  }
  return result;
}

function parseClothing(markdown) {
  const pools = { tops: [], bottoms: [], shoes: [], outerwear: [], hosiery: [], outfits: [] };
  let pool = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^## 上衣/.test(line)) pool = 'tops';
    else if (/^## 下身/.test(line)) pool = 'bottoms';
    else if (/^## 鞋款/.test(line)) pool = 'shoes';
    else if (/^## 外套/.test(line)) pool = 'outerwear';
    else if (/^## 襪類/.test(line)) pool = 'hosiery';
    else if (/^## 核心 520/.test(line)) pool = 'outfits';
    else if (/^## /.test(line)) pool = null;
    const match = line.match(/^- \*\*([A-Z]\d{2,3})\*\*\s+(.+)$/);
    if (!pool || !match) continue;
    const [, id, text] = match;
    const entry = { id, text: text.trim() };
    if (pool === 'outfits') {
      const [top, bottom, shoe] = text.split(/\s+\+\s+/);
      Object.assign(entry, { top, bottom, shoe });
    }
    pools[pool].push(entry);
  }
  return pools;
}

export function importPersonPhotoPrompts(sourcePath) {
  const absolute = resolve(sourcePath);
  const sourceBuffer = readFileSync(absolute);
  const sourceSha256 = createHash('sha256').update(sourceBuffer).digest('hex');
  const directory = mkdtempSync(join(tmpdir(), 'person-photo-prompts-'));
  try {
    const unzip = spawnSync('unzip', ['-q', absolute, '-d', directory], { encoding: 'utf8' });
    if (unzip.status !== 0) throw new Error(`Unable to extract prompt archive: ${unzip.stderr.trim()}`);
    const files = readdirSync(directory).filter((name) => name.endsWith('.md')).sort();
    if (files.length !== 15) throw new Error(`Expected 15 Markdown files, found ${files.length}`);
    const categories = {};
    let clothing;
    for (const filename of files) {
      const number = filename.slice(0, 2);
      const markdown = readFileSync(join(directory, filename), 'utf8');
      if (number === '07') clothing = parseClothing(markdown);
      else categories[SECTION_KEYS[number]] = parseSections(markdown, SECTION_KEYS[number]);
    }
    if (!clothing || clothing.outfits.length !== 520) throw new Error(`Expected C001-C520, found ${clothing?.outfits.length ?? 0}`);
    if (clothing.outfits[0].id !== 'C001' || clothing.outfits.at(-1).id !== 'C520') throw new Error('Outfit IDs are not contiguous C001-C520');
    return { schemaVersion: 1, libraryVersion: `person-photo-v1-${sourceSha256.slice(0, 12)}`, source: basename(absolute), sourceSha256, markdownFileCount: files.length, categories, clothing };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = process.argv[2] ?? resolve(process.cwd(), '../person_photo_prompt_docs.zip');
  const output = process.argv[3] ?? resolve(process.cwd(), 'server/image-generation/person-photo-library.v1.json');
  const library = importPersonPhotoPrompts(source);
  writeFileSync(output, `${JSON.stringify(library, null, 2)}\n`);
  console.log(`Imported ${library.markdownFileCount} Markdown files and ${library.clothing.outfits.length} outfits to ${output}`);
}
