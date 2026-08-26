import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPersonPhotoRecipeBrief,
  loadPersonPhotoLibrary,
  personPhotoLibrarySummary,
  randomizePersonPhotoRecipes,
  validatePersonPhotoRecipe,
} from '../server/image-generation/person-photo-randomizer.mjs';

const LIFESTYLE_PHOTO_TYPE_FOR_TEST = /日常生活感|社群生活照|旅行紀錄|室內生活|戶外自然|紀實抓拍|無修圖感|手機隨拍|咖啡廳生活|居家生活|朋友代拍|自拍|通勤途中|雨天街頭|清晨城市散步|書店閱讀|飯店入住|運動生活|散步生活|校園建築生活/;
const LIFESTYLE_STYLE_FOR_TEST = /寫實自然|日常生活流|日系清新|韓系簡約|文青紀實|青春自然|溫柔柔和|明亮陽光|原片直出感|社群網紅生活照感|朋友視角自然隨拍感|觀察式紀實感|安靜低調敘事感|溫暖居家生活感|空間敘事背景清晰感|輕微動態抓拍感|旅途紀錄感|柔和陰天生活感|背景可讀的環境肖像感/;
const SOCIAL_CAPTURE_LABELS = ['前鏡頭近距離自拍', '高角度自拍', '0.5× 超廣角自拍', '全身鏡前穿搭', '遮臉鏡自拍', '鏡前直閃', '朋友隨拍', '咖啡廳抓拍', '行走回頭', '夜間 Photo Dump'];
const SEXY_BED_TEMPLATE_LABEL = '床面近距離背拍';
const SEXY_BED_POSE = '成年女性在鋪有白色床單的臥室床面採主動四點承重姿勢。雙膝至少分開一個肩寬並壓住床面；髖部高於膝蓋，臀部完全抬離腳跟與小腿，臀部不可接觸腳跟或小腿。雙手掌放在肩線前方約一個前臂長的位置，五指張開壓住床面，手腕位於肩膀前方，雙臂伸展並承擔上半身重量。軀幹由髖部向床頭方向明顯前傾，背部接近水平；不得直立跪坐、不得坐在腳跟上、不得把手掌放在臀部兩側。人物背對鏡頭，肩膀、胸腔與骨盆始終朝離鏡頭方向，只輕微轉頭越肩側望，最多露出單側窄幅臉頰。相機從人物正後方 180°、約 0.8 公尺、貼近床面並位於骨盆高度，以手機後置 26mm 等效主鏡頭輕微仰拍；髖部是距離鏡頭最近且視覺上最大的前景，肩膀與頭部向遠處縮小。使用 2:3 直式緊湊構圖，畫面從頭頂至大腿下段，膝蓋可貼近底部邊緣，小腿下段、腳踝與腳掌全部在畫面外，床面與床頭板保持可辨識。只有臉部表情放鬆，身體仍維持主動四點承重。';

function selectionForLock(selections, key) {
  if (key.startsWith('cameraAngle.')) return selections.cameraAngle[key.slice('cameraAngle.'.length)];
  if (key.startsWith('lighting.')) return selections.lighting[key.slice('lighting.'.length)];
  for (const category of ['identity', 'face', 'hair', 'body', 'skin']) {
    if (key.startsWith(`${category}.`)) return selections[category][key.slice(category.length + 1)];
  }
  return selections[key];
}

test('loads the canonical 15-document library with stable clothing IDs', async () => {
  const library = await loadPersonPhotoLibrary();
  const summary = await personPhotoLibrarySummary();
  assert.equal(summary.markdownFileCount, 15);
  assert.equal(summary.outfitCount, 520);
  assert.equal(summary.id, 'person-photo');
  assert.equal(summary.version, summary.libraryVersion);
  assert.equal(summary.sourceHash, summary.sourceSha256);
  assert.equal(summary.clothingOptions.outfit.length, 520);
  assert.equal(summary.clothingOptions.swimwear.length, 100);
  assert.equal(summary.swimwearCount, 100);
  assert.equal(summary.clothingOptions.miniskirt.length, 20);
  assert.equal(summary.clothingOptions.bra.length, 100);
  assert.equal(summary.clothingOptions.panties.length, 100);
  assert.equal(summary.clothingOptions.underwearSet.length, 100);
  assert.equal(summary.miniskirtCount, 20);
  assert.equal(summary.braCount, 100);
  assert.equal(summary.pantyCount, 100);
  assert.equal(summary.underwearSetCount, 100);
  assert.deepEqual(Object.keys(summary.clothingOptions).sort(), ['bottom', 'bra', 'custom', 'hosiery', 'miniskirt', 'outerwear', 'outfit', 'panties', 'shoes', 'swimwear', 'top', 'underwearSet']);
  assert.match(summary.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(library.clothing.outfits[0].id, 'C001');
  assert.equal(library.clothing.outfits.at(-1).id, 'C520');
  assert.deepEqual(library.clothing.swimwear.map(({ id }) => id), Array.from({ length: 100 }, (_, index) => `SW${String(index + 1).padStart(2, '0')}`));
  assert.deepEqual(library.clothing.miniskirts.map(({ id }) => id), Array.from({ length: 20 }, (_, index) => `MS${String(index + 1).padStart(2, '0')}`));
  assert.deepEqual(library.clothing.bras.map(({ id }) => id), Array.from({ length: 100 }, (_, index) => `BR${String(index + 1).padStart(2, '0')}`));
  assert.deepEqual(library.clothing.panties.map(({ id }) => id), Array.from({ length: 100 }, (_, index) => `PT${String(index + 1).padStart(2, '0')}`));
  assert.deepEqual(library.clothing.underwearSets.map(({ id }) => id), Array.from({ length: 100 }, (_, index) => `UW${String(index + 1).padStart(2, '0')}`));
  for (const category of ['swimwear', 'bras', 'panties']) {
    assert.deepEqual(Object.fromEntries(['classic', 'sexy', 'sensual'].map((group) => [group, library.clothing[category].filter((item) => item.group === group).length])), {
      classic: 50, sexy: 25, sensual: 25,
    });
  }
  assert.deepEqual(summary.clothingOptions.swimwear.slice(49, 51).map(({ id, group }) => ({ id, group })), [{ id: 'SW50', group: 'classic' }, { id: 'SW51', group: 'sexy' }]);
  assert.deepEqual(summary.clothingOptions.bra.slice(74, 76).map(({ id, group }) => ({ id, group })), [{ id: 'BR75', group: 'sexy' }, { id: 'BR76', group: 'sensual' }]);
  assert.deepEqual(summary.clothingOptions.underwearSet.slice(74, 76).map(({ id, group }) => ({ id, group })), [{ id: 'UW75', group: 'sexy' }, { id: 'UW76', group: 'sensual' }]);
  assert.equal(summary.poseOptions.length, 168);
  assert.equal(summary.poseOptions.filter((item) => item.group === 'classic').length, 82);
  assert.equal(summary.poseOptions.filter((item) => item.group === 'lifestyle').length, 35);
  assert.equal(summary.poseOptions.filter((item) => item.group === 'sexy').length, 26);
  assert.equal(summary.poseOptions.filter((item) => item.group === 'sensual').length, 25);
  assert.deepEqual(summary.poseOptions.filter((item) => item.id.startsWith('pose.社群手機構圖.')).map((item) => item.label), SOCIAL_CAPTURE_LABELS);
  assert.deepEqual(library.categories.identity.年齡層.map(({ text }) => text), [
    '18–20 歲成年女性', '20–22 歲成年女性', '23–25 歲成年女性',
    '26–29 歲成年女性', '20 歲出頭年輕成年女性', '20 多歲年輕成年女性',
  ]);
  assert.deepEqual(library.categories.identity.人物數量.map(({ text }) => text), ['單人']);
  assert.equal(
    library.categories.face.顴骨_臉頰.find(({ id }) => id === 'face.顴骨_臉頰.007')?.text,
    '臉頰輪廓自然平順，維持均勻中性膚色',
  );
  assert.doesNotMatch(
    library.categories.face.顴骨_臉頰.find(({ id }) => id === 'face.顴骨_臉頰.007')?.text || '',
    /蘋果肌|腮紅|泛紅/,
  );
  assert.doesNotMatch(JSON.stringify(library.categories.imageGoal.真實度), /localized redness/);
  assert.deepEqual(library.categories.face.臉型.slice(-2), [
    { id: 'face.臉型.015', text: '短下巴、輪廓柔和的圓卵形臉' },
    { id: 'face.臉型.016', text: '臉寬適中、下半臉自然收窄的柔和鵝蛋臉' },
  ]);
  assert.deepEqual(library.categories.hair.剪裁_輪廓.slice(-5), [
    { id: 'hair.剪裁_輪廓.026', text: '高位雙馬尾，兩側髮束自然垂落' },
    { id: 'hair.剪裁_輪廓.027', text: '半高雙馬尾，後方長髮自然披下' },
    { id: 'hair.剪裁_輪廓.028', text: '蓬鬆低馬尾，臉側保留柔和修飾髮' },
    { id: 'hair.剪裁_輪廓.029', text: '長直髮搭配臉側階梯層次' },
    { id: 'hair.剪裁_輪廓.030', text: '肩下中長髮，髮尾輕微外翻' },
  ]);
  assert.deepEqual(library.categories.hair.瀏海.slice(-2), [
    { id: 'hair.瀏海.015', text: '輕薄齊瀏海，中央略透出額頭' },
    { id: 'hair.瀏海.016', text: '中間自然分束的薄瀏海' },
  ]);
  assert.equal(library.categories.imageGoal.照片類型.length, 50);
  assert.equal(library.categories.imageGoal.風格方向.length, 40);
  assert.equal(library.categories.imageGoal.真實度.length, 40);
  const sexyBedTemplate = library.categories.pose.性感姿勢.at(-1);
  assert.equal(sexyBedTemplate.id, 'pose.性感姿勢.026');
  assert.equal(sexyBedTemplate.label, SEXY_BED_TEMPLATE_LABEL);
  assert.equal(sexyBedTemplate.text, SEXY_BED_POSE);
  assert.equal(sexyBedTemplate.group, 'sexy');
  assert.equal(sexyBedTemplate.selectOnly, true);
  assert.equal(sexyBedTemplate.capturePreset.strictRearView, true);
  assert.equal(sexyBedTemplate.capturePreset.referencePoseSkill, 'reference-pose-description-v1');
  assert.match(sexyBedTemplate.capturePreset.referencePosePriority, /臀部完全抬離腳跟與小腿/);
  assert.match(sexyBedTemplate.capturePreset.referencePosePriority, /雙手掌位於肩線前方/);
  assert.match(sexyBedTemplate.capturePreset.referencePosePriority, /腳踝與腳掌必須在畫面外/);
  assert.match(sexyBedTemplate.capturePreset.rearViewPriority, /只可看見後腦、背部、後肩、後腰、臀部/);
  assert.ok(sexyBedTemplate.capturePreset?.locks);
  assert.deepEqual(sexyBedTemplate.capturePreset.fixedRealism, ['imageGoal.真實度.013', 'imageGoal.真實度.025']);
  assert.match(library.libraryVersion, /^person-photo-v13-reference-pose-skill-/);
  assert.deepEqual(summary.photoGoals, {
    photoTypeCount: 50,
    styleCount: 40,
    realismCueCount: 40,
    realismCuesPerRecipe: 2,
    compatiblePhotoStylePairCount: 1875,
    compatibleCombinationCount: 1462500,
  });
  assert.deepEqual(summary.hosiery.filter(({ id }) => ['H01', 'H04'].includes(id)).map(({ id }) => id), ['H01', 'H04']);
});

test('photo-reference face and hair options can be locked into a recipe', async () => {
  const locks = {
    'face.臉型': 'face.臉型.015',
    'face.眉型': 'face.眉型.013',
    'face.眼型': 'face.眼型.023',
    'face.鼻型': 'face.鼻型.013',
    'face.嘴唇': 'face.嘴唇.015',
    'face.顴骨_臉頰': 'face.顴骨_臉頰.010',
    'face.下顎_下巴': 'face.下顎_下巴.011',
    'hair.style': 'hair.剪裁_輪廓.026',
    'hair.bangs': 'hair.瀏海.015',
  };
  const { recipes: [recipe] } = await randomizePersonPhotoRecipes({ seed: 'photo-reference-face-hair', locks });
  assert.equal(recipe.selections.face.臉型.id, locks['face.臉型']);
  assert.equal(recipe.selections.face.眉型.id, locks['face.眉型']);
  assert.equal(recipe.selections.face.眼型.id, locks['face.眼型']);
  assert.equal(recipe.selections.face.鼻型.id, locks['face.鼻型']);
  assert.equal(recipe.selections.face.嘴唇.id, locks['face.嘴唇']);
  assert.equal(recipe.selections.face.顴骨_臉頰.id, locks['face.顴骨_臉頰']);
  assert.equal(recipe.selections.face.下顎_下巴.id, locks['face.下顎_下巴']);
  assert.equal(recipe.selections.hair.style.id, locks['hair.style']);
  assert.equal(recipe.selections.hair.bangs.id, locks['hair.bangs']);
  assert.match(recipe.brief, /高位雙馬尾，兩側髮束自然垂落/);
  assert.match(recipe.brief, /面中自然飽滿，臉頰保持均勻中性膚色，無明顯腮紅/);
});

test('single and batch generation use the same deterministic seed stream', async () => {
  const options = { seed: 'repeatable', count: 4 };
  const firstResult = await randomizePersonPhotoRecipes(options);
  const secondResult = await randomizePersonPhotoRecipes(options);
  assert.deepEqual(firstResult, secondResult);
  assert.equal(firstResult.mode, 'batch');
  assert.equal(typeof firstResult.batchSeed, 'number');
  assert.ok(firstResult.batchSeed >= 0 && firstResult.batchSeed <= 2_147_483_647);
  const first = firstResult.recipes;
  const second = secondResult.recipes;
  assert.deepEqual(first, second);
  assert.equal(first.length, 4);
  assert.deepEqual(first.map((recipe) => recipe.batchIndex), [0, 1, 2, 3]);
  assert.ok(first.every((recipe) => recipe.batchSize === 4 && recipe.validation.passed && recipe.recipeSeed <= 2_147_483_647));
  const single = await randomizePersonPhotoRecipes({ seed: 'repeatable', count: 1 });
  assert.equal(single.mode, 'single');
  assert.equal(single.recipes[0].recipeSeed, first[0].recipeSeed);
  assert.equal(single.recipes[0].selections.outfit.id, first[0].selections.outfit.id);
});

test('recipe briefs keep every photographic category in a separate labeled block', async () => {
  const { recipes: [recipe] } = await randomizePersonPhotoRecipes({ seed: 'structured-brief', count: 1 });
  const headings = ['照片目標', '人物', '服裝', '動作與表情', '構圖與鏡位', '場景', '光線', '拍攝質感'];
  assert.deepEqual(recipe.brief.match(/【[^\n]+】/g), headings.map((heading) => `【${heading}】`));
  assert.equal(recipe.brief.split('\n\n').length, headings.length);
  for (const heading of headings) assert.match(recipe.brief, new RegExp(`【${heading}】\\n[^\\n]+`));
  assert.equal(recipe.selections.realism.length, 2);
  assert.equal(new Set(recipe.selections.realism.map(({ id }) => id)).size, 2);
  for (const cue of recipe.selections.realism) assert.match(recipe.brief, new RegExp(cue.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('all expanded photo types resolve to coherent scenes across multiple seeds', async () => {
  const library = await loadPersonPhotoLibrary();
  const expanded = library.categories.imageGoal.照片類型.slice(30);
  assert.equal(expanded.length, 20);
  for (const photoType of expanded) {
    for (let index = 0; index < 5; index += 1) {
      const { recipes: [recipe] } = await randomizePersonPhotoRecipes({ seed: `${photoType.id}:${index}`, locks: { photoType: photoType.id } });
      assert.equal(recipe.selections.photoType.id, photoType.id);
      assert.equal(recipe.validation.passed, true, `${photoType.text}: ${recipe.validation.checks.filter((check) => !check.passed).map((check) => check.id).join(', ')}`);
      assert.equal(recipe.validation.checks.find((check) => check.id === 'photo-type-scene-compatible')?.passed, true);
      assert.equal(recipe.validation.checks.find((check) => check.id === 'style-scene-compatible')?.passed, true);
      assert.equal(recipe.validation.checks.find((check) => check.id === 'goal-lighting-compatible')?.passed, true);
    }
  }
});

test('expanded capture and lighting goals select matching camera profiles and light', async () => {
  const cases = [
    ['imageGoal.照片類型.031', {}, /手機/],
    ['imageGoal.照片類型.032', {}, /手機/],
    ['imageGoal.照片類型.033', {}, /手機/],
    ['imageGoal.照片類型.001', { style: 'imageGoal.風格方向.035' }, /CCD|消費型數位/],
    ['imageGoal.照片類型.001', { style: 'imageGoal.風格方向.036' }, /中片幅/],
  ];
  for (const [photoType, extraLocks, capturePattern] of cases) {
    const { recipes: [recipe] } = await randomizePersonPhotoRecipes({ seed: `${photoType}:${JSON.stringify(extraLocks)}`, locks: { photoType, ...extraLocks } });
    assert.match(recipe.selections.captureProfile.text, capturePattern);
    assert.equal(recipe.validation.checks.find((check) => check.id === 'capture-profile-aligned')?.passed, true);
  }
  for (const [photoType, sourcePattern, directionPattern] of [
    ['imageGoal.照片類型.035', /雨天/, null],
    ['imageGoal.照片類型.036', /清晨/, null],
    ['imageGoal.照片類型.037', /黃昏|日落/, /後方/],
  ]) {
    const { recipes: [recipe] } = await randomizePersonPhotoRecipes({ seed: photoType, locks: { photoType } });
    assert.match(recipe.selections.lighting.source.text, sourcePattern);
    if (directionPattern) assert.match(recipe.selections.lighting.direction.text, directionPattern);
  }
  await assert.rejects(() => randomizePersonPhotoRecipes({ locks: {
    photoType: 'imageGoal.照片類型.031',
    style: 'imageGoal.風格方向.035',
  } }), { code: 'PERSON_PHOTO_LOCK_INVALID' });
});

test('a clothing category without a selected style deterministically chooses a random option from that category', async () => {
  const library = await loadPersonPhotoLibrary();
  const pools = {
    outfit: library.clothing.outfits,
    top: library.clothing.tops,
    bottom: library.clothing.bottoms,
    hosiery: library.clothing.hosiery,
    shoes: library.clothing.shoes,
    outerwear: library.clothing.outerwear,
    swimwear: library.clothing.swimwear,
    miniskirt: library.clothing.miniskirts,
    bra: library.clothing.bras,
    panties: library.clothing.panties,
  };
  for (const [category, pool] of Object.entries(pools)) {
    const input = { seed: `category-only:${category}`, clothingRequirements: [{ category, applyToAll: true }] };
    const first = (await randomizePersonPhotoRecipes(input)).recipes[0];
    const second = (await randomizePersonPhotoRecipes(input)).recipes[0];
    const selected = first.hardRequirements[0].selectedItem;
    assert.ok(pool.some((item) => item.id === selected.id && item.text === selected.text), `${category} must select from its own pool`);
    assert.deepEqual(first, second);
    assert.equal(first.validation.passed, true);
  }
});

test('generic white socks resolve only to H01/H04 and force visible compatible styling', async () => {
  const { recipes } = await randomizePersonPhotoRecipes({
    seed: 2468,
    count: 20,
    clothingRequirements: [{ category: 'hosiery', value: '白襪子', applyToAll: true }],
  });
  for (const recipe of recipes) {
    assert.ok(['H01', 'H04'].includes(recipe.selections.hosiery.id));
    assert.match(recipe.selections.outfit.text, /短褲|短裙|九分褲/);
    assert.match(recipe.selections.outfit.shoe, /低筒|休閒鞋|跑鞋|樂福鞋|瑪麗珍鞋|平底鞋|低跟鞋|厚底/);
    assert.match(recipe.selections.framing.text, /全身|鞋底/);
    assert.equal(recipe.validation.passed, true);
    assert.match(recipe.brief, /白色(?:短襪|中筒襪)/);
    assert.deepEqual(recipe.hardRequirements[0].resolvedOptionIds, ['H01', 'H04']);
  }
});

test('specific hosiery option and locks are retained', async () => {
  const { recipes: [recipe] } = await randomizePersonPhotoRecipes({
    seed: 9,
    locks: { outfit: 'C004', hosiery: 'H04', framing: 'composition.取景範圍.008' },
    clothingRequirements: [{ category: 'hosiery', value: '白色中筒襪', optionId: 'H04', applyToAll: true }],
  });
  assert.equal(recipe.selections.outfit.id, 'C004');
  assert.equal(recipe.selections.hosiery.id, 'H04');
  assert.equal(recipe.validation.passed, true);
  assert.equal(validatePersonPhotoRecipe(recipe).passed, true);
  assert.equal(buildPersonPhotoRecipeBrief(recipe), recipe.brief);
});

test('all 100 selectable swimwear styles produce coherent recipes', async () => {
  const library = await loadPersonPhotoLibrary();
  for (const option of library.clothing.swimwear) {
    const { recipes: [recipe] } = await randomizePersonPhotoRecipes({
      seed: option.id,
      clothingRequirements: [{ category: 'swimwear', value: option.text, optionId: option.id, applyToAll: true }],
    });
    assert.equal(recipe.selections.swimwear.id, option.id);
    assert.equal(recipe.selections.outfit.id, option.id);
    assert.ok(recipe.selections.hosiery.id);
    assert.ok(recipe.selections.outfit.shoe);
    assert.equal(recipe.selections.outerwear.id, 'O00');
    assert.match(recipe.brief, new RegExp(option.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(recipe.brief, new RegExp(recipe.selections.hosiery.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(recipe.brief, new RegExp(recipe.selections.outfit.shoe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(recipe.validation.passed, true);
    assert.equal(recipe.hardRequirements[0].selectedItem.id, option.id);
  }
});

test('swimwear permits any scene, hosiery, shoes and outerwear but rejects upper or lower clothing', async () => {
  const clothingRequirements = [
    { category: 'swimwear', optionId: 'SW01', applyToAll: true },
    { category: 'hosiery', optionId: 'H01', applyToAll: true },
    { category: 'shoes', optionId: 'S11', applyToAll: true },
    { category: 'outerwear', optionId: 'O01', applyToAll: true },
  ];
  const { recipes: [recipe] } = await randomizePersonPhotoRecipes({
    seed: 20260825,
    locks: { photoType: 'imageGoal.照片類型.001', scene: 'scene.商業室內.001' },
    clothingRequirements,
  });
  assert.equal(recipe.selections.scene.id, 'scene.商業室內.001');
  assert.equal(recipe.selections.hosiery.id, 'H01');
  assert.equal(recipe.selections.outfit.shoe, '黑色踝靴');
  assert.equal(recipe.selections.outerwear.id, 'O01');
  assert.equal(recipe.validation.passed, true);
  assert.match(recipe.brief, /咖啡廳/);
  assert.match(recipe.brief, /白色短襪/);
  assert.match(recipe.brief, /黑色踝靴/);
  assert.match(recipe.brief, /淺藍牛仔外套/);
  assert.deepEqual(recipe.hardRequirements.map((item) => item.selectedItem.id), ['SW01', 'H01', 'S11', 'O01']);
  assert.equal(recipe.validation.checks.some((check) => ['swimwear-scene-compatible', 'swimwear-no-hosiery', 'swimwear-no-outerwear'].includes(check.id)), false);

  await assert.rejects(() => randomizePersonPhotoRecipes({ clothingRequirements: [
    { category: 'swimwear', optionId: 'SW01', applyToAll: true },
    { category: 'top', optionId: 'T01', applyToAll: true },
  ] }), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  await assert.rejects(() => randomizePersonPhotoRecipes({ clothingRequirements: [
    { category: 'swimwear', optionId: 'SW01', applyToAll: true },
    { category: 'bottom', optionId: 'B01', applyToAll: true },
  ] }), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  const invalid = structuredClone(recipe);
  invalid.selections.outfit.top = '一般白色上衣';
  const report = validatePersonPhotoRecipe(invalid);
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.id === 'swimwear-no-upper-lower-clothing')?.passed, false);
});

test('all miniskirt styles are selectable and compose a complete outfit', async () => {
  const library = await loadPersonPhotoLibrary();
  for (const option of library.clothing.miniskirts) {
    const { recipes: [recipe] } = await randomizePersonPhotoRecipes({ seed: option.id, clothingRequirements: [{ category: 'miniskirt', optionId: option.id, applyToAll: true }] });
    assert.equal(recipe.selections.miniskirt.id, option.id);
    assert.equal(recipe.selections.outfit.id, option.id);
    assert.equal(recipe.selections.outfit.bottom, option.text);
    assert.ok(recipe.selections.outfit.top);
    assert.ok(recipe.selections.outfit.shoe);
    assert.match(recipe.brief, new RegExp(option.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(recipe.validation.passed, true);
    assert.equal(recipe.hardRequirements[0].selectedItem.id, option.id);
  }
  const { recipes: [whiteSocks] } = await randomizePersonPhotoRecipes({ clothingRequirements: [
    { category: 'miniskirt', optionId: 'MS01', applyToAll: true },
    { category: 'hosiery', optionId: 'H01', applyToAll: true },
  ] });
  assert.match(whiteSocks.selections.outfit.bottom, /迷你裙/);
  assert.match(whiteSocks.selections.outfit.shoe, /低筒|休閒鞋|跑鞋|樂福鞋|瑪麗珍鞋|平底鞋|低跟鞋|厚底/);
  assert.equal(whiteSocks.validation.passed, true);
});

test('all 100 bras and 100 panties are selectable with a complete coherent set', async () => {
  const library = await loadPersonPhotoLibrary();
  for (const [category, options] of [['bra', library.clothing.bras], ['panties', library.clothing.panties]]) {
    for (const option of options) {
      const { recipes: [recipe] } = await randomizePersonPhotoRecipes({ seed: option.id, clothingRequirements: [{ category, optionId: option.id, applyToAll: true }] });
      assert.equal(recipe.selections[category].id, option.id);
      assert.match(recipe.selections.bra.id, /^BR/);
      assert.match(recipe.selections.panties.id, /^PT/);
      assert.equal(recipe.selections.hosiery.id, 'H00');
      assert.equal(recipe.selections.outerwear.id, 'O00');
      assert.match(recipe.selections.scene.text, /臥室|更衣室|攝影棚|白棚|背景棚/);
      assert.match(recipe.selections.framing.text, /大腿以上|膝蓋以上|三分之二身|全身|鞋底|人物帶環境/);
      assert.ok(recipe.brief.includes(recipe.selections.bra.text));
      assert.ok(recipe.brief.includes(recipe.selections.panties.text));
      assert.equal(recipe.validation.passed, true);
      assert.equal(recipe.hardRequirements[0].selectedItem.id, option.id);
    }
  }
});

test('sexy and sensual underwear always resolve to a matching style group', async () => {
  for (const [category, optionId, expectedGroup] of [
    ['bra', 'BR51', 'sexy'],
    ['panties', 'PT76', 'sensual'],
  ]) {
    const { recipes: [recipe] } = await randomizePersonPhotoRecipes({ seed: optionId, clothingRequirements: [{ category, optionId, applyToAll: true }] });
    assert.equal(recipe.selections.bra.group, expectedGroup);
    assert.equal(recipe.selections.panties.group, expectedGroup);
    assert.equal(recipe.hardRequirements[0].selectedItem.group, expectedGroup);
    assert.equal(recipe.validation.checks.find((check) => check.id === 'underwear-style-group-compatible')?.passed, true);
  }
  const { recipes } = await randomizePersonPhotoRecipes({ seed: 'random-underwear-groups', count: 20, clothingRequirements: [{ category: 'bra', applyToAll: true }] });
  assert.ok(recipes.every((recipe) => recipe.selections.bra.group === recipe.selections.panties.group));
  await assert.rejects(() => randomizePersonPhotoRecipes({ clothingRequirements: [
    { category: 'bra', optionId: 'BR51', applyToAll: true },
    { category: 'panties', optionId: 'PT76', applyToAll: true },
  ] }), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
});

test('all 100 underwear sets lock both components and remain traceable', async () => {
  const library = await loadPersonPhotoLibrary();
  for (const option of library.clothing.underwearSets) {
    const { recipes: [recipe] } = await randomizePersonPhotoRecipes({ seed: option.id, clothingRequirements: [{ category: 'underwearSet', optionId: option.id, applyToAll: true }] });
    assert.equal(recipe.selections.underwearSet.id, option.id);
    assert.equal(recipe.selections.bra.id, option.braId);
    assert.equal(recipe.selections.panties.id, option.pantiesId);
    assert.equal(recipe.selections.outfit.id, option.id);
    assert.equal(recipe.hardRequirements[0].selectedItem.id, option.id);
    assert.equal(recipe.validation.checks.find((check) => check.id === 'underwear-set-components-match')?.passed, true);
    assert.equal(recipe.validation.passed, true);
  }
});

test('lifestyle, sexy and sensual pose groups can be randomized or exactly locked', async () => {
  for (const [group, pose] of [
    ['lifestyle', 'pose.生活感姿勢.001'],
    ['sexy', 'pose.性感姿勢.001'],
    ['sensual', 'pose.情慾姿勢.001'],
  ]) {
    const { recipes } = await randomizePersonPhotoRecipes({ seed: group, count: 20, locks: { poseGroup: group } });
    assert.ok(recipes.every((recipe) => recipe.selections.pose.group === group && recipe.validation.passed));
    const { recipes: [exact] } = await randomizePersonPhotoRecipes({ seed: pose, locks: { poseGroup: group, pose } });
    assert.equal(exact.selections.pose.id, pose);
    assert.match(exact.selections.identity.age.text, /成年女性/);
    if (group === 'lifestyle') {
      assert.match(exact.selections.photoType.text, LIFESTYLE_PHOTO_TYPE_FOR_TEST);
      assert.match(exact.selections.style.text, LIFESTYLE_STYLE_FOR_TEST);
    }
  }
  await assert.rejects(() => randomizePersonPhotoRecipes({ locks: { poseGroup: 'unknown' } }), { code: 'PERSON_PHOTO_LOCK_INVALID' });
  await assert.rejects(() => randomizePersonPhotoRecipes({ locks: { poseGroup: 'sexy', pose: 'pose.情慾姿勢.001' } }), { code: 'PERSON_PHOTO_LOCK_INVALID' });
});

test('reference-inspired bed template fixes the capture while varying only clothing, face identity and hair', async () => {
  const library = await loadPersonPhotoLibrary();
  const template = library.categories.pose.性感姿勢.find((item) => item.id === 'pose.性感姿勢.026');
  const { recipes } = await randomizePersonPhotoRecipes({
    seed: 'sexy-bed-template',
    count: 40,
    locks: { poseGroup: 'sexy', pose: template.id },
  });
  const entryIds = (entries) => Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, value.id]));
  const fixedProjection = (recipe) => ({
    photoType: recipe.selections.photoType.id,
    style: recipe.selections.style.id,
    realism: recipe.selections.realism.map((item) => item.id),
    identity: {
      atmosphere: recipe.selections.identity.atmosphere.id,
      temperament: recipe.selections.identity.temperament.id,
      count: recipe.selections.identity.count.id,
    },
    body: entryIds(recipe.selections.body),
    skin: entryIds(recipe.selections.skin),
    pose: recipe.selections.pose.id,
    expression: recipe.selections.expression.id,
    framing: recipe.selections.framing.id,
    ratio: recipe.selections.ratio.id,
    cameraAngle: entryIds(recipe.selections.cameraAngle),
    focalLength: recipe.selections.focalLength.id,
    distance: recipe.selections.distance.id,
    scene: recipe.selections.scene.id,
    lighting: entryIds(recipe.selections.lighting),
    captureProfile: recipe.selections.captureProfile.id,
    dimensions: recipe.dimensions,
  });
  const fixed = fixedProjection(recipes[0]);
  assert.ok(recipes.every((recipe) => recipe.validation.passed && JSON.stringify(fixedProjection(recipe)) === JSON.stringify(fixed)));
  for (const [key, expectedId] of Object.entries(template.capturePreset.locks)) assert.equal(selectionForLock(recipes[0].selections, key)?.id, expectedId, key);
  assert.deepEqual(recipes[0].selections.realism.map((item) => item.id), template.capturePreset.fixedRealism);
  assert.match(recipes[0].selections.identity.age.text, /成年女性/);
  assert.ok(recipes[0].brief.includes(SEXY_BED_POSE));
  assert.match(recipes[0].brief, /^【最高優先鏡位限制】\n/);
  assert.match(recipes[0].brief, /【最高優先參考姿勢限制】\n/);
  assert.match(recipes[0].brief, /不得改成跪坐、坐在腳跟上、直立跪姿/);
  assert.match(recipes[0].brief, /小腿下段、腳踝與腳掌必須在畫面外/);
  assert.match(recipes[0].brief, /最多露出單側窄幅臉頰/);
  assert.match(recipes[0].brief, /所有前側設計完全在鏡頭外/);

  const faceIdentities = new Set(recipes.map((recipe) => JSON.stringify({ age: recipe.selections.identity.age.id, appearance: recipe.selections.identity.appearance.id, face: entryIds(recipe.selections.face) })));
  const hairstyles = new Set(recipes.map((recipe) => JSON.stringify(entryIds(recipe.selections.hair))));
  const clothing = new Set(recipes.map((recipe) => recipe.selections.outfit.id));
  assert.ok(faceIdentities.size > 1);
  assert.ok(hairstyles.size > 1);
  assert.ok(clothing.size > 1);

  const { recipes: [underwear] } = await randomizePersonPhotoRecipes({
    seed: 'sexy-bed-template-underwear',
    locks: { poseGroup: 'sexy', pose: template.id },
    clothingRequirements: [{ category: 'underwearSet', optionId: 'UW76', applyToAll: true }],
  });
  assert.equal(underwear.selections.underwearSet.id, 'UW76');
  assert.equal(underwear.selections.pose.id, template.id);
  assert.equal(underwear.validation.passed, true);
  assert.doesNotMatch(underwear.brief, /harness|罩杯/);

  const { recipes: [frontDetailedUnderwear] } = await randomizePersonPhotoRecipes({
    seed: 'sexy-bed-template-front-detail-clothing',
    locks: { poseGroup: 'sexy', pose: template.id },
    clothingRequirements: [{ category: 'underwearSet', optionId: 'UW55', applyToAll: true }],
  });
  assert.match(frontDetailedUnderwear.selections.underwearSet.text, /紅色前扣深 V 內衣/);
  assert.match(frontDetailedUnderwear.brief, /紅色內衣/);
  assert.doesNotMatch(frontDetailedUnderwear.brief, /紅色前扣深 V 內衣/);
  await assert.rejects(() => randomizePersonPhotoRecipes({ locks: { pose: template.id, focalLength: 'lens.焦段.015' } }), { code: 'PERSON_PHOTO_LOCK_INVALID' });
});

test('social smartphone capture styles lock coherent optics, viewpoint, scene and light', async () => {
  const library = await loadPersonPhotoLibrary();
  const styles = library.categories.pose.生活感姿勢.filter((item) => item.id.startsWith('pose.社群手機構圖.'));
  assert.equal(styles.length, 10);
  assert.deepEqual(styles.map((item) => item.label), SOCIAL_CAPTURE_LABELS);
  assert.ok(styles.every((item) => item.group === 'lifestyle' && item.selectOnly && item.capturePreset?.locks));
  for (const style of styles) {
    const { recipes: [recipe] } = await randomizePersonPhotoRecipes({
      seed: style.id,
      locks: { poseGroup: 'lifestyle', pose: style.id },
      clothingRequirements: [{ category: 'hosiery', applyToAll: true }],
    });
    assert.equal(recipe.selections.pose.id, style.id);
    for (const [key, expectedId] of Object.entries(style.capturePreset.locks)) assert.equal(selectionForLock(recipe.selections, key)?.id, expectedId, `${style.label}: ${key}`);
    assert.equal(recipe.validation.passed, true, style.label);
    assert.match(recipe.selections.captureProfile.text, /手機/);
    assert.match(recipe.brief, new RegExp(recipe.selections.captureProfile.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const { recipes: [ultrawide] } = await randomizePersonPhotoRecipes({ seed: '0.5x', locks: { pose: 'pose.社群手機構圖.003' } });
  assert.equal(ultrawide.selections.focalLength.text, '18mm 超廣角');
  assert.equal(ultrawide.selections.distance.text, '0.8 公尺近距離');
  assert.equal(ultrawide.validation.checks.find((check) => check.id === 'framing-focal-distance-compatible')?.passed, true);
  const { recipes: randomLifestyle } = await randomizePersonPhotoRecipes({ seed: 'lifestyle-without-compound-styles', count: 100, locks: { poseGroup: 'lifestyle' } });
  assert.ok(randomLifestyle.every((recipe) => !recipe.selections.pose.selectOnly));
  const { recipes: [friendSnapshot] } = await randomizePersonPhotoRecipes({
    seed: 'friend-snapshot-ui-default',
    locks: { poseGroup: 'lifestyle', pose: 'pose.社群手機構圖.007' },
    clothingRequirements: [{ category: 'hosiery', applyToAll: true }],
  });
  assert.equal(friendSnapshot.selections.hosiery.id, 'H00');
  assert.equal(friendSnapshot.selections.framing.id, 'composition.取景範圍.007');
  assert.equal(friendSnapshot.validation.passed, true);
  await assert.rejects(() => randomizePersonPhotoRecipes({ locks: { pose: 'pose.社群手機構圖.001', focalLength: 'lens.焦段.015' } }), { code: 'PERSON_PHOTO_LOCK_INVALID' });
});

test('underwear rejects conflicting clothing and invalid external recipes', async () => {
  await assert.rejects(() => randomizePersonPhotoRecipes({ clothingRequirements: [
    { category: 'bra', optionId: 'BR01', applyToAll: true },
    { category: 'hosiery', optionId: 'H01', applyToAll: true },
  ] }), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  await assert.rejects(() => randomizePersonPhotoRecipes({ clothingRequirements: [
    { category: 'panties', optionId: 'PT01', applyToAll: true },
    { category: 'swimwear', optionId: 'SW01', applyToAll: true },
  ] }), { code: 'PERSON_PHOTO_REQUIREMENT_CONFLICT' });
  const { recipes: [recipe] } = await randomizePersonPhotoRecipes({ clothingRequirements: [{ category: 'bra', optionId: 'BR01', applyToAll: true }] });
  const publicScene = structuredClone(recipe);
  publicScene.selections.scene = { id: 'scene.城市場景.external', text: '市中心街道' };
  assert.equal(validatePersonPhotoRecipe(publicScene).checks.find((check) => check.id === 'underwear-scene-compatible')?.passed, false);
  const missingBottom = structuredClone(recipe);
  missingBottom.selections.panties = null;
  assert.equal(validatePersonPhotoRecipe(missingBottom).checks.find((check) => check.id === 'underwear-complete-set')?.passed, false);
});

test('rejects invalid count and incompatible locked white-sock outfit', async () => {
  await assert.rejects(() => randomizePersonPhotoRecipes({ count: 1001 }), { code: 'PERSON_PHOTO_COUNT_INVALID' });
  await assert.rejects(() => randomizePersonPhotoRecipes({
    seed: 1,
    locks: { outfit: 'C002' },
    clothingRequirements: [{ category: 'hosiery', value: '白襪子', applyToAll: true }],
  }), { code: 'PERSON_PHOTO_LOCK_INVALID' });
});

test('library excludes examples and preset implementation notes', async () => {
  const library = await loadPersonPhotoLibrary();
  for (const category of Object.values(library.categories)) {
    assert.ok(Object.keys(category).every((key) => !/範例|常用質感預設|高辨識度組合/.test(key)));
  }
});

test('recipes use one adult subject and semantic primary selections', async () => {
  const { recipes } = await randomizePersonPhotoRecipes({ seed: 'semantic', count: 20, clothingRequirements: [{ category: 'hosiery', optionId: 'H00', applyToAll: true }] });
  for (const recipe of recipes) {
    assert.equal(recipe.selections.identity.count.text, '單人');
    assert.match(recipe.selections.identity.age.text, /^(?:18–20|20–22|23–25|26–29) 歲成年女性$|^20(?: 歲出頭| 多歲)年輕成年女性$/);
    assert.equal(recipe.validation.checks.find((check) => check.id === 'young-adult-woman-only')?.passed, true);
    assert.deepEqual(Object.keys(recipe.selections.hair).sort(), ['bangs', 'color', 'style', 'texture']);
    assert.match(recipe.selections.pose.id, /^pose\.(站姿|坐姿|蹲_跪姿|躺姿|動態姿勢|生活感姿勢|社群手機構圖|性感姿勢|情慾姿勢)\./);
    assert.match(recipe.selections.pose.group, /^(classic|lifestyle|sexy|sensual)$/);
    assert.doesNotMatch(recipe.selections.scene.id, /背景道具/);
    assert.deepEqual(Object.keys(recipe.selections.cameraAngle).sort(), ['height', 'horizontal', 'vertical']);
    assert.deepEqual(Object.keys(recipe.selections.lighting).sort(), ['direction', 'quality', 'source']);
    assert.match(recipe.selections.captureProfile.id, /^photographicTexture\.相機類型感\./);
    assert.deepEqual(Object.keys(recipe.dimensions).sort(), ['aspectRatio', 'height', 'width']);
    assert.ok(recipe.dimensions.width >= 768 && recipe.dimensions.height >= 768);
  }
});

test('rejects older or multi-person identities from external recipes and locks', async () => {
  const { recipes: [base] } = await randomizePersonPhotoRecipes({ seed: 'young-woman-policy' });
  const older = structuredClone(base);
  older.selections.identity.age = { id: 'external.age.older', text: '40–49 歲成年女性' };
  assert.equal(validatePersonPhotoRecipe(older).checks.find((check) => check.id === 'young-adult-woman-only')?.passed, false);
  const group = structuredClone(base);
  group.selections.identity.count = { id: 'external.count.group', text: '雙人' };
  assert.equal(validatePersonPhotoRecipe(group).checks.find((check) => check.id === 'single-person-only')?.passed, false);
  await assert.rejects(() => randomizePersonPhotoRecipes({ locks: { 'identity.age': 'identity.年齡層.007' } }), { code: 'PERSON_PHOTO_LOCK_INVALID' });
});

test('all clothing requirement categories are exact and traceable', async () => {
  const cases = [
    ['top', 'T01'], ['bottom', 'B01'], ['shoes', 'S01'], ['outfit', 'C004'], ['outerwear', 'O01'],
  ];
  for (const [category, optionId] of cases) {
    const requirements = [{ category, optionId, applyToAll: true }];
    if (category !== 'outfit') requirements.push({ category: 'hosiery', optionId: 'H00', applyToAll: true });
    const { recipes: [recipe] } = await randomizePersonPhotoRecipes({ seed: `${category}-exact`, clothingRequirements: requirements });
    const requirement = recipe.hardRequirements.find((item) => item.category === category);
    assert.equal(requirement.selectedItem.id, optionId);
    assert.ok(recipe.brief.includes(requirement.selectedItem.text));
  }
  const { recipes: [custom] } = await randomizePersonPhotoRecipes({ seed: 'custom', clothingRequirements: [{ category: 'custom', value: '紅色領巾', applyToAll: true }] });
  assert.equal(custom.hardRequirements[0].selectedItem.text, '紅色領巾');
  assert.match(custom.brief, /紅色領巾/);
});

test('seed 7788 white-sock batch has coherent framing, capture, light and optics', async () => {
  const { recipes } = await randomizePersonPhotoRecipes({ seed: 7788, count: 20, clothingRequirements: [{ category: 'hosiery', value: '白襪子', applyToAll: true }] });
  assert.equal(recipes.length, 20);
  for (const recipe of recipes) {
    const s = recipe.selections;
    assert.equal(recipe.validation.passed, true);
    assert.match(s.framing.text, /全身|鞋底/);
    const mm = Number.parseInt(s.focalLength.text.match(/\d+/)?.[0] ?? '0', 10);
    const fullBody = /全身|鞋底|人物帶環境|遠距離環境人像/.test(s.framing.text);
    const mappedMinimum = fullBody ? (mm <= 30 ? 2 : mm <= 58 ? 3 : mm <= 85 ? 4 : 5) : mm >= 105 ? 4 : mm >= 70 ? 2 : 0;
    const minimum = /遠距離/.test(s.framing.text) ? Math.max(4, mappedMinimum) : mappedMinimum;
    assert.ok(distanceMetersForTest(s.distance.text) >= minimum, `${s.framing.text} + ${s.focalLength.text} requires at least ${minimum}m, got ${s.distance.text}`);
    const requested = `${s.photoType.text} ${s.style.text}`;
    if (/手機/.test(requested)) assert.match(s.captureProfile.text, /手機/);
    if (/CCD/.test(requested)) assert.match(s.captureProfile.text, /CCD|消費型數位/);
    if (/底片/.test(requested)) assert.match(s.captureProfile.text, /底片/);
    if (!/scene\.(居家室內|商業室內)\./.test(s.scene.id) && !/棚拍|攝影棚|白棚|背景棚|商業廣告|雜誌|時裝|editorial/i.test(`${requested} ${s.scene.text}`)) assert.doesNotMatch(s.lighting.source.id, /攝影用光|室內光/);
  }
});

function distanceMetersForTest(text) {
  return Number.parseFloat(text.match(/\d+(?:\.\d+)?/)?.[0] ?? '0');
}

test('incompatible locked focal distance is rejected', async () => {
  await assert.rejects(() => randomizePersonPhotoRecipes({ seed: 4, locks: { framing: 'composition.取景範圍.011', focalLength: 'lens.焦段.015', distance: 'lens.拍攝距離.004' } }), { code: 'PERSON_PHOTO_LOCK_INVALID' });
});

test('photo type and scene stay hard-compatible across batches', async () => {
  const { recipes } = await randomizePersonPhotoRecipes({ seed: 'scene-regression', count: 20, clothingRequirements: [{ category: 'hosiery', optionId: 'H00', applyToAll: true }] });
  assert.ok(recipes.every((recipe) => recipe.validation.passed && recipe.validation.checks.find((check) => check.id === 'photo-type-scene-compatible')?.passed));
  const library = await loadPersonPhotoLibrary();
  const parkType = library.categories.imageGoal.照片類型.find((item) => /公園/.test(item.text));
  const indoorScene = library.categories.scene.居家室內[0];
  const [base] = recipes;
  const invalid = structuredClone(base);
  invalid.selections.photoType = parkType;
  invalid.selections.scene = indoorScene;
  const report = validatePersonPhotoRecipe(invalid);
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.id === 'photo-type-scene-compatible')?.passed, false);
  await assert.rejects(() => randomizePersonPhotoRecipes({ seed: 7, locks: { photoType: parkType.id, scene: indoorScene.id } }), { code: 'PERSON_PHOTO_LOCK_INVALID' });
});

test('explicit park photo batches never select indoor or commercial scenes', async () => {
  const library = await loadPersonPhotoLibrary();
  const parkType = library.categories.imageGoal.照片類型.find((item) => /公園/.test(item.text));
  const { recipes } = await randomizePersonPhotoRecipes({ seed: 7788, count: 20, locks: { photoType: parkType.id } });
  for (const recipe of recipes) {
    assert.match(recipe.selections.scene.id, /^scene\.自然場景\./);
    assert.match(recipe.selections.scene.text, /公園|草地|樹蔭步道|花園/);
    assert.equal(recipe.validation.passed, true);
  }
});

test('outdoor scenes exclude window and doorway lighting semantics', async () => {
  const library = await loadPersonPhotoLibrary();
  const outdoorScene = library.categories.scene.自然場景.find((item) => /山區步道/.test(item.text));
  const genericPhotoType = library.categories.imageGoal.照片類型.find((item) => item.text === '真人人像照片');
  const { recipes } = await randomizePersonPhotoRecipes({ seed: 'outdoor-lighting', count: 20, locks: { photoType: genericPhotoType.id, scene: outdoorScene.id } });
  for (const recipe of recipes) {
    assert.doesNotMatch(recipe.selections.lighting.source.text, /窗戶|落地窗/);
    assert.doesNotMatch(recipe.selections.lighting.direction.text, /窗邊|門口/);
    assert.equal(recipe.validation.checks.find((check) => check.id === 'outdoor-lighting-compatible')?.passed, true);
  }
  const invalid = structuredClone(recipes[0]);
  invalid.selections.lighting.source = library.categories.lighting.自然光.find((item) => /窗戶自然光/.test(item.text));
  invalid.selections.lighting.direction = library.categories.lighting.光線方向.find((item) => /窗邊斜射/.test(item.text));
  const report = validatePersonPhotoRecipe(invalid);
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.id === 'outdoor-lighting-compatible')?.passed, false);
  await assert.rejects(() => randomizePersonPhotoRecipes({ seed: 8, locks: { photoType: genericPhotoType.id, scene: outdoorScene.id, 'lighting.direction': invalid.selections.lighting.direction.id } }), { code: 'PERSON_PHOTO_LOCK_INVALID' });
});
