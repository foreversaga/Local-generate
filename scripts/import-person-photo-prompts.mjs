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
const NEUTRAL_CHEEK_TEXT = '臉頰輪廓自然平順，維持均勻中性膚色';

const PHOTO_REFERENCE_FACE_EXTENSIONS = {
  臉型: [
    { id: 'face.臉型.015', text: '短下巴、輪廓柔和的圓卵形臉' },
    { id: 'face.臉型.016', text: '臉寬適中、下半臉自然收窄的柔和鵝蛋臉' },
  ],
  眉型: [
    { id: 'face.眉型.013', text: '眉頭自然、眉尾略帶弧度的柔和平眉' },
  ],
  眼型: [
    { id: 'face.眼型.023', text: '偏圓杏眼，眼尾平緩' },
    { id: 'face.眼型.024', text: '細長杏眼，外眼角柔和' },
  ],
  鼻型: [
    { id: 'face.鼻型.013', text: '鼻樑柔和、鼻頭小巧圓潤' },
  ],
  嘴唇: [
    { id: 'face.嘴唇.015', text: '唇峰柔和、嘴角微微上揚的自然唇形' },
  ],
  顴骨_臉頰: [
    { id: 'face.顴骨_臉頰.010', text: '面中自然飽滿，臉頰保持均勻中性膚色，無明顯腮紅' },
  ],
  下顎_下巴: [
    { id: 'face.下顎_下巴.011', text: '下顎柔和收窄、下巴短而圓潤' },
  ],
};

const PHOTO_REFERENCE_HAIR_EXTENSIONS = {
  剪裁_輪廓: [
    { id: 'hair.剪裁_輪廓.026', text: '高位雙馬尾，兩側髮束自然垂落' },
    { id: 'hair.剪裁_輪廓.027', text: '半高雙馬尾，後方長髮自然披下' },
    { id: 'hair.剪裁_輪廓.028', text: '蓬鬆低馬尾，臉側保留柔和修飾髮' },
    { id: 'hair.剪裁_輪廓.029', text: '長直髮搭配臉側階梯層次' },
    { id: 'hair.剪裁_輪廓.030', text: '肩下中長髮，髮尾輕微外翻' },
  ],
  瀏海: [
    { id: 'hair.瀏海.015', text: '輕薄齊瀏海，中央略透出額頭' },
    { id: 'hair.瀏海.016', text: '中間自然分束的薄瀏海' },
  ],
};

function appendCategoryExtensions(categories, category, extensions) {
  for (const [section, entries] of Object.entries(extensions)) {
    const target = categories[category]?.[section];
    if (!target) throw new Error(`Expected ${category}.${section} prompt category`);
    const existingIds = new Set(target.map(({ id }) => id));
    for (const entry of entries) {
      if (existingIds.has(entry.id)) throw new Error(`Duplicate prompt option ID: ${entry.id}`);
      target.push(entry);
      existingIds.add(entry.id);
    }
  }
}

function extendedGoalEntries(section, start, entries) {
  return entries.map((entry, index) => {
    const value = typeof entry === 'string' ? { text: entry } : entry;
    return { id: `imageGoal.${section}.${String(start + index).padStart(3, '0')}`, ...value };
  });
}

const PHOTO_TYPE_EXTENSIONS = extendedGoalEntries('照片類型', 31, [
  { text: '朋友代拍手機生活照', captureKind: 'phone' },
  { text: '前置鏡頭自拍人像', captureKind: 'phone' },
  { text: '鏡前穿搭自拍照', captureKind: 'phone', sceneGroups: ['居家室內', '商業室內'], sceneTerms: ['更衣鏡前', '更衣室', '飯店房間', '健身房'] },
  { text: '通勤途中抓拍人像', sceneGroups: ['城市場景'], sceneTerms: ['捷運站入口', '火車站月台', '公車站', '天橋', '騎樓'] },
  { text: '雨天街頭人物照', sceneGroups: ['城市場景'], lightingSourceTerms: ['雨天'] },
  { text: '清晨城市散步人像', sceneGroups: ['城市場景'], lightingSourceTerms: ['清晨'] },
  { text: '黃昏逆光環境人像', sceneGroups: ['城市場景', '自然場景', '建築_景點'], lightingSourceTerms: ['黃昏', '日落'], lightingDirectionTerms: ['後方'] },
  { text: '書店閱讀生活人像', sceneGroups: ['商業室內'], sceneTerms: ['書店'] },
  { text: '飯店入住旅行紀錄', sceneGroups: ['商業室內'], sceneTerms: ['飯店大廳', '飯店房間'] },
  { text: '屋頂露台都市人像', sceneGroups: ['建築_景點'], sceneTerms: ['屋頂露台'] },
  { text: '美術館觀展環境人像', sceneGroups: ['建築_景點'], sceneTerms: ['現代美術館'] },
  { text: '健身房運動生活照', sceneGroups: ['商業室內'], sceneTerms: ['健身房'] },
  { text: '瑜伽教室運動生活照', sceneGroups: ['商業室內'], sceneTerms: ['瑜伽教室'] },
  { text: '露營旅行紀錄人像', sceneGroups: ['自然場景'], sceneTerms: ['露營區'] },
  { text: '山林步道人物紀錄', sceneGroups: ['自然場景'], sceneTerms: ['山區步道', '森林小徑', '竹林'] },
  { text: '河岸散步生活人像', sceneGroups: ['自然場景'], sceneTerms: ['河岸步道'] },
  { text: '湖畔自然人物照', sceneGroups: ['自然場景'], sceneTerms: ['湖邊'] },
  { text: '花園漫步人物照', sceneGroups: ['自然場景'], sceneTerms: ['花園'] },
  { text: '校園建築生活人像', sceneGroups: ['建築_景點'], sceneTerms: ['校園建築外'] },
  { text: '老街旅行人物照', sceneGroups: ['建築_景點'], sceneTerms: ['老街'] },
]);

const STYLE_DIRECTION_EXTENSIONS = extendedGoalEntries('風格方向', 21, [
  { text: '朋友視角自然隨拍感', captureKind: 'phone' },
  '觀察式紀實感',
  '安靜低調敘事感',
  { text: '溫暖居家生活感', sceneGroups: ['居家室內'] },
  { text: '雨天低飽和灰調', sceneGroups: ['城市場景', '自然場景', '建築_景點'], lightingSourceTerms: ['雨天'] },
  { text: '黃昏自然逆光感', sceneGroups: ['城市場景', '自然場景', '建築_景點'], lightingSourceTerms: ['黃昏', '日落'], lightingDirectionTerms: ['後方'] },
  '高對比黑白紀實感',
  '低飽和雜誌紀實感',
  '空間敘事背景清晰感',
  '輕微動態抓拍感',
  '旅途紀錄感',
  { text: '戶外機能紀實感', sceneGroups: ['城市場景', '自然場景', '建築_景點'] },
  { text: '度假輕盈感', sceneGroups: ['商業室內', '自然場景', '建築_景點'] },
  { text: '極簡建築敘事感', sceneGroups: ['城市場景', '商業室內', '建築_景點'] },
  { text: '復古數位快照感', captureKind: 'ccd' },
  { text: '中片幅細膩人像感', captureKind: 'medium-format' },
  { text: '柔和陰天生活感', sceneGroups: ['城市場景', '自然場景', '建築_景點'], lightingSourceTerms: ['陰天'] },
  { text: '高對比都市街頭感', sceneGroups: ['城市場景'] },
  '自然電影靜幀感',
  '背景可讀的環境肖像感',
]);

const REALISM_EXTENSIONS = extendedGoalEntries('真實度', 21, [
  'natural left-right facial asymmetry',
  'lifelike eye size, sclera and eyelid thickness',
  'anatomically coherent hands with the correct finger count',
  'anatomically coherent feet with the correct toe count',
  'believable joint bends and limb overlaps',
  'natural body balance and grounded weight',
  'physically plausible grip and prop contact',
  'garment folds and tension consistent with the pose',
  'subtle natural skin-tone variation across the face and body',
  'flyaway hair and naturally varied strand clumping',
  'background details remain spatially recognizable',
  'depth of field consistent with focal length and distance',
  'mirror and reflective directions remain consistent',
  'shadow direction consistent with the main light',
  'slightly imperfect handheld horizon and crop',
  'subtle natural focus falloff around the subject',
  'restrained motion trace during an in-between action',
  'plausible mixed white balance and local color variation',
  'natural highlight rolloff with retained shadow detail',
  'restrained computational sharpening without halos',
]);

const SEXY_POSES = [
  '重心落在單腿的自然 S 型站姿，一手扶腰', '身體半轉並回眸，骨盆與肩線自然錯開', '靠牆站立並彎起一側膝蓋，背部有支撐', '坐在高腳椅邊緣，雙腿前後錯開', '坐在床沿，一側膝蓋抬高並保持腳掌著地',
  '挺直跪姿，肩膀放鬆並微微後展', '側坐並以身後單手支撐上身', '雙手輕攏頭髮，身體重心穩定', '單手調整肩帶，另一手自然垂放', '單手輕拉衣襬，身體微微側轉',
  '背靠牆面並從肩後回望鏡頭', '緩慢行走中回頭，前後腳步自然', '交叉腳踝倚在門框旁，一手扶門框', '坐在地面，一腿彎曲一腿自然延伸', '斜躺沙發並以手肘支撐上身',
  '雙手扶腰轉動上身，骨盆保持正向', '單臂向上伸展，重心落在另一側腿', '指尖輕觸鎖骨，另一手放在腰側', '一手輕托下巴，頭部微微側傾', '雙腳自然分開站立，肩線放鬆',
  '低蹲並以前臂支撐在大腿上', '反向坐椅並把前臂放在椅背上', '半跪姿，一腳踩地並保持軀幹直立', '側躺並讓雙膝輕微彎曲，頭部有支撐', '低頭整理側邊髮絲，身體自然前傾',
].map((text, index) => ({ id: `pose.性感姿勢.${String(index + 1).padStart(3, '0')}`, text, group: 'sexy' }));

const SEXY_BED_CAPTURE_TEMPLATE = {
  id: 'pose.性感姿勢.026',
  label: '床面近距離背拍',
  text: '成年女性在鋪有白色床單的臥室床面採主動四點承重姿勢。雙膝至少分開一個肩寬並壓住床面；髖部高於膝蓋，臀部完全抬離腳跟與小腿，臀部不可接觸腳跟或小腿。雙手掌放在肩線前方約一個前臂長的位置，五指張開壓住床面，手腕位於肩膀前方，雙臂伸展並承擔上半身重量。軀幹由髖部向床頭方向明顯前傾，背部接近水平；不得直立跪坐、不得坐在腳跟上、不得把手掌放在臀部兩側。人物背對鏡頭，肩膀、胸腔與骨盆始終朝離鏡頭方向，只輕微轉頭越肩側望，最多露出單側窄幅臉頰。相機從人物正後方 180°、約 0.8 公尺、貼近床面並位於骨盆高度，以手機後置 26mm 等效主鏡頭輕微仰拍；髖部是距離鏡頭最近且視覺上最大的前景，肩膀與頭部向遠處縮小。使用 2:3 直式緊湊構圖，畫面從頭頂至大腿下段，膝蓋可貼近底部邊緣，小腿下段、腳踝與腳掌全部在畫面外，床面與床頭板保持可辨識。只有臉部表情放鬆，身體仍維持主動四點承重。',
  group: 'sexy',
  selectOnly: true,
  capturePreset: {
    strictRearView: true,
    referencePoseSkill: 'reference-pose-description-v1',
    referencePosePriority: '固定參考姿勢不可簡化：雙膝至少分開一個肩寬並承重；髖部高於膝蓋，臀部完全抬離腳跟與小腿且不得接觸；雙手掌位於肩線前方約一個前臂長，手腕在肩膀前方、雙臂伸展並承重；軀幹明顯前傾且背部接近水平。不得改成跪坐、坐在腳跟上、直立跪姿或雙手放在臀部兩側。畫面從頭頂到大腿下段，膝蓋可貼近底部邊緣，小腿下段、腳踝與腳掌必須在畫面外。只有臉部表情可放鬆，身體仍保持主動四點承重。',
    rearViewPriority: '相機必須位於人物正後方 180°。畫面只可看見後腦、背部、後肩、後腰、臀部、服裝背面與雙腿後側；胸口、腹部、內衣前側、內衣前扣與內褲正面必須完全在鏡頭外。不可使用正面、正面三分之四或側前方視角，也不可為展示臉部或服裝正面而旋轉肩膀、胸腔或骨盆。',
    locks: {
      photoType: 'imageGoal.照片類型.003', style: 'imageGoal.風格方向.001', framing: 'composition.取景範圍.005', ratio: 'composition.直式比例.004', focalLength: 'lens.焦段.004', distance: 'lens.拍攝距離.002', hosiery: 'H00',
      'identity.atmosphere': 'identity.身份氛圍.008', 'identity.temperament': 'identity.個人氣質.017', 'identity.count': 'identity.人物數量.001',
      'body.身高感': 'body.身高感.008', 'body.骨架': 'body.骨架.005', 'body.肩頸': 'body.肩頸.002', 'body.上半身': 'body.上半身.002', 'body.腰腹': 'body.腰腹.008', 'body.臀部': 'body.臀部.004', 'body.大腿': 'body.大腿.003', 'body.膝蓋_小腿_腳踝': 'body.膝蓋_小腿_腳踝.008', 'body.手臂_手部': 'body.手臂_手部.008', 'body.整體體型': 'body.整體體型.005', 'body.物理真實感描述': 'body.物理真實感描述.001',
      'skin.膚色': 'skin.膚色.008', 'skin.底色': 'skin.底色.002', 'skin.面部皮膚質地': 'skin.面部皮膚質地.006', 'skin.真實瑕疵': 'skin.真實瑕疵.006', 'skin.身體皮膚': 'skin.身體皮膚.010', 'skin.光澤程度': 'skin.光澤程度.002',
      expression: 'expression.基本表情.020',
      'cameraAngle.vertical': 'cameraAngle.垂直角度.007', 'cameraAngle.height': 'cameraAngle.相機高度.005', 'cameraAngle.horizontal': 'cameraAngle.水平方向.012', scene: 'scene.居家室內.007',
      'lighting.source': 'lighting.室內光.001', 'lighting.direction': 'lighting.光線方向.005', 'lighting.quality': 'lighting.光質.002', captureProfile: 'photographicTexture.相機類型感.001',
    },
    fixedRealism: ['imageGoal.真實度.013', 'imageGoal.真實度.025'],
  },
};

const SENSUAL_POSES = [
  '坐在床沿向後傾，以雙手穩定支撐身體', '側躺形成自然身體曲線，以前臂支撐頭部', '跪坐在腳跟上，肩膀放鬆並微微後展', '一側膝蓋跪在床面，另一腳穩定踩地', '半躺並抬起一側膝蓋，以前臂支撐上身',
  '背部輕靠牆面形成柔和弧線，雙腳保持著地', '背對鏡頭再轉頭回望，一手停在腰線', '坐姿雙膝自然錯開，雙手分別支撐座面', '側面跪姿，一手放在大腿上保持平衡', '俯躺並彎起小腿，以雙肘支撐上身',
  '坐在地面，一腿伸展一腿屈曲並側轉上身', '倚在門框，一手向上扶住門框', '側坐椅面並微微轉動胸肩，背部有椅背支撐', '坐在床沿交叉腳踝並輕微前傾', '緩慢走動中轉身回望，衣料與髮絲自然跟隨',
  '雙手從腰側移向髖部，肩膀保持放鬆', '單手抬起頭髮露出頸肩線條', '靠在梳妝台邊緣，雙手分別支撐桌面與大腿', '肩背靠枕半躺，一側膝蓋自然抬起', '跪姿並將雙手平放在大腿上',
  '雙腿折向同一側側坐，胸肩轉向鏡頭', '單腳踩在低矮踏階上，另一腿穩定承重', '身體轉向側面並以視線越過肩線', '側靠牆面低頭，指尖停在頸側', '坐在長椅邊緣，一手後撐、一手輕放膝上',
].map((text, index) => ({ id: `pose.情慾姿勢.${String(index + 1).padStart(3, '0')}`, text, group: 'sensual' }));

const LIFESTYLE_POSES = [
  '端著馬克杯走到窗邊，視線自然停在窗外', '坐在沙發邊低頭回覆手機訊息，另一手隨意放在膝上', '站在廚房流理台前準備飲品，身體微微側向鏡頭', '走出咖啡店時順手整理肩背包，腳步沒有刻意停下', '坐在咖啡桌旁翻閱書頁，視線落在內容而非鏡頭',
  '在玄關彎身穿鞋，一手扶牆保持平衡', '走在騎樓下抬手整理被風吹亂的髮絲', '站在便利商店冰櫃前查看飲料標籤，肩膀自然放鬆', '坐在床沿摺疊剛收下的衣物，身體略微前傾', '拉開窗簾讓日光進入房間，頭部順勢轉向窗外',
  '在書架前抽出一本書，手臂與視線跟著書本移動', '等候過馬路時低頭確認手機，雙腳自然前後錯開', '沿著河岸慢走並回頭聽身旁朋友說話', '坐在公園長椅上整理外套袖口，雙膝自然錯開', '在超市推著購物車查看架上商品，身體處於移動途中',
  '站在全身鏡前調整上衣下襬，視線停在鏡中穿搭', '坐在窗邊地毯上替盆栽整理葉片，一腿自然屈起', '從餐桌拿起剛沖好的飲品，另一手仍扶著椅背', '走上樓梯途中短暫回頭，重心穩定落在前腳', '在陽台晾衣時抬手掛上衣物，姿勢自然延伸',
  '坐在車站候車座椅上整理隨身袋內物品', '在雨後街邊收起雨傘，低頭確認傘扣', '靠在廚房檯面旁嚐一口食物，表情自然放鬆', '盤腿坐在沙發上聽音樂，手指輕觸耳機', '穿過家門時回頭與屋內的人說話，手仍扶著門把',
].map((text, index) => ({ id: `pose.生活感姿勢.${String(index + 1).padStart(3, '0')}`, text, group: 'lifestyle' }));

function socialCaptureStyle(index, label, text, locks, options = {}) {
  return {
    id: `pose.社群手機構圖.${String(index).padStart(3, '0')}`,
    label,
    text,
    group: 'lifestyle',
    selectOnly: true,
    capturePreset: { locks, ...options },
  };
}

const SOCIAL_CAPTURE_STYLES = [
  socialCaptureStyle(1, '前鏡頭近距離自拍', '成年女性以單手在手臂距離握持手機前鏡頭自拍，視線自然看向螢幕或鏡頭，肩膀與一小段前臂留在畫面邊緣，呈現輕微廣角透視、普通前鏡頭解析感與不完全置中的胸上隨手裁切', {
    photoType: 'imageGoal.照片類型.032', style: 'imageGoal.風格方向.014', framing: 'composition.取景範圍.003', ratio: 'composition.直式比例.001', focalLength: 'lens.焦段.004', distance: 'lens.拍攝距離.001', hosiery: 'H00',
    'cameraAngle.vertical': 'cameraAngle.垂直角度.002', 'cameraAngle.height': 'cameraAngle.相機高度.002', 'cameraAngle.horizontal': 'cameraAngle.水平方向.001', scene: 'scene.居家室內.002',
    'lighting.source': 'lighting.自然光.009', 'lighting.direction': 'lighting.光線方向.008', captureProfile: 'photographicTexture.相機類型感.013',
  }),
  socialCaptureStyle(2, '高角度自拍', '成年女性將手機前鏡頭舉到頭部上方，手臂自然向上伸展並以中度俯拍收進大腿以上範圍，視線看向螢幕，近距離透視使頭部略近、身體向後延伸，保留臥室背景與一處輕微不完整裁切', {
    photoType: 'imageGoal.照片類型.032', style: 'imageGoal.風格方向.020', framing: 'composition.取景範圍.005', ratio: 'composition.直式比例.001', focalLength: 'lens.焦段.003', distance: 'lens.拍攝距離.001', hosiery: 'H00',
    'cameraAngle.vertical': 'cameraAngle.垂直角度.006', 'cameraAngle.height': 'cameraAngle.相機高度.001', 'cameraAngle.horizontal': 'cameraAngle.水平方向.003', scene: 'scene.居家室內.006',
    'lighting.source': 'lighting.自然光.009', 'lighting.direction': 'lighting.光線方向.001', captureProfile: 'photographicTexture.相機類型感.013',
  }),
  socialCaptureStyle(3, '0.5× 超廣角自拍', '成年女性使用手機後置 0.5× 超廣角，以伸直的手臂從頭部斜上方拍攝全身與大量街景，不刻意修正靠近鏡頭的手臂與腿部延伸、邊緣拉伸及略帶不確定感的構圖，保留社群隨手快照的廣角臨場感', {
    photoType: 'imageGoal.照片類型.018', style: 'imageGoal.風格方向.014', framing: 'composition.取景範圍.008', ratio: 'composition.直式比例.001', focalLength: 'lens.焦段.001', distance: 'lens.拍攝距離.002',
    'cameraAngle.vertical': 'cameraAngle.垂直角度.006', 'cameraAngle.height': 'cameraAngle.相機高度.001', 'cameraAngle.horizontal': 'cameraAngle.水平方向.003', scene: 'scene.城市場景.001',
    'lighting.source': 'lighting.自然光.004', 'lighting.direction': 'lighting.光線方向.002', captureProfile: 'photographicTexture.相機類型感.014',
  }, { allowArmLengthFullBody: true }),
  socialCaptureStyle(4, '全身鏡前穿搭', '成年女性站在全身鏡前，以手機後置主鏡頭拍下從頭頂到鞋底的完整穿搭，手機與真實握持手勢清楚出現在鏡中，機身約在胸口高度，房間和鏡框保留可辨識細節，構圖像準備出門前隨手記錄 OOTD', {
    photoType: 'imageGoal.照片類型.033', style: 'imageGoal.風格方向.020', framing: 'composition.取景範圍.009', ratio: 'composition.直式比例.001', focalLength: 'lens.焦段.004', distance: 'lens.拍攝距離.007',
    'cameraAngle.vertical': 'cameraAngle.垂直角度.001', 'cameraAngle.height': 'cameraAngle.相機高度.003', 'cameraAngle.horizontal': 'cameraAngle.水平方向.001', scene: 'scene.居家室內.011',
    'lighting.source': 'lighting.室內光.001', 'lighting.direction': 'lighting.光線方向.006', captureProfile: 'photographicTexture.相機類型感.001',
  }),
  socialCaptureStyle(5, '遮臉鏡自拍', '成年女性在更衣鏡前用手機遮住部分臉部，以後置主鏡頭拍攝大腿以上穿搭，身體稍微偏離中心、肩線自然傾斜，鏡框或環境在一側形成不等留白，保留普通社群穿搭照的隨手感', {
    photoType: 'imageGoal.照片類型.033', style: 'imageGoal.風格方向.014', framing: 'composition.取景範圍.005', ratio: 'composition.直式比例.002', focalLength: 'lens.焦段.004', distance: 'lens.拍攝距離.005', hosiery: 'H00',
    'cameraAngle.vertical': 'cameraAngle.垂直角度.001', 'cameraAngle.height': 'cameraAngle.相機高度.003', 'cameraAngle.horizontal': 'cameraAngle.水平方向.003', scene: 'scene.居家室內.011',
    'lighting.source': 'lighting.室內光.010', 'lighting.direction': 'lighting.光線方向.007', captureProfile: 'photographicTexture.相機類型感.001',
  }),
  socialCaptureStyle(6, '鏡前直閃', '成年女性在鏡前以手機後置主鏡頭和直射閃光自拍，手機與握持手清楚可見，閃光在鏡面形成局部亮點，人物局部偏亮、背景較暗並保留室內混合色溫與清楚硬陰影，呈現夜間社群快照而非棚拍打光', {
    photoType: 'imageGoal.照片類型.033', style: 'imageGoal.風格方向.020', framing: 'composition.取景範圍.006', ratio: 'composition.直式比例.001', focalLength: 'lens.焦段.004', distance: 'lens.拍攝距離.005', hosiery: 'H00',
    'cameraAngle.vertical': 'cameraAngle.垂直角度.001', 'cameraAngle.height': 'cameraAngle.相機高度.003', 'cameraAngle.horizontal': 'cameraAngle.水平方向.001', scene: 'scene.居家室內.011',
    'lighting.source': 'lighting.手機閃光.001', 'lighting.direction': 'lighting.光線方向.006', captureProfile: 'photographicTexture.相機類型感.015',
  }),
  socialCaptureStyle(7, '朋友隨拍', '朋友站在幾步外以手機後置主鏡頭拍攝成年女性的三分之二身生活照，人物沒有完全置中，正在整理衣服或笑到一半而非正式擺拍，街道背景保持可讀，只保留一點手持傾斜與普通手機銳化', {
    photoType: 'imageGoal.照片類型.031', style: 'imageGoal.風格方向.021', framing: 'composition.取景範圍.007', ratio: 'composition.直式比例.002', focalLength: 'lens.焦段.004', distance: 'lens.拍攝距離.008', hosiery: 'H00',
    'cameraAngle.vertical': 'cameraAngle.垂直角度.001', 'cameraAngle.height': 'cameraAngle.相機高度.003', 'cameraAngle.horizontal': 'cameraAngle.水平方向.005', scene: 'scene.城市場景.001',
    'lighting.source': 'lighting.自然光.004', 'lighting.direction': 'lighting.光線方向.001', captureProfile: 'photographicTexture.相機類型感.001',
  }),
  socialCaptureStyle(8, '咖啡廳抓拍', '朋友坐在咖啡桌對面以手機後置主鏡頭拍攝成年女性的腰上生活照，桌面、杯子或餐點形成近距離前景，人物正拿起飲料、看向窗外或低頭閱讀而沒有對鏡頭擺拍，室內暖光與窗光自然混合', {
    photoType: 'imageGoal.照片類型.027', style: 'imageGoal.風格方向.021', framing: 'composition.取景範圍.004', ratio: 'composition.直式比例.002', focalLength: 'lens.焦段.004', distance: 'lens.拍攝距離.005', hosiery: 'H00',
    'cameraAngle.vertical': 'cameraAngle.垂直角度.001', 'cameraAngle.height': 'cameraAngle.相機高度.003', 'cameraAngle.horizontal': 'cameraAngle.水平方向.005', scene: 'scene.商業室內.001',
    'lighting.source': 'lighting.室內光.008', 'lighting.direction': 'lighting.光線方向.002', captureProfile: 'photographicTexture.相機類型感.001',
  }),
  socialCaptureStyle(9, '行走回頭', '朋友在後方以手機後置主鏡頭拍攝成年女性沿人行道行走後自然回頭的全身瞬間，重心仍在跨步途中，衣料與髮絲留有克制的動態痕跡，人物稍微偏離中心並保留可辨識街景', {
    photoType: 'imageGoal.照片類型.031', style: 'imageGoal.風格方向.030', framing: 'composition.取景範圍.008', ratio: 'composition.直式比例.002', focalLength: 'lens.焦段.004', distance: 'lens.拍攝距離.009',
    'cameraAngle.vertical': 'cameraAngle.垂直角度.001', 'cameraAngle.height': 'cameraAngle.相機高度.003', 'cameraAngle.horizontal': 'cameraAngle.水平方向.013', scene: 'scene.城市場景.004',
    'lighting.source': 'lighting.自然光.004', 'lighting.direction': 'lighting.光線方向.002', captureProfile: 'photographicTexture.相機類型感.001',
  }),
  socialCaptureStyle(10, '夜間 Photo Dump', '朋友在霓虹街道以手機後置主鏡頭和直射閃光拍攝成年女性的膝上瞬間，人物被短促閃光照亮、背景環境光明顯較暗，保留混合白平衡、清楚硬陰影、輕微不完整裁切與相簿直出感，像社群 Photo Dump 中的一張生活快照', {
    photoType: 'imageGoal.照片類型.018', style: 'imageGoal.風格方向.014', framing: 'composition.取景範圍.006', ratio: 'composition.直式比例.002', focalLength: 'lens.焦段.004', distance: 'lens.拍攝距離.005', hosiery: 'H00',
    'cameraAngle.vertical': 'cameraAngle.垂直角度.001', 'cameraAngle.height': 'cameraAngle.相機高度.003', 'cameraAngle.horizontal': 'cameraAngle.水平方向.003', scene: 'scene.城市場景.016',
    'lighting.source': 'lighting.手機閃光.002', 'lighting.direction': 'lighting.光線方向.006', captureProfile: 'photographicTexture.相機類型感.015',
  }),
];

const SOCIAL_CAPTURE_PROFILES = [
  { id: 'photographicTexture.相機類型感.013', text: '手機前置鏡頭手臂距離自拍感' },
  { id: 'photographicTexture.相機類型感.014', text: '手機後置 0.5× 超廣角社群自拍感' },
  { id: 'photographicTexture.相機類型感.015', text: '手機後置主鏡頭直閃快照感' },
];

const PHONE_FLASH_LIGHTING = [
  { id: 'lighting.手機閃光.001', text: '鏡面手機直閃與偏暗室內環境光' },
  { id: 'lighting.手機閃光.002', text: '手機直閃與偏暗夜間街道環境光' },
];

function groupedClothingStyles(prefix, groups) {
  let index = 0;
  return groups.flatMap(([group, styles]) => styles.map((text) => ({ id: `${prefix}${String(++index).padStart(2, '0')}`, text, group })));
}

const SWIMWEAR_STYLES = groupedClothingStyles('SW', [
  ['classic', [
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
  ]],
  ['sexy', [
    '黑色繞頸深 V 比基尼', '酒紅色高衩 V 腰比基尼', '白色交叉綁帶比基尼', '黑色金屬環三角比基尼', '寶藍色側腰鏤空連身泳裝',
    '紅色不對稱鏤空連身泳裝', '墨綠色束腰剪裁連身泳裝', '銀色光澤平口比基尼', '黑色網紗拼接連身泳裝', '紫紅色巴西式比基尼',
    '黑色寬帶高腰比基尼', '香檳色緞光三角比基尼', '豹紋高衩比基尼', '蛇紋單肩連身泳裝', '黑色方扣腰帶比基尼',
    '紅色胸前扭結連身泳裝', '奶油色低背高衩泳裝', '深藍色側腰綁帶比基尼', '黑色 U 領高衩連身泳裝', '珊瑚色交叉背比基尼',
    '白色腰側鏤空單肩泳裝', '酒紅色復古束腰泳裝', '黑色幾何帶飾比基尼', '金色微光繞頸比基尼', '深紫色胸前鏤空連身泳裝',
  ]],
  ['sensual', [
    '黑色多帶環扣情趣風比基尼', '酒紅色束身綁帶情趣風泳裝', '紅色頸圈連接繞頸比基尼', '白色蕾絲拼接有內襯比基尼', '黑色 harness 風鏤空連身泳裝',
    '紫色緞帶綁結情趣風比基尼', '深藍色交叉腰帶連身泳裝', '黑色細鏈裝飾比基尼', '玫瑰粉蝴蝶結帶飾泳裝', '黑色皮革紋理環扣比基尼',
    '紅色網紗拼接有內襯泳裝', '黑色側邊綁帶高衩連身泳裝', '香檳色環扣緞光比基尼', '祖母綠束身衣輪廓泳裝', '白色多帶不對稱比基尼',
    '黑色籠狀線條連身泳裝', '酒紅色繃帶風比基尼', '銀色金屬環連接連身泳裝', '黑色緞帶前綁連身泳裝', '寶石紅幾何鏤空泳裝',
    '紫色蕾絲拼接高腰比基尼', '黑色吊帶元素腰帶比基尼', '珍珠白細鏈裝飾連身泳裝', '海軍藍後背束帶泳裝', '黑紅撞色不透明內襯情趣風泳裝',
  ]],
]);

const MINISKIRT_STYLES = [
  '黑色百褶迷你裙', '灰色百褶迷你裙', '白色 A 字迷你裙', '牛仔藍 A 字迷你裙', '黑色高腰包臀迷你裙',
  '深灰直筒迷你裙', '卡其工裝迷你裙', '橄欖綠工裝迷你裙', '黑色皮革迷你裙', '棕色麂皮迷你裙',
  '紅黑格紋迷你裙', '灰白格紋迷你裙', '白色蕾絲迷你裙', '奶油色針織迷你裙', '黑色針織迷你裙',
  '深藍運動迷你裙', '白色網球迷你裙', '粉色傘擺迷你裙', '酒紅色燈芯絨迷你裙', '銀灰色亮面迷你裙',
].map((text, index) => ({ id: `MS${String(index + 1).padStart(2, '0')}`, text }));

const BRA_STYLES = groupedClothingStyles('BR', [
  ['classic', [
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
  ]],
  ['sexy', [
    '黑色蕾絲深 V 聚攏內衣', '酒紅色法式陽台內衣', '白色扇貝蕾絲半罩杯內衣', '墨綠色長版蕾絲內衣', '紅色前扣深 V 內衣',
    '黑色網紗拼接有內襯內衣', '香檳色緞面低脊心內衣', '深藍色刺繡薄杯內衣', '黑色交叉胸帶內衣', '玫瑰粉長版陽台內衣',
    '紫色繞頸蕾絲內衣', '黑色金屬環細肩帶內衣', '奶油色低背 U 型內衣', '酒紅色側翼蕾絲內衣', '銀灰色光澤半罩杯內衣',
    '黑色不對稱單肩蕾絲內衣', '白色胸前扭結內衣', '寶藍色低脊心刺繡內衣', '黑色寬版下圍深 V 內衣', '珊瑚色細帶三角內衣',
    '紅色緞面陽台內衣', '黑色蕾絲長版 bralette', '墨綠色交叉背薄杯內衣', '香檳金刺繡聚攏內衣', '深紫色側邊鏤空有內襯內衣',
  ]],
  ['sensual', [
    '黑色多帶環扣情趣風內衣', '酒紅色束身綁帶長版內衣', '紅色頸圈連接繞頸內衣', '白色蕾絲籠狀線條內衣', '黑色 harness 風罩杯內衣',
    '紫色緞帶前綁情趣風內衣', '深藍色交叉束帶內衣', '黑色細鏈裝飾有內襯內衣', '玫瑰粉蝴蝶結帶飾內衣', '黑色皮革紋理環扣內衣',
    '紅色網紗拼接完整罩杯內衣', '黑色側翼綁帶陽台內衣', '香檳色金屬環緞光內衣', '祖母綠束腰輪廓長版內衣', '白色多帶不對稱內衣',
    '黑色 cage 風線條內衣', '酒紅色繃帶風罩杯內衣', '銀色金屬環連接內衣', '黑色緞帶束身式內衣', '寶石紅幾何鏤空有內襯內衣',
    '紫色蕾絲頸帶連接內衣', '黑色吊帶元素下圍內衣', '珍珠白細鏈裝飾內衣', '海軍藍後背束帶長版內衣', '黑紅撞色不透明內襯情趣風內衣',
  ]],
  // Reference: https://x.com/jpcccce/status/2092460460788605314
  ['sexy', [
    '象牙白透膚花卉蕾絲低脊心薄杯內衣',
    '淡粉紫扇貝花卉蕾絲四分之三罩杯內衣',
    '粉藍薄襯花卉蕾絲四分之三罩杯內衣',
  ]],
]);

const PANTY_STYLES = groupedClothingStyles('PT', [
  ['classic', [
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
  ]],
  ['sexy', [
    '黑色蕾絲 cheeky 內褲', '酒紅色高衩巴西式內褲', '白色扇貝蕾絲丁字內褲', '墨綠色 V 腰蕾絲內褲', '紅色側邊細帶內褲',
    '黑色網紗拼接有內襯內褲', '香檳色緞面 tanga 內褲', '深藍色刺繡高衩內褲', '黑色交叉腰帶內褲', '玫瑰粉荷葉邊內褲',
    '紫色繫帶巴西式內褲', '黑色金屬環側帶內褲', '奶油色低腰 cheeky 內褲', '酒紅色側腰蕾絲內褲', '銀灰色光澤 V 腰內褲',
    '黑色不對稱細帶內褲', '白色後腰扭結內褲', '寶藍色低腰刺繡內褲', '黑色寬腰帶高衩內褲', '珊瑚色細帶丁字內褲',
    '紅色緞面巴西式內褲', '黑色長版蕾絲高腰內褲', '墨綠色交叉側帶內褲', '香檳金刺繡 tanga 內褲', '深紫色側邊鏤空有內襯內褲',
  ]],
  ['sensual', [
    '黑色多帶環扣情趣風內褲', '酒紅色束帶高腰內褲', '紅色頸帶套裝對應細帶內褲', '白色蕾絲籠狀腰線內褲', '黑色 harness 風腰帶內褲',
    '紫色緞帶側綁情趣風內褲', '深藍色交叉束帶內褲', '黑色細鏈裝飾有內襯內褲', '玫瑰粉蝴蝶結帶飾內褲', '黑色皮革紋理環扣內褲',
    '紅色網紗拼接不透明底襯內褲', '黑色側腰綁帶高衩內褲', '香檳色金屬環緞光內褲', '祖母綠束腰輪廓高腰內褲', '白色多帶不對稱內褲',
    '黑色 cage 風腰線內褲', '酒紅色繃帶風內褲', '銀色金屬環連接內褲', '黑色緞帶束腰式內褲', '寶石紅幾何鏤空有內襯內褲',
    '紫色蕾絲吊帶元素內褲', '黑色吊襪帶元素腰帶內褲', '珍珠白細鏈裝飾內褲', '海軍藍後腰束帶內褲', '黑紅撞色不透明底襯情趣風內褲',
  ]],
  // The three entries keep the front and rear construction paired with BR101–BR103.
  ['sexy', [
    '象牙白透膚花卉蕾絲細側帶丁字內褲',
    '淡粉紫低腰全蕾絲丁字內褲',
    '粉藍低腰細側帶內褲（平滑正面、蕾絲丁字背面）',
  ]],
]);

const UNDERWEAR_SETS = BRA_STYLES.map((bra, index) => {
  const panties = PANTY_STYLES[index];
  return {
    id: `UW${String(index + 1).padStart(2, '0')}`,
    text: `${bra.text} + ${panties.text}`,
    group: bra.group,
    braId: bra.id,
    pantiesId: panties.id,
    bra: bra.text,
    panties: panties.text,
  };
});

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
    swimwear: SWIMWEAR_STYLES, miniskirts: MINISKIRT_STYLES, bras: BRA_STYLES, panties: PANTY_STYLES, underwearSets: UNDERWEAR_SETS,
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
    categories.imageGoal.照片類型.push(...PHOTO_TYPE_EXTENSIONS);
    categories.imageGoal.風格方向.push(...STYLE_DIRECTION_EXTENSIONS);
    categories.imageGoal.真實度.push(...REALISM_EXTENSIONS);
    categories.identity.年齡層 = categories.identity.年齡層.filter((item) => YOUNG_ADULT_WOMAN_AGE.test(item.text));
    categories.identity.人物數量 = categories.identity.人物數量.filter((item) => item.text === '單人');
    const neutralCheek = categories.face.顴骨_臉頰.find((item) => item.id === 'face.顴骨_臉頰.007');
    if (!neutralCheek) throw new Error('Expected cheek face option face.顴骨_臉頰.007');
    neutralCheek.text = NEUTRAL_CHEEK_TEXT;
    appendCategoryExtensions(categories, 'face', PHOTO_REFERENCE_FACE_EXTENSIONS);
    appendCategoryExtensions(categories, 'hair', PHOTO_REFERENCE_HAIR_EXTENSIONS);
    for (const items of Object.values(categories.pose)) for (const item of items) item.group = 'classic';
    categories.pose.生活感姿勢 = [...LIFESTYLE_POSES, ...SOCIAL_CAPTURE_STYLES];
    categories.pose.性感姿勢 = [...SEXY_POSES, SEXY_BED_CAPTURE_TEMPLATE];
    categories.pose.情慾姿勢 = SENSUAL_POSES;
    categories.photographicTexture.相機類型感.push(...SOCIAL_CAPTURE_PROFILES);
    categories.lighting.手機閃光 = PHONE_FLASH_LIGHTING;
    if (categories.imageGoal.照片類型.length !== 50 || categories.imageGoal.風格方向.length !== 40 || categories.imageGoal.真實度.length !== 40) {
      throw new Error(`Expected expanded photo goals 50/40/40, found ${categories.imageGoal.照片類型.length}/${categories.imageGoal.風格方向.length}/${categories.imageGoal.真實度.length}`);
    }
    if (categories.identity.年齡層.length !== 6) throw new Error(`Expected 6 young adult woman age options, found ${categories.identity.年齡層.length}`);
    if (categories.identity.人物數量.length !== 1) throw new Error(`Expected only the single-person identity option, found ${categories.identity.人物數量.length}`);
    if (!clothing || clothing.outfits.length !== 520) throw new Error(`Expected C001-C520, found ${clothing?.outfits.length ?? 0}`);
    if (clothing.outfits[0].id !== 'C001' || clothing.outfits.at(-1).id !== 'C520') throw new Error('Outfit IDs are not contiguous C001-C520');
    if (clothing.swimwear.length !== 100 || clothing.swimwear[0].id !== 'SW01' || clothing.swimwear.at(-1).id !== 'SW100') throw new Error('Expected contiguous swimwear IDs SW01-SW100');
    if (clothing.miniskirts.length !== 20 || clothing.miniskirts[0].id !== 'MS01' || clothing.miniskirts.at(-1).id !== 'MS20') throw new Error('Expected contiguous miniskirt IDs MS01-MS20');
    if (clothing.bras.length !== 103 || clothing.bras[0].id !== 'BR01' || clothing.bras.at(-1).id !== 'BR103') throw new Error('Expected contiguous bra IDs BR01-BR103');
    if (clothing.panties.length !== 103 || clothing.panties[0].id !== 'PT01' || clothing.panties.at(-1).id !== 'PT103') throw new Error('Expected contiguous panty IDs PT01-PT103');
    if (clothing.underwearSets.length !== 103 || clothing.underwearSets[0].id !== 'UW01' || clothing.underwearSets.at(-1).id !== 'UW103') throw new Error('Expected contiguous underwear set IDs UW01-UW103');
    if (categories.pose.生活感姿勢.length !== 35 || categories.pose.性感姿勢.length !== 26 || categories.pose.情慾姿勢.length !== 25) throw new Error('Expected 35 lifestyle, 26 sexy and 25 sensual pose options');
    return { schemaVersion: 1, libraryVersion: `person-photo-v14-reference-pose-skill-${sourceSha256.slice(0, 12)}`, source: basename(absolute), sourceSha256, markdownFileCount: files.length, categories, clothing };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = process.argv[2] ?? resolve(process.cwd(), '../person_photo_prompt_docs.zip');
  const output = process.argv[3] ?? resolve(process.cwd(), 'server/image-generation/person-photo-library.v1.json');
  const library = importPersonPhotoPrompts(source);
  writeFileSync(output, `${JSON.stringify(library, null, 2)}\n`);
  console.log(`Imported ${library.markdownFileCount} Markdown files and ${library.clothing.outfits.length} outfits to ${output}`);
}
