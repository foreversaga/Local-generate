import { MigrationPanel, RoutePage } from "../../components/shell/RoutePage";

export default function SettingsPage() {
  return (
    <RoutePage
      eyebrow="Settings"
      title="系統設定"
      description="Runtime、Prompt provider、模型預設與服務狀態會集中到 Settings；生成表單不再承擔系統設定責任。"
    >
      <MigrationPanel title="Settings 遷移中">
        目前 runtime switch 與 provider/model controls 仍在 legacy workspace。正式搬移時會沿用既有 API，不改 ComfyUI、Ollama、Codex 或 Vast 拓撲。
      </MigrationPanel>
    </RoutePage>
  );
}
