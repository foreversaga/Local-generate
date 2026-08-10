import { MigrationPanel, RoutePage } from "../../../components/shell/RoutePage";

type JobDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function JobDetailPage({ params }: JobDetailPageProps) {
  const { id } = await params;

  return (
    <RoutePage
      eyebrow="Jobs / Detail"
      title={`Job ${id}`}
      description="Job detail 將顯示階段、進度、ETA、輸出，以及 Cancel / Retry / Resume；Create 頁不再嵌入完整 job history。"
    >
      <MigrationPanel title="Job detail 遷移中">
        目前 job polling 與 action 還在 legacy workspace。Phase 3 會用 adapter 保持既有 backend status 與 API payload 不變。
      </MigrationPanel>
    </RoutePage>
  );
}
