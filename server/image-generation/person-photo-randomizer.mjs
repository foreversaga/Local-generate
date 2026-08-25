import { readFile } from 'node:fs/promises';

const LIBRARY_URL = new URL('./person-photo-library.v1.json', import.meta.url);
export const PERSON_PHOTO_RULES_VERSION = 'person-photo-rules-v8-intimate-poses-sets';
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
      swimwear: library.clothing.swimwear.map(({ id, text, group }) => ({ id, label: text, text, group })),
      miniskirt: library.clothing.miniskirts.map(({ id, text }) => ({ id, label: text, text })),
      bra: library.clothing.bras.map(({ id, text, group }) => ({ id, label: text, text, group })),
      panties: library.clothing.panties.map(({ id, text, group }) => ({ id, label: text, text, group })),
      underwearSet: library.clothing.underwearSets.map(({ id, text, group }) => ({ id, label: text, text, group })),
      custom: [],
    },
    poseOptions: poseOptionsFor(library).map(({ id, text, group }) => ({ id, label: text, text, group })),
    libraryVersion: library.libraryVersion,
    sourceSha256: library.sourceSha256,
    markdownFileCount: library.markdownFileCount,
    outfitCount: library.clothing.outfits.length,
    swimwearCount: library.clothing.swimwear.length,
    miniskirtCount: library.clothing.miniskirts.length,
    braCount: library.clothing.bras.length,
    pantyCount: library.clothing.panties.length,
    underwearSetCount: library.clothing.underwearSets.length,
    photoGoals: photoGoalStats(library),
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
const POSE_SECTIONS = /^(?:站姿|坐姿|蹲_跪姿|躺姿|動態姿勢|性感姿勢|情慾姿勢)$/;

function poseOptionsFor(library) {
  return Object.entries(library.categories.pose ?? {}).filter(([key]) => POSE_SECTIONS.test(key)).flatMap(([, items]) => items);
}

function choose(items, random, lock, label) {
  if (!items.length) throw new Error(`No options available for ${label}`);
  if (lock == null || lock === '') return pick(items, random);
  const requested = typeof lock === 'object' ? lock.id ?? lock.optionId ?? lock.value : lock;
  const found = items.find((item) => item.id === requested || item.text === requested);
  if (!found) throw Object.assign(new Error(`Unknown ${label} lock: ${requested}`), { code: 'PERSON_PHOTO_LOCK_INVALID' });
  return found;
}

function chooseDistinct(items, random, count, label) {
  if (items.length < count) throw new Error(`Not enough options available for ${label}`);
  const pool = [...items];
  return Array.from({ length: count }, () => pool.splice(Math.floor(random() * pool.length), 1)[0]);
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
    if (category === 'underwearset') category = 'underwearSet';
    if (!['hosiery', 'top', 'bottom', 'shoes', 'outerwear', 'outfit', 'swimwear', 'miniskirt', 'bra', 'panties', 'underwearSet', 'custom'].includes(category)) throw Object.assign(new Error(`Unsupported clothing requirement category: ${requirement.category}`), { code: 'PERSON_PHOTO_REQUIREMENT_INVALID' });
    if (category === 'custom') {
      const text = String(requirement.value ?? '').trim();
      if (!text) throw Object.assign(new Error('Custom clothing requirement cannot be empty'), { code: 'PERSON_PHOTO_REQUIREMENT_INVALID' });
      return { category, value: text, optionId: null, applyToAll: true, candidates: [{ id: `custom:${hash32(text)}`, text }] };
    }
    const poolName = ({ top: 'tops', bottom: 'bottoms', shoes: 'shoes', outerwear: 'outerwear', outfit: 'outfits', hosiery: 'hosiery', swimwear: 'swimwear', miniskirt: 'miniskirts', bra: 'bras', panties: 'panties', underwearSet: 'underwearSets' })[category];
    let candidates = library.clothing[poolName];
    const hasSelectedStyle = Boolean(String(requirement.optionId ?? requirement.value ?? '').trim());
    if (hasSelectedStyle && category === 'hosiery' && !requirement.optionId && /白襪|白色襪/.test(requirement.value ?? '')) candidates = candidates.filter((item) => ['H01', 'H04'].includes(item.id));
    else if (hasSelectedStyle) candidates = matchPool(candidates, requirement);
    if (!candidates.length) throw Object.assign(new Error(`No ${category} matches: ${requirement.optionId ?? requirement.value}`), { code: 'PERSON_PHOTO_REQUIREMENT_INVALID' });
    return { category, value: requirement.value, optionId: requirement.optionId, applyToAll: true, candidates };
  });
}

const SOCK_BOTTOM = /短褲|短裙|迷你裙|九分褲/;
const SOCK_SHOE = /低筒|休閒鞋|跑鞋|樂福鞋|瑪麗珍鞋|平底鞋|低跟鞋|厚底/;
const SOCK_FRAME = /全身|鞋底/;
const CLOSE_FRAME = /特寫|胸上/;
const SMALL_INTERIOR = /小型公寓|臥室|更衣室|玄關|化妝桌|書房桌邊/;
const LONG_LENS = /105mm|135mm/;
const SELFIE = /手機隨拍|社群生活照|前置鏡頭自拍|鏡前穿搭自拍/;
const DISTANT_FRAME = /遠距離環境人像/;
const FULL_BODY_FRAME = /全身|鞋底|人物帶環境|遠距離環境人像/;
const YOUNG_ADULT_WOMAN_AGE = /^(?:18–20|20–22|23–25|26–29) 歲成年女性$|^20(?: 歲出頭| 多歲)年輕成年女性$/;
const UNDERWEAR_SCENE = /臥室|更衣室|攝影棚|白棚|背景棚/;
const UNDERWEAR_PHOTO_TYPE = /真人人像|日常生活感|時尚寫真|雜誌人物|商業廣告|棚拍人物|品牌形象|Lookbook|生活方式廣告|無修圖|高級時裝|清新日系|韓系生活|底片感|自然光寫真/;
const UNDERWEAR_FRAME = /大腿以上|膝蓋以上|三分之二身|全身|鞋底|人物帶環境/;

function youngAdultWoman(entry) { return YOUNG_ADULT_WOMAN_AGE.test(textOf(entry)); }

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

function captureKind(entry) {
  if (entry?.captureKind) return entry.captureKind;
  const text = textOf(entry);
  if (/手機|前置鏡頭|鏡前.*自拍|iPhone|Android/.test(text)) return 'phone';
  if (/CCD|消費型數位|復古數位/.test(text)) return 'ccd';
  if (/底片|35mm/.test(text)) return 'film';
  if (/中片幅/.test(text)) return 'medium-format';
  return null;
}

function termsOverlap(left, right) {
  return !left?.length || !right?.length || left.some((term) => right.includes(term));
}

function photoGoalEntriesCompatible(photoType, style) {
  const photoKind = captureKind(photoType);
  const styleKind = captureKind(style);
  return (!photoKind || !styleKind || photoKind === styleKind)
    && termsOverlap(photoType?.sceneGroups, style?.sceneGroups)
    && termsOverlap(photoType?.lightingSourceTerms, style?.lightingSourceTerms)
    && termsOverlap(photoType?.lightingDirectionTerms, style?.lightingDirectionTerms);
}

function metadataSceneCompatible(entry, scene) {
  const sceneId = scene?.id ?? '';
  const place = textOf(scene);
  if (entry?.sceneGroups?.length && !entry.sceneGroups.some((group) => sceneId.startsWith(`scene.${group}.`))) return false;
  if (entry?.sceneTerms?.length && !entry.sceneTerms.some((term) => place.includes(term))) return false;
  return true;
}

function photoTypeSceneCompatible(photoType, scene) {
  const metadataCompatible = metadataSceneCompatible(photoType, scene);
  if (!metadataCompatible) return false;
  if (photoType?.sceneGroups?.length || photoType?.sceneTerms?.length) return true;
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

function styleSceneCompatible(style, scene) {
  return metadataSceneCompatible(style, scene);
}

function goalLightingCompatible(photoType, style, source, direction) {
  return [photoType, style].every((entry) => {
    const sourceCompatible = !entry?.lightingSourceTerms?.length || entry.lightingSourceTerms.some((term) => textOf(source).includes(term));
    const directionCompatible = !entry?.lightingDirectionTerms?.length || entry.lightingDirectionTerms.some((term) => textOf(direction).includes(term));
    return sourceCompatible && directionCompatible;
  });
}

function captureProfileCompatible(photoType, style, profile) {
  const requiredKind = captureKind(photoType) ?? captureKind(style);
  return !requiredKind || captureKind(profile) === requiredKind;
}

function photoGoalStats(library) {
  const photoTypes = section(library.categories.imageGoal, /照片類型/);
  const styles = section(library.categories.imageGoal, /風格方向/);
  const realismCues = section(library.categories.imageGoal, /真實度/);
  const scenes = Object.entries(library.categories.scene).filter(([key]) => /居家室內|商業室內|城市場景|自然場景|建築_景點/.test(key)).flatMap(([, items]) => items);
  const compatiblePhotoStylePairCount = photoTypes.reduce((total, photoType) => total + styles.filter((style) => photoGoalEntriesCompatible(photoType, style)
    && scenes.some((scene) => photoTypeSceneCompatible(photoType, scene) && styleSceneCompatible(style, scene))).length, 0);
  const realismPairCount = (realismCues.length * (realismCues.length - 1)) / 2;
  return {
    photoTypeCount: photoTypes.length,
    styleCount: styles.length,
    realismCueCount: realismCues.length,
    realismCuesPerRecipe: 2,
    compatiblePhotoStylePairCount,
    compatibleCombinationCount: compatiblePhotoStylePairCount * realismPairCount,
  };
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
  const swimwear = s.swimwear;
  const miniskirt = s.miniskirt;
  const underwearSet = s.underwearSet;
  const underwear = s.bra || s.panties || underwearSet;
  hard('young-adult-woman-only', youngAdultWoman(s.identity?.age), '人物只能是 18–29 歲的年輕成年女性');
  hard('single-person-only', textOf(s.identity?.count) === '單人', '人物只能是單人');
  hard('white-socks-visible-bottom', !whiteSocks || swimwear || SOCK_BOTTOM.test(textOf(s.outfit)), '白襪需搭配短褲、短裙或九分褲；泳裝不套用此限制');
  hard('white-socks-compatible-shoe', !whiteSocks || swimwear || SOCK_SHOE.test(s.outfit?.shoe ?? ''), '白襪需搭配低筒相容鞋款；泳裝不套用此限制');
  hard('white-socks-visible-framing', !whiteSocks || swimwear || SOCK_FRAME.test(textOf(s.framing)), '白襪需使用至少膝上或全身構圖；泳裝不套用此限制');
  hard('selfie-not-long-lens', !(SELFIE.test(textOf(s.photoType)) && LONG_LENS.test(textOf(s.focalLength))), '自拍或社群隨拍不搭配 105–135mm 長焦');
  hard('closeup-no-footwear', swimwear || !(CLOSE_FRAME.test(textOf(s.framing)) && whiteSocks), '特寫不能要求可見鞋襪；泳裝不套用此限制');
  hard('small-interior-not-135mm', !(SMALL_INTERIOR.test(textOf(s.scene)) && /135mm/.test(textOf(s.focalLength))), '小型室內空間不使用 135mm');
  hard('framing-focal-distance-compatible', distanceCompatible(s.framing, s.focalLength, s.distance), '構圖、焦段與拍攝距離必須符合真實光學關係');
  hard('photo-style-compatible', photoGoalEntriesCompatible(s.photoType, s.style), '照片類型與風格的拍攝設備、場景或光線條件不可衝突');
  hard('photo-type-scene-compatible', photoTypeSceneCompatible(s.photoType, s.scene), '照片類型必須搭配相容的拍攝場景');
  hard('style-scene-compatible', styleSceneCompatible(s.style, s.scene), '風格方向必須搭配相容的拍攝場景');
  hard('goal-lighting-compatible', goalLightingCompatible(s.photoType, s.style, s.lighting?.source, s.lighting?.direction), '照片目標指定的時段、天候與光線方向必須一致');
  hard('outdoor-lighting-compatible', outdoorLightingCompatible(s.scene, s.lighting?.source, s.lighting?.direction), '戶外場景不可使用窗戶光或窗邊、門口方向');
  hard('swimwear-stable-id', !swimwear || /^SW(?:0[1-9]|[1-9]\d|100)$/.test(swimwear.id), '泳裝樣式必須來自 SW01–SW100 清單');
  const swimwearLayerConflict = recipe.hardRequirements?.some((item) => ['outfit', 'top', 'bottom', 'miniskirt', 'bra', 'panties', 'underwearSet'].includes(item.category))
    || (swimwear && (s.outfit?.top !== swimwear.text || Boolean(s.outfit?.bottom)));
  hard('swimwear-no-upper-lower-clothing', !swimwear || !swimwearLayerConflict, '泳裝不可同時搭配一般上衣或下身');
  hard('miniskirt-stable-id', !miniskirt || /^MS(?:0[1-9]|1\d|20)$/.test(miniskirt.id), '迷你裙樣式必須來自 MS01–MS20 清單');
  hard('bra-stable-id', !s.bra || /^BR(?:0[1-9]|[1-9]\d|100)$/.test(s.bra.id), '上身內衣必須來自 BR01–BR100 清單');
  hard('panties-stable-id', !s.panties || /^PT(?:0[1-9]|[1-9]\d|100)$/.test(s.panties.id), '下身內褲必須來自 PT01–PT100 清單');
  hard('underwear-set-stable-id', !underwearSet || /^UW(?:0[1-9]|[1-9]\d|100)$/.test(underwearSet.id), '內衣組合必須來自 UW01–UW100 清單');
  hard('underwear-set-components-match', !underwearSet || (underwearSet.braId === s.bra?.id && underwearSet.pantiesId === s.panties?.id), '內衣組合的上身與下身款式必須完整對應');
  hard('underwear-complete-set', !underwear || Boolean(s.bra && s.panties), '內衣配方必須同時具有上身內衣與下身內褲');
  hard('underwear-style-group-compatible', !underwear || !s.bra?.group || !s.panties?.group || s.bra.group === s.panties.group, '上身內衣與下身內褲必須屬於同一款式分組');
  hard('underwear-scene-compatible', !underwear || UNDERWEAR_SCENE.test(textOf(s.scene)), '內衣只搭配臥室、更衣室或攝影棚場景');
  hard('underwear-visible-framing', !underwear || UNDERWEAR_FRAME.test(textOf(s.framing)), '內衣配方需使用能看見上身與下身款式的構圖');
  hard('underwear-no-hosiery', !underwear || s.hosiery?.id === 'H00', '內衣不可同時指定襪類');
  hard('underwear-no-outerwear', !underwear || s.outerwear?.id === 'O00', '內衣不可同時指定外套');
  hard('pose-style-group-known', !s.pose?.group || ['classic', 'sexy', 'sensual'].includes(s.pose.group), '姿勢分組必須是自然、性感或情慾');
  const requestedCaptureKind = captureKind(s.photoType) ?? captureKind(s.style);
  hard('capture-profile-aligned', !requestedCaptureKind || captureProfileCompatible(s.photoType, s.style, s.captureProfile), '照片目標必須使用對應的拍攝設備 profile');
  hard('capture-profile-ccd-aligned', requestedCaptureKind !== 'ccd' || captureKind(s.captureProfile) === 'ccd', 'CCD 或復古數位風格必須使用 CCD 或消費型數位相機 profile');
  hard('capture-profile-mobile-aligned', requestedCaptureKind !== 'phone' || captureKind(s.captureProfile) === 'phone', '手機風格必須使用手機 capture profile');
  hard('capture-profile-film-aligned', requestedCaptureKind !== 'film' || captureKind(s.captureProfile) === 'film', '底片風格必須使用底片 capture profile');
  hard('capture-profile-medium-format-aligned', requestedCaptureKind !== 'medium-format' || captureKind(s.captureProfile) === 'medium-format', '中片幅風格必須使用中片幅 capture profile');
  hard('realism-cues-present', Array.isArray(s.realism) && s.realism.length === 2 && new Set(s.realism.map((item) => item.id)).size === 2, '每張需包含兩個不重複的真實度訊號');
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
  const swimwearShoe = s.swimwear && s.outfit?.shoe ? { text: s.outfit.shoe } : null;
  const clothing = s.swimwear ? [s.swimwear, s.hosiery, swimwearShoe, s.outerwear] : s.bra || s.panties ? [s.bra, s.panties] : [s.outfit, s.hosiery, s.outerwear];
  const block = (label, values) => {
    const content = values.filter(Boolean).map(textOf).filter(Boolean).join('，');
    return content ? `【${label}】\n${content}` : '';
  };
  return [
    block('照片目標', [s.photoType, s.style, ...(s.realism ?? [])]),
    block('人物', [...Object.values(s.identity), ...Object.values(s.face), ...Object.values(s.hair), ...Object.values(s.body), ...Object.values(s.skin)]),
    block('服裝', [...clothing, ...s.customClothing]),
    block('動作與表情', [s.pose, s.expression]),
    block('構圖與鏡位', [s.framing, s.ratio, ...Object.values(s.cameraAngle), s.focalLength, s.distance]),
    block('場景', [s.scene]),
    block('光線', Object.values(s.lighting)),
    block('拍攝質感', [s.captureProfile]),
  ].filter(Boolean).join('\n\n');
}

function makeRecipe(library, { batchIndex, batchSize, recipeSeed, locks, requirements }) {
  const random = rngFor(recipeSeed);
  const c = library.categories;
  const byCategory = (name) => requirements.filter((item) => item.category === name);
  const swimwearRequirements = byCategory('swimwear');
  const hasSwimwear = swimwearRequirements.length > 0;
  const miniskirtRequirements = byCategory('miniskirt');
  const hasMiniskirt = miniskirtRequirements.length > 0;
  const braRequirements = byCategory('bra');
  const pantyRequirements = byCategory('panties');
  const underwearSetRequirements = byCategory('underwearSet');
  const hasUnderwear = braRequirements.length > 0 || pantyRequirements.length > 0 || underwearSetRequirements.length > 0;
  if ([hasSwimwear, hasMiniskirt, hasUnderwear].filter(Boolean).length > 1) throw Object.assign(new Error('Swimwear, miniskirts and underwear are mutually exclusive clothing modes'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  const incompatibleSwimwearRequirement = ['outfit', 'top', 'bottom', 'miniskirt', 'bra', 'panties', 'underwearSet'].some((category) => byCategory(category).length);
  if (hasSwimwear && incompatibleSwimwearRequirement) throw Object.assign(new Error('Swimwear cannot be combined with regular upper or lower clothing'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  const incompatibleUnderwearRequirement = ['outfit', 'top', 'bottom', 'shoes', 'swimwear', 'miniskirt'].some((category) => byCategory(category).length)
    || byCategory('hosiery').some((item) => item.candidates.some((candidate) => candidate.id !== 'H00'))
    || byCategory('outerwear').some((item) => item.candidates.some((candidate) => candidate.id !== 'O00'));
  if (hasUnderwear && incompatibleUnderwearRequirement) throw Object.assign(new Error('Underwear cannot be combined with regular outfits, shoes, hosiery, outerwear or swimwear'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  if (hasMiniskirt && ['outfit', 'bottom'].some((category) => byCategory(category).length)) throw Object.assign(new Error('A miniskirt cannot be combined with another outfit or bottom'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  let swimwearPool = library.clothing.swimwear;
  for (const requirement of swimwearRequirements) swimwearPool = swimwearPool.filter((item) => requirement.candidates.some((candidate) => candidate.id === item.id));
  if (hasSwimwear && !swimwearPool.length) throw Object.assign(new Error('Swimwear requirements do not resolve to one style'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  const swimwear = hasSwimwear ? choose(swimwearPool, random, lockedValue(locks, 'swimwear') ?? lockedValue(locks, 'outfit'), 'swimwear') : null;
  let miniskirtPool = library.clothing.miniskirts;
  for (const requirement of miniskirtRequirements) miniskirtPool = miniskirtPool.filter((item) => requirement.candidates.some((candidate) => candidate.id === item.id));
  if (hasMiniskirt && !miniskirtPool.length) throw Object.assign(new Error('Miniskirt requirements do not resolve to one style'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  const miniskirt = hasMiniskirt ? choose(miniskirtPool, random, lockedValue(locks, 'miniskirt') ?? lockedValue(locks, 'outfit'), 'miniskirt') : null;
  let braPool = library.clothing.bras;
  for (const requirement of braRequirements) braPool = braPool.filter((item) => requirement.candidates.some((candidate) => candidate.id === item.id));
  let pantyPool = library.clothing.panties;
  for (const requirement of pantyRequirements) pantyPool = pantyPool.filter((item) => requirement.candidates.some((candidate) => candidate.id === item.id));
  let underwearSetPool = library.clothing.underwearSets;
  for (const requirement of underwearSetRequirements) underwearSetPool = underwearSetPool.filter((item) => requirement.candidates.some((candidate) => candidate.id === item.id));
  for (const requirement of braRequirements) underwearSetPool = underwearSetPool.filter((item) => requirement.candidates.some((candidate) => candidate.id === item.braId));
  for (const requirement of pantyRequirements) underwearSetPool = underwearSetPool.filter((item) => requirement.candidates.some((candidate) => candidate.id === item.pantiesId));
  if (underwearSetRequirements.length && !underwearSetPool.length) throw Object.assign(new Error('Underwear set requirements do not resolve to one complete set'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  const underwearSet = underwearSetRequirements.length ? choose(underwearSetPool, random, lockedValue(locks, 'underwearSet'), 'underwearSet') : null;
  if (underwearSet) {
    braPool = braPool.filter((item) => item.id === underwearSet.braId);
    pantyPool = pantyPool.filter((item) => item.id === underwearSet.pantiesId);
  }
  const singleRequirementGroup = (items) => {
    const groups = new Set(items.flatMap((item) => item.candidates.map((candidate) => candidate.group).filter(Boolean)));
    return groups.size === 1 ? [...groups][0] : null;
  };
  const braGroup = singleRequirementGroup(braRequirements);
  const pantyGroup = singleRequirementGroup(pantyRequirements);
  const underwearSetGroup = singleRequirementGroup(underwearSetRequirements);
  if (new Set([braGroup, pantyGroup, underwearSetGroup].filter(Boolean)).size > 1) throw Object.assign(new Error('Bra, panties and underwear set requirements must use the same style group'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  const underwearGroup = braGroup ?? pantyGroup ?? underwearSetGroup;
  if (underwearGroup) {
    braPool = braPool.filter((item) => item.group === underwearGroup);
    pantyPool = pantyPool.filter((item) => item.group === underwearGroup);
  }
  if (hasUnderwear && (!braPool.length || !pantyPool.length)) throw Object.assign(new Error('Underwear requirements do not resolve to one complete set'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  const bra = hasUnderwear ? choose(braPool, random, lockedValue(locks, 'bra'), 'bra') : null;
  const panties = hasUnderwear ? choose(pantyPool.filter((item) => !bra?.group || item.group === bra.group), random, lockedValue(locks, 'panties'), 'panties') : null;
  const whiteSockRequirement = byCategory('hosiery').find((item) => item.candidates.some((candidate) => ['H01', 'H04'].includes(candidate.id)));
  const noHosiery = library.clothing.hosiery.find((item) => item.id === 'H00');
  const hosieryPool = hasUnderwear ? [noHosiery] : byCategory('hosiery')[0]?.candidates ?? library.clothing.hosiery;
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
  if (!outfitPool.length && !swimwear && !miniskirt && !hasUnderwear) throw Object.assign(new Error('Clothing requirements cannot be combined into a C outfit'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  const framingPool = hasUnderwear ? section(c.composition, /取景範圍/).filter((item) => UNDERWEAR_FRAME.test(item.text)) : visibleSocks && !swimwear ? section(c.composition, /取景範圍/).filter((item) => SOCK_FRAME.test(item.text)) : section(c.composition, /取景範圍/);
  let outfit;
  if (swimwear) {
    let shoePool = library.clothing.shoes;
    for (const requirement of byCategory('shoes')) shoePool = shoePool.filter((item) => requirement.candidates.some((candidate) => candidate.id === item.id));
    if (!shoePool.length) throw Object.assign(new Error('Swimwear requirements do not resolve to one shoe style'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
    const shoe = choose(shoePool, random, lockedValue(locks, 'shoes'), 'shoes');
    outfit = { ...swimwear, text: `${swimwear.text} + ${shoe.text}`, top: swimwear.text, bottom: '', shoe: shoe.text };
  }
  else if (hasUnderwear) outfit = { id: underwearSet?.id ?? `underwear:${bra.id}:${panties.id}`, text: `${bra.text} + ${panties.text}`, top: bra.text, bottom: panties.text, shoe: '' };
  else if (miniskirt) {
    let topPool = library.clothing.tops;
    for (const requirement of byCategory('top')) topPool = topPool.filter((item) => requirement.candidates.some((candidate) => candidate.id === item.id));
    let shoePool = library.clothing.shoes;
    for (const requirement of byCategory('shoes')) shoePool = shoePool.filter((item) => requirement.candidates.some((candidate) => candidate.id === item.id));
    if (visibleSocks) shoePool = shoePool.filter((item) => SOCK_SHOE.test(item.text));
    if (!topPool.length || !shoePool.length) throw Object.assign(new Error('Miniskirt requirements cannot be combined with the selected top or shoes'), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
    const top = choose(topPool, random, lockedValue(locks, 'top'), 'top');
    const shoe = choose(shoePool, random, lockedValue(locks, 'shoes'), 'shoes');
    outfit = { id: miniskirt.id, text: `${top.text} + ${miniskirt.text} + ${shoe.text}`, top: top.text, bottom: miniskirt.text, shoe: shoe.text };
  } else outfit = choose(outfitPool, random, lockedValue(locks, 'outfit'), 'outfit');
  const photoTypePool = hasUnderwear ? section(c.imageGoal, /照片類型/).filter((item) => UNDERWEAR_PHOTO_TYPE.test(item.text)) : section(c.imageGoal, /照片類型/);
  const photoType = choose(photoTypePool, random, lockedValue(locks, 'photoType'), 'photoType');
  const selectableScenes = Object.entries(c.scene).filter(([key]) => /居家室內|商業室內|城市場景|自然場景|建築_景點/.test(key)).flatMap(([, items]) => items).filter((item) => !hasUnderwear || UNDERWEAR_SCENE.test(item.text));
  const requestedScene = typeof lockedValue(locks, 'scene') === 'object' ? lockedValue(locks, 'scene')?.id : lockedValue(locks, 'scene');
  const lockedSceneOption = selectableScenes.find((item) => item.id === requestedScene || item.text === requestedScene);
  if (lockedSceneOption && !photoTypeSceneCompatible(photoType, lockedSceneOption)) throw Object.assign(new Error('Locked photo type and scene are incompatible'), { code: 'PERSON_PHOTO_LOCK_INVALID' });
  const stylePool = section(c.imageGoal, /風格方向/).filter((item) => photoGoalEntriesCompatible(photoType, item)
    && (lockedSceneOption
      ? photoTypeSceneCompatible(photoType, lockedSceneOption) && styleSceneCompatible(item, lockedSceneOption)
      : selectableScenes.some((sceneOption) => photoTypeSceneCompatible(photoType, sceneOption) && styleSceneCompatible(item, sceneOption))));
  const style = choose(stylePool, random, lockedValue(locks, 'style'), 'style');
  const realism = chooseDistinct(section(c.imageGoal, /真實度/), random, 2, 'realism');
  const framing = choose(framingPool, random, lockedValue(locks, 'framing'), 'framing');
  let focalPool = section(c.lens, /焦段/);
  if (SELFIE.test(photoType.text)) focalPool = focalPool.filter((item) => !LONG_LENS.test(item.text));
  let focalLength = choose(focalPool, random, lockedValue(locks, 'focalLength'), 'focalLength');
  const scenePool = selectableScenes.filter((item) => photoTypeSceneCompatible(photoType, item) && styleSceneCompatible(style, item));
  const scene = choose(scenePool, random, lockedValue(locks, 'scene'), 'scene');
  if (SMALL_INTERIOR.test(scene.text) && /135mm/.test(focalLength.text) && !lockedValue(locks, 'focalLength')) focalLength = choose(focalPool.filter((item) => !/135mm/.test(item.text)), random, null, 'focalLength');
  const ratio = choose([...section(c.composition, /直式比例/), ...section(c.composition, /橫式比例/)], random, lockedValue(locks, 'ratio'), 'ratio');
  const [width, height] = ratioDimensions(ratio.text);
  const identity = {
    age: choose(section(c.identity, /年齡層/).filter(youngAdultWoman), random, lockedValue(locks, 'identity.age'), 'identity.age'),
    appearance: choose(section(c.identity, /外觀地域風格/), random, lockedValue(locks, 'identity.appearance'), 'identity.appearance'),
    atmosphere: choose(section(c.identity, /身份氛圍/), random, lockedValue(locks, 'identity.atmosphere'), 'identity.atmosphere'),
    temperament: choose(section(c.identity, /個人氣質/), random, lockedValue(locks, 'identity.temperament'), 'identity.temperament'),
    count: choose(section(c.identity, /人物數量/).filter((item) => item.text === '單人'), random, lockedValue(locks, 'identity.count'), 'identity.count'),
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
  const goalEntries = [photoType, style];
  const lightSources = [...section(c.lighting, /自然光/).filter((item) => !outdoorScene || !/窗戶|落地窗/.test(item.text)), ...(indoorScene ? section(c.lighting, /室內光/) : []), ...(studioLook ? section(c.lighting, /攝影用光/) : [])]
    .filter((source) => goalEntries.every((entry) => !entry.lightingSourceTerms?.length || entry.lightingSourceTerms.some((term) => source.text.includes(term))));
  const lightDirections = section(c.lighting, /光線方向/).filter((item) => (!outdoorScene || !/窗邊|門口/.test(item.text))
    && goalEntries.every((entry) => !entry.lightingDirectionTerms?.length || entry.lightingDirectionTerms.some((term) => item.text.includes(term))));
  const lighting = { source: choose(lightSources, random, lockedValue(locks, 'lighting.source'), 'lighting.source'), direction: choose(lightDirections, random, lockedValue(locks, 'lighting.direction'), 'lighting.direction'), quality: choose(section(c.lighting, /光質/), random, lockedValue(locks, 'lighting.quality'), 'lighting.quality') };
  const outerwearRequirement = byCategory('outerwear')[0];
  const noOuterwear = library.clothing.outerwear.find((item) => item.id === 'O00');
  const outerwear = choose(hasUnderwear ? [noOuterwear] : outerwearRequirement?.candidates ?? [noOuterwear], random, lockedValue(locks, 'outerwear'), 'outerwear');
  const customClothing = byCategory('custom').map((item) => item.candidates[0]);
  let capturePool = section(c.photographicTexture, /相機類型感/);
  const requestedCaptureKind = captureKind(photoType) ?? captureKind(style);
  if (requestedCaptureKind) capturePool = capturePool.filter((item) => captureKind(item) === requestedCaptureKind);
  const distancePool = section(c.lens, /拍攝距離/).filter((item) => distanceCompatible(framing, focalLength, item));
  const poseGroup = String(lockedValue(locks, 'poseGroup') ?? '').trim();
  if (poseGroup && !['classic', 'sexy', 'sensual'].includes(poseGroup)) throw Object.assign(new Error(`Unknown pose group lock: ${poseGroup}`), { code: 'PERSON_PHOTO_LOCK_INVALID' });
  const posePool = poseOptionsFor(library).filter((item) => !poseGroup || item.group === poseGroup);
  const selections = {
    photoType, style, realism,
    identity, face: selectCategory(c.face, random, locks, 'face'), hair,
    body: selectCategory(c.body, random, locks, 'body'), skin: selectCategory(c.skin, random, locks, 'skin'), outfit, swimwear, miniskirt, bra, panties, underwearSet, hosiery, outerwear, customClothing,
    pose: choose(posePool, random, lockedValue(locks, 'pose'), 'pose'), expression: choose(section(c.expression, /情緒組合|基本表情/), random, lockedValue(locks, 'expression'), 'expression'),
    framing, ratio, cameraAngle, focalLength,
    distance: choose(distancePool, random, lockedValue(locks, 'distance'), 'distance'), scene,
    lighting, captureProfile: choose(capturePool, random, lockedValue(locks, 'captureProfile'), 'captureProfile'),
  };
  const recipe = { id: `person-photo-${recipeSeed}-${batchIndex + 1}`, batchIndex, batchSize, recipeSeed, libraryVersion: library.libraryVersion, sourceHash: library.sourceSha256, brief: '', selections, hardRequirements: requirements.map(({ candidates, ...item }) => {
    const componentKey = { top: 'top', bottom: 'bottom', shoes: 'shoe' }[item.category];
    const selected = item.category === 'hosiery' ? hosiery : item.category === 'outerwear' ? outerwear : item.category === 'swimwear' ? swimwear : item.category === 'miniskirt' ? miniskirt : item.category === 'bra' ? bra : item.category === 'panties' ? panties : item.category === 'underwearSet' ? underwearSet : item.category === 'custom' ? candidates[0] : item.category === 'outfit' ? outfit : candidates.find((candidate) => candidate.text === outfit[componentKey]);
    return { ...item, resolvedOptionIds: candidates.map((candidate) => candidate.id), selectedItem: { id: selected.id, text: selected.text, ...(selected.group ? { group: selected.group } : {}) } };
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
