# MiniMax H3 真實世界影片 Prompt 範例

本文件整理 MiniMax H3 生成真人／寫實影片時，可用來降低「AI 感」的 Prompt 寫法。

重點不是單純堆疊 `photorealistic`、`8K`、`masterpiece`、`cinematic` 等品質詞，而是描述真實攝影機、手機錄影、自然光線與人類動作會出現的細微不完美。

> 這些是實務 Prompt 模板與社群常見寫法，不是 MiniMax H3 的固定「濾鏡名稱」。實際效果仍會受到來源圖片、模型版本、workflow、解析度與生成參數影響。

---

## 1. 建議 Prompt 結構

推薦依照以下順序組合：

```text
[人物 / 場景]
[動作 / 劇情]
[鏡頭運動]
[真實世界攝影特徵]
[人物與材質真實感]
[避免 AI / 商業廣告感]
```

例如：

```text
A young adult woman walks naturally along a seaside promenade while casually talking to her friend.
Her full body remains visible as the camera follows at walking pace.

The footage is captured like a real handheld smartphone video.
Natural available daylight, slightly imperfect framing,
subtle natural camera wobble, limited stabilization,
slight autofocus breathing, natural motion blur,
minor exposure variation, subtle sensor noise,
realistic smartphone compression and ordinary real-world colors.

Natural skin texture, realistic fabric movement and natural hair motion.
Her gestures, walking rhythm and facial expressions feel spontaneous and unstaged.

Not cinematic, not overly polished, no beauty-filter appearance,
no perfect gimbal movement and no commercial advertising aesthetic.
```

---

## 2. 通用 Real-World Realism Block

如果只想固定加一段「降低 AI 感」的共用 Prompt，優先使用以下版本：

```text
Grounded real-world live-action footage,
natural available lighting,
realistic skin and fabric texture,
casual handheld camera with subtle natural wobble,
limited stabilization,
slight autofocus breathing,
natural motion blur,
minor exposure variation,
subtle sensor noise,
realistic camera compression,
imperfect framing,
ordinary real-world colors and contrast,
unstaged natural human behavior,
not cinematic, not overly polished.
```

適合：

- 真人角色影片
- 散步
- 日常聊天
- Vlog
- 街拍
- 海灘
- 咖啡廳
- 公園
- 家庭生活場景

---

## 3. Smartphone / UGC 實拍風格

如果希望影片像一般人拿手機拍攝，而不是電影或廣告，使用這個版本。

```text
Casual smartphone video captured by a real person.
Natural available light and imperfect handheld framing.
Subtle natural camera wobble with limited stabilization.
Slight autofocus breathing and occasional focus adjustment.
Natural motion blur, subtle smartphone sensor noise,
realistic phone HDR and mild video compression.
Unscripted and observational.
Not cinematic and not overly polished.
```

### 特點

- 手持微晃
- 防手震不是完全平滑
- 自動對焦偶爾調整
- 手機感光元件噪點
- 手機 HDR
- 輕微壓縮感
- 構圖沒有過度完美

這通常是「最不像 AI」的一種方向。

---

## 4. Documentary / 紀錄片實拍風格

適合希望畫面像現場紀錄、街拍或有人剛好拿相機拍到的感覺。

```text
Observational documentary footage,
captured spontaneously in the real world.
Available natural lighting,
slightly imperfect exposure,
subtle handheld camera movement,
minor autofocus corrections,
imperfect framing,
ordinary real-world contrast and colors,
natural motion blur.
Feels candid and unscripted rather than staged.
```

### 適合場景

- 街頭
- 夜市
- 公園
- 海邊
- 旅行
- 人物聊天
- 日常活動
- Vlog

---

## 5. Real Camera / 電影實拍風格

如果希望有電影感，但仍然像真實攝影機拍攝，而不是 AI CGI，可以使用：

```text
Live-action footage photographed on a real camera.
Subtle optical softness,
fine organic film grain,
natural lens rendering,
realistic motion blur,
slightly imperfect exposure,
practical real-world lighting,
physical sets and materials.
```

可額外加入：

```text
authentic optical softness
fine organic film grain
slight gate weave
natural lens breathing
realistic motion blur
practical lighting
```

這一組比較適合「真人電影」而不是「手機隨手拍」。

不要同時塞入過多 Smartphone 與 Film Camera 特徵，避免模型收到互相衝突的攝影描述。

---

## 6. 真實攝影機缺陷

降低 AI 感時，很有效的方法是描述真實攝影設備會出現的小缺陷。

可依需求挑選：

```text
slight autofocus breathing
minor focus hunting
subtle exposure adjustment
limited stabilization
small handheld wobble
slight sensor grain
realistic video compression
natural motion blur
minor framing imperfections
subtle lens softness
minor rolling shutter during fast movement
```

### 為什麼有效

AI 影片容易出現：

- 過度乾淨
- 過度銳利
- 鏡頭完美平滑
- 光線完全一致
- 人物皮膚過度平滑
- 構圖像廣告

真實攝影反而常會發生：

```text
手持微晃
→ 自動對焦重新判斷
→ 曝光小幅調整
→ 快門造成自然 motion blur
→ 感光元件產生細微 noise
→ 編碼後產生輕微 compression
```

這些細節通常比一直增加 `ultra realistic` 更有效。

---

## 7. 真人皮膚與材質

真人影片特別容易因為「塑膠皮膚」產生 AI 感。

推薦：

```text
Natural human skin texture,
subtle pores and fine facial texture,
realistic uneven skin reflectance,
natural hair movement,
realistic fabric texture,
no beauty-filter appearance,
no excessive skin smoothing,
ordinary real-world lighting on the face.
```

### 不建議大量使用

```text
perfect skin
flawless skin
porcelain skin
beautiful glowing skin
studio portrait lighting
cinematic beauty lighting
```

這些詞不是完全不能使用，但同時堆太多容易讓人物變成廣告或 Beauty Filter 質感。

---

## 8. Negative Prompt

如果 workflow 支援獨立 Negative Prompt，可使用：

```text
cinematic color grading,
overly polished commercial look,
perfect studio lighting,
overly smooth gimbal movement,
beauty filter,
excessive skin smoothing,
plastic skin,
waxy skin,
staged acting,
perfect symmetrical composition,
unnaturally clean textures,
CGI appearance,
3D render appearance,
artificial lighting,
excessive HDR,
excessive sharpness,
over-saturated colors,
morphing,
face distortion,
body deformation
```

如果 workflow 沒有 Negative Prompt 欄位，可以在正文最後加入：

```text
Avoid cinematic color grading, studio lighting, beauty-filter skin,
overly smooth camera movement, staged acting, CGI appearance
and an overly polished commercial aesthetic.
```

---

## 9. 完整範例：真人散步聊天

```text
A young adult woman walks naturally with another person along a seaside promenade during daytime.
She casually talks while walking, occasionally looking toward the person beside her and naturally gesturing with her hands.
Her full body remains inside the frame throughout the shot.
Her walking rhythm, body weight transfer, facial expressions and gestures remain physically natural.

The camera operator walks beside her and follows her at normal human walking speed.
Casual handheld smartphone footage with subtle natural camera wobble and limited stabilization.
The framing changes slightly as the camera operator walks.
There is mild autofocus breathing, occasional small exposure correction,
natural motion blur and subtle smartphone sensor noise.

Natural daylight, ordinary real-world contrast and colors.
Natural human skin texture with subtle pores and realistic uneven reflectance.
Hair and clothing react naturally to her movement and the sea breeze.
Realistic fabric folds and material response.

The scene feels spontaneous, observational and unstaged.
Not cinematic, not overly polished, no beauty filter,
no perfect gimbal movement, no artificial commercial lighting,
no CGI or 3D-rendered appearance.
```

Negative Prompt：

```text
cinematic color grading,
overly polished commercial look,
studio beauty lighting,
beauty filter,
plastic skin,
waxy skin,
excessive skin smoothing,
perfect gimbal movement,
staged acting,
perfect symmetrical composition,
CGI appearance,
3D render appearance,
excessive HDR,
excessive sharpness,
over-saturated colors,
unnatural motion,
morphing,
face distortion,
body deformation
```

---

## 10. 完整範例：海灘手機實拍

```text
A real-world candid beach video captured during daytime.
The subject walks casually across the sand while talking and occasionally looking toward the camera.
Movement is relaxed and physically natural.
Foot placement reacts realistically to the uneven sand.
Hair and clothing move naturally in the sea breeze.

Shot on a normal modern smartphone by another person walking nearby.
Subtle handheld wobble, imperfect framing and limited stabilization.
Slight autofocus breathing and minor exposure adjustments occur naturally as the subject moves.
Realistic smartphone HDR, natural motion blur,
subtle sensor noise and mild video compression.

Natural sunlight, realistic shadows and ordinary colors.
Natural human skin texture without beauty-filter smoothing.
Realistic sand, fabric, hair and skin materials.

Unscripted real-life footage.
Not cinematic, not a fashion advertisement and not overly polished.
```

---

## 11. 完整範例：室內日常手機影片

```text
Casual real-life indoor smartphone footage.
A person naturally moves around the room while having a conversation.
Their timing, gestures, eye movements and facial expressions feel spontaneous rather than acted.

The phone camera is handheld by another person.
Subtle hand movement, slight framing corrections,
minor autofocus adjustment when the subject changes distance,
and small automatic exposure changes when moving between brighter and darker areas.
Natural motion blur and mild smartphone video compression.

The room is illuminated primarily by existing practical lights and available window light.
Ordinary real-world white balance and contrast.
Natural skin texture, fabric texture and hair detail.
No beauty-filter appearance and no artificial studio lighting.
```

---

## 12. 常見錯誤：堆疊過多「高品質」詞

不推薦把以下詞全部一起使用：

```text
masterpiece,
best quality,
ultra realistic,
hyper realistic,
8K,
HDR,
extremely detailed,
razor sharp,
cinematic,
perfect lighting,
perfect skin
```

這些詞可能提高視覺上的「精緻程度」，但不一定會提高「真實世界攝影感」。

如果目標是日常真人實拍，過度精緻反而可能造成：

- AI Beauty Filter 感
- 廣告片感
- CGI 感
- 過度銳化
- HDR 過強
- 不自然的皮膚
- 不自然的鏡頭穩定度

建議改為描述具體的物理與攝影現象。

---

## 13. 推薦調整順序

生成結果仍然太像 AI 時，不建議一次加入大量 Prompt。

建議依序測試：

1. 移除 `masterpiece / perfect / hyper realistic / cinematic` 等過度精緻詞。
2. 加入 `natural available lighting`。
3. 加入 `natural motion blur`。
4. 加入 `subtle handheld camera wobble`。
5. 加入 `limited stabilization`。
6. 加入 `slight autofocus breathing`。
7. 加入 `minor exposure variation`。
8. 加入 `subtle sensor noise / realistic compression`。
9. 真人再加入 `natural human skin texture`。
10. 最後才增加 Negative Prompt 排除 beauty filter、CGI、commercial look。

每次只改一到兩個變數，比一次增加大量描述更容易判斷哪一項對當前 workflow 有效。

---

## 14. Local Generate 建議預設模板

如果之後要把這些設定整合成 Local Generate 的 Prompt Preset，可以先以三組為主：

### `realism-smartphone`

```text
Grounded real-world smartphone footage,
natural available lighting,
casual handheld camera,
subtle natural wobble,
limited stabilization,
slight autofocus breathing,
natural motion blur,
minor exposure variation,
subtle sensor noise,
realistic smartphone compression,
imperfect framing,
ordinary real-world colors,
unstaged natural human behavior,
not cinematic and not overly polished.
```

### `realism-documentary`

```text
Observational documentary footage,
captured spontaneously in the real world,
available natural lighting,
slightly imperfect exposure,
subtle handheld movement,
minor autofocus corrections,
imperfect framing,
ordinary real-world contrast and colors,
natural motion blur,
candid and unstaged.
```

### `realism-live-action-film`

```text
Live-action footage photographed on a real camera,
subtle optical softness,
fine organic film grain,
natural lens rendering,
realistic motion blur,
slightly imperfect exposure,
practical real-world lighting,
physical sets and realistic materials.
```

其中真人日常影片建議優先從 `realism-smartphone` 開始，再依結果調整。
