export type SingleRenderMode = "t2v" | "i2v" | "ref2v" | "fl2v" | "l2v" | "replace" | string;

export type NumberDraft = number | "";

export interface SingleRenderAssetRef {
    name: string;
}

export interface SingleRenderValidationInput {
    mode: SingleRenderMode;
    prompt: string;
    promptMaxChars?: number;
    enforcePromptMaxChars?: boolean;
    width: NumberDraft;
    height: NumberDraft;
    steps: NumberDraft;
    seed: NumberDraft;
    renderCount: NumberDraft;
    referenceImage: SingleRenderAssetRef | null;
    referenceImages: SingleRenderAssetRef[];
    lastFrameImage: SingleRenderAssetRef | null;
    sourceVideo: SingleRenderAssetRef | null;
}

export interface ValidationIssue {
    field: string;
    message: string;
}

interface NumericRule {
    label: string;
    min: number;
    max: number;
    integer?: boolean;
}

export function validateSingleRender(input: SingleRenderValidationInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const prompt = input.prompt.trim();

    if (!prompt) {
        issues.push({ field: "prompt", message: "請先填入提示詞。" });
    } else if (
        input.enforcePromptMaxChars
        && input.promptMaxChars !== undefined
        && input.prompt.length > input.promptMaxChars
    ) {
        issues.push({
            field: "prompt",
            message: `H3 提示詞不可超過 ${input.promptMaxChars} 字元，目前為 ${input.prompt.length} 字元。`,
        });
    }

    issues.push(...validateRequiredAssets(input));

    const dimensionGrid = input.mode === "replace" ? 16 : 32;
    issues.push(...validateDimension(input.width, "width", "影片寬度", dimensionGrid));
    issues.push(...validateDimension(input.height, "height", "影片高度", dimensionGrid));
    issues.push(...validateNumber(input.steps, "steps", { label: "Steps", min: 1, max: 80, integer: true }));
    issues.push(...validateNumber(input.seed, "seed", { label: "Seed", min: 0, max: 2147483647, integer: true }));
    issues.push(...validateNumber(input.renderCount, "renderCount", { label: "影片數量", min: 1, max: 20, integer: true }));

    return issues;
}

function validateRequiredAssets(input: SingleRenderValidationInput): ValidationIssue[] {
    if (input.mode === "ref2v" && input.referenceImages.length === 0 && !input.sourceVideo) {
        return [{ field: "referenceImages", message: "Ref2VA 至少需要一個參考圖片或參考影片。" }];
    }

    if (input.mode === "i2v" && !input.referenceImage) {
        return [{ field: "referenceImage", message: "I2VA 需要參考圖片。" }];
    }

    if (input.mode === "fl2v" && (!input.referenceImage || !input.lastFrameImage)) {
        return [{ field: "referenceImage", message: "FL2VA 需要首幀與尾幀圖片。" }];
    }

    if (input.mode === "l2v" && !input.lastFrameImage) {
        return [{ field: "lastFrameImage", message: "L2VA 需要尾幀圖片。" }];
    }

    if (input.mode === "replace" && (!input.referenceImage || !input.sourceVideo)) {
        return [{ field: "sourceVideo", message: "影片替換需要參考圖片與來源影片。" }];
    }

    return [];
}

function validateDimension(
    value: NumberDraft,
    field: "width" | "height",
    label: string,
    grid: number,
): ValidationIssue[] {
    if (value === "" || !Number.isFinite(value)) {
        return [{ field, message: `${label}不可為空。` }];
    }

    if (value <= 0 || !Number.isInteger(value)) {
        return [{ field, message: `${label}必須是大於 0 的整數。` }];
    }

    if (value % grid !== 0) {
        return [{ field, message: `${label}必須是 ${grid} 的倍數。` }];
    }

    return [];
}

function validateNumber(
    value: NumberDraft,
    field: "steps" | "seed" | "renderCount",
    rule: NumericRule,
): ValidationIssue[] {
    if (value === "" || !Number.isFinite(value)) {
        return [{ field, message: `${rule.label}不可為空。` }];
    }

    if (rule.integer && !Number.isInteger(value)) {
        return [{ field, message: `${rule.label}必須是整數。` }];
    }

    if (value < rule.min || value > rule.max) {
        return [{ field, message: `${rule.label}必須介於 ${rule.min} 到 ${rule.max}。` }];
    }

    return [];
}
