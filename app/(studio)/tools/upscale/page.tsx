import { RoutePage } from "../../../components/shell/RoutePage";
import { UpscaleWorkspace } from "../../../components/tools/UpscaleWorkspace";

export default function UpscalePage() {
  return (
    <RoutePage
      eyebrow="page.upscale.eyebrow"
      title="page.upscale.title"
      description="page.upscale.description"
    >
      <UpscaleWorkspace />
    </RoutePage>
  );
}
