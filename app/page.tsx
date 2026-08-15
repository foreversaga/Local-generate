"use client";

import { CreateLanding } from "./components/create/CreateLanding";
import { AppShell } from "./components/shell/AppShell";
import { RoutePage } from "./components/shell/RoutePage";

export default function Home() {
  return (
    <AppShell>
      <RoutePage
        eyebrow="page.create.eyebrow"
        title="page.create.title"
        description="page.create.description"
      >
        <CreateLanding />
      </RoutePage>
    </AppShell>
  );
}
