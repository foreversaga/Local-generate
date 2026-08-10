import { RouteCard, RouteGrid, RoutePage } from "../../components/shell/RoutePage";

export default function ToolsPage() {
  return (
    <RoutePage
      eyebrow="Tools"
      title="工具"
      description="選擇要使用的本機工具；每個工作台都會在提交前顯示 runtime 與模型 readiness。"
    >
      <RouteGrid>
        <RouteCard
          code="01 / UPSCALE"
          title="Video Upscale"
          description="使用 SeedVR2 3B Int8 將 Library 影片或上傳來源固定升頻 2×。"
          href="/app/tools/upscale"
          actionLabel="Open tool"
        />
        <RouteCard
          code="02 / IMAGE TO IMAGE"
          title="Image to Image / 以圖生圖"
          description="選取圖片、設定提示詞與 checkpoint，建立可追蹤的圖生圖工作。"
          href="/app/tools/image-to-image"
          actionLabel="Open tool"
        />
      </RouteGrid>
    </RoutePage>
  );
}
