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
          code="02 / IMAGE TO IMAGE"
          title="tools.img2img.title"
          description="tools.img2img.description"
          href="/app/tools/image-to-image"
          actionLabel="action.openTool"
        />
        <RouteCard
          code="03 / LORA TRAINER"
          title="tools.lora.title"
          description="tools.lora.description"
          href="/app/tools/lora-trainer"
          actionLabel="action.openTool"
        />
      </RouteGrid>
    </RoutePage>
  );
}
