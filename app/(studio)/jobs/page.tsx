import { MigrationPanel, RoutePage } from "../../components/shell/RoutePage";

export default function JobsPage() {
  return (
    <RoutePage
      eyebrow="Jobs"
      title="生成工作"
      description="完整歷史、篩選、狀態、取消、重試、詳情與恢復會集中在這裡；Create 不再承擔完整 queue。"
    >
      <MigrationPanel title="Job list 遷移中">
        目前既有工作歷史與 active job 狀態仍由 legacy workspace 顯示。Phase 3 會加入 status adapter 與 Job detail。
      </MigrationPanel>
    </RoutePage>
  );
}
