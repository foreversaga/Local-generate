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

const YOUNG_ADULT_WOMAN_AGE = /^(?:18–20|20–22|23–25|26–29) 歲成年女性$|^20(?: 歲出頭| 多歲)年輕成年女性$/;

const SWIMWEAR_STYLES = [
  '黑色經典三角比基尼', '白色繫帶三角比基尼', '海軍藍高腰比基尼', '紅色運動型比基尼', '粉色荷葉邊比基尼',
  '淺藍條紋比基尼', '綠色綁帶比基尼', '黃色方領比基尼', '紫色交叉肩帶比基尼', '橘色單肩比基尼',
  '黑色削肩運動泳裝', '深藍拉鍊運動泳裝', '白色高領運動泳裝', '酒紅色背心式泳裝', '墨綠色競泳連身泳裝',
  '寶藍色競泳連身泳裝', '黑白撞色競泳泳裝', '灰色短袖衝浪泳衣', '藍色長袖防曬泳衣', '黑色長袖拉鍊泳衣',
  '黑色深 V 連身泳裝', '白色方領連身泳裝', '紅色低背連身泳裝', '海軍藍高衩連身泳裝', '墨綠色繞頸連身泳裝',
  '粉色荷葉肩連身泳裝', '米白腰帶連身泳裝', '黑色腰間鏤空連身泳裝', '藍白條紋復古連身泳裝', '紅白波點復古連身泳裝',
  '黑色高腰復古比基尼', '奶油色高腰復古比基尼', '花卉印花高腰比基尼', '熱帶葉片印花比基尼', '藍色漸層比基尼',
  '珊瑚粉平口比基尼', '黑色平口比基尼', '白色單肩連身泳裝', '藍色單肩連身泳裝', '黑色裙擺式連身泳裝',
  '深藍裙擺式連身泳裝', '粉色兩件式裙泳裝', '黑色坦基尼泳裝', '海軍藍坦基尼泳裝', '白色短版上衣兩件式泳裝',
  '黑色短版上衣兩件式泳裝', '藍色短袖兩件式泳裝', '黑色長袖兩件式泳裝', '米色針織紋理比基尼', '銀灰色極簡連身泳裝',
].map((text, index) => ({ id: `SW${String(index + 1).padStart(2, '0')}`, text }));

const MINISKIRT_STYLES = [
  '黑色百褶迷你裙', '灰色百褶迷你裙', '白色 A 字迷你裙', '牛仔藍 A 字迷你裙', '黑色高腰包臀迷你裙',
  '深灰直筒迷你裙', '卡其工裝迷你裙', '橄欖綠工裝迷你裙', '黑色皮革迷你裙', '棕色麂皮迷你裙',
  '紅黑格紋迷你裙', '灰白格紋迷你裙', '白色蕾絲迷你裙', '奶油色針織迷你裙', '黑色針織迷你裙',
  '深藍運動迷你裙', '白色網球迷你裙', '粉色傘擺迷你裙', '酒紅色燈芯絨迷你裙', '銀灰色亮面迷你裙',
].map((text, index) => ({ id: `MS${String(index + 1).padStart(2, '0')}`, text }));

const BRA_STYLES = [
  '白色無鋼圈三角內衣', '黑色無鋼圈三角內衣', '裸色無痕 T-shirt 內衣', '黑色無痕 T-shirt 內衣', '白色全罩杯內衣',
  '黑色全罩杯內衣', '膚色四分之三罩杯內衣', '酒紅色四分之三罩杯內衣', '白色半罩杯內衣', '黑色半罩杯內衣',
  '淡粉色陽台型內衣', '深藍色陽台型內衣', '白色蕾絲三角內衣', '黑色蕾絲三角內衣', '奶油色蕾絲內衣',
  '酒紅色蕾絲內衣', '淺藍色刺繡內衣', '墨綠色刺繡內衣', '白色運動內衣', '黑色運動內衣',
  '灰色工字背運動內衣', '海軍藍高支撐運動內衣', '黑色長版運動內衣', '白色細肩帶內衣', '黑色細肩帶內衣',
  '膚色可拆肩帶內衣', '黑色無肩帶內衣', '白色平口內衣', '黑色平口內衣', '淡紫色交叉背內衣',
  '灰藍色前扣內衣', '黑色後背交叉內衣', '米白色背心式內衣', '灰色棉質背心內衣', '白色羅紋內衣',
  '黑色羅紋內衣', '淡粉色柔棉內衣', '奶茶色柔棉內衣', '黑色深 V 內衣', '白色深 V 內衣',
  '紅色繞頸內衣', '黑色單肩內衣', '白色單肩內衣', '藍白條紋內衣', '黑白撞色內衣',
  '花卉印花內衣', '點點印花內衣', '豆沙色緞面內衣', '黑色緞面內衣', '銀灰色極簡內衣',
].map((text, index) => ({ id: `BR${String(index + 1).padStart(2, '0')}`, text }));

const PANTY_STYLES = [
  '白色棉質三角內褲', '黑色棉質三角內褲', '膚色無痕三角內褲', '黑色無痕三角內褲', '白色中腰三角內褲',
  '黑色中腰三角內褲', '裸色高腰內褲', '黑色高腰內褲', '白色低腰內褲', '黑色低腰內褲',
  '淡粉色蕾絲內褲', '酒紅色蕾絲內褲', '白色平口內褲', '黑色平口內褲', '灰色四角內褲',
  '海軍藍四角內褲', '白色高衩內褲', '黑色高衩內褲', '膚色丁字內褲', '黑色丁字內褲',
  '白色巴西式內褲', '黑色巴西式內褲', '淡紫色 V 腰內褲', '豆沙色 V 腰內褲', '白色羅紋內褲',
  '黑色羅紋內褲', '灰色運動內褲', '黑色運動內褲', '白色無縫內褲', '膚色無縫內褲',
  '奶油色柔棉內褲', '淡藍色柔棉內褲', '粉色花邊內褲', '黑色花邊內褲', '白色刺繡內褲',
  '墨綠色刺繡內褲', '藍白條紋內褲', '黑白撞色內褲', '花卉印花內褲', '波點印花內褲',
  '豆沙色緞面內褲', '黑色緞面內褲', '銀灰色極簡內褲', '白色側邊細帶內褲', '黑色側邊細帶內褲',
  '膚色塑身內褲', '黑色塑身內褲', '白色經期內褲', '黑色經期內褲', '海軍藍高腰運動內褲',
].map((text, index) => ({ id: `PT${String(index + 1).padStart(2, '0')}`, text }));

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
  const pools = {
    tops: [], bottoms: [], shoes: [], outerwear: [], hosiery: [], outfits: [],
    swimwear: SWIMWEAR_STYLES, miniskirts: MINISKIRT_STYLES, bras: BRA_STYLES, panties: PANTY_STYLES,
  };
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
    categories.identity.年齡層 = categories.identity.年齡層.filter((item) => YOUNG_ADULT_WOMAN_AGE.test(item.text));
    categories.identity.人物數量 = categories.identity.人物數量.filter((item) => item.text === '單人');
    if (categories.identity.年齡層.length !== 6) throw new Error(`Expected 6 young adult woman age options, found ${categories.identity.年齡層.length}`);
    if (categories.identity.人物數量.length !== 1) throw new Error(`Expected only the single-person identity option, found ${categories.identity.人物數量.length}`);
    if (!clothing || clothing.outfits.length !== 520) throw new Error(`Expected C001-C520, found ${clothing?.outfits.length ?? 0}`);
    if (clothing.outfits[0].id !== 'C001' || clothing.outfits.at(-1).id !== 'C520') throw new Error('Outfit IDs are not contiguous C001-C520');
    if (clothing.swimwear.length !== 50 || clothing.swimwear[0].id !== 'SW01' || clothing.swimwear.at(-1).id !== 'SW50') throw new Error('Expected contiguous swimwear IDs SW01-SW50');
    if (clothing.miniskirts.length !== 20 || clothing.miniskirts[0].id !== 'MS01' || clothing.miniskirts.at(-1).id !== 'MS20') throw new Error('Expected contiguous miniskirt IDs MS01-MS20');
    if (clothing.bras.length !== 50 || clothing.bras[0].id !== 'BR01' || clothing.bras.at(-1).id !== 'BR50') throw new Error('Expected contiguous bra IDs BR01-BR50');
    if (clothing.panties.length !== 50 || clothing.panties[0].id !== 'PT01' || clothing.panties.at(-1).id !== 'PT50') throw new Error('Expected contiguous panty IDs PT01-PT50');
    return { schemaVersion: 1, libraryVersion: `person-photo-v4-clothing-categories-${sourceSha256.slice(0, 12)}`, source: basename(absolute), sourceSha256, markdownFileCount: files.length, categories, clothing };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = process.argv[2] ?? resolve(process.cwd(), '../person_photo_prompt_docs.zip');
  const output = process.argv[3] ?? resolve(process.cwd(), 'server/image-generation/person-photo-library.v1.json');
  const library = importPersonPhotoPrompts(source);
  writeFileSync(output, `${JSON.stringify(library, null, 2)}\n`);
  console.log(`Imported ${library.markdownFileCount} Markdown files and ${library.clothing.outfits.length} outfits to ${output}`);
}
