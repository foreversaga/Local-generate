import { LongCreateForm } from "../../../components/create/LongCreateForm";
import { RoutePage } from "../../../components/shell/RoutePage";

export default function LongCreatePage() {
  return (
    <RoutePage
      eyebrow="建立 / 長影片"
      title="長影片"
      description="故事、連貫性、規劃、時間軸、片段檢視與輸出設定全部常駐；沿用既有序列草稿與服務介面。"
    >
      <LongCreateForm />
    </RoutePage>
  );
}
