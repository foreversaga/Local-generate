import type {
    SeedVR2BlendingMethod,
    SeedVR2ColorCorrection,
    SeedVR2DetailPreset,
    SeedVR2ResizeMethod,
    SeedVR2SamplerName,
    SeedVR2Scheduler,
    SeedVR2TilingStrategy,
} from "./upscale-client";

type SeedVR2DetailHelpCopy = {
    sectionTitle: string;
    sectionSummaryDefault: string;
    sectionSummarySkin: string;
    presetLabel: string;
    reset: string;
    experimentalWarning: string;
    preset: Record<SeedVR2DetailPreset, string>;
    inputNoiseScale: string;
    latentNoiseScale: string;
    tileWidth: string;
    tileHeight: string;
    tilePadding: string;
    tileUpscaleResolution: string;
    antiAliasingStrength: string;
    maskBlur: string;
    blendingMethod: Record<SeedVR2BlendingMethod, string>;
    tilingStrategy: Record<SeedVR2TilingStrategy, string>;
    errors: {
        inputNoiseScale: string;
        latentNoiseScale: string;
        tileWidth: string;
        tileHeight: string;
        tilePadding: string;
        tileUpscaleResolution: string;
        antiAliasingStrength: string;
        maskBlur: string;
    };
};

type SeedVR2HelpCopy = {
    scale: string;
    seed: string;
    steps: string;
    cfg: string;
    denoise: string;
    resize: Record<SeedVR2ResizeMethod, string>;
    colorCorrection: Record<SeedVR2ColorCorrection, string>;
    sampler: Record<SeedVR2SamplerName, string>;
    scheduler: Record<SeedVR2Scheduler, string>;
    detail: SeedVR2DetailHelpCopy;
};

const ZH_TW_HELP: SeedVR2HelpCopy = {
    scale: "決定輸出寬高的放大倍率；倍率越高，輸出解析度、記憶體需求與處理時間通常越高。",
    seed: "控制取樣的隨機性；相同素材與參數搭配相同 Seed 較容易重現結果，留空會自動隨機。",
    steps: "取樣迭代次數。SeedVR2 官方預設為 1；提高步數會增加運算時間，主要用於多步取樣實驗。",
    cfg: "控制取樣引導強度。官方預設為 1；提高後會增加模型重建介入，過高可能更容易偏離原始畫面。",
    denoise: "控制重建／去噪介入程度。1 代表完整修復；降低可保留更多原始內容，但修復幅度也會下降。",
    resize: {
        lanczos: "高品質且偏銳利的重採樣，較能保留邊緣與細節；一般放大優先選擇。",
        bicubic: "細節與平滑度較平衡，畫面通常比 Lanczos 柔和一些。",
        bilinear: "平滑且計算簡單，較容易柔化細節；適合不希望邊緣過銳的素材。",
        "nearest-exact": "直接使用鄰近像素、不做平滑；像素邊界最硬，較適合像素風素材。",
        area: "以區域平均方式重採樣，縮小時穩定；用於放大時通常會較柔和。",
    },
    colorCorrection: {
        wavelet: "以多尺度方式校正輸出色彩，通常能兼顧來源色調與修復結果；目前建議選項。",
        lab: "在 LAB 色彩空間對齊來源與輸出，通常能保留亮度細節並讓色彩更接近原圖。",
        adain: "以特徵統計對齊色彩與對比，校正較積極，可能改變部分局部色調。",
        none: "不做額外色彩對齊；保留模型原始輸出，但可能與來源畫面產生色偏。",
    },
    sampler: {
        euler: "單步直接、計算簡單；SeedVR2 官方預設，使用 1 Step 時優先選擇。",
        euler_ancestral: "帶較多隨機探索的 Euler 變體；結果變化通常比一般 Euler 更明顯。",
        heun: "帶二階校正的取樣器；通常在多步設定較有意義，單步用途有限且計算量較高。",
        dpmpp_2m: "二階多步取樣器；主要用於 2 Step 以上的多步實驗，追求較平順的收斂。",
        dpmpp_2m_sde: "DPM++ 2M 的 SDE 版本；多步時增加隨機探索，結果變化通常也更大。",
        dpmpp_3m_sde: "三階多步 SDE 取樣器；偏向較高步數的精細實驗，1 Step 時優勢有限。",
        res_multistep: "多步取樣方法；主要用於非官方多步實驗，建議保持其他參數不變做 A/B 比較。",
    },
    scheduler: {
        simple: "簡化噪聲時程；SeedVR2 官方預設，最適合官方 1 Step 配置。",
        normal: "一般噪聲時程，作為多步設定的基準選項，方便與其他 Scheduler 比較。",
        karras: "Karras 噪聲時程，會把較多取樣密度放在低噪聲區段，常用於多步精修。",
        exponential: "以指數方式配置噪聲層級，讓高到低噪聲之間維持較規律的比例間距。",
        sgm_uniform: "依 SGM 時間／噪聲座標均勻配置步驟，主要用於多步取樣比較。",
        ddim_uniform: "使用 DDIM 類型的均勻步驟配置，行為較規則，主要用於多步或相容性實驗。",
        beta: "依 Beta 分布安排噪聲步驟，使取樣密度偏向特定區段；屬於進階實驗選項。",
    },
    detail: {
        sectionTitle: "細節重建 / Tiled detail",
        sectionSummaryDefault: "預設關閉細節增強",
        sectionSummarySkin: "皮膚細節 · 0.035 noise · 1024 tile",
        presetLabel: "細節預設",
        reset: "重設細節參數",
        experimentalWarning: "細節重建參數不是目前原生 SeedVR2 workflow 的預設；後端接上 tiled/detail workflow 後才會實際生效。提高 noise 或 tile 解析度也會增加偏離原圖、記憶體與耗時風險。",
        preset: {
            default: "預設（維持原工作流）",
            skin_detail: "皮膚細節（毛孔／髮絲／材質）",
        },
        inputNoiseScale: "在輸入影像加入少量噪聲，讓模型有空間重建毛孔與其他高頻細節。真人素材建議從 0.02–0.06 測試。",
        latentNoiseScale: "在 latent 階段加入噪聲。皮膚細節模式預設為 0；提高通常會讓結果更柔或增加變化。",
        tileWidth: "每個細節重建 tile 的寬度。1024 是高品質起點；越大越吃記憶體。",
        tileHeight: "每個細節重建 tile 的高度。通常與 Tile Width 保持一致。",
        tilePadding: "tile 周圍額外重疊區域，可降低接縫；64 是一般高品質起點。",
        tileUpscaleResolution: "單一 tile 的細節重建目標解析度；2048 能提供較多高頻重建空間，但會增加記憶體與耗時。",
        antiAliasingStrength: "細節保留優先時使用 0；提高會平滑鋸齒，也可能把皮膚高頻紋理一起柔化。",
        maskBlur: "tile 混合遮罩的模糊程度。細節保留優先使用 0；提高可柔化接縫但也可能降低局部清晰度。",
        blendingMethod: {
            multiband: "以多頻段混合 tile，通常最能兼顧接縫與高頻細節；皮膚細節建議。",
            linear: "線性混合重疊區，速度與行為較單純，但複雜材質可能較容易看出接縫。",
            gaussian: "以高斯權重柔和混合 tile，接縫自然但可能比 Multiband 更柔。",
        },
        tilingStrategy: {
            chess: "棋盤式分批處理相鄰 tile，降低邊界互相干擾；細節模式建議。",
            grid: "依規則網格逐塊處理，行為直觀，但接縫控制更依賴 padding 與 blending。",
        },
        errors: {
            inputNoiseScale: "Input Noise Scale 必須介於 0 到 0.2。",
            latentNoiseScale: "Latent Noise Scale 必須介於 0 到 0.2。",
            tileWidth: "Tile Width 必須是 256 到 2048 之間且為 64 的倍數。",
            tileHeight: "Tile Height 必須是 256 到 2048 之間且為 64 的倍數。",
            tilePadding: "Tile Padding 必須是 0 到 256 的整數。",
            tileUpscaleResolution: "Tile Upscale Resolution 必須是 512 到 4096 之間且為 64 的倍數。",
            antiAliasingStrength: "Anti-aliasing Strength 必須介於 0 到 1。",
            maskBlur: "Mask Blur 必須介於 0 到 64。",
        },
    },
};

const EN_HELP: SeedVR2HelpCopy = {
    scale: "Controls the output width/height scale. Higher scales usually require more memory and processing time.",
    seed: "Controls sampling randomness. Reusing the same source, settings, and seed helps reproduce a result; leave blank for a random seed.",
    steps: "Number of sampling iterations. SeedVR2 officially defaults to 1; more steps cost more compute and are mainly for multi-step experiments.",
    cfg: "Controls sampling guidance strength. The official default is 1; higher values increase reconstruction influence and can drift further from the source.",
    denoise: "Controls reconstruction/denoising strength. 1 applies full restoration; lower values preserve more source content but reduce restoration strength.",
    resize: {
        lanczos: "High-quality, sharper resampling that preserves edges and detail well; a strong default for upscaling.",
        bicubic: "Balances detail and smoothness and is usually softer than Lanczos.",
        bilinear: "Simple, smooth resampling that can soften fine detail; useful when sharp edges are undesirable.",
        "nearest-exact": "Uses the nearest pixel without smoothing, producing hard pixel edges; best suited to pixel-art-like sources.",
        area: "Area-averaged resampling that is stable for downscaling and usually softer when enlarging.",
    },
    colorCorrection: {
        wavelet: "Multi-scale color correction that usually balances source color with the restored result; currently recommended.",
        lab: "Matches source and output in LAB color space, generally preserving luminance detail while keeping color close to the source.",
        adain: "Aligns feature statistics for color and contrast more aggressively and may alter some local tones.",
        none: "Disables extra color matching; keeps the model output untouched but may allow color drift from the source.",
    },
    sampler: {
        euler: "Simple, direct sampling and the SeedVR2 official default; preferred for the official 1-step setup.",
        euler_ancestral: "An Euler variant with more stochastic exploration, typically producing more variation than standard Euler.",
        heun: "A second-order corrected sampler that is mainly useful with multiple steps; limited benefit at 1 step and more compute per step.",
        dpmpp_2m: "A second-order multi-step sampler mainly intended for 2+ step experiments and smoother convergence.",
        dpmpp_2m_sde: "The SDE form of DPM++ 2M; adds stochastic exploration in multi-step runs and usually increases variation.",
        dpmpp_3m_sde: "A third-order multi-step SDE sampler aimed at higher-step fine-tuning experiments; limited advantage at 1 step.",
        res_multistep: "A multi-step sampling method for non-default experiments; compare it with other settings held constant.",
    },
    scheduler: {
        simple: "A simplified noise schedule and the SeedVR2 official default; best matched to the official 1-step setup.",
        normal: "A general noise schedule that works as a useful multi-step baseline for comparing schedulers.",
        karras: "A Karras noise schedule that allocates more sampling density toward lower-noise regions, commonly used for multi-step refinement.",
        exponential: "Places noise levels exponentially, maintaining more regular proportional spacing from high to low noise.",
        sgm_uniform: "Distributes steps uniformly in SGM time/noise coordinates; mainly useful for multi-step comparisons.",
        ddim_uniform: "Uses a DDIM-style uniform step schedule with regular spacing, mainly for multi-step or compatibility experiments.",
        beta: "Distributes noise steps with a beta schedule so density favors selected regions; an advanced experimental option.",
    },
    detail: {
        sectionTitle: "Detail reconstruction / Tiled detail",
        sectionSummaryDefault: "Detail enhancement off by default",
        sectionSummarySkin: "Skin detail · 0.035 noise · 1024 tile",
        presetLabel: "Detail preset",
        reset: "Reset detail settings",
        experimentalWarning: "These controls are not part of the current native SeedVR2 workflow. They take effect after the backend detail/tiled workflow is connected. More noise or larger tile reconstruction can also increase drift, memory use, and runtime.",
        preset: {
            default: "Default (preserve current workflow)",
            skin_detail: "Skin detail (pores / hair / material)",
        },
        inputNoiseScale: "Adds a small amount of noise before reconstruction so the model has room to rebuild pores and other high-frequency detail. For people, start around 0.02–0.06.",
        latentNoiseScale: "Adds noise in latent space. Skin detail defaults to 0; increasing it commonly softens the result or adds variation.",
        tileWidth: "Width of each detail reconstruction tile. 1024 is a strong quality starting point; larger values use more memory.",
        tileHeight: "Height of each detail reconstruction tile. Usually keep it aligned with Tile Width.",
        tilePadding: "Extra overlap around each tile to reduce seams. 64 is a common high-quality starting point.",
        tileUpscaleResolution: "Target reconstruction resolution for each tile. 2048 gives the model more high-frequency reconstruction space at higher memory and runtime cost.",
        antiAliasingStrength: "Use 0 when fine detail preservation is the priority. Higher values smooth jagged edges but may also soften skin texture.",
        maskBlur: "Controls tile blend-mask blur. Use 0 for maximum detail; higher values can hide seams while softening local detail.",
        blendingMethod: {
            multiband: "Blends tiles across frequency bands and usually preserves fine detail while hiding seams; recommended for skin detail.",
            linear: "Linearly blends overlap regions. It is simple and predictable, but complex textures can reveal seams more easily.",
            gaussian: "Uses Gaussian weighting for softer transitions; seams can look natural but results may be softer than Multiband.",
        },
        tilingStrategy: {
            chess: "Processes neighboring tiles in a chess pattern to reduce boundary interference; recommended for detail reconstruction.",
            grid: "Processes a regular grid; straightforward, but seam quality depends more heavily on padding and blending.",
        },
        errors: {
            inputNoiseScale: "Input Noise Scale must be between 0 and 0.2.",
            latentNoiseScale: "Latent Noise Scale must be between 0 and 0.2.",
            tileWidth: "Tile Width must be 256–2048 and a multiple of 64.",
            tileHeight: "Tile Height must be 256–2048 and a multiple of 64.",
            tilePadding: "Tile Padding must be an integer from 0 to 256.",
            tileUpscaleResolution: "Tile Upscale Resolution must be 512–4096 and a multiple of 64.",
            antiAliasingStrength: "Anti-aliasing Strength must be between 0 and 1.",
            maskBlur: "Mask Blur must be between 0 and 64.",
        },
    },
};

export function getSeedVR2Help(locale: "zh-TW" | "en"): SeedVR2HelpCopy {
    return locale === "en" ? EN_HELP : ZH_TW_HELP;
}
