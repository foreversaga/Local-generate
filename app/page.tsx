"use client";

import { CreateLanding } from "./components/create/CreateLanding";
import { AppShell } from "./components/shell/AppShell";
import { RoutePage } from "./components/shell/RoutePage";

export default function Home() {
  return (
    <AppShell>
      <RoutePage
        eyebrow="Create"
        title="選擇生成工作流"
        description="Single 與 Long 使用獨立流程；也可以直接從 Library 的 input 素材開始。"
      >
        <CreateLanding />
      </RoutePage>
    </AppShell>
  );
}
