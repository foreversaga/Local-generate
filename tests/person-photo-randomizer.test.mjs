import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPersonPhotoRecipeBrief,
  loadPersonPhotoLibrary,
  personPhotoLibrarySummary,
  randomizePersonPhotoRecipes,
  validatePersonPhotoRecipe,
} from '../server/image-generation/person-photo-randomizer.mjs';

test('loads the canonical 15-document library with stable clothing IDs', async () => {
  const library = await loadPersonPhotoLibrary();
  const summary = await personPhotoLibrarySummary();
  assert.equal(summary.markdownFileCount, 15);
  assert.equal(summary.outfitCount, 520);
  assert.equal(summary.id, 'person-photo');
  assert.equal(summary.version, summary.libraryVersion);
  assert.equal(summary.sourceHash, summary.sourceSha256);
  assert.equal(summary.clothingOptions.outfit.length, 520);
  assert.equal(summary.clothingOptions.swimwear.length, 50);
  assert.equal(summary.swimwearCount, 50);
  assert.equal(summary.clothingOptions.miniskirt.length, 20);
  assert.equal(summary.clothingOptions.bra.length, 50);
  assert.equal(summary.clothingOptions.panties.length, 50);
  assert.equal(summary.miniskirtCount, 20);
  assert.equal(summary.braCount, 50);
  assert.equal(summary.pantyCount, 50);
  assert.deepEqual(Object.keys(summary.clothingOptions).sort(), ['bottom', 'bra', 'custom', 'hosiery', 'miniskirt', 'outerwear', 'outfit', 'panties', 'shoes', 'swimwear', 'top']);
  assert.match(summary.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(library.clothing.outfits[0].id, 'C001');
  assert.equal(library.clothing.outfits.at(-1).id, 'C520');
  assert.deepEqual(library.clothing.swimwear.map(({ id }) => id), Array.from({ length: 50 }, (_, index) => `SW${String(index + 1).padStart(2, '0')}`));
  assert.deepEqual(library.clothing.miniskirts.map(({ id }) => id), Array.from({ length: 20 }, (_, index) => `MS${String(index + 1).padStart(2, '0')}`));
  assert.deepEqual(library.clothing.bras.map(({ id }) => id), Array.from({ length: 50 }, (_, index) => `BR${String(index + 1).padStart(2, '0')}`));
  assert.deepEqual(library.clothing.panties.map(({ id }) => id), Array.from({ length: 50 }, (_, index) => `PT${String(index + 1).padStart(2, '0')}`));
  assert.deepEqual(library.categories.identity.年齡層.map(({ text }) => text), [
    '18–20 歲成年女性', '20–22 歲成年女性', '23–25 歲成年女性',
    '26–29 歲成年女性', '20 歲出頭年輕成年女性', '20 多歲年輕成年女性',
  ]);
  assert.deepEqual(library.categories.identity.人物數量.map(({ text }) => text), ['單人']);
  assert.equal(library.categories.imageGoal.照片類型.length, 50);
  assert.equal(library.categories.imageGoal.風格方向.length, 40);
  assert.equal(library.categories.imageGoal.真實度.length, 40);
  assert.match(library.libraryVersion, /^person-photo-v5-expanded-goals-/);
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

test('all 50 selectable swimwear styles produce coherent recipes', async () => {
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

test('all 50 bras and 50 panties are selectable with a complete coherent set', async () => {
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
  await assert.rejects(() => randomizePersonPhotoRecipes({ count: 21 }), { code: 'PERSON_PHOTO_COUNT_INVALID' });
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
    assert.match(recipe.selections.pose.id, /^pose\.(站姿|坐姿|蹲_跪姿|躺姿|動態姿勢)\./);
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
