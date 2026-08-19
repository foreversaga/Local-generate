import { RoutePage } from "../../../components/shell/RoutePage";
import { TextToImageWorkspace } from "../../../components/tools/TextToImageWorkspace";

export default function TextToImagePage() {
  return (
    <RoutePage
      eyebrow="page.text2img.eyebrow"
      title="page.text2img.title"
      description="page.text2img.description"
    >
      <TextToImageWorkspace />
    </RoutePage>
  );
}
