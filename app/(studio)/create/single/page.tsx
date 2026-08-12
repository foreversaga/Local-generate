import { SingleCreateForm } from "../../../components/create/SingleCreateForm";
import { RoutePage } from "../../../components/shell/RoutePage";

export default function SingleCreatePage() {
  return (
    <RoutePage
      eyebrow="建立 / 單次影片"
      title="單次影片"
      description="設定來源素材、提示詞與生成參數；右側摘要會即時檢查，確認後建立既有 H3 / Wan Animate 工作。"
    >
      <SingleCreateForm />
    </RoutePage>
  );
}
