import { RoutePage } from "../../../components/shell/RoutePage";
import { ImageToImageWorkspace } from "../../../components/tools/ImageToImageWorkspace";

export default function ImageToImagePage() {
  return (
    <RoutePage
      eyebrow="page.img2img.eyebrow"
      title="page.img2img.title"
      description="page.img2img.description"
    >
      <ImageToImageWorkspace />
    </RoutePage>
  );
}
