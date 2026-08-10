import { MigrationPanel, RoutePage } from "../../../components/shell/RoutePage";

export default function LongCreatePage() {
  return (
    <RoutePage
      eyebrow="Create / Long"
      title="Long Video"
      description="長影片會依 Story / Source、Continuity / References、Planner / Timeline、Segment Review、Render Setup 分區，並保留既有 draft hydration。"
    >
      <MigrationPanel title="Long workflow 遷移中">
        目前仍由既有 `/app` 提供完整長影片規劃與生成。正式搬移前會先補 hydration regression test，避免草稿與續作資料在拆頁時遺失。
      </MigrationPanel>
    </RoutePage>
  );
}
