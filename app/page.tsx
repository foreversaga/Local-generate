"use client";

import { CreateLanding } from "./components/create/CreateLanding";
import { AppShell } from "./components/shell/AppShell";
import { RoutePage } from "./components/shell/RoutePage";

export default function Home() {
  return (
    <AppShell>
      <RoutePage
        eyebrow="建立"
        title="選擇生成工作流"
        description="單次影片與長影片使用獨立流程；也可以直接從素材庫的素材開始。"
      >
        <CreateLanding />
      </RoutePage>
    </AppShell>
  );
}
