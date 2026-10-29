import { ipcMain, BrowserWindow, dialog, app } from "electron";
import { Log } from "../log/main";
import { ConfigMain } from "../config/main";
import ServerApi from "../server/api";
import { spawn, exec, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
    recognizeAudioWithFunasr,
    extractAudioFromVideo,
    funasrResultToSrt,
    FunasrResult
} from "./funasr";
import { AppEnv } from "../env";
import AuthMain from "../auth/main";
import { execFFmpegCommand } from "../shell";
import { registerCoverTemplateHandlers } from "./coverTemplate";
import { registerSubtitleTemplateHandlers } from "./subtitleTemplate";
import { isDev } from "../../lib/env";
import { getPythonPath } from "../../lib/python-util";
import { getFFmpegExecutablePath, resourceExists } from "../../lib/resource-path";
import { getPythonScriptPath } from "../../lib/resource-path";
import { getElectronSystemConfigSync } from "../systemConfig";

function getSystemFontDirs(): string[] {
    const dirs: string[] = [];
    if (process.platform === 'win32') {
        dirs.push(path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'Fonts'));
    } else if (process.platform === 'darwin') {
        dirs.push('/Library/Fonts', '/System/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts'));
    } else {
        dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'), path.join(os.homedir(), '.local/share/fonts'));
    }
    return dirs;
}

let browserWindow: BrowserWindow | null = null;

/**
 * 将 Windows 长路径转换为短路径（8.3 格式）
 * 用于处理包含中文字符或空格的路径
 * @param longPath 长路径
 * @returns 短路径，如果转换失败则返回原路径
 */
function getShortPath(longPath: string): string {
    return longPath;
}

// 获取设置文件路径
const getSettingsFilePath = () => {
    return path.join(AppEnv.dataRoot, 'ipAgent', 'settings.json');
};

// 获取统一的输出目录（所有生成的文件都保存在这里）
const getOutputDir = (subDir?: string) => {
    const hubRoot = ConfigMain.getSync('hubRoot') || '';
    const baseDir = hubRoot || path.join(AppEnv.dataRoot, 'hub');
    const outputDir = subDir ? path.join(baseDir, subDir) : path.join(baseDir, 'file');
    console.log(`[getOutputDir] hubRoot=${hubRoot}, baseDir=${baseDir}, outputDir=${outputDir}`);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    return outputDir;
};

// 确保设置目录存在
const ensureSettingsDir = () => {
    const settingsDir = path.join(AppEnv.dataRoot, 'ipAgent');
    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, { recursive: true });
    }
};

const DEFAULT_DOUBAO_TEXT_MODEL = 'doubao-seed-2-0-lite-260215';

function getConfiguredDoubaoTextModelKey(): string {
    const configuredModelId = (getElectronSystemConfigSync().volcengine_model || '').trim() || DEFAULT_DOUBAO_TEXT_MODEL;
    return `builtInDoubao|${configuredModelId}`;
}

function normalizeIpAgentSettings(settings: any): { settings: any; changed: boolean } {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return { settings, changed: false };
    }

    const normalizedSettings = { ...settings };
    let changed = false;
    const configuredDoubaoTextModelKey = getConfiguredDoubaoTextModelKey();
    const currentTextModelKey = typeof normalizedSettings.textModelKey === 'string'
        ? normalizedSettings.textModelKey.trim()
        : '';

    if (normalizedSettings.enableGpuCleanup) {
        normalizedSettings.enableGpuCleanup = false;
        changed = true;
    }

    if (!currentTextModelKey) {
        normalizedSettings.textModelKey = configuredDoubaoTextModelKey;
        return { settings: normalizedSettings, changed: true };
    }

    // 🔧 修复：不再强制覆盖用户选择的豆包模型
    // 用户可以在 builtInDoubao 的多个模型之间自由选择，只有当 modelId 无效时才纠正
    // 老安装包遗留的无效模型ID（不在已知模型列表中的）才需要自动纠正
    const knownDoubaoModels = [
        'doubao-seed-2-0-lite-260215',
        'doubao-seed-2-0-mini-260215',
    ];
    const [providerId, modelId] = currentTextModelKey.split('|');
    if (providerId === 'builtInDoubao' && modelId && !knownDoubaoModels.includes(modelId)) {
        // 模型ID不在已知列表中，属于老版本遗留或无效ID，纠正为配置的默认模型
        normalizedSettings.textModelKey = configuredDoubaoTextModelKey;
        changed = true;
    }

    return { settings: normalizedSettings, changed };
}

// RGB颜色转ASS ABGR格式（不带透明度）
const hexToABGR = (hex: string): string => {
    if (!hex || typeof hex !== 'string') return '&H00FFFFFF';
    const rgb = hex.replace('#', '').toUpperCase();
    if (rgb.length === 6) {
        const r = rgb.substring(0, 2);
        const g = rgb.substring(2, 4);
        const b = rgb.substring(4, 6);
        return `&H00${b}${g}${r}`;
    }
    return '&H00FFFFFF';
};

// RGB颜色转ASS ABGR格式（带透明度）
// 修复：ASS格式中，00=不透明，FF=完全透明
// 新增：混合颜色以模拟透明度（ASS BackColour不支持Alpha）
// 原理：混合色 = 前景色 * 透明度 + 白色 * (1 - 透明度)
// 这样能产生"变淡"效果而不是"变暗"，符合正常的透明度视觉效果
const blendColorForOpacity = (foregroundHex: string, opacity: number): string => {
    // 完全透明时返回白色（完全看不到背景）
    if (!foregroundHex || foregroundHex === 'transparent' || opacity === 0) {
        return '#FFFFFF';
    }

    // 完全不透明时返回原始颜色
    if (opacity === 1) {
        return foregroundHex;
    }

    // 解析前景色（用户选择的背景颜色）
    const fgHex = foregroundHex.replace('#', '').toUpperCase();
    if (fgHex.length !== 6) {
        return foregroundHex; // 格式错误，返回原始颜色
    }

    const fgR = parseInt(fgHex.substring(0, 2), 16);
    const fgG = parseInt(fgHex.substring(2, 4), 16);
    const fgB = parseInt(fgHex.substring(4, 6), 16);

    // 背景色为白色（用于产生淡化效果）
    const bgR = 255;
    const bgG = 255;
    const bgB = 255;

    // 计算混合颜色
    // 公式：混合色 = 前景色 * opacity + 白色 * (1 - opacity)
    // 效果：opacity高 → 接近前景色，opacity低 → 接近白色（变淡）
    const blendR = Math.round(fgR * opacity + bgR * (1 - opacity));
    const blendG = Math.round(fgG * opacity + bgG * (1 - opacity));
    const blendB = Math.round(fgB * opacity + bgB * (1 - opacity));

    // 转换回16进制
    const blendHex = '#' +
        blendR.toString(16).padStart(2, '0').toUpperCase() +
        blendG.toString(16).padStart(2, '0').toUpperCase() +
        blendB.toString(16).padStart(2, '0').toUpperCase();

    Log.info("blendColorForOpacity.calculation", {
        inputColor: foregroundHex,
        inputOpacity: opacity,
        foregroundRGB: { r: fgR, g: fgG, b: fgB },
        白色背景RGB: { r: bgR, g: bgG, b: bgB },
        blendedRGB: { r: blendR, g: blendG, b: blendB },
        blendedColor: blendHex,
        visualEffect: '透明度越低 → 颜色越淡（趋向白色）',
        note: '混合颜色用于模拟ASS中的背景透明度效果（ASS不支持Alpha）'
    });

    return blendHex;
};

const hexToABGRWithAlpha = (hex: string, opacity: number): string => {
    // 如果颜色是透明或透明度为0，返回完全透明
    if (!hex || typeof hex !== 'string' || hex === 'transparent' || opacity === 0) {
        return '&HFF000000'; // 完全透明（Alpha=FF表示完全透明）
    }
    const rgb = hex.replace('#', '').toUpperCase();
    if (rgb.length === 6) {
        const r = rgb.substring(0, 2);
        const g = rgb.substring(2, 4);
        const b = rgb.substring(4, 6);
        // 修复：ASS格式透明度计算
        // opacity: 0-1 (0=完全透明, 1=完全不透明)
        // ASS Alpha: 00-FF (00=不透明, FF=完全透明)
        // 公式：alpha = (1 - opacity) * 255
        const alpha = Math.round((1 - opacity) * 255);
        const alphaHex = alpha.toString(16).padStart(2, '0').toUpperCase();

        Log.info("hexToABGRWithAlpha.calculation", {
            inputOpacity: opacity,
            calculatedAlpha: alpha,
            alphaHex,
            finalColor: `&H${alphaHex}${b}${g}${r}`
        });

        return `&H${alphaHex}${b}${g}${r}`;
    }
    return '&HFF000000'; // 默认完全透明
};

const resolveDrawtextBoxStyle = (backgroundColor?: string, backgroundOpacity?: number) => {
    const normalizedOpacity = typeof backgroundOpacity === 'number' && Number.isFinite(backgroundOpacity)
        ? Math.max(0, Math.min(1, backgroundOpacity))
        : 0;
    const normalizedColor = typeof backgroundColor === 'string' ? backgroundColor.trim() : '';

    if (!normalizedColor || normalizedColor.toLowerCase() === 'transparent' || normalizedOpacity <= 0) {
        return {
            colorHex: '000000',
            opacity: 0,
            hasBackground: false
        };
    }

    const colorHex = normalizedColor.replace('#', '').toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(colorHex)) {
        return {
            colorHex: '000000',
            opacity: 0,
            hasBackground: false
        };
    }

    return {
        colorHex,
        opacity: normalizedOpacity,
        hasBackground: true
    };
};

// 生成 drawtext 过滤器链（支持真正的背景透明度和关键词特效）
// 这是实现透明背景的唯一可靠方法（FFmpeg libass 限制）
// 定义返回类型
interface DrawtextFilterResult {
    filters: string;
    occupiedRanges: Array<{
        start: number;         // 开始时间（秒）
        end: number;           // 结束时间（秒）
        keyword: string;       // 关键词
        lineIndex: number;     // 对话行索引
        wordIndex: number;     // 字索引
    }>;
}

// 字幕布局信息
interface SubtitleLayoutInfo {
    line: 1 | 2;           // 第1行或第2行
    y: number;             // y坐标（像素）
    isKeywordEffect: boolean; // 是否是关键词特效
}

// 遮挡检测结果
interface OcclusionResult {
    isSafe: boolean;                    // 是否安全（不会遮挡）
    affectedSubtitles: string[];        // 会遮挡的字幕列表
    suggestedActions: string[];         // 建议的调整措施
    adjustmentParams?: {                // 建议的调整参数
        scaleReduction?: number;        // 缩放倍数降低（0-1）
        durationReduction?: number;     // 时长缩短（0-1）
        positionShift?: number;         // 位置偏移（像素）
    };
}

// 动画遮挡检测器
class AnimationOcclusionDetector {
    private videoWidth: number = 1280;
    private videoHeight: number = 720;

    constructor(videoWidth: number = 1280, videoHeight: number = 720) {
        this.videoWidth = videoWidth;
        this.videoHeight = videoHeight;
    }

    /**
     * 检测特效字幕动画是否会遮挡后续字幕
     * @param effectDuration 特效时长（秒）
     * @param scaleAmplitude 缩放幅度（相对于原始字体大小）
     * @param followingSubtitles 后续字幕列表
     * @returns 遮挡检测结果
     */
    detectOcclusion(
        effectDuration: number,
        scaleAmplitude: number,
        followingSubtitles: string[]
    ): OcclusionResult {
        const maxScaleFactor = 1 + scaleAmplitude;
        const maxExpandedHeight = 60 * maxScaleFactor; // 假设字体大小为60

        const isSafe = maxExpandedHeight < this.videoHeight * 0.6; // 不超过视频高度的60%

        return {
            isSafe: isSafe,
            affectedSubtitles: isSafe ? [] : followingSubtitles.slice(0, 2),
            suggestedActions: isSafe
                ? ["动画安全，不会遮挡后续字幕"]
                : [
                    "缩放幅度过大，建议降低",
                    "缩短动画时长",
                    "改变字幕显示位置"
                ],
            adjustmentParams: isSafe ? undefined : {
                scaleReduction: 0.3,      // 建议降低30%的缩放幅度
                durationReduction: 0.2,   // 建议缩短20%的时长
                positionShift: -20        // 建议向上偏移20像素
            }
        };
    }
}

// 遮挡避免器
class OcclusionAvoider {
    private detector: AnimationOcclusionDetector;

    constructor(videoWidth: number = 1280, videoHeight: number = 720) {
        this.detector = new AnimationOcclusionDetector(videoWidth, videoHeight);
    }

    /**
     * 自动调整字幕参数以避免遮挡
     */
    applyAutoAdjustment(
        originalScaleAmplitude: number,
        originalDuration: number,
        detectionResult: OcclusionResult
    ): {
        adjustedScaleAmplitude: number;
        adjustedDuration: number;
        strategy: string;
    } {
        if (detectionResult.isSafe) {
            return {
                adjustedScaleAmplitude: originalScaleAmplitude,
                adjustedDuration: originalDuration,
                strategy: "no_adjustment"
            };
        }

        const adjustment = detectionResult.adjustmentParams || {};
        const scaleReduction = adjustment.scaleReduction || 0.2;
        const durationReduction = adjustment.durationReduction || 0.1;

        return {
            adjustedScaleAmplitude: originalScaleAmplitude * (1 - scaleReduction),
            adjustedDuration: originalDuration * (1 - durationReduction),
            strategy: "reduce_scale_and_duration"
        };
    }
}

// 2行字幕布局管理器
class SubtitleLayoutManager {
    private maxLines: number = 2;
    private lineHeight: number = 60; // 每行的高度（像素）
    private videoHeight: number = 720; // 视频高度（默认值，可配置）
    private bottomMargin: number = 20; // 距离底部的边距

    constructor(videoHeight: number = 720) {
        this.videoHeight = videoHeight;
    }

    /**
     * 计算字幕应该显示的行号和y坐标
     * @param isKeywordEffect 是否是关键词特效（优先显示在上方）
     * @param currentLineCount 当前已分配的行数
     * @returns 布局信息
     */
    calculateLayout(isKeywordEffect: boolean, currentLineCount: number): SubtitleLayoutInfo {
        // 关键词特效优先显示在上方（第1行）
        // 普通字幕显示在下方（第2行）
        // 如果超过2行，则向上调整位置

        if (isKeywordEffect) {
            // 关键词特效：优先使用第1行
            return {
                line: 1,
                y: this.videoHeight - this.lineHeight - this.bottomMargin,
                isKeywordEffect: true
            };
        } else {
            // 普通字幕：使用第2行
            // 如果已有关键词特效，则向下放置
            return {
                line: 2,
                y: this.videoHeight - 2 * this.lineHeight - this.bottomMargin,
                isKeywordEffect: false
            };
        }
    }

    /**
     * 当超过2行时，自动调整所有字幕的y坐标
     */
    adjustForMultipleLines(subtitleCount: number): number {
        // 如果字幕数超过2行，需要整体向上移动
        // 向上移动的距离 = (总行数 - 2) * lineHeight
        const extraLines = Math.max(0, Math.ceil(subtitleCount / 2) - 1);
        return extraLines * this.lineHeight;
    }
}

// 生成普通字幕的enable条件，排除被关键词占用的时间段
const generateEnableCondition = (
    baseStart: number,
    baseEnd: number,
    occupiedRanges: Array<{ start: number, end: number }>
): string => {
    // 基础条件：在对话行的时间段内
    let condition = `between(t\\,${baseStart}\\,${baseEnd})`;

    // 如果没有冲突，直接返回
    if (!occupiedRanges || occupiedRanges.length === 0) {
        return condition;
    }

    // 添加排除条件：排除所有占用的时间段
    // 生成表达式：between(t,start,end) AND !between(t,occ1_start,occ1_end) AND ...
    for (const occupied of occupiedRanges) {
        condition += ` AND !between(t\\,${occupied.start}\\,${occupied.end})`;
    }

    return condition;
};

const generateDrawtextFilters = (
    assPath: string,
    subtitleStyle: any,
    keywords?: string[],           // 关键词列表
    keywordStyle?: any,            // 关键词样式
    keywordGroups?: any[]          // 关键词组（包含每个组的样式和关键词）
): DrawtextFilterResult => {
    try {
        const assContent = fs.readFileSync(assPath, 'utf-8');
        const lines = assContent.split('\n');

        // 从 subtitleStyle 提取样式参数
        let fontSize = 48;
        let fontColor = 'FFFFFF';
        let backgroundColor = '000000';
        let bgOpacity = 0;
        let hasBackgroundBox = false;
        let fontName = 'Arial';

        if (subtitleStyle) {
            fontSize = subtitleStyle.fontSize || 48;
            fontColor = (subtitleStyle.fontColor || '#FFFFFF').replace('#', '').toUpperCase();
            fontName = subtitleStyle.fontName || 'Arial';

            const subtitleBackgroundStyle = resolveDrawtextBoxStyle(
                subtitleStyle.backgroundColor,
                subtitleStyle.backgroundOpacity
            );
            backgroundColor = subtitleBackgroundStyle.colorHex;
            bgOpacity = subtitleBackgroundStyle.opacity;
            hasBackgroundBox = subtitleBackgroundStyle.hasBackground;
        }

        // 确保颜色格式为 6 位十六进制
        if (fontColor.length !== 6) fontColor = 'FFFFFF';

        // 字体描边参数
        let outlineWidth = subtitleStyle?.outlineWidth ?? 0;
        let outlineColor = (subtitleStyle?.outlineColor || '#000000').replace('#', '').toUpperCase();
        if (outlineColor.length !== 6) outlineColor = '000000';

        // 从 ASS 文件中提取实际的字体名称（可能已被更新为内部 Family 名称）
        let assExtractedFontName = 'Arial';
        try {
            const styleLineMatch = assContent.match(/Style:\s*Default,([^,]+)/);
            if (styleLineMatch) {
                assExtractedFontName = styleLineMatch[1].trim().replace(/^["']|["']$/g, '');
                Log.info("generateDrawtextFilters.fontNameFromASS", {
                    extractedFontName: assExtractedFontName,
                    originalFontName: fontName
                });
                fontName = assExtractedFontName;
            }
        } catch (e) {
            Log.info("generateDrawtextFilters.failedToExtractFontFromASS", { error: String(e) });
        }

        // 查找实际的字体文件路径（优先查找 ASS 目录中的复制字体文件）
        const assDir = path.dirname(assPath);
        let fontFilePath = '';

        try {
            const fontExtensions = ['.ttf', '.otf', '.ttc', '.woff', '.woff2'];
            const fontNameLower = fontName.toLowerCase().replace(/\s+/g, '');

            // 在 ASS 文件所在目录查找字体文件
            if (fs.existsSync(assDir)) {
                const files = fs.readdirSync(assDir);
                for (const file of files) {
                    const ext = path.extname(file).toLowerCase();
                    if (!fontExtensions.includes(ext)) continue;

                    const fileName = path.basename(file, ext);
                    const fileNameLower = fileName.toLowerCase().replace(/\s+/g, '');

                    // 精确匹配或模糊匹配
                    if (fileNameLower === fontNameLower ||
                        fileNameLower.includes(fontNameLower) ||
                        fontNameLower.includes(fileNameLower)) {
                        const foundPath = path.join(assDir, file);

                        // 如果文件名包含非 ASCII 字符，复制并重命名为 ASCII 名称
                        // 这是为了兼容 FFmpeg drawtext filter 对中文字体名称的处理问题
                        if (/[^\x00-\x7F]/.test(file)) {
                            const ext = path.extname(file);
                            const safeFileName = `font_${Date.now()}${ext}`;
                            const safePath = path.join(assDir, safeFileName);

                            try {
                                if (!fs.existsSync(safePath)) {
                                    fs.copyFileSync(foundPath, safePath);
                                }
                                fontFilePath = safePath;
                                Log.info("generateDrawtextFilters.fontFileSafeRenamed", {
                                    originalFile: file,
                                    originalPath: foundPath,
                                    safePath: safePath,
                                    reason: "包含非 ASCII 字符，已复制并重命名以兼容 FFmpeg"
                                });
                            } catch (copyErr) {
                                // 如果复制失败，使用原始路径
                                fontFilePath = foundPath;
                                Log.info("generateDrawtextFilters.fontFileSafeRenameFailed", {
                                    originalPath: foundPath,
                                    error: String(copyErr),
                                    fallback: "使用原始文件路径"
                                });
                            }
                        } else {
                            // 文件名已是 ASCII，直接使用
                            fontFilePath = foundPath;
                        }

                        Log.info("generateDrawtextFilters.fontFileFound", {
                            fontName: fontName,
                            filePath: fontFilePath,
                            location: "assDir",
                            hasNonAsciiChars: /[^\x00-\x7F]/.test(file)
                        });
                        break;
                    }
                }
            }

            // 如果在 ASS 目录没找到，查找 ziti 目录（自定义字体目录）
            if (!fontFilePath) {
                let zitiDir = '';
                if (isDev) {
                    const appRoot = process.env.APP_ROOT || process.cwd();
                    zitiDir = path.join(appRoot, 'ziti');
                } else {
                    const installRoot = AppEnv.installRoot || AppEnv.appRoot || process.resourcesPath || process.cwd();
                    const bundleZitiDir = path.join(installRoot, 'resources-bundles', 'ziti');
                    if (fs.existsSync(bundleZitiDir)) {
                        zitiDir = bundleZitiDir;
                    } else {
                        const appRoot = process.resourcesPath || process.env.APP_ROOT || process.cwd();
                        const asarUnpackedPath = path.join(appRoot, 'app.asar.unpacked', 'ziti');
                        if (fs.existsSync(asarUnpackedPath)) {
                            zitiDir = asarUnpackedPath;
                        } else {
                            zitiDir = path.join(appRoot, 'ziti');
                        }
                    }
                }

                if (zitiDir && fs.existsSync(zitiDir)) {
                    const files = fs.readdirSync(zitiDir);
                    for (const file of files) {
                        const ext = path.extname(file).toLowerCase();
                        if (!fontExtensions.includes(ext)) continue;

                        const fileName = path.basename(file, ext);
                        const fileNameLower = fileName.toLowerCase().replace(/\s+/g, '');

                        // 精确匹配或模糊匹配（忽略大小写和空格）
                        if (fileNameLower === fontNameLower ||
                            fileNameLower.includes(fontNameLower) ||
                            fontNameLower.includes(fileNameLower)) {
                            const foundPath = path.join(zitiDir, file);

                            // 如果文件名包含非 ASCII 字符，复制到 ASS 目录并重命名
                            if (/[^\x00-\x7F]/.test(file)) {
                                const ext = path.extname(file);
                                const safeFileName = `font_${Date.now()}${ext}`;
                                const safePath = path.join(assDir, safeFileName);

                                try {
                                    if (!fs.existsSync(safePath)) {
                                        fs.copyFileSync(foundPath, safePath);
                                    }
                                    fontFilePath = safePath;
                                    Log.info("generateDrawtextFilters.fontFileSafeRenamed", {
                                        originalFile: file,
                                        originalPath: foundPath,
                                        safePath: safePath,
                                        reason: "包含非 ASCII 字符，从 ziti 目录复制并重命名"
                                    });
                                } catch (copyErr) {
                                    fontFilePath = foundPath;
                                    Log.info("generateDrawtextFilters.fontFileSafeRenameFailed", {
                                        originalPath: foundPath,
                                        error: String(copyErr),
                                        fallback: "使用原始文件路径"
                                    });
                                }
                            } else {
                                // 文件名已是 ASCII，直接复制到 ASS 目录以便 FFmpeg 使用
                                const targetPath = path.join(assDir, file);
                                try {
                                    if (!fs.existsSync(targetPath)) {
                                        fs.copyFileSync(foundPath, targetPath);
                                    }
                                    fontFilePath = targetPath;
                                } catch (copyErr) {
                                    // 如果复制失败，使用原始路径
                                    fontFilePath = foundPath;
                                    Log.info("generateDrawtextFilters.fontFileCopyFailed", {
                                        originalPath: foundPath,
                                        targetPath: targetPath,
                                        error: String(copyErr),
                                        fallback: "使用原始文件路径"
                                    });
                                }
                            }

                            Log.info("generateDrawtextFilters.fontFileFound", {
                                fontName: fontName,
                                filePath: fontFilePath,
                                location: "zitiDir",
                                zitiDir: zitiDir,
                                hasNonAsciiChars: /[^\x00-\x7F]/.test(file)
                            });
                            break;
                        }
                    }
                }
            }

            // 如果在 ziti 目录也没找到，查找系统字体目录
            if (!fontFilePath) {
                const systemFontDirs = getSystemFontDirs();
                for (const systemFontDir of systemFontDirs) {
                if (!fs.existsSync(systemFontDir)) continue;
                    const files = fs.readdirSync(systemFontDir);
                    for (const file of files) {
                        const fileName = path.basename(file, path.extname(file));
                        if (fileName.toLowerCase() === fontName.toLowerCase()) {
                            const foundPath = path.join(systemFontDir, file);

                            // 如果文件名包含非 ASCII 字符，复制到 ASS 目录并重命名
                            if (/[^\x00-\x7F]/.test(file)) {
                                const ext = path.extname(file);
                                const safeFileName = `font_${Date.now()}${ext}`;
                                const safePath = path.join(assDir, safeFileName);

                                try {
                                    if (!fs.existsSync(safePath)) {
                                        fs.copyFileSync(foundPath, safePath);
                                    }
                                    fontFilePath = safePath;
                                    Log.info("generateDrawtextFilters.fontFileSafeRenamed", {
                                        originalFile: file,
                                        originalPath: foundPath,
                                        safePath: safePath,
                                        reason: "包含非 ASCII 字符，从系统字体目录复制并重命名"
                                    });
                                } catch (copyErr) {
                                    fontFilePath = foundPath;
                                    Log.info("generateDrawtextFilters.fontFileSafeRenameFailed", {
                                        originalPath: foundPath,
                                        error: String(copyErr)
                                    });
                                }
                            } else {
                                fontFilePath = foundPath;
                            }

                            Log.info("generateDrawtextFilters.fontFileFound", {
                                fontName: fontName,
                                filePath: fontFilePath,
                                location: "systemFontDir",
                                hasNonAsciiChars: /[^\x00-\x7F]/.test(file)
                            });
                            break;
                        }
                    }
                }
            }
        } catch (e) {
            Log.info("generateDrawtextFilters.fontSearchError", { error: String(e) });
        }

        // 提取所有字幕对话行
        const dialogues: Array<{ text: string, start: string, end: string }> = [];
        for (const line of lines) {
            if (line.startsWith('Dialogue:')) {
                const parts = line.substring('Dialogue:'.length).split(',');
                if (parts.length >= 10) {
                    const start = parts[1]?.trim() || '0:00:00.00';
                    const end = parts[2]?.trim() || '0:00:10.00';
                    const text = parts.slice(9).join(',').trim();

                    if (text && text !== '') {
                        dialogues.push({ text, start, end });
                    }
                }
            }
        }

        if (dialogues.length === 0) {
            Log.info("generateDrawtextFilters.noDialogues", { assPath });
            return {
                filters: '',
                occupiedRanges: []
            };
        }

        // 时间转换：ASS 格式 HH:MM:SS.MS -> 秒数
        const timeToSeconds = (timeStr: string): number => {
            const match = timeStr.match(/(\d+):(\d+):([\d.]+)/);
            if (match) {
                const hours = parseInt(match[1], 10) || 0;
                const minutes = parseInt(match[2], 10) || 0;
                const seconds = parseFloat(match[3]) || 0;
                return hours * 3600 + minutes * 60 + seconds;
            }
            return 0;
        };

        // 生成 drawtext 过滤器
        const filters: string[] = [];
        const tempTextFiles: string[] = []; // 用于清理临时文件
        const occupiedRanges: DrawtextFilterResult['occupiedRanges'] = []; // 追踪被关键词占用的时间段
        const uniqueId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`; // 唯一标识符，避免文件名重复

        // ========== 预处理：提前计算会被关键词分组处理的关键词 ==========
        // 这样在计算foundKeywords时可以排除这些词，避免重复渲染
        const groupProcessedKeywords = new Set<string>();
        if (keywordGroups && keywordGroups.length > 0) {
            for (const group of keywordGroups) {
                if (!group.keywords || !group.keywords.length) {
                    continue;
                }
                const groupKeywords = Array.isArray(group.keywords) ? group.keywords : [];
                for (const keywordItem of groupKeywords) {
                    let keyword: string;
                    if (typeof keywordItem === 'string') {
                        keyword = keywordItem;
                    } else if (keywordItem && typeof keywordItem === 'object' && keywordItem.keyword) {
                        keyword = keywordItem.keyword;
                    } else {
                        continue;
                    }
                    if (keyword) {
                        groupProcessedKeywords.add(keyword);
                    }
                }
            }
            if (groupProcessedKeywords.size > 0) {
                Log.info('generateDrawtextFilters.precomputedGroupKeywords', {
                    count: groupProcessedKeywords.size,
                    keywords: Array.from(groupProcessedKeywords)
                });
            }
        }

        // ========== 检测ASS文件中的内联样式关键词 ==========
        // 这用于避免重复渲染：如果关键词已经在ASS中有内联样式，就不在drawtext中重复处理
        const assInlineStyledKeywords = new Map<string, { color: string, fontName?: string }>();

        // 精确匹配{\fn字体\c颜色}关键词{\r}格式
        const inlineStyleRegex = /\{\\fn([^\\}]*)\\c(&H[0-9A-F]{8})\}([^{}\\r]+)\{\\r\}/gi;

        // 也匹配只有颜色的格式 {\c颜色}关键词{\c}
        const colorOnlyRegex = /\{\\c(&H[0-9A-F]{8})\}([^{}]+)\{\\c\}/gi;

        for (const dialogue of dialogues) {
            let text = dialogue.text;

            // 匹配带字体和颜色的格式
            inlineStyleRegex.lastIndex = 0;
            let match;
            while ((match = inlineStyleRegex.exec(text)) !== null) {
                const fontName = match[1];
                const color = match[2];
                const keyword = match[3].trim();

                if (keyword && !assInlineStyledKeywords.has(keyword)) {
                    assInlineStyledKeywords.set(keyword, {
                        color: color,
                        fontName: fontName || undefined
                    });
                }
            }

            // 匹配只有颜色的格式
            colorOnlyRegex.lastIndex = 0;
            while ((match = colorOnlyRegex.exec(text)) !== null) {
                const color = match[1];
                const keyword = match[2].trim();

                if (keyword && !assInlineStyledKeywords.has(keyword)) {
                    assInlineStyledKeywords.set(keyword, {
                        color: color,
                        fontName: undefined
                    });
                }
            }
        }

        if (assInlineStyledKeywords.size > 0) {
            Log.info('generateDrawtextFilters.assInlineStyledKeywords', {
                count: assInlineStyledKeywords.size,
                keywords: Array.from(assInlineStyledKeywords.entries()).map(([k, v]) => ({
                    keyword: k,
                    color: v.color,
                    fontName: v.fontName
                }))
            });
        }

        for (let i = 0; i < dialogues.length; i++) {
            const dialogue = dialogues[i];
            const startTime = timeToSeconds(dialogue.start);
            const endTime = timeToSeconds(dialogue.end);

            // 清理文本：移除 ASS 标签（drawtext 不理解它们）
            // 但首先提取关键词和颜色信息用于后续处理
            let rawText = dialogue.text;
            rawText = rawText.replace(/\\N/g, '\n').replace(/\\n/g, '\n'); // 转换换行符

            // 从ASS内联标签中提取关键词和颜色
            // 格式: {\c&H颜色}文本{\c}
            // 【关键修复】如果有关键词分组，跳过ASS内联样式提取，避免重复生成
            // 因为关键词已经从ASS文本中移除，且keywordGroups会单独处理关键词特效
            const keywordColorMap: Map<string, string> = new Map();

            // 只有当没有keywordGroups时，才提取ASS内联样式关键词
            if (!keywordGroups || keywordGroups.length === 0) {
                const colorTagRegex = /\{\\c(&H[0-9A-F]{8})\}([^{]+)\{\\c\}/gi;
                let colorMatch;
                while ((colorMatch = colorTagRegex.exec(rawText)) !== null) {
                    const color = colorMatch[1];
                    const keyword = colorMatch[2].trim();
                    if (keyword) {
                        keywordColorMap.set(keyword, color);
                    }
                }
            } else {
                Log.info(`generateDrawtextFilters.skipAssInlineStyleExtraction`, {
                    lineIndex: i,
                    reason: "有关键词分组，跳过ASS内联样式提取，避免重复生成特效",
                    keywordGroupsCount: keywordGroups.length
                });
            }

            // 清理文本：移除所有 ASS 标签
            let displayText = rawText;
            displayText = displayText.replace(/\{[^}]*\}/g, '');
            displayText = displayText.trim();

            if (!displayText) continue;

            const plainText = displayText;

            // ========== 先扫描关键词，以便生成正确的enable条件 ==========
            // 关键修复：排除已被关键词分组处理的词，避免重复渲染
            const foundKeywords: Array<{ keyword: string, index: number }> = [];
            if (keywords && keywords.length > 0) {
                const keywordList = keywords.map(k => typeof k === 'string' ? k : k.word || k.keyword || String(k));
                for (const keyword of keywordList) {
                    if (!keyword || !plainText.includes(keyword)) {
                        continue;
                    }
                    // 关键修复：如果该关键词已被关键词分组处理，跳过它
                    if (groupProcessedKeywords.has(keyword)) {
                        Log.info(`generateDrawtextFilters.skipFoundKeyword`, {
                            keyword: keyword,
                            reason: "该关键词已在关键词分组中处理，避免重复渲染"
                        });
                        continue;
                    }
                    // 修复：跳过已有ASS内联样式的关键词
                    // 这样它们不会影响foundKeywords的计算
                    if (assInlineStyledKeywords.has(keyword)) {
                        Log.info(`generateDrawtextFilters.skipInlineStyledKeyword`, {
                            keyword: keyword,
                            reason: "该关键词已在ASS文件中使用内联样式，避免重复渲染"
                        });
                        continue;
                    }
                    foundKeywords.push({
                        keyword: keyword,
                        index: plainText.indexOf(keyword)
                    });
                }
            }

            // 使用 textfile 参数处理中文，避免编码问题
            // 创建临时文本文件（使用唯一标识符避免文件名重复）
            const tempDir = os.tmpdir();
            const tempTextPath = path.join(tempDir, `drawtext_${uniqueId}_${i}.txt`);
            fs.writeFileSync(tempTextPath, displayText, 'utf-8');
            tempTextFiles.push(tempTextPath);

            // 字体路径处理 - 需要转义冒号以支持 Windows 路径
            let fontPath = '';

            if (fontFilePath) {
                let processedPath = fontFilePath;
                if (/[\u4e00-\u9fa5]/.test(fontFilePath) || fontFilePath.includes(' ')) {
                    processedPath = getShortPath(fontFilePath);
                    Log.info('generateDrawtextFilters.convertToShortPath', {
                        originalPath: fontFilePath,
                        shortPath: processedPath,
                        reason: /[\u4e00-\u9fa5]/.test(fontFilePath) ? '路径包含中文字符' : '路径包含空格'
                    });
                }

                // 使用找到的实际字体文件路径
                // 转换反斜杠为正斜杠，转义冒号
                fontPath = processedPath.replace(/\\/g, '/').replace(/:/g, '\\:');

                Log.info(`generateDrawtextFilters.filter${i + 1}.usingFoundFontFile`, {
                    fontName: fontName,
                    originalPath: fontFilePath,
                    processedPath: processedPath,
                    escapedPath: fontPath,
                    hasChineseChars: /[\u4e00-\u9fa5]/.test(fontFilePath)
                });
            } else {
                // 备用方案：如果没找到字体文件，尝试从系统目录访问
                // 这种情况下通常会失败，但至少给出明确的错误信息
                Log.info(`generateDrawtextFilters.fontFileNotFound`, {
                    fontName: fontName,
                    searchedInDir: assDir,
                    fallbackPath: `C\\:/Windows/Fonts/${fontName}.ttf`
                });
                // 使用备用路径（带中文字体名称的情况下可能失败）
                fontPath = `C\\:/Windows/Fonts/${fontName}.ttf`;
            }

            let processedTempPath = tempTextPath;
            if (/[\u4e00-\u9fa5]/.test(tempTextPath) || tempTextPath.includes(' ')) {
                processedTempPath = getShortPath(tempTextPath);
            }

            // 转义临时文件路径中的冒号
            const escapedTempPath = processedTempPath.replace(/\\/g, '/').replace(/:/g, '\\:');

            // 在 shell: false 模式下，不需要手动添加引号
            // Node.js 的 spawn() 会自动处理参数中的特殊字符
            const quotedFontPath = fontPath;
            const quotedTempPath = escapedTempPath;

            // 生成单个 drawtext 过滤器 - 使用 textfile 而不是 text 来支持中文
            let filter =
                `drawtext=` +
                `fontfile=${quotedFontPath}:` +
                `textfile=${quotedTempPath}:` +
                `fontsize=${fontSize}:` +
                `fontcolor=0x${fontColor}:`;

            // 添加字体描边参数（如果设置了描边宽度）
            if (outlineWidth > 0) {
                filter += `borderw=${outlineWidth}:bordercolor=0x${outlineColor}:`;
            }

            // 检查当前行是否包含需要处理的分组关键词
            // 【关键修复】检查keywordGroups中是否有任何关键词
            // 即使关键词已经从ASS文本中移除了，只要keywordGroups存在，就应该显示关键词特效
            const hasKeywordGroupInThisLine = keywordGroups && keywordGroups.length > 0 &&
                keywordGroups.some(g => {
                    const keywords = g.keywords || [];
                    return keywords.length > 0;
                });

            // 【关键修复】基础字幕应该显示非关键词部分（例如："123"）
            // 关键词由drawtext特效层单独显示（例如："456"带特效）
            // 这样普通字幕和特效字幕都能显示，且关键词只显示一次
            let enableCondition = `gte(t\\,${startTime})*lte(t\\,${endTime})`;

            // 【重要】不要隐藏基础字幕，让基础字幕显示非关键词部分
            // 关键词已经从ASS文本中移除了，所以基础字幕只会显示非关键词部分

            // 检查当前行是否包含其他样式的关键词（非分组的）
            if (foundKeywords.length > 0 && !hasKeywordGroupInThisLine) {
                // 当有普通样式的特效字幕出现时，隐藏普通字幕以避免重复显示
                enableCondition = `0`; // 禁用普通字幕，因为特效会替代它

                Log.info(`generateDrawtextFilters.normalSubtitleWithKeyword`, {
                    lineIndex: i,
                    foundKeywords: foundKeywords.map(k => k.keyword),
                    normalSubtitleDisplay: "hidden when keyword effects are shown",
                    startTime: startTime,
                    endTime: endTime
                });
            }

            // 生成基础字幕（当没有关键词特效时显示）
            if (hasBackgroundBox) {
                filter +=
                    `box=1:` +
                    `boxcolor=0x${backgroundColor}@${bgOpacity}:` +
                    `boxborderw=1:`;
            }

            filter +=
                `x=(w-text_w)/2:` +
                `y=(h-text_h-20):` +
                `enable='${enableCondition}'`;

            filters.push(filter);

            // ========== 关键词特效处理 ==========
            // 优先级：keywordGroups > keywordColorMap > keywordStyle

            // 计算是否处理了关键词分组
            let keywordGroupsProcessed = false;
            const processedGroupKeywords = new Set<string>(); // 追踪已被关键词分组处理的关键词
            const processedKeywordsInThisLine = new Set<string>(); // 【关键修复】追踪当前dialogue行已处理的关键词，避免重复生成

            // 优先处理关键词分组（用户设置的各组样式）
            if (keywordGroups && keywordGroups.length > 0) {
                Log.info(`generateDrawtextFilters.keywordGroupsProcessing`, {
                    groupCount: keywordGroups.length,
                    displayText: displayText.substring(0, 100),
                    note: "处理用户配置的关键词分组"
                });

                // 设置标志表示有keywordGroups需要处理
                // 即使所有关键词都被跳过（因为有ASS内联样式），也应该设置这个标志
                keywordGroupsProcessed = true;

                for (const group of keywordGroups) {
                    if (!group.keywords || !group.keywords.length || !group.styleOverride) {
                        continue;
                    }

                    const style = group.styleOverride;
                    const groupKeywords = Array.isArray(group.keywords) ? group.keywords : [];

                    // 调试日志：查看关键词分组中的关键词格式
                    Log.info(`generateDrawtextFilters.debugGroupKeywords`, {
                        groupId: group.groupId || group.id,
                        groupName: group.groupName || group.name,
                        keywordsRaw: group.keywords,
                        keywordsArray: groupKeywords,
                        firstKeywordType: groupKeywords.length > 0 ? typeof groupKeywords[0] : 'N/A',
                        firstKeywordValue: groupKeywords.length > 0 ? groupKeywords[0] : 'N/A'
                    });

                    // 提取分组的样式信息
                    const groupFontSize = style.fontSize || fontSize;
                    const groupOutlineWidth = style.outlineWidth || outlineWidth;

                    // 处理颜色转换：#RRGGBB -> drawtext格式 0xRRGGBB
                    let groupFontColor = style.fontColor || '#FFFFFF';
                    if (groupFontColor.startsWith('#')) {
                        groupFontColor = groupFontColor.substring(1);
                    }
                    groupFontColor = groupFontColor.toUpperCase();

                    let groupOutlineColor = style.outlineColor || '#000000';
                    if (groupOutlineColor.startsWith('#')) {
                        groupOutlineColor = groupOutlineColor.substring(1);
                    }
                    groupOutlineColor = groupOutlineColor.toUpperCase();

                    // 确保颜色格式正确
                    if (groupFontColor.length !== 6) groupFontColor = 'FFFFFF';
                    if (groupOutlineColor.length !== 6) groupOutlineColor = '000000';

                    Log.info(`generateDrawtextFilters.keywordGroup`, {
                        keywordCount: groupKeywords.length,
                        fontSize: groupFontSize,
                        fontColor: groupFontColor,
                        outlineWidth: groupOutlineWidth,
                        outlineColor: groupOutlineColor
                    });

                    // 为该分组的每个关键词创建drawtext过滤器
                    for (const keywordItem of groupKeywords) {
                        // 关键词可能是字符串或对象 {keyword: "...", enabled: true}
                        let keyword: string;
                        if (typeof keywordItem === 'string') {
                            keyword = keywordItem;
                        } else if (keywordItem && typeof keywordItem === 'object' && keywordItem.keyword) {
                            keyword = keywordItem.keyword;
                        } else {
                            continue;
                        }

                        // 【关键修复】不再依赖ASS文本中是否包含关键词
                        // drawtext特效层直接从keywordGroups参数获取关键词，不依赖ASS文本查找
                        // 这样即使关键词从ASS文本中移除了，特效层仍然可以显示
                        if (!keyword) {
                            continue;
                        }

                        // 【关键修复】检查关键词是否已经在当前dialogue行处理过，避免重复生成
                        // 同一个关键词可能在多个分组中出现，或在同一分组中出现多次
                        // 但每个时间段内，每个关键词只应生成一次特效
                        if (processedKeywordsInThisLine.has(keyword)) {
                            Log.info(`generateDrawtextFilters.skipDuplicateKeyword`, {
                                keyword: keyword,
                                groupName: group.groupName || group.name,
                                reason: "该关键词已在当前时间段处理过，跳过重复生成",
                                lineIndex: i,
                                startTime: startTime,
                                endTime: endTime
                            });
                            continue; // 跳过已处理的关键词
                        }

                        // 检查关键词是否应该在该时间段显示（使用字幕时间段，不依赖文本匹配）
                        // 这样可以确保关键词特效在字幕时间段内显示，即使ASS文本中已经移除了关键词
                        const keywordShouldDisplayInThisTimeRange = true; // 总是显示，因为关键词分组已经指定了时间段

                        // 不跳过有ASS样式的关键词！
                        // 虽然ASS提供了颜色，但drawtext特效会在上面一层渲染动画
                        // drawtext的样式会覆盖ASS样式，显示用户配置的颜色和动画效果
                        if (assInlineStyledKeywords.has(keyword)) {
                            Log.info(`generateDrawtextFilters.groupKeywordWithAssStyle`, {
                                keyword: keyword,
                                groupName: group.groupName || group.name,
                                assColor: assInlineStyledKeywords.get(keyword)?.color,
                                reason: "虽有ASS样式，但仍生成drawtext特效以显示动画和正确的颜色"
                            });
                            // 不要continue - 继续处理以生成drawtext特效
                        }

                        keywordGroupsProcessed = true;
                        processedGroupKeywords.add(keyword); // 记录已处理的关键词，避免重复处理
                        processedKeywordsInThisLine.add(keyword); // 【关键修复】记录当前行已处理的关键词

                        Log.info(`generateDrawtextFilters.processingGroupKeyword`, {
                            keyword: keyword,
                            groupName: group.groupName || group.name,
                            foundInDisplayText: displayText.includes(keyword)
                        });

                        // 创建只包含关键词的临时文件
                        const tempDir = os.tmpdir();
                        const keywordTempPath = path.join(tempDir, `drawtext_group_keyword_${uniqueId}_${i}_${keyword.replace(/[^a-zA-Z0-9]/g, '')}.txt`);
                        fs.writeFileSync(keywordTempPath, keyword, 'utf-8');
                        tempTextFiles.push(keywordTempPath);

                        const escapedKeywordTempPath = keywordTempPath.replace(/\\/g, '/').replace(/:/g, '\\:');
                        const quotedKeywordTempPath = `'${escapedKeywordTempPath}'`;

                        // 从分组获取特效ID，如果没有则默认无特效
                        // 【关键修复】effectId可能存储在group.effectId或styleOverride.effectId中
                        const groupEffectId = group.effectId ||
                            group.effect ||
                            style?.effectId ||
                            group.effectConfig?.effectId ||
                            'none';

                        // 添加详细日志，追踪effectId的获取
                        Log.info(`generateDrawtextFilters.effectIdExtraction`, {
                            keyword: keyword,
                            groupName: group.groupName || group.name,
                            groupEffectId: groupEffectId,
                            fromGroupEffectId: group.effectId,
                            fromGroupEffect: group.effect,
                            fromStyleEffectId: style?.effectId,
                            fromEffectConfig: group.effectConfig?.effectId,
                            finalEffectId: groupEffectId
                        });

                        // 为关键词分组生成特效表达式
                        // 注意：FFmpeg drawtext filter 参数中不能有空格
                        let fontSizeExpr = String(groupFontSize);
                        let alphaExpr = '1';
                        let xExpr = '(w-text_w)/2';
                        let yExpr = '(h-text_h-20)';

                        // 根据特效类型生成动画表达式
                        // 注意：只使用 FFmpeg 支持的参数（fontsize, x, y），不使用 alpha
                        switch (groupEffectId) {
                            case 'zoom-in':
                                fontSizeExpr = `${groupFontSize}+sin(t*15)*3`;
                                break;
                            case 'pulse':
                                // 改为使用字体大小脉冲，而非透明度
                                fontSizeExpr = `${groupFontSize}*(0.95+sin(t*20)*0.05)`;
                                break;
                            case 'bounce':
                                yExpr = `(h-text_h-20)+sin(t*8)*30`;
                                break;
                            case 'glow':
                                // 改为使用字体大小和位置发光效果，而非透明度
                                fontSizeExpr = `${groupFontSize}*(0.98+sin(t*12)*0.02)`;
                                break;
                            case 'shake':
                                xExpr = `(w-text_w)/2+sin(t*25)*8`;
                                break;
                            case 'flip':
                                // 改为使用字体大小闪烁，而非透明度闪烁
                                // 使用绝对值和正弦波模拟闪烁
                                fontSizeExpr = `${groupFontSize}*(0.85+0.15*abs(sin(t*6)))`;
                                break;
                            case 'slide-up':
                                yExpr = `(h-text_h-20)+(h-text_h)*(1-min(1,(t-${startTime})/0.5))`;
                                break;
                            case 'fade':
                                // 改为使用字体大小渐变，而非透明度渐变
                                fontSizeExpr = `${groupFontSize}*(0.7+0.3*min(1,(t-${startTime})/0.3))`;
                                break;
                            case 'none':
                            default:
                                // 无特效，使用默认值
                                break;
                        }

                        // 生成关键词分组的drawtext过滤器
                        // 注意：只使用 FFmpeg 支持的参数（fontsize, x, y），不使用 alpha
                        // alpha 参数中的某些表达式（如 if()）无法被 FFmpeg 正确解析

                        // 【修复】改进fontsize表达式的处理方式
                        // 检查fontSizeExpr是否为动画表达式（包含sin, cos等函数）
                        const isFontSizeAnimated = fontSizeExpr.includes('sin') ||
                            fontSizeExpr.includes('cos') ||
                            fontSizeExpr.includes('tan') ||
                            fontSizeExpr.includes('+') ||
                            fontSizeExpr.includes('-') ||
                            fontSizeExpr.includes('*');

                        // 对于动画表达式，使用正确的引号处理（移除单引号直接传入表达式）
                        // 或根据FFmpeg版本使用不同的处理方式
                        const fontSizeParam = isFontSizeAnimated
                            ? `fontsize=${fontSizeExpr}`  // 动画表达式：直接传入，不用引号
                            : `fontsize='${fontSizeExpr}'`;  // 静态大小：用引号包裹

                        let groupFilter =
                            `drawtext=` +
                            `fontfile=${quotedFontPath}:` +
                            `textfile=${quotedKeywordTempPath}:` +
                            `${fontSizeParam}:` +
                            `fontcolor=0x${groupFontColor}:`;

                        // 添加描边参数
                        if (groupOutlineWidth > 0) {
                            groupFilter += `borderw=${groupOutlineWidth}:bordercolor=0x${groupOutlineColor}:`;
                        }

                        // 【修复】改进x和y表达式的处理方式
                        // 检查是否为动画表达式
                        const isXAnimated = xExpr.includes('sin') ||
                            xExpr.includes('cos') ||
                            xExpr.includes('t') ||
                            xExpr.includes('+') ||
                            xExpr.includes('-');
                        const isYAnimated = yExpr.includes('sin') ||
                            yExpr.includes('cos') ||
                            yExpr.includes('t') ||
                            yExpr.includes('+') ||
                            yExpr.includes('-');

                        const xParam = isXAnimated ? `x=${xExpr}` : `x='${xExpr}'`;
                        const yParam = isYAnimated ? `y=${yExpr}` : `y='${yExpr}'`;

                        // 【关键修复】drawtext特效层使用字幕的时间段来显示关键词
                        // 这样即使关键词从基础字幕中移除了，特效层仍然知道在哪个时间段显示
                        groupFilter +=
                            `box=1:` +
                            `boxcolor=0x000000@0:` + // 透明背景
                            `${xParam}:` +
                            `${yParam}:` +
                            `enable='gte(t\\,${startTime})*lte(t\\,${endTime})'`; // 使用字幕时间段显示关键词特效

                        filters.push(groupFilter);

                        Log.info(`generateDrawtextFilters.keywordGroup_${i}_${keyword}`, {
                            keyword: keyword,
                            groupName: group.groupName || group.name,
                            effectId: groupEffectId,
                            fontSize: groupFontSize,
                            fontColor: groupFontColor,
                            outlineWidth: groupOutlineWidth,
                            fontSizeExpr: fontSizeExpr,
                            xExpr: xExpr,
                            yExpr: yExpr,
                            isAnimated: isFontSizeAnimated || isXAnimated || isYAnimated,
                            start: startTime,
                            end: endTime
                        });
                    }
                }
            }

            // 【关键修复】当有关键词分组时，完全禁用ASS内联样式路径，避免重复生成
            // 只有当完全没有keywordGroups（null/undefined/空数组）时，才使用ASS内联样式
            // 这是导致重复显示的根本原因：即使有keywordGroups，ASS内联样式路径仍可能执行
            if ((!keywordGroups || keywordGroups.length === 0) && !keywordGroupsProcessed && keywordColorMap.size > 0) {
                // 只有在完全没有keywordGroups时，才使用从ASS文件提取的关键词颜色信息

                Log.info(`generateDrawtextFilters.assKeywordProcessing`, {
                    foundCount: keywordColorMap.size,
                    keywords: Array.from(keywordColorMap.keys()),
                    displayText: displayText.substring(0, 100),
                    hasKeywordGroups: !!(keywordGroups && keywordGroups.length > 0),
                    keywordGroupsProcessed: keywordGroupsProcessed,
                    note: "从ASS内联标签中提取的关键词颜色（仅在无keywordGroups时使用）"
                });

                for (const [keyword, color] of keywordColorMap.entries()) {
                    if (!keyword || !displayText.includes(keyword)) {
                        continue;
                    }

                    // 【关键修复】如果关键词已经被keywordGroups处理过，跳过它，避免重复生成
                    if (processedGroupKeywords.has(keyword)) {
                        Log.info(`generateDrawtextFilters.skipAssKeywordAlreadyProcessed`, {
                            keyword: keyword,
                            reason: "该关键词已被keywordGroups处理，避免重复生成特效"
                        });
                        continue;
                    }

                    // 从ASS颜色格式(&H00BBGGRR)转换为RGB颜色
                    // ASS格式中的颜色是BGR顺序，我们需要转换为RGB
                    const assColor = color.substring(4); // 取&H后面的6个字符（BBGGRR）
                    const blue = assColor.substring(0, 2);
                    const green = assColor.substring(2, 4);
                    const red = assColor.substring(4, 6);
                    const rgbColor = `${red}${green}${blue}`; // 转换为RGB

                    // 创建只包含关键词的临时文件
                    // 使用 C:\Windows\Temp 而不是 os.tmpdir()，避免短路径格式（ADMINI~1）
                    const tempDir = os.tmpdir();
                    const keywordTempPath = path.join(tempDir, `drawtext_ass_keyword_${uniqueId}_${i}_${keyword.replace(/[^a-zA-Z0-9]/g, '')}.txt`);
                    fs.writeFileSync(keywordTempPath, keyword, 'utf-8');
                    tempTextFiles.push(keywordTempPath);

                    const escapedKeywordTempPath = keywordTempPath.replace(/\\/g, '/').replace(/:/g, '\\:');
                    const quotedKeywordTempPath = `'${escapedKeywordTempPath}'`;

                    // 生成关键词drawtext过滤器，使用提取的颜色
                    let keywordFilter =
                        `drawtext=` +
                        `fontfile=${quotedFontPath}:` +
                        `textfile=${quotedKeywordTempPath}:` +
                        `fontsize=${fontSize * 1.2}:` + // 关键词稍大一些
                        `fontcolor=0x${rgbColor}:` + // 使用提取的颜色
                        `box=1:` +
                        `boxcolor=0x000000@0:` + // 透明背景
                        `x=(w-text_w)/2:` +
                        `y=(h-text_h-20):` +
                        `enable='gte(t\\,${startTime})*lte(t\\,${endTime})'`;

                    filters.push(keywordFilter);

                    Log.info(`generateDrawtextFilters.assKeyword_${i}_${keyword}`, {
                        keyword: keyword,
                        color: color,
                        rgbColor: rgbColor,
                        start: startTime,
                        end: endTime
                    });
                }
            } else if (keywords && keywords.length > 0 && keywordStyle && !keywordGroupsProcessed && (!keywordGroups || keywordGroups.length === 0)) {
                // 【关键修复】仅在没有配置keywordGroups时，才使用参数传入的keywords和keywordStyle
                // 当有关键词分组时，完全禁用keywordStyle路径，避免重复生成

                Log.info(`generateDrawtextFilters.keywordStyleWarning`, {
                    lineIndex: i,
                    message: "使用keywordStyle路径（默认黄色），可能覆盖keywordGroups的样式",
                    hasKeywordGroups: !!(keywordGroups && keywordGroups.length > 0),
                    keywordGroupsProcessed: keywordGroupsProcessed,
                    displayText: displayText.substring(0, 100)
                });
                // 关键词可能是字符串数组或对象数组，需要处理两种情况
                const keywordList = keywords.map(k => typeof k === 'string' ? k : k.word || k.keyword || String(k));

                Log.info(`generateDrawtextFilters.paramKeywordProcessing`, {
                    hasKeywords: true,
                    keywordCount: keywordList.length,
                    keywords: keywordList.slice(0, 5),
                    displayText: displayText.substring(0, 100),
                    hasKeywordStyle: !!keywordStyle,
                    processedGroupKeywords: Array.from(processedGroupKeywords),
                    processedGroupKeywordsSize: processedGroupKeywords.size
                });

                for (const keyword of keywordList) {
                    // 跳过已经被关键词分组处理过的关键词，避免重复处理
                    if (processedGroupKeywords.has(keyword)) {
                        Log.info(`generateDrawtextFilters.skipKeywordProcessed`, {
                            keyword: keyword,
                            reason: "已被关键词分组处理过"
                        });
                        continue;
                    }

                    if (!keyword || !displayText.includes(keyword)) {
                        continue;
                    }

                    // 关键词找到，创建特效过滤器
                    const keywordFontSize = keywordStyle.fontSize || fontSize;
                    let keywordFontColor = (keywordStyle.fontColor || '#FFD700').replace('#', '').toUpperCase();
                    const keywordBackgroundStyle = resolveDrawtextBoxStyle(
                        keywordStyle.backgroundColor ?? subtitleStyle?.backgroundColor,
                        keywordStyle.backgroundOpacity ?? subtitleStyle?.backgroundOpacity
                    );
                    const keywordBgColor = keywordBackgroundStyle.colorHex;
                    const keywordBgOpacity = keywordBackgroundStyle.opacity;
                    const hasKeywordBackgroundBox = keywordBackgroundStyle.hasBackground;

                    // 确保颜色格式正确
                    if (keywordFontColor.length !== 6) keywordFontColor = 'FFD700'; // 默认黄色

                    // 创建只包含关键词的临时文件（使用唯一标识符避免文件名重复）
                    // 使用 C:\Windows\Temp 而不是 os.tmpdir()，避免短路径格式（ADMINI~1）
                    const tempDir = os.tmpdir();
                    const keywordTempPath = path.join(tempDir, `drawtext_keyword_${uniqueId}_${i}_${keyword.replace(/[^a-zA-Z0-9]/g, '')}.txt`);
                    fs.writeFileSync(keywordTempPath, keyword, 'utf-8');
                    tempTextFiles.push(keywordTempPath);

                    const escapedKeywordTempPath = keywordTempPath.replace(/\\/g, '/').replace(/:/g, '\\:');
                    const quotedKeywordTempPath = `'${escapedKeywordTempPath}'`;

                    // 关键词特效：支持多种动画效果
                    // 支持从 keywordStyle 中动态读取特效参数和特效类型
                    const enableDynamicEffect = keywordStyle.enableDynamicEffect ?? true;
                    const effectType = keywordStyle.effectId || keywordStyle.effect || 'zoom-in'; // 特效类型
                    let keywordFontSizeExpr = String(keywordFontSize);
                    let keywordAlphaExpr = '1'; // 默认完全不透明
                    let xExpr = '(w-text_w)/2'; // X坐标
                    let yExpr = '(h-text_h-20)'; // Y坐标

                    if (enableDynamicEffect) {
                        // 根据不同的特效类型生成不同的动画表达式
                        switch (effectType) {
                            case 'zoom-in':
                                // 缩放弹出：字体大小动态变化
                                const scaleFreq = keywordStyle.scaleFrequency || 15;
                                const scaleAmp = keywordStyle.scaleAmplitude || 3;
                                keywordFontSizeExpr = `${keywordFontSize} + sin(t*${scaleFreq})*${scaleAmp}`;
                                break;

                            case 'pulse':
                                // 脉冲跳动：透明度闪烁
                                const flashFreq = keywordStyle.flashFrequency || 20;
                                keywordAlphaExpr = `0.9 + sin(t*${flashFreq})*0.1`;
                                break;

                            case 'bounce':
                                // 弹跳反弹：Y坐标上下移动
                                const bounceFreq = keywordStyle.bounceFrequency || 8;
                                const bounceAmp = keywordStyle.bounceAmplitude || 30;
                                yExpr = `(h-text_h-20) + sin(t*${bounceFreq})*${bounceAmp}`;
                                break;

                            case 'glow':
                                // 发光闪烁：字体大小和透明度同时变化
                                const glowFreq = keywordStyle.glowFrequency || 12;
                                keywordFontSizeExpr = `${keywordFontSize} + sin(t*${glowFreq})*2`;
                                keywordAlphaExpr = `0.85 + sin(t*${glowFreq})*0.15`;
                                break;

                            case 'shake':
                                // 抖动震颤：X坐标左右摇晃
                                const shakeFreq = keywordStyle.shakeFrequency || 25;
                                const shakeAmp = keywordStyle.shakeAmplitude || 8;
                                xExpr = `(w-text_w)/2 + sin(t*${shakeFreq})*${shakeAmp}`;
                                break;

                            case 'slide-up':
                                // 底部滑入：Y坐标从下往上变化（使用cos实现一次性效果）
                                const slideStart = startTime;
                                const slideDuration = keywordStyle.slideDuration || 0.5;
                                const slideProgress = `min(1, (t-${slideStart})/${slideDuration})`;
                                yExpr = `(h-text_h-20) + (h-text_h) * (1 - ${slideProgress})`;
                                break;

                            case 'fade':
                                // 渐变高亮：透明度从低到高
                                const fadeStart = startTime;
                                const fadeDuration = keywordStyle.fadeDuration || 0.3;
                                const fadeProgress = `min(1, (t-${fadeStart})/${fadeDuration})`;
                                keywordAlphaExpr = `0.3 + ${fadeProgress} * 0.7`;
                                break;

                            case 'spin':
                                // 旋转转动：通过缩放比例的不同变化模拟旋转
                                const spinFreq = keywordStyle.spinFrequency || 8;
                                keywordFontSizeExpr = `${keywordFontSize} * (0.9 + 0.1 * sin(t*${spinFreq}))`;
                                break;

                            case 'wave':
                                // 彩虹波浪：使用组合效果
                                const waveFreq = keywordStyle.waveFrequency || 10;
                                const waveAmp = keywordStyle.waveAmplitude || 4;
                                keywordFontSizeExpr = `${keywordFontSize} + sin(t*${waveFreq})*${waveAmp}`;
                                yExpr = `(h-text_h-20) + sin(t*${waveFreq})*${waveAmp}`;
                                break;

                            case 'flip':
                                // 翻转效果：通过缩放X实现翻转
                                const flipFreq = keywordStyle.flipFrequency || 6;
                                keywordFontSizeExpr = `${keywordFontSize} * abs(sin(t*${flipFreq}*PI))`;
                                break;

                            default:
                                // 默认缩放特效
                                keywordFontSizeExpr = `${keywordFontSize} + sin(t*15)*3`;
                                break;
                        }
                    }

                    // 生成关键词 drawtext 过滤器
                    // 修复：FFmpeg不支持between()函数，使用gte()*lte()替代
                    let keywordFilter =
                        `drawtext=` +
                        `fontfile=${quotedFontPath}:` +
                        `textfile=${quotedKeywordTempPath}:` +
                        `fontsize='${keywordFontSizeExpr}':` +
                        `fontcolor=0x${keywordFontColor}:`;

                    if (hasKeywordBackgroundBox) {
                        keywordFilter +=
                            `box=1:` +
                            `boxcolor=0x${keywordBgColor}@${keywordBgOpacity}:` +
                            `boxborderw=${keywordStyle.borderWidth || 2}:`;
                    }

                    keywordFilter +=
                        `bordercolor=0x${(keywordStyle.borderColor || '#FF0000').replace('#', '').toUpperCase() || 'FF0000'}:` +
                        `alpha='${keywordAlphaExpr}':` +
                        `x='${xExpr}':` +
                        `y='${yExpr}':` +
                        `enable='gte(t\\,${startTime})*lte(t\\,${endTime})'`;

                    filters.push(keywordFilter);

                    // 记录被关键词占用的时间段和文字位置
                    const wordIndex = displayText.indexOf(keyword);
                    if (wordIndex >= 0) {
                        occupiedRanges.push({
                            start: startTime,
                            end: endTime,
                            keyword: keyword,
                            lineIndex: i,
                            wordIndex: wordIndex
                        });
                    }

                    Log.info(`generateDrawtextFilters.keywordEffect.${i}_${keyword}`, {
                        keyword: keyword,
                        start: startTime,
                        end: endTime,
                        fontColor: keywordFontColor,
                        backgroundColor: keywordBgColor,
                        bgOpacity: keywordBgOpacity,
                        enableDynamicEffect: enableDynamicEffect,
                        scaleFrequency: keywordStyle.scaleFrequency || 15,
                        scaleAmplitude: keywordStyle.scaleAmplitude || 3,
                        flashFrequency: keywordStyle.flashFrequency || 20,
                        occupiedWordIndex: wordIndex
                    });
                }
            }

            Log.info(`generateDrawtextFilters.filter${i + 1}`, {
                text: displayText.substring(0, 50),
                start: startTime,
                end: endTime,
                opacity: bgOpacity,
                hasKeyword: keywords && keywords.length > 0 && keywords.some(k => displayText.includes(k)),
                textFile: tempTextPath,
                fontPath: fontPath,
                fontName: fontName,
                fontFilePathFound: !!fontFilePath
            });
        }

        // 清理临时文本文件（在 FFmpeg 处理完成后）
        // 注意：这里我们保存文件路径列表，在后续的调用中清理
        if (tempTextFiles.length > 0) {
            // 延迟删除，等 FFmpeg 处理完毕
            setImmediate(() => {
                setTimeout(() => {
                    for (const file of tempTextFiles) {
                        try {
                            if (fs.existsSync(file)) {
                                fs.unlinkSync(file);
                            }
                        } catch (err) {
                            Log.error('Failed to clean temp text file:', { file, error: String(err) });
                        }
                    }
                }, 5000); // 等待 5 秒后清理
            });
        }

        const result = filters.join(',');
        Log.info("generateDrawtextFilters.complete", {
            filterCount: filters.length,
            totalLength: result.length,
            backgroundColor,
            bgOpacity,
            occupiedRangesCount: occupiedRanges.length
        });

        return {
            filters: result,
            occupiedRanges: occupiedRanges
        };
    } catch (error) {
        Log.error("generateDrawtextFilters.error", {
            error: String(error),
            assPath
        });
        return {
            filters: '',
            occupiedRanges: []
        };
    }
};

// 智能换行：优先在标点符号处换行
const smartLineBreak = (text: string, maxCharsPerLine: number): string[] => {
    const lines: string[] = [];
    const punctuations = ['，', '。', '！', '？', '；', '：', ',', '.', '!', '?', ';', ':'];
    const MAX_LINES = 2;  // ✅ 添加最多2行限制

    let currentLine = '';
    let pureTextLength = 0; // 纯文本长度（不包含ASS标签）
    let i = 0;

    while (i < text.length) {
        // ✅ 如果已经有2行，直接将剩余文本附加到最后一行，不再换行
        if (lines.length >= MAX_LINES) {
            currentLine += text[i];
            i++;
            continue;
        }

        if (text[i] === '{') {
            // 找到ASS标签的结尾
            const endBrace = text.indexOf('}', i);
            if (endBrace !== -1) {
                // 添加整个标签但不计算长度
                currentLine += text.substring(i, endBrace + 1);
                i = endBrace + 1;
                continue;
            }
        }

        // 普通字符
        currentLine += text[i];
        pureTextLength++;

        // 检查是否达到最大长度或遇到标点符号
        const isPunctuation = punctuations.includes(text[i]);
        const isNearMaxLength = pureTextLength >= maxCharsPerLine * 0.8; // 80%阈值

        if (isPunctuation && isNearMaxLength && lines.length < MAX_LINES - 1) {
            // ✅ 在标点符号处换行，但仅当还有空间时
            lines.push(currentLine.trim());
            currentLine = '';
            pureTextLength = 0;
        } else if (pureTextLength >= maxCharsPerLine && lines.length < MAX_LINES - 1) {
            // ✅ 强制换行，但仅当还有空间时
            lines.push(currentLine.trim());
            currentLine = '';
            pureTextLength = 0;
        }

        i++;
    }

    if (currentLine.trim()) {
        lines.push(currentLine.trim());
    }

    // ✅ 确保最多2行
    return lines.slice(0, MAX_LINES);
};

// 应用关键词特效
/**
 * 应用关键词特效 - 使用分段替换方法
 * 直接替换关键词并保留普通文本
 */
const applyKeywordEffects = (text: string, keywords: string[], keywordStyle: any): string => {
    if (!keywords || keywords.length === 0) {
        Log.info("applyKeywordEffects.skipped", { reason: "no keywords" });
        return text;
    }

    if (!text || text.trim() === '') {
        Log.info("applyKeywordEffects.skipped", { reason: "empty text" });
        return text;
    }

    const keywordFontSize = keywordStyle?.fontSize || 72;
    const keywordColor = hexToABGR(keywordStyle?.fontColor || '#FFD700');
    const keywordOutlineColor = keywordStyle?.outlineColor ? hexToABGR(keywordStyle.outlineColor) : hexToABGR('#000000');
    const keywordOutlineWidth = keywordStyle?.outlineWidth ?? 3;
    const keywordFontName = keywordStyle?.fontName || 'Microsoft YaHei Bold';

    let result = text;
    const processedKeywords: string[] = [];

    // 按长度从长到短排序关键词，避免短关键词被长关键词包含
    const sortedKeywords = [...keywords].sort((a, b) => b.length - a.length);

    for (const keyword of sortedKeywords) {
        if (!keyword || keyword.trim() === '') continue;

        // 创建正则表达式来匹配关键词（case-insensitive，但保留原始大小写）
        // 使用 \b 字边界确保不会匹配单词的一部分
        const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedKeyword}\\b`, 'gi');

        // 构建特效标签
        const startTag = `{\\fn${keywordFontName}\\fs${keywordFontSize}\\c${keywordColor}\\3c${keywordOutlineColor}\\4c${keywordOutlineColor}\\xbord${keywordOutlineWidth}\\ybord${keywordOutlineWidth}\\b1}`;
        const endTag = '{\\r}';

        // 替换关键词，保留非关键词文本
        const matchedCount = (result.match(regex) || []).length;
        if (matchedCount > 0) {
            result = result.replace(regex, `${startTag}$&${endTag}`);
            processedKeywords.push(`${keyword}(${matchedCount})`);
        }
    }

    Log.info("applyKeywordEffects.result", {
        inputText: text,
        outputText: result,
        totalKeywords: keywords.length,
        processedKeywords: processedKeywords,
        hasEffects: result !== text && result.includes('{\\\\')
    });

    return result;
};

/**
 * 应用多个关键词分组的特效
 * 支持同一文本中的多个分组，每个分组有独立的样式
 */
const applyKeywordGroupsEffects = (text: string, keywordGroups: any[]): string => {
    if (!keywordGroups || keywordGroups.length === 0) {
        return text;
    }

    // 提取纯文本（用于查找关键词位置）
    const pureText = text.replace(/\{[^}]*\}/g, '');

    if (!pureText || pureText.trim() === '') {
        return text;
    }

    // 用于追踪原始文本中的位置（跳过ASS标签）
    let resultParts: Array<{ type: 'text' | 'tag', content: string }> = [];
    let i = 0;

    // 分解原始文本，保留标签和纯文本
    while (i < text.length) {
        if (text[i] === '{') {
            // 查找ASS标签的结尾
            const endBrace = text.indexOf('}', i);
            if (endBrace !== -1) {
                resultParts.push({
                    type: 'tag',
                    content: text.substring(i, endBrace + 1)
                });
                i = endBrace + 1;
            } else {
                resultParts.push({
                    type: 'text',
                    content: text[i]
                });
                i++;
            }
        } else {
            resultParts.push({
                type: 'text',
                content: text[i]
            });
            i++;
        }
    }

    // 创建标记数组用于标记每个字符属于哪个分组
    const charGroupMap = new Map<number, { groupId: string, groupIndex: number }>();

    for (let groupIndex = 0; groupIndex < keywordGroups.length; groupIndex++) {
        const group = keywordGroups[groupIndex];
        const keywords = group.keywords || [];

        for (const keywordItem of keywords) {
            const keyword = typeof keywordItem === 'string' ? keywordItem : keywordItem.keyword;
            if (!keyword || keyword.trim() === '') continue;

            // 在纯文本中查找关键词（case-insensitive）
            let searchIndex = 0;
            while (true) {
                const pos = pureText.toLowerCase().indexOf(keyword.toLowerCase(), searchIndex);
                if (pos === -1) break;

                // 标记这个位置的所有字符属于该分组
                for (let j = 0; j < keyword.length; j++) {
                    charGroupMap.set(pos + j, {
                        groupId: group.id,
                        groupIndex: groupIndex
                    });
                }

                searchIndex = pos + 1;
            }
        }
    }

    // 重新组装文本：按分组应用不同的样式
    let finalResult = '';
    let purePos = 0;
    let currentGroupIndex = -1;

    for (const part of resultParts) {
        if (part.type === 'tag') {
            finalResult += part.content;
        } else {
            const char = part.content;
            const charGroupInfo = charGroupMap.get(purePos);

            if (charGroupInfo) {
                const group = keywordGroups[charGroupInfo.groupIndex];
                const style = group.styleOverride || {};

                // 需要应用样式
                if (charGroupInfo.groupIndex !== currentGroupIndex) {
                    // 从非关键词或不同分组切换到这个分组
                    if (currentGroupIndex !== -1) {
                        // 先重置之前的样式
                        finalResult += '{\\r}';
                    }

                    const fontSize = style.fontSize || 72;
                    const fontColor = hexToABGR(style.fontColor || '#FFD700');
                    const outlineColor = style.outlineColor ? hexToABGR(style.outlineColor) : hexToABGR('#000000');
                    const outlineWidth = style.outlineWidth ?? 3;
                    const fontName = style.fontName || 'Microsoft YaHei Bold';

                    finalResult += `{\\fn${fontName}\\fs${fontSize}\\c${fontColor}\\3c${outlineColor}\\4c${outlineColor}\\xbord${outlineWidth}\\ybord${outlineWidth}\\b1}`;
                    currentGroupIndex = charGroupInfo.groupIndex;
                }
            } else if (currentGroupIndex !== -1) {
                // 从关键词退出到普通文本
                finalResult += '{\\r}';
                currentGroupIndex = -1;
            }

            finalResult += char;
            purePos++;
        }
    }

    // 如果以关键词结尾，添加重置标签
    if (currentGroupIndex !== -1) {
        finalResult += '{\\r}';
    }

    return finalResult;
};

// 生成ASS格式字幕（支持关键词分组和多样式）
const generateAssSubtitleWithKeywordGroups = (
    asrRecords: any[],
    subtitleStyle: any,
    maxCharsPerLine: number = 18,
    keywordGroups?: any[]
): string => {
    // 首先使用基础样式生成字幕，然后应用关键词分组样式
    // 关键词分组中的样式会覆盖基础样式
    Log.info("generateAssSubtitleWithKeywordGroups", {
        groupCount: keywordGroups?.length || 0,
        groups: keywordGroups?.map((g: any) => ({
            id: g.id,
            name: g.name,
            keywordCount: g.keywords?.length || 0,
            effectId: g.effectId
        }))
    });

    // 使用现有的generateAssSubtitle函数生成基础字幕
    let assContent = generateAssSubtitle(asrRecords, subtitleStyle, maxCharsPerLine);

    if (!keywordGroups || keywordGroups.length === 0) {
        return assContent;
    }

    // 为每个关键词分组创建独立的样式行
    let styleSection = '';
    let dialogLines: string[] = [];

    // 提取现有的[V4+ Styles]部分
    const styleMatch = assContent.match(/\[V4\+ Styles\]([\s\S]*?)(?=\[Events\]|\Z)/);
    const eventsMatch = assContent.match(/\[Events\]([\s\S]*)/);

    if (styleMatch && eventsMatch) {
        styleSection = styleMatch[1];
        const eventsSection = eventsMatch[1];

        // 【关键修复】不在此函数中创建关键词分组的Style
        // 原因：这些Style永远不会被应用到Dialogue行（因为关键词被删除了）
        // 所有关键词特效由drawtext层单独处理
        // 详细日志记录关键词分组信息用于调试
        Log.info('generateAssSubtitleWithKeywordGroups.skipGroupStyleCreation', {
            groupCount: keywordGroups.length,
            reason: '关键词将由drawtext特效层处理，不在ASS中创建关键词分组Style',
            note: 'Style创建但不使用会造成混乱，已移除',
            groups: keywordGroups.map((g: any, i: number) => ({
                index: i,
                groupId: g.id,
                groupName: g.name,
                groupEffectId: g.effectId,
                hasStyleOverride: !!g.styleOverride
            }))
        });

        // 处理对话行，为关键词应用对应的样式（修复：直接赋值给dialogLines，不重新声明）
        const eventsLines = eventsSection.split('\n');

        // 保留Format行
        const formatLines = eventsLines.filter((line: string) => line.trim().startsWith('Format:'));
        if (formatLines.length > 0) {
            dialogLines.push(...formatLines);
        }

        // 关键修复：详细日志记录关键词处理
        Log.info('generateAssSubtitleWithKeywordGroups.processingDialogueLines', {
            totalEventLines: eventsLines.length,
            dialogueLineCount: eventsLines.filter((line: string) => line.trim().startsWith('Dialogue:')).length,
            keywordGroupsToProcess: keywordGroups.map((g: any) => ({
                groupId: g.id,
                groupName: g.name,
                keywordsInGroup: g.keywords?.map((kw: any) => typeof kw === 'string' ? kw : kw.keyword) || []
            }))
        });

        // 收集所有会被drawtext特效层处理的关键词
        const allEffectKeywords = new Set<string>();
        for (const group of keywordGroups) {
            if (!group.keywords) continue;
            for (const kw of group.keywords) {
                const keyword = typeof kw === 'string' ? kw : kw.keyword;
                if (keyword) {
                    allEffectKeywords.add(keyword);
                }
            }
        }

        // 处理所有Dialogue行
        // 【关键修复】从ASS字幕文本中移除关键词，避免与drawtext特效层重复显示
        // drawtext特效层已经从keywordGroups参数获取关键词，不再依赖ASS文本查找
        // 这样基础字幕只显示非关键词部分，关键词由特效层单独显示
        const dialogueLines = eventsLines
            .filter((line: string) => line.trim().startsWith('Dialogue:'))
            .map((line: string, lineIndex: number) => {
                // 解析Dialogue行，提取文本部分
                const dialogueParts = line.split(',');
                if (dialogueParts.length < 10) {
                    return line; // 格式错误，返回原行
                }

                const dialoguePrefix = dialogueParts.slice(0, 9).join(',') + ',';
                let dialogueText = dialogueParts.slice(9).join(','); // 文本部分可能包含逗号

                // 移除所有ASS标签，获取纯文本
                const textWithoutTags = dialogueText.replace(/\{[^}]*\}/g, '');

                // 检查是否包含会被特效层处理的关键词
                const keywordsInText: string[] = [];
                for (const keyword of allEffectKeywords) {
                    if (textWithoutTags.includes(keyword)) {
                        keywordsInText.push(keyword);
                    }
                }

                // 如果有关键词，从文本中移除它们（包括带内联样式的），避免重复显示
                if (keywordsInText.length > 0) {
                    let modifiedText = dialogueText;

                    // 按长度从长到短排序关键词，避免短关键词被长关键词包含
                    const sortedKeywords = [...keywordsInText].sort((a, b) => b.length - a.length);

                    for (const keyword of sortedKeywords) {
                        // 【关键修复】移除带内联样式的关键词
                        // 匹配格式：{\fn字体\c颜色}关键词{\r} 或 {\c颜色}关键词{\c} 等
                        // 1. 移除带完整内联样式的关键词
                        const inlineStyleWithKeywordRegex = new RegExp(
                            `\\{[^}]*\\}${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{[^}]*\\}`,
                            'gi'
                        );
                        modifiedText = modifiedText.replace(inlineStyleWithKeywordRegex, '');

                        // 2. 移除带开始标签的关键词：{\c颜色}关键词
                        const startTagRegex = new RegExp(
                            `\\{[^}]*\\}${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
                            'gi'
                        );
                        modifiedText = modifiedText.replace(startTagRegex, '');

                        // 3. 移除带结束标签的关键词：关键词{\c}
                        const endTagRegex = new RegExp(
                            `${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{[^}]*\\}`,
                            'gi'
                        );
                        modifiedText = modifiedText.replace(endTagRegex, '');

                        // 4. 最后移除纯关键词（没有标签的）
                        const textWithoutTags2 = modifiedText.replace(/\{[^}]*\}/g, '');
                        if (textWithoutTags2.includes(keyword)) {
                            const keywordRegex = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                            modifiedText = modifiedText.replace(keywordRegex, '');
                        }
                    }

                    // 清理孤立的ASS标签（标签内没有文本）
                    // 移除连续的标签，如 {\c} {\r} 等
                    modifiedText = modifiedText.replace(/\{\\[^}]*\}\s*\{\\[^}]*\}/g, '');
                    modifiedText = modifiedText.replace(/\{\\[^}]*\}\s+/g, '');
                    modifiedText = modifiedText.replace(/\s+\{\\[^}]*\}/g, '');

                    // 清理多余的空格和标点
                    modifiedText = modifiedText.replace(/\s+/g, ' ').trim();

                    // 如果移除关键词后文本为空，完全隐藏这一行字幕
                    const finalTextWithoutTags = modifiedText.replace(/\{[^}]*\}/g, '').trim();
                    if (!finalTextWithoutTags || finalTextWithoutTags.length === 0) {
                        Log.info('generateAssSubtitleWithKeywordGroups.hidingSubtitle', {
                            lineIndex,
                            keywords: keywordsInText,
                            reason: "移除关键词后文本为空，完全隐藏字幕行，关键词由特效层单独显示"
                        });
                        return ''; // 返回空行，后续会被过滤掉
                    }

                    dialogueText = modifiedText;

                    Log.info('generateAssSubtitleWithKeywordGroups.removedKeywords', {
                        lineIndex,
                        keywords: keywordsInText,
                        originalText: textWithoutTags.substring(0, 50),
                        newText: finalTextWithoutTags.substring(0, 50),
                        reason: "从ASS字幕中移除关键词（包括带内联样式的），由drawtext特效层单独显示"
                    });
                }

                return dialoguePrefix + dialogueText;
            })
            .filter((line: string) => line.trim().length > 0); // 过滤掉空行

        // 合并所有对话行
        dialogLines.push(...dialogueLines);

        // 最后日志：显示是否有任何关键词被应用
        Log.info('generateAssSubtitleWithKeywordGroups.summaryAfterProcessing', {
            totalDialogueLines: dialogueLines.length - formatLines.length,
            hasAnyKeywordApplication: dialogueLines.some(line => line.includes('{\\c'))
        });

        // 重新构建ASS内容
        const header = assContent.substring(0, assContent.indexOf('[V4+ Styles]'));
        const newContent = header + '[V4+ Styles]\n' + styleSection + '\n[Events]\n' + dialogLines.join('\n');

        return newContent;
    }

    return assContent;
};

// 生成ASS格式字幕的辅助函数（增强版：支持背景颜色、关键词特效、智能换行）
const generateAssSubtitle = (
    asrRecords: any[],
    subtitleStyle: any,
    maxCharsPerLine: number = 18,
    keywords?: string[],
    keywordStyle?: any
): string => {
    // 详细日志：记录接收到的样式参数
    Log.info("generateAssSubtitle.receivedStyle", {
        fullStyle: subtitleStyle,
        fontName: subtitleStyle?.fontName,
        backgroundColor: subtitleStyle?.backgroundColor,
        backgroundOpacity: subtitleStyle?.backgroundOpacity
    });

    // ===== 关键诊断：原始颜色值 =====
    Log.info("generateAssSubtitle.colorDiagnostics.原始值", {
        fontColor_原始: subtitleStyle?.fontColor,
        outlineColor_原始: subtitleStyle?.outlineColor,
        backgroundColor_原始: subtitleStyle?.backgroundColor,
        backgroundOpacity_原始: subtitleStyle?.backgroundOpacity,
        position_原始: subtitleStyle?.position
    });

    // 解析样式参数
    const fontSize = subtitleStyle?.fontSize || 48;
    const fontColor = subtitleStyle?.fontColor || '#FFFFFF';
    const outlineColor = subtitleStyle?.outlineColor || '#000000';
    const position = subtitleStyle?.position || 'bottom';

    // 修复：确保字体名称正确传递
    // 如果fontName是对象（如{value: \"xxx\", label: \"xxx\"}），提取value
    let fontName = subtitleStyle?.fontName || 'Microsoft YaHei Bold';
    if (typeof fontName === 'object' && fontName !== null) {
        // 处理对象格式：{value: \"...\", label: \"...\"}
        if (fontName.value) {
            fontName = fontName.value;
        } else if (fontName.label) {
            fontName = fontName.label;
        } else {
            // 如果对象没有value或label，尝试序列化或使用默认值
            fontName = 'Microsoft YaHei Bold';
            Log.error("generateAssSubtitle.invalidFontName", {
                received: subtitleStyle?.fontName,
                note: "字体名称是无效的对象格式，使用默认字体"
            });
        }
    }
    // 确保最终是字符串类型
    if (typeof fontName !== 'string') {
        fontName = String(fontName || 'Microsoft YaHei Bold');
    }
    fontName = fontName.trim() || 'Microsoft YaHei Bold';

    // ASS格式要求：如果字体名称包含逗号，需要用引号包裹
    // 但通常字体名称不会有逗号，所以这里先检查
    const fontNameForASS = fontName.includes(',') ? `"${fontName}"` : fontName;

    const backgroundColor = subtitleStyle?.backgroundColor || 'transparent';

    // 修复：确保背景透明度是0-1之间的数字
    let backgroundOpacity = subtitleStyle?.backgroundOpacity ?? 0;
    if (typeof backgroundOpacity === 'string') {
        // 如果是从本地存储读取的百分比格式，转换为0-1范围
        if (backgroundOpacity.endsWith('%')) {
            backgroundOpacity = parseFloat(backgroundOpacity) / 100;
        } else {
            backgroundOpacity = parseFloat(backgroundOpacity);
        }
    }
    // 确保是有效的数字且在0-1范围内
    if (isNaN(backgroundOpacity) || backgroundOpacity < 0) {
        backgroundOpacity = 0;
    } else if (backgroundOpacity > 1) {
        // 如果是百分比格式（0-100），转换为0-1
        if (backgroundOpacity <= 100) {
            backgroundOpacity = backgroundOpacity / 100;
        } else {
            backgroundOpacity = 1;
        }
    }

    // 详细日志：记录解析后的参数
    Log.info("generateAssSubtitle.parsedParams", {
        fontName,
        fontNameType: typeof fontName,
        originalFontName: subtitleStyle?.fontName,
        originalFontNameType: typeof subtitleStyle?.fontName,
        backgroundColor,
        backgroundOpacity,
        backgroundOpacityType: typeof backgroundOpacity,
        originalBackgroundOpacity: subtitleStyle?.backgroundOpacity,
        originalBackgroundOpacityType: typeof subtitleStyle?.backgroundOpacity,
        willUseBorderStyle3: (backgroundColor !== 'transparent' && backgroundOpacity > 0 && backgroundOpacity <= 1),
        backgroundValid: (backgroundColor !== 'transparent' && backgroundColor !== '' && backgroundOpacity > 0 && backgroundOpacity <= 1),
        hasValidBackground: (backgroundColor !== 'transparent' && backgroundColor !== '' && backgroundOpacity > 0 && backgroundOpacity <= 1)
    });

    // 检查是否有有效背景
    const hasValidBackground = (backgroundColor !== 'transparent' && backgroundColor !== '' && backgroundOpacity > 0 && backgroundOpacity <= 1);

    // 注意：ASS的BackColour参数不支持Alpha通道
    // 解决方案：使用颜色混合来模拟透明度效果
    // 混合颜色 = 用户选择的颜色 * 透明度 + 白色背景 * (1 - 透明度)
    // 这样能产生"变淡"效果而不是"变暗"，符合正常的透明度视觉效果
    let blendedBackgroundColor = backgroundColor;
    if (hasValidBackground && backgroundColor !== 'transparent' && backgroundOpacity < 1) {
        // 计算混合颜色，模拟透明度
        blendedBackgroundColor = blendColorForOpacity(backgroundColor, backgroundOpacity);
        Log.info("generateAssSubtitle.opacityBlending", {
            originalColor: backgroundColor,
            opacity: backgroundOpacity,
            blendedColor: blendedBackgroundColor,
            method: '颜色混合（ASS BackColour不支持Alpha）'
        });
    }

    // 转换颜色格式
    const primaryColor = hexToABGR(fontColor);
    const outlineColorASS = hexToABGR(outlineColor);
    // 修复：ASS BackColour只支持RGB格式（&HBBGGRR），不支持Alpha
    // 使用混合后的背景颜色（已考虑透明度）
    const backColorASS = hexToABGR(blendedBackgroundColor);  // 使用混合后的颜色，已模拟透明度

    // ===== 关键诊断：颜色转换后的值 =====
    Log.info("generateAssSubtitle.colorDiagnostics.转换后", {
        fontColor_输入: fontColor,
        fontColor_输出: primaryColor,
        outlineColor_输入: outlineColor,
        outlineColor_输出: outlineColorASS,
        backgroundColor_输入: backgroundColor,
        backgroundColor_混合后: blendedBackgroundColor,
        backgroundColor_输出: backColorASS,
        backgroundColor_16进制: blendedBackgroundColor ? blendedBackgroundColor.replace('#', '') : 'N/A',
        透明度模拟方式: '颜色混合而非Alpha通道'
    });

    // ===== 颜色值交换检测 =====
    // 如果发现颜色可能被交换了，在日志中标记
    const outlineHex = outlineColor.replace('#', '').toLowerCase();
    const backgroundHex = backgroundColor !== 'transparent' ? backgroundColor.replace('#', '').toLowerCase() : 'transparent';

    if (outlineHex && backgroundHex && outlineHex !== backgroundHex && backgroundHex !== 'transparent') {
        // 两个颜色都被设置且不相同，输出详细的颜色对比日志用于检查
        Log.info("generateAssSubtitle.colorDiagnostics.颜色对比", {
            outlineColor_hex: outlineHex,
            outlineColor_ABGR: outlineColorASS,
            backgroundColor_hex: backgroundHex,
            backgroundColor_ABGR: backColorASS,
            note: "如果这里显示的颜色对比与UI中选择的颜色不同，说明可能发生了颜色交换"
        });
    }

    // 确定对齐方式：2=底部，5=居中，8=顶部
    const alignment = position === 'top' ? 8 : position === 'center' ? 5 : 2;

    // 增加安全边距：左右120px，底部80px，防止字幕超出屏幕
    const marginL = 120;
    const marginR = 120;
    const marginV = 80;

    // 确定BorderStyle：如果有背景色且透明度大于0，使用3（不透明盒子），否则使用1（描边）
    // 注意：即使有背景色，如果透明度为0，也应该使用描边模式
    // hasValidBackground 已在上面声明，无需重复声明

    // 修复：正确处理outlineWidth和shadowOffset
    let outlineWidth = subtitleStyle?.outlineWidth ?? 3;
    let shadowOffset = subtitleStyle?.shadowOffset ?? 2;

    // 修复：根据是否有背景来选择 BorderStyle（优先显示背景）
    // BorderStyle=1: 描边模式 - 显示OutlineColour（文字描边），忽略BackColour
    // BorderStyle=3: 背景模式 - 显示BackColour（背景），忽略OutlineColour
    // ASS格式限制：不能同时显示描边和背景，必须择一
    // 优先级：背景 > 描边（如果两者都设置，显示背景）

    let finalBorderStyle = 1;
    let finalOutlineWidth = outlineWidth || 3;
    let finalShadowWidth = shadowOffset || 2;

    // 关键修复：当使用背景模式时，必须禁用描边以防止覆盖背景颜色
    let finalOutlineColorASS = outlineColorASS;

    if (hasValidBackground) {
        // 用户设置了背景，使用BorderStyle=3（背景模式），优先显示背景
        finalBorderStyle = 3;
        finalOutlineWidth = 1;   // BorderStyle=3 模式下，Outline=1 用于背景边框宽度
        finalShadowWidth = 0;    // BorderStyle=3 模式下禁用阴影
        // 关键修复：将 OutlineColour 设为与背景颜色相同，使边框也是相同颜色
        finalOutlineColorASS = backColorASS;  // 使用背景颜色作为轮廓色，确保边框和背景颜色一致
        Log.info("generateAssSubtitle.borderStyleAdjusted", {
            reason: "用户设置了背景，优先使用BackColour显示背景（禁用Outline防止覆盖）",
            finalBorderStyle: finalBorderStyle,
            finalOutlineWidth: finalOutlineWidth,
            finalShadowWidth: finalShadowWidth,
            backgroundColor_原始: backgroundColor,
            backgroundColor_混合后: blendedBackgroundColor,
            backgroundOpacity: backgroundOpacity,
            backColorASS: backColorASS,
            finalOutlineColorASS: finalOutlineColorASS,
            note: "BorderStyle=3(背景模式) - 显示BackColour作为背景，禁用Outline(=0)防止覆盖，背景色已通过混合处理透明度"
        });
    } else {
        // 没有背景，使用BorderStyle=1（描边模式），显示描边
        finalBorderStyle = 1;
        finalOutlineWidth = outlineWidth || 3;  // 描边宽度
        finalShadowWidth = 0;
        finalOutlineColorASS = outlineColorASS;  // 使用原始描边颜色
        Log.info("generateAssSubtitle.borderStyleAdjusted", {
            reason: "用户没有设置背景，使用BorderStyle=1显示描边",
            finalBorderStyle: finalBorderStyle,
            finalOutlineWidth: finalOutlineWidth,
            finalShadowWidth: finalShadowWidth,
            outlineColor: outlineColor,
            finalOutlineColorASS: finalOutlineColorASS,
            note: "BorderStyle=1(描边模式) - 显示OutlineColour作为描边，BackColour会被忽略"
        });
    }

    // 详细日志：记录最终的ASS样式参数
    Log.info("generateAssSubtitle.finalAssStyle", {
        fontName,
        fontNameForASS,
        fontSize,
        primaryColor,
        outlineColor: outlineColor,
        outlineColorASS,
        backgroundColor_原始: backgroundColor,
        backgroundColor_混合后: blendedBackgroundColor,
        backgroundOpacity: backgroundOpacity,
        backColorASS,  // 混合后的颜色转换为ASS格式
        finalBorderStyle,
        finalOutlineWidth,
        finalShadowWidth,
        alignment,
        透明度处理方式: `颜色混合（${backgroundColor} * ${backgroundOpacity} → ${blendedBackgroundColor}）`,
        renderMode: {
            borderStyle: finalBorderStyle,
            mode: finalBorderStyle === 3 ? 'BackgroundMode(BorderStyle=3)' : 'StrokeMode(BorderStyle=1)',
            displayContent: finalBorderStyle === 3 ? `背景(BackColour=${backColorASS}, 已混合透明度)` : `描边(OutlineColour=${outlineColorASS})`,
            note: `优先级：有背景→BorderStyle=3(显示背景，忽略描边) | 无背景→BorderStyle=1(显示描边)`
        }
    });

    // ASS样式参数说明
    // PrimaryColour = 文字颜色
    // OutlineColour = 文字描边颜色（仅在BorderStyle=1时显示）
    // BackColour = 背景颜色（仅在BorderStyle=3时显示）
    // BorderStyle = 1(描边模式) 或 3(背景模式)
    // 优先级：有背景→BorderStyle=3 | 无背景→BorderStyle=1

    // 生成样式行（使用 finalOutlineColorASS 防止描边覆盖背景）
    const styleLine = `Style: Default,${fontNameForASS},${fontSize},${primaryColor},&H000000FF,${finalOutlineColorASS},${backColorASS},1,0,0,0,100,100,0,0,${finalBorderStyle},${finalOutlineWidth},${finalShadowWidth},${alignment},${marginL},${marginR},${marginV},1`;
    Log.info("generateAssSubtitle.styleLine", {
        styleLine: styleLine,
        fontNameInStyle: fontNameForASS,
        primaryColorInStyle: primaryColor,        // 文字颜色
        outlineColorInStyle: finalOutlineColorASS,   // 实际使用的描边颜色（背景模式时为透明）
        originalOutlineColor: outlineColorASS,   // 原始描边颜色
        backColorInStyle: backColorASS,           // 背景颜色
        borderStyleInStyle: finalBorderStyle,     // 1=描边模式, 3=背景模式
        outlineWidthInStyle: finalOutlineWidth,   // 描边/背景边框宽度
        shadowWidthInStyle: finalShadowWidth,     // 阴影宽度
        mode: finalBorderStyle === 3 ? '背景模式(显示BackColour，OutlineColour已清除)' : '描边模式(显示OutlineColour)',
        note: `ASS格式限制：BorderStyle=${finalBorderStyle}(${finalBorderStyle === 3 ? '背景' : '描边'}模式) - 修复：背景模式时OutlineColour清除防止覆盖`
    });

    // ASS文件头部（使用 finalOutlineColorASS）
    let assContent = `[Script Info]\nTitle: Generated Subtitle\nScriptType: v4.00+\nWrapStyle: 0\nPlayResX: 1920\nPlayResY: 1080\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${fontNameForASS},${fontSize},${primaryColor},&H000000FF,${finalOutlineColorASS},${backColorASS},1,0,0,0,100,100,0,0,${finalBorderStyle},${finalOutlineWidth},${finalShadowWidth},${alignment},${marginL},${marginR},${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

    // 时间格式化函数：秒 -> H:MM:SS.CC
    const formatTime = (seconds: number): string => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const cs = Math.floor((seconds % 1) * 100);
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    };

    // 生成字幕事件（每个ASR记录独立处理，确保根据音频时间及时换行）
    for (const record of asrRecords) {
        let startTime = record.start || record.begin || 0;
        let endTime = record.end || startTime + 1;

        // 时间单位转换（毫秒->秒）
        if (startTime > 100) startTime = startTime / 1000;
        if (endTime > 100) endTime = endTime / 1000;

        let text = record.text || record.sentence || '';

        // **修复**：不在ASS字幕层应用关键词特效，避免与drawtext特效层重复显示
        // 关键词特效统一由drawtext特效层处理，这样可以：
        // 1. 支持用户设置的动画效果（ASS内联样式不支持动画）
        // 2. 避免关键词显示两次（ASS层一次 + drawtext层一次）
        // 3. 确保颜色和动画效果与用户设置一致
        // 备份原始文本（用于对比调试）
        const originalTextBeforeKeywordEffects = text;

        // 不再在ASS层应用关键词特效，由drawtext特效层统一处理
        // 这样每个关键词只会显示一次，且使用用户设置的动画效果
        if (keywords && keywords.length > 0) {
            Log.info("字幕处理.跳过ASS层关键词特效", {
                原因: "关键词特效由drawtext特效层统一处理，避免重复显示并支持动画效果",
                关键词数量: keywords.length,
                原始文本: originalTextBeforeKeywordEffects.substring(0, 50)
            });
        }

        // 去除标点符号（在应用关键词特效之后，这样特效位置对应原始文本）
        text = text.replace(/[，。！？；：、\"\"''（）《》【】…—·,.!?;:'\"()\\[\\]{}<>]/g, '');
        text = text.trim();

        if (!text) continue;

        // 智能换行：优先在标点符号处换行
        const lines = smartLineBreak(text, maxCharsPerLine);
        const displayText = lines.join('\\\\N');  // ASS使用\\N换行

        // 注意：不在这里加\\alpha标签，因为那会影响文字本身的透明度
        // 背景透明度在 BorderStyle=3 模式下无法直接实现
        // （因为ASS的BackColour参数不支持Alpha通道）
        // 如果需要背景透明效果，应该在前端选色时就处理（选择更淡的背景颜色）
        let finalDisplayText = displayText;

        assContent += `Dialogue: 0,${formatTime(startTime)},${formatTime(endTime)},Default,,0,0,0,,${finalDisplayText}\n`;
    }

    return assContent;
};

// 注册所有IPC handlers
const registerHandlers = () => {
    // 打开浏览器窗口并自动抓取数据
    ipcMain.handle("ipAgent:openBrowserWindow", async (event, params: { url: string }) => {
        try {
            const { url } = params;

            Log.info("ipAgent.openBrowserWindow", { url });

            // 关闭之前的窗口（如果存在）
            if (browserWindow && !browserWindow.isDestroyed()) {
                // 🔧 修复：使用 destroy() 强制销毁窗口，而不是 close()（close 会跳转到 about:blank）
                browserWindow.destroy();
                browserWindow = null;
            }

            // Create new browser window - 确保窗口可见并正确加载URL
            browserWindow = new BrowserWindow({
                width: 1200,
                height: 800,
                show: true,  // 🔧 修复：确保窗口显示
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    webSecurity: false,
                    sandbox: true,
                    // 禁用preload，避免dispatch_message错误
                    preload: undefined
                }
            });

            // 🔧 修复：添加页面加载错误监听
            browserWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
                Log.error("ipAgent.analyzeDouyinAccount.loadError", {
                    errorCode,
                    errorDescription,
                    validatedURL,
                    originalUrl: url
                });
                console.error(`页面加载失败: ${errorCode} - ${errorDescription} (URL: ${validatedURL})`);
            });

            // 🔧 修复：显示窗口后再加载URL，确保用户能看到加载过程
            browserWindow.show();

            // 验证URL格式
            let finalUrl = url.trim();
            if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
                finalUrl = 'https://' + finalUrl;
            }

            Log.info("ipAgent.analyzeDouyinAccount.loadingURL", { originalUrl: url, finalUrl });
            browserWindow.loadURL(finalUrl).catch((error) => {
                Log.error("ipAgent.analyzeDouyinAccount.loadURLError", { error, url: finalUrl });
                console.error(`加载URL失败: ${error.message}`);
            });

            // 监听页面加载完成事件
            return new Promise((resolve) => {
                if (!browserWindow) {
                    resolve({
                        success: false,
                        message: "Browser window creation failed"
                    });
                    return;
                }

                // 设置超时时间（30秒）
                const timeout = setTimeout(() => {
                    Log.info("ipAgent.openBrowserWindow.timeout", { url });
                    resolve({
                        success: false,
                        message: "页面加载超时，请检查网络连接或稍后重试"
                    });
                }, 30000);

                // 监听页面加载完成
                browserWindow.webContents.on("did-finish-load", async () => {
                    clearTimeout(timeout);

                    Log.info("ipAgent.openBrowserWindow.pageLoaded", { url });

                    // 等待5秒让页面完全渲染（抖音是动态加载的，需要更多时间）
                    await new Promise(r => setTimeout(r, 5000));

                    try {
                        // 自动执行抓取脚本
                        const script = `
                        (function() {
                            // 获取账号名称 - 多种尝试
                            let accountName = '';

                            // 尝试1: 查找包含nickname的元素
                            const nicknameEl = document.querySelector('[class*="nickname"], [class*="account"], h1');
                            if (nicknameEl) accountName = nicknameEl.textContent?.trim();

                            // 尝试2: 查找meta标签
                            if (!accountName) {
                                const metaEl = document.querySelector('meta[property="og:title"]');
                                if (metaEl) accountName = metaEl.getAttribute('content');
                            }

                            // 尝试3: 查找页面中较大的文本元素
                            if (!accountName) {
                                const allHeaders = document.querySelectorAll('h1, h2, .dy-name, [data-testid*="name"], [class*="userName"]');
                                for (let el of allHeaders) {
                                    const text = el.textContent?.trim();
                                    if (text && text.length > 2 && text.length < 30) {
                                        accountName = text;
                                        break;
                                    }
                                }
                            }

                            // 尝试4: 从页面title获取（去除杂染信息）
                            if (!accountName) {
                                const titleText = document.title;
                                const match = titleText.match(/(.+?)(?:的抖音|抖音号|-)/);
                                accountName = match ? match[1].trim() : titleText.split('-')[0]?.trim() || '';
                            }

                            // 获取视频列表（最新的6个）
                            const videoTitles = [];
                            const excludeWords = ['抖音号', 'IP属地', '获赞', '粉丝', '关注', '作品', '点赞', '评论', '分享', '收藏', '私信', '粉丝团', '加关注', '粉丝团主页', '最新作品', '合作推荐', '喜欢作者'];
                            const shouldExclude = (text) => {
                                if (!text) return true;
                                const hasExcludeWord = excludeWords.some(word => text.includes(word));
                                if (hasExcludeWord) return true;
                                if (text.length < 5 || text.length > 300) return true;
                                if (!/[\u4e00-\u9fa5a-zA-Z0-9]/g.test(text)) return true;
                                return false;
                            };

                            const allPTags = document.querySelectorAll('p, span, div');
                            allPTags.forEach((el) => {
                                const text = el.textContent?.trim();
                                if (text && text.includes('#') && !shouldExclude(text) && text.length > 10) {
                                    if (videoTitles.length < 6 && !videoTitles.includes(text)) {
                                        videoTitles.push(text);
                                    }
                                }
                            });

                            if (videoTitles.length < 3) {
                                const titleSelectors = ['[class*="title"]', '[class*="desc"]', '[class*="caption"]', '[data-testid*="title"]', '[class*="feed-item"]', '[class*="video-item"]', '.dy-video-title', '.aweme-detail', '[class*="aweme"]'];
                                titleSelectors.forEach(selector => {
                                    if (videoTitles.length >= 6) return;
                                    document.querySelectorAll(selector).forEach((el) => {
                                        if (videoTitles.length < 6) {
                                            const text = el.textContent?.trim();
                                            if (text && !shouldExclude(text) && text.length > 5) {
                                                if (!videoTitles.includes(text)) {
                                                    videoTitles.push(text);
                                                }
                                            }
                                        }
                                    });
                                });
                            }

                            return {
                                accountName,
                                videoTitles: videoTitles.slice(0, 6),
                                pageTitle: document.title,
                                pageUrl: window.location.href
                            };
                        })();
                    `;

                        const data = await browserWindow!.webContents.executeJavaScript(script);

                        Log.info("ipAgent.openBrowserWindow.scraped", {
                            accountName: data.accountName,
                            videoCount: data.videoTitles?.length || 0
                        });

                        // 🔧 修复：使用 destroy() 强制销毁窗口，而不是 close()（close 会跳转到 about:blank）
                        try {
                            if (browserWindow && !browserWindow.isDestroyed()) {
                                Log.info("ipAgent.analyzeDouyinAccount.destroyingBrowser", { url });
                                // 直接使用 destroy() 强制销毁窗口，避免跳转到 about:blank
                                browserWindow.destroy();
                                browserWindow = null;
                                Log.info("ipAgent.analyzeDouyinAccount.browserDestroyed", { message: "浏览器窗口已销毁" });
                            }
                        } catch (destroyError) {
                            Log.error("ipAgent.analyzeDouyinAccount.destroyBrowserError", destroyError);
                            browserWindow = null;
                        }

                        resolve({
                            success: true,
                            data
                        });

                    } catch (scrapeError) {
                        Log.error("ipAgent.openBrowserWindow.scrapeError", scrapeError);
                        resolve({
                            success: false,
                            message: "数据采集失败: " + (scrapeError?.message || scrapeError)
                        });
                    }
                });

                browserWindow.on("closed", () => {
                    clearTimeout(timeout);
                    browserWindow = null;
                });
            });

        } catch (error) {
            Log.error("ipAgent.openBrowserWindow.error", error);
            return {
                success: false,
                message: "打开浏览器失败: " + (error?.message || error)
            };
        }
    });

    // 分析抖音账号 - 使用与视频仿写相同的浏览器实例
    ipcMain.handle("ipAgent:analyzeDouyinAccount", async (event, params: { url: string }) => {
        try {
            const { url } = params;

            Log.info("ipAgent.analyzeDouyinAccount", { url });

            // 🔧 修复：尝试使用 publish 模块的浏览器上下文（与视频仿写共享）
            let externalBrowserContext: any = null;
            try {
                const { getBrowserContext } = await import('../publish/main');
                externalBrowserContext = await getBrowserContext('douyin');
                Log.info("ipAgent.analyzeDouyinAccount.browserContext", { message: "成功获取共享浏览器上下文" });
            } catch (error) {
                Log.info("ipAgent.analyzeDouyinAccount.browserContext", { message: "未获取到共享浏览器，将使用独立窗口", error: error instanceof Error ? error.message : String(error) });
            }

            // 如果获取到共享浏览器上下文，使用 Puppeteer/Playwright 方式
            if (externalBrowserContext) {
                try {
                    // 使用共享浏览器打开新页面
                    const page = await externalBrowserContext.newPage();
                    Log.info("ipAgent.analyzeDouyinAccount.pageCreated", { url });

                    // 🔧 修复：Playwright 不支持 networkidle2，使用 domcontentloaded 或 networkidle
                    try {
                        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    } catch (navigationError) {
                        Log.error("ipAgent.analyzeDouyinAccount.navigationError", {
                            url,
                            error: navigationError?.message
                        });
                        throw navigationError;
                    }

                    Log.info("ipAgent.analyzeDouyinAccount.pageLoaded", { url });

                    // 等待页面完全加载
                    await new Promise(r => setTimeout(r, 5000));

                    // 执行抓取脚本 - 简化版本，避免正则表达式解析错误
                    const script = `
                    (function() {
                        try {
                            // 获取账号名称 - 多种尝试
                            let accountName = '';

                            // 尝试1: 查找包含nickname的元素
                            const nicknameEl = document.querySelector('[class*="nickname"], [class*="account"], h1');
                            if (nicknameEl) accountName = nicknameEl.textContent?.trim();

                            // 尝试2: 查找meta标签
                            if (!accountName) {
                                const metaEl = document.querySelector('meta[property="og:title"]');
                                if (metaEl) accountName = metaEl.getAttribute('content');
                            }

                            // 尝试3: 查找页面中较大的文本元素
                            if (!accountName) {
                                const allHeaders = document.querySelectorAll('h1, h2, .dy-name, [data-testid*="name"], [class*="userName"]');
                                for (let el of allHeaders) {
                                    const text = el.textContent?.trim();
                                    if (text && text.length > 2 && text.length < 30) {
                                        accountName = text;
                                        break;
                                    }
                                }
                            }

                            // 尝试4: 从页面title获取
                            if (!accountName) {
                                const titleText = document.title;
                                // 简化版本：按'-'分割
                                const parts = titleText.split('-');
                                accountName = parts[0]?.trim() || titleText;
                            }

                            // 获取视频列表
                            const videoTitles = [];
                            const seenTexts = new Set();
                            const excludeWords = ['抖音号', 'IP属地', '获赞', '粉丝', '关注', '作品', '点赞', '评论', '分享', '收藏', '私信'];

                            const shouldExclude = (text) => {
                                if (!text || text.length < 5 || text.length > 300) return true;
                                return excludeWords.some(word => text.includes(word));
                            };

                            // 获取所有 p 标签中的文本
                            const allElements = document.querySelectorAll('p, span[class*="desc"], div[class*="title"]');
                            allElements.forEach((el) => {
                                if (videoTitles.length >= 6) return;
                                const text = el.textContent?.trim();
                                if (text && text.length > 10 && text.length < 500 && !shouldExclude(text) && !seenTexts.has(text)) {
                                    videoTitles.push(text);
                                    seenTexts.add(text);
                                }
                            });

                            // 清理标题：移除前导数字
                            const cleanTitles = videoTitles.map(title => {
                                return title.replace(/^\\d+\\s+/, '').trim();
                            }).filter(t => t && t.length > 5);

                            return {
                                accountName: accountName || '未知账号',
                                videoTitles: Array.from(new Set(cleanTitles)).slice(0, 6),
                                pageTitle: document.title,
                                pageUrl: window.location.href
                            };
                        } catch (err) {
                            return {
                                accountName: document.title?.split('-')[0] || '错误',
                                videoTitles: [],
                                pageTitle: document.title,
                                pageUrl: window.location.href,
                                error: err.message
                            };
                        }
                    })();
                `;

                    const data = await page.evaluate(script);
                    await page.close();

                    // 清理及关闭页面
                    try {
                        await page.close();
                    } catch (e) {
                        // 忽略关闭错误
                    }

                    Log.info("ipAgent.analyzeDouyinAccount.scraped", {
                        accountName: data.accountName,
                        videoCount: data.videoTitles?.length || 0
                    });

                    return {
                        success: true,
                        data
                    };

                } catch (scrapeError) {
                    Log.error("ipAgent.analyzeDouyinAccount.scrapeError", scrapeError);
                    return {
                        success: false,
                        message: "数据采集失败: " + (scrapeError?.message || scrapeError)
                    };
                }
            }

            // 关闭之前的窗口（如果存在）
            if (browserWindow && !browserWindow.isDestroyed()) {
                browserWindow.destroy();
                browserWindow = null;
            }

            // Create new browser window
            browserWindow = new BrowserWindow({
                width: 1200,
                height: 800,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    webSecurity: false,
                    sandbox: true,
                    // 禁用preload，避免dispatch_message错误
                    preload: undefined
                }
            });

            // 🔧 修复：阻止窗口关闭时跳转到 about:blank
            browserWindow.webContents.on('will-navigate', (event, navigationUrl) => {
                // 如果导航到 about:blank，阻止导航并直接销毁窗口
                if (navigationUrl === 'about:blank') {
                    event.preventDefault();
                    Log.info("ipAgent.analyzeDouyinAccount.preventAboutBlank", { url });
                    if (browserWindow && !browserWindow.isDestroyed()) {
                        browserWindow.destroy();
                        browserWindow = null;
                    }
                }
            });

            browserWindow.loadURL(url);

            // 监听页面加载完成事件
            return new Promise((resolve) => {
                if (!browserWindow) {
                    resolve({
                        success: false,
                        message: "Browser window creation failed"
                    });
                    return;
                }

                // 设置超时时间（30秒）
                const timeout = setTimeout(() => {
                    Log.info("ipAgent.analyzeDouyinAccount.timeout", { url });
                    if (browserWindow && !browserWindow.isDestroyed()) {
                        // 直接销毁窗口，不使用 close()
                        browserWindow.destroy();
                        browserWindow = null;
                    }
                    resolve({
                        success: false,
                        message: "页面加载超时，请检查网络连接或稍后重试"
                    });
                }, 30000);

                // 🔧 修复：添加一个标志，防止多次执行
                let isProcessing = false;

                // 监听页面加载完成
                browserWindow.webContents.on("did-finish-load", async () => {
                    // 防止重复执行
                    if (isProcessing) {
                        Log.warn("ipAgent.analyzeDouyinAccount.alreadyProcessing", { url });
                        return;
                    }
                    isProcessing = true;

                    clearTimeout(timeout);

                    Log.info("ipAgent.analyzeDouyinAccount.pageLoaded", { url });

                    // 等待5秒让页面完全渲染（抖音是动态加载的，需要更多时间）
                    await new Promise(r => setTimeout(r, 5000));

                    try {
                        // 自动执行抓取脚本 - 简化版本，避免正则表达式解析错误
                        const script = `
                        (function() {
                            try {
                                // 获取账号名称 - 多种尝试
                                let accountName = '';

                                // 尝试1: 查找包含nickname的元素
                                const nicknameEl = document.querySelector('[class*="nickname"], [class*="account"], h1');
                                if (nicknameEl) accountName = nicknameEl.textContent?.trim();

                                // 尝试2: 查找meta标签
                                if (!accountName) {
                                    const metaEl = document.querySelector('meta[property="og:title"]');
                                    if (metaEl) accountName = metaEl.getAttribute('content');
                                }

                                // 尝试3: 查找页面中较大的文本元素
                                if (!accountName) {
                                    const allHeaders = document.querySelectorAll('h1, h2, .dy-name, [data-testid*="name"], [class*="userName"]');
                                    for (let el of allHeaders) {
                                        const text = el.textContent?.trim();
                                        if (text && text.length > 2 && text.length < 30) {
                                            accountName = text;
                                            break;
                                        }
                                    }
                                }

                                // 尝试4: 从页面title获取
                                if (!accountName) {
                                    const titleText = document.title;
                                    // 简化版本：按'-'分割
                                    const parts = titleText.split('-');
                                    accountName = parts[0]?.trim() || titleText;
                                }

                                // 获取视频列表
                                const videoTitles = [];
                                const seenTexts = new Set();
                                const excludeWords = ['抖音号', 'IP属地', '获赞', '粉丝', '关注', '作品', '点赞', '评论', '分享', '收藏', '私信'];

                                const shouldExclude = (text) => {
                                    if (!text || text.length < 5 || text.length > 300) return true;
                                    return excludeWords.some(word => text.includes(word));
                                };

                                // 获取所有 p 和 span 标签中的文本
                                const allElements = document.querySelectorAll('p, span[class*="desc"], div[class*="title"]');
                                allElements.forEach((el) => {
                                    if (videoTitles.length >= 6) return;
                                    const text = el.textContent?.trim();
                                    if (text && text.length > 10 && text.length < 500 && !shouldExclude(text) && !seenTexts.has(text)) {
                                        videoTitles.push(text);
                                        seenTexts.add(text);
                                    }
                                });

                                // 清理标题：移除前导数字
                                const cleanTitles = videoTitles.map(title => {
                                    return title.replace(/^\\d+\\s+/, '').trim();
                                }).filter(t => t && t.length > 5);

                                return {
                                    accountName: accountName || '未知账号',
                                    videoTitles: Array.from(new Set(cleanTitles)).slice(0, 6),
                                    pageTitle: document.title,
                                    pageUrl: window.location.href
                                };
                            } catch (err) {
                                return {
                                    accountName: document.title?.split('-')[0] || '错误',
                                    videoTitles: [],
                                    pageTitle: document.title,
                                    pageUrl: window.location.href,
                                    error: err.message
                                };
                            }
                        })();
                    `;

                        const data = await browserWindow!.webContents.executeJavaScript(script);

                        Log.info("ipAgent.analyzeDouyinAccount.scraped", {
                            accountName: data.accountName,
                            videoCount: data.videoTitles?.length || 0
                        });

                        // 🔧 修复：强制关闭浏览器窗口（使用 destroy 直接销毁）
                        try {
                            if (browserWindow && !browserWindow.isDestroyed()) {
                                Log.info("ipAgent.analyzeDouyinAccount.destroyingBrowser", { url });
                                // 直接使用 destroy() 强制销毁窗口，避免跳转到 about:blank
                                browserWindow.destroy();
                                browserWindow = null;
                                Log.info("ipAgent.analyzeDouyinAccount.browserDestroyed", { message: "浏览器窗口已销毁" });
                            }
                        } catch (destroyError) {
                            Log.error("ipAgent.analyzeDouyinAccount.destroyBrowserError", destroyError);
                            browserWindow = null;
                        }

                        resolve({
                            success: true,
                            data
                        });

                    } catch (scrapeError) {
                        Log.error("ipAgent.analyzeDouyinAccount.scrapeError", scrapeError);
                        // 🔧 修复：确保错误时也强制销毁浏览器窗口
                        try {
                            if (browserWindow && !browserWindow.isDestroyed()) {
                                Log.info("ipAgent.analyzeDouyinAccount.destroyingBrowserOnError", { url });
                                browserWindow.destroy();
                                browserWindow = null;
                                Log.info("ipAgent.analyzeDouyinAccount.browserDestroyedOnError", { message: "错误时浏览器窗口已销毁" });
                            }
                        } catch (destroyError) {
                            Log.error("ipAgent.analyzeDouyinAccount.destroyBrowserOnErrorError", destroyError);
                            browserWindow = null;
                        }

                        resolve({
                            success: false,
                            message: "数据采集失败: " + (scrapeError?.message || scrapeError)
                        });
                    }
                });

                browserWindow.on("closed", () => {
                    clearTimeout(timeout);
                    browserWindow = null;
                });
            });

        } catch (error) {
            Log.error("ipAgent.analyzeDouyinAccount.error", error);

            // 🔧 修复：捕获异常时也要强制销毁浏览器窗口
            try {
                if (browserWindow && !browserWindow.isDestroyed()) {
                    Log.info("ipAgent.analyzeDouyinAccount.destroyingBrowserOnException", { url });
                    browserWindow.destroy();
                    browserWindow = null;
                    Log.info("ipAgent.analyzeDouyinAccount.browserDestroyedOnException", { message: "异常时浏览器窗口已销毁" });
                }
            } catch (destroyError) {
                Log.error("ipAgent.analyzeDouyinAccount.destroyBrowserOnExceptionError", destroyError);
                browserWindow = null;
            }

            return {
                success: false,
                message: "分析失败: " + (error?.message || error)
            };
        }
    });

    // 仿写标题 - 使用配置的文本模型
    ipcMain.handle("ipAgent:rewriteTitles", async (event, params: {
        titles: string[],
        accountName: string,
        modelConfig: { providerId: string, modelId: string, apiUrl: string, apiHost: string, apiKey: string, type: string },
        rewritePrompt: string
    }) => {
        try {
            const { titles, accountName, modelConfig, rewritePrompt } = params;

            Log.info("ipAgent.rewriteTitles", { accountName, titleCount: titles.length, modelConfig });

            if (!modelConfig || !modelConfig.providerId || !modelConfig.modelId) {
                return {
                    success: false,
                    message: "未配置文本模型，请先在设置中选择模型"
                };
            }

            const rewrittenTitles: string[] = [];

            // 构建提示词 - 一次性仿写所有标题
            const titlesText = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');

            // 使用用户自定义提示词,如果没有则使用默认提示词
            let prompt = rewritePrompt;
            if (!prompt || prompt.trim() === '') {
                prompt = `参考以下5个标题，帮我生成5个新的标题。要求：
1. 保持相似的主题和风格
2. 标题简洁有力
3. 不要添加表情符号和标签
4. 直接输出5个标题，每行一个，不要编号

参考标题：
${titlesText}

请生成5个新标题：`;
            } else {
                // 替换提示词中的变量
                prompt = prompt.replace(/\{\{content\}\}/g, titlesText);
                prompt = prompt.replace(/\{content\}/g, titlesText);
            }

            try {
                // 记录完整的API请求信息
                const requestPayload = {
                    model: modelConfig.modelId,
                    messages: [{ role: 'user', content: prompt }]
                };

                Log.info("ipAgent.rewriteTitles.REQUEST", {
                    apiUrl: modelConfig.apiUrl,
                    model: modelConfig.modelId,
                    promptLength: prompt.length,
                    titleCount: titles.length,
                    hasApiKey: !!modelConfig.apiKey
                });

                Log.info("ipAgent.rewriteTitles.REQUEST_FULL_PROMPT", prompt);
                Log.info("ipAgent.rewriteTitles.REQUEST_FULL_PAYLOAD", JSON.stringify(requestPayload, null, 2));

                // 调用文本模型API
                const response = await fetch(modelConfig.apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${modelConfig.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestPayload)
                });

                if (!response.ok) {
                    const error = await response.text();
                    Log.error("ipAgent.rewriteTitles.API_ERROR", {
                        status: response.status,
                        errorResponse: error
                    });
                    throw new Error(`API请求失败: ${response.status}\n${error}`);
                }

                const data = await response.json();
                const content = data.choices?.[0]?.message?.content;

                // 记录完整的API响应
                Log.info("ipAgent.rewriteTitles.RESPONSE_FULL", {
                    rawResponse: JSON.stringify(data, null, 2)
                });

                Log.info("ipAgent.rewriteTitles.RESPONSE_CONTENT", content);

                if (!content) {
                    Log.error("ipAgent.rewriteTitles.EMPTY_CONTENT", {
                        response: JSON.stringify(data, null, 2)
                    });
                    throw new Error('模型返回内容为空');
                }

                // 解析返回的标题（每行一个）
                const lines = content.trim().split('\n').filter(line => line.trim());

                // 清理可能的编号前缀（如"1. ", "1、", "- "等）
                const cleanedTitles = lines.map(line => {
                    return line.replace(/^[\d\s\.\-、]+/, '').trim();
                });

                // 确保返回的标题数量与输入一致
                if (cleanedTitles.length >= titles.length) {
                    rewrittenTitles.push(...cleanedTitles.slice(0, titles.length));
                } else {
                    // 如果返回的标题不够，用原标题填充
                    rewrittenTitles.push(...cleanedTitles);
                    for (let i = cleanedTitles.length; i < titles.length; i++) {
                        rewrittenTitles.push(titles[i]);
                    }
                }

                Log.info("ipAgent.rewriteTitles.success", {
                    originalCount: titles.length,
                    rewrittenCount: rewrittenTitles.length
                });

                AuthMain.reportGeneration('script', `仿写标题:${titles.length}→${rewrittenTitles.length}个`);

            } catch (e) {
                Log.error("ipAgent.rewriteTitles.api.error", e);
                // API调用失败时返回原标题
                return {
                    success: false,
                    message: "AI模型调用失败: " + (e?.message || e),
                    rewrittenTitles: titles
                };
            }

            return {
                success: true,
                rewrittenTitles
            };
        } catch (error) {
            Log.error("ipAgent.rewriteTitles.error", error);
            return {
                success: false,
                message: "仿写失败: " + (error?.message || error),
                rewrittenTitles: params.titles // 失败时返回原标题
            };
        }
    });

    // 保存设置
    ipcMain.handle("ipAgent:saveSettings", async (event, params: { settings: any }) => {
        try {
            const { settings } = params;

            Log.info("ipAgent.saveSettings", { settings });

            // 🔧 修复：设置未加载完成时的自动保存可能带着空的模型选择，
            // 不能用空值覆盖用户已选的模型
            try {
                const settingsFilePath = getSettingsFilePath();
                if (fs.existsSync(settingsFilePath)) {
                    const existing = JSON.parse(fs.readFileSync(settingsFilePath, 'utf-8'));
                    const modelKeys = ['textModelKey', 'voiceModelKey', 'asrModelKey', 'videoDigitalHumanModelKey'];
                    for (const key of modelKeys) {
                        if (!(typeof settings[key] === 'string' && settings[key].trim()) && existing[key]) {
                            settings[key] = existing[key];
                            Log.info("ipAgent.saveSettings.preserveModelKey", { key, value: existing[key] });
                        }
                    }
                }
            } catch (mergeError) {
                Log.warn("ipAgent.saveSettings.mergeGuardFailed", { error: mergeError });
            }

            ensureSettingsDir();

            const settingsFilePath = getSettingsFilePath();
            fs.writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2), 'utf-8');

            await ConfigMain.set('ipAgentSettings', JSON.stringify(settings));

            Log.info("ipAgent.saveSettings.success", { path: settingsFilePath });

            return {
                success: true
            };
        } catch (error) {
            Log.error("ipAgent.saveSettings.error", error);
            return {
                success: false,
                message: "保存设置失败: " + (error?.message || error)
            };
        }
    });

    // 获取设置
    ipcMain.handle("ipAgent:getSettings", async (event) => {
        try {
            Log.info("ipAgent.getSettings");

            const settingsFilePath = getSettingsFilePath();

            // 如果文件不存在，尝试加载并保存默认配置
            if (!fs.existsSync(settingsFilePath)) {
                Log.info("ipAgent.getSettings.notFound", { path: settingsFilePath });

                // 🆕 首次运行：尝试加载默认配置
                try {
                    // 获取默认配置文件路径（从打包资源中）
                    const defaultConfigPath = isDev
                        ? path.join(app.getAppPath(), 'electron', 'config', 'default-ipagent-config.json')
                        : path.join(process.resourcesPath, 'extra', 'common', 'config', 'default-ipagent-config.json');

                    if (fs.existsSync(defaultConfigPath)) {
                        Log.info("ipAgent.getSettings.loadDefaultConfig", { path: defaultConfigPath });

                        // 读取默认配置
                        const defaultContent = fs.readFileSync(defaultConfigPath, 'utf-8');
                        const defaultSettings = JSON.parse(defaultContent);

                        // 确保目录存在并保存到用户设置文件
                        ensureSettingsDir();
                        fs.writeFileSync(settingsFilePath, defaultContent, 'utf-8');

                        Log.info("ipAgent.getSettings.defaultConfigLoaded", {
                            savedTo: settingsFilePath,
                            hasSubtitleTemplates: !!defaultSettings.subtitleTemplates,
                            hasFrontendState: !!defaultSettings.frontendState
                        });

                        return {
                            success: true,
                            settings: defaultSettings,
                            isFirstRun: true
                        };
                    } else {
                        Log.warn("ipAgent.getSettings.defaultConfigNotFound", { path: defaultConfigPath });
                    }
                } catch (defaultError) {
                    Log.warn("ipAgent.getSettings.loadDefaultConfigError", defaultError);
                }

                // 如果没有默认配置或加载失败，返回null
                return {
                    success: true,
                    settings: null
                };
            }

            // 读取并解析JSON文件
            const content = fs.readFileSync(settingsFilePath, 'utf-8');
            const settings = JSON.parse(content);
            const normalized = normalizeIpAgentSettings(settings);

            if (normalized.changed) {
                ensureSettingsDir();
                fs.writeFileSync(settingsFilePath, JSON.stringify(normalized.settings, null, 2), 'utf-8');
                Log.info("ipAgent.getSettings.migratedTextModelKey", {
                    path: settingsFilePath,
                    textModelKey: normalized.settings.textModelKey
                });
            }

            Log.info("ipAgent.getSettings.success", { path: settingsFilePath });

            return {
                success: true,
                settings: normalized.settings
            };
        } catch (error) {
            Log.error("ipAgent.getSettings.error", error);
            return {
                success: false,
                message: "获取设置失败: " + (error?.message || error)
            };
        }
    });

    // 获取最近生成的结果文件
    ipcMain.handle("ipAgent:getResultFilesRecently", async (event, params: { type: 'audio' | 'video', limit?: number }) => {
        try {
            const { type, limit = 5 } = params;
            const outputDir = getOutputDir(type === 'audio' ? 'audio' : 'video');

            Log.info("ipAgent.getResultFilesRecently", { type, limit, outputDir });

            if (!fs.existsSync(outputDir)) {
                return [];
            }

            // 定义文件扩展名
            const extensions = type === 'audio'
                ? ['.mp3', '.wav', '.m4a', '.aac', '.ogg']
                : ['.mp4', '.mkv', '.avi', '.mov', '.webm'];

            // 获取目录下所有匹配的文件
            const allFiles: { path: string; mtime: number }[] = [];
            const scanDir = (dir: string) => {
                if (!fs.existsSync(dir)) return;
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        scanDir(fullPath);
                    } else if (extensions.some(ext => entry.name.toLowerCase().endsWith(ext))) {
                        const stats = fs.statSync(fullPath);
                        allFiles.push({ path: fullPath, mtime: stats.mtime.getTime() });
                    }
                }
            };
            scanDir(outputDir);
            const files = allFiles
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, limit)
                .map(f => f.path);

            Log.info("ipAgent.getResultFilesRecently.result", { count: files.length, files });

            return files;
        } catch (error) {
            Log.error("ipAgent.getResultFilesRecently.error", error);
            return [];
        }
    });

    // 生成文案 - 根据标题使用AI模型生成文案
    ipcMain.handle("ipAgent:generateScript", async (event, params: {
        title: string,
        count: number,
        modelConfig: { providerId: string, modelId: string, apiUrl: string, apiHost: string, apiKey: string, type: string },
        scriptPrompt: string
    }) => {
        try {
            const { title, count, modelConfig, scriptPrompt } = params;

            Log.info("ipAgent.generateScript", { title, count, modelConfig });

            if (!modelConfig || !modelConfig.providerId || !modelConfig.modelId) {
                return {
                    success: false,
                    message: "未配置文本模型，请先在设置中选择模型"
                };
            }

            // 使用用户自定义提示词，如果没有则使用默认提示词
            let prompt = scriptPrompt;
            if (!prompt || prompt.trim() === '') {
                prompt = `请根据以下标题，生成一篇约{count}字的短视频文案。要求：
1. 内容有趣、生动、吸引人
2. 适合短视频口播
3. 语言简洁易懂
4. 直接输出文案内容，不要其他说明

标题：{title}

请生成文案：`;
            }

            // 替换提示词中的变量
            prompt = prompt.replace(/\{title\}/g, title);
            prompt = prompt.replace(/\{\{title\}\}/g, title);
            prompt = prompt.replace(/\{count\}/g, count.toString());
            prompt = prompt.replace(/\{\{count\}\}/g, count.toString());

            try {
                // 记录完整的API请求信息
                const requestPayload = {
                    model: modelConfig.modelId,
                    messages: [{ role: 'user', content: prompt }]
                };

                Log.info("ipAgent.generateScript.REQUEST", {
                    apiUrl: modelConfig.apiUrl,
                    model: modelConfig.modelId,
                    promptLength: prompt.length,
                    hasApiKey: !!modelConfig.apiKey
                });

                Log.info("ipAgent.generateScript.REQUEST_FULL_PROMPT", prompt);
                Log.info("ipAgent.generateScript.REQUEST_FULL_PAYLOAD", JSON.stringify(requestPayload, null, 2));

                // 调用文本模型API
                const response = await fetch(modelConfig.apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${modelConfig.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestPayload)
                });

                if (!response.ok) {
                    const error = await response.text();
                    Log.error("ipAgent.generateScript.API_ERROR", {
                        status: response.status,
                        errorResponse: error
                    });
                    throw new Error(`API请求失败: ${response.status}\n${error}`);
                }

                const data = await response.json();
                const script = data.choices?.[0]?.message?.content;

                // 记录完整的API响应
                Log.info("ipAgent.generateScript.RESPONSE_FULL", {
                    rawResponse: JSON.stringify(data, null, 2)
                });

                Log.info("ipAgent.generateScript.RESPONSE_CONTENT", script);

                if (!script) {
                    Log.error("ipAgent.generateScript.EMPTY_CONTENT", {
                        response: JSON.stringify(data, null, 2)
                    });
                    throw new Error('模型返回内容为空');
                }

                Log.info("ipAgent.generateScript.success", {
                    titleLength: title.length,
                    scriptLength: script.length
                });

                AuthMain.reportGeneration('script', `标题:${title} 字数:${script.length}`);

                return {
                    success: true,
                    script: script.trim()
                };

            } catch (e) {
                Log.error("ipAgent.generateScript.api.error", e);
                return {
                    success: false,
                    message: "AI模型调用失败: " + (e?.message || e)
                };
            }
        } catch (error) {
            Log.error("ipAgent.generateScript.error", error);
            return {
                success: false,
                message: "生成文案失败: " + (error?.message || error)
            };
        }
    });

    // 生成标题标签关键词 - 根据文案生成
    ipcMain.handle("ipAgent:generateTitleTags", async (event, params: {
        content?: string,
        script?: string,
        modelConfig: { providerId: string, modelId: string, apiUrl: string, apiHost: string, apiKey: string, type: string },
        titleTagPrompt?: string,
        titleTagsPrompt?: string
    }) => {
        try {
            // 兼容前端传递的参数名称(content或script)
            const script = params.content || params.script;
            const titleTagsPrompt = params.titleTagPrompt || params.titleTagsPrompt;
            const { modelConfig } = params;

            Log.info("ipAgent.generateTitleTags", { scriptLength: script.length, modelConfig });

            if (!modelConfig || !modelConfig.providerId || !modelConfig.modelId) {
                return {
                    success: false,
                    message: "未配置文本模型，请先在设置中选择模型"
                };
            }

            // 使用用户自定义提示词，如果没有则使用默认提示词
            let prompt = titleTagsPrompt;
            if (!prompt || prompt.trim() === '') {
                prompt = `请根据以下文案内容，生成1个吸引人的标题、5-10个相关标签、4个分组关键词。

文案内容：
{content}

请严格按以下JSON格式输出，不要输出任何其他内容：
{"title":"标题内容","tags":["标签1","标签2","标签3"],"keywords":{"重点词/成语词":["词1","词2"],"描述词":["词1"],"行动词":["词1"],"情感词":["词1"]}}

要求：标题不要加书名号《》和引号，每个分组关键词只要0-2个词，标签和关键词不要带#号，不要在标签或关键词后面加括号说明（如"词（说明）"这种格式是禁止的），只输出纯词语，只输出JSON不要有其他文字。`;
            }

            // 替换提示词中的变量（先替换双花括号，再替换单花括号，避免{{content}}被{content}先匹配）
            prompt = prompt.replace(/\{\{content\}\}/g, script);
            prompt = prompt.replace(/\{content\}/g, script);

            try {
                // 记录完整的API请求信息
                const requestPayload = {
                    model: modelConfig.modelId,
                    messages: [{ role: 'user', content: prompt }]
                };

                Log.info("ipAgent.generateTitleTags.REQUEST", {
                    apiUrl: modelConfig.apiUrl,
                    model: modelConfig.modelId,
                    promptLength: prompt.length,
                    hasApiKey: !!modelConfig.apiKey
                });

                Log.info("ipAgent.generateTitleTags.REQUEST_FULL_PROMPT", prompt);
                Log.info("ipAgent.generateTitleTags.REQUEST_FULL_PAYLOAD", JSON.stringify(requestPayload, null, 2));

                // 调用文本模型API
                const response = await fetch(modelConfig.apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${modelConfig.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestPayload)
                });

                if (!response.ok) {
                    const error = await response.text();
                    Log.error("ipAgent.generateTitleTags.API_ERROR", {
                        status: response.status,
                        errorResponse: error
                    });
                    throw new Error(`API请求失败: ${response.status}\n${error}`);
                }

                const data = await response.json();
                const content = data.choices?.[0]?.message?.content;

                // 记录完整的API响应
                Log.info("ipAgent.generateTitleTags.RESPONSE_FULL", {
                    rawResponse: JSON.stringify(data, null, 2)
                });

                Log.info("ipAgent.generateTitleTags.RESPONSE_CONTENT", content);

                if (!content) {
                    Log.error("ipAgent.generateTitleTags.EMPTY_CONTENT", {
                        response: JSON.stringify(data, null, 2)
                    });
                    throw new Error('模型返回内容为空');
                }

                Log.info("ipAgent.generateTitleTags.rawContent", { content });

                // 尝试解析JSON格式的返回内容
                let title = '';
                let tags = '';
                let keywords = '';

                try {
                    // 清理可能的markdown代码块标记
                    let cleanedContent = content.trim();
                    cleanedContent = cleanedContent.replace(/```json\s*/gi, '');
                    cleanedContent = cleanedContent.replace(/```\s*/g, '');
                    cleanedContent = cleanedContent.trim();

                    // 替换中文引号为英文引号（只影响JSON结构，不影响字符串内容）
                    cleanedContent = cleanedContent.replace(/"/g, '"');
                    cleanedContent = cleanedContent.replace(/"/g, '"');
                    cleanedContent = cleanedContent.replace(/'/g, "'");
                    cleanedContent = cleanedContent.replace(/'/g, "'");
                    // 注意：不替换中文逗号，因为中文逗号可能出现在JSON字符串值内部

                    // 尝试提取JSON对象（如果有多余的文本）
                    const jsonMatch = cleanedContent.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        cleanedContent = jsonMatch[0];
                    }

                    Log.info("ipAgent.generateTitleTags.cleanedContent", { cleanedContent });

                    // 解析JSON
                    const parsed = JSON.parse(cleanedContent);
                    title = (parsed.title || '').replace(/[《》""'']/g, '').trim();
                    
                    // 清除标签和关键词中的括号说明（如"火锅（核心主题）"→"火锅"）
                    const stripParenthetical = (str: string): string => {
                        const result = str.replace(/[（(][^）)]*[）)]/g, '').trim();
                        return result || str.replace(/[（）()]/g, '').trim();
                    };
                    
                    // 保持数组格式，让前端自己处理，同时清除括号说明
                    if (Array.isArray(parsed.tags)) {
                        tags = parsed.tags.map((t: string) => stripParenthetical(String(t))).filter((t: string) => t);
                    } else if (typeof parsed.tags === 'string' && parsed.tags.trim()) {
                        // 字符串格式：替换中文逗号为英文逗号，统一分隔符
                        tags = stripParenthetical(parsed.tags.trim().replace(/，/g, ','));
                    } else {
                        tags = [];
                    }
                    
                    if (parsed.keywords && typeof parsed.keywords === 'object' && !Array.isArray(parsed.keywords)) {
                        // 清除分类关键词中的括号说明
                        const cleanedKeywords: {[key: string]: string[]} = {};
                        for (const [cat, words] of Object.entries(parsed.keywords)) {
                            if (Array.isArray(words)) {
                                cleanedKeywords[cat] = words.map((w: string) => stripParenthetical(String(w))).filter((w: string) => w && w.trim());
                            } else {
                                cleanedKeywords[cat] = [];
                            }
                        }
                        keywords = cleanedKeywords;
                    } else if (Array.isArray(parsed.keywords)) {
                        keywords = parsed.keywords.map((k: string) => stripParenthetical(String(k))).filter((k: string) => k && k.trim());
                    } else {
                        keywords = parsed.keywords || [];
                    }

                    Log.info("ipAgent.generateTitleTags.parsed", { title, tags, keywords });
                } catch (parseError) {
                    // 如果JSON解析失败，尝试传统的行分割方式
                    Log.info("ipAgent.generateTitleTags.jsonParseFailed", { error: parseError.message, content });

                    const lines = content.split('\n');
                    const categoryKeywords: {[key: string]: string[]} = {};
                    let currentCategory = '';
                    const categoryNames = ['重点词/成语词', '描述词', '行动词', '情感词'];
                    const titleCandidates: string[] = [];
                    // 清除括号说明
                    const stripParenthetical = (str: string): string => {
                        const result = str.replace(/[（(][^）)]*[）)]/g, '').trim();
                        return result || str.replace(/[（）()]/g, '').trim();
                    };

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (!trimmedLine) continue;

                        // 检查是否是分类关键词标题行
                        let foundCategory = false;
                        for (const catName of categoryNames) {
                            if (trimmedLine.includes(catName)) {
                                currentCategory = catName;
                                const afterColon = trimmedLine.split(/[：:]/).slice(1).join('：').trim();
                                if (afterColon) {
                                    const words = afterColon.split(/[,，、\s]+/).map((w: string) => stripParenthetical(w)).filter((w: string) => w.trim());
                                    if (!categoryKeywords[catName]) categoryKeywords[catName] = [];
                                    categoryKeywords[catName].push(...words);
                                }
                                foundCategory = true;
                                break;
                            }
                        }
                        if (foundCategory) continue;

                        // 分类下的关键词行
                        if (currentCategory) {
                            const words = trimmedLine.split(/[,，、\s]+/).map((w: string) => stripParenthetical(w)).filter((w: string) => w.trim());
                            if (words.length > 0 && !trimmedLine.includes('标题') && !trimmedLine.includes('标签') && !trimmedLine.includes('Title') && !trimmedLine.includes('Tags')) {
                                if (!categoryKeywords[currentCategory]) categoryKeywords[currentCategory] = [];
                                categoryKeywords[currentCategory].push(...words);
                            }
                        }

                        // 提取标题 - 支持多种格式
                        if (trimmedLine.match(/^标题[建议]?[：:]/)) {
                            // "标题：xxx" 或 "标题建议：xxx"
                            const titlePart = trimmedLine.split(/[：:]/).slice(1).join('：').trim();
                            if (titlePart && !title) title = titlePart;
                        } else if (trimmedLine.match(/^\d+[.、)\s]/)) {
                            // "1. 标题内容" 格式的标题候选
                            const candidate = trimmedLine.replace(/^\d+[.、)\s]+/, '').trim();
                            if (candidate && candidate.length > 2 && candidate.length < 100) {
                                titleCandidates.push(candidate);
                            }
                        }

                        // 提取标签 - 支持 # 标签行和 "标签：xxx" 格式
                        if ((trimmedLine.includes('标签') || trimmedLine.includes('Tags')) && !trimmedLine.includes('关键词')) {
                            const tagPart = trimmedLine.split(/[：:]/).slice(1).join('：').trim();
                            if (tagPart) tags = tagPart;
                        } else if (trimmedLine.match(/^#\S/) || trimmedLine.match(/#\S+/)) {
                            // "#标签1 #标签2" 格式
                            const hashTags = trimmedLine.match(/#(\S+)/g);
                            if (hashTags && hashTags.length > 0) {
                                tags = hashTags.map((t: string) => t.replace('#', '')).join(', ');
                            }
                        }

                        // 提取普通关键词（无分类时）
                        if ((trimmedLine.includes('关键词') || trimmedLine.includes('Keywords')) && !trimmedLine.includes('重点') && !trimmedLine.includes('描述') && !trimmedLine.includes('行动') && !trimmedLine.includes('情感')) {
                            const kwPart = trimmedLine.split(/[：:]/).slice(1).join('：').trim();
                            if (kwPart) keywords = kwPart;
                        }
                    }

                    // 如果没有提取到标题，使用第一个候选标题
                    if (!title && titleCandidates.length > 0) {
                        title = titleCandidates[0];
                    }

                    // 如果提取到了分类关键词，优先使用分类格式
                    const hasCategoryKeywords = Object.keys(categoryKeywords).length > 0;
                    if (hasCategoryKeywords) {
                        keywords = categoryKeywords;
                        Log.info("ipAgent.generateTitleTags.categoryKeywordsExtracted", { categoryKeywords });
                    }
                }

                // 如果解析后仍然为空，返回原始内容以供调试
                const hasTitle = title && String(title).trim().length > 0;
                const hasTags = tags && (Array.isArray(tags) ? tags.length > 0 : String(tags).trim().length > 0);
                const hasKeywords = keywords && (Array.isArray(keywords) ? keywords.length > 0 : (typeof keywords === 'object' ? Object.keys(keywords).some(k => Array.isArray(keywords[k]) && keywords[k].length > 0) : String(keywords).trim().length > 0));
                if (!hasTitle && !hasTags && !hasKeywords) {
                    Log.error("ipAgent.generateTitleTags.emptyResult", { content });
                    return {
                        success: false,
                        message: '解析结果为空，AI返回内容: ' + content
                    };
                }

                Log.info("ipAgent.generateTitleTags.success", {
                    title, tags, keywords
                });

                AuthMain.reportGeneration('script', `标题标签关键词:${title}`);

                return {
                    success: true,
                    titleTags: JSON.stringify({ title, tags, keywords }),
                    // 同时提供直接字段方便访问
                    title,
                    tags: Array.isArray(tags) ? tags.join(', ') : tags,
                    keywords: Array.isArray(keywords) ? keywords.join(', ') : keywords
                };

            } catch (e) {
                Log.error("ipAgent.generateTitleTags.api.error", e);
                return {
                    success: false,
                    message: "AI模型调用失败: " + (e?.message || e)
                };
            }
        } catch (error) {
            Log.error("ipAgent.generateTitleTags.error", error);
            return {
                success: false,
                message: "生成标题标签失败: " + (error?.message || error)
            };
        }
    });

    // 03视频编辑 - 自动处理(静音剪辑)
    ipcMain.handle("ipAgent:processSilenceDetection", async (event, params: {
        inputVideo: string,
        silenceThreshold?: number,
        silenceDuration?: number,
        minPauseDuration?: number
    }) => {
        try {
            // 🔧 改进：使用新的默认参数（用户已反馈-40dB, 1秒是最佳值）
            let { inputVideo, silenceThreshold = -40, silenceDuration = 1, minPauseDuration = 0.15 } = params;

            // 验证输入参数
            if (!inputVideo || typeof inputVideo !== 'string') {
                Log.error("ipAgent.processSilenceDetection.invalidInput", { inputVideo });
                return {
                    success: false,
                    message: "无效的视频路径"
                };
            }

            // 移除file://前缀
            inputVideo = inputVideo.replace(/^file:\/\//, '');

            // 验证文件是否存在
            if (!fs.existsSync(inputVideo)) {
                Log.error("ipAgent.processSilenceDetection.fileNotFound", { inputVideo });
                return {
                    success: false,
                    message: "视频文件不存在: " + inputVideo
                };
            }

            if (/[\u4e00-\u9fa5]/.test(inputVideo) || inputVideo.includes(' ')) {
                inputVideo = getShortPath(inputVideo);
            }

            Log.info("ipAgent.processSilenceDetection", {
                inputVideo,
                silenceThreshold,
                silenceDuration,
                minPauseDuration,
                message: "开始处理视频..."
            });

            const outputDir = getOutputDir('video');
            const timestamp = Date.now();
            const outputVideo = path.join(outputDir, `video_processed_${timestamp}.mp4`);

            // 🔧 改进的FFmpeg命令：silenceremove + adelay组合
            // 参数说明：
            // - stop_periods=-1: 删除所有停顿
            // - stop_duration=${silenceDuration}: 只删除超过此时长的沉默 ✓
            // - stop_threshold=${silenceThreshold}dB: 沉默阈值 ✓
            // - adelay=${minPauseDuration*1000}ms: 保留自然停顿 ✓
            const minPauseDurationMs = Math.round(minPauseDuration * 1000);
            const audioFilter = `silenceremove=stop_periods=-1:stop_duration=${silenceDuration}:stop_threshold=${silenceThreshold}dB,adelay=${minPauseDurationMs}ms|${minPauseDurationMs}ms`;

            const ffmpegArgs = [
                '-i',
                String(inputVideo),
                '-af',
                audioFilter,
                '-c:v',
                'copy',
                '-y',  // 覆盖已存在的文件
                String(outputVideo)
            ];

            // 打印详细日志以便调试
            Log.info("ipAgent.processSilenceDetection.command", {
                audioFilter,
                args: ffmpegArgs,
                description: `删除超过${silenceDuration}秒且音量低于${silenceThreshold}dB的停顿，保留${minPauseDurationMs}ms的自然停顿`
            });

            await execFFmpegCommand(ffmpegArgs);

            Log.info("ipAgent.processSilenceDetection.success", {
                outputVideo,
                message: "视频处理完成！已删除不必要的停顿。"
            });

            return {
                success: true,
                outputVideo,
                message: "视频处理完成！"
            };
        } catch (error) {
            Log.error("ipAgent.processSilenceDetection.error", error);
            return {
                success: false,
                message: "视频处理失败: " + (error?.message || error)
            };
        }
    });

    // 03视频编辑 - 绿幕替换（chromakey）
    ipcMain.handle("ipAgent:processGreenScreen", async (event, params: {
        inputVideo: string,
        backgroundImage: string,
        similarity?: number,
        blend?: number
    }) => {
        try {
            let { inputVideo, backgroundImage, similarity = 0.28, blend = 0.05 } = params;

            // 验证输入参数
            if (!inputVideo || typeof inputVideo !== 'string') {
                Log.error("ipAgent.processGreenScreen.invalidInput", { inputVideo });
                return { success: false, message: "无效的视频路径" };
            }
            if (!backgroundImage || typeof backgroundImage !== 'string') {
                Log.error("ipAgent.processGreenScreen.invalidBackground", { backgroundImage });
                return { success: false, message: "无效的背景图片路径" };
            }

            // 移除file://前缀
            inputVideo = inputVideo.replace(/^file:\/\//, '');
            backgroundImage = backgroundImage.replace(/^file:\/\//, '');

            // 验证文件是否存在
            if (!fs.existsSync(inputVideo)) {
                Log.error("ipAgent.processGreenScreen.videoNotFound", { inputVideo });
                return { success: false, message: "视频文件不存在: " + inputVideo };
            }
            if (!fs.existsSync(backgroundImage)) {
                Log.error("ipAgent.processGreenScreen.imageNotFound", { backgroundImage });
                return { success: false, message: "背景图片不存在: " + backgroundImage };
            }

            if (/[\u4e00-\u9fa5]/.test(inputVideo) || inputVideo.includes(' ')) {
                inputVideo = getShortPath(inputVideo);
            }
            if (/[\u4e00-\u9fa5]/.test(backgroundImage) || backgroundImage.includes(' ')) {
                backgroundImage = getShortPath(backgroundImage);
            }

            Log.info("ipAgent.processGreenScreen", {
                inputVideo,
                backgroundImage,
                similarity,
                blend,
                message: "开始绿幕替换处理..."
            });

            const outputDir = getOutputDir('video');
            const timestamp = Date.now();
            const outputVideo = path.join(outputDir, `video_greenscreen_${timestamp}.mp4`);

            // FFmpeg chromakey 绿幕替换：
            // 输入0: 绿幕视频, 输入1: 背景图片（-loop 1）
            // scale2ref: 把背景图[1:v]缩放到视频[0:v]的尺寸
            // chromakey: 去除视频中的绿色
            // overlay: 把去绿后的视频叠加到缩放后的背景上
            const filterComplex = [
                `[1:v][0:v]scale2ref=flags=lanczos[bg][vid]`,
                `[vid]format=yuva444p,chromakey=0x00FF00:0.28:0.05,chromakey=0x40FF40:0.12:0.15[fg]`,
                `[bg][fg]overlay=0:0:shortest=1,unsharp=3:3:0.5:3:3:0.5,format=yuv420p[out]`
            ].join(';');

            const ffmpegArgs = [
                '-i', String(inputVideo),          // 输入0：绿幕视频
                '-loop', '1',                      // 循环图片
                '-i', String(backgroundImage),     // 输入1：背景图片
                '-filter_complex', filterComplex,
                '-map', '[out]',
                '-map', '0:a?',                    // 保留原视频音频
                '-c:v', 'libx264',
                '-preset', 'medium',
                '-crf', '18',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-shortest',
                '-y',
                String(outputVideo)
            ];

            Log.info("ipAgent.processGreenScreen.command", {
                filterComplex,
                args: ffmpegArgs
            });

            await execFFmpegCommand(ffmpegArgs);

            Log.info("ipAgent.processGreenScreen.success", {
                outputVideo,
                message: "绿幕替换完成！"
            });

            return {
                success: true,
                outputVideo,
                message: "绿幕替换完成！"
            };
        } catch (error) {
            Log.error("ipAgent.processGreenScreen.error", error);
            return {
                success: false,
                message: "绿幕替换失败: " + (error?.message || error)
            };
        }
    });

    // 从视频提取音频（不使用缓存，每次都重新提取）
    ipcMain.handle("ipAgent:extractAudioFromVideo", async (event, params: { videoPath: string }) => {
        try {
            let { videoPath } = params;

            // 验证输入参数
            if (!videoPath || typeof videoPath !== 'string') {
                Log.error("ipAgent.extractAudioFromVideo.invalidInput", { videoPath });
                return {
                    success: false,
                    message: "无效的视频路径"
                };
            }

            // 移除file://前缀
            videoPath = videoPath.replace(/^file:\/\//, '');

            // 验证文件是否存在
            if (!fs.existsSync(videoPath)) {
                Log.error("ipAgent.extractAudioFromVideo.fileNotFound", { videoPath });
                return {
                    success: false,
                    message: "视频文件不存在: " + videoPath
                };
            }

            if (/[\u4e00-\u9fa5]/.test(videoPath) || videoPath.includes(' ')) {
                videoPath = getShortPath(videoPath);
            }

            Log.info("ipAgent.extractAudioFromVideo", {
                videoPath,
                note: "不使用缓存，每次都重新提取"
            });

            const outputDir = getOutputDir('audio');

            // 使用时间戳作为音频文件名，确保每次都生成新文件
            const timestamp = Date.now();
            const audioPath = path.join(outputDir, `audio_${timestamp}.wav`);

            Log.info("ipAgent.extractAudioFromVideo.extracting", { audioPath });

            // 提取音频为WAV格式
            const ffmpegArgs = [
                '-i', videoPath,
                '-vn',
                '-acodec', 'pcm_s16le',
                '-ar', '16000',
                '-ac', '1',
                audioPath
            ];

            await execFFmpegCommand(ffmpegArgs);

            Log.info("ipAgent.extractAudioFromVideo.success", {
                audioPath,
                timestamp,
                message: "音频提取完成（不使用缓存）"
            });

            return {
                success: true,
                audioPath,
                timestamp,
                cached: false,
                message: "音频提取完成"
            };
        } catch (error) {
            Log.error("ipAgent.extractAudioFromVideo.error", error);
            return {
                success: false,
                message: "提取音频失败: " + (error?.message || error)
            };
        }
    });

    // 增强版音频提取（不使用缓存，每次都重新提取）
    ipcMain.handle("ipAgent:extractAudioFromVideoEnhanced", async (event, params: {
        videoPath: string,
        format?: string,
        quality?: string,
        sampleRate?: string,
        outputPath?: string
    }) => {
        try {
            let { videoPath, format = 'wav', quality = '320', sampleRate = '44100', outputPath } = params;

            // 验证输入参数
            if (!videoPath || typeof videoPath !== 'string') {
                Log.error("ipAgent.extractAudioFromVideoEnhanced.invalidInput", { videoPath });
                return {
                    success: false,
                    message: "无效的视频路径"
                };
            }

            // 移除file://前缀
            videoPath = videoPath.replace(/^file:\/\//, '');

            // 验证文件是否存在
            if (!fs.existsSync(videoPath)) {
                Log.error("ipAgent.extractAudioFromVideoEnhanced.fileNotFound", { videoPath });
                return {
                    success: false,
                    message: "视频文件不存在: " + videoPath
                };
            }

            if (/[\u4e00-\u9fa5]/.test(videoPath) || videoPath.includes(' ')) {
                videoPath = getShortPath(videoPath);
            }

            Log.info("ipAgent.extractAudioFromVideoEnhanced", {
                videoPath,
                format,
                quality,
                sampleRate,
                note: "不使用缓存，每次都重新提取"
            });

            // 使用时间戳作为音频文件名，确保每次都生成新文件
            const timestamp = Date.now();
            let finalOutputPath: string;
            if (outputPath) {
                // 如果指定了输出路径，直接使用（不再添加额外时间戳）
                finalOutputPath = outputPath;
            } else {
                finalOutputPath = path.join(getOutputDir('audio'), `audio_enhanced_${timestamp}.${format}`);
            }

            Log.info("ipAgent.extractAudioFromVideoEnhanced.extracting", { audioPath: finalOutputPath });

            // 根据格式选择编码器和参数
            const ffmpegArgs = ['-i', videoPath, '-vn'];

            if (format === 'wav') {
                ffmpegArgs.push('-acodec', 'pcm_s16le');
            } else if (format === 'mp3') {
                ffmpegArgs.push('-acodec', 'libmp3lame', '-b:a', `${quality}k`);
            }

            ffmpegArgs.push('-ar', sampleRate, '-ac', '2', finalOutputPath);

            await execFFmpegCommand(ffmpegArgs);

            Log.info("ipAgent.extractAudioFromVideoEnhanced.success", {
                outputPath: finalOutputPath,
                timestamp,
                message: "音频提取完成（不使用缓存）"
            });

            return {
                success: true,
                audioPath: finalOutputPath,
                timestamp,
                cached: false,
                message: "音频提取完成"
            };
        } catch (error) {
            Log.error("ipAgent.extractAudioFromVideoEnhanced.error", error);
            return {
                success: false,
                message: "提取音频失败: " + (error?.message || error)
            };
        }
    });

    // 从ASR结果生成SRT文件（不使用缓存，每次都重新生成）
    // 注意：如果需要自定义样式，建议使用ASS格式
    ipcMain.handle("ipAgent:generateSrtFromAsrResult", async (event, params: {
        videoPath: string,
        asrRecords: any[],
        maxCharsPerLine?: number,
        audioPath?: string,
        timestamp?: number,
        originalScript?: string,
        subtitleStyle?: any,  // 添加样式参数
        keywords?: string[],  // 添加关键词参数
        keywordStyle?: any,   // 添加关键词样式参数
        keywordGroups?: any[],  // 添加关键词分组参数
        enableKeywordEffects?: boolean  // 是否启用关键词特效
    }) => {
        try {
            const { videoPath, asrRecords, maxCharsPerLine = 18, audioPath, timestamp, originalScript, subtitleStyle, keywords, keywordStyle, keywordGroups, enableKeywordEffects } = params;

            Log.info("ipAgent.generateSrtFromAsrResult", {
                videoPath,
                recordCount: asrRecords.length,
                maxCharsPerLine,
                hasOriginalScript: !!originalScript,
                hasSubtitleStyle: !!subtitleStyle,
                subtitleStyleDetails: subtitleStyle ? {
                    fontName: subtitleStyle.fontName,
                    fontNameType: typeof subtitleStyle.fontName,
                    backgroundColor: subtitleStyle.backgroundColor,
                    backgroundOpacity: subtitleStyle.backgroundOpacity,
                    backgroundOpacityType: typeof subtitleStyle.backgroundOpacity,
                    fontSize: subtitleStyle.fontSize,
                    fontColor: subtitleStyle.fontColor
                } : null,
                hasKeywords: !!(keywords && keywords.length > 0),
                keywordCount: keywords?.length || 0,
                hasKeywordGroups: !!(keywordGroups && keywordGroups.length > 0),
                keywordGroupCount: keywordGroups?.length || 0,
                enableKeywordEffects: enableKeywordEffects || false,
                note: "SRT字幕不使用缓存，每次都重新生成"
            });

            // 关键修复：详细记录接收到的keywordGroups
            if (keywordGroups && keywordGroups.length > 0) {
                Log.info("ipAgent.generateSrtFromAsrResult.keywordGroupsReceived", {
                    groupCount: keywordGroups.length,
                    groups: keywordGroups.map((g: any) => ({
                        id: g.id,
                        name: g.name,
                        keywordCount: g.keywords?.length || 0,
                        effectId: g.effectId,
                        hasStyleOverride: !!g.styleOverride,
                        styleOverride: g.styleOverride ? {
                            fontColor: g.styleOverride.fontColor,
                            outlineColor: g.styleOverride.outlineColor,
                            fontSize: g.styleOverride.fontSize,
                            fontName: g.styleOverride.fontName,
                            outlineWidth: g.styleOverride.outlineWidth
                        } : null
                    }))
                });
            }

            const outputDir = getOutputDir('subtitle');
            // 这样可以确保基础字幕样式修改后重新生成时能够生效
            const finalTimestamp = Date.now();

            // 如果提供了样式参数，生成ASS格式（样式更可靠）
            // 否则生成SRT格式
            const useAssFormat = !!subtitleStyle;
            const subtitlePath = path.join(outputDir, useAssFormat ? `subtitle_${finalTimestamp}.ass` : `subtitle_${finalTimestamp}.srt`);

            Log.info("ipAgent.generateSrtFromAsrResult.generating", {
                subtitlePath,
                format: useAssFormat ? 'ASS' : 'SRT',
                willApplyKeywordEffects: !!(keywords && keywords.length > 0 && keywordStyle)
            });

            if (useAssFormat) {
                // 生成ASS格式字幕（支持完整样式和关键词特效）
                // 如果启用了关键词特效，使用关键词分组信息；否则使用单一关键词样式
                const assContent = enableKeywordEffects && keywordGroups && keywordGroups.length > 0
                    ? generateAssSubtitleWithKeywordGroups(asrRecords, subtitleStyle, maxCharsPerLine, keywordGroups)
                    : generateAssSubtitle(asrRecords, subtitleStyle, maxCharsPerLine, keywords, keywordStyle);

                // 提取样式行用于详细检查
                const styleLineMatch = assContent.match(/Style:\s*Default,([^\n]+)/);
                const styleLine = styleLineMatch ? styleLineMatch[1] : 'NOT_FOUND';

                // 记录生成的ASS文件内容（前1000字符，用于调试）
                const previewContent = assContent.substring(0, 1000);

                // 解析样式行中的关键字段
                // 注意：styleLine 是去掉了 "Style: Default," 前缀的部分，所以：
                // 索引0=Fontname, 索引1=Fontsize, 索引6=BackColour, 索引14=BorderStyle
                const styleParts = styleLine.split(',');
                const extractedFontName = styleParts[0] || 'NOT_FOUND';
                // ASS格式字段顺序（去掉"Style: Default,"后）：
                // 0=Fontname, 1=Fontsize, 2=PrimaryColour, 3=SecondaryColour, 4=OutlineColour, 5=BackColour, ...
                const extractedBackColor = styleParts[5] || 'NOT_FOUND'; // BackColour是第6个字段（索引5）
                const extractedBorderStyle = styleParts[14] || 'NOT_FOUND'; // BorderStyle是第15个字段（索引14）

                // 验证解析结果
                let verifiedBackColor = extractedBackColor;
                if (extractedBackColor === 'NOT_FOUND' || extractedBackColor.length < 3 || !extractedBackColor.startsWith('&H')) {
                    // 如果解析失败，尝试直接从ASS内容中提取BackColour
                    const backColorMatch = assContent.match(/Style:\s*Default,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^,]+)/);
                    if (backColorMatch) {
                        verifiedBackColor = backColorMatch[1].trim();
                    }
                    Log.info("ipAgent.generateSrtFromAsrResult.styleParsingError", {
                        styleLine: styleLine,
                        stylePartsCount: styleParts.length,
                        extractedBackColor: extractedBackColor,
                        verifiedBackColor: verifiedBackColor,
                        allParts: styleParts.slice(0, 10).map((p, i) => `${i}:${p}`).join(', ')
                    });
                }

                Log.info("ipAgent.generateSrtFromAsrResult.assContent", {
                    preview: previewContent,
                    fullLength: assContent.length,
                    styleLine: styleLine,
                    extractedFontName: extractedFontName,
                    extractedBackColor: verifiedBackColor,
                    extractedBorderStyle: extractedBorderStyle,
                    expectedFontName: subtitleStyle?.fontName,
                    expectedBackgroundColor: subtitleStyle?.backgroundColor,
                    expectedBackgroundOpacity: subtitleStyle?.backgroundOpacity,
                    containsFontName: assContent.includes(String(subtitleStyle?.fontName || '')),
                    containsBackColor: assContent.includes('BackColour'),
                    containsBorderStyle: assContent.includes('BorderStyle')
                });

                fs.writeFileSync(subtitlePath, assContent, 'utf-8');

                // 额外保存一个调试版本的ASS文件（包含更多信息）
                if (isDev) {
                    const debugAssPath = subtitlePath.replace('.ass', '_debug.ass');
                    const debugContent = `[Debug Info]
Generated at: ${new Date().toISOString()}
Expected FontName: ${subtitleStyle?.fontName}
Expected BackgroundColor: ${subtitleStyle?.backgroundColor}
Expected BackgroundOpacity: ${subtitleStyle?.backgroundOpacity}
Actual FontName in Style: ${extractedFontName}
Actual BackColor in Style: ${verifiedBackColor}
Actual BorderStyle in Style: ${extractedBorderStyle}

${assContent}`;
                    try {
                        fs.writeFileSync(debugAssPath, debugContent, 'utf-8');
                        Log.info("ipAgent.generateSrtFromAsrResult.debugFile", { path: debugAssPath });
                    } catch (e) {
                        Log.info("ipAgent.generateSrtFromAsrResult.debugFileError", { error: e });
                    }
                }

                Log.info("ipAgent.generateSrtFromAsrResult.success", {
                    subtitlePath,
                    format: 'ASS',
                    timestamp: finalTimestamp,
                    keywordsApplied: !!(keywords && keywords.length > 0),
                    fontName: subtitleStyle?.fontName,
                    backgroundColor: subtitleStyle?.backgroundColor,
                    backgroundOpacity: subtitleStyle?.backgroundOpacity,
                    message: "ASS字幕文件生成完成（支持完整样式和关键词特效）"
                });

                return {
                    success: true,
                    srtPath: subtitlePath,  // 保持字段名兼容性
                    timestamp: finalTimestamp,
                    cached: false,
                    format: 'ASS',
                    message: "ASS字幕文件生成完成"
                };
            }

            // 生成SRT内容
            let srtContent = '';
            let index = 1;

            for (const record of asrRecords) {
                // ASR返回的时间可能是毫秒，需要转换为秒
                let startTime = record.start || record.begin || 0;
                let endTime = record.end || startTime + 1;

                // 检测时间单位：如果大于100，认为是毫秒（因为视频一般不会超过100秒才开始说话）
                // 更保守的阈值，避免误判
                if (startTime > 100) {
                    startTime = startTime / 1000;
                }
                if (endTime > 100) {
                    endTime = endTime / 1000;
                }

                // 记录日志以便调试
                if (index === 1) {
                    Log.info("ipAgent.generateSrtFromAsrResult.firstRecord", {
                        originalStart: record.start || record.begin,
                        originalEnd: record.end,
                        convertedStart: startTime,
                        convertedEnd: endTime
                    });
                }

                let text = record.text || record.sentence || '';

                // 如果提供了原始文案,尝试校正ASR识别结果
                if (originalScript && text) {
                    // 简单的文本匹配和替换逻辑
                    text = text.trim();
                }

                // 去除所有标点符号（中英文标点）
                text = text.replace(/[，。！？；：、""''（）《》【】…—·,.!?;:'"()\[\]{}<>]/g, '');
                text = text.trim();

                // 如果去除标点后文本为空，跳过这条记录
                if (!text) {
                    continue;
                }

                // 按maxCharsPerLine分割文本
                const lines = [];
                while (text.length > maxCharsPerLine) {
                    lines.push(text.substring(0, maxCharsPerLine));
                    text = text.substring(maxCharsPerLine);
                }
                if (text.length > 0) {
                    lines.push(text);
                }

                // 格式化时间（输入为秒）
                // SRT格式：HH:MM:SS,mmm（注意：毫秒用逗号分隔，不是冒号！）
                const formatTime = (seconds: number) => {
                    const h = Math.floor(seconds / 3600);
                    const m = Math.floor((seconds % 3600) / 60);
                    const s = Math.floor(seconds % 60);
                    const ms = Math.floor((seconds % 1) * 1000);
                    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
                };

                srtContent += `${index}\n`;
                srtContent += `${formatTime(startTime)} --> ${formatTime(endTime)}\n`;
                srtContent += lines.join('\n') + '\n\n';
                index++;
            }

            // 写入SRT文件
            fs.writeFileSync(subtitlePath, srtContent, 'utf-8');

            Log.info("ipAgent.generateSrtFromAsrResult.success", {
                subtitlePath,
                format: 'SRT',
                timestamp: finalTimestamp,
                message: "SRT字幕文件生成完成（不使用缓存）"
            });

            return {
                success: true,
                srtPath: subtitlePath,  // 保持字段名兼容性
                timestamp: finalTimestamp,
                cached: false,
                format: 'SRT',
                message: "SRT字幕文件生成完成"
            };
        } catch (error) {
            Log.error("ipAgent.generateSrtFromAsrResult.error", {
                error: error,
                errorMessage: error?.message,
                errorStack: error?.stack,
                errorString: String(error)
            });
            return {
                success: false,
                message: "生成字幕文件失败: " + (error?.message || String(error) || "未知错误")
            };
        }
    });

    // 添加字幕到视频
    ipcMain.handle("ipAgent:addSubtitleToVideo", async (event, params: {
        inputVideo: string,
        srtPath: string,
        subtitleStyle: any,
        highlightWords?: string[],
        keywordStyle?: any,
        keywords?: any[],
        keywordMarkers?: any[],
        keywordGroups?: any[],
        enableTopTitle?: boolean,
        topTitleStyle?: any,
        topTitleText?: string
    }) => {
        try {
            let {
                inputVideo,
                srtPath,
                subtitleStyle,
                highlightWords = [],
                keywordStyle,
                keywords = [],
                keywordMarkers = [],
                keywordGroups = [],
                enableTopTitle = false,
                topTitleStyle,
                topTitleText
            } = params;

            // 验证输入参数
            if (!inputVideo || typeof inputVideo !== 'string') {
                Log.error("ipAgent.addSubtitleToVideo.invalidInput", { inputVideo });
                return {
                    success: false,
                    message: "无效的视频路径"
                };
            }

            // 移除file://前缀
            inputVideo = inputVideo.replace(/^file:\/\//, '');

            // 验证文件是否存在
            if (!fs.existsSync(inputVideo)) {
                Log.error("ipAgent.addSubtitleToVideo.fileNotFound", { inputVideo });
                return {
                    success: false,
                    message: "视频文件不存在: " + inputVideo
                };
            }

            if (!srtPath || !fs.existsSync(srtPath)) {
                Log.error("ipAgent.addSubtitleToVideo.srtNotFound", { srtPath });
                return {
                    success: false,
                    message: "字幕文件不存在"
                };
            }

            if (/[\u4e00-\u9fa5]/.test(inputVideo) || inputVideo.includes(' ')) {
                inputVideo = getShortPath(inputVideo);
            }
            if (/[\u4e00-\u9fa5]/.test(srtPath) || srtPath.includes(' ')) {
                srtPath = getShortPath(srtPath);
            }

            Log.info("ipAgent.addSubtitleToVideo", {
                inputVideo,
                srtPath,
                subtitleStyle,
                highlightWords,
                keywordStyle,
                keywords: keywords.length,
                enableTopTitle,
                isAssFile: srtPath.endsWith('.ass')
            });

            const outputDir = getOutputDir('video');
            const timestamp = Date.now();
            const outputVideo = path.join(outputDir, `video_with_subtitle_${timestamp}.mp4`);

            // 检查是否是ASS文件（情感分析字幕）
            const isAssFile = srtPath.endsWith('.ass');

            let ffmpegArgs: string[];

            if (isAssFile) {
                // ASS文件：直接使用，不覆盖样式（保留情感分析特效）
                // 重要：必须重新编码视频，否则字幕不会显示
                Log.info("ipAgent.addSubtitleToVideo.usingAssFile", { srtPath });

                // 修复：从ASS文件中提取所有字体名称（不仅是Default样式），并确保字体文件可被FFmpeg访问
                let fontNames: string[] = [];
                try {
                    const assContent = fs.readFileSync(srtPath, 'utf-8');
                    // 提取所有Style定义中的字体名称
                    const styleRegex = /Style:\s*[^,]+,([^,]+)/g;
                    let match;
                    while ((match = styleRegex.exec(assContent)) !== null) {
                        let fontName = match[1].trim();
                        // 如果字体名称被引号包裹，去掉引号
                        fontName = fontName.replace(/^["']|["']$/g, '');
                        if (fontName && !fontNames.includes(fontName)) {
                            fontNames.push(fontName);
                        }
                    }
                    Log.info("ipAgent.addSubtitleToVideo.extractedAllFontNames", {
                        fontNames,
                        count: fontNames.length,
                        note: "从ASS文件中提取了所有Style定义中的字体名称"
                    });
                } catch (e) {
                    Log.info("ipAgent.addSubtitleToVideo.failedToReadAss", { error: String(e) });
                }

                // 如果找到了字体名称，尝试将字体文件复制到ASS文件所在目录
                // 这样FFmpeg可以找到字体文件（特别是ziti目录中的自定义字体）
                if (fontNames.length > 0) {
                    try {
                        const assDir = path.dirname(srtPath);
                        let zitiDir = '';
                        if (isDev) {
                            zitiDir = path.join(process.cwd(), 'ziti');
                        } else {
                            const installRoot = AppEnv.installRoot || AppEnv.appRoot || process.cwd();
                            const bundleZitiDir = path.join(installRoot, 'resources-bundles', 'ziti');
                            zitiDir = fs.existsSync(bundleZitiDir) ? bundleZitiDir : path.join(process.cwd(), 'ziti');
                        }
                        const fontExtensions = ['.ttf', '.otf', '.ttc', '.woff', '.woff2'];

                        // 为每个字体处理复制逻辑
                        for (const fontName of fontNames) {
                            let fontFound = false;

                            // 1. 优先查找ziti目录（支持精确匹配和模糊匹配）
                            if (fs.existsSync(zitiDir)) {
                                const files = fs.readdirSync(zitiDir);
                                const fontNameLower = fontName.toLowerCase().replace(/\s+/g, '');

                                for (const file of files) {
                                    const ext = path.extname(file).toLowerCase();
                                    if (!fontExtensions.includes(ext)) continue;

                                    const fileName = path.basename(file, ext);
                                    const fileNameLower = fileName.toLowerCase().replace(/\s+/g, '');

                                    // 精确匹配或模糊匹配（忽略大小写和空格）
                                    if (fileNameLower === fontNameLower || fileNameLower.includes(fontNameLower) || fontNameLower.includes(fileNameLower)) {
                                        const fontFilePath = path.join(zitiDir, file);
                                        const targetFontPath = path.join(assDir, file);

                                        // 如果字体文件不在ASS目录中，复制它
                                        if (!fs.existsSync(targetFontPath)) {
                                            fs.copyFileSync(fontFilePath, targetFontPath);
                                            Log.info("ipAgent.addSubtitleToVideo.fontCopiedFromZiti", {
                                                fontName,
                                                fileName,
                                                from: fontFilePath,
                                                to: targetFontPath
                                            });
                                        }
                                        fontFound = true;
                                        break;
                                    }
                                }
                            }

                            // 2. 如果ziti目录没找到，查找系统字体目录
                            if (!fontFound) {
                                const systemFontDirs = getSystemFontDirs();
                                for (const systemFontDir of systemFontDirs) {
                                    if (!fs.existsSync(systemFontDir)) continue;
                                    const files = fs.readdirSync(systemFontDir);
                                    for (const file of files) {
                                        const fileName = path.basename(file, path.extname(file));
                                        if (fileName.toLowerCase() === fontName.toLowerCase()) {
                                            const fontFilePath = path.join(systemFontDir, file);
                                            const targetFontPath = path.join(assDir, file);
                                            if (!fs.existsSync(targetFontPath)) {
                                                fs.copyFileSync(fontFilePath, targetFontPath);
                                                Log.info("ipAgent.addSubtitleToVideo.fontCopiedFromSystem", {
                                                    fontName,
                                                    from: fontFilePath,
                                                    to: targetFontPath
                                                });
                                            }
                                            fontFound = true;
                                            break;
                                        }
                                    }
                                    if (fontFound) break;
                                }
                            }

                            if (!fontFound) {
                                Log.info("ipAgent.addSubtitleToVideo.fontNotFound", {
                                    fontName,
                                    note: "字体文件未找到，FFmpeg可能无法正确渲染字体，将使用系统默认字体"
                                });
                            }
                        }
                    } catch (e) {
                        Log.error("ipAgent.addSubtitleToVideo.fontCopyError", {
                            error: String(e),
                            note: "字体复制过程中发生错误"
                        });
                    }
                }

                // 使用 drawtext 过滤器处理 ASS 文件（支持字体和特效）
                Log.info("ipAgent.addSubtitleToVideo.usingDrawtextFilter", {
                    reason: "使用 drawtext filter 处理 ASS 文件，支持字体描边和背景透明度"
                });

                const assDir = path.dirname(srtPath);
                const inputVideoAbsolute = path.isAbsolute(inputVideo) ? inputVideo : path.join(assDir, inputVideo);
                const outputVideoAbsolute = path.isAbsolute(outputVideo) ? outputVideo : path.join(assDir, outputVideo);

                // 生成 drawtext 过滤器
                const drawtextResult = generateDrawtextFilters(srtPath, subtitleStyle, keywords, keywordStyle, keywordGroups);
                const drawtextFilter = drawtextResult.filters;

                if (!drawtextFilter || drawtextFilter.length === 0) {
                    Log.error("ipAgent.addSubtitleToVideo.emptyDrawtextFilter", {
                        reason: "Failed to generate drawtext filters from ASS file"
                    });
                    return {
                        success: false,
                        message: "无法从 ASS 文件生成字幕过滤器"
                    };
                }

                ffmpegArgs = [
                    '-i', inputVideoAbsolute,
                    '-vf', drawtextFilter,
                    '-c:v', 'libx264',
                    '-preset', 'medium',
                    '-crf', '23',
                    '-c:a', 'copy',
                    '-y',
                    outputVideoAbsolute
                ];

                Log.info("ipAgent.addSubtitleToVideo.drawtextCommand", {
                    assPath: srtPath,
                    drawtextFilter: drawtextFilter.substring(0, 100) + (drawtextFilter.length > 100 ? '...' : ''),
                    reason: "使用 drawtext filter 生成过滤器链（支持背景透明度）"
                });

                try {
                    await execFFmpegCommand(ffmpegArgs);
                } catch (ffmpegError: any) {
                    Log.error("ipAgent.addSubtitleToVideo.ffmpegFailed", {
                        error: ffmpegError?.message || String(ffmpegError),
                        ffmpegArgs: ffmpegArgs,
                        cwd: assDir,
                        note: "FFmpeg 执行失败，可能是字体文件问题、视频格式问题或其他编码错误"
                    });
                    return {
                        success: false,
                        message: "视频处理失败：" + (ffmpegError?.message || "FFmpeg 执行失败")
                    };
                }

                // 检查输出文件是否存在
                if (!fs.existsSync(outputVideoAbsolute)) {
                    Log.error("ipAgent.addSubtitleToVideo.outputNotFound", { outputVideo: outputVideoAbsolute });
                    return {
                        success: false,
                        message: "视频文件生成失败"
                    };
                }

                Log.info("ipAgent.addSubtitleToVideo.success", {
                    outputVideo: outputVideoAbsolute,
                    inputVideo: inputVideoAbsolute,
                    srtPath
                });

                return {
                    success: true,
                    outputVideo: outputVideoAbsolute
                };
            } else {
                // SRT文件：应用自定义样式
                Log.info("ipAgent.addSubtitleToVideo.usingSrtFile", { srtPath, subtitleStyle });

                // 🔧 修复中文路径和空格：Windows路径处理
                // FFmpeg的subtitles滤镜需要特殊处理：
                // 1. 将反斜杠转为正斜杠（FFmpeg 可以正确处理）
                // 2. 转义冒号（C: -> C\\:）
                // 3. 转义单引号（如果路径中包含单引号）
                // 4. 空格不需要转义（因为整个路径会用单引号包裹）
                let srtPathForFilter = srtPath;
                if (process.platform === 'win32') {
                    // Windows 上：转换为正斜杠
                    srtPathForFilter = srtPathForFilter.replace(/\\/g, '/');
                    // 转义冒号
                    srtPathForFilter = srtPathForFilter.replace(/:/g, '\\:');
                    // 转义单引号（如果路径中包含单引号，需要转义为 '\''）
                    srtPathForFilter = srtPathForFilter.replace(/'/g, "'\\''");
                } else {
                    // Unix 系统：转义特殊字符
                    srtPathForFilter = srtPathForFilter.replace(/:/g, '\\:');
                    srtPathForFilter = srtPathForFilter.replace(/'/g, "'\\''");
                }

                Log.info("ipAgent.addSubtitleToVideo.pathConversion", {
                    originalPath: srtPath,
                    convertedPath: srtPathForFilter,
                    platform: process.platform,
                    hasSpace: srtPath.includes(' '),
                    hasChinese: /[\u4e00-\u9fa5]/.test(srtPath)
                });

                // 确定字幕对齐方式
                const alignment = subtitleStyle.position === 'top' ? 8 : subtitleStyle.position === 'center' ? 5 : 2;

                // 将RGB颜色转换为ASS格式的ABGR（FFmpeg的force_style要求）
                // FFmpeg force_style格式：&HAABBGGRR，其中AA是透明度（00=不透明，FF=透明）
                const hexToABGR = (hex: string) => {
                    if (!hex || typeof hex !== 'string') {
                        Log.info("ipAgent.addSubtitleToVideo.invalidColor", { hex, message: "使用默认白色" });
                        return '&H00FFFFFF'; // 默认白色
                    }

                    const rgb = hex.replace('#', '').toUpperCase();
                    if (rgb.length === 6) {
                        const r = rgb.substring(0, 2);
                        const g = rgb.substring(2, 4);
                        const b = rgb.substring(4, 6);
                        // 返回完整的ASS颜色格式：&H + AA(透明度) + BB + GG + RR
                        return `&H00${b}${g}${r}`; // 00=不透明 + BGR
                    }
                    Log.info("ipAgent.addSubtitleToVideo.invalidColorLength", { hex, rgb, message: "使用默认白色" });
                    return '&H00FFFFFF'; // 默认白色
                };

                // 转换颜色
                const fontColor = hexToABGR(subtitleStyle.fontColor || '#FFFFFF');
                const outlineColor = hexToABGR(subtitleStyle.outlineColor || '#000000');

                // 构建样式字符串 - 注意：不要在样式字符串中使用单引号，会与外层冲突
                // 使用逗号分隔，不使用空格
                const fontSize = subtitleStyle.fontSize || 48;
                const outlineWidth = subtitleStyle.outlineWidth || 3;

                // 确保字体名称是字符串
                let fontName = subtitleStyle.fontName || 'Microsoft YaHei Bold';
                if (typeof fontName === 'object' && fontName !== null) {
                    fontName = fontName.value || fontName.label || 'Microsoft YaHei Bold';
                } else if (typeof fontName !== 'string') {
                    fontName = String(fontName || 'Microsoft YaHei Bold');
                }
                fontName = fontName.trim() || 'Microsoft YaHei Bold';

                // 确保背景透明度是0-1范围的数字
                let backgroundOpacity = subtitleStyle.backgroundOpacity ?? 0;
                if (typeof backgroundOpacity === 'string') {
                    if (backgroundOpacity.endsWith('%')) {
                        backgroundOpacity = parseFloat(backgroundOpacity) / 100;
                    } else {
                        backgroundOpacity = parseFloat(backgroundOpacity);
                    }
                }
                if (isNaN(backgroundOpacity) || backgroundOpacity < 0) {
                    backgroundOpacity = 0;
                } else if (backgroundOpacity > 1) {
                    if (backgroundOpacity <= 100) {
                        backgroundOpacity = backgroundOpacity / 100;
                    } else {
                        backgroundOpacity = 1;
                    }
                }

                // 构建样式字符串 - 使用单引号包裹整个force_style值
                let styleStr = `FontName=${fontName},FontSize=${fontSize},PrimaryColour=${fontColor},OutlineColour=${outlineColor},Outline=${outlineWidth},Alignment=${alignment}`;

                // 如果有背景色且透明度大于0，添加背景色和BorderStyle
                const backgroundColor = subtitleStyle.backgroundColor || 'transparent';
                if (backgroundColor !== 'transparent' && backgroundColor !== '' && backgroundOpacity > 0 && backgroundOpacity <= 1) {
                    // 计算背景颜色的ASS格式
                    const bgHex = backgroundColor.replace('#', '').toUpperCase();
                    if (bgHex.length === 6) {
                        const r = bgHex.substring(0, 2);
                        const g = bgHex.substring(2, 4);
                        const b = bgHex.substring(4, 6);
                        // ASS格式：Alpha值（00=不透明，FF=完全透明）
                        const alpha = Math.round((1 - backgroundOpacity) * 255);
                        const alphaHex = alpha.toString(16).padStart(2, '0').toUpperCase();
                        // ASS格式：&HAABBGGRR
                        const backColor = `&H${alphaHex}${b}${g}${r}`;
                        styleStr += `,BackColour=${backColor},BorderStyle=3`;
                    }
                }

                Log.info("ipAgent.addSubtitleToVideo.styleConfig", {
                    originalPath: srtPath,
                    convertedPath: srtPathForFilter,
                    fontName: fontName,
                    originalFontColor: subtitleStyle.fontColor,
                    convertedFontColor: fontColor,
                    originalOutlineColor: subtitleStyle.outlineColor,
                    convertedOutlineColor: outlineColor,
                    fontSize,
                    outlineWidth,
                    alignment,
                    position: subtitleStyle.position,
                    backgroundColor: subtitleStyle.backgroundColor,
                    backgroundOpacity: backgroundOpacity,
                    styleStr
                });

                // 重要：SRT字幕需要重新编码视频才能应用自定义样式
                // 使用subtitles滤镜 + 重新编码
                // 关键修复：
                // 1. 路径用单引号包裹（避免空格和特殊字符问题）
                // 2. 冒号必须转义（C: -> C\\:）
                // 3. force_style也用单引号包裹（避免&符号被shell解释）
                const vfFilter = `subtitles='${srtPathForFilter}':force_style='${styleStr}'`;

                Log.info("ipAgent.addSubtitleToVideo.ffmpegFilter", { vfFilter });

                ffmpegArgs = [
                    '-i', inputVideo,
                    '-vf', vfFilter,
                    '-c:v', 'libx264',  // 重新编码视频
                    '-preset', 'medium',  // 编码速度预设
                    '-crf', '23',  // 质量控制
                    '-c:a', 'copy',  // 音频直接复制
                    '-y',  // 覆盖已存在的文件
                    outputVideo
                ];

                Log.info("ipAgent.addSubtitleToVideo.ffmpegCommand", {
                    args: ffmpegArgs.join(' ')
                });
            }

            try {
                await execFFmpegCommand(ffmpegArgs);
            } catch (ffmpegError) {
                Log.error("ipAgent.addSubtitleToVideo.ffmpegError", {
                    message: ffmpegError?.message || String(ffmpegError),
                    stack: ffmpegError?.stack,
                    args: ffmpegArgs.join(' '),
                    inputVideo,
                    srtPath,
                    outputVideo
                });
                throw ffmpegError;
            }

            Log.info("ipAgent.addSubtitleToVideo.success", { outputVideo });

            return {
                success: true,
                outputVideo
            };
        } catch (error) {
            Log.error("ipAgent.addSubtitleToVideo.error", {
                message: error?.message || String(error),
                stack: error?.stack
            });
            return {
                success: false,
                message: "添加字幕失败: " + (error?.message || String(error) || "未知错误")
            };
        }
    });

    // 添加BGM到视频
    ipcMain.handle("ipAgent:addBGMToVideo", async (event, params: {
        inputVideo: string,
        bgmPath: string,
        bgmVolume?: number
    }) => {
        try {
            let { inputVideo, bgmPath, bgmVolume = 30 } = params;

            // 验证输入参数
            if (!inputVideo || typeof inputVideo !== 'string') {
                Log.error("ipAgent.addBGMToVideo.invalidInput", { inputVideo });
                return {
                    success: false,
                    message: "无效的视频路径"
                };
            }

            // 移除file://前缀
            inputVideo = inputVideo.replace(/^file:\/\//, '');

            // 验证文件是否存在
            if (!fs.existsSync(inputVideo)) {
                Log.error("ipAgent.addBGMToVideo.fileNotFound", { inputVideo });
                return {
                    success: false,
                    message: "视频文件不存在: " + inputVideo
                };
            }

            if (!bgmPath || !fs.existsSync(bgmPath)) {
                Log.error("ipAgent.addBGMToVideo.bgmNotFound", { bgmPath });
                return {
                    success: false,
                    message: "BGM文件不存在"
                };
            }

            Log.info("ipAgent.addBGMToVideo", { inputVideo, bgmPath, bgmVolume });

            const outputDir = getOutputDir('video');
            const timestamp = Date.now();
            const outputVideo = path.join(outputDir, `video_with_bgm_${timestamp}.mp4`);

            // 计算音量比例(0-100转换为0-1)
            const volumeRatio = bgmVolume / 100;

            // FFmpeg命令:混合视频原声和BGM
            const ffmpegArgs = [
                '-i', inputVideo,
                '-stream_loop', '-1',
                '-i', bgmPath,
                '-filter_complex', `[0:a]volume=1.0[a0];[1:a]volume=${volumeRatio}[a1];[a0][a1]amix=inputs=2:duration=first`,
                '-c:v', 'copy',
                '-shortest',
                outputVideo
            ];

            await execFFmpegCommand(ffmpegArgs);

            Log.info("ipAgent.addBGMToVideo.success", { outputVideo, outputDir });

            return {
                success: true,
                outputVideo,
                outputDir
            };
        } catch (error) {
            Log.error("ipAgent.addBGMToVideo.error", error);
            return {
                success: false,
                message: "添加BGM失败: " + (error?.message || error)
            };
        }
    });

    // 提取关键词
    ipcMain.handle("ipAgent:extractKeywords", async (event, params: {
        subtitleText: string,
        modelConfig: any
    }) => {
        try {
            const { subtitleText, modelConfig } = params;

            Log.info("ipAgent.extractKeywords", { textLength: subtitleText.length });

            const prompt = `请从以下文本中提取5-8个关键词,这些关键词应该是文本中最重要、最有代表性的词汇。每个关键词2-4个字。

文本内容:
${subtitleText}

请直接输出关键词列表,每行一个,不要编号,不要额外说明。`;

            // 调用AI模型
            const response = await fetch(modelConfig.apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${modelConfig.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: modelConfig.modelId,
                    messages: [{ role: 'user', content: prompt }]
                })
            });

            if (!response.ok) {
                throw new Error(`API请求失败: ${response.status}`);
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content || '';

            // 解析关键词
            const keywords = content
                .split('\n')
                .map((line: string) => line.trim())
                .filter((line: string) => line && !line.startsWith('#'))
                .map((keyword: string) => ({ keyword, enabled: true }));

            Log.info("ipAgent.extractKeywords.success", { keywordCount: keywords.length });

            AuthMain.reportGeneration('script', `关键词提取:${keywords.length}个`);

            return {
                success: true,
                keywords
            };
        } catch (error) {
            const errorMessage = error?.message || String(error || '????');
            const errorName = error?.cause?.name || error?.name || '';
            const errorCode = error?.cause?.code || error?.code || '';
            const isTimeoutError = /timeout/i.test(errorMessage) || /timeout/i.test(errorName) || /timeout/i.test(errorCode);

            Log.error("ipAgent.extractKeywords.error", error);

            if (isTimeoutError) {
                Log.warn("ipAgent.extractKeywords.timeoutFallback", { errorMessage, errorName, errorCode });
                return {
                    success: true,
                    degraded: true,
                    keywords: [],
                    message: "????????????????"
                };
            }

            return {
                success: false,
                message: "???????: " + errorMessage
            };
        }
    });

    // 选择音乐文件
    ipcMain.handle("ipAgent:selectMusicFile", async (event) => {
        try {
            let defaultPath = "";

            // 尝试查找bgm目录
            // 生产环境: resources/resources-bundles/bgm
            // 开发环境: 项目根目录/bgm
            // 兼容旧路径: resources/app.asar.unpacked/bgm
            const possiblePaths = [
                path.join(process.resourcesPath, 'resources-bundles', 'bgm'),
                path.join(process.cwd(), 'resources', 'resources-bundles', 'bgm'),
                path.join(process.cwd(), 'bgm'),
                path.join(process.resourcesPath, 'app.asar.unpacked', 'bgm'),
                path.join(process.resourcesPath, 'bgm'),
                path.join(app.getAppPath(), 'bgm')
            ];

            for (const p of possiblePaths) {
                try {
                    if (fs.existsSync(p)) {
                        defaultPath = p;
                        Log.info("ipAgent.selectMusicFile.defaultPathFound", { path: p });
                        break;
                    }
                } catch (e) {
                    // ignore
                }
            }

            const result = await dialog.showOpenDialog({
                title: '选择背景音乐',
                defaultPath: defaultPath,
                filters: [
                    { name: '音频文件', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'] }
                ],
                properties: ['openFile']
            });

            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return {
                    success: false,
                    message: '用户取消选择'
                };
            }

            const filePath = result.filePaths[0];

            Log.info("ipAgent.selectMusicFile.success", { filePath });

            return {
                success: true,
                filePath
            };
        } catch (error) {
            Log.error("ipAgent.selectMusicFile.error", error);
            return {
                success: false,
                message: "选择文件失败: " + (error?.message || error)
            };
        }
    });

    // 选择视频文件（用于上传自己的视频生成字幕）
    ipcMain.handle("ipAgent:selectVideoFile", async (event) => {
        try {
            const result = await dialog.showOpenDialog({
                title: '选择视频文件',
                filters: [
                    { name: '视频文件', extensions: ['mp4', 'avi', 'mov', 'mkv', 'wmv', 'flv', 'webm'] }
                ],
                properties: ['openFile']
            });

            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return {
                    success: false,
                    message: '用户取消选择'
                };
            }

            const filePath = result.filePaths[0];

            Log.info("ipAgent.selectVideoFile.success", { filePath });

            return {
                success: true,
                filePath
            };
        } catch (error) {
            Log.error("ipAgent.selectVideoFile.error", error);
            return {
                success: false,
                message: "选择文件失败: " + (error?.message || error)
            };
        }
    });

    // 生成视频封面
    ipcMain.handle("ipAgent:generateVideoCover", async (event, params: {
        videoPath: string,
        titleText: string,
        effectStyle?: any,
        template?: any  // ✅ 添加template参数
    }) => {
        try {
            let { videoPath, titleText, effectStyle, template } = params;

            // ✅ 关键修复：优先使用template参数，如果没有则使用effectStyle
            const templateConfig = template || effectStyle;

            // 验证输入参数
            if (!videoPath || typeof videoPath !== 'string') {
                Log.error("ipAgent.generateVideoCover.invalidInput", { videoPath });
                return {
                    success: false,
                    message: "无效的视频路径"
                };
            }

            // 移除file://前缀
            videoPath = videoPath.replace(/^file:\/\//, '');

            // 验证文件是否存在
            if (!fs.existsSync(videoPath)) {
                Log.error("ipAgent.generateVideoCover.fileNotFound", { videoPath });
                return {
                    success: false,
                    message: "视频文件不存在: " + videoPath
                };
            }

            if (!titleText || typeof titleText !== 'string' || titleText.trim() === '') {
                Log.error("ipAgent.generateVideoCover.invalidTitle", { titleText });
                return {
                    success: false,
                    message: "标题文本不能为空"
                };
            }

            Log.info("ipAgent.generateVideoCover", { videoPath, titleText, effectStyle, template, usingTemplate: !!template });

            const outputDir = getOutputDir('cover');
            const timestamp = Date.now();
            const coverPath = path.join(outputDir, `cover_${timestamp}.jpg`);

            // 1. 从视频中提取一个出彩帧(取视频3秒位置的帧)
            const tempFramePath = path.join(outputDir, `temp_frame_${timestamp}.jpg`);
            // 修复：
            // 1. -ss 参数必须放在 -i 之前（快速跳转模式）
            // 2. 添加 -pix_fmt yuvj420p 将像素格式从 yuv420p 转换为 yuvj420p（full-range）
            // 3. 添加 -c:v mjpeg 明确指定 MJPEG 编码器
            // 4. 添加 -strict:v unofficial 允许非标准参数
            // 这样可以解决 "Non full-range YUV" 错误
            const extractFrameArgs = [
                '-ss', '00:00:03',              // 快速跳转到 3 秒位置
                '-i', videoPath,                // 读取输入视频
                '-vframes', '1',                // 只提取一帧
                '-pix_fmt', 'yuvj420p',         // 转换像素格式为 full-range YUV
                '-c:v', 'mjpeg',                // 使用 MJPEG 编码器
                '-strict:v', 'unofficial',      // 允许非标准 YUV 范围
                '-f', 'image2',                 // 输出格式为图像
                '-y',                           // 覆盖已存在的输出文件
                tempFramePath                   // 输出文件路径
            ];

            await execFFmpegCommand(extractFrameArgs);

            // 2. 检查是否使用新的模板系统
            // 判断条件：如果 templateConfig 包含以下任一属性，则认为是新模板
            // - blurBackground: 背景模糊
            // - extractPerson: 人物抠图
            // - personOutlineColor/personOutlineWidth: 人物描边
            // - maskImagePath: 蒙版图片
            // - titleFontFamily: 自定义字体
            // - titleBackgroundEnabled: 标题背景
            // - personSize: 人物大小
            // - backgroundBlurEnabled: 背景模糊开关
            const isNewTemplate = templateConfig && (
                templateConfig.blurBackground !== undefined ||
                templateConfig.extractPerson !== undefined ||
                templateConfig.personOutlineColor !== undefined ||
                templateConfig.personOutlineWidth !== undefined ||
                templateConfig.maskImagePath !== undefined ||
                templateConfig.titleFontFamily ||
                templateConfig.titleBackgroundEnabled ||
                templateConfig.personSize !== undefined ||
                templateConfig.backgroundBlurEnabled !== undefined
            );

            // 详细日志：记录判断过程
            Log.info("ipAgent.generateVideoCover.templateCheck", {
                hasEffectStyle: !!templateConfig,
                effectStyleKeys: templateConfig ? Object.keys(templateConfig) : [],
                blurBackground: templateConfig?.blurBackground,
                extractPerson: templateConfig?.extractPerson,
                personOutlineColor: templateConfig?.personOutlineColor,
                personOutlineWidth: templateConfig?.personOutlineWidth,
                maskImagePath: templateConfig?.maskImagePath,
                titleFontFamily: templateConfig?.titleFontFamily,
                titleBackgroundEnabled: templateConfig?.titleBackgroundEnabled,
                personSize: templateConfig?.personSize,
                backgroundBlurEnabled: templateConfig?.backgroundBlurEnabled,
                isNewTemplate
            });

            if (isNewTemplate) {
                // 使用高级Python封面生成器（支持完整的模板配置和步骤化生成）
                Log.info("ipAgent.generateVideoCover.usingAdvancedPythonGenerator", { templateConfig: templateConfig });

                try {
                    // 调用高级Python生成器
                    const pythonScript = getPythonScriptPath('advanced_cover_generator.py');
                    const pythonExe = getPythonPath();

                    // ✅ 关键修复：使用templateConfig而不是effectStyle
                    // 准备配置JSON字符串（包含所有模板配置）
                    const configJson = JSON.stringify(templateConfig);

                    // 检查是否有自定义视频路径
                    let finalVideoPath = videoPath;
                    if (templateConfig.customVideoPath && fs.existsSync(templateConfig.customVideoPath)) {
                        finalVideoPath = templateConfig.customVideoPath;
                        Log.info("ipAgent.generateVideoCover.usingCustomVideo", {
                            originalVideo: videoPath,
                            customVideo: finalVideoPath
                        });
                    } else if (templateConfig.customVideoPath) {
                        Log.info("ipAgent.generateVideoCover.customVideoNotFound", {
                            customVideoPath: templateConfig.customVideoPath,
                            fallbackToOriginal: videoPath
                        });
                    }

                    // 🔧 修复中文路径问题：在 Windows 上，将路径转换为短路径格式（8.3格式）
                    // 这样可以避免中文和特殊字符导致的编码问题
                    const normalizePathForPython = (filePath: string): string => {
                        if (process.platform === 'win32') {
                            // Windows 上使用正斜杠，Python 可以正确处理
                            return filePath.replace(/\\/g, '/');
                        }
                        return filePath;
                    };

                    // 构建命令行参数
                    const pythonArgs = [
                        pythonScript,
                        '--video', normalizePathForPython(finalVideoPath),  // 使用自定义视频路径或原始视频路径
                        '--title', titleText,
                        '--output', normalizePathForPython(coverPath),
                        '--config', configJson
                    ];

                    // 🚀 优化：如果已提取帧，传递帧路径给Python，避免重复提取
                    if (fs.existsSync(tempFramePath)) {
                        templateConfig._extractedFramePath = normalizePathForPython(tempFramePath);
                        // 更新configJson
                        const updatedConfigJson = JSON.stringify(templateConfig);
                        pythonArgs[pythonArgs.indexOf(configJson)] = updatedConfigJson;
                        Log.info("ipAgent.generateVideoCover.passExtractedFrame", {
                            tempFramePath: normalizePathForPython(tempFramePath)
                        });
                    }

                    Log.info("ipAgent.generateVideoCover.advancedPythonArgs", {
                        pythonExe,
                        videoPath: videoPath,
                        normalizedVideoPath: normalizePathForPython(finalVideoPath),
                        outputPath: coverPath,
                        normalizedOutputPath: normalizePathForPython(coverPath),
                        titleText: titleText,
                        configKeys: Object.keys(templateConfig).length,
                        // ✅ 新增：验证polygon背景点数据是否被传递
                        titleBackgroundPointsCount: templateConfig.titleBackgroundPoints?.length || 0,
                        titleBackgroundShape: templateConfig.titleBackgroundShape,
                        subtitleBackgroundPointsCount: templateConfig.subtitleBackgroundPoints?.length || 0,
                        subtitleBackgroundShape: templateConfig.subtitleBackgroundShape
                    });

                    const result = await new Promise<{ success: boolean, message?: string, previewImages?: any[] }>((resolve) => {
                        // 设置工作目录为 python 脚本所在目录，确保能找到 modules 目录
                        const pythonScriptDir = path.dirname(pythonScript);

                        // 🔧 修复：传递APP_ROOT环境变量给Python进程，使其能正确识别打包环境
                        // ✅ 关键修复：使用AppEnv.appRoot（已在主进程初始化时正确设置）代替process.env.APP_ROOT
                        // 避免降级到process.cwd()导致找不到模型文件
                        const env = Object.assign({}, process.env, {
                            APP_ROOT: AppEnv.appRoot || process.resourcesPath || process.cwd(),
                            // 🔧 新增：设置 Python 使用 UTF-8 编码
                            PYTHONIOENCODING: 'utf-8'
                        });

                        // 🔧 修复：添加 FFmpeg 目录到 PATH
                        const ffmpegPath = getFFmpegExecutablePath();
                        if (resourceExists(ffmpegPath)) {
                            const ffmpegDir = path.dirname(ffmpegPath);
                            const pathSep = process.platform === 'win32' ? ';' : ':';
                            env['PATH'] = ffmpegDir + pathSep + (env['PATH'] || process.env.PATH || '');
                        }

                        // spawn 选项：使用 shell: false 以正确传递参数
                        const spawnOptions: any = {
                            cwd: AppEnv.appRoot || process.resourcesPath || process.cwd(),
                            env: env,
                            shell: false
                        };

                        const pythonProcess = spawn(pythonExe, pythonArgs, spawnOptions);

                        let stdout = '';
                        let stderr = '';

                        pythonProcess.stdout.on('data', (data) => {
                            stdout += data.toString();
                        });

                        pythonProcess.stderr.on('data', (data) => {
                            stderr += data.toString();
                        });

                        pythonProcess.on('close', (code) => {
                            Log.info("ipAgent.generateVideoCover.advancedPythonCompleted", {
                                exitCode: code,
                                coverExists: fs.existsSync(coverPath),
                                stdoutLength: stdout.length,
                                stderrLength: stderr.length
                            });

                            // 输出Python的stderr以便调试
                            if (stderr && stderr.length > 0) {
                                console.log("=== Python stderr (调试信息) ===");
                                console.log(stderr);
                                console.log("=== stderr 结束 ===");
                            }

                            if (code === 0 && fs.existsSync(coverPath)) {
                                // 解析Python输出以获取预览图信息
                                let previewImages = [];
                                try {
                                    // Python脚本现在只输出一行JSON
                                    const pythonResult = JSON.parse(stdout.trim());
                                    previewImages = pythonResult.previewImages || [];
                                } catch (e) {
                                    Log.error("ipAgent.generateVideoCover.parsePreviewFailed", {
                                        error: e,
                                        stdout: stdout
                                    });
                                }

                                Log.info("ipAgent.generateVideoCover.advancedPythonSuccess", {
                                    coverPath,
                                    previewCount: previewImages.length,
                                    previews: previewImages.slice(0, 3) // 只记录前3个，避免日志过长
                                });
                                resolve({ success: true, previewImages });
                            } else {
                                Log.error("ipAgent.generateVideoCover.advancedPythonFailed", {
                                    code,
                                    stdout,
                                    stderr,
                                    coverExists: fs.existsSync(coverPath)
                                });
                                resolve({
                                    success: false,
                                    message: `高级Python生成器失败 (code: ${code}): ${stderr || stdout}`
                                });
                            }
                        });

                        pythonProcess.on('error', (err) => {
                            Log.error("ipAgent.generateVideoCover.pythonError", { error: err });
                            resolve({
                                success: false,
                                message: `Python进程错误: ${err.message}`
                            });
                        });
                    });

                    if (!result.success) {
                        throw new Error(result.message || 'Python生成器失败');
                    }

                } catch (pythonError: any) {
                    Log.info("ipAgent.generateVideoCover.pythonFallback", { error: pythonError.message });
                    // Python生成失败，回退到FFmpeg简单模式
                    const {
                        titleFontSize = 90,
                        titleFontColor = '#FFFFFF',
                        titlePosition = 'bottom'
                    } = effectStyle || {};

                    const textPosition = titlePosition === 'top' ? 'y=50' : titlePosition === 'center' ? 'y=(h-text_h)/2' : 'y=h-text_h-50';

                    const addTextArgs = [
                        '-i', tempFramePath,
                        '-vf', `drawtext=text='${titleText}':fontsize=${titleFontSize}:fontcolor=${titleFontColor}:x=(w-text_w)/2:${textPosition}:shadowcolor=black:shadowx=2:shadowy=2`,
                        coverPath
                    ];

                    await execFFmpegCommand(addTextArgs);
                }
            } else {
                // 使用FFmpeg简单模式（旧的效果样式）
                const {
                    titleFontSize = 90,
                    titleFontColor = '#FFFFFF',
                    titlePosition = 'bottom',
                    backgroundColor = '#000000',
                    backgroundOpacity = 0.8
                } = effectStyle || {};

                const textPosition = titlePosition === 'top' ? 'y=50' : titlePosition === 'center' ? 'y=(h-text_h)/2' : 'y=h-text_h-50';

                const addTextArgs = [
                    '-i', tempFramePath,
                    '-vf', `drawtext=text='${titleText}':fontsize=${titleFontSize}:fontcolor=${titleFontColor}:x=(w-text_w)/2:${textPosition}:shadowcolor=black:shadowx=2:shadowy=2`,
                    coverPath
                ];

                await execFFmpegCommand(addTextArgs);
            }

            // 删除临时文件
            if (fs.existsSync(tempFramePath)) {
                fs.unlinkSync(tempFramePath);
            }

            Log.info("ipAgent.generateVideoCover.success", { coverPath });

            return {
                success: true,
                coverPath,
                finalCoverPath: coverPath
            };
        } catch (error) {
            Log.error("ipAgent.generateVideoCover.error", error);
            return {
                success: false,
                message: "生成封面失败: " + (error?.message || error),
                error: error?.message || String(error)
            };
        }
    });

    // 读取SRT文件并解析
    ipcMain.handle("ipAgent:readSrtFile", async (event, params: { srtPath: string }) => {
        try {
            const { srtPath } = params;

            Log.info("ipAgent.readSrtFile", { srtPath });

            // 验证文件是否存在
            if (!fs.existsSync(srtPath)) {
                Log.error("ipAgent.readSrtFile.fileNotFound", { srtPath });
                return {
                    success: false,
                    message: "SRT文件不存在: " + srtPath
                };
            }

            // 读取SRT文件内容
            const content = fs.readFileSync(srtPath, 'utf-8');

            // 解析SRT格式
            const subtitles: Array<{
                index: number;
                startTime: string;
                endTime: string;
                text: string;
            }> = [];

            const blocks = content.trim().split('\n\n');
            for (const block of blocks) {
                const lines = block.split('\n');
                if (lines.length >= 3) {
                    const index = parseInt(lines[0]);
                    const timeMatch = lines[1].match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
                    if (timeMatch) {
                        const startTime = timeMatch[1];
                        const endTime = timeMatch[2];
                        const text = lines.slice(2).join('\n');
                        subtitles.push({ index, startTime, endTime, text });
                    }
                }
            }

            Log.info("ipAgent.readSrtFile.success", {
                srtPath,
                subtitleCount: subtitles.length
            });

            return {
                success: true,
                subtitles,
                content
            };
        } catch (error) {
            Log.error("ipAgent.readSrtFile.error", error);
            return {
                success: false,
                message: "读取SRT文件失败: " + (error?.message || error)
            };
        }
    });

    // 保存ASS字幕文件（不使用缓存，每次都生成新文件）
    ipcMain.handle("ipAgent:saveAssFile", async (event, params: {
        assContent: string,
        videoPath?: string,
        timestamp?: number
    }) => {
        try {
            const { assContent, videoPath, timestamp } = params;

            Log.info("ipAgent.saveAssFile", {
                contentLength: assContent.length,
                hasVideoPath: !!videoPath,
                note: "ASS字幕不使用缓存，每次都重新生成"
            });

            // ASS字幕始终使用当前时间戳，不使用缓存
            // 这样可以确保情感分析结果每次都是最新的
            const finalTimestamp = Date.now();
            const outputDir = getOutputDir('subtitle');
            const assPath = path.join(outputDir, `subtitle_emotion_${finalTimestamp}.ass`);

            // 写入ASS文件
            fs.writeFileSync(assPath, assContent, 'utf-8');

            Log.info("ipAgent.saveAssFile.success", {
                assPath,
                message: "ASS字幕文件已生成（不使用缓存）"
            });

            return {
                success: true,
                assPath,
                cached: false,  // 明确标记不使用缓存
                message: "ASS字幕文件已生成"
            };
        } catch (error) {
            Log.error("ipAgent.saveAssFile.error", error);
            return {
                success: false,
                message: "保存ASS文件失败: " + (error?.message || error)
            };
        }
    });

    // 从URL下载视频文件
    ipcMain.handle("ipAgent:downloadVideoFromUrl", async (event, params: {
        videoUrl: string,
        fileName?: string
    }) => {
        try {
            const { videoUrl, fileName } = params;

            Log.info("ipAgent.downloadVideoFromUrl", { videoUrl });

            if (!videoUrl || typeof videoUrl !== 'string') {
                return {
                    success: false,
                    message: "无效的视频URL"
                };
            }

            // 确定输出目录和文件名
            const outputDir = getOutputDir('video');
            const timestamp = Date.now();
            const fileExt = path.extname(new URL(videoUrl).pathname) || '.mp4';
            const finalFileName = fileName || `video_${timestamp}${fileExt}`;
            const videoPath = path.join(outputDir, finalFileName);

            Log.info("ipAgent.downloadVideoFromUrl.downloading", { videoPath });

            // 使用fetch下载视频
            const response = await fetch(videoUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (!response.ok) {
                throw new Error(`下载失败: ${response.status} ${response.statusText}`);
            }

            // 将响应流写入文件
            const fileStream = fs.createWriteStream(videoPath);
            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error("无法读取响应流");
            }

            const pump = async () => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    fileStream.write(Buffer.from(value));
                }
                fileStream.end();
            };

            await pump();

            // 等待文件写入完成
            await new Promise<void>((resolve, reject) => {
                fileStream.on('finish', () => resolve());
                fileStream.on('error', (err) => reject(err));
            });

            Log.info("ipAgent.downloadVideoFromUrl.success", { videoPath });

            return {
                success: true,
                videoPath,
                message: "视频下载成功"
            };
        } catch (error) {
            Log.error("ipAgent.downloadVideoFromUrl.error", error);
            return {
                success: false,
                message: "视频下载失败: " + (error?.message || error)
            };
        }
    });

    // 视频文案分析：使用浏览器自动化+API拦截+语音识别
    ipcMain.handle("ipAgent:rewriteVideoContent", async (event, params: {
        videoUrl: string,
        modelConfig: { providerId: string, modelId: string, apiUrl: string, apiHost: string, apiKey: string, type: string },
        rewritePrompt: string,
        asrModelKey?: string,
        scriptWordCount?: number
    }) => {
        // 提升参数到外层作用域，确保catch块中可访问
        const videoUrl = params.videoUrl;
        const modelConfig = params.modelConfig;
        const rewritePrompt = params.rewritePrompt;
        const asrModelKey = params.asrModelKey;
        const scriptWordCount = params.scriptWordCount || 300;  // 默认 300 字

        // 提升浏览器上下文变量到外层作用域，确保catch块中可访问
        let externalBrowserContext: any = null;

        try {

            Log.info("ipAgent.rewriteVideoContent.start", {
                videoUrl,
                hasModelConfig: !!modelConfig,
                hasRewritePrompt: !!rewritePrompt,
                mode: "浏览器自动化+语音识别模式"
            });

            // 导入视频下载器
            const { DouyinVideoDownloader } = await import('./videoDownloader');

            // 尝试从publish模块获取现有的浏览器上下文
            try {
                const { getBrowserContext } = await import('../publish/main');
                console.log('尝试从publish模块获取浏览器...');
                externalBrowserContext = await getBrowserContext('douyin');
                console.log('成功获取publish模块的浏览器上下文，将复用该浏览器');
            } catch (error) {
                console.log('未能从publish模块获取浏览器，将使用独立的浏览器管理器:', error instanceof Error ? error.message : error);
            }

            // 创建下载器实例（传入外部浏览器上下文，如果有的话）
            const downloader = new DouyinVideoDownloader(externalBrowserContext);

            let videoPath: string | null = null;
            let audioPath: string | null = null;
            let textPath: string | null = null;

            try {
                // 第一步：下载视频文件
                Log.info("ipAgent.rewriteVideoContent.step1", { step: "使用浏览器自动化下载视频" });

                const downloadResult = await downloader.downloadDouyinVideo(videoUrl);

                Log.info("ipAgent.rewriteVideoContent.step1.result", {
                    success: downloadResult.success,
                    error: downloadResult.error,
                    videoPath: downloadResult.videoPath
                });

                if (!downloadResult.success) {
                    throw new Error(downloadResult.error || "视频下载失败");
                }

                videoPath = downloadResult.videoPath;
                audioPath = downloadResult.audioPath;

                Log.info("ipAgent.rewriteVideoContent.step1.success", {
                    videoPath: downloadResult.videoPath,
                    videoTitle: downloadResult.videoInfo?.desc,
                    author: downloadResult.videoInfo?.author?.nickname
                });

                // 【立即关闭浏览器】- 视频下载完成，不再需要浏览器
                Log.info("ipAgent.rewriteVideoContent.closeBrowser", { reason: "视频下载完成，关闭浏览器" });
                try {
                    await downloader.close();
                    // 如果使用了外部浏览器上下文，需要显式关闭它
                    if (externalBrowserContext) {
                        const { closeBrowserContext } = await import('../publish/main');
                        await closeBrowserContext('douyin');
                        Log.info("ipAgent.rewriteVideoContent.closeBrowser.success", { message: "已关闭抖音浏览器上下文" });
                    }
                } catch (closeError) {
                    Log.error("ipAgent.rewriteVideoContent.close.error", closeError);
                }

                // 第二步：提取音频并进行语音识别（本地处理）
                Log.info("ipAgent.rewriteVideoContent.step2", { step: "提取音频并进行语音识别" });

                // 第二步：提取音频并进行语音识别
                Log.info("ipAgent.rewriteVideoContent.step2.usingASR", { asrModelKey });
                Log.info("ipAgent.rewriteVideoContent.step2.calling", {
                    message: "即将调用extractAudioAndRecognize"
                });

                const recognizeResult = await extractAudioAndRecognize(
                    downloadResult.videoPath!,
                    downloadResult.audioPath!,
                    asrModelKey
                );

                Log.info("ipAgent.rewriteVideoContent.step2.receivedResult", {
                    message: "已收到extractAudioAndRecognize的返回值",
                    hasText: !!recognizeResult?.text,
                    textLength: recognizeResult?.text?.length || 0
                });

                const extractedText = recognizeResult.text;
                textPath = recognizeResult.textPath;

                Log.info("ipAgent.rewriteVideoContent.step2.success", {
                    extractedTextLength: extractedText.length,
                    extractedTextPreview: extractedText.substring(0, 100) + "...",
                    textPath: textPath
                });

                // 第三步：先用AI优化识别文本（添加标点符号），再进行仿写
                Log.info("ipAgent.rewriteVideoContent.step3", { step: "优化识别文本并进行仿写" });

                // 【新增】先调用AI优化识别文本，添加标点符号
                Log.info("ipAgent.rewriteVideoContent.step3.optimizingText", {
                    sourceLength: extractedText.length,
                    preview: extractedText.substring(0, 100)
                });

                const optimizationPrompt = `这是我使用ASR技术对音频内容进行转录的结果。请直接输出优化后的文本，添加适当的标点符号，无需任何额外说明文字。

转录结果：${extractedText}`;

                let optimizedText = extractedText;
                try {
                    optimizedText = await callTextModelAPI(optimizationPrompt, modelConfig);
                    Log.info("ipAgent.rewriteVideoContent.step3.optimizationSuccess", {
                        optimizedLength: optimizedText?.length || 0,
                        preview: optimizedText?.substring(0, 100) || ''
                    });
                } catch (optimizationError) {
                    Log.info("ipAgent.rewriteVideoContent.step3.optimizationFailed", {
                        error: optimizationError instanceof Error ? optimizationError.message : optimizationError
                    });
                    // 如果优化失败，继续使用原始文本
                }

                // 使用优化后的文本作为仿写的源内容
                Log.info("ipAgent.rewriteVideoContent.step3.rewriteSourceText", {
                    sourceLength: optimizedText.length,
                    preview: optimizedText.substring(0, 100)
                });

                // 使用用户配置的提示词（rewritePrompt来自设置）
                // 替换提示词中的占位符：{content} 和 {{count}}
                let finalRewritePrompt = rewritePrompt && rewritePrompt.trim().length > 0
                    ? rewritePrompt
                    : `请基于以下视频原文案，创作一个新的仿写文案：\n\n原文案：${optimizedText}\n\n要求：\n1. 保持原文案的核心内容和风格\n2. 适当改变表达方式和用词\n3. 确保新文案通顺自然\n4. 长度与原文案相当\n\n请直接输出仿写后的文案：`;

                // 替换 {content} 和 {{content}} 为优化后的文本
                finalRewritePrompt = finalRewritePrompt
                    .replace(/{content}/g, optimizedText)
                    .replace(/{{content}}/g, optimizedText);

                // 替换 {{count}} 为实际字数（支持多种格式：{{count}}、{count} 等）
                finalRewritePrompt = finalRewritePrompt
                    .replace(/{{count}}/g, String(scriptWordCount))
                    .replace(/{count}/g, String(scriptWordCount));

                Log.info("ipAgent.rewriteVideoContent.step3.usingPrompt", {
                    isCustomPrompt: !!(rewritePrompt && rewritePrompt.trim().length > 0),
                    promptLength: finalRewritePrompt.length,
                    promptPreview: finalRewritePrompt.substring(0, 80)
                });

                // 调用设置中的在线文案模型进行仿写
                Log.info("ipAgent.rewriteVideoContent.step3.callingTextModel", {
                    modelId: modelConfig.modelId,
                    providerId: modelConfig.providerId
                });

                const rewrittenContent = await callTextModelAPI(finalRewritePrompt, modelConfig);

                Log.info("ipAgent.rewriteVideoContent.step3.rewriteResult", {
                    resultLength: rewrittenContent?.length || 0,
                    resultPreview: rewrittenContent?.substring(0, 100) || ''
                });

                Log.info("ipAgent.rewriteVideoContent.success", {
                    originalTextLength: extractedText.length,
                    rewrittenTextLength: rewrittenContent.length
                });

                // 【新增】清理临时文件：转文字成功后删除下载的视频和提取的音频
                Log.info("ipAgent.rewriteVideoContent.cleanupTempFiles", {
                    videoPath: videoPath,
                    audioPath: audioPath,
                    reason: "转文字成功，删除临时文件以节省空间"
                });

                try {
                    // 删除下载的视频文件
                    if (videoPath && fs.existsSync(videoPath)) {
                        fs.unlinkSync(videoPath);
                        Log.info("ipAgent.rewriteVideoContent.cleanupTempFiles.deletedVideo", { videoPath });
                    }

                    // 删除提取的音频文件
                    if (audioPath && fs.existsSync(audioPath)) {
                        fs.unlinkSync(audioPath);
                        Log.info("ipAgent.rewriteVideoContent.cleanupTempFiles.deletedAudio", { audioPath });
                    }

                    Log.info("ipAgent.rewriteVideoContent.cleanupTempFiles.success", {
                        message: "临时文件清理完成"
                    });
                } catch (cleanupError) {
                    // 清理失败不影响主流程，只记录日志
                    Log.error("ipAgent.rewriteVideoContent.cleanupTempFiles.error", {
                        error: cleanupError instanceof Error ? cleanupError.message : cleanupError,
                        message: "临时文件清理失败，不影响主流程"
                    });
                }

                return {
                    success: true,
                    recognizedText: extractedText,      // 返回识别文本（txt文件的内容：去掉空格，保留标点）
                    rewrittenText: rewrittenContent,   // 返回AI生成的仿写内容（原样返回，不处理）
                    videoInfo: {
                        title: downloadResult.videoInfo?.desc,
                        author: downloadResult.videoInfo?.author?.nickname,
                        duration: downloadResult.videoInfo?.video?.duration
                    },
                    message: "视频文案分析完成",
                    debug: {
                        videoUrl: videoUrl,
                        recognizedTextLength: extractedText.length,
                        rewrittenTextLength: rewrittenContent.length,
                        videoPath: videoPath,
                        audioPath: audioPath,
                        textPath: textPath
                    }
                };

            } catch (processingError) {
                throw processingError;
            }

        } catch (error: any) {
            // 记录详细的错误信息，便于诊断
            console.error("【浏览器自动化失败】详细错误信息：");
            console.error("错误类型:", error?.constructor?.name);
            console.error("错误消息:", error?.message);
            console.error("错误堆栈:", error?.stack);
            console.error("原始错误对象:", error);

            Log.error("ipAgent.rewriteVideoContent.error", {
                errorType: error?.constructor?.name,
                errorMessage: error?.message,
                errorStack: error?.stack,
                fullError: String(error)
            });

            // 发生错误时也要关闭浏览器
            if (externalBrowserContext) {
                try {
                    const { closeBrowserContext } = await import('../publish/main');
                    await closeBrowserContext('douyin');
                    Log.info("ipAgent.rewriteVideoContent.closeBrowser.onError", { message: "错误发生后已关闭抖音浏览器上下文" });
                } catch (closeError) {
                    Log.error("ipAgent.rewriteVideoContent.closeBrowser.onError.failed", closeError);
                }
            }

            // 直接抛出错误，返回失败状态
            return {
                success: false,
                error: error?.message || "视频处理失败",
                message: "视频仿写失败：" + (error?.message || "未知错误"),
                debug: {
                    videoUrl: videoUrl,
                    errorType: error?.constructor?.name,
                    errorMessage: error?.message,
                    errorStack: error?.stack
                }
            };
        }
    });

    // 下载视频 (专门用于视频仿写，返回详细信息)
    ipcMain.handle("ipAgent:downloadVideo", async (event, params: { url: string }) => {
        try {
            const { url } = params;

            Log.info("ipAgent.downloadVideo", { url });

            // 导入视频下载器
            const { DouyinVideoDownloader } = await import('./videoDownloader');

            // 创建下载器实例
            const downloader = new DouyinVideoDownloader();

            // 下载视频
            const result = await downloader.downloadDouyinVideo(url);

            if (result.success) {
                Log.info("ipAgent.downloadVideo.success", {
                    videoPath: result.videoPath,
                    audioPath: result.audioPath
                });
                return {
                    success: true,
                    videoPath: result.videoPath,
                    audioPath: result.audioPath,
                    videoInfo: result.videoInfo
                };
            } else {
                Log.error("ipAgent.downloadVideo.fail", result.error);
                return {
                    success: false,
                    message: result.error || "下载失败"
                };
            }

        } catch (error: any) {
            Log.error("ipAgent.downloadVideo.error", error);
            return {
                success: false,
                message: "下载视频出错: " + (error?.message || error)
            };
        }
    });

    /**
     * 提取音频并进行语音识别
     */
    async function extractAudioAndRecognize(videoPath: string, audioPath: string, asrModelKey?: string): Promise<{ text: string, textPath: string }> {
        try {
            const { exec } = await import('child_process');
            const { dirname, join, extname } = await import('path');
            const { existsSync, mkdirSync, writeFileSync, statSync } = await import('fs');

            Log.info("extractAudioAndRecognize.start", { videoPath, audioPath });

            // 确保音频目录存在
            const audioDir = dirname(audioPath);
            if (!existsSync(audioDir)) {
                mkdirSync(audioDir, { recursive: true });
            }

            // 【修复】检查音频文件是否已存在且有效
            if (existsSync(audioPath)) {
                try {
                    const stats = statSync(audioPath);
                    if (stats.size > 0) {
                        Log.info("extractAudioAndRecognize.audioExists", {
                            audioPath,
                            fileSize: stats.size
                        });
                        // 音频文件已存在且大小有效，直接使用
                    } else {
                        Log.info("extractAudioAndRecognize.audioFileEmpty", { audioPath });
                        // 音频文件为空，删除并重新提取
                        require('fs').unlinkSync(audioPath);
                    }
                } catch (statError) {
                    Log.info("extractAudioAndRecognize.statError", statError);
                }
            }

            // 如果音频文件不存在，使用FFmpeg提取
            if (!existsSync(audioPath)) {
                Log.info("extractAudioAndRecognize.extractingAudio", { videoPath, audioPath });

                // 使用FFmpeg提取音频，⚠️ 使用打包的 FFmpeg，不依赖系统环境
                const ffmpegParams = [
                    '-i', videoPath,
                    '-vn',
                    '-acodec', 'pcm_s16le',
                    '-ar', '16000',
                    '-ac', '1',
                    '-y',
                    audioPath
                ];

                Log.info("extractAudioAndRecognize.ffmpeg", { params: ffmpegParams });

                try {
                    await execFFmpegCommand(ffmpegParams);
                    Log.info("extractAudioAndRecognize.ffmpeg.success");
                } catch (error: any) {
                    Log.error("extractAudioAndRecognize.ffmpeg.error", { error: error.message });
                    throw new Error(`音频提取失败: ${error.message}`);
                }

                // 检查音频文件是否生成成功
                if (!existsSync(audioPath)) {
                    throw new Error("音频文件提取失败");
                }
            }

            // 再次检查提取后的音频文件大小
            const audioFileSize = statSync(audioPath).size;
            if (audioFileSize === 0) {
                throw new Error("提取的音频文件为空");
            }

            Log.info("extractAudioAndRecognize.audioReady", {
                audioPath,
                fileSize: audioFileSize
            });

            // 【修复】使用设置的 ASR 模型进行语音识别
            let recognitionText = '';
            const textPath = audioPath.replace(extname(audioPath), '.txt');

            if (asrModelKey) {
                // 使用用户设置的 ASR 模型 - 通过前端serverStore调用
                Log.info("extractAudioAndRecognize.usingServerModel", { asrModelKey, audioPath });

                try {
                    // 获取主窗口以进行IPC通信
                    const mainWindow = BrowserWindow.getFocusedWindow() ||
                        BrowserWindow.getAllWindows()[0];

                    if (!mainWindow) {
                        throw new Error("无法获取主窗口，将使用FUNASR降级方案");
                    }

                    // 创建一个Promise来等待前端的ASR调用响应
                    const asrResult = await new Promise<any>((resolve, reject) => {
                        let timeoutHandle: NodeJS.Timeout | null = null;
                        let listenerAttached = false;

                        const handleResult = (_event: any, result: any) => {
                            if (timeoutHandle) {
                                clearTimeout(timeoutHandle);
                                timeoutHandle = null;
                            }

                            // 移除监听器避免重复触发
                            if (listenerAttached) {
                                ipcMain.removeListener("ipAgent:asrRecognizeResult", handleResult);
                                listenerAttached = false;
                            }

                            if (result && result.success) {
                                resolve(result.data);
                            } else {
                                reject(new Error(result?.message || "ASR识别失败"));
                            }
                        };

                        // 先发送请求,然后监听响应
                        // 发送请求给前端，让前端使用serverStore调用ASR
                        Log.info("extractAudioAndRecognize.beforeSendingRequest", {
                            asrModelKey,
                            audioPath,
                            mainWindowAvailable: !!mainWindow
                        });

                        mainWindow.webContents.send("ipAgent:performAsrRecognize", {
                            asrModelKey,
                            audioPath
                        });

                        // 发送请求后才监听响应(避免竞争条件)
                        ipcMain.on("ipAgent:asrRecognizeResult", handleResult);
                        listenerAttached = true;

                        Log.info("extractAudioAndRecognize.sentAsrRequestToFrontend", {
                            asrModelKey,
                            audioPath,
                            timestamp: new Date().toISOString()
                        });

                        // 设置超时（2分钟）
                        timeoutHandle = setTimeout(() => {
                            if (listenerAttached) {
                                ipcMain.removeListener("ipAgent:asrRecognizeResult", handleResult);
                                listenerAttached = false;
                            }
                            reject(new Error("ASR识别超时（2分钟）"));
                        }, 120000);
                    });

                    Log.info("extractAudioAndRecognize.serverModel.response", {
                        code: asrResult.code,
                        hasData: !!asrResult.data,
                        dataType: asrResult.data?.type,
                        hasDataData: !!asrResult.data?.data,
                        hasRecords: !!asrResult.data?.data?.records
                    });

                    // 【修复】ASR返回的数据结构是 data.data.records 而不是 data.result.records
                    if (asrResult.code === 0 && asrResult.data?.type === 'success' && asrResult.data?.data?.records) {
                        const records = asrResult.data.data.records || [];
                        recognitionText = records
                            .map((r: any) => r.text.trim())
                            .filter((text: string) => text.length > 0)
                            .join('')
                            .replace(/\s+/g, '');  // 去掉所有空格

                        Log.info("extractAudioAndRecognize.serverModel.success", {
                            recordCount: records.length,
                            textLength: recognitionText.length,
                            textPreview: recognitionText.substring(0, 100)
                        });
                    } else {
                        throw new Error(`ASR识别失败: code=${asrResult.code}, type=${asrResult.data?.type}, hasRecords=${!!asrResult.data?.data?.records}, msg=${asrResult.msg || '未知错误'}`);
                    }
                } catch (serverError) {
                    Log.error("extractAudioAndRecognize.serverModel.error", serverError);
                    // 失败时降级使用FUNASR
                    Log.info("extractAudioAndRecognize.fallbackToFunasr", { reason: serverError instanceof Error ? serverError.message : serverError });

                    const funasrResult = await recognizeAudioWithFunasr(audioPath, {
                        language: 'zh',
                        enableWordTimestamp: true
                    });

                    recognitionText = funasrResult.segments
                        .map(seg => seg.text.trim())
                        .filter(text => text.length > 0)
                        .join('')
                        .replace(/\s+/g, '');

                    Log.info("extractAudioAndRecognize.funasr.fallback.success", {
                        resultLength: recognitionText.length,
                        resultPreview: recognitionText.substring(0, 100)
                    });
                }
            } else {
                // 降级方案：使用FUNASR进行语音识别
                Log.info("extractAudioAndRecognize.funasr.start", { audioPath });

                const funasrResult = await recognizeAudioWithFunasr(audioPath, {
                    language: 'zh',
                    enableWordTimestamp: true
                });

                // 将FUNASR结果转换为识别的文本
                // 【修复】去掉所有空格，与"声音-语音识别"功能保持一致
                recognitionText = funasrResult.segments
                    .map(seg => seg.text.trim())
                    .filter(text => text.length > 0)
                    .join('')
                    .replace(/\s+/g, '');  // 去掉所有空格（包括字与字之间的空格）

                Log.info("extractAudioAndRecognize.funasr.success", {
                    resultLength: recognitionText.length,
                    resultPreview: recognitionText.substring(0, 100),
                    segmentCount: funasrResult.segments.length
                });
            }

            // 保存识别文本到文件（与音频同目录，扩展名改为 .txt）
            writeFileSync(textPath, recognitionText, 'utf-8');

            Log.info("extractAudioAndRecognize.success", {
                resultLength: recognitionText.length,
                resultPreview: recognitionText.substring(0, 100),
                textPath: textPath,
                usedModel: asrModelKey || 'funasr-fallback'
            });

            Log.info("extractAudioAndRecognize.returningResult", {
                message: "即将返回识别结果",
                textLength: recognitionText.length
            });

            return {
                text: recognitionText,
                textPath: textPath
            };

        } catch (error) {
            Log.error("extractAudioAndRecognize.error", error);
            throw new Error(`音频提取和识别失败: ${error instanceof Error ? error.message : error}`);
        }
    }


    /**
     * 调用文本模型API
     */
    async function callTextModelAPI(prompt: string, modelConfig: {
        providerId: string,
        modelId: string,
        apiUrl: string,
        apiKey: string
    }): Promise<string> {
        try {
            const requestBody = {
                model: modelConfig.modelId,
                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                max_tokens: 1000,
                temperature: 0.7
            };

            // 记录完整的API请求信息
            Log.info("callTextModelAPI.REQUEST", {
                apiUrl: modelConfig.apiUrl,
                providerId: modelConfig.providerId,
                modelId: modelConfig.modelId,
                promptLength: prompt.length,
                hasApiKey: !!modelConfig.apiKey
            });

            Log.info("callTextModelAPI.REQUEST_FULL_PROMPT", prompt);
            Log.info("callTextModelAPI.REQUEST_FULL_PAYLOAD", JSON.stringify(requestBody, null, 2));

            const response = await fetch(modelConfig.apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${modelConfig.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const error = await response.text();
                Log.error("callTextModelAPI.API_ERROR", {
                    status: response.status,
                    statusText: response.statusText,
                    errorResponse: error
                });
                throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();
            const content = result.choices?.[0]?.message?.content || result.content || '';

            // 记录完整的API响应
            Log.info("callTextModelAPI.RESPONSE_FULL", {
                rawResponse: JSON.stringify(result, null, 2)
            });

            Log.info("callTextModelAPI.RESPONSE_CONTENT", content);

            if (!content) {
                Log.error("callTextModelAPI.EMPTY_CONTENT", {
                    response: JSON.stringify(result, null, 2)
                });
            }

            Log.info("callTextModelAPI.success", {
                responseLength: content.length,
                responsePreview: content.substring(0, 100)
            });

            return content.trim();

        } catch (error) {
            Log.error("callTextModelAPI.error", error);
            throw new Error(`文本模型API调用失败: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * 直接调用豆包API
     * @param prompt 提示词
     * @param config API配置
     * @returns API响应内容
     */
    async function callDoubaoAPI(prompt: string, config: {
        apiUrl: string,
        apiKey: string,
        modelId: string
    }): Promise<string> {
        try {
            Log.info("ipAgent.callDoubaoAPI.start", {
                apiUrl: config.apiUrl,
                modelId: config.modelId,
                promptLength: prompt.length
            });

            const requestBody = {
                model: config.modelId,
                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                max_tokens: 500,
                temperature: 0.7
            };

            Log.info("ipAgent.callDoubaoAPI.request", {
                body: JSON.stringify(requestBody, null, 2)
            });

            const response = await fetch(config.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            Log.info("ipAgent.callDoubaoAPI.response", {
                status: response.status,
                statusText: response.statusText
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`豆包API调用失败 (${response.status}): ${errorText}`);
            }

            const responseData = await response.json();
            Log.info("ipAgent.callDoubaoAPI.responseData", {
                fullResponse: JSON.stringify(responseData, null, 2)
            });

            // 提取内容
            const content = responseData.choices?.[0]?.message?.content?.trim();

            if (!content) {
                throw new Error('豆包API返回内容为空');
            }

            Log.info("ipAgent.callDoubaoAPI.success", {
                contentLength: content.length,
                contentPreview: content.substring(0, 100)
            });

            return content;

        } catch (error: any) {
            Log.error("ipAgent.callDoubaoAPI.error", error);
            throw new Error(`豆包API调用失败: ${error.message}`);
        }
    }

    /**
     * 获取视频页面内容
     * @param videoUrl 视频URL
     * @returns 页面文本内容
     */
    async function fetchVideoPageContent(videoUrl: string): Promise<string> {
        try {
            Log.info("ipAgent.fetchVideoPageContent", { videoUrl });

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000); // 30秒超时

            const response = await fetch(videoUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`获取页面失败: ${response.status} ${response.statusText}`);
            }

            const html = await response.text();

            // 提取页面中的文本内容
            const pageContent = extractTextFromHtml(html);

            Log.info("ipAgent.fetchVideoPageContent.success", {
                contentLength: pageContent.length,
                htmlLength: html.length
            });

            return pageContent;

        } catch (error: any) {
            Log.error("ipAgent.fetchVideoPageContent.error", error);
            throw new Error(`获取视频页面内容失败: ${error.message}`);
        }
    }

    /**
     * 从HTML中提取文本内容
     * @param html HTML字符串
     * @returns 提取的文本内容
     */
    function extractTextFromHtml(html: string): string {
        // 移除HTML标签，只保留文本内容
        let text = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // 移除脚本
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')   // 移除样式
            .replace(/<[^>]+>/g, ' ')                          // 移除HTML标签
            .replace(/\s+/g, ' ')                              // 合并空白字符
            .trim();

        // 尝试提取常见的视频文案元素
        const patterns = [
            // 抖音常见的文案选择器（从已移除的标签中提取）
            /['"]([^'"]{10,100}?)['"](?=[^a-zA-Z0-9]|$)/g,  // 引号内的文本
            /文案[：:]\s*([^\n]{10,200})/gi,                // "文案: xxx"
            /标题[：:]\s*([^\n]{10,200})/gi,                // "标题: xxx"
            /描述[：:]\s*([^\n]{10,200})/gi,                // "描述: xxx"
            /内容[：:]\s*([^\n]{10,200})/gi,                // "内容: xxx"
        ];

        let extractedTexts: string[] = [];

        for (const pattern of patterns) {
            const matches = html.match(pattern);
            if (matches) {
                extractedTexts = extractedTexts.concat(
                    matches.map(match => match.replace(/^['"]|['"]$/g, '').trim())
                );
            }
        }

        // 如果找到了特定的文案内容，优先使用
        if (extractedTexts.length > 0) {
            // 去重并过滤
            const uniqueTexts = [...new Set(extractedTexts)]
                .filter(text => text.length >= 10 && text.length <= 500)
                .filter(text => !/^\d+$/.test(text)) // 排除纯数字
                .filter(text => !/^[a-zA-Z\s]+$/.test(text)); // 排除纯英文

            if (uniqueTexts.length > 0) {
                return uniqueTexts.join('\n');
            }
        }

        // 如果没有找到特定文案，使用清理后的页面文本
        // 取前500个字符作为主要内容
        return text.substring(0, 500);
    }

    /**
     * 使用豆包模型分析内容
     * @param content 原始内容
     * @param modelConfig 模型配置
     * @param rewritePrompt 用户提示词
     * @returns 分析结果
     */
    async function analyzeContentWithDoubao(
        content: string,
        modelConfig: { providerId: string, modelId: string, apiUrl: string, apiHost: string, apiKey: string, type: string },
        rewritePrompt: string
    ): Promise<string> {
        try {
            Log.info("ipAgent.analyzeContentWithDoubao", {
                contentLength: content.length,
                modelId: modelConfig.modelId
            });

            // 验证模型配置
            if (!modelConfig || !modelConfig.providerId || !modelConfig.modelId) {
                throw new Error("未提供有效的模型配置");
            }

            if (!modelConfig.apiUrl) {
                throw new Error("模型API地址未配置");
            }

            if (!modelConfig.apiKey) {
                throw new Error("模型API密钥未配置");
            }

            // 构建豆包专用的提示词
            let prompt = rewritePrompt || `你是一个专业的视频文案分析助手。请分析以下从视频页面提取的HTML内容，识别并提取出其中的视频文案、标题、描述或主要文本内容。

要求：
1. 识别页面中的视频标题、文案描述、字幕文本等内容
2. 过滤掉HTML标签、CSS样式、JavaScript代码等无关内容
3. 提取有意义的中文文本内容
4. 如果页面内容混乱或不完整，请基于可识别的关键信息推断并整理出合理的视频文案
5. 输出应该是一个连贯、完整的视频文案

页面内容：
{{content}}

请直接输出整理后的视频文案（只输出文案内容，不要其他说明）：`;

            // 替换变量
            prompt = prompt.replace(/\{\{content\}\}/g, content);
            prompt = prompt.replace(/\{content\}/g, content);

            Log.info("ipAgent.analyzeContentWithDoubao.config", {
                apiUrl: modelConfig.apiUrl,
                modelId: modelConfig.modelId,
                providerId: modelConfig.providerId,
                promptLength: prompt.length
            });

            // 调用豆包模型API
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000); // 60秒超时

            let requestBody: any;

            // 火山引擎豆包模型使用标准的OpenAI格式
            requestBody = {
                model: modelConfig.modelId,
                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                max_tokens: 2000,
                temperature: 0.7,
                top_p: 0.9
            };

            const aiResponse = await fetch(modelConfig.apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${modelConfig.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!aiResponse.ok) {
                const errorText = await aiResponse.text();
                Log.error("ipAgent.analyzeContentWithDoubao.httpError", {
                    status: aiResponse.status,
                    statusText: aiResponse.statusText,
                    error: errorText.substring(0, 500)
                });
                throw new Error(`豆包模型调用失败 (HTTP ${aiResponse.status}): ${errorText.substring(0, 200)}`);
            }

            const aiData = await aiResponse.json();

            // 详细记录API响应结构以便调试
            Log.info("ipAgent.analyzeContentWithDoubao.responseStructure", {
                hasChoices: !!aiData.choices,
                hasResult: !!aiData.result,
                hasText: !!aiData.text,
                hasContent: !!aiData.content,
                hasOutput: !!aiData.output,
                dataKeys: Object.keys(aiData),
                fullResponse: JSON.stringify(aiData, null, 2)
            });

            // 尝试多种响应格式的解析
            let analyzedText = aiData.choices?.[0]?.message?.content?.trim() ||
                aiData.result?.trim() ||
                aiData.text?.trim() ||
                aiData.content?.trim() ||
                aiData.output?.text?.trim() ||
                aiData.data?.content?.trim() ||
                aiData.message?.content?.trim();

            // 如果还是没有找到，尝试更深层级的查找
            if (!analyzedText) {
                for (const key in aiData) {
                    const value = aiData[key];
                    if (typeof value === 'object' && value !== null) {
                        if (value.content && typeof value.content === 'string') {
                            analyzedText = value.content.trim();
                            break;
                        }
                        if (value.text && typeof value.text === 'string') {
                            analyzedText = value.text.trim();
                            break;
                        }
                        if (value.result && typeof value.result === 'string') {
                            analyzedText = value.result.trim();
                            break;
                        }
                    }
                    if (typeof value === 'string' && value.length > 10) {
                        analyzedText = value.trim();
                        break;
                    }
                }
            }

            if (!analyzedText) {
                Log.error("ipAgent.analyzeContentWithDoubao.emptyResponse", {
                    aiData: aiData,
                    responseType: typeof aiData,
                    responseKeys: Object.keys(aiData)
                });
                throw new Error(`豆包模型返回内容为空。响应结构: ${JSON.stringify(Object.keys(aiData))}`);
            }

            Log.info("ipAgent.analyzeContentWithDoubao.success", {
                resultLength: analyzedText.length,
                resultPreview: analyzedText.substring(0, 100)
            });

            return analyzedText;

        } catch (error: any) {
            Log.error("ipAgent.analyzeContentWithDoubao.error", error);
            throw new Error(`豆包模型分析失败: ${error.message}`);
        }
    }

    // 新版字幕生成接口（使用ZimuShengcheng服务）
    // 流程：前端执行字幕处理 -> 主进程执行FFmpeg -> 返回结果
    ipcMain.handle("ipAgent:generateSubtitleV2", async (event, params: {
        videoPath: string,
        videoWidth: number,
        videoHeight: number,
        userText: string,
        funasrSegments: any[],
        subtitleStyle: any,
        keywordGroups: any[],
        keywordRenderMode?: 'floating' | 'inline-emphasis',
        fontDir: string,
        outputPath: string
    }) => {
        try {
            const {
                videoPath,
                videoWidth,
                videoHeight,
                userText,
                funasrSegments,
                subtitleStyle,
                keywordGroups,
                keywordRenderMode,
                fontDir,
                outputPath
            } = params;

            Log.info("ipAgent.generateSubtitleV2.start", {
                videoPath,
                videoWidth,
                videoHeight,
                hasUserText: !!userText,
                segmentsCount: funasrSegments.length,
                hasKeywordGroups: keywordGroups.length > 0
            });

            // 获取主窗口以进行IPC通信
            const mainWindow = BrowserWindow.getFocusedWindow() ||
                BrowserWindow.getAllWindows()[0];

            if (!mainWindow) {
                throw new Error("无法获取主窗口");
            }

            // 第一步：请求前端执行字幕生成逻辑
            Log.info("ipAgent.generateSubtitleV2.requestFrontend", {
                step: "requesting frontend to process subtitle"
            });

            // 创建一个Promise来等待前端的响应
            const processingResult = await new Promise((resolve, reject) => {
                let timeoutHandle: NodeJS.Timeout | null = null;

                const handleResult = (_event: any, result: any) => {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle);
                        timeoutHandle = null;
                    }

                    if (result && result.success) {
                        resolve(result);
                    } else {
                        reject(new Error(result?.message || "字幕处理失败"));
                    }
                };

                // 使用 ipcMain.once() 来监听前端的一次性响应
                ipcMain.once("ipAgent:generateSubtitleV2Result", handleResult);

                // 设置超时
                timeoutHandle = setTimeout(() => {
                    ipcMain.removeListener("ipAgent:generateSubtitleV2Result", handleResult);
                    reject(new Error("前端字幕处理超时（5分钟）"));
                }, 300000); // 5分钟超时

                // 发送请求给前端
                mainWindow.webContents.send("ipAgent:performSubtitleGeneration", {
                    videoPath,
                    videoWidth,
                    videoHeight,
                    userText,
                    funasrSegments,
                    subtitleStyle,
                    keywordGroups,
                    keywordRenderMode,
                    fontDir,
                    outputPath
                });

                Log.info("ipAgent.generateSubtitleV2.sentToFrontend", {
                    timestamp: new Date().toISOString()
                });
            });

            Log.info("ipAgent.generateSubtitleV2.frontendCompleted", {
                assNormalPath: processingResult.assNormalPath,
                assEffectPath: processingResult.assEffectPath,
                ffmpegCommand: processingResult.ffmpegCommand?.substring(0, 100) + "..."
            });

            // 第二步：如果前端生成了FFmpeg命令，执行它
            if (processingResult.ffmpegCommand) {
                Log.info("ipAgent.generateSubtitleV2.executingFFmpeg", {
                    command: processingResult.ffmpegCommand.substring(0, 100) + "..."
                });

                const execResult = await new Promise((resolve, reject) => {
                    // 🔧 修复：准备环境变量，确保 FFmpeg 能找到所有依赖
                    const env = { ...process.env };

                    // ✅ 添加 FFmpeg 目录到 PATH，确保 Windows 下的 DLL 依赖能被找到
                    const ffmpegPath = getFFmpegExecutablePath();
                    const ffmpegDir = path.dirname(ffmpegPath);
                    const pathSep = process.platform === 'win32' ? ';' : ':';

                    if (!env['PATH']) {
                        env['PATH'] = ffmpegDir;
                    } else if (!env['PATH'].includes(ffmpegDir)) {
                        env['PATH'] = ffmpegDir + pathSep + env['PATH'];
                    }

                    Log.info("ipAgent.generateSubtitleV2.preparingEnv", {
                        ffmpegDir,
                        pathSet: env['PATH']?.substring(0, 100) + "..."
                    });

                    const child = spawn('cmd', ['/c', processingResult.ffmpegCommand], {
                        maxBuffer: 100 * 1024 * 1024,
                        shell: true,
                        env  // ✅ 关键修复：传递环境变量给子进程
                    });

                    let stdout = '';
                    let stderr = '';

                    child.stdout?.on('data', (data: any) => {
                        const dataString = data.toString();
                        stdout += dataString;
                        Log.info("ipAgent.generateSubtitleV2.ffmpegStdout", dataString.substring(0, 200));
                    });

                    child.stderr?.on('data', (data: any) => {
                        const dataString = data.toString();
                        stderr += dataString;
                        Log.info("ipAgent.generateSubtitleV2.ffmpegStderr", dataString.substring(0, 200));
                    });

                    child.on('close', (code: number) => {
                        if (code === 0) {
                            Log.info("ipAgent.generateSubtitleV2.ffmpegSuccess", {
                                code,
                                outputPath
                            });
                            resolve({ success: true, code });
                        } else {
                            Log.error("ipAgent.generateSubtitleV2.ffmpegError", {
                                code,
                                stderr: stderr.substring(0, 500)
                            });
                            reject(new Error(`FFmpeg执行失败，代码: ${code}`));
                        }
                    });

                    child.on('error', (err: any) => {
                        Log.error("ipAgent.generateSubtitleV2.ffmpegProcessError", err);
                        reject(err);
                    });
                });
            }

            // 返回最终结果
            const result = {
                success: true,
                outputPath: outputPath,
                message: "字幕生成成功",
                statistics: processingResult.statistics
            };

            Log.info("ipAgent.generateSubtitleV2.success", {
                outputPath: result.outputPath,
                statistics: result.statistics
            });

            return result;

        } catch (error: any) {
            Log.error("ipAgent.generateSubtitleV2.error", {
                errorType: error?.constructor?.name,
                errorMessage: error?.message,
                errorStack: error?.stack?.substring(0, 500)
            });

            return {
                success: false,
                message: "新版字幕生成失败：" + (error?.message || "未知错误"),
                error: error?.message
            };
        }
    });

    // 获取视频时长
    ipcMain.handle("ipAgent:getVideoDuration", async (event, params: { videoPath: string }) => {
        try {
            let { videoPath } = params;

            // 验证输入
            if (!videoPath || typeof videoPath !== 'string') {
                Log.error("ipAgent.getVideoDuration.invalidInput", { videoPath });
                return {
                    success: false,
                    message: "无效的视频路径"
                };
            }

            // 移除file://前缀
            videoPath = videoPath.replace(/^file:\/\//, '');

            // 验证文件存在
            if (!fs.existsSync(videoPath)) {
                Log.error("ipAgent.getVideoDuration.fileNotFound", { videoPath });
                return {
                    success: false,
                    message: "视频文件不存在"
                };
            }

            Log.info("ipAgent.getVideoDuration", { videoPath, message: "获取视频时长..." });

            // 使用FFmpeg获取视频时长
            const ffmpegArgs = [
                '-i', videoPath
            ];

            let result = '';
            try {
                result = await execFFmpegCommand(ffmpegArgs);
            } catch (err: any) {
                // FFmpeg命令会失败，但我们从错误信息中提取Duration
                result = err.message || err.toString();
            }

            // 从输出中提取Duration: HH:MM:SS.ms格式
            const durationMatch = result.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
            if (durationMatch) {
                const hours = parseInt(durationMatch[1], 10);
                const minutes = parseInt(durationMatch[2], 10);
                const seconds = parseFloat(durationMatch[3]);
                const duration = hours * 3600 + minutes * 60 + seconds;

                Log.info("ipAgent.getVideoDuration.success", { duration, message: "成功获取视频时长" });
                return {
                    success: true,
                    duration: duration
                };
            }

            Log.warn("ipAgent.getVideoDuration.couldNotExtract", { videoPath });
            return {
                success: false,
                message: "无法从视频中提取时长信息"
            };
        } catch (error: any) {
            Log.error("ipAgent.getVideoDuration.error", error);
            return {
                success: false,
                message: "获取视频时长失败: " + (error?.message || error)
            };
        }
    });

    // 执行视频混剪处理
    ipcMain.handle("ipAgent:processVideoMixCut", async (event, params: {
        inputVideo: string,
        replacements: Array<{
            startTime: number,
            duration: number,
            materialPath: string,
            materialDuration: number,
            materialStartOffset: number,
            reason: string,
            // 🔧 新增：每个素材的配置
            displayMode?: 'pip' | 'fullscreen',
            pipPosition?: string,
            pipSizePercent?: number,
            pipScaleMode?: string,
            // 🆕 新增：原视频最小化配置
            originalVideoMinimized?: {
                enabled: boolean,
                shape: 'square' | 'circle',
                position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center',
                sizePercent: number
            }
        }>,
        outputPath: string,
        videoResolution: { width: number; height: number },
        videoDuration: number,  // 原视频时长,用于限制输出
        displayMode?: 'pip' | 'fullscreen'  // 显示模式: pip=画中画, fullscreen=全屏替换 (已废弃,优先使用per-replacement配置)
    }) => {
        try {
            let { inputVideo, replacements, outputPath, videoResolution, videoDuration, displayMode = 'pip' } = params;

            // 验证输入
            if (!inputVideo || !Array.isArray(replacements) || !outputPath) {
                return {
                    success: false,
                    message: "参数不完整"
                };
            }

            // 移除file://前缀
            inputVideo = inputVideo.replace(/^file:\/\//, '');

            // 验证文件存在
            if (!fs.existsSync(inputVideo)) {
                return {
                    success: false,
                    message: "输入视频文件不存在"
                };
            }

            // 验证素材文件
            for (const replacement of replacements) {
                if (!fs.existsSync(replacement.materialPath)) {
                    return {
                        success: false,
                        message: `素材文件不存在: ${replacement.materialPath}`
                    };
                }
            }

            Log.info("ipAgent.processVideoMixCut", {
                inputVideo,
                replacementCount: replacements.length,
                outputPath,
                displayMode: displayMode,
                message: "开始混剪处理..."
            });

            // 构建FFmpeg filter_complex命令
            let filterComplex = '';
            let inputFiles = [inputVideo];
            let currentStream = '[0:v]';

            // 🔧 修复：处理重叠替换点，当后续替换点开始时立即停止前序替换点
            // 计算每个替换点的实际结束时间（考虑后续替换点的干扰）
            const adjustedReplacements = replacements.map((r, i) => {
                let actualEndTime = r.startTime + Math.min(r.duration, r.materialDuration);

                // 检查是否有后续替换点在当前替换点的播放期间开始
                for (let j = i + 1; j < replacements.length; j++) {
                    const nextR = replacements[j];
                    // 如果后续替换点在当前替换点的播放期间开始，立即停止当前替换点
                    if (nextR.startTime < actualEndTime) {
                        actualEndTime = nextR.startTime;
                    }
                }

                return { ...r, actualEndTime };
            });

            console.log('[processVideoMixCut] 📊 替换点时间调整详情:');
            adjustedReplacements.forEach((r, i) => {
                const originalEnd = r.startTime + Math.min(r.duration, r.materialDuration);
                console.log(`[${i}] startTime=${r.startTime.toFixed(3)}, originalEnd=${originalEnd.toFixed(3)}, actualEnd=${r.actualEndTime.toFixed(3)}`);
            });

            for (let i = 0; i < adjustedReplacements.length; i++) {
                const r = adjustedReplacements[i];
                const inputIndex = i + 1;
                const materialStream = `[${inputIndex}:v]`;
                const trimmedMaterialStream = `[m_trim${i}]`;
                const processedMaterialStream = `[m${i}]`;

                // 🔧 修复：优先使用 per-replacement 配置,再使用全局 displayMode
                const mode = r.displayMode || displayMode || 'fullscreen';

                // 素材预处理：根据显示模式缩放
                let scaleFilter = '';
                let overlayParam = '';

                if (mode === 'fullscreen') {
                    // 全屏替换模式：素材缩放到原视频分辨率，全屏显示，居中
                    // 使用模糊背景填充空余部分（模糊度：25）
                    scaleFilter = `scale=${videoResolution.width}:${videoResolution.height}:force_original_aspect_ratio=increase,crop=${videoResolution.width}:${videoResolution.height},boxblur=25:2`;
                    overlayParam = '0:0';  // 左上角对齐
                } else {
                    // 画中画模式：根据配置缩放和定位
                    const pipSizePercent = r.pipSizePercent || 30;
                    const pipWidth = Math.round(videoResolution.width * pipSizePercent / 100);
                    const pipHeight = Math.round(videoResolution.height * pipSizePercent / 100);
                    const pipScaleMode = r.pipScaleMode || 'fit';

                    // 根据缩放模式生成 scale filter
                    let pipScaleFilter = '';
                    if (pipScaleMode === 'fit') {
                        // 保持比例 + 黑边
                        pipScaleFilter = `scale=${pipWidth}:${pipHeight}:force_original_aspect_ratio=decrease`;
                    } else if (pipScaleMode === 'fill') {
                        // 保持比例 + 裁剪
                        pipScaleFilter = `scale=${pipWidth}:${pipHeight}:force_original_aspect_ratio=increase,crop=${pipWidth}:${pipHeight}`;
                    } else {
                        // stretch - 强制拉伸
                        pipScaleFilter = `scale=${pipWidth}:${pipHeight}`;
                    }

                    // 计算 overlay 位置
                    const pipPos = r.pipPosition || 'bottom-right';
                    let pipX = 0, pipY = 0;

                    switch (pipPos) {
                        case 'top-left':
                            pipX = 10; pipY = 10; break;
                        case 'top-center':
                            pipX = (videoResolution.width - pipWidth) / 2; pipY = 10; break;
                        case 'top-right':
                            pipX = videoResolution.width - pipWidth - 10; pipY = 10; break;
                        case 'center-left':
                            pipX = 10; pipY = (videoResolution.height - pipHeight) / 2; break;
                        case 'center':
                            pipX = (videoResolution.width - pipWidth) / 2; pipY = (videoResolution.height - pipHeight) / 2; break;
                        case 'center-right':
                            pipX = videoResolution.width - pipWidth - 10; pipY = (videoResolution.height - pipHeight) / 2; break;
                        case 'bottom-left':
                            pipX = 10; pipY = videoResolution.height - pipHeight - 10; break;
                        case 'bottom-center':
                            pipX = (videoResolution.width - pipWidth) / 2; pipY = videoResolution.height - pipHeight - 10; break;
                        case 'bottom-right':
                        default:
                            pipX = videoResolution.width - pipWidth - 10; pipY = videoResolution.height - pipHeight - 10; break;
                    }

                    scaleFilter = pipScaleFilter;
                    overlayParam = `${Math.round(pipX)}:${Math.round(pipY)}`;
                }

                // 🔧 修复：区分图片和视频处理
                const actualDuration = Math.min(r.duration, r.materialDuration);

                // 判断是否为图片素材
                if (r.isImage) {
                    // 对于图片：使用 fps 将静态图片转换为视频流
                    // fps=25 表示 25 帧/秒，实际时长由 setpts 控制
                    const fpsFilter = `fps=25`;
                    const setptsFilter = `setpts=PTS-STARTPTS+${r.startTime.toFixed(3)}/TB`;

                    filterComplex += `${materialStream}${fpsFilter},${setptsFilter}${trimmedMaterialStream};`;

                    // 全屏模式：根据是否开启原视频最小化选择不同的缩放方式
                    if (mode === 'fullscreen') {
                        // 🔧 修复：开启原视频最小化时，素材需要填满屏幕（increase+crop）
                        const originalMinimized = r.originalVideoMinimized;
                        if (originalMinimized?.enabled) {
                            // 素材全屏铺满：裁剪填充，无黑边
                            const fullscreenScaleFilter = `scale=${videoResolution.width}:${videoResolution.height}:force_original_aspect_ratio=increase,crop=${videoResolution.width}:${videoResolution.height}`;
                            filterComplex += `${trimmedMaterialStream}${fullscreenScaleFilter}${processedMaterialStream};`;
                        } else {
                            // 素材保持比例缩放，留黑边（配合模糊背景）
                            const simpleScaleFilter = `scale=${videoResolution.width}:${videoResolution.height}:force_original_aspect_ratio=decrease`;
                            filterComplex += `${trimmedMaterialStream}${simpleScaleFilter}${processedMaterialStream};`;
                        }
                    } else {
                        filterComplex += `${trimmedMaterialStream}${scaleFilter}${processedMaterialStream};`;
                    }
                } else {
                    // 对于视频：使用 trim 提取片段，然后调整时间戳
                    // 1. trim 提取素材片段（从 materialStartOffset 开始）
                    const trimFilter = `trim=start=${r.materialStartOffset.toFixed(3)}:duration=${actualDuration.toFixed(3)}`;

                    // 2. setpts 调整时间戳：先重置到0，再偏移到输出时间 r.startTime
                    // 这样素材的时间戳就与 overlay enable 的时间范围对齐了
                    // 例如：素材 0-4s → PTS-STARTPTS → 0-4s → +12.68/TB → 12.68-16.68s
                    const setptsFilter = `setpts=PTS-STARTPTS+${r.startTime.toFixed(3)}/TB`;

                    filterComplex += `${materialStream}${trimFilter},${setptsFilter}${trimmedMaterialStream};`;

                    // 全屏模式：根据是否开启原视频最小化选择不同的缩放方式
                    if (mode === 'fullscreen') {
                        // 🔧 修复：开启原视频最小化时，素材需要填满屏幕（increase+crop）
                        const originalMinimized = r.originalVideoMinimized;
                        if (originalMinimized?.enabled) {
                            // 素材全屏铺满：裁剪填充，无黑边
                            const fullscreenScaleFilter = `scale=${videoResolution.width}:${videoResolution.height}:force_original_aspect_ratio=increase,crop=${videoResolution.width}:${videoResolution.height}`;
                            filterComplex += `${trimmedMaterialStream}${fullscreenScaleFilter}${processedMaterialStream};`;
                        } else {
                            // 素材保持比例缩放，留黑边（配合模糊背景）
                            const simpleScaleFilter = `scale=${videoResolution.width}:${videoResolution.height}:force_original_aspect_ratio=decrease`;
                            filterComplex += `${trimmedMaterialStream}${simpleScaleFilter}${processedMaterialStream};`;
                        }
                    } else {
                        filterComplex += `${trimmedMaterialStream}${scaleFilter}${processedMaterialStream};`;
                    }
                }

                // overlay：在指定时间段显示素材
                const outputStream = `[v${i}]`;
                // 🔧 修复：使用半开区间 [start, end) 避免边界重叠
                // between() 是闭区间会导致两个素材在交界点同时显示
                // 改用 gte(t,start)*lt(t,end) 实现半开区间，确保后续素材开始时前序素材立即停止
                const enableExpr = `gte(t,${r.startTime.toFixed(3)})*lt(t,${r.actualEndTime.toFixed(3)})`;

                // 🔧 全屏模式处理
                if (mode === 'fullscreen') {
                    const originalMinimized = r.originalVideoMinimized;

                    if (originalMinimized?.enabled) {
                        // 🆕 场景：素材全屏 + 原视频小窗口
                        const { shape, position, sizePercent } = originalMinimized;
                        const originalSize = Math.floor(videoResolution.width * (sizePercent / 100));

                        // 1. 使用split将原视频流分成两份
                        const splitStream1 = `[split${i}_1]`;
                        const splitStream2 = `[split${i}_2]`;
                        filterComplex += `${currentStream}split=2${splitStream1}${splitStream2};`;

                        // 2. 从第一份生成原视频小窗口（裁剪填满，无黑边）
                        const origStream = `[orig${i}]`;
                        let originalScaled = `${splitStream1}scale=${originalSize}:${originalSize}:force_original_aspect_ratio=increase,crop=${originalSize}:${originalSize}`;

                        // 3. 如果是圆形，添加圆形mask
                        if (shape === 'circle') {
                            const radius = originalSize / 2;
                            // 转换为RGBA，然后使用geq创建圆形遮罩，保持RGB不变，只修改Alpha
                            originalScaled += `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-${radius},Y-${radius}),${radius}),255,0)'`;
                        }
                        originalScaled += origStream;
                        filterComplex += originalScaled + ';';

                        // 4. 从第二份叠加素材全屏
                        const tmpStream = `[tmp${i}]`;
                        filterComplex += `${splitStream2}${processedMaterialStream}overlay=0:0:enable='${enableExpr}'${tmpStream};`;

                        // 5. 计算位置坐标
                        const padding = 50;
                        let x = 0, y = 0;
                        switch (position) {
                            case 'top-left':
                                x = padding; y = padding; break;
                            case 'top-right':
                                x = videoResolution.width - originalSize - padding; y = padding; break;
                            case 'bottom-left':
                                x = padding; y = videoResolution.height - originalSize - padding; break;
                            case 'bottom-right':
                                x = videoResolution.width - originalSize - padding; y = videoResolution.height - originalSize - padding; break;
                            case 'center':
                                x = (videoResolution.width - originalSize) / 2; y = (videoResolution.height - originalSize) / 2; break;
                        }

                        // 6. 叠加原视频小窗口到tmpStream上
                        filterComplex += `${tmpStream}${origStream}overlay=${Math.round(x)}:${Math.round(y)}:enable='${enableExpr}'${outputStream};`;
                    } else {
                        // 原有的全屏替换逻辑（模糊背景）
                        const blurredBgStream = `[blurred_bg${i}]`;
                        filterComplex += `${currentStream}boxblur=25:2:enable='${enableExpr}'${blurredBgStream};`;
                        filterComplex += `${blurredBgStream}${processedMaterialStream}overlay=(W-w)/2:(H-h)/2:enable='${enableExpr}'${outputStream};`;
                    }
                } else {
                    filterComplex += `${currentStream}${processedMaterialStream}overlay=${overlayParam}:enable='${enableExpr}'${outputStream};`;
                }

                inputFiles.push(r.materialPath);
                currentStream = outputStream;
            }

            // 移除最后的分号
            filterComplex = filterComplex.slice(0, -1);

            // 添加trim滤镜限制输出时长为原视频时长
            // 这确保输出视频不会因为素材或其他原因而增长
            filterComplex += `; ${currentStream}trim=start=0:duration=${videoDuration}[final_video]`;

            // 构建FFmpeg命令
            const ffmpegArgs = [
                ...inputFiles.flatMap(f => ['-i', f]),
                '-filter_complex', filterComplex,
                '-map', '[final_video]',  // 使用trim后的最终视频流
                '-map', '0:a?',  // 原视频的音频
                '-c:a', 'copy',  // 音频直接复制不重新编码
                '-c:v', 'libx264',  // 视频使用H.264编码
                '-preset', 'medium',
                '-shortest',  // 输出时长为最短的流(这里应该是原视频)
                '-y',
                outputPath
            ];

            Log.info("ipAgent.processVideoMixCut.command", {
                filterComplex: filterComplex,
                fullCommand: ffmpegArgs.join(' '),
                args: ffmpegArgs.length
            });

            // 🔧 调试：输出完整的 filter_complex 命令到控制台
            console.log('[processVideoMixCut] filter_complex:', filterComplex);
            console.log('[processVideoMixCut] 替换点详情:');
            replacements.forEach((r, idx) => {
                console.log(`  [${idx}] ${r.startTime.toFixed(3)}s - ${(r.startTime + Math.min(r.duration, r.materialDuration)).toFixed(3)}s (${Math.min(r.duration, r.materialDuration).toFixed(3)}s) - ${r.materialPath}`);
            });

            await execFFmpegCommand(ffmpegArgs);

            Log.info("ipAgent.processVideoMixCut.success", {
                outputPath,
                message: "混剪处理完成"
            });

            return {
                success: true,
                outputVideo: outputPath,
                message: "混剪处理完成"
            };
        } catch (error: any) {
            Log.error("ipAgent.processVideoMixCut.error", error);
            return {
                success: false,
                message: "混剪处理失败: " + (error?.message || error)
            };
        }
    });

    // ========== 视频仿写优化 - 新增处理器 ==========

    // 处理抖音分享文本（完整流程：下载视频 + 语音识别 + 仿写）
    ipcMain.handle("ipAgent:processDouyinShare", async (event, params: {
        shareText: string,
        modelConfig: { providerId: string, modelId: string, apiUrl: string, apiHost: string, apiKey: string, type: string },
        rewriteConfig?: {
            style?: 'casual' | 'professional' | 'emotional' | 'humorous',
            length?: 'short' | 'medium' | 'long',
            keepHashtags?: boolean,
            keepEmoji?: boolean
        },
        customPrompt?: string
    }) => {
        try {
            const { shareText, modelConfig, rewriteConfig, customPrompt } = params;

            Log.info("ipAgent.processDouyinShare", {
                textLength: shareText.length,
                modelId: modelConfig?.modelId,
                rewriteConfig,
                mode: 'complete-with-video-and-asr'  // 标记使用完整流程
            });

            // 动态导入集成模块
            const { VideoRewriteIntegration } = await import('./videoRewriteIntegration');

            // 使用完整流程：下载视频 + 音频识别 + 改写
            const result = await VideoRewriteIntegration.processDouyinShareComplete(
                shareText,
                modelConfig,
                rewriteConfig,
                customPrompt,
                (status: string) => {
                    Log.info("ipAgent.processDouyinShare.progress", { status });
                }
            );

            if (result.success) {
                Log.info("ipAgent.processDouyinShare.success", {
                    videoUrl: result.original?.videoUrl,
                    originalLength: result.original?.description?.length,
                    rewrittenLength: result.rewritten?.description?.length,
                    method: 'video-download-and-asr'
                });
            } else {
                Log.error("ipAgent.processDouyinShare.failed", {
                    error: result.error
                });
            }

            return result;

        } catch (error) {
            Log.error("ipAgent.processDouyinShare.error", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });

    // 完整的视频处理流程：下载 + 音频识别 + 文案改写
    ipcMain.handle("ipAgent:processDouyinShareComplete", async (event, params: {
        shareText: string,
        modelConfig: { providerId: string, modelId: string, apiUrl: string, apiHost: string, apiKey: string, type: string },
        rewriteConfig?: {
            style?: 'casual' | 'professional' | 'emotional' | 'humorous',
            length?: 'short' | 'medium' | 'long',
            keepHashtags?: boolean,
            keepEmoji?: boolean
        },
        customPrompt?: string
    }) => {
        try {
            const { shareText, modelConfig, rewriteConfig, customPrompt } = params;

            Log.info("ipAgent.processDouyinShareComplete", {
                textLength: shareText.length,
                modelId: modelConfig?.modelId,
                rewriteConfig
            });

            // 动态导入集成模块
            const { VideoRewriteIntegration } = await import('./videoRewriteIntegration');

            const result = await VideoRewriteIntegration.processDouyinShareComplete(
                shareText,
                modelConfig,
                rewriteConfig,
                customPrompt,
                (status: string) => {
                    // 可以通过 WebSocket 或其他方式发送进度更新
                    Log.info("ipAgent.processDouyinShareComplete.progress", { status });
                }
            );

            if (result.success) {
                Log.info("ipAgent.processDouyinShareComplete.success", {
                    videoUrl: result.original?.videoUrl,
                    originalLength: result.original?.description?.length,
                    rewrittenLength: result.rewritten?.description?.length
                });
            } else {
                Log.error("ipAgent.processDouyinShareComplete.failed", {
                    error: result.error
                });
            }

            return result;

        } catch (error) {
            Log.error("ipAgent.processDouyinShareComplete.error", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });

    // 批量处理抖音分享文本
    ipcMain.handle("ipAgent:processBatchDouyinShares", async (event, params: {
        shareTexts: string[],
        modelConfig: { providerId: string, modelId: string, apiUrl: string, apiHost: string, apiKey: string, type: string },
        rewriteConfig?: {
            style?: 'casual' | 'professional' | 'emotional' | 'humorous',
            length?: 'short' | 'medium' | 'long',
            keepHashtags?: boolean,
            keepEmoji?: boolean
        },
        customPrompt?: string
    }) => {
        try {
            const { shareTexts, modelConfig, rewriteConfig, customPrompt } = params;

            Log.info("ipAgent.processBatchDouyinShares", {
                count: shareTexts.length,
                modelId: modelConfig?.modelId
            });

            // 动态导入集成模块
            const { VideoRewriteIntegration } = await import('./videoRewriteIntegration');

            const results = await VideoRewriteIntegration.processBatchDouyinShares(
                shareTexts,
                modelConfig,
                rewriteConfig,
                customPrompt
            );

            const successCount = results.filter(r => r.success).length;

            Log.info("ipAgent.processBatchDouyinShares.complete", {
                total: results.length,
                success: successCount,
                failed: results.length - successCount
            });

            return {
                success: true,
                results
            };

        } catch (error) {
            Log.error("ipAgent.processBatchDouyinShares.error", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });

    // 导出所有设置
    ipcMain.handle('ipAgent:exportSettings', async (event, data) => {
        try {
            // 如果前端传来了数据，使用前端传的数据（整合了所有配置）
            // 如果没传（旧逻辑），则只读取 ipAgent/settings.json
            let settingsToExport = data;

            if (!settingsToExport) {
                const settingsPath = getSettingsFilePath();
                if (fs.existsSync(settingsPath)) {
                    const content = fs.readFileSync(settingsPath, 'utf-8');
                    settingsToExport = JSON.parse(content);
                } else {
                    settingsToExport = {};
                }
            }

            // 弹出保存对话框
            const result = await dialog.showSaveDialog({
                title: '导出设置',
                defaultPath: `ip-agent-config-${new Date().toISOString().slice(0, 10)}.json`,
                filters: [
                    { name: 'JSON配置文件', extensions: ['json'] }
                ]
            });

            if (!result.canceled && result.filePath) {
                // 保存设置到用户选择的文件
                fs.writeFileSync(result.filePath, JSON.stringify(settingsToExport, null, 2), 'utf-8');

                Log.info('ipAgent.exportSettings.success', { filePath: result.filePath });

                return {
                    success: true,
                    filePath: result.filePath
                };
            }

            return {
                success: false,
                error: '用户取消导出'
            };
        } catch (error) {
            Log.error('ipAgent.exportSettings.error', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });

    // 导入所有设置
    ipcMain.handle('ipAgent:importSettings', async () => {
        try {
            // 弹出文件选择对话框
            const result = await dialog.showOpenDialog({
                title: '导入设置',
                filters: [
                    { name: 'JSON配置文件', extensions: ['json'] }
                ],
                properties: ['openFile']
            });

            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return {
                    success: false,
                    error: '用户取消导入'
                };
            }

            const importPath = result.filePaths[0];

            // 读取配置文件
            const content = fs.readFileSync(importPath, 'utf-8');
            const importedSettings = JSON.parse(content);

            // 保存到设置文件
            const settingsPath = getSettingsFilePath();
            ensureSettingsDir();
            fs.writeFileSync(settingsPath, JSON.stringify(importedSettings, null, 2), 'utf-8');

            Log.info('ipAgent.importSettings.success', { filePath: importPath });

            return {
                success: true,
                filePath: importPath,
                settings: importedSettings
            };
        } catch (error) {
            Log.error('ipAgent.importSettings.error', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });

}; // 结束 registerHandlers 函数

export default {
    init: () => {
        registerHandlers();
        registerCoverTemplateHandlers();
        registerSubtitleTemplateHandlers();
        Log.info("ipAgent.module.initialized");
        console.log("ipAgent.module.initialized");
        console.log('ipAgent module initialized, handlers should already be registered');
    }
};
