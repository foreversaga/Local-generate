import { MigrationPanel, RoutePage } from "../../../components/shell/RoutePage";

export default function SingleCreatePage() {
  return (
    <RoutePage
      eyebrow="Create / Single"
      title="Single Video"
      description="此 route 將承接單片來源、Prompt、Negative Prompt、Render settings、預覽、validation summary 與唯一 Generate CTA。"
    >
      <MigrationPanel title="Single 表單遷移中">
        Phase 1 已先建立 shared validation contract。下一個實作切片會把 legacy Single 表單接到同一套 validation，再逐區搬進此 route。
      </MigrationPanel>
    </RoutePage>
  );
}
