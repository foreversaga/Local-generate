import { RouteCard, RouteGrid, RoutePage } from "../../components/shell/RoutePage";

export default function ToolsPage() {
  const solH3Enabled = !/^(?:0|false|no|off)$/i.test(String(process.env.SOL_H3_ENABLED || "1"));
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
        <RouteCard
          code="06 / VIDEO CHARACTER"
          titleText="影片人物工作流程"
          descriptionText="原場景換人物，或用 DWPose 動作骨架搭配參考人物生成影片。"
          href="/app/tools/video-character"
          actionLabel="action.openTool"
        />
        {solH3Enabled && <RouteCard
          code="07 / SOL-H3-SPARK"
          titleText="Sol-H3 官方影片＋音訊"
          descriptionText="使用官方兩階段 H3 → LTX pipeline，支援文字、首尾幀與單一參考素材模式。"
          href="/app/create/sol-h3"
          actionLabel="action.openTool"
        />}
      </RouteGrid>
    </RoutePage>
  );
}
