import type {
    SeedVR2ColorCorrection,
    SeedVR2ResizeMethod,
    SeedVR2SamplerName,
    SeedVR2Scheduler,
} from "./upscale-client";

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
        nearest: "直接使用鄰近像素、不做平滑；像素邊界最硬，較適合像素風素材。",
        area: "以區域平均方式重採樣，縮小時穩定；用於放大時通常會較柔和。",
    },
    colorCorrection: {
        wavelet: "以多尺度方式校正輸出色彩，通常能兼顧來源色調與修復結果；目前建議選項。",
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
        nearest: "Uses the nearest pixel without smoothing, producing hard pixel edges; best suited to pixel-art-like sources.",
        area: "Area-averaged resampling that is stable for downscaling and usually softer when enlarging.",
    },
    colorCorrection: {
        wavelet: "Multi-scale color correction that usually balances source color with the restored result; currently recommended.",
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
};

export function getSeedVR2Help(locale: "zh-TW" | "en"): SeedVR2HelpCopy {
    return locale === "en" ? EN_HELP : ZH_TW_HELP;
}
