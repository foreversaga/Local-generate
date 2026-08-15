import { LongCreateForm } from "../../../components/create/LongCreateForm";
import { RoutePage } from "../../../components/shell/RoutePage";

export default function LongCreatePage() {
  return (
    <RoutePage
      eyebrow="page.long.eyebrow"
      title="page.long.title"
      description="page.long.description"
    >
      <LongCreateForm />
    </RoutePage>
  );
}
