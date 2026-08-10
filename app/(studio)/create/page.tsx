import {
  MigrationPanel,
  RouteCard,
  RouteGrid,
  RoutePage,
} from "../../components/shell/RoutePage";

export default function CreatePage() {
  return (
    <RoutePage
      eyebrow="Create"
      title="選擇生成工作流"
      description="Single 與 Long 分成獨立流程。來源、提示詞、設定與 review 會在各自頁面完成，不再靠同一頁 toggle 切換。"
    >
      <RouteGrid>
        <RouteCard
          code="01 / SINGLE"
          title="Single Video"
          description="單次影片生成。下一階段會把來源、Prompt、Render settings 與 sticky summary 搬到這裡。"
          href="/app/create/single"
          actionLabel="進入 Single"
        />
        <RouteCard
          code="02 / LONG"
          title="Long Video"
          description="長影片規劃與分段生成。保留既有 timeline、continuity、draft hydration 與恢復能力。"
          href="/app/create/long"
          actionLabel="進入 Long"
        />
      </RouteGrid>

      <MigrationPanel title="既有工作流仍可使用">
        新 route 會逐步接管既有功能。在 Single / Long 完成 parity 前，原本 `/app` 工作台不會被移除。
      </MigrationPanel>
    </RoutePage>
  );
}
