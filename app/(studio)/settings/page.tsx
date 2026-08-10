import { RoutePage } from "../../components/shell/RoutePage";
import { SettingsWorkspace } from "../../components/settings/SettingsWorkspace";

export default function SettingsPage() {
  return (
    <RoutePage
      eyebrow="Settings"
      title="系統設定"
      description="切換本機或 Vast runtime、查看服務狀態，並儲存 Prompt provider 與模型預設。生成表單仍留在 Create。"
    >
      <SettingsWorkspace />
    </RoutePage>
  );
}
