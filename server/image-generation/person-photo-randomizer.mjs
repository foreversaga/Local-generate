import { readFile } from 'node:fs/promises';

const LIBRARY_URL = new URL('./person-photo-library.v1.json', import.meta.url);
export const PERSON_PHOTO_RULES_VERSION = 'person-photo-rules-v1';
let cachedLibrary;

export async function loadPersonPhotoLibrary() {
  cachedLibrary ??= JSON.parse(await readFile(LIBRARY_URL, 'utf8'));
  return cachedLibrary;
}

export async function personPhotoLibrarySummary() {
  const library = await loadPersonPhotoLibrary();
  return {
    id: 'person-photo',
    version: library.libraryVersion,
    sourceHash: library.sourceSha256,
    rulesVersion: PERSON_PHOTO_RULES_VERSION,
    clothingOptions: {
      outfit: library.clothing.outfits.map(({ id, text }) => ({ id, label: text, text })),
      top: library.clothing.tops.map(({ id, text }) => ({ id, label: text, text })),
      bottom: library.clothing.bottoms.map(({ id, text }) => ({ id, label: text, text })),
      hosiery: library.clothing.hosiery.map(({ id, text }) => ({ id, label: text, text })),
      shoes: library.clothing.shoes.map(({ id, text }) => ({ id, label: text, text })),
      outerwear: library.clothing.outerwear.map(({ id, text }) => ({ id, label: text, text })),
      custom: [],
    },
    libraryVersion: library.libraryVersion,
    sourceSha256: library.sourceSha256,
    markdownFileCount: library.markdownFileCount,
    outfitCount: library.clothing.outfits.length,
    hosiery: library.clothing.hosiery,
  };
}

function hash32(value) {
  let hash = 2166136261;
  for (const char of String(value)) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 1;
}

function rngFor(seed) {
  let state = hash32(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (items, random) => items[Math.floor(random() * items.length)];
const textOf = (entry) => entry?.text ?? '';
const section = (sections, pattern) => Object.entries(sections ?? {}).find(([key]) => pattern.test(key))?.[1] ?? [];
const lockedValue = (locks, key) => locks?.[key];

function choose(items, random, lock, label) {
  if (!items.length) throw new Error(`No options available for ${label}`);
  if (lock == null || lock === '') return pick(items, random);
  const requested = typeof lock === 'object' ? lock.id ?? lock.optionId ?? lock.value : lock;
  const found = items.find((item) => item.id === requested || item.text === requested);
  if (!found) throw Object.assign(new Error(`Unknown ${label} lock: ${requested}`), { code: 'PERSON_PHOTO_LOCK_INVALID' });
  return found;
}

function matchPool(pool, requirement) {
  const wanted = requirement.optionId ?? requirement.value;
  return pool.filter((item) => item.id === wanted || item.text === wanted || (!requirement.optionId && item.text.includes(String(wanted ?? ''))));
}

function resolveRequirements(library, requirements = []) {
  return requirements.map((requirement) => {
    if (requirement.applyToAll === false) throw Object.assign(new Error('Only applyToAll:true is supported'), { code: 'PERSON_PHOTO_REQUIREMENT_SCOPE_INVALID' });
    let category = String(requirement.category ?? '').toLowerCase();
    if (['socks', '襪類', '襪子'].includes(category)) category = 'hosiery';
    if (!['hosiery', 'top', 'bottom', 'shoes', 'outerwear', 'outfit', 'custom'].includes(category)) throw Object.assign(new Error(`Unsupported clothing requirement category: ${requirement.category}`), { code: 'PERSON_PHOTO_REQUIREMENT_INVALID' });
    if (category === 'custom') {
      const text = String(requirement.value ?? '').trim();
      if (!text) throw Object.assign(new Error('Custom clothing requirement cannot be empty'), { code: 'PERSON_PHOTO_REQUIREMENT_INVALID' });
      return { category, value: text, optionId: null, applyToAll: true, candidates: [{ id: `custom:${hash32(text)}`, text }] };
    }
    const poolName = ({ top: 'tops', bottom: 'bottoms', shoes: 'shoes', outerwear: 'outerwear', outfit: 'outfits', hosiery: 'hosiery' })[category];
    let candidates = library.clothing[poolName];
    if (category === 'hosiery' && !requirement.optionId && /白襪|白色襪/.test(requirement.value ?? '')) candidates = candidates.filter((item) => ['H01', 'H04'].includes(item.id));
    else candidates = matchPool(candidates, requirement);
    if (!candidates.length) throw Object.assign(new Error(`No ${category} matches: ${requirement.optionId ?? requirement.value}`), { code: 'PERSON_PHOTO_REQUIREMENT_INVALID' });
    return { category, value: requirement.value, optionId: requirement.optionId, applyToAll: true, candidates };
  });
}

const SOCK_BOTTOM = /短褲|短裙|九分褲/;
const SOCK_SHOE = /低筒|休閒鞋|跑鞋|樂福鞋|瑪麗珍鞋|平底鞋|低跟鞋|厚底/;
const SOCK_FRAME = /全身|鞋底/;
const CLOSE_FRAME = /特寫|胸上/;
const SMALL_INTERIOR = /小型公寓|臥室|更衣室|玄關|化妝桌|書房桌邊/;
const LONG_LENS = /105mm|135mm/;
const SELFIE = /手機隨拍|社群生活照/;
const DISTANT_FRAME = /遠距離環境人像/;
const FULL_BODY_FRAME = /全身|鞋底|人物帶環境|遠距離環境人像/;

function focalMm(entry) { return Number.parseInt(textOf(entry).match(/\d+/)?.[0] ?? '0', 10); }
function distanceMeters(entry) { return Number.parseFloat(textOf(entry).match(/\d+(?:\.\d+)?/)?.[0] ?? '0'); }
function distanceCompatible(framing, focalLength, distance) {
  const meters = distanceMeters(distance);
  const mm = focalMm(focalLength);
  if (FULL_BODY_FRAME.test(textOf(framing))) {
    const minimum = mm <= 30 ? 2 : mm <= 58 ? 3 : mm <= 85 ? 4 : 5;
    if (meters < minimum) return false;
  }
  if (DISTANT_FRAME.test(textOf(framing)) && meters < 4) return false;
  if (mm >= 105 && meters < 4) return false;
  if (mm >= 70 && meters < 2) return false;
  return true;
}

function photoTypeSceneCompatible(photoType, scene) {
  const photo = textOf(photoType);
  const place = textOf(scene);
  const sceneId = scene?.id ?? '';
  if (/公園/.test(photo)) return /scene\.自然場景\./.test(sceneId) && /公園|草地|樹蔭步道|花園/.test(place);
  if (/海邊/.test(photo)) return /scene\.自然場景\./.test(sceneId) && /海邊|沙灘|岩岸/.test(place);
  if (/咖啡廳/.test(photo)) return /咖啡廳|咖啡店門口/.test(place);
  if (/居家|室內生活/.test(photo)) return /scene\.居家室內\./.test(sceneId);
  if (/棚拍/.test(photo)) return /攝影棚|白棚|背景棚/.test(place);
  if (/夜間都市/.test(photo)) return /scene\.城市場景\./.test(sceneId) && /霓虹|夜市|街道|商業區|十字路口/.test(place);
  if (/街拍|都市時尚|都市/.test(photo)) return /scene\.城市場景\./.test(sceneId);
  if (/戶外自然/.test(photo)) return /scene\.自然場景\./.test(sceneId);
  return true;
}

function outdoorLightingCompatible(scene, source, direction) {
  const outdoor = /scene\.(城市場景|自然場景|建築_景點)\./.test(scene?.id ?? '');
  if (!outdoor) return true;
  return !/窗戶|落地窗/.test(textOf(source)) && !/窗邊|門口/.test(textOf(direction));
}

function ratioDimensions(ratio) {
  return ({ '9:16': [768, 1360], '4:5': [896, 1120], '3:4': [864, 1152], '2:3': [832, 1248], '16:9': [1360, 768], '3:2': [1248, 832], '4:3': [1152, 864] })[ratio] ?? [896, 1120];
}

export function validatePersonPhotoRecipe(recipe) {
  const checks = [];
  const hard = (id, passed, detail) => checks.push({ id, severity: 'hard', passed, detail });
  const soft = (id, passed, detail) => checks.push({ id, severity: 'soft', passed, detail });
  const s = recipe.selections;
  const whiteSocks = ['H01', 'H04'].includes(s.hosiery?.id);
  hard('white-socks-visible-bottom', !whiteSocks || SOCK_BOTTOM.test(textOf(s.outfit)), '白襪需搭配短褲、短裙或九分褲');
  hard('white-socks-compatible-shoe', !whiteSocks || SOCK_SHOE.test(s.outfit?.shoe ?? ''), '白襪需搭配低筒相容鞋款');
  hard('white-socks-visible-framing', !whiteSocks || SOCK_FRAME.test(textOf(s.framing)), '白襪需使用至少膝上或全身構圖');
  hard('selfie-not-long-lens', !(SELFIE.test(textOf(s.photoType)) && LONG_LENS.test(textOf(s.focalLength))), '自拍或社群隨拍不搭配 105–135mm 長焦');
  hard('closeup-no-footwear', !(CLOSE_FRAME.test(textOf(s.framing)) && whiteSocks), '特寫不能要求可見鞋襪');
  hard('small-interior-not-135mm', !(SMALL_INTERIOR.test(textOf(s.scene)) && /135mm/.test(textOf(s.focalLength))), '小型室內空間不使用 135mm');
  hard('framing-focal-distance-compatible', distanceCompatible(s.framing, s.focalLength, s.distance), '構圖、焦段與拍攝距離必須符合真實光學關係');
  hard('photo-type-scene-compatible', photoTypeSceneCompatible(s.photoType, s.scene), '照片類型必須搭配相容的拍攝場景');
  hard('outdoor-lighting-compatible', outdoorLightingCompatible(s.scene, s.lighting?.source, s.lighting?.direction), '戶外場景不可使用窗戶光或窗邊、門口方向');
  const captureText = textOf(s.captureProfile);
  const requestedLook = `${textOf(s.photoType)} ${textOf(s.style)}`;
  hard('capture-profile-aligned', !/CCD/.test(requestedLook) || /CCD|消費型數位/.test(captureText), 'CCD 風格必須使用 CCD 或消費型數位相機 profile');
  hard('capture-profile-mobile-aligned', !/手機/.test(requestedLook) || /手機/.test(captureText), '手機風格必須使用手機 capture profile');
  hard('capture-profile-film-aligned', !/底片/.test(requestedLook) || /底片/.test(captureText), '底片風格必須使用底片 capture profile');
  soft('outfit-scene-tone', !(/運動/.test(textOf(s.outfit)) && /飯店大廳|精品/.test(textOf(s.scene))), '運動服與正式精品場景的調性較弱');
  const failedHard = checks.filter((item) => item.severity === 'hard' && !item.passed);
  const warnings = checks.filter((item) => item.severity === 'soft' && !item.passed).map((item) => item.detail);
  return { rulesVersion: PERSON_PHOTO_RULES_VERSION, passed: failedHard.length === 0, score: Math.max(0, 100 - failedHard.length * 30 - warnings.length * 7), warnings, checks };
}

function selectCategory(sections, random, locks, category) {
  const result = {};
  for (const [key, items] of Object.entries(sections ?? {})) result[key] = choose(items, random, lockedValue(locks, `${category}.${key}`), `${category}.${key}`);
  return result;
}

export function buildPersonPhotoRecipeBrief(recipe) {
  const s = recipe.selections;
  return [s.photoType, s.style, ...Object.values(s.identity), ...Object.values(s.face), ...Object.values(s.hair), ...Object.values(s.body), ...Object.values(s.skin), s.outfit, s.hosiery, s.outerwear, ...s.customClothing, s.pose, s.expression, s.framing, s.ratio, ...Object.values(s.cameraAngle), s.focalLength, s.distance, s.scene, ...Object.values(s.lighting), s.captureProfile].filter(Boolean).map(textOf).join('，');
}

function makeRecipe(library, { batchIndex, batchSize, recipeSeed, locks, requirements }) {
  const random = rngFor(recipeSeed);
  const c = library.categories;
  const byCategory = (name) => requirements.filter((item) => item.category === name);
  const whiteSockRequirement = byCategory('hosiery').find((item) => item.candidates.some((candidate) => ['H01', 'H04'].includes(candidate.id)));
  const hosieryPool = byCategory('hosiery')[0]?.candidates ?? library.clothing.hosiery;
  const hosiery = choose(hosieryPool, random, lockedValue(locks, 'hosiery'), 'hosiery');
  const visibleSocks = whiteSockRequirement || ['H01', 'H04'].includes(hosiery.id);
  let outfitPool = library.clothing.outfits;
  for (const requirement of requirements) {
    if (requirement.category === 'outfit') outfitPool = outfitPool.filter((item) => requirement.candidates.some((candidate) => candidate.id === item.id));
    if (requirement.category === 'top') outfitPool = outfitPool.filter((item) => requirement.candidates.some((candidate) => candidate.text === item.top));
    if (requirement.category === 'bottom') outfitPool = outfitPool.filter((item) => requirement.candidates.some((candidate) => candidate.text === item.bottom));
    if (requirement.category === 'shoes') outfitPool = outfitPool.filter((item) => requirement.candidates.some((candidate) => candidate.text === item.shoe));
  }
  if (visibleSocks) outfitPool = outfitPool.filter((item) => SOCK_BOTTOM.test(item.text) && SOCK_SHOE.test(item.shoe));
  if (!outfitPool.length) throw Object.assign(new Error('Clothing requirements cannot be combined into a C outfit'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  const framingPool = visibleSocks ? section(c.composition, /取景範圍/).filter((item) => SOCK_FRAME.test(item.text)) : section(c.composition, /取景範圍/);
  const outfit = choose(outfitPool, random, lockedValue(locks, 'outfit'), 'outfit');
  const photoType = choose(section(c.imageGoal, /照片類型/), random, lockedValue(locks, 'photoType'), 'photoType');
  let stylePool = section(c.imageGoal, /風格方向/);
  if (/手機/.test(photoType.text)) stylePool = stylePool.filter((item) => !/CCD|底片/.test(item.text));
  else if (/CCD/.test(photoType.text)) stylePool = stylePool.filter((item) => !/手機|底片/.test(item.text));
  else if (/底片/.test(photoType.text)) stylePool = stylePool.filter((item) => !/手機|CCD/.test(item.text));
  const style = choose(stylePool, random, lockedValue(locks, 'style'), 'style');
  const framing = choose(framingPool, random, lockedValue(locks, 'framing'), 'framing');
  let focalPool = section(c.lens, /焦段/);
  if (SELFIE.test(photoType.text)) focalPool = focalPool.filter((item) => !LONG_LENS.test(item.text));
  let focalLength = choose(focalPool, random, lockedValue(locks, 'focalLength'), 'focalLength');
  const scenePool = Object.entries(c.scene).filter(([key]) => /居家室內|商業室內|城市場景|自然場景|建築_景點/.test(key)).flatMap(([, items]) => items).filter((item) => photoTypeSceneCompatible(photoType, item));
  const scene = choose(scenePool, random, lockedValue(locks, 'scene'), 'scene');
  if (SMALL_INTERIOR.test(scene.text) && /135mm/.test(focalLength.text) && !lockedValue(locks, 'focalLength')) focalLength = choose(focalPool.filter((item) => !/135mm/.test(item.text)), random, null, 'focalLength');
  const ratio = choose([...section(c.composition, /直式比例/), ...section(c.composition, /橫式比例/)], random, lockedValue(locks, 'ratio'), 'ratio');
  const [width, height] = ratioDimensions(ratio.text);
  const identity = {
    age: choose(section(c.identity, /年齡層/), random, lockedValue(locks, 'identity.age'), 'identity.age'),
    appearance: choose(section(c.identity, /外觀地域風格/), random, lockedValue(locks, 'identity.appearance'), 'identity.appearance'),
    atmosphere: choose(section(c.identity, /身份氛圍/), random, lockedValue(locks, 'identity.atmosphere'), 'identity.atmosphere'),
    temperament: choose(section(c.identity, /個人氣質/), random, lockedValue(locks, 'identity.temperament'), 'identity.temperament'),
    count: section(c.identity, /人物數量/).find((item) => item.text === '單人'),
  };
  const hair = {
    style: choose(section(c.hair, /剪裁_輪廓/), random, lockedValue(locks, 'hair.style'), 'hair.style'),
    color: choose(section(c.hair, /髮色/), random, lockedValue(locks, 'hair.color'), 'hair.color'),
    bangs: choose(section(c.hair, /瀏海/), random, lockedValue(locks, 'hair.bangs'), 'hair.bangs'),
    texture: choose(section(c.hair, /髮量_質感/), random, lockedValue(locks, 'hair.texture'), 'hair.texture'),
  };
  const cameraAngle = {
    vertical: choose(section(c.cameraAngle, /垂直角度/), random, lockedValue(locks, 'cameraAngle.vertical'), 'cameraAngle.vertical'),
    height: choose(section(c.cameraAngle, /相機高度/), random, lockedValue(locks, 'cameraAngle.height'), 'cameraAngle.height'),
    horizontal: choose(section(c.cameraAngle, /水平方向/), random, lockedValue(locks, 'cameraAngle.horizontal'), 'cameraAngle.horizontal'),
  };
  const indoorScene = /scene\.(居家室內|商業室內)\./.test(scene.id);
  const outdoorScene = /scene\.(城市場景|自然場景|建築_景點)\./.test(scene.id);
  const studioLook = /棚拍|攝影棚|白棚|背景棚|商業廣告|雜誌|時裝|editorial/i.test(`${photoType.text} ${style.text} ${scene.text}`);
  const lightSources = [...section(c.lighting, /自然光/).filter((item) => !outdoorScene || !/窗戶|落地窗/.test(item.text)), ...(indoorScene ? section(c.lighting, /室內光/) : []), ...(studioLook ? section(c.lighting, /攝影用光/) : [])];
  const lightDirections = section(c.lighting, /光線方向/).filter((item) => !outdoorScene || !/窗邊|門口/.test(item.text));
  const lighting = { source: choose(lightSources, random, lockedValue(locks, 'lighting.source'), 'lighting.source'), direction: choose(lightDirections, random, lockedValue(locks, 'lighting.direction'), 'lighting.direction'), quality: choose(section(c.lighting, /光質/), random, lockedValue(locks, 'lighting.quality'), 'lighting.quality') };
  const outerwearRequirement = byCategory('outerwear')[0];
  const noOuterwear = library.clothing.outerwear.find((item) => item.id === 'O00');
  const outerwear = choose(outerwearRequirement?.candidates ?? [noOuterwear], random, lockedValue(locks, 'outerwear'), 'outerwear');
  const customClothing = byCategory('custom').map((item) => item.candidates[0]);
  const requestedCapture = `${photoType.text} ${style.text}`;
  let capturePool = section(c.photographicTexture, /相機類型感/);
  if (/手機/.test(requestedCapture)) capturePool = capturePool.filter((item) => /手機/.test(item.text));
  else if (/CCD/.test(requestedCapture)) capturePool = capturePool.filter((item) => /CCD|消費型數位/.test(item.text));
  else if (/底片/.test(requestedCapture)) capturePool = capturePool.filter((item) => /底片/.test(item.text));
  const distancePool = section(c.lens, /拍攝距離/).filter((item) => distanceCompatible(framing, focalLength, item));
  const selections = {
    photoType, style,
    identity, face: selectCategory(c.face, random, locks, 'face'), hair,
    body: selectCategory(c.body, random, locks, 'body'), skin: selectCategory(c.skin, random, locks, 'skin'), outfit, hosiery, outerwear, customClothing,
    pose: choose([...section(c.pose, /站姿/), ...section(c.pose, /坐姿/), ...section(c.pose, /蹲_跪姿/), ...section(c.pose, /躺姿/), ...section(c.pose, /動態姿勢/)], random, lockedValue(locks, 'pose'), 'pose'), expression: choose(section(c.expression, /情緒組合|基本表情/), random, lockedValue(locks, 'expression'), 'expression'),
    framing, ratio, cameraAngle, focalLength,
    distance: choose(distancePool, random, lockedValue(locks, 'distance'), 'distance'), scene,
    lighting, captureProfile: choose(capturePool, random, lockedValue(locks, 'captureProfile'), 'captureProfile'),
  };
  const recipe = { id: `person-photo-${recipeSeed}-${batchIndex + 1}`, batchIndex, batchSize, recipeSeed, libraryVersion: library.libraryVersion, sourceHash: library.sourceSha256, brief: '', selections, hardRequirements: requirements.map(({ candidates, ...item }) => {
    const componentKey = { top: 'top', bottom: 'bottom', shoes: 'shoe' }[item.category];
    const selected = item.category === 'hosiery' ? hosiery : item.category === 'outerwear' ? outerwear : item.category === 'custom' ? candidates[0] : item.category === 'outfit' ? outfit : candidates.find((candidate) => candidate.text === outfit[componentKey]);
    return { ...item, resolvedOptionIds: candidates.map((candidate) => candidate.id), selectedItem: { id: selected.id, text: selected.text } };
  }), dimensions: { aspectRatio: ratio.text, width, height } };
  recipe.brief = buildPersonPhotoRecipeBrief(recipe);
  recipe.validation = validatePersonPhotoRecipe(recipe);
  if (!recipe.validation.passed) throw Object.assign(new Error('Locked values create an invalid person photo recipe'), { code: 'PERSON_PHOTO_RECIPE_INVALID', validation: recipe.validation });
  return recipe;
}

export async function randomizePersonPhotoRecipes({ seed = Date.now(), count = 1, locks = {}, clothingRequirements = [] } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 20) throw Object.assign(new Error('count must be an integer from 1 to 20'), { code: 'PERSON_PHOTO_COUNT_INVALID' });
  const library = await loadPersonPhotoLibrary();
  const requirements = resolveRequirements(library, clothingRequirements);
  const batchSeed = hash32(seed);
  const recipes = Array.from({ length: count }, (_, batchIndex) => makeRecipe(library, { batchIndex, batchSize: count, recipeSeed: hash32(`${batchSeed}:${batchIndex}`), locks, requirements }));
  return { mode: count === 1 ? 'single' : 'batch', batchSeed, count, recipes };
}
