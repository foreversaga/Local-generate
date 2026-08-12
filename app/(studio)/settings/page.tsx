import { RoutePage } from "../../components/shell/RoutePage";
import { SettingsWorkspace } from "../../components/settings/SettingsWorkspace";

export default function SettingsPage() {
  return (
    <RoutePage
      eyebrow="設定"
      title="系統設定"
      description="切換本機或 Vast 執行環境、查看服務狀態，並儲存提示詞提供者與模型預設。生成表單仍留在建立。"
    >
      <SettingsWorkspace />
    </RoutePage>
  );
}
