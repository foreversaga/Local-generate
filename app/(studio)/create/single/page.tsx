import { SingleCreateForm } from "../../../components/create/SingleCreateForm";
import { RoutePage } from "../../../components/shell/RoutePage";

export default function SingleCreatePage() {
  return (
    <RoutePage
      eyebrow="Create / Single"
      title="Single Video"
      description="設定來源、Prompt 與生成參數；右側摘要會即時驗證，確認後建立既有 H3 / Wan Animate 工作。"
    >
      <SingleCreateForm />
    </RoutePage>
  );
}
