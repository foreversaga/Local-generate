import { MigrationPanel, RoutePage } from "../../components/shell/RoutePage";

export default function LibraryPage() {
  return (
    <RoutePage
      eyebrow="Library"
      title="素材與輸出"
      description="完整 input/output 管理、搜尋、預覽、下載、刪除與批次操作會集中在 Library；Create 只保留精簡 picker。"
    >
      <MigrationPanel title="Library 遷移中">
        既有資源預覽與刪除能力目前仍在 legacy workspace。搬移時會維持原 API 與 asset root/name contract。
      </MigrationPanel>
    </RoutePage>
  );
}
