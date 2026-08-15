import { RoutePage } from "../../components/shell/RoutePage";
import { SettingsWorkspace } from "../../components/settings/SettingsWorkspace";

export default function SettingsPage() {
  return (
    <RoutePage
      eyebrow="page.settings.eyebrow"
      title="page.settings.title"
      description="page.settings.description"
    >
      <SettingsWorkspace />
    </RoutePage>
  );
}
