import { RoutePage } from "../../../components/shell/RoutePage";
import { LoraTrainerWorkspace } from "../../../components/tools/lora-trainer/LoraTrainerWorkspace";

export default function LoraTrainerPage() {
  return (
    <RoutePage
      eyebrow="Tools / LoRA Trainer"
      title="LoRA Trainer"
      description="從圖片資料集建立 SDXL 或 Illustrious LoRA；caption、訓練前檢查、GPU 排程與模型安裝都可在同一個可恢復工作中完成。"
    >
      <LoraTrainerWorkspace />
    </RoutePage>
  );
}
