import { RoutePage } from "../../../components/shell/RoutePage";
import { LoraTrainerWorkspace } from "../../../components/tools/lora-trainer/LoraTrainerWorkspace";

export default function LoraTrainerPage() {
  return (
    <RoutePage
      eyebrow="page.lora.eyebrow"
      title="page.lora.title"
      description="page.lora.description"
    >
      <LoraTrainerWorkspace />
    </RoutePage>
  );
}
