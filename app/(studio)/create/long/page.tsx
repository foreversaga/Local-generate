import { LongCreateForm } from "../../../components/create/LongCreateForm";
import { RoutePage } from "../../../components/shell/RoutePage";

export default function LongCreatePage() {
  return (
    <RoutePage
      eyebrow="Create / Long"
      title="Long Video"
      description="故事、continuity、planner、timeline、segment review 與 render setup 全部常駐；沿用既有 sequence draft hydration 與 API contract。"
    >
      <LongCreateForm />
    </RoutePage>
  );
}
