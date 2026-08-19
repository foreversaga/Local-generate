import { RouteCard, RouteGrid, RoutePage } from "../../components/shell/RoutePage";

export default function ToolsPage() {
  return (
    <RoutePage
      eyebrow="page.tools.eyebrow"
      title="page.tools.title"
      description="page.tools.description"
    >
      <RouteGrid>
        <RouteCard
          code="01 / UPSCALE"
          title="tools.upscale.title"
          description="tools.upscale.description"
          href="/app/tools/upscale"
          actionLabel="action.openTool"
        />
        <RouteCard
          code="02 / TEXT TO IMAGE"
          title="tools.text2img.title"
          description="tools.text2img.description"
          href="/app/tools/text-to-image"
          actionLabel="action.openTool"
        />
        <RouteCard
          code="03 / IMAGE TO IMAGE"
          title="tools.img2img.title"
          description="tools.img2img.description"
          href="/app/tools/image-to-image"
          actionLabel="action.openTool"
        />
        <RouteCard
          code="04 / POSE TO IMAGE"
          titleText="OpenPose 骨架生圖"
          descriptionText="上傳人物圖片自動擷取 DWPose 骨架，輸入描述產生提示詞，再用 SDXL + ControlNet 依姿勢生成圖片。"
          href="/app/tools/pose-to-image"
          actionLabel="action.openTool"
        />
        <RouteCard
          code="05 / LORA TRAINER"
          title="tools.lora.title"
          description="tools.lora.description"
          href="/app/tools/lora-trainer"
          actionLabel="action.openTool"
        />
      </RouteGrid>
    </RoutePage>
  );
}
