import { RoutePage } from "../../../components/shell/RoutePage";
import { UpscaleWorkspace } from "../../../components/tools/UpscaleWorkspace";

export default function UpscalePage() {
  return (
    <RoutePage
      eyebrow="Tools / Upscale"
      title="Video Upscale"
      description="選擇 Library 影片或上傳來源，使用 SeedVR2 3B Int8 產生固定 2× 升頻結果。"
    >
      <UpscaleWorkspace />
    </RoutePage>
  );
}
