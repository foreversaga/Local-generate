import {
  MigrationPanel,
  RouteCard,
  RouteGrid,
  RoutePage,
} from "../../../components/shell/RoutePage";

export default function UpscalePage() {
  return (
    <RoutePage
      eyebrow="Tools / Upscale"
      title="Video Upscale"
      description="影片升頻將從 Create 工作台移到獨立 Tools route，保留目前的 submit、progress、cancel、retry 與輸出回 Library 行為。"
    >
      <RouteGrid>
        <RouteCard
          code="TOOLS / UPSCALE"
          title="Upscale"
          description="目前所在工具。正式遷移後在此選取來源影片與升頻設定。"
          href="/app/tools/upscale"
          actionLabel="目前頁面"
        />
        <RouteCard
          code="TOOLS / I2I"
          title="Image to Image"
          description="完整圖片修改工作流，與影片 Create 分離。"
          href="/app/tools/image-to-image"
          actionLabel="切換工具"
        />
      </RouteGrid>
      <MigrationPanel title="Upscale 遷移中">
        SeedVR2 / ComfyUI API contract 不變；目前完整操作仍可從 legacy workspace 使用。
      </MigrationPanel>
    </RoutePage>
  );
}
