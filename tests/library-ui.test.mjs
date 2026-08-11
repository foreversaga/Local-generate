import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("library picker and preview dialogs preserve keyboard/a11y contracts", async () => {
  const [picker, library, styles, pickerStyles, assetClient, navigation] = await Promise.all([
    readFile(new URL("../app/components/library/AssetPickerButton.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/library/LibraryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/library/LibraryWorkspace.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/library/AssetPickerButton.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/library/asset-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/library/asset-navigation.ts", import.meta.url), "utf8"),
  ]);

  assert.match(picker, /aria-haspopup="dialog" aria-expanded=\{open\}/);
  assert.match(picker, /role="dialog" aria-modal="true"/);
  assert.match(picker, /onClick=\{\(event\) => event\.target === event\.currentTarget && closeDialog\(\)\}/);
  assert.match(picker, /const \[currentPath, setCurrentPath\] = useState<string\[\]>\(\[\]\)/);
  assert.match(picker, /navigation\.folders\.map/);
  assert.match(picker, /aria-current=\{!currentPath\.length \? "page" : undefined\}/);
  assert.match(picker, /aria-live="polite"/);
  assert.match(picker, /const chosen = scopedAssets\.filter/);
  assert.match(picker, /assetSource = "library"/);
  assert.match(picker, /fetchAssetLibrary\(assetSource\)/);
  assert.match(picker, /setFolderRecords\(next\.folders\)/);
  assert.match(picker, /buildAssetNavigation\(scopedAssets, currentPath, scopedFolders, kind\)/);
  assert.match(picker, /訓練素材（專案 input）/);
  assert.match(picker, /multiple && !query\.trim\(\) && navigation\.directAssets\.length > 0/);
  assert.match(picker, /function toggleAllCurrentFolder\(\)/);
  assert.match(picker, /setSelected\(\(current\) =>/);
  assert.match(picker, /aria-pressed=\{allCurrentFolderSelected\}/);
  assert.match(picker, /全選圖片/);
  assert.match(picker, /取消全選圖片/);
  assert.match(picker, /已達選取上限/);
  assert.match(picker, /已全選目前資料夾圖片/);
  assert.match(picker, /className=\{styles\.selectionNotice\} role="status" aria-live="polite"/);
  assert.match(assetClient, /\/api\/lora-training\/assets/);
  assert.match(assetClient, /fetchAssetLibrary\(source:AssetSource="library"\)/);
  assert.match(assetClient, /folders\?:StudioAssetFolder\[\]/);
  assert.match(library, /role="dialog" aria-modal="true"/);
  assert.match(library, /onClick=\{\(event\) => event\.target === event\.currentTarget && closePreview\(\)\}/);
  assert.match(library, /const \[currentPath, setCurrentPath\] = useState<string\[\]>\(\[\]\)/);
  assert.match(library, /navigation\.folders\.map/);
  assert.match(library, /aria-label="Current asset folder"/);
  assert.match(library, /aria-label=\{`Open folder \$\{folder\.path\.join\("\/"\)\}`\}/);
  assert.match(navigation, /export function buildAssetNavigation/);
  assert.match(navigation, /folderRecords/);
  assert.match(styles, /\.copy\{grid-template-columns:44px minmax\(0,1fr\)\}\.checkbox\{width:44px;height:44px\}/);
  assert.match(styles, /\.folderButton\{/);
  assert.match(pickerStyles, /\.bulkButton\{[^}]*min-height:44px/);
  assert.match(pickerStyles, /\.selectionNotice:empty\{display:none\}/);
});
