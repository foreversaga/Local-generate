import { SingleCreateProgressiveShell } from "../../../components/create/SingleCreateProgressiveShell";
import { RoutePage } from "../../../components/shell/RoutePage";

export default function SingleCreatePage() {
  return (
    <RoutePage
      eyebrow="page.single.eyebrow"
      title="page.single.title"
      description="page.single.description"
    >
      <SingleCreateProgressiveShell />
    </RoutePage>
  );
}
