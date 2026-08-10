import {
  MigrationPanel,
  RouteCard,
  RouteGrid,
  RoutePage,
} from "../../../components/shell/RoutePage";

export default function ImageToImagePage() {
  return (
    <RoutePage
      eyebrow="Tools / Image to Image"
      title="Image to Image"
      description="完整 I2I 表單、Prompt、Negative Prompt、模型設定、進度與結果將集中在 Tools，不再出現在 Create 工作流。"
    >
      <RouteGrid>
        <RouteCard
          code="TOOLS / UPSCALE"
          title="Upscale"
          description="影片升頻與輸出管理。"
          href="/app/tools/upscale"
          actionLabel="切換工具"
        />
        <RouteCard
          code="TOOLS / I2I"
          title="Image to Image"
          description="目前所在工具。正式遷移後在此完成完整圖片生成與修改。"
          href="/app/tools/image-to-image"
          actionLabel="目前頁面"
        />
      </RouteGrid>
      <MigrationPanel title="Image to Image 遷移中">
        既有 img2img readiness、prompt generation、polling 與 cancel 行為仍由 legacy workspace 提供，後端 contract 不變。
      </MigrationPanel>
    </RoutePage>
  );
}
