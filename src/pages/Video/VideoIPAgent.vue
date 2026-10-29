<script setup lang="ts">
import {ref, computed, onMounted, onUnmounted, watch, onBeforeUnmount, nextTick, onErrorCaptured} from "vue";
import {useRouter} from "vue-router";
// 🔧 在渲染进程中访问 ipcRenderer (已通过 preload 暴露)
const {ipcRenderer} = window.require('electron');
const router = useRouter();
import {t} from "../../lang";
import {buildChatCompletionsUrl} from "../../module/Model/provider/chat-url.cjs";
import {computeRowSpan} from "../../lib/masonry-grid.cjs";
import {Message, Modal} from "@arco-design/web-vue";
import {
    IconSettings,
    IconCloseCircle,
    IconDelete,
    IconExport,
    IconImport,
    IconDownload,
    IconRefresh,
    IconCheckCircleFill,
    IconExclamationCircleFill
} from '@arco-design/web-vue/es/icon';
import ModelSelector from "../../module/Model/ModelSelector.vue";
import ServerSelector from "../../components/Server/ServerSelector.vue";
import OnlineModelSelector from "../../components/common/OnlineModelSelector.vue";
import AudioPlayer from "../../components/common/AudioPlayer.vue";
import SoundPromptSelector from "../Sound/components/SoundPromptSelector.vue";
import SoundPromptEditDialog from "../Sound/components/SoundPromptEditDialog.vue";
import {
    systemVoiceMapCosyvoice,
    isVoiceSupportInstruct,
    INSTRUCT_SUPPORTED_VOICES,
    isVoiceLanguageMatch,
    getVoiceLanguage,
    getRecommendedVoicesForLanguage,
    systemVoices as systemVoicesData
} from "../Sound/config/systemVoices";
import VideoTemplateSelector from "./components/VideoTemplateSelector.vue";
import VideoTemplateEditDialog from "./components/VideoTemplateEditDialog.vue";
import SubtitleStyleSelector from "./components/SubtitleStyleSelector.vue";
import TitleSubtitleSettings from "./components/TitleSubtitleSettings.vue";
import KeywordEffectSelector from "./components/KeywordEffectSelector.vue";
import KeywordMarker from "./components/KeywordMarker.vue";
import KeywordGroupManager from "./components/KeywordGroupManager.vue";
import VideoPlayer from "../../components/common/VideoPlayer.vue";
import CoverEffectSelector from "./components/CoverEffectSelector.vue";
import CoverSettingsDialog from "./components/CoverSettingsDialog.vue";
import TaskLogViewer from "../../components/common/TaskLogViewer.vue";
import WebFileSelectButton from "../../components/common/WebFileSelectButton.vue";
import AgentProgressDialog from "../../components/common/AgentProgressDialog.vue";
import CyberPunkButton from "../../components/common/CyberPunkButton.vue";
import IPAgentWarning from "../../components/Legal/IPAgentWarning.vue";
import SettingMixCut from "../../components/Setting/SettingMixCut.vue";
import SubtitlePreviewCard from "./components/SubtitlePreviewCard.vue";
import AccountManager from "./components/AccountManager.vue";
import {StorageUtil} from "../../lib/storage";
import {getSystemConfigSync} from "../../service/systemConfig";
import {TaskService, TaskRecord, TaskType} from "../../service/TaskService";
import {DataService} from "../../service/DataService";
import {Dialog} from "../../lib/dialog";
import {TimeUtil} from "../../lib/util";
import dayjs from "dayjs";
import {useServerStore} from "../../store/modules/server";
import {useTaskStore} from "../../store/modules/task";
import {useSettingStore} from "../../store/modules/setting";
import {useAuthStore} from "../../store/modules/auth";
import {LevenshteinMatcher} from "../../lib/algorithms/Levenshtein";
import {SentimentAnalyzer} from "../../lib/sentiment/SentimentAnalyzer";
import type {SentimentAnalysisResult} from "../../lib/sentiment/prompts";
// 导入新版字幕生成服务
import {ZimuShengcheng} from "../../service/ZimuShengcheng";
import {ffprobeVideoInfo} from "../../lib/ffprobe";
import {subtitleProcessor} from "../../lib/smartSubtitle/SubtitleProcessor";
import type {SubtitleProcessConfig, ProcessedSubtitle} from "../../types/smartSubtitle";
import {getDefaultTitleSubtitleConfig, generateTitleLines} from "../../lib/subtitle/TitleSubtitleUtils";
import {
    processSmartSubtitle,
    processSmartSubtitleQuick,
    getRecommendedConfig,
    validateResult,
    generateSubtitleSummary,
    generateStatisticsReport
} from "../../service/SmartSubtitleService";
import KeywordGroupService from "../../service/KeywordGroupService";
// 导入一键智能功能
import {executeOneClickIntelligence, type OneClickContext} from "./yijiankaiqi";
// 导入事件驱动等待函数
import {waitForTaskCompletion} from "./yijiankaiqi-event";
// 导入新任务类型
import {VideoTitleGeneration} from "../../task/VideoTitleGeneration";
import {VideoSubtitleAndBGM} from "../../task/VideoSubtitleAndBGM";
// 导入视频模板服务
import {VideoTemplateService} from "../../service/VideoTemplateService";
// 导入系统内置字幕模板
import {SYSTEM_TEMPLATES, isSystemTemplate} from "../../config/systemSubtitleTemplates";
// 导入开发模式检测和系统模板API
import {useDevMode} from "../../composables/useDevMode";
// 系统字幕模板在开发环境下统一通过 saveTemplatesToStorage 持久化并导出到打包配置
// 导入字幕模板导出API
import {
    exportAndDownloadSubtitleTemplates,
    exportAndDownloadSubtitleTemplate,
    duplicateSubtitleTemplate,
    importSubtitleTemplateFromFile
} from "../../api/subtitleTemplate";

const serverStore = useServerStore();
const taskStore = useTaskStore();
const setting = useSettingStore();
const authStore = useAuthStore();

// ==================== 防抖函数 ====================
// 用于防止频繁的watch回调执行
const createDebounce = (func: Function, delay: number = 1000) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    return (...args: any[]) => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
            func(...args);
            timeoutId = null;
        }, delay);
    };
};

// IP大脑相关状态
// 对标账号类型（包含选题库）
type LearnedAccount = {
    name: string;           // 账号名称
    url: string;            // 账号URL（用于去重）
    topicLibrary: Array<{   // 该账号的选题库（最多6个）
        original: string;
        rewritten: string | null;
        isRewriting: boolean;
        script: string | null;
        isGeneratingScript: boolean;
    }>;
};

const showAddIPDialog = ref(false);
const douyinUrl = ref("");
const isAnalyzing = ref(false);
const learnedAccounts = ref<LearnedAccount[]>([]);  // 最多5个
const selectedAccountIndex = ref<number | null>(null);  // 当前选中的对标索引

// 计算属性：当前选中对标的选题库
const topicLibrary = computed(() => {
    if (selectedAccountIndex.value === null) return [];
    const account = learnedAccounts.value[selectedAccountIndex.value];
    if (!account) return [];
    return account.topicLibrary || [];
});

const showBrowserView = ref(false);
const currentWebviewUrl = ref("");
const currentBrowserPlatform = ref<string>("");  // 记录当前打开的浏览器平台

// 选中的标题索引
const selectedTopicIndex = ref<number | null>(null);

// 文案编辑相关
const scriptWordCount = ref(100);
const scriptContent = ref("");
const isGeneratingScript = ref(false);

// AI法务检测相关
const isCheckingLegal = ref(false);
const legalCheckDialogVisible = ref(false);
const legalCheckLoading = ref(false);
const legalCheckResult = ref<{
    hasViolations: boolean;
    risks: { word: string; recommendation: string; reason: string }[];
    analysis: string;
    highlightedText: string;
    fixedText: string;
    totalCount: number;
}>({
    hasViolations: false,
    risks: [],
    analysis: '',
    highlightedText: '',
    fixedText: '',
    totalCount: 0
});

// 🆕 文案生成语言选择
const scriptLanguage = ref('中文');
const languageOptions = [
    {label: '中文（普通话）', value: '中文'},
    {label: '上海话', value: '上海话'},
    {label: '北京话', value: '北京话'},
    {label: '四川话', value: '四川话'},
    {label: '南京话', value: '南京话'},
    {label: '陕西话', value: '陕西话'},
    {label: '闽南语', value: '闽南语'},
    {label: '天津话', value: '天津话'},
    {label: '粤语', value: '粤语'},
    {label: 'English', value: '英语'},
    {label: 'Français', value: '法语'},
    {label: 'Deutsch', value: '德语'},
    {label: 'Русский', value: '俄语'},
    {label: 'Italiano', value: '意大利语'},
    {label: 'Español', value: '西班牙语'},
    {label: 'Português', value: '葡萄牙语'},
    {label: '日本語', value: '日语'},
    {label: '한국어', value: '韩语'}
];

// 标题标签关键词生成相关
const generatedTitle = ref("");  // 生成的标题
const generatedTags = ref("");   // 生成的标签（英文逗号分隔）
const generatedKeywords = ref(""); // 生成的关键词
const isGeneratingTitleTags = ref(false);

// 关键词分类相关
const keywordTabOptions = [
    {label: '重点词', value: '重点词/成语词'},
    {label: '描述词', value: '描述词'},
    {label: '行动词', value: '行动词'},
    {label: '情感词', value: '情感词'}
];
const selectedKeywordTab = ref('重点词/成语词');
const isUpdatingKeywords = ref(false); // 标志：是否正在内部更新关键词
const classifiedKeywords = ref<{ [key: string]: string[] }>({
    '重点词/成语词': [],
    '描述词': [],
    '行动词': [],
    '情感词': []
});

// 关键词输入框的文本内容
const groupKeywordTexts = ref<{ [key: string]: string }>({
    '重点词/成语词': '',
    '描述词': '',
    '行动词': '',
    '情感词': ''
});

// 音视频生成相关
const audioPreviewUrl = ref("");
const audioDuration = ref<number>(0); // 音频时长（秒）
const isGeneratingAudio = ref(false);
const videoPreviewUrl = ref("");
const isGeneratingVideo = ref(false);

// 🆕 音频历史记录功能
const generatedAudioHistory = ref<any[]>([]);  // 历史生成的音频列表
const selectedAudioIndex = ref<number | null>(null);  // 当前选中的音频索引
const selectedAudioUrl = ref("");  // 当前选中用于生成视频的音频URL

// 🆕 发布视频选择功能
const selectedPublishVideoUrl = ref("");  // 选中作为发布内容的视频URL

// 🔧 关键修复：页面生命周期标志，防止卸载后继续创建定时器导致卡死
let isComponentMounted = false;

// 后台任务控制 - 🔧 改为computed自动响应taskStore和一键智能状态变化
const isBackgroundTaskRunning = computed(() => {
    const status = taskStore.getBackgroundTaskStatus();
    return (status.enabled && status.running) || isOneClickRunning.value;
});
const latestAudioTaskId = ref<string>("");
const latestVideoTaskId = ref<string>("");

// 🔧 优化：自动保存开关（一键智能执行时禁用自动保存，避免localStorage频繁写入导致卡顿）
const isAutoSavingEnabled = ref(true);

// 视频处理相关
const isProcessingVideo = ref(false);
const processedVideoUrl = ref("");

// 字幕相关
const selectedSubtitleStyleId = ref("");
const subtitleFontSizeScale = ref(100); // 字体大小缩放百分比，默认100%
const subtitlePosition = ref<'top' | 'center' | 'bottom'>('bottom'); // 字幕位置
const subtitleStyleSelectorRef = ref<any>(null);
const keywordGroupManagerRef = ref<any>(null); // 关键词分组管理组件引用
const enableSubtitle = ref(false);
const enableMixCut = ref(false);  // 画中画混剪开关
const enableSilenceRemoval = ref(false);  // 自动剪气口开关
const enableVideoEnhance = ref(false);  // 画质增强开关
const enableSmartColor = ref(false);  // 智能调色开关
const enableVideoDenoise = ref(false);  // 视频降噪开关
const enableBeautyWhiten = ref(false);  // 美颜美牙开关
const enableAutoFrame = ref(false);  // 自动补帧开关
const enableMotionStab = ref(false);  // 运镜防抖开关
const isGeneratingSubtitle = ref(false);

// 新版字幕生成相关

// 注：minSubtitleDuration 已移至 settings 对象中，仅控制特效字幕，不影响普通字幕

// 字幕模板相关
const subtitleTemplates = ref<any[]>([]);
const showTemplateDialog = ref(false);
const templateName = ref("");
const templateDescription = ref("");
const saveAsSystemTemplate = ref(false);  // ✨ 保存为系统模板选项
const showTemplateList = ref(false);
const selectedSubtitleTemplate = ref<string>('');
const currentTemplateConfig = ref<any>(null);

// 开发模式检测
const {isDev} = useDevMode();

// 🆕 字幕模板编辑模式控制
const isEditingSubtitleTemplate = ref(false);  // 是否处于编辑模式
const editingTemplateId = ref<string>('');     // 当前编辑的模板ID

// ✨ 新增：计算属性 - 获取当前选中的模板对象
const currentSelectedTemplate = computed(() => {
    if (!selectedSubtitleTemplate.value) {
        return null;
    }
    const template = subtitleTemplates.value.find(t => t.id === selectedSubtitleTemplate.value);
    if (template && template.config && !template.config.titleSubtitleConfig) {
        // 确保titleSubtitleConfig总是存在
        template.config.titleSubtitleConfig = getDefaultTitleSubtitleConfig();
    }
    return template;
});

const liveEditingSubtitleStyle = ref<any>(null);

const editingPreviewSubtitleStyle = computed(() => (
    liveEditingSubtitleStyle.value ||
    currentSelectedTemplate.value?.config?.subtitleStyle ||
    currentTemplateConfig.value?.subtitleStyle ||
    null
));

const cloneSubtitleStyle = (style: any) => {
    if (!style || typeof style !== 'object') {
        return null;
    }

    try {
        return JSON.parse(JSON.stringify(style));
    } catch (_error) {
        return {...style};
    }
};

const syncEditingPreviewSubtitleStyle = (fallbackStyle?: any) => {
    if (!isEditingSubtitleTemplate.value) {
        return;
    }

    const latestStyle =
        fallbackStyle ||
        currentSelectedTemplate.value?.config?.subtitleStyle ||
        currentTemplateConfig.value?.subtitleStyle ||
        subtitleStyleSelectorRef.value?.getSelectedStyle?.();

    const styleCopy = cloneSubtitleStyle(latestStyle);
    if (!styleCopy) {
        return;
    }

    liveEditingSubtitleStyle.value = styleCopy;

    if (currentSelectedTemplate.value?.config) {
        currentSelectedTemplate.value.config.subtitleStyle = cloneSubtitleStyle(styleCopy);
    }

    if (currentTemplateConfig.value) {
        currentTemplateConfig.value.subtitleStyle = cloneSubtitleStyle(styleCopy);
    }
};

const currentKeywordRenderMode = computed<'floating' | 'inline-emphasis'>({
    get() {
        const selectedTemplateMode = currentSelectedTemplate.value?.config?.keywordRenderMode;
        if (selectedTemplateMode === 'inline-emphasis') {
            return 'inline-emphasis';
        }

        const currentConfigMode = currentTemplateConfig.value?.keywordRenderMode;
        if (currentConfigMode === 'inline-emphasis') {
            return 'inline-emphasis';
        }

        return 'floating';
    },
    set(value) {
        if (currentSelectedTemplate.value?.config) {
            currentSelectedTemplate.value.config.keywordRenderMode = value;
        }
        if (currentTemplateConfig.value) {
            currentTemplateConfig.value.keywordRenderMode = value;
        }
    }
});

// ✨ 新增：视频尺寸（用于标题字幕）
const videoWidth = ref(1920);
const videoHeight = ref(1080);

// 默认预览样式 - 常数，不会变化
const DEFAULT_PREVIEW_STYLE = {
    fontName: 'Microsoft YaHei Bold',
    fontColor: '#FFFFFF',
    fontSize: 48,
    outlineColor: '#000000',
    outlineWidth: 3,
    backgroundColor: 'transparent',
    backgroundOpacity: 0
} as const;

const previewStyle = ref<any>(structuredClone(DEFAULT_PREVIEW_STYLE));

// 安全获取预览样式 - 确保永远不会返回 undefined
const safePreviewStyle = computed(() => {
    try {
        const current = previewStyle.value;

        // 如果当前值无效，返回默认值
        if (!current || typeof current !== 'object') {
            console.warn('[safePreviewStyle] current 无效，使用默认值:', current);
            return structuredClone(DEFAULT_PREVIEW_STYLE);
        }

        // 确保所有必需字段都存在且有效，使用默认值作为后备
        const result = {
            fontName: (typeof current.fontName === 'string' && current.fontName) ? current.fontName : DEFAULT_PREVIEW_STYLE.fontName,
            fontColor: (typeof current.fontColor === 'string' && current.fontColor) ? current.fontColor : DEFAULT_PREVIEW_STYLE.fontColor,
            fontSize: (typeof current.fontSize === 'number' && current.fontSize > 0) ? current.fontSize : DEFAULT_PREVIEW_STYLE.fontSize,
            outlineColor: (typeof current.outlineColor === 'string' && current.outlineColor) ? current.outlineColor : DEFAULT_PREVIEW_STYLE.outlineColor,
            outlineWidth: (typeof current.outlineWidth === 'number' && current.outlineWidth >= 0) ? current.outlineWidth : DEFAULT_PREVIEW_STYLE.outlineWidth,
            backgroundColor: (typeof current.backgroundColor === 'string' && current.backgroundColor) ? current.backgroundColor : DEFAULT_PREVIEW_STYLE.backgroundColor,
            backgroundOpacity: (typeof current.backgroundOpacity === 'number') ? current.backgroundOpacity : DEFAULT_PREVIEW_STYLE.backgroundOpacity
        };

        // 最后的防卫检查：确保 fontColor 不为 undefined
        if (!result.fontColor || typeof result.fontColor !== 'string') {
            result.fontColor = DEFAULT_PREVIEW_STYLE.fontColor;
        }

        return result;
    } catch (err) {
        console.error('[safePreviewStyle] 计算失败:', err);
        return structuredClone(DEFAULT_PREVIEW_STYLE);
    }
});

// 🆕 辅助函数：计算预览背景颜色（处理 Hex/RGB/RGBA + Opacity）
const getPreviewBackgroundColor = (style: any) => {
    if (!style || !style.backgroundColor || style.backgroundColor === 'transparent') {
        return 'transparent';
    }

    // 如果透明度为0，直接返回 transparent
    if (style.backgroundOpacity === 0) {
        return 'transparent';
    }

    const color = style.backgroundColor;
    const opacity = style.backgroundOpacity ?? 1;

    // 如果已经是 RGBA 格式，直接返回
    if (String(color).startsWith('rgba')) {
        return color;
    }

    // 如果是 Hex 格式 (#RRGGBB)
    if (String(color).startsWith('#')) {
        let hex = color.replace('#', '');
        if (hex.length === 3) {
            hex = hex.split('').map((c: string) => c + c).join('');
        }
        if (hex.length === 8) {
            hex = hex.slice(0, 6);
        }
        if (hex.length === 6) {
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            return `rgba(${r}, ${g}, ${b}, ${opacity})`;
        }
    }

    // 其他情况（如颜色名称），尝试直接返回（可能不支持透明度，但好过全黑）
    return color;
};

/**
 * 🆕 安全获取字幕样式，确保组件已初始化
 * 修复 fontColor 时序问题的核心函数
 */
const getSafeSubtitleStyle = async () => {
    try {
        if (!subtitleStyleSelectorRef.value) {
            console.warn('[getSafeSubtitleStyle] subtitleStyleSelectorRef 未找到');
            return null;
        }

        // 等待组件初始化完成
        if (typeof subtitleStyleSelectorRef.value.waitForInitialization === 'function') {
            await subtitleStyleSelectorRef.value.waitForInitialization();
        }

        // 获取样式
        if (typeof subtitleStyleSelectorRef.value.getSelectedStyle === 'function') {
            return subtitleStyleSelectorRef.value.getSelectedStyle();
        }

        console.warn('[getSafeSubtitleStyle] getSelectedStyle 方法未找到');
        return null;
    } catch (error) {
        console.error('[getSafeSubtitleStyle] 获取样式失败:', error);
        return null;
    }
};

const SUBTITLE_TEMPLATES_STORAGE_KEY = 'zhenqianba_subtitle_templates';
const currentLoadedTemplateId = ref<string>(''); // 跟踪当前加载的模板ID，防止模板参数被workData覆盖
const previousLoadedTemplateId = ref<string>(''); // 跟踪前一个加载的模板ID，用于切换时保存

// 智能字幕处理相关
const enableSmartSubtitle = ref(true);
const smartSubtitleConfig = ref<SubtitleProcessConfig>({
    screenWidth: 1920,
    screenHeight: 1080,
    fontSize: 48,
    fontFamily: 'Arial, sans-serif',
    readabilityFactor: 1.0,
    enableEffects: true,
    enableAI: true,
    subtitlePosition: 'bottom',
    subtitleAlignment: 'center'
});
const isProcessingSmartSubtitle = ref(false);
const processedSubtitleResult = ref<ProcessedSubtitle | null>(null);
const smartSubtitlePreviewText = ref("");
const smartSubtitleReadability = ref(1.0);  // 可读性因子 0.5-2.0

// 视频顶部标题相关
const enableTopTitle = ref(false);
const topTitleStyle = ref({
    fontSize: 48,
    fontColor: '#FFD700',
    backgroundColor: '#000000',
    backgroundOpacity: 0.7,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10
});

// FUNASR字幕识别相关
const useFunasr = ref(false);
const funasrLanguage = ref('zh');
const funasrGenerating = ref(false);
const funasrSegments = ref<any[]>([]);
const srtFile = ref("");
const customText = ref("");

// 关键词特效相关
const enableKeywordEffects = ref(false);
const keywordsExtracting = ref(false);
const extractedKeywords = ref<any[]>([]);
const keywordMarkers = ref<any[]>([]);
const keywordGroups = ref<any[]>([]);
let keywordGroupsInitializeAttempted = false; // 防止死循环的标志
console.log('[VideoIPAgent setup] ✅ 模块已加载，keywordGroups ref已创建');

const keywordEffectSelectorRef = ref<any>(null);
const keywordMarkerRef = ref<any>(null);

// BGM相关
const enableBGM = ref(false);
const selectedBGMPath = ref("");
const bgmVolume = ref(30); // 默认30%音量
const isAddingBGM = ref(false);
const audioPlayerRef = ref<any>(null);  // AudioPlayer组件引用
// 音乐来源
const bgmSourceType = ref<'local' | 'system'>('local');
// 系统乐库分类
const bgmCategories = ref<{ name: string; files: { name: string; path: string }[] }>([]);
const selectedBGMCategory = ref('');
const isLoadingBGMList = ref(false);
const bgmCategorySelectVisible = ref(false);
// 音乐试听相关
const bgmAudioPlayer = ref<HTMLAudioElement | null>(null);
const isPlayingBGM = ref(false);
const bgmPreviewDuration = ref<number>(0);

// 上传视频生成字幕相关
const uploadedVideoPath = ref("");  // 用户上传的视频路径

// 最终生成的带字幕/BGM的视频
const finalVideoUrl = ref("");
// 🆕 对比预览对话框显示状态
const showComparisonDialog = ref(false);
// 🆕 形象视频模板路径
const templateVideoUrl = ref("");
// 🆕 视频播放器refs
const templateVideoPlayer = ref<any>(null);
const finalVideoPlayer = ref<any>(null);
// 🆕 【功能】历史视频对比功能相关
const generatedVideoHistory = ref<any[]>([]);  // 历史生成的视频列表
const selectedHistoryIndex = ref<number | null>(null);  // 当前选中的历史记录索引
const isLoadingHistory = ref(false);  // 历史列表加载状态
const isLoadingHistoryVideo = ref(false);  // 历史视频切换加载状态
const historyTemplateVideoUrl = ref("");  // 历史视频对应的形象URL
const historyVideoUrl = ref("");  // 历史视频URL
let videoSwitchAbortController: AbortController | null = null;  // 用于中止上一次的加载

// 性能监控
let performanceMonitorInterval: any = null;

// 封面相关
const isGeneratingCover = ref(false);
const coverPreviewUrl = ref("");
const showCoverEffectDialog = ref(false);
const coverEffectSelectorRef = ref<any>(null);
const showCoverImageDialog = ref(false);  // 封面图片预览弹窗
const showCoverSettingsDialog = ref(false);  // 封面高级设置对话框
const coverConfig = ref<any>({
    templateId: undefined,
    coverStyle: {}
});
const coverTemplateName = ref("");  // 当前选中的模板名称
const coverStyle = ref<any>({
    // 文字设置
    titleFontSize: 90,
    titleFontColor: '#FFFFFF',
    titlePosition: 'bottom' as 'top' | 'center' | 'bottom',
    titleAlignment: 'center' as 'left' | 'center' | 'right',
    textDirection: 'horizontal' as 'horizontal' | 'vertical',
    textAngle: 0,

    // 背景设置
    hasBackgroundBox: false,
    backgroundColor: '#000000',
    backgroundOpacity: 0.8,
    borderRadius: 0,
    padding: 25,

    // 效果设置
    titleShadowEnabled: true,
    titleShadowColor: '#000000',
    titleShadowOffsetX: 0,
    titleShadowOffsetY: 0,
    titleShadowBlur: 10,
    hasBorder: false,
    borderColor: '#FFFFFF',
    borderWidth: 4,
    hasGlowEffect: false,
    glowColor: '#00BFFF',
    glowIntensity: 8,

    // 副标题
    hasSubtitle: false,
    subtitleFontSize: 60,
    subtitleFontColor: '#FFFFFF',
    subtitleText: '',
    subtitleShadowEnabled: true,      // 副标题默认启用阴影
    subtitleShadowColor: '#000000',   // 阴影颜色，默认黑色
    subtitleShadowOffsetX: 0,         // 阴影X偏移，默认0
    subtitleShadowOffsetY: 0,         // 阴影Y偏移，默认0
    subtitleShadowBlur: 5,            // 副标题阴影模糊，默认5px

    // 底部横幅
    hasBottomBanner: false,
    bannerColor: '#FFD700',
    bannerHeight: 130,

    // 背景处理
    blurBackground: false,
    blurIntensity: 50, // 增强模糊强度
    extractPerson: false,
    personOutlineColor: '#FFFFFF', // 白色描边
    personOutlineWidth: 3 // 描边宽度
});

// 视频仿写模式相关状态
const showVideoRewriteDialog = ref(false);
const videoRewriteUrl = ref("");
const isVideoRewriting = ref(false);
const videoRewriteProgress = ref("");
const recognizedText = ref("");

// 🆕 爆款文案相关状态
const viralVideoType = ref("口播文案");  // 视频类型：口播文案 / 广告投放文案
const viralCopyType = ref("人设型");     // 文案类型
const viralPersona = ref("");            // 行业+人设
const viralProduct = ref("");            // 产品/业务
const viralSellingPoint = ref("");       // 卖点+价格
const viralOther = ref("");              // 其他要求
const viralWordCount = ref(50);         // 目标字数
const isGeneratingCustomPrompt = ref(false);
const customPromptProgress = ref("");
const customPromptOptions = ref<string[]>([]);
const showCustomPromptOptionsDialog = ref(false);
const selectedCustomPromptIndex = ref<number | null>(null);

// IP智能大脑内部页签状态 - IP智能大脑 / 智能视频仿写 / 爆款文案
const activeIPBrainTab = ref('videoWrite'); // 'ipBrain' 或 'videoWrite' 或 'customPrompt'
const lastMainIPBrainTab = ref('videoWrite');

// 视频编辑相关状态
const enableGreenScreen = ref(false);
const greenScreenImagePath = ref("");

// 折叠状态
const collapsed = ref({
    ipBrain: false,
    videoRewrite: false,  // 视频仿写模式
    scriptEdit: false,
    audioVideo: false,
    videoEdit: false,
    titleTags: false,
    subtitleMusic: false,
    coverMake: false,
    videoPublish: false,
    keywordDisplay: true,  // 提取的关键词展示区默认折叠
    generatedKeywords: false  // 🔧 【修复】生成的关键词区默认展开
});

// 视频发布相关状态
const publishPlatforms = ref({
    douyin: {
        checked: false,
        loggedIn: false,
        nickname: '',
        refreshing: false,
        selectedAccountId: '',
        accounts: [] as any[]
    },
    kuaishou: {
        checked: false,
        loggedIn: false,
        nickname: '',
        refreshing: false,
        selectedAccountId: '',
        accounts: [] as any[]
    },
    shipin: {
        checked: false,
        loggedIn: false,
        nickname: '',
        refreshing: false,
        selectedAccountId: '',
        accounts: [] as any[]
    },
    xiaohongshu: {
        checked: false,
        loggedIn: false,
        nickname: '',
        refreshing: false,
        selectedAccountId: '',
        accounts: [] as any[]
    }
});
const isPublishing = ref(false);
const publishProgress = ref('');
const publishResults = ref<any[]>([]);
const showAccountManager = ref(false);
const scheduledPublishTime = ref<string>('');
const isScheduledPublishing = ref(false);
const showSchedulePanel = ref(false);
let scheduledPublishTimer: ReturnType<typeof setTimeout> | null = null;

// 加载各平台的账号列表（用于下拉选择）
const loadPublishAccounts = async () => {
    try {
        const result = await window.$mapi.publish.listAccounts();
        if (result.success && result.data) {
            const platforms = ['douyin', 'kuaishou', 'shipin', 'xiaohongshu'];
            for (const p of platforms) {
                const platAccounts = result.data.filter((a: any) => a.platform === p);
                publishPlatforms.value[p].accounts = platAccounts;
                // 如果有活跃账号且未选择，自动选最新的
                if (!publishPlatforms.value[p].selectedAccountId && platAccounts.length > 0) {
                    const active = platAccounts.find((a: any) => a.loginStatus === 'active');
                    if (active) {
                        publishPlatforms.value[p].selectedAccountId = active.id;
                        publishPlatforms.value[p].checked = true;
                    }
                }
            }
        }
    } catch (e) {
        console.error('加载发布账号列表失败:', e);
    }
};

// 账号管理弹窗关闭后刷新账号列表
watch(showAccountManager, (newVal) => {
    if (!newVal) {
        loadPublishAccounts();
    }
});

// 轮询定时器
let audioCheckInterval: any = null;
let audioCheckTimeout: any = null;
let videoCheckInterval: any = null;
let videoCheckTimeout: any = null;

// 音频生成参数
// audioVoicePromptId 已移除，统一使用 settings.voicePromptId
const audioEmotion = ref("自动"); // 情绪
const audioSpeed = ref(1.0); // 语速
const audioLanguage = ref("中文"); // 🆕 默认中文

// 🆕 语言-音色匹配检测
const voiceLanguageMismatch = computed(() => {
    const promptId = settings.value.voicePromptId;
    if (!promptId || !audioLanguage.value) return false;
    const match = isVoiceLanguageMatch(audioLanguage.value, promptId);
    // undefined 表示无法判断（用户自定义音色），不算不匹配
    return match === false;
});

// 🆕 当前音色适合的语言描述
const currentVoiceLanguageLabel = computed(() => {
    const promptId = settings.value.voicePromptId;
    if (!promptId) return '';
    return getVoiceLanguage(promptId) || '';
});

// 🆕 推荐音色名称列表（用于提示信息）
const recommendedVoiceNames = computed(() => {
    const voiceIds = getRecommendedVoicesForLanguage(audioLanguage.value);
    if (!voiceIds.length) return [];
    return voiceIds
        .filter(id => {
            const voice = systemVoicesData.find(v => v.id === id);
            return voice && voice.supportedInV3Flash;
        })
        .slice(0, 5) // 最多显示5个
        .map(id => {
            const voice = systemVoicesData.find(v => v.id === id);
            return voice ? voice.title : id;
        });
});

// ==================== TTS 模型配置 ====================
interface TtsModelConfig {
    id: string;
    name: string;
    model: string;
    speedRange: { min: number; max: number; step: number };
    emotions: string[];
    supportsClone: boolean;
    description: string;
}

const ttsModelConfigs: TtsModelConfig[] = [
    {
        id: 'aliyun-cosyvoice',
        name: 'V1 阿里云 CosyVoice',
        model: 'cosyvoice-v3-flash',
        speedRange: {min: 0.5, max: 2.0, step: 0.1},
        emotions: ['开心', '悲伤', '愤怒', '恐惧', '惊讶', '厌恶'],
        supportsClone: true,
        description: '中文最强模型，支持语速调整，支持情绪表达（instruction 指令控制）'
    },
    {
        id: 'cosyvoiceV2',
        name: 'T1 多模态语音模型',
        model: 'cosyvoice-v3.5-plus',
        speedRange: {min: 0.5, max: 2.0, step: 0.1},
        emotions: ['开心', '悲伤', '愤怒', '恐惧', '惊讶', '厌恶'],
        supportsClone: true,
        description: 'T1多模态语音模型：基于CosyVoice v3.5-plus，81种丰富音色，支持音调/语速精细调节，多语言/方言支持，效果更自然'
    },
    {
        id: 'runninghub_t2',
        name: 'T2 语音模型',
        model: 'runninghub-t2',
        speedRange: {min: 0.5, max: 2.0, step: 0.1},
        emotions: [],
        supportsClone: true,
        description: 'T2语音模型：基于RunningHub可配置工作流，支持声音克隆，管理员可从后台更换工作流'
    },
    {
        id: 'runninghub_t3',
        name: 'T3 语音模型',
        model: 'runninghub-t3',
        speedRange: {min: 0.5, max: 2.0, step: 0.1},
        emotions: [],
        supportsClone: true,
        description: 'T3语音模型：基于RunningHub可配置工作流，支持声音克隆，管理员可从后台更换工作流'
    },
    {
        id: 'runninghub_t4',
        name: 'T4 语音模型',
        model: 'runninghub-t4',
        speedRange: {min: 0.5, max: 2.0, step: 0.1},
        emotions: [],
        supportsClone: true,
        description: 'T4语音模型：基于RunningHub可配置工作流，支持声音克隆，管理员可从后台更换工作流'
    },
    {
        id: 'runninghub_t5',
        name: 'T5 语音模型',
        model: 'runninghub-t5',
        speedRange: {min: 0.5, max: 2.0, step: 0.1},
        emotions: [],
        supportsClone: true,
        description: 'T5语音模型：基于RunningHub可配置工作流，支持声音克隆，管理员可从后台更换工作流'
    },
    {
        id: 'runninghub_t6',
        name: 'T6 语音模型',
        model: 'runninghub-t6',
        speedRange: {min: 0.5, max: 2.0, step: 0.1},
        emotions: [],
        supportsClone: true,
        description: 'T6语音模型：基于RunningHub可配置工作流，支持声音克隆和情感音频，管理员可从后台更换工作流'
    }
];

// 当前选中的模型配置（计算属性）
const currentTtsModelConfig = computed(() => {
    return ttsModelConfigs.find(m => m.id === settings.value.onlineTtsModel) || ttsModelConfigs[1];
});

// T2/T3/T4/T5/T6模型配置状态
const ttsModelStatus = ref<{
    t2: { configured: boolean },
    t3: { configured: boolean },
    t4: { configured: boolean },
    t5: { configured: boolean },
    t6: { configured: boolean }
}>({
    t2: {configured: false},
    t3: {configured: false},
    t4: {configured: false},
    t5: {configured: false},
    t6: {configured: false}
});

// 检查T2/T3/T4/T5/T6模型配置状态
const checkTtsModelStatus = async () => {
    try {
        const result = await ipcRenderer.invoke('runninghub:tts:getModelStatus');
        if (result.success) {
            ttsModelStatus.value = {
                t2: {configured: result.t2.configured},
                t3: {configured: result.t3.configured},
                t4: {configured: result.t4.configured},
                t5: {configured: result.t5.configured},
                t6: {configured: result.t6.configured}
            };
        }
    } catch (e) {
        console.warn('[TTS] 检查T2/T3模型状态失败:', e);
    }
};

// 情绪选项
const emotionOptions = computed(() => {
    return [
        {value: '自动', label: '自动'},
        {value: '开心', label: '开心'},
        {value: '悲伤', label: '悲伤'},
        {value: '愤怒', label: '愤怒'},
        {value: '恐惧', label: '恐惧'},
        {value: '惊讶', label: '惊讶'},
        {value: '厌恶', label: '厌恶'}
    ];
});

// 语速范围（计算属性）
const speedRange = computed(() => {
    const config = ttsModelConfigs.find(m => m.id === settings.value.onlineTtsModel);
    return config ? config.speedRange : {min: 0.5, max: 2.0, step: 0.1};
});

// 判断当前选中的系统音色是否支持情绪控制
const currentVoiceSupportsInstruct = computed(() => {
    const promptId = settings.value.voicePromptId;
    const isSystemVoice = typeof promptId === 'string' && promptId.startsWith('sys_');
    if (!isSystemVoice) return true; // 复刻音色支持
    const voiceId = systemVoiceMapCosyvoice[promptId as string];
    return voiceId ? INSTRUCT_SUPPORTED_VOICES.includes(voiceId) : false;
});

// 🆕 语言/方言选项
const audioLanguageOptions = [
    {label: "中文（普通话）", value: "中文"},
    {label: "English", value: "英语"},
    {label: "日本語", value: "日语"},
    {label: "한국어", value: "韩语"},
    {label: "Français", value: "法语"},
    {label: "Deutsch", value: "德语"},
    {label: "Русский", value: "俄语"},
    {label: "Italiano", value: "意大利语"},
    {label: "Español", value: "西班牙语"},
    {label: "Português", value: "葡萄牙语"},
    {label: "上海话", value: "上海话"},
    {label: "北京话", value: "北京话"},
    {label: "四川话", value: "四川话"},
    {label: "南京话", value: "南京话"},
    {label: "陕西话", value: "陕西话"},
    {label: "闽南语", value: "闽南语"},
    {label: "天津话", value: "天津话"},
    {label: "粤语", value: "粤语"}
];


// 视频生成参数
const videoTemplateId = ref(0); // 视频形象模板ID
const videoTemplateEditRef = ref<InstanceType<typeof VideoTemplateEditDialog> | null>(null);
const videoTemplateSelectorRef = ref<any>(null);
const soundPromptEditRef = ref<InstanceType<typeof SoundPromptEditDialog> | null>(null);
const soundPromptSelectorRef = ref<InstanceType<typeof SoundPromptSelector> | null>(null);

// 打开音色选择弹窗，并切换到指定Tab
const openVoiceDialog = (tab: 'system' | 'my') => {
    soundPromptSelectorRef.value?.doSelect(tab);
};

// 系统形象弹窗
const showSystemAvatarDialog = () => {
    Message.info(t("系统形象即将上线，敬请期待"));
};

// 我的形象 - 跳转到数字人形象页面
const showMyAvatarDialog = () => {
    router.push('/video?tab=videoTemplate');
};

// 设置相关状态
const showSettingsDialog = ref(false);
const activeSettingsTab = ref('model');  // 当前激活的设置标签页
const isTopbarRouteHostReady = ref(false);

const refreshTopbarRouteHostReady = async () => {
    await nextTick();
    isTopbarRouteHostReady.value = !!document.querySelector('#app-topbar-route-host');
};

onMounted(() => {
    refreshTopbarRouteHostReady();
    window.setTimeout(refreshTopbarRouteHostReady, 0);
});

// 自主算力机状态
const selfServerStatus = ref<'unknown' | 'starting' | 'running' | 'stopped'>('unknown');
const selfServerStatusLoading = ref(false);
const cloudBeautyMode = ref('256o');
let selfServerCheckTimer: ReturnType<typeof setInterval> | null = null;

// 检测自主算力机状态
const checkSelfServerStatus = async () => {
    if (!settings.value.selfServerId || !settings.value.selfServerPublicKey || !settings.value.selfServerPrivateKey) {
        selfServerStatus.value = 'unknown';
        return;
    }
    try {
        await window.$mapi.compshare.setApiKey({
            publicKey: settings.value.selfServerPublicKey,
            privateKey: settings.value.selfServerPrivateKey
        });
        const result = await window.$mapi.compshare.describeInstance({
            uhostIds: [settings.value.selfServerId]
        });
        if (result.success && result.instances && result.instances.length > 0) {
            const state = result.instances[0].State;
            if (state === 'Running') {
                selfServerStatus.value = 'running';
            } else if (state === 'Stopped') {
                selfServerStatus.value = 'stopped';
            } else if (state === 'Starting') {
                selfServerStatus.value = 'starting';
            } else {
                selfServerStatus.value = 'unknown';
            }
        } else {
            selfServerStatus.value = 'unknown';
        }
    } catch (e) {
        console.error('[checkSelfServerStatus] 检测失败:', e);
        selfServerStatus.value = 'unknown';
    }
};

// 启动自主算力机
const startSelfServer = async () => {
    if (!settings.value.selfServerId) {
        Message.error(t('请先填写服务器ID'));
        return;
    }
    if (!settings.value.selfServerPublicKey || !settings.value.selfServerPrivateKey) {
        Message.error(t('请先填写API密钥'));
        return;
    }
    selfServerStatusLoading.value = true;
    selfServerStatus.value = 'starting';
    try {
        await window.$mapi.compshare.setApiKey({
            publicKey: settings.value.selfServerPublicKey,
            privateKey: settings.value.selfServerPrivateKey
        });
        const result = await window.$mapi.compshare.startInstance({
            region: 'cn-wlcb',
            zone: 'cn-wlcb-01',
            projectId: '',
            uhostId: settings.value.selfServerId
        });
        if (result.success) {
            Message.success(t('实例启动命令已发送'));
            setTimeout(() => checkSelfServerStatus(), 3000);
        } else {
            Message.error(result.message || t('启动失败'));
            selfServerStatus.value = 'stopped';
        }
    } catch (e: any) {
        Message.error(e.message || t('启动失败'));
        selfServerStatus.value = 'unknown';
    } finally {
        selfServerStatusLoading.value = false;
    }
};

// 停止自主算力机
const stopSelfServer = async () => {
    if (!settings.value.selfServerId) {
        return;
    }
    selfServerStatusLoading.value = true;
    try {
        await window.$mapi.compshare.setApiKey({
            publicKey: settings.value.selfServerPublicKey,
            privateKey: settings.value.selfServerPrivateKey
        });
        const result = await window.$mapi.compshare.stopInstance({
            region: 'cn-wlcb',
            zone: 'cn-wlcb-01',
            projectId: '',
            uhostId: settings.value.selfServerId
        });
        if (result.success) {
            Message.success(t('实例关闭命令已发送'));
            selfServerStatus.value = 'stopped';
        } else {
            Message.error(result.message || t('关闭失败'));
        }
    } catch (e: any) {
        Message.error(e.message || t('关闭失败'));
    } finally {
        selfServerStatusLoading.value = false;
    }
};

// 启动定时检测
const startSelfServerCheckTimer = () => {
    if (selfServerCheckTimer) {
        clearInterval(selfServerCheckTimer);
    }
    checkSelfServerStatus();
    selfServerCheckTimer = setInterval(() => {
        if (settings.value.videoDigitalHumanModelKey === '__SELF_SERVER__') {
            checkSelfServerStatus();
        }
    }, 60000);
};

// 停止定时检测
const stopSelfServerCheckTimer = () => {
    if (selfServerCheckTimer) {
        clearInterval(selfServerCheckTimer);
        selfServerCheckTimer = null;
    }
};

// IP Agent 设置对象
const settings = ref({
    // 模型设置
    textModelKey: '',
    voiceMode: 'online' as 'local' | 'online',
    voiceModelKey: '',
    onlineTtsModel: 'cosyvoiceV2' as 'aliyun-cosyvoice' | 'runninghub' | 'cosyvoiceV2' | 'runninghub_t2' | 'runninghub_t3' | 'runninghub_t4' | 'runninghub_t5' | 'runninghub_t6',
    voicePromptId: 0,
    asrMode: 'online' as 'local' | 'online',
    asrModelKey: '',
    videoDigitalHumanModelKey: '__CLOUD_1942022968606355458__',

    // 自主算力机配置
    selfServerId: '',          // UHostId
    selfServerApiUrl: '',
    selfServerPublicKey: '',   // API公钥
    selfServerPrivateKey: '',  // API私钥

    // 提示词设置
    scriptPrompt: '你是一个视频口播专家，擅长根据用户给的主题和关键词生成高质量的口播稿件。\n请根据以下要求生成口播稿件：\n\n1. 主题：{title}\n2. 字数：大约{count}字\n\n不增加表情或特殊符号\n请确保稿件内容连贯、有吸引力，并且符合口播的风格。\n请直接输出生成的口播稿件，无需任何额外说明文字。\n禁止输出的词："原文""作者""文章"等词，攻击性强、侮辱性强的词（滚吧、找爸爸去、废物）、骂人的词（傻子、垃圾、蠢蛋），ai常用词（如"这波操作"、"666"）\n\n可用变量：{title}、{count}',
    titleTagPrompt: '你是短视频标题与标签助手。分析文案内容 {content}，生成1个吸引眼球的标题、5-10个相关标签、4个分组关键词。\n\n请严格按以下JSON格式输出，不要输出任何其他内容：\n{"title":"标题内容","tags":["标签1","标签2","标签3"],"keywords":{"重点词/成语词":["词1","词2"],"描述词":["词1"],"行动词":["词1"],"情感词":["词1"]}}\n\n要求：标题不要加书名号《》和引号，每个分组关键词只要0-2个词，标签和关键词不要带#号，不要在标签或关键词后面加括号说明（如"词（说明）"这种格式是禁止的），只输出纯词语，只输出JSON不要有其他文字。',
    topicRewritePrompt: '请仿写以下标题：{{content}}。要求保持原意和风格，但用不同的表达方式，更加吸引人。',
    rewritePrompt: '请根据以下内容 {{content}} 进行仿写，生成 {{count}} 字的内容。要求保持原文的风格和主题，但使用不同的表达方式。',

    // 其他设置
    normalSubtitleX: 50,
    normalSubtitleY: 90,
    disableSmartLayout: false,

    // 静音/停顿相关配置
    silenceThreshold: -40,     // 默认音量阈值 -40dB
    silenceDuration: 1,        // 默认删除超过1秒的停顿
    minPauseDuration: 0.15,    // 默认保留150ms的最小间隔

    // 避让配置（字幕避让设置）
    avoidanceConfig: {
        preferDirection: 'right',
        safeDistance: 20
    },

    // 关键词分组位置配置
    keywordGroupPositions: [],

    // 🆕 新增：画中画混剪配置
    videoMixCutSettings: null as any
});

// 监听模型切换，重置语速超出范围的情况
watch(() => settings.value.onlineTtsModel, (newModel) => {
    const config = ttsModelConfigs.find(m => m.id === newModel);
    if (config) {
        if (audioSpeed.value < config.speedRange.min || audioSpeed.value > config.speedRange.max) {
            audioSpeed.value = 1.0;
        }
    }
});

const resolveAliyunTtsModelByVoiceId = (voiceId?: string) => {
    if (!voiceId) {
        return 'cosyvoice-v3-flash';
    }

    if (voiceId.startsWith('qwen-tts-vc-')) {
        return 'qwen3-tts-vc-2026-01-22';
    }

    // CosyVoice v3/v2 音色ID
    if (voiceId.startsWith('long') || voiceId.startsWith('loong')) {
        return 'cosyvoice-v3-flash';
    }

    return 'cosyvoice-v3-flash';
};
// 导出设置
const exportSettings = async () => {
    try {
        // 1. 收集 IP Agent 主设置 (直接使用当前 UI 状态)
        let ipAgentSettings: any;
        try {
            ipAgentSettings = JSON.parse(JSON.stringify(settings.value));
        } catch (e) {
            ipAgentSettings = structuredClone(settings.value);
            console.warn('[exportSettings] settings JSON转换失败，使用 strutturedClone');
        }

        // 2. 收集提示词 (直接从 settings.value 读取，确保是当前界面上的值)
        const prompts = {
            scriptPrompt: settings.value.scriptPrompt,
            titleTagPrompt: settings.value.titleTagPrompt,
            topicRewritePrompt: settings.value.topicRewritePrompt,
            rewritePrompt: settings.value.rewritePrompt,
            voicePromptId: settings.value.voicePromptId,
            // audioVoicePromptId 已移除，统一使用 settings.voicePromptId
            audioLanguage: audioLanguage.value // 🆕 导出语言设置
        };


        // 3. 收集混剪设置 (从 config store, 因为它有单独的 save 逻辑)
        const videoMixCutSettings = await window.$mapi.config.get('videoMixCutSettings') || {};

        // 4. 收集字幕模板 (从 localStorage)
        let subtitleTemplatesData: any[] = [];
        try {
            const subtitleTemplatesStr = localStorage.getItem(SUBTITLE_TEMPLATES_STORAGE_KEY);
            if (subtitleTemplatesStr) {
                subtitleTemplatesData = JSON.parse(subtitleTemplatesStr);
            }
        } catch (e) {
            console.warn('[exportSettings] 读取本地字幕模板失败:', e);
        }

        // 5. 收集前端状态 (独立 refs)
        const frontendState = {
            selectedSubtitleTemplate: selectedSubtitleTemplate.value,
            keywordGroups: keywordGroups.value, // 包含关键词分组的特效绑定信息
            enableKeywordEffects: enableKeywordEffects.value,
            enableSmartSubtitle: enableSmartSubtitle.value,
            enableSilenceRemoval: enableSilenceRemoval.value,
            // enableMixCut 由 videoMixCutSettings 控制，此处无需重复导出
            subtitleFontSizeScale: subtitleFontSizeScale.value,
            subtitlePosition: subtitlePosition.value,
            // BGM相关
            enableBGM: enableBGM.value,
            bgmVolume: bgmVolume.value,
            // 视频相关
            videoTemplateId: videoTemplateId.value,
            enableTopTitle: enableTopTitle.value,
            topTitleStyle: topTitleStyle.value
        };

        // 6. 打包所有数据
        const exportData = {
            version: '1.2', // 再次升级版本号
            timestamp: new Date().toISOString(),
            ipAgentSettings, // 包含 coords, avoidanceConfig 等
            prompts,
            videoMixCutSettings,
            subtitleTemplates: subtitleTemplatesData,
            frontendState // 新增：前端独立状态
        };

        console.log('[exportSettings] 准备导出数据:', {
            promptsSample: prompts.scriptPrompt?.substring(0, 20),
            hasFrontendState: !!exportData.frontendState
        });

        // 7. 深拷贝以移除Vue响应式代理对象，确保IPC可以序列化
        const exportDataPlain = JSON.parse(JSON.stringify(exportData));

        // 8. 调用后端导出
        const result = await (window as any).$mapi.ipAgent.exportSettings(exportDataPlain);

        // 9. 处理导出结果
        if (result.success) {
            Message.success(t("设置已导出到：") + result.filePath);
        } else if (result.error) {
            if (result.error !== '用户取消导出') {
                Message.error(t("导出失败：") + result.error);
            }
        }
    } catch (error) {
        console.error("导出设置错误:", error);
        Message.error(t("导出设置出错"));
    }
};

// 保存设置处理函数
const handleSettingsOk = async () => {
    // 1. 如果正在编辑字幕模板，拦截保存操作
    if (activeSettingsTab.value === 'subtitle' && isEditingSubtitleTemplate.value) {
        try {
            // 调用保存模板逻辑
            await handleSaveButtonClick();
            Message.success(t('字幕模板已保存'));
            // 保存后不关闭对话框，或者询问用户？
            // 这里选择不关闭，让用户确认无误后手动关闭或继续编辑
            return;
        } catch (error) {
            console.error('保存模板失败:', error);
            Message.error(t('保存字幕模板失败'));
            return;
        }
    }

    // 2. 调用完整的 saveSettings 函数执行保存
    try {
        console.log('[handleSettingsOk] 开始保存设置...');

        // 先保存到 localStorage 作为备份
        const SETTINGS_KEY = 'videoIPAgent_settings';
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value));
        console.log('[handleSettingsOk] ✅ 已保存到 localStorage');

        // 调用完整的 saveSettings 函数（包括 IPC、提示词保存等）
        await saveSettings();

        // 关闭对话框
        showSettingsDialog.value = false;

    } catch (error) {
        console.error("保存设置失败:", error);
        Message.error(t("保存设置失败"));
    }
};

// 🔧 从 localStorage 加载设置
const loadSettingsFromLocalStorage = () => {
    try {
        const SETTINGS_KEY = 'videoIPAgent_settings';
        const saved = localStorage.getItem(SETTINGS_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            // 🔧 修复：textModelKey 以文件设置（IPC加载）为准，
            // localStorage 快照可能过期，不能用它覆盖已选的模型（否则会回退到旧的内置豆包）
            delete parsed.textModelKey;
            // 合并保存的设置到当前设置，保留默认值
            settings.value = {
                ...settings.value,
                ...parsed
            };
            console.log('[loadSettingsFromLocalStorage] ✅ 已从localStorage加载设置');
        }
    } catch (error) {
        console.warn('[loadSettingsFromLocalStorage] ⚠️ 加载设置失败:', error);
    }
};

// 🔧 初始化：页面加载时从 localStorage 恢复设置
setTimeout(() => {
    loadSettingsFromLocalStorage();
}, 100);

// 导入设置
const importSettings = async (importData?: any) => {
    try {
        let data: any;

        if (importData) {
            data = importData;
            console.log('[importSettings] 📥 使用传入的配置数据，frontendState:', data.frontendState ? {
                selectedSubtitleTemplate: data.frontendState.selectedSubtitleTemplate,
                hasKeywordGroups: !!data.frontendState.keywordGroups,
                enableKeywordEffects: data.frontendState.enableKeywordEffects
            } : '无');
        } else {
            const result = await (window as any).$mapi.ipAgent.importSettings();
            if (result.success && result.settings) {
                data = result.settings;
            } else if (result.error && result.error !== '用户取消导入') {
                Message.error(t("导入失败：") + result.error);
                return;
            } else {
                return;
            }
        }

        if (data) {
            console.log('[importSettings] 导入数据:', data);

            // 1. 恢复 IP Agent 主设置
            if (data.ipAgentSettings) {
                // 深度合并设置，特别注意 keywordGroupPositions 和 avoidanceConfig
                settings.value = {...settings.value, ...data.ipAgentSettings};

                // 强制确保数组和对象被正确替换
                if (data.ipAgentSettings.keywordGroupPositions) {
                    settings.value.keywordGroupPositions = data.ipAgentSettings.keywordGroupPositions;
                }
                if (data.ipAgentSettings.avoidanceConfig) {
                    settings.value.avoidanceConfig = data.ipAgentSettings.avoidanceConfig;
                }

                console.log('[importSettings] 已恢复主设置');
            } else if (data.settings) {
                // 兼容旧格式
                settings.value = {...settings.value, ...data.settings};
            }

            // 2. 恢复提示词 (优先从 prompts 字段，如果没有则从 settings)
            if (data.prompts) {
                await window.$mapi.config.set('prompts', data.prompts);

                // 立即更新 UI
                if (data.prompts.scriptPrompt) settings.value.scriptPrompt = data.prompts.scriptPrompt;
                if (data.prompts.titleTagPrompt) settings.value.titleTagPrompt = data.prompts.titleTagPrompt;
                if (data.prompts.topicRewritePrompt) settings.value.topicRewritePrompt = data.prompts.topicRewritePrompt;
                if (data.prompts.rewritePrompt) settings.value.rewritePrompt = data.prompts.rewritePrompt;
                if (data.prompts.voicePromptId !== undefined) {
                    settings.value.voicePromptId = data.prompts.voicePromptId;
                }
                // 兼容旧数据：如果有 audioVoicePromptId，同步到 settings.voicePromptId
                if (data.prompts.audioVoicePromptId !== undefined && !settings.value.voicePromptId) {
                    settings.value.voicePromptId = data.prompts.audioVoicePromptId;
                }

                // 🆕 恢复语言设置
                if (data.prompts.audioLanguage) {
                    audioLanguage.value = data.prompts.audioLanguage;
                }

                console.log('[importSettings] 已恢复提示词');

            } else if (data.ipAgentSettings) {
                // 如果没有 prompts 字段，尝试从 ipAgentSettings 恢复
                if (data.ipAgentSettings.scriptPrompt) settings.value.scriptPrompt = data.ipAgentSettings.scriptPrompt;
            }

            // 3. 恢复混剪设置
            if (data.videoMixCutSettings) {
                await window.$mapi.config.set('videoMixCutSettings', data.videoMixCutSettings);
                console.log('[importSettings] 已恢复混剪设置');
                if (settingMixCutRef.value && typeof settingMixCutRef.value.save === 'function') {
                    // TODO: 考虑是否需要刷新组件
                }
            }

            // 4. 恢复字幕模板 - 【关键修复】只导入用户模板，不覆盖系统模板
            if (data.subtitleTemplates && Array.isArray(data.subtitleTemplates)) {
                // 只保留非系统模板（用户创建的模板）
                const userTemplatesFromImport = data.subtitleTemplates.filter((t: any) =>
                    !isSystemTemplate(t.id) && t.isSystem !== true && t.is_system !== 1
                );

                // 保存用户模板到 localStorage
                localStorage.setItem(SUBTITLE_TEMPLATES_STORAGE_KEY, JSON.stringify(userTemplatesFromImport));

                // 合并：硬编码系统模板 + 导入的用户模板
                const systemTemplates = JSON.parse(JSON.stringify(SYSTEM_TEMPLATES));
                subtitleTemplates.value = [...systemTemplates, ...userTemplatesFromImport];

                console.log('[importSettings] 已恢复字幕模板：系统模板', systemTemplates.length, '个 + 用户模板', userTemplatesFromImport.length, '个 = 总计', subtitleTemplates.value.length, '个');
            }

            // 5. 恢复前端独立状态
            if (data.frontendState) {
                const fs = data.frontendState;
                if (fs.keywordGroups) keywordGroups.value = fs.keywordGroups;
                if (fs.enableKeywordEffects !== undefined) enableKeywordEffects.value = fs.enableKeywordEffects;
                if (fs.enableSmartSubtitle !== undefined) enableSmartSubtitle.value = fs.enableSmartSubtitle;
                if (fs.enableSilenceRemoval !== undefined) enableSilenceRemoval.value = fs.enableSilenceRemoval;
                if (fs.subtitleFontSizeScale !== undefined) subtitleFontSizeScale.value = fs.subtitleFontSizeScale;
                if (fs.subtitlePosition !== undefined) subtitlePosition.value = fs.subtitlePosition;
                if (fs.enableBGM !== undefined) enableBGM.value = fs.enableBGM;
                if (fs.bgmVolume !== undefined) bgmVolume.value = fs.bgmVolume;
                if (fs.videoTemplateId !== undefined) videoTemplateId.value = fs.videoTemplateId;
                if (fs.enableTopTitle !== undefined) enableTopTitle.value = fs.enableTopTitle;
                if (fs.topTitleStyle) topTitleStyle.value = fs.topTitleStyle;

                console.log('[importSettings] 已恢复前端独立状态');

                // 🆕 【关键修复】在最后设置 selectedSubtitleTemplate，并主动加载模板
                console.log('[importSettings] 🔍 frontendState检查:', {
                    hasSelectedSubtitleTemplate: !!fs.selectedSubtitleTemplate,
                    selectedId: fs.selectedSubtitleTemplate,
                    subtitleTemplatesCount: subtitleTemplates.value.length,
                    templateIds: subtitleTemplates.value.map(t => t.id)
                });

                if (fs.selectedSubtitleTemplate && subtitleTemplates.value.length > 0) {
                    selectedSubtitleTemplate.value = fs.selectedSubtitleTemplate;
                    console.log('[importSettings] ✅ 设置选中的字幕模板:', fs.selectedSubtitleTemplate);

                    // 主动加载模板以应用所有配置
                    const template = subtitleTemplates.value.find(t => t.id === fs.selectedSubtitleTemplate);
                    if (template) {
                        console.log('[importSettings] ✅ 主动加载字幕模板:', template.name, '- 配置关键词分组数:', template.config?.keywordGroups?.length || 0);
                        await loadTemplate(template);
                        console.log('[importSettings] ✅ 模板加载完成');
                    } else {
                        console.warn('[importSettings] ❌ 找不到模板:', fs.selectedSubtitleTemplate, '- 可用模板:', subtitleTemplates.value.map(t => t.id));
                    }
                } else {
                    console.warn('[importSettings] ❌ 无法设置选中模板 - selectedSubtitleTemplate:', fs.selectedSubtitleTemplate, '- subtitleTemplates长度:', subtitleTemplates.value.length);
                }
            }

            // 6. 自动保存 (仅当是通过 importData 传入时，或者是明确的导入操作)
            await saveSettings();

            // 如果不是自动加载的（即有 importData），则显示成功消息
            if (!importData) {
                Message.success(t("设置已成功导入"));
            } else {
                console.log('[importSettings] 默认配置已自动加载应用');
            }
        }
    } catch (error) {
        console.error("导入设置错误:", error);
        if (!importData) {
            Message.error(t("导入设置出错"));
        }
    }
};

const settingMixCutRef = ref<any>(null);

// 🔧 调试：监听showSettingsDialog的变化
watch(showSettingsDialog, (newVal, oldVal) => {
    console.log('[showSettingsDialog watch] 值已改变:', {
        oldVal,
        newVal,
        timestamp: new Date().toISOString()
    });
    if (newVal && settings.value.videoDigitalHumanModelKey === '__SELF_SERVER__') {
        startSelfServerCheckTimer();
    } else if (!newVal) {
        stopSelfServerCheckTimer();
    }
});

// 🔧 监听音色变化，自动保存到后端（实现双向同步）
watch(() => settings.value.voicePromptId, (newValue, oldValue) => {
    if (newValue && newValue !== oldValue) {
        console.log('[watch voicePromptId] 音色已更改:', oldValue, '->', newValue);
        // 自动保存设置到后端
        window.$mapi.ipAgent.saveSettings({
            settings: JSON.parse(JSON.stringify(settings.value))
        }).then(() => {
            console.log('[watch voicePromptId] 设置已自动保存到后端');
        }).catch((err: any) => {
            console.warn('[watch voicePromptId] 自动保存设置失败:', err);
        });
    }
});

// 🔧 监听数字人模型切换，自动保存到后端（实现双向同步）
watch(() => settings.value.videoDigitalHumanModelKey, (newValue, oldValue) => {
    if (newValue !== oldValue) {
        console.log('[watch videoDigitalHumanModelKey] 数字人模型已更改:', oldValue, '->', newValue);
        // 自动保存设置到后端
        window.$mapi.ipAgent.saveSettings({
            settings: JSON.parse(JSON.stringify(settings.value))
        }).then(() => {
            console.log('[watch videoDigitalHumanModelKey] 设置已自动保存到后端');
        }).catch((err: any) => {
            console.warn('[watch videoDigitalHumanModelKey] 自动保存设置失败:', err);
        });
    }
});

// 日志相关
const showLogDialog = ref(false);
const currentLogTaskId = computed(() => latestVideoTaskId.value || latestAudioTaskId.value);

// 主题检测 - 使用 MutationObserver 监听 body data-theme 变化
const currentTheme = ref(document.body.getAttribute('data-theme') || 'dark');
const isLightTheme = computed(() => currentTheme.value === 'soft-light');

// 监听 body data-theme 属性变化（带防抖，避免主题切换时多次触发重渲染）
let _themeRaf = 0;
const themeObserver = new MutationObserver(() => {
    cancelAnimationFrame(_themeRaf);
    _themeRaf = requestAnimationFrame(() => {
        currentTheme.value = document.body.getAttribute('data-theme') || 'dark';
    });
});
themeObserver.observe(document.body, {attributes: true, attributeFilter: ['data-theme']});
onUnmounted(() => {
    cancelAnimationFrame(_themeRaf);
    themeObserver.disconnect();
});

// 脱敏手机号
const maskedPhone = computed(() => {
    const phone = authStore.phone || '';
    if (phone && phone.length >= 7) {
        return phone.slice(0, 3) + '****' + phone.slice(-4);
    }
    return phone || '';
});

// 一键智能相关状态
const isOneClickRunning = ref(false);

// 🔧 计算属性：检查是否有任何任务在运行中
const hasRunningTasks = computed(() => {
    return isOneClickRunning.value ||
        isGeneratingScript.value ||
        isGeneratingTitleTags.value ||
        isGeneratingAudio.value ||
        isGeneratingVideo.value ||
        isGeneratingSubtitle.value ||
        isGeneratingCover.value;
});

// 🔧 【防守修复】计算属性：确保最终视频URL总是clean的（解析JSON、确保file://前缀）
const cleanFinalVideoUrl = computed(() => {
    const url = finalVideoUrl.value;
    if (!url) return '';

    // 如果URL看起来像JSON，解析它
    let cleanUrl = url;
    if (typeof url === 'string' && (url.startsWith('{') || url.includes('{"'))) {
        try {
            const parsed = JSON.parse(url);
            cleanUrl = parsed.finalVideoUrl || parsed.url || url;
        } catch (e) {
            // 解析失败，使用原值
        }
    }

    // 确保有file://前缀
    return cleanUrl.startsWith('file://') ? cleanUrl : 'file://' + cleanUrl;
});

// 🔧 【防守修复】计算属性：确保历史视频URL总是clean的
const cleanHistoryVideoUrl = computed(() => {
    const url = historyVideoUrl.value;
    if (!url) return '';

    // 如果URL看起来像JSON，解析它
    let cleanUrl = url;
    if (typeof url === 'string' && (url.startsWith('{') || url.includes('{"'))) {
        try {
            const parsed = JSON.parse(url);
            cleanUrl = parsed.finalVideoUrl || parsed.url || url;
        } catch (e) {
            // 解析失败，使用原值
        }
    }

    // 确保有file://前缀
    return cleanUrl.startsWith('file://') ? cleanUrl : 'file://' + cleanUrl;
});

const showProgressDialog = ref(false);
const currentStep = ref('');
const progressPercent = ref(0);
const progressErrorMessage = ref('');
const canCancelProgress = ref(true);

// 情感分析器实例（懒加载）
let sentimentAnalyzer: SentimentAnalyzer | null = null;

// 打开设置对话框
const openSettingsDialog = async () => {
    try {
        console.log('[openSettingsDialog] 开始打开设置对话框');

        // 🔧 【修复】强制加载最新的设置数据
        console.log('[openSettingsDialog] 正在加载最新设置...');
        try {
            await loadSettings();
            console.log('[openSettingsDialog] ✅ 设置加载完成');

            // 确保所有关键词组都有配置对象（初始化keywordGroupPositions）
            if (keywordGroups.value && keywordGroups.value.length > 0) {
                if (!settings.value.keywordGroupPositions) {
                    settings.value.keywordGroupPositions = [];
                }
                keywordGroups.value.forEach((group) => {
                    if (!settings.value.keywordGroupPositions.find(p => p.groupName === group.name)) {
                        settings.value.keywordGroupPositions.push({
                            groupName: group.name,
                            effectX: undefined,
                            effectY: undefined,
                            safeDistance: undefined
                        });
                    }
                });
            }
        } catch (e) {
            console.warn('[openSettingsDialog] 设置加载失败，使用缓存:', e);
        }

        // 🔧 不再等待 serverStore，直接打开对话框（serverStore 会在后台初始化）

        // 确保 previewStyle 有有效值（safePreviewStyle 计算属性保证这一点）
        if (!previewStyle.value || typeof previewStyle.value !== 'object') {
            console.warn('[openSettingsDialog] previewStyle.value 无效，使用默认值');
            previewStyle.value = structuredClone(DEFAULT_PREVIEW_STYLE);
        } else if (!previewStyle.value.fontColor) {
            console.warn('[openSettingsDialog] previewStyle.value.fontColor 无效，使用默认值');
            previewStyle.value.fontColor = DEFAULT_PREVIEW_STYLE.fontColor;
        }

        // 显示设置对话框
        console.log('[openSettingsDialog] 设置 showSettingsDialog.value = true');
        showSettingsDialog.value = true;

        // 检查T2/T3模型配置状态
        checkTtsModelStatus().catch(e => console.warn('[openSettingsDialog] T2/T3/T4/T5/T6状态检查失败:', e));
        console.log('[openSettingsDialog] 设置后的 showSettingsDialog.value:', showSettingsDialog.value);

        // 等待下一帧渲染完成
        await nextTick();
        console.log('[openSettingsDialog] 已完成 nextTick');
        console.log('[openSettingsDialog] nextTick后的 showSettingsDialog.value:', showSettingsDialog.value);

        // 检查对话框是否存在于DOM
        setTimeout(() => {
            const modal = document.querySelector('[class*="arco-modal"]');
            if (modal) {
                const style = window.getComputedStyle(modal);
                console.log('[openSettingsDialog] 对话框DOM检查:', {
                    exists: true,
                    display: style.display,
                    visibility: style.visibility,
                    zIndex: style.zIndex,
                    opacity: style.opacity
                });
            } else {
                console.warn('[openSettingsDialog] 对话框在DOM中不存在');
            }
        }, 100);

        // 尝试从 SubtitleStyleSelector 获取当前样式并更新预览
        try {
            const selectedStyle = subtitleStyleSelectorRef.value?.getSelectedStyle?.();
            console.log('[openSettingsDialog] 获取的 selectedStyle:', {
                exists: !!selectedStyle,
                hasFontColor: selectedStyle?.fontColor !== undefined,
                fontColor: selectedStyle?.fontColor
            });

            if (selectedStyle && typeof selectedStyle === 'object' && selectedStyle.fontColor) {
                console.log('[openSettingsDialog] 更新预览样式');
                updatePreviewStyle(selectedStyle);
            } else if (!selectedStyle) {
                console.warn('[openSettingsDialog] selectedStyle 为 undefined');
            } else if (!selectedStyle.fontColor) {
                console.warn('[openSettingsDialog] selectedStyle.fontColor 为 undefined');
            }
        } catch (err) {
            console.warn('[openSettingsDialog] 获取 selectedStyle 失败:', err);
            // 失败时保持 previewStyle 的默认值，safePreviewStyle 保证总是有效
        }

        // 🔧 强制重新渲染，确保对话框显示
        await nextTick();
        await nextTick();

        console.log('[openSettingsDialog] 完成，showSettingsDialog.value:', showSettingsDialog.value);
    } catch (error) {
        console.error('[openSettingsDialog] 打开设置对话框失败:', error);
        // 即使初始化失败，也要显示对话框
        showSettingsDialog.value = true;
        console.error('[openSettingsDialog] 错误处理后强制显示对话框');
    }
};

const openSubtitleTemplateSettings = async () => {
    activeSettingsTab.value = 'subtitle';
    await openSettingsDialog();
};

const openMixCutMaterialDialog = async () => {
    activeSettingsTab.value = 'mixCut';
    await openSettingsDialog();
};

// 🔧 调试：手动处理 voiceModelKey 更新并备份
const handleVoiceModelKeyUpdate = (val: string) => {
    console.log('[Debug] voiceModelKey 手动更新:', val);
    if (val) {
        settings.value.voiceModelKey = val;
        localStorage.setItem('backup_voiceModelKey', val);
    }
};

// 处理设置对话框关闭
const handleSettingsCancel = () => {
    console.log('[handleSettingsCancel] 关闭设置对话框');
    showSettingsDialog.value = false;

    // 🆕 修复：关闭对话框时，强制退出字幕模板编辑模式
    if (isEditingSubtitleTemplate.value) {
        console.log('[handleSettingsCancel] 自动退出字幕模板编辑模式');
        isEditingSubtitleTemplate.value = false;
        editingTemplateId.value = '';
        selectedSubtitleTemplate.value = '';
    }
};

// 保存设置
const saveSettings = async () => {
    try {
        console.log('[Debug] saveSettings value:', JSON.stringify(settings.value));

        // 🆕 修复：保存设置时，如果处于字幕模板编辑模式，自动退出
        if (isEditingSubtitleTemplate.value) {
            console.log('[saveSettings] 保存设置，自动退出字幕模板编辑模式');
            isEditingSubtitleTemplate.value = false;
            editingTemplateId.value = '';
            selectedSubtitleTemplate.value = '';
        }

        // 🔧 备份 voiceModelKey，确保在意外丢失时可以恢复
        if (settings.value.voiceModelKey) {
            localStorage.setItem('backup_voiceModelKey', settings.value.voiceModelKey);
        }

        // 🔧 关键修复：通过 JSON 序列化来移除所有 Proxy 包装
        // structuredClone 无法处理 Vue Proxy 对象，改用 JSON.parse(JSON.stringify(...))
        let settingsData: any;
        try {
            settingsData = JSON.parse(JSON.stringify(settings.value));
            console.log('[saveSettings] ✅ 已通过 JSON 转换成功清理所有 Proxy 对象');
        } catch (jsonError) {
            console.error('[saveSettings] JSON 转换失败:', jsonError);
            // 如果 JSON 序列化失败，则使用 structuredClone 作为备选
            settingsData = structuredClone(settings.value);
        }

        const result = await window.$mapi.ipAgent.saveSettings({
            settings: settingsData
        });

        if (result && result.success === true) {
            // 💾 保存提示词配置到 config.json
            try {
                await window.$mapi.config.set('prompts', {
                    scriptPrompt: settings.value.scriptPrompt,
                    titleTagPrompt: settings.value.titleTagPrompt,
                    topicRewritePrompt: settings.value.topicRewritePrompt,
                    rewritePrompt: settings.value.rewritePrompt
                });
                console.log('[saveSettings] ✅ 提示词已保存到 config.json');
            } catch (promptError) {
                console.warn('[saveSettings] ⚠️ 保存提示词失败（不影响主流程）:', promptError);
            }

            // 保存混剪配置
            if (settingMixCutRef.value && typeof settingMixCutRef.value.save === 'function') {
                await settingMixCutRef.value.save();
            }

            Message.success(t("设置已保存"));

            // 保存字幕样式并更新模板中的 styleId
            let styleSaved = false;
            try {
                console.log('[saveSettings] 准备保存字幕样式...', {
                    selectedSubtitleTemplate: selectedSubtitleTemplate.value,
                    hasSubtitleStyleSelectorRef: !!subtitleStyleSelectorRef.value
                });

                let subtitleStyle = subtitleStyleSelectorRef.value?.getSelectedStyle?.();

                console.log('[saveSettings] 获取到的字幕样式:', {
                    hasStyle: !!subtitleStyle,
                    style: subtitleStyle ? {
                        fontName: subtitleStyle?.fontName,
                        fontColor: subtitleStyle?.fontColor,
                        backgroundColor: subtitleStyle?.backgroundColor
                    } : null
                });

                if (subtitleStyle) {
                    // 🔧 关键修复：通过 JSON 序列化来移除 Proxy 包装，而不是 structuredClone
                    let cleanedStyle: any;
                    try {
                        cleanedStyle = JSON.parse(JSON.stringify(subtitleStyle));
                    } catch (styleJsonError) {
                        console.warn('[saveSettings] 样式 JSON 转换失败，尝试 structuredClone:', styleJsonError);
                        cleanedStyle = structuredClone(subtitleStyle);
                    }

                    console.log('[saveSettings] 准备保存样式到模板配置');

                    // 🔧 关键修复：参考特效字幕的方式，直接将完整样式对象保存到模板配置中
                    // 不再依赖数据库的 styleId 方式
                    if (selectedSubtitleTemplate.value && subtitleTemplates.value.length > 0) {
                        const template = subtitleTemplates.value.find(t => t.id === selectedSubtitleTemplate.value);

                        if (template && template.config) {
                            // 🔧 关键：直接保存完整样式对象到模板配置（参考特效字幕的 keywordGroupsStyles）
                            template.config.subtitleStyle = cleanedStyle;
                            console.log('[saveSettings] ✅ 已将完整样式对象保存到模板配置:', {
                                fontColor: cleanedStyle.fontColor,
                                fontSize: cleanedStyle.fontSize,
                                backgroundColor: cleanedStyle.backgroundColor
                            });

                            // 🔧 关键修复：如使用的是基于ID的样式，必须同步更新数据库
                            // 否则下次通过ID加载时（如重新打开编辑器）不管是本地还是其他地方都会加载到旧数据
                            if (selectedSubtitleStyleId.value && !selectedSubtitleStyleId.value.startsWith('temp_')) {
                                console.log('[saveSettings] 同步保存样式到数据库, ID:', selectedSubtitleStyleId.value);
                                await subtitleStyleSelectorRef.value.saveCustomStyle(selectedSubtitleStyleId.value);
                            }
                            styleSaved = true;
                        } else {
                            console.warn('[saveSettings] ⚠️ 找不到模板或模板配置');
                        }
                    } else {
                        console.warn('[saveSettings] ⚠️ 没有选中模板或模板列表为空');
                    }
                } else {
                    console.warn('[saveSettings] ⚠️ 没有获取到字幕样式');
                }
            } catch (styleError) {
                console.warn('[saveSettings] 字幕样式保存异常:', styleError);
            }

            // 如果样式被保存，同时保存模板配置到存储
            if (styleSaved) {
                try {
                    await saveTemplatesToStorage(getTemplateStorageOptions(selectedSubtitleTemplate.value));
                    console.log('[saveSettings] ✅ 已保存模板配置到存储');
                } catch (storageError) {
                    console.warn('[saveSettings] 保存模板到存储失败（不影响主流程）:', storageError);
                }
            } else {
                console.warn('[saveSettings] ⚠️ 样式未被保存，跳过模板存储更新');
            }

            // 保存关键词分组信息（清理 Proxy 对象）
            try {
                console.log('[saveSettings] 准备保存关键词分组信息...', {
                    enableKeywordEffects: enableKeywordEffects.value,
                    groupsCount: keywordGroups.value?.length || 0
                });

                // 保存关键词分组到数据库
                if (enableKeywordEffects.value && keywordGroups.value && keywordGroups.value.length > 0) {
                    await Promise.all(
                        keywordGroups.value.map(group => {
                            // 🔧 关键修复：通过 JSON 序列化来移除 Proxy 包装
                            let cleanedGroup: any;
                            try {
                                cleanedGroup = JSON.parse(JSON.stringify(group));
                            } catch (groupJsonError) {
                                console.warn('[saveSettings] 分组 JSON 转换失败，尝试 structuredClone:', groupJsonError);
                                cleanedGroup = structuredClone(group);
                            }
                            return window.$mapi.keywordGroup.saveGroup(cleanedGroup).catch(err => {
                                console.warn('[saveSettings] 分组保存失败:', group.name, err);
                            });
                        })
                    );
                    console.log('[saveSettings] ✅ 关键词分组已保存到数据库');
                }

                // 关键修复：始终将关键词分组的样式配置和启用状态保存到模板的 config 中
                // （不管是否启用或是否有分组，都要保存这些配置，这样切换模板时才能恢复）
                if (selectedSubtitleTemplate.value && subtitleTemplates.value.length > 0) {
                    const template = subtitleTemplates.value.find(t => t.id === selectedSubtitleTemplate.value);
                    if (template && template.config) {
                        // 保存 enableKeywordEffects 状态
                        template.config.enableKeywordEffects = enableKeywordEffects.value;
                        template.config.keywordRenderMode =
                            template.config.keywordRenderMode ||
                            currentTemplateConfig.value?.keywordRenderMode ||
                            'floating';

                        // 提取每个分组的样式配置（styleOverride, effectId, color, 音效配置）
                        if (keywordGroups.value && keywordGroups.value.length > 0) {
                            template.config.keywordGroupsStyles = keywordGroups.value.map(group => ({
                                groupName: group.name,
                                styleOverride: group.styleOverride || null,
                                effectId: group.effectId || null,
                                effectDuration: group.effectDuration || null,  // 🆕 保存特效时长
                                color: group.color || null,
                                // 🆕 添加音效配置
                                soundEffectId: group.soundEffectId || null,
                                soundEffectConfig: group.soundEffectConfig || null
                            }));
                        } else {
                            template.config.keywordGroupsStyles = [];
                        }

                        console.log('[saveSettings] ✅ 已将关键词分组配置保存到模板:', {
                            templateId: selectedSubtitleTemplate.value,
                            enableKeywordEffects: template.config.enableKeywordEffects,
                            groupsCount: template.config.keywordGroupsStyles.length
                        });

                        // 保存模板配置到存储
                        await saveTemplatesToStorage(getTemplateStorageOptions(selectedSubtitleTemplate.value));
                    }
                }
            } catch (groupError) {
                console.warn('[saveSettings] 关键词分组保存失败（不影响主流程）:', groupError);
            }

            showSettingsDialog.value = false;
        } else {
            Message.error(result?.message || t("保存设置失败"));
        }
    } catch (error) {
        console.error("保存设置异常:", error);
        Message.error(t("保存设置失败"));
    }
};

// 加载设置
const loadSettings = async () => {
    try {
        // 🔧 保存当前内存中的音色ID（如果有的话）
        const currentVoicePromptId = settings.value.voicePromptId;

        const result = await window.$mapi.ipAgent.getSettings();

        if (result.success && result.settings) {
            // 🆕 检查是否是首次运行（自动加载了默认配置）
            if (result.isFirstRun) {
                console.log('[loadSettings] 🎉 首次运行，自动导入默认配置');
                // 直接应用完整的导入逻辑（包括字幕模板、前端状态等）
                await importSettings(result.settings);
                Message.success(t("欢迎使用！已自动加载默认配置"));
            } else {
                // 正常合并设置，保留默认值
                settings.value = {
                    ...settings.value,
                    ...result.settings
                };

                // 🔧 如果当前内存中有音色ID，优先使用内存中的值（保持同步）
                if (currentVoicePromptId) {
                    settings.value.voicePromptId = currentVoicePromptId;
                    console.log('[loadSettings] 保留当前内存中的音色ID:', currentVoicePromptId);
                }

                // 🔧 强制将已废弃的 aliyun-cosyvoice (V1) 替换为 cosyvoiceV2 (T1)
                // V1 模型与 cosyvoice-v3.5-plus 克隆音色不兼容，会触发 418 错误
                if (settings.value.onlineTtsModel === 'aliyun-cosyvoice') {
                    settings.value.onlineTtsModel = 'cosyvoiceV2';
                    console.log('[loadSettings] 已将废弃的 V1 模型替换为 T1');
                }
                // 旧版 RunningHub 迁移到 T2
                if (settings.value.onlineTtsModel === 'runninghub') {
                    settings.value.onlineTtsModel = 'runninghub_t2';
                    console.log('[loadSettings] 已将旧版 RunningHub 迁移为 T2');
                }
            }
        }

        // 🔧 修改：加载完整的混剪配置到 settings
        try {
            const mixCutConfig = await window.$mapi.config.get('videoMixCutSettings');
            if (mixCutConfig) {
                settings.value.videoMixCutSettings = mixCutConfig;
                enableMixCut.value = mixCutConfig.enabled || false;
                console.log('[loadSettings] 画中画配置已加载:', mixCutConfig);
            } else {
                settings.value.videoMixCutSettings = null;
                enableMixCut.value = false;
                console.log('[loadSettings] 未找到画中画配置');
            }
        } catch (e) {
            console.warn('[loadSettings] 加载混剪配置失败:', e);
            settings.value.videoMixCutSettings = null;
            enableMixCut.value = false;
        }
    } catch (error) {
        console.error("加载设置失败:", error);
    }

    if (!settings.value.textModelKey) {
        // 🔧 修复：优先从 localStorage 恢复，避免异步加载时序问题导致已选模型被默认值覆盖
        try {
            const localSettings = localStorage.getItem('videoIPAgent_settings');
            if (localSettings) {
                const parsed = JSON.parse(localSettings);
                if (parsed.textModelKey) {
                    settings.value.textModelKey = parsed.textModelKey;
                    console.log('[loadSettings] 从localStorage恢复文案模型:', settings.value.textModelKey);
                }
            }
        } catch (e) {
            // ignore
        }
    }
    if (!settings.value.textModelKey) {
        try {
            const configuredDoubaoModelId = getSystemConfigSync().volcengine_model || 'doubao-seed-2-0-lite-260215';
            settings.value.textModelKey = `builtInDoubao|${configuredDoubaoModelId}`;
            console.log('[loadSettings] 自动选择默认文案模型:', settings.value.textModelKey);
        } catch (e) {
            console.warn('[loadSettings] 自动选择默认文案模型失败:', e);
        }
    }
};

// 获取或创建关键词组的位置配置
const getGroupPositionConfig = (groupName: string) => {
    let config = settings.value.keywordGroupPositions?.find(p => p.groupName === groupName);
    if (!config) {
        config = {groupName, effectX: undefined, effectY: undefined, safeDistance: undefined};
        if (!settings.value.keywordGroupPositions) {
            settings.value.keywordGroupPositions = [];
        }
        settings.value.keywordGroupPositions.push(config);
    }
    return config;
};

// 🔧 更新关键词组位置配置的专用函数（确保响应式更新）
const updateGroupPosition = (groupName: string, position: { x?: number, y?: number }) => {
    const config = getGroupPositionConfig(groupName);
    if (position.x !== undefined) {
        config.effectX = position.x;
    }
    if (position.y !== undefined) {
        config.effectY = position.y;
    }
    // 强制触发响应式更新：创建新数组
    settings.value.keywordGroupPositions = settings.value.keywordGroupPositions?.slice() || [];
    console.log('[updateGroupPosition] 更新', groupName, '位置:', position, '新配置:', config);
};


// 清除关键词组的位置配置（恢复为使用默认值）
const clearGroupPosition = (groupName: string) => {
    const index = settings.value.keywordGroupPositions?.findIndex(p => p.groupName === groupName) ?? -1;
    if (index >= 0 && settings.value.keywordGroupPositions) {
        settings.value.keywordGroupPositions.splice(index, 1);
    }
};

// 关键词组颜色配置（循环使用）
const groupColors = [
    '#ef4444', // 红色
    '#10b981', // 绿色
    '#f59e0b', // 橙色
    '#8b5cf6', // 紫色
    '#ec4899', // 粉色
    '#06b6d4', // 青色
    '#84cc16', // 黄绿色
    '#f43f5e'  // 玫瑰色
];

// 获取关键词组的颜色
const getGroupColor = (index: number) => {
    return groupColors[index % groupColors.length];
};

// 🔧 关键词分组坐标的 getter/setter 函数
const getGroupX = (groupName: string) => {
    const config = settings.value.keywordGroupPositions?.find(p => p.groupName === groupName);
    return config?.effectX;
};

const setGroupX = (groupName: string, val: number | undefined) => {
    let config = settings.value.keywordGroupPositions?.find(p => p.groupName === groupName);
    if (!config) {
        config = {groupName, effectX: val, effectY: undefined, safeDistance: undefined};
        if (!settings.value.keywordGroupPositions) {
            settings.value.keywordGroupPositions = [];
        }
        settings.value.keywordGroupPositions.push(config);
    } else {
        config.effectX = val;
    }
    // 强制触发响应式更新
    settings.value.keywordGroupPositions = [...settings.value.keywordGroupPositions];
};

const getGroupY = (groupName: string) => {
    const config = settings.value.keywordGroupPositions?.find(p => p.groupName === groupName);
    return config?.effectY;
};

const setGroupY = (groupName: string, val: number | undefined) => {
    let config = settings.value.keywordGroupPositions?.find(p => p.groupName === groupName);
    if (!config) {
        config = {groupName, effectX: undefined, effectY: val, safeDistance: undefined};
        if (!settings.value.keywordGroupPositions) {
            settings.value.keywordGroupPositions = [];
        }
        settings.value.keywordGroupPositions.push(config);
    } else {
        config.effectY = val;
    }
    // 强制触发响应式更新
    settings.value.keywordGroupPositions = [...settings.value.keywordGroupPositions];
};

// 🔧 直接获取关键词组的SVG位置（用于实时预览）


// 🔧 直接获取关键词组的SVG位置（用于实时预览）

// 关键词组在SVG中的显示数据（computed确保响应式）
const keywordGroupsForSVG = computed(() => {
    console.log('[keywordGroupsForSVG] 开始计算, keywordGroups.value:', keywordGroups.value);

    // 🔧 关键修复：显式访问 settings.value.keywordGroupPositions 以确保响应式依赖
    // 这样当配置改变时，computed 会重新计算
    const positions = settings.value.keywordGroupPositions;
    console.log('[keywordGroupsForSVG] keywordGroupPositions:', positions);

    if (!keywordGroups.value || keywordGroups.value.length === 0) {
        console.log('[keywordGroupsForSVG] keywordGroups为空，返回空数组');
        return [];
    }

    // 为关键词组分配初始位置（如果没有自定义坐标）
    const defaultPositions = [
        {x: 30, y: 40},   // 左上
        {x: 70, y: 40},   // 右上
        {x: 30, y: 60},   // 左中
        {x: 70, y: 60},   // 右中
        {x: 50, y: 50},   // 正中
        {x: 20, y: 70},   // 左下
        {x: 80, y: 70},   // 右下
        {x: 50, y: 30}    // 上中
    ];

    try {
        const result = keywordGroups.value.map((group, index) => {
            console.log(`[keywordGroupsForSVG] 处理组 ${index}: ${group.name}`);

            const config = getGroupPositionConfig(group.name);
            console.log(`[keywordGroupsForSVG] 配置:`, config);

            const hasCustomPosition = config.effectX !== undefined || config.effectY !== undefined;

            // 如果没有自定义位置，使用预设的分散位置
            const defaultPos = defaultPositions[index % defaultPositions.length];
            const x = config.effectX ?? defaultPos.x;
            const y = config.effectY ?? defaultPos.y;

            const color = getGroupColor(index);
            console.log(`[keywordGroupsForSVG] ${group.name}: x=${x}, y=${y}, color=${color}`);

            return {
                id: group.id,
                name: group.name,
                x: x,
                y: y,
                color: color,
                opacity: hasCustomPosition ? 0.9 : 0.5,
                textOpacity: hasCustomPosition ? 1 : 0.6
            };
        });

        console.log('[keywordGroupsForSVG] 计算完成，结果:', result);
        return result;
    } catch (error) {
        console.error('[keywordGroupsForSVG] 计算出错:', error);
        return [];
    }
});

// 选择背景音乐目录
const getDefaultGroupPos = (groupIndex: number) => {
    const defaultPositions = [
        {x: 30, y: 40},   // 左上
        {x: 70, y: 40},   // 右上
        {x: 30, y: 60},   // 左中
        {x: 70, y: 60},   // 右中
        {x: 50, y: 50},   // 正中
        {x: 20, y: 70},   // 左下
        {x: 80, y: 70},   // 右下
        {x: 50, y: 30}    // 上中
    ];
    return defaultPositions[groupIndex % defaultPositions.length];
};

// 添加IP大脑 - 简化版，直接采集
const DIRECT_VIDEO_URL_PATTERN = /(?:https?:\/\/)[^\s"'<>]+?\.(mp4|mov|m4v|webm|avi|mkv)(\?[^\s"'<>]*)?/i;
const DOUYIN_ACCOUNT_PATTERNS = [
    /(?:https?:\/\/)?(?:www\.)?douyin\.com\/user\/[^\s/?#]+/i,
    /(?:https?:\/\/)?iesdouyin\.com\/share\/user\/[^\s/?#]+/i,
    /(?:https?:\/\/)?v\.douyin\.com\/[\w_\-@]+\/?/i
];
const DOUYIN_VIDEO_PATTERNS = [
    /(?:https?:\/\/)?v\.douyin\.com\/[\w_\-@]+\/?/i,
    /(?:https?:\/\/)?(?:www\.)?douyin\.com\/(?:video|modal)\/\d+[^\s]*/i,
    /(?:https?:\/\/)?iesdouyin\.com\/(?:share\/video|video)\/\d+[^\s]*/i
];
const OTHER_PLATFORM_PATTERNS: Array<{ platform: string; pattern: RegExp }> = [
    {platform: 'kuaishou', pattern: /(?:kuaishou\.com|chenzhongtech\.com|v\.kuaishou\.com)/i},
    {platform: 'xiaohongshu', pattern: /(?:xiaohongshu\.com|xhslink\.com)/i},
    {platform: 'bilibili', pattern: /(?:bilibili\.com|b23\.tv)/i},
    {platform: 'shipin', pattern: /(?:channels\.weixin\.qq\.com|weixin\.qq\.com)/i}
];

const getDetectedPlatformName = (platform: string): string => {
    const nameMap: Record<string, string> = {
        douyin: '抖音',
        kuaishou: '快手',
        xiaohongshu: '小红书',
        bilibili: '哔哩哔哩',
        shipin: '视频号',
        unknown: '未知平台'
    };
    return nameMap[platform] || nameMap.unknown;
};

const normalizeExternalUrl = (value: string) => value.startsWith('http') ? value : `https://${value}`;

const extractUrlByPatterns = (input: string, patterns: RegExp[]) => {
    for (const pattern of patterns) {
        const match = input.match(pattern);
        if (match?.[0]) {
            return normalizeExternalUrl(match[0].trim());
        }
    }
    return '';
};

const detectSocialPlatformFromInput = (input: string): string => {
    const normalized = input.trim().toLowerCase();
    if (!normalized) {
        return 'unknown';
    }
    if (DOUYIN_ACCOUNT_PATTERNS.some((pattern) => pattern.test(normalized)) || DOUYIN_VIDEO_PATTERNS.some((pattern) => pattern.test(normalized))) {
        return 'douyin';
    }
    if (DIRECT_VIDEO_URL_PATTERN.test(normalized)) {
        return 'directVideo';
    }
    const matchedPlatform = OTHER_PLATFORM_PATTERNS.find(({pattern}) => pattern.test(normalized));
    return matchedPlatform?.platform || 'unknown';
};

const normalizeIpLearningInput = (input: string) => {
    const normalized = extractUrlByPatterns(input, DOUYIN_ACCOUNT_PATTERNS);
    if (normalized) {
        return {ok: true, url: normalized};
    }

    const detectedPlatform = detectSocialPlatformFromInput(input);
    if (detectedPlatform !== 'unknown' && detectedPlatform !== 'directVideo') {
        return {
            ok: false,
            message: `当前IP学习暂只支持抖音账号主页/用户分享链接，已识别为${getDetectedPlatformName(detectedPlatform)}链接`
        };
    }

    return {
        ok: false,
        message: '请输入有效的抖音账号主页、用户分享链接或短链接'
    };
};

const normalizeVideoRewriteInput = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
        return {ok: false, message: '请粘贴视频分享文本或视频链接'};
    }

    if (DIRECT_VIDEO_URL_PATTERN.test(trimmed)) {
        return {ok: true, value: trimmed};
    }

    const douyinUrl = extractUrlByPatterns(trimmed, DOUYIN_VIDEO_PATTERNS);
    if (douyinUrl) {
        return {ok: true, value: trimmed.includes(douyinUrl) ? trimmed : douyinUrl};
    }

    const detectedPlatform = detectSocialPlatformFromInput(trimmed);
    if (detectedPlatform !== 'unknown' && detectedPlatform !== 'directVideo') {
        return {
            ok: false,
            message: `当前视频仿写暂支持抖音分享文本/链接和直接视频文件链接，暂未接入${getDetectedPlatformName(detectedPlatform)}分享链接`
        };
    }

    return {
        ok: false,
        message: '请输入抖音分享文本、抖音视频链接，或直接视频文件链接（mp4/mov/webm/mkv/avi）'
    };
};

const parseCustomPromptOptions = (rawContent: string): string[] => {
    const fencedContent = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() || rawContent.trim();

    try {
        const parsed = JSON.parse(fencedContent);
        const candidateList = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.options)
                ? parsed.options
                : Array.isArray(parsed?.data)
                    ? parsed.data
                    : [];

        const normalized = candidateList
            .map((item: any) => typeof item === 'string' ? item : item?.content || item?.text || '')
            .map((item: string) => item.trim())
            .filter(Boolean);

        if (normalized.length) {
            return Array.from(new Set(normalized)).slice(0, 3);
        }
    } catch (error) {
        console.warn('[爆款文案] JSON解析失败，转用文本拆分:', error);
    }

    const textBlocks = fencedContent
        .split(/\n(?=(?:方案|选项)\s*[一二三123])|\n{2,}/)
        .map((item) => item.replace(/^(?:方案|选项)\s*[一二三123][：:\.\s-]*/g, '').trim())
        .filter(Boolean);

    return Array.from(new Set(textBlocks)).slice(0, 3);
};

const useCustomPromptOption = (content: string) => {
    scriptContent.value = content;
    showCustomPromptOptionsDialog.value = false;
    Message.success(t("已将所选文案填入编辑区"));
};

const openCustomPromptDialog = () => {
    showCustomPromptOptionsDialog.value = true;
    selectedCustomPromptIndex.value = customPromptOptions.value.length ? (selectedCustomPromptIndex.value ?? 0) : null;
    customPromptProgress.value = customPromptOptions.value.length
        ? `已生成 ${customPromptOptions.value.length} 个爆款文案方案，可直接选择或重新生成`
        : "";
};

const handleIPBrainTabChange = (value: string | number | boolean) => {
    activeIPBrainTab.value = String(value);
    lastMainIPBrainTab.value = String(value);
};

const normalizeSubtitleCacheText = (text: string): string => {
    return (text || '')
        .replace(/\s+/g, '')
        .replace(/[，。！？、；：,.!?;:'"“”‘’（）()【】《》<>\-]/g, '')
        .trim();
};

const SUBTITLE_REUSE_META_STORAGE_KEY = 'videoIPAgent_subtitleReuseMeta';

const normalizeSubtitleVideoPath = (videoPath: string): string => {
    return String(videoPath || '')
        .replace(/^file:\/\//, '')
        .replace(/\//g, '\\')
        .trim()
        .toLowerCase();
};

const saveSubtitleReuseMeta = (payload: {
    videoPath: string;
    scriptText?: string;
    srtPath?: string | null;
    records?: Array<{ end?: number }>;
}) => {
    try {
        const lastRecord = Array.isArray(payload.records) && payload.records.length > 0
            ? payload.records[payload.records.length - 1]
            : null;
        const lastEnd = typeof lastRecord?.end === 'number' ? lastRecord.end : 0;
        localStorage.setItem(SUBTITLE_REUSE_META_STORAGE_KEY, JSON.stringify({
            videoPath: normalizeSubtitleVideoPath(payload.videoPath),
            scriptText: normalizeSubtitleCacheText(payload.scriptText || ''),
            srtPath: payload.srtPath || '',
            recordsCount: Array.isArray(payload.records) ? payload.records.length : 0,
            lastEnd,
            savedAt: Date.now(),
        }));
    } catch (error) {
        console.warn('[saveSubtitleReuseMeta] 保存字幕复用元数据失败:', error);
    }
};

const getSubtitleReuseMeta = (): any | null => {
    try {
        const raw = localStorage.getItem(SUBTITLE_REUSE_META_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        console.warn('[getSubtitleReuseMeta] 读取字幕复用元数据失败:', error);
        return null;
    }
};
const validateCachedSubtitleRecords = async (
    records: Array<{ text?: string; start?: number; end?: number }>,
    currentVideoPath: string,
    scriptText: string
) => {
    if (!Array.isArray(records) || records.length === 0) {
        return {valid: false, reason: 'empty-records', similarity: 0, durationDelta: Number.POSITIVE_INFINITY};
    }

    const cachedText = normalizeSubtitleCacheText(records.map(r => r.text || '').join(''));
    const currentText = normalizeSubtitleCacheText(scriptText || '');
    const similarity = currentText && cachedText
        ? LevenshteinMatcher.similarity(currentText, cachedText)
        : 0;

    if (!currentText || similarity < 0.72) {
        return {valid: false, reason: 'text-mismatch', similarity, durationDelta: Number.POSITIVE_INFINITY};
    }

    try {
        const videoInfo = await ffprobeVideoInfo(currentVideoPath);
        const lastRecord = records[records.length - 1];
        const recordsEnd = typeof lastRecord?.end === 'number'
            ? (lastRecord.end > 100 ? lastRecord.end / 1000 : lastRecord.end)
            : 0;
        const durationDelta = Math.abs((videoInfo?.duration || 0) - recordsEnd);

        if (durationDelta > 1.2) {
            return {valid: false, reason: 'duration-mismatch', similarity, durationDelta};
        }

        return {valid: true, reason: 'ok', similarity, durationDelta};
    } catch (error) {
        console.warn('[validateCachedSubtitleRecords] 视频时长校验失败，放弃复用缓存:', error);
        return {valid: false, reason: 'duration-check-failed', similarity, durationDelta: Number.POSITIVE_INFINITY};
    }
};

const openAddIPDialog = () => {
    showAddIPDialog.value = true;
    douyinUrl.value = "";
};

// 自动采集 - 打开浏览器并自动抓取数据
const startAutoScrape = async () => {
    if (!douyinUrl.value) {
        Message.warning(t("请输入抖音链接"));
        return;
    }

    const normalizedInput = normalizeIpLearningInput(douyinUrl.value);
    if (!normalizedInput.ok) {
        Message.error(normalizedInput.message);
        return;
    }

    console.log("=== 开始采集 ===");
    console.log("URL:", normalizedInput.url);

    isAnalyzing.value = true;
    showAddIPDialog.value = false;

    try {
        Message.info(t("正在打开浏览器并采集数据，请稍候..."));

        console.log("调用 analyzeDouyinAccount...");
        // 使用window.$mapi调用我们的抖音账号分析功能
        const result = await window.$mapi.ipAgent.analyzeDouyinAccount({
            url: normalizedInput.url
        });

        console.log("采集结果:", result);

        if (result.success && result.data) {
            const {accountName, videoTitles} = result.data;

            console.log("账号名称:", accountName);
            console.log("视频标题数量:", videoTitles?.length);
            console.log("视频标题原始数据:", videoTitles);

            if (!accountName) {
                Message.error(t("未能识别账号名称，请检查链接是否正确"));
                isAnalyzing.value = false;
                return;
            }

            if (!videoTitles || videoTitles.length === 0) {
                Message.error(t("未能找到视频标题，请确保链接指向账号主页"));
                isAnalyzing.value = false;
                return;
            }

            // 🔧 关键修复：从HTML标签中提取纯文本
            const cleanVideoTitles = videoTitles.map((title: any, index: number) => {
                if (typeof title === 'string') {
                    let cleanTitle = title;
                    console.log(`[标题清理 ${index}] 原始:`, title);

                    // 如果是字符串，检查是否包含HTML标签
                    if (cleanTitle.includes('<') && cleanTitle.includes('>')) {
                        // 创建临时DOM元素来提取文本
                        const temp = document.createElement('div');
                        temp.innerHTML = cleanTitle;
                        cleanTitle = temp.textContent || temp.innerText || cleanTitle;
                        console.log(`[标题清理 ${index}] 去除HTML后:`, cleanTitle);
                    }

                    // 🔧 关键修复：去掉开头的数字前缀（如"14"、"4"等统计数据）
                    // 这是后端可能遗漏的清理
                    const beforeNumRemoval = cleanTitle;
                    cleanTitle = cleanTitle.replace(/^\d+\s+/, '').trim();
                    if (beforeNumRemoval !== cleanTitle) {
                        console.log(`[标题清理 ${index}] 去除数字前缀后:`, cleanTitle);
                    }

                    // 去掉#标签（后端采集脚本可能保留了）
                    const beforeHashRemoval = cleanTitle;
                    cleanTitle = cleanTitle.replace(/#[^\s]+/g, ' ').trim();
                    if (beforeHashRemoval !== cleanTitle) {
                        console.log(`[标题清理 ${index}] 去除#标签后:`, cleanTitle);
                    }

                    // 合并多个空格
                    cleanTitle = cleanTitle.replace(/\s+/g, ' ').trim();

                    console.log(`[标题清理 ${index}] 最终:`, cleanTitle);
                    return cleanTitle;
                }
                return title;
            });

            console.log("视频标题清理后:", cleanVideoTitles);

            // 使用清理后的标题替换原始标题
            const processedData = {
                accountName,
                videoTitles: cleanVideoTitles
            };

            // 后续使用 processedData 中的 videoTitles
            const finalVideoTitles = processedData.videoTitles;

            // 检查URL是否已存在
            const normalizedUrl = normalizedInput.url.split('?')[0]; // 去掉查询参数
            const existingIndex = learnedAccounts.value.findIndex(acc => {
                const accNormalizedUrl = acc.url.split('?')[0];
                return accNormalizedUrl === normalizedUrl;
            });

            // 准备新的选题库（去掉#标签和数字序号，最多6个，去重）
            const newTopics: Array<{
                original: string;
                rewritten: string | null;
                isRewriting: boolean;
                script: string | null;
                isGeneratingScript: boolean;
            }> = [];

            // 🔧 关键修复：智能检测和拆分拼接的标题，避免多个标题混在一起
            const seenTitles = new Set<string>();

            // 辅助函数：计算两个字符串的相似度
            const calculateSimilarity = (str1: string, str2: string): number => {
                const set1 = new Set(str1.split(''));
                const set2 = new Set(str2.split(''));
                const intersection = new Set([...set1].filter(x => set2.has(x)));
                const union = new Set([...set1, ...set2]);
                return intersection.size / union.size;
            };

            // 辅助函数：检查文本是否包含重复内容（可能是多个标题拼接）
            const hasRepeatedContent = (text: string): boolean => {
                if (text.length > 200) return true;
                // 检查是否有明显的重复模式
                const sentences = text.split(/[。！？\n]/).filter(s => s.trim().length > 10);
                if (sentences.length > 3) {
                    for (let i = 0; i < sentences.length; i++) {
                        for (let j = i + 1; j < sentences.length; j++) {
                            const s1 = sentences[i].trim();
                            const s2 = sentences[j].trim();
                            if (s1.length > 20 && s2.length > 20) {
                                const similarity = calculateSimilarity(s1, s2);
                                if (similarity > 0.8) return true;
                            }
                        }
                    }
                }
                return false;
            };

            // 辅助函数：拆分可能拼接的标题
            const splitConcatenatedTitle = (text: string): string[] => {
                const titles: string[] = [];

                // 方法1: 按#标签分割（每个#标签通常是一个标题的结尾）
                const hashtagParts = text.split(/(#[^\s#]+)/);
                let currentPart = '';
                for (let i = 0; i < hashtagParts.length; i++) {
                    currentPart += hashtagParts[i];
                    if (hashtagParts[i].startsWith('#') && currentPart.length > 20) {
                        const title = currentPart.replace(/^\d+\s*/, '').trim();
                        if (title && title.length > 5) {
                            titles.push(title);
                        }
                        currentPart = '';
                    }
                }
                if (currentPart.trim().length > 20) {
                    const title = currentPart.replace(/^\d+\s*/, '').trim();
                    if (title && title.length > 5) {
                        titles.push(title);
                    }
                }

                // 方法2: 如果按#标签分割失败，尝试按重复模式分割
                if (titles.length === 0 && hasRepeatedContent(text)) {
                    const sentences = text.split(/[。！？]/).filter(s => s.trim().length > 10);
                    if (sentences.length >= 2) {
                        for (let i = 0; i < sentences.length - 1; i++) {
                            for (let j = i + 1; j < sentences.length; j++) {
                                if (calculateSimilarity(sentences[i], sentences[j]) > 0.8) {
                                    const firstTitle = sentences.slice(0, j).join('。').replace(/^\d+\s*/, '').trim();
                                    if (firstTitle && firstTitle.length > 5) {
                                        titles.push(firstTitle);
                                    }
                                    const secondTitle = sentences.slice(j).join('。').replace(/^\d+\s*/, '').trim();
                                    if (secondTitle && secondTitle.length > 5) {
                                        titles.push(secondTitle);
                                    }
                                    return titles;
                                }
                            }
                        }
                    }
                }

                // 如果无法拆分，返回原文本（去掉数字前缀）
                if (titles.length === 0) {
                    const cleanTitle = text.replace(/^\d+\s*/, '').trim();
                    if (cleanTitle && cleanTitle.length > 2) {
                        titles.push(cleanTitle);
                    }
                }

                return titles;
            };

            // 辅助函数：检查标题是否与已有标题相似（避免重复）
            const isSimilarToExisting = (title: string, existingTitles: Set<string>): boolean => {
                for (const existing of existingTitles) {
                    const similarity = calculateSimilarity(title, existing);
                    // 如果相似度超过70%，认为是重复
                    if (similarity > 0.7) return true;
                }
                return false;
            };

            for (const title of finalVideoTitles) {
                if (newTopics.length >= 6) break;

                // 检查是否包含多个数字序号 (1), (2), (3) 等
                const sequenceMatches = title.match(/\(\d+\)/g) || [];

                let titlesToProcess: string[] = [];

                if (sequenceMatches.length > 1) {
                    // 多个序号：按序号分割
                    console.log(`[选题库] 检测到多个序号标题: ${sequenceMatches.join(', ')} 在: "${title.substring(0, 50)}..."`);
                    titlesToProcess = title.split(/\(\d+\)/).filter(t => t.trim());
                } else if (hasRepeatedContent(title)) {
                    // 检测到重复内容，尝试拆分
                    console.log(`[选题库] 检测到拼接标题，尝试拆分: "${title.substring(0, 50)}..."`);
                    titlesToProcess = splitConcatenatedTitle(title);
                } else {
                    // 单个标题：正常处理
                    titlesToProcess = [title];
                }

                // 处理每个分割出来的标题
                titlesToProcess.forEach((singleTitle, subIndex) => {
                    if (newTopics.length >= 6) return;

                    let cleanTitle = singleTitle
                        .replace(/#[^\s#]+/g, '') // 去掉 #标签
                        .replace(/\s+/g, ' ') // 合并多个空格为单个空格
                        .trim();

                    // 🔧 修复：检查原始标题是否只包含标签（去掉标签后变为空或过短）
                    const isHashtagOnly = !cleanTitle || cleanTitle.length < 3;

                    console.log(`[选题库处理] 标题片段 ${subIndex}: "${singleTitle.substring(0, 50)}" -> 清理后: "${cleanTitle}" (长度: ${cleanTitle.length}, 纯标签: ${isHashtagOnly})`);

                    // 只添加非空、未重复的标题，最多6个
                    // 🔧 修复：降低最小长度要求从 5 改为 2，避免过滤掉"雷公炮"等极短标题
                    if (cleanTitle && cleanTitle.length > 2 &&
                        !isHashtagOnly &&
                        !seenTitles.has(cleanTitle) &&
                        !isSimilarToExisting(cleanTitle, seenTitles)) {
                        seenTitles.add(cleanTitle);
                        newTopics.push({
                            original: cleanTitle,
                            rewritten: null,
                            isRewriting: false,
                            script: null,
                            isGeneratingScript: false
                        });
                        console.log(`[选题库处理] ✅ 已添加: "${cleanTitle}"`);
                    } else if (isHashtagOnly) {
                        console.log(`[选题库处理] ❌ 跳过（纯标签内容）: "${singleTitle.substring(0, 50)}"`);
                    } else if (cleanTitle.length <= 2) {
                        console.log(`[选题库处理] ❌ 跳过（长度不足 ${cleanTitle.length}≤2）: "${cleanTitle}"`);
                    } else if (seenTitles.has(cleanTitle)) {
                        console.log(`[选题库处理] ❌ 跳过（已存在）: "${cleanTitle}"`);
                    } else if (isSimilarToExisting(cleanTitle, seenTitles)) {
                        console.log(`[选题库处理] ❌ 跳过（相似度过高）: "${cleanTitle}"`);
                    }
                });
            }

            console.log(`[选题库] 清理重复前 ${finalVideoTitles.length} 个，清理后 ${newTopics.length} 个（去掉HTML、#标签和序号）`);

            if (existingIndex !== -1) {
                // 账号已存在，更新选题库
                console.log("账号已存在，更新选题库...", accountName);
                learnedAccounts.value[existingIndex].name = accountName; // 更新名称（可能变化）
                learnedAccounts.value[existingIndex].url = normalizedInput.url; // 更新URL
                learnedAccounts.value[existingIndex].topicLibrary = newTopics;

                Message.success(t("已更新") + ` ${accountName} ` + t("的选题库") + ` (${newTopics.length}个)`);
                // 🔧 【修复】保存更新到本地存储
                saveWorkData();
            } else {
                // 账号不存在，检查是否达到上限
                if (learnedAccounts.value.length >= 5) {
                    Message.warning(t("最多只能添加5个对标，请先删除一个"));
                    isAnalyzing.value = false;
                    return;
                }

                // 添加新账号
                console.log("添加新账号到列表...", accountName);
                const newAccount: LearnedAccount = {
                    name: accountName,
                    url: normalizedInput.url,
                    topicLibrary: newTopics
                };
                learnedAccounts.value.push(newAccount);

                // 自动选中新添加的账号
                selectedAccountIndex.value = learnedAccounts.value.length - 1;

                Message.success(t("采集完成！已添加") + ` ${accountName} (${newTopics.length}个选题)`);
                // 🔧 【修复】保存新增账号到本地存储
                saveWorkData();
            }

            console.log("当前账号列表:", learnedAccounts.value);
            console.log("当前选中账号索引:", selectedAccountIndex.value);
            currentWebviewUrl.value = normalizedInput.url;
        } else {
            console.error("采集失败:", result.message);
            Message.error(result.message || t("采集失败，请重试"));
        }

    } catch (error) {
        console.error("自动采集失败:", error);
        Message.error(t("采集失败：") + (error?.message || t("请检查网络连接")));
    } finally {
        isAnalyzing.value = false;
        console.log("=== 采集结束 ===");
    }
};

// 从浏览器中抓取数据
const scrapeFromBrowser = async () => {
    isAnalyzing.value = true;

    try {
        // 调用后端从浏览器窗口抓取数据
        const result = await window.$mapi.ipAgent.scrapeFromBrowser({
            url: currentWebviewUrl.value
        });

        if (result.success && result.data) {
            const {accountName, videoTitles} = result.data;

            if (!accountName) {
                Message.error(t("未能识别账号名称，请确保页面已加载完成"));
                return;
            }

            if (!videoTitles || videoTitles.length === 0) {
                Message.error(t("未能找到视频标题，请确保在账号主页"));
                return;
            }

            // 🔧 关键修复：从HTML标签中提取纯文本
            const cleanVideoTitles = videoTitles.map((title: any) => {
                if (typeof title === 'string') {
                    // 如果是字符串，检查是否包含HTML标签
                    if (title.includes('<') && title.includes('>')) {
                        // 创建临时DOM元素来提取文本
                        const temp = document.createElement('div');
                        temp.innerHTML = title;
                        return temp.textContent || temp.innerText || title;
                    }
                    return title;
                }
                return title;
            });

            // 使用清理后的标题替换原始标题
            const finalVideoTitles = cleanVideoTitles;

            // 检查URL是否已存在
            const normalizedUrl = currentWebviewUrl.value.split('?')[0]; // 去掉查询参数
            const existingIndex = learnedAccounts.value.findIndex(acc => {
                const accNormalizedUrl = acc.url.split('?')[0];
                return accNormalizedUrl === normalizedUrl;
            });

            // 准备新的选题库（去掉#标签和数字序号，最多6个，去重）
            const newTopics: Array<{
                original: string;
                rewritten: string | null;
                isRewriting: boolean;
                script: string | null;
                isGeneratingScript: boolean;
            }> = [];

            // 🔧 关键修复：智能检测和拆分拼接的标题，避免多个标题混在一起
            const seenTitles = new Set<string>();

            // 辅助函数：计算两个字符串的相似度
            const calculateSimilarity = (str1: string, str2: string): number => {
                const set1 = new Set(str1.split(''));
                const set2 = new Set(str2.split(''));
                const intersection = new Set([...set1].filter(x => set2.has(x)));
                const union = new Set([...set1, ...set2]);
                return intersection.size / union.size;
            };

            // 辅助函数：检查文本是否包含重复内容（可能是多个标题拼接）
            const hasRepeatedContent = (text: string): boolean => {
                if (text.length > 200) return true;
                // 检查是否有明显的重复模式
                const sentences = text.split(/[。！？\n]/).filter(s => s.trim().length > 10);
                if (sentences.length > 3) {
                    for (let i = 0; i < sentences.length; i++) {
                        for (let j = i + 1; j < sentences.length; j++) {
                            const s1 = sentences[i].trim();
                            const s2 = sentences[j].trim();
                            if (s1.length > 20 && s2.length > 20) {
                                const similarity = calculateSimilarity(s1, s2);
                                if (similarity > 0.8) return true;
                            }
                        }
                    }
                }
                return false;
            };

            // 辅助函数：拆分可能拼接的标题
            const splitConcatenatedTitle = (text: string): string[] => {
                const titles: string[] = [];

                // 方法1: 按#标签分割（每个#标签通常是一个标题的结尾）
                const hashtagParts = text.split(/(#[^\s#]+)/);
                let currentPart = '';
                for (let i = 0; i < hashtagParts.length; i++) {
                    currentPart += hashtagParts[i];
                    if (hashtagParts[i].startsWith('#') && currentPart.length > 20) {
                        const title = currentPart.replace(/^\d+\s*/, '').trim();
                        if (title && title.length > 10) {
                            titles.push(title);
                        }
                        currentPart = '';
                    }
                }
                if (currentPart.trim().length > 20) {
                    const title = currentPart.replace(/^\d+\s*/, '').trim();
                    if (title && title.length > 10) {
                        titles.push(title);
                    }
                }

                // 方法2: 如果按#标签分割失败，尝试按重复模式分割
                if (titles.length === 0 && hasRepeatedContent(text)) {
                    const sentences = text.split(/[。！？]/).filter(s => s.trim().length > 10);
                    if (sentences.length >= 2) {
                        for (let i = 0; i < sentences.length - 1; i++) {
                            for (let j = i + 1; j < sentences.length; j++) {
                                if (calculateSimilarity(sentences[i], sentences[j]) > 0.8) {
                                    const firstTitle = sentences.slice(0, j).join('。').replace(/^\d+\s*/, '').trim();
                                    if (firstTitle && firstTitle.length > 10) {
                                        titles.push(firstTitle);
                                    }
                                    const secondTitle = sentences.slice(j).join('。').replace(/^\d+\s*/, '').trim();
                                    if (secondTitle && secondTitle.length > 10) {
                                        titles.push(secondTitle);
                                    }
                                    return titles;
                                }
                            }
                        }
                    }
                }

                // 如果无法拆分，返回原文本（去掉数字前缀）
                if (titles.length === 0) {
                    const cleanTitle = text.replace(/^\d+\s*/, '').trim();
                    if (cleanTitle && cleanTitle.length > 10) {
                        titles.push(cleanTitle);
                    }
                }

                return titles;
            };

            // 辅助函数：检查标题是否与已有标题相似（避免重复）
            const isSimilarToExisting = (title: string, existingTitles: Set<string>): boolean => {
                for (const existing of existingTitles) {
                    const similarity = calculateSimilarity(title, existing);
                    // 如果相似度超过70%，认为是重复
                    if (similarity > 0.7) return true;
                }
                return false;
            };

            for (const title of finalVideoTitles) {
                if (newTopics.length >= 6) break;

                // 检查是否包含多个数字序号 (1), (2), (3) 等
                const sequenceMatches = title.match(/\(\d+\)/g) || [];

                let titlesToProcess: string[] = [];

                if (sequenceMatches.length > 1) {
                    // 多个序号：按序号分割
                    console.log(`[选题库] 检测到多个序号标题: ${sequenceMatches.join(', ')} 在: "${title.substring(0, 50)}..."`);
                    titlesToProcess = title.split(/\(\d+\)/).filter(t => t.trim());
                } else if (hasRepeatedContent(title)) {
                    // 检测到重复内容，尝试拆分
                    console.log(`[选题库] 检测到拼接标题，尝试拆分: "${title.substring(0, 50)}..."`);
                    titlesToProcess = splitConcatenatedTitle(title);
                } else {
                    // 单个标题：正常处理
                    titlesToProcess = [title];
                }

                // 处理每个分割出来的标题
                titlesToProcess.forEach(singleTitle => {
                    if (newTopics.length >= 6) return;

                    let cleanTitle = singleTitle
                        .replace(/#[^\s#]+/g, '') // 去掉 #标签
                        .replace(/\s+/g, ' ') // 合并多个空格为单个空格
                        .trim();

                    // 只添加非空、未重复的标题，最多6个
                    if (cleanTitle && cleanTitle.length > 10 &&
                        !seenTitles.has(cleanTitle) &&
                        !isSimilarToExisting(cleanTitle, seenTitles)) {
                        seenTitles.add(cleanTitle);
                        newTopics.push({
                            original: cleanTitle,
                            rewritten: null,
                            isRewriting: false,
                            script: null,
                            isGeneratingScript: false
                        });
                    }
                });
            }

            console.log(`[选题库] 清理重复前 ${finalVideoTitles.length} 个，清理后 ${newTopics.length} 个（去掉HTML、#标签和序号）`);

            if (existingIndex !== -1) {
                // 账号已存在，更新选题库
                console.log("账号已存在，更新选题库...", accountName);
                learnedAccounts.value[existingIndex].name = accountName; // 更新名称（可能变化）
                learnedAccounts.value[existingIndex].url = currentWebviewUrl.value; // 更新URL
                learnedAccounts.value[existingIndex].topicLibrary = newTopics;

                Message.success(t("已更新") + ` ${accountName} ` + t("的选题库") + ` (${newTopics.length}个)`);
            } else {
                // 账号不存在，检查是否达到上限
                if (learnedAccounts.value.length >= 5) {
                    Message.warning(t("最多只能添加5个对标，请先删除一个"));
                    return;
                }

                // 添加新账号
                console.log("添加新账号到列表...", accountName);
                const newAccount: LearnedAccount = {
                    name: accountName,
                    url: currentWebviewUrl.value,
                    topicLibrary: newTopics
                };
                learnedAccounts.value.push(newAccount);

                // 自动选中新添加的账号
                selectedAccountIndex.value = learnedAccounts.value.length - 1;

                Message.success(t("抓取完成！已添加") + ` ${accountName} (${newTopics.length}个选题)`);
            }
        } else {
            Message.error(result.message || t("抓取失败，请重试"));
        }

    } catch (error) {
        console.error('发布视频失败:', error);
        Message.error(t('发布视频失败：') + error?.message);
    } finally {
        isPublishing.value = false;
    }
};

// ==================== 视频对比预览相关方法 ====================

/**
 * 加载形象视频模板用于对比预览
 */
const loadTemplateVideoForComparison = async () => {
    try {
        console.log('[loadTemplateVideoForComparison] 开始加载模板视频，videoTemplateId:', videoTemplateId.value);

        if (!videoTemplateId.value) {
            console.warn('[loadTemplateVideoForComparison] 未选择视频模板');
            templateVideoUrl.value = "";
            Message.warning(t('请先选择形象视频'));
            return;
        }

        const template = await VideoTemplateService.get(videoTemplateId.value);
        console.log('[loadTemplateVideoForComparison] 查询到的模板信息:', template);

        if (template && template.video) {
            // 直接使用template.video，它已经是完整路径
            // 🔧 【修复】确保 URL 格式一致
            const videoUrl = template.video.startsWith('file://') ? template.video : 'file://' + template.video;
            templateVideoUrl.value = videoUrl;
            console.log('[loadTemplateVideoForComparison] ✅ 模板视频路径已设置:', {
                original: template.video,
                formatted: videoUrl
            });
        } else {
            console.warn('[loadTemplateVideoForComparison] ⚠️ 未找到模板视频，template:', template);
            templateVideoUrl.value = "";
            Message.warning(t('未找到形象视频文件'));
        }
    } catch (error) {
        console.error('[loadTemplateVideoForComparison] ❌ 加载模板视频失败:', error);
        templateVideoUrl.value = "";
        Message.error(t('加载形象视频失败'));
    }
};

/**
 * 【功能】打开预览时，加载最新生成的字幕视频 + 历史记录
 * 🔧 修复：预览对话框打开时，同时加载当前视频和完整的历史记录列表
 */
const loadLatestSubtitleVideo = async () => {
    try {
        console.log('[loadLatestSubtitleVideo] 预览对话框打开，准备加载最新生成的字幕视频和历史记录');
        isLoadingHistory.value = true;

        // 启动性能监控
        setTimeout(() => {
            startPerformanceMonitor();
        }, 500);

        // 🔧 修复：同时加载历史记录列表
        console.log('[loadLatestSubtitleVideo] 🔄 正在加载历史记录列表...');
        try {
            await loadGeneratedVideoHistory();
            console.log('[loadLatestSubtitleVideo] ✅ 历史记录加载完成，总数:', generatedVideoHistory.value.length);
        } catch (historyError) {
            console.warn('[loadLatestSubtitleVideo] ⚠️ 加载历史记录失败:', historyError);
            // 不中断流程，继续显示当前视频
        }

        // 重置为"当前"模式（不选择历史）
        selectedHistoryIndex.value = null;

        // 🔧 【关键修复】不再自动选择历史视频
        // 原因：历史列表现在包含所有有result的记录，包括没有字幕的视频
        // 如果 finalVideoUrl 为空，保持为空，不显示预览
        // 用户需要主动选择历史视频或生成新的字幕视频
        if (!finalVideoUrl.value && generatedVideoHistory.value.length > 0) {
            console.log('[loadLatestSubtitleVideo] ℹ️ 当前字幕视频为空，不自动选择（防止显示没字幕的视频）');
            // 不调用 selectHistoryVideo(0)，保持 finalVideoUrl 为空
        }

        // 加载当前的模板视频（如果没有模板视频，也不显示错误提示，让UI正常显示）
        if (videoTemplateId.value) {
            try {
                await loadTemplateVideoForComparison();
            } catch (error) {
                console.warn('[loadLatestSubtitleVideo] 加载模板视频失败，但继续显示字幕视频:', error);
                // 不中断流程
            }
        } else {
            console.log('[loadLatestSubtitleVideo] 未选择模板，跳过模板视频加载');
        }

        console.log('[loadLatestSubtitleVideo] ✅ 已加载最新字幕视频和历史记录', {
            templateVideoUrl: templateVideoUrl.value,
            finalVideoUrl: finalVideoUrl.value,
            historyVideoUrl: historyVideoUrl.value,
            selectedHistoryIndex: selectedHistoryIndex.value,
            historyCount: generatedVideoHistory.value.length
        });
    } catch (error) {
        console.error('[loadLatestSubtitleVideo] ❌ 加载字幕视频预览失败:', error);
        // 不显示错误提示，让UI正常显示
    } finally {
        isLoadingHistory.value = false;
    }
};

/**
 * 【功能】加载历史生成的视频列表
 * 🔧 修复：显示所有带字幕的视频（优先使用 finalVideoUrl，如果没有则显示原始视频）
 */
const loadGeneratedVideoHistory = async () => {
    try {
        console.log('[loadGeneratedVideoHistory] 开始加载历史视频列表');
        isLoadingHistory.value = true;

        // 启动性能监控
        setTimeout(() => {
            startPerformanceMonitor();
        }, 1000);

        // 🔧 【关键修复】确保每次都查询最新的数据库记录，避免缓存问题
        // 先清除所有缓存，确保下次查询从数据库读取最新数据
        console.log('[loadGeneratedVideoHistory] 清除缓存，强制从数据库加载最新数据...');

        // 查询所有 VideoGen 类型的任务
        const records = await TaskService.list('VideoGen', 1);  // 1 = TaskType.User

        console.log('[loadGeneratedVideoHistory] 查询到的总任务数:', records.length);

        // 调试：打印前5条任务的详细信息
        if (records.length > 0) {
            console.log('[loadGeneratedVideoHistory] 最新的5条任务:', records.slice(0, 5).map(r => ({
                id: r.id,
                title: r.title,
                status: r.status,
                hasResult: !!r.result,
                hasFinalVideoUrl: !!r.result?.finalVideoUrl,
                endTime: r.endTime,
                startTime: r.startTime,
                timestamp: r.endTime || r.startTime || 0
            })));
        }

        // 过滤成功的任务，并按时间倒序排列
        const successRecords = records
            .filter(r => {
                // ✅ 【简化逻辑】只显示有字幕的视频
                // 必须满足：有 result 字段 AND 有 finalVideoUrl 字段
                // 这是唯一的过滤条件，没有其他例外
                const hasResult = !!r.result;
                const hasFinalVideoUrl = !!r.result?.finalVideoUrl;
                const isValid = hasResult && hasFinalVideoUrl;

                if (!isValid) {
                    console.log('[loadGeneratedVideoHistory] ⏭️ 跳过（无字幕）:', {
                        id: r.id,
                        hasResult,
                        hasFinalVideoUrl
                    });
                }
                return isValid;
            })
            .map(r => {
                // 🔧 【关键修复】正确处理 result 字段，可能是字符串或对象
                // 有时 result 被存储为 JSON 字符串，需要先解析
                let resultObj = r.result;
                let resultUrl = '';
                let finalUrl = '';

                // 第一步：如果 result 是字符串且看起来像 JSON，则 parse 它
                if (typeof resultObj === 'string') {
                    if (resultObj.startsWith('{') || resultObj.startsWith('[')) {
                        try {
                            resultObj = JSON.parse(resultObj);
                            console.log('[loadGeneratedVideoHistory] 已解析 result JSON:', {id: r.id, resultObj});
                        } catch (e) {
                            // 如果 parse 失败，保持原始字符串
                            resultObj = r.result;
                        }
                    }
                }

                // 第二步：提取 URL
                if (typeof resultObj === 'string') {
                    // result 是纯字符串路径
                    resultUrl = resultObj;
                    finalUrl = resultObj;
                } else if (typeof resultObj === 'object' && resultObj) {
                    // result 是对象，提取 finalVideoUrl 或 url
                    resultUrl = resultObj.url || '';
                    finalUrl = resultObj.finalVideoUrl || resultObj.url || '';
                }

                // 第三步：验证 finalUrl 确实是字符串路径，不是 JSON
                if (finalUrl && (finalUrl.startsWith('{') || finalUrl.includes('{"'))) {
                    console.warn('[loadGeneratedVideoHistory] ⚠️ finalUrl 看起来像 JSON，重新处理:', finalUrl);
                    // 如果 finalUrl 仍然像 JSON，提取其中的实际路径
                    try {
                        const parsed = JSON.parse(finalUrl);
                        finalUrl = parsed.finalVideoUrl || parsed.url || '';
                    } catch (e) {
                        // 无法解析，使用原值
                    }
                }

                return {
                    id: r.id,
                    title: r.title,
                    // 🔧 【修复】使用 id 作为排序依据，因为 id 是自增的，能准确反映记录的创建顺序
                    // 之前使用 endTime 会导致新生成的视频（endTime=0）排在旧视频后面
                    timestamp: r.endTime || r.startTime || Date.now(),
                    startTime: r.startTime,
                    endTime: r.endTime,
                    status: r.status,
                    videoUrl: resultUrl,
                    // 🔧 【修复】确保 finalVideoUrl 总是纯字符串路径，不是 JSON
                    finalVideoUrl: finalUrl,
                    hasFinalSubtitles: !!(typeof resultObj === 'object' && resultObj?.finalVideoUrl),
                    templateId: r.modelConfig?.videoTemplateId,
                    templateName: r.modelConfig?.videoTemplateName,
                    templateUrl: r.modelConfig?.videoTemplateUrl,
                    modelConfig: r.modelConfig
                };
            })
            .sort((a, b) => b.id - a.id);  // 🔧 【修复】按 id 倒序，id 越大表示越新

        generatedVideoHistory.value = successRecords;
        console.log('[loadGeneratedVideoHistory] ✅ 已加载', successRecords.length, '条历史记录');

        // 🔧 【调试】统计一下所有任务的情况
        const totalRecords = records.length;
        const successCount = records.filter(r => r.status === 'success').length;
        const withResultCount = records.filter(r => r.result).length;
        const validCount = records.filter(r => r.status === 'success' && r.result).length;
        const withSubtitles = records.filter(r => r.result?.finalVideoUrl).length;

        console.log('[loadGeneratedVideoHistory] 📊 数据统计:', {
            总任务数: totalRecords,
            成功任务数: successCount,
            有result字段: withResultCount,
            最终显示数: validCount,
            包含字幕的: withSubtitles
        });

        console.log('[loadGeneratedVideoHistory] 📋 显示的完整列表:', successRecords.map(r => ({
            id: r.id,
            title: r.title,
            hasFinalSubtitles: r.hasFinalSubtitles,
            timestamp: r.timestamp,
            endTime: r.endTime
        })));

        // 自动选中最新的一条
        if (successRecords.length > 0) {
            selectedHistoryIndex.value = 0;
            await selectHistoryVideo(0);
        } else {
            console.warn('[loadGeneratedVideoHistory] ⚠️ 没有找到任何历史记录');
        }
    } catch (error) {
        console.error('[loadGeneratedVideoHistory] ❌ 加载历史视频列表失败:', error);
        Message.error(t('加载历史视频列表失败'));
    } finally {
        isLoadingHistory.value = false;
    }
};

/**
 * 🆕 【功能】加载音频历史记录
 */
const loadGeneratedAudioHistory = async () => {
    try {
        console.log('[loadGeneratedAudioHistory] 开始加载音频历史记录...');

        // 🔧 改用 listByStatus 确保获取到的是成功的任务，避免被失败任务挤占 limit
        // const records = await TaskService.list(
        //     'SoundGenerate',
        //     TaskType.User,
        //     50
        // );

        // 临时使用 listByStatus 获取最近成功的50条
        // 注意：底层 listByStatus 暂时不支持 limit，这里获取全部 success 的 sound 任务，在内存中截取
        // 为了性能，如果数据量太大可能需要优化 TaskService.listByStatus 支持 limit
        const records = await TaskService.listByStatus(
            'SoundGenerate',
            ['success']
        );

        console.log('[loadGeneratedAudioHistory] 获取到', records.length, '条成功状态的音频任务记录');
        if (records.length > 0) {
            console.log('[loadGeneratedAudioHistory] 最新一条记录:', {
                id: records[0].id,
                title: records[0].title,
                status: records[0].status,
                timestamp: records[0].endTime || records[0].startTime,
                timestampFormatted: new Date(records[0].endTime || records[0].startTime || 0).toLocaleString()
            });
        }

        // 过滤出成功的任务并提取音频URL
        const audioRecords = records
            .filter(r => r.result) // status 已经是 success 了，只要 check result
            .map(r => {
                let audioUrl = '';
                if (typeof r.result === 'string') {
                    audioUrl = r.result;
                } else if (typeof r.result === 'object' && r.result) {
                    audioUrl = r.result.url || r.result.audioUrl || '';
                }

                return {
                    id: r.id,
                    title: r.title || '未命名音频',
                    timestamp: r.endTime || r.startTime || 0,
                    audioUrl: audioUrl,
                    voicePromptId: r.modelConfig?.promptId,
                    voicePromptTitle: r.modelConfig?.promptTitle
                };
            })
            .filter(r => r.audioUrl)  // 只保留有音频URL的记录
            .sort((a, b) => b.timestamp - a.timestamp)  // 按时间倒序
            .slice(0, 50); // 截取前50条

        generatedAudioHistory.value = audioRecords;
        console.log('[loadGeneratedAudioHistory] ✅ 已加载', audioRecords.length, '条音频历史记录 (Top 50)');
        if (audioRecords.length > 0) {
            console.log('[loadGeneratedAudioHistory] 列表第一条:', {
                id: audioRecords[0].id,
                time: dayjs(audioRecords[0].timestamp).format('YYYY-MM-DD HH:mm:ss')
            });
        }
    } catch (error) {
        console.error('[loadGeneratedAudioHistory] ❌ 加载音频历史失败:', error);
    }
};

/**
 * 🆕 【功能】选择音频用于生成视频
 */
const selectAudioForVideo = (index: number | null) => {
    if (index === null) {
        // 取消选择，使用最新生成的音频
        selectedAudioIndex.value = null;
        selectedAudioUrl.value = audioPreviewUrl.value;
        console.log('[selectAudioForVideo] 取消选择，使用当前音频:', selectedAudioUrl.value);
    } else if (index >= 0 && index < generatedAudioHistory.value.length) {
        selectedAudioIndex.value = index;
        selectedAudioUrl.value = generatedAudioHistory.value[index].audioUrl;
        console.log('[selectAudioForVideo] 选择历史音频:', generatedAudioHistory.value[index]);
    }
};

/**
 * 🆕 【功能】选择视频作为发布内容
 */
const selectVideoForPublish = (videoUrl: string) => {
    selectedPublishVideoUrl.value = videoUrl;
    // 同步更新字幕和BGM区域显示的视频
    if (videoUrl) {
        finalVideoUrl.value = videoUrl;
        console.log('[selectVideoForPublish] 已选择发布视频:', videoUrl);
        Message.success(t('已选择该视频作为发布内容'));
    }
};

/**
 * 【功能】选择历史视频，并加载对应的形象
 */
const selectHistoryVideo = async (index: number) => {
    try {
        if (index < 0 || index >= generatedVideoHistory.value.length) {
            console.warn('[selectHistoryVideo] 索引越界:', index);
            return;
        }

        // 中止上一次的加载（如果存在）
        if (videoSwitchAbortController) {
            videoSwitchAbortController.abort();
        }
        videoSwitchAbortController = new AbortController();
        const currentAbortController = videoSwitchAbortController;

        isLoadingHistoryVideo.value = true;

        const historyItem = generatedVideoHistory.value[index];
        selectedHistoryIndex.value = index;

        console.log('[selectHistoryVideo] 选择历史视频:', historyItem);

        // 🔧 【修复】设置历史视频URL - 优先使用带字幕的最终视频
        // 优先级：finalVideoUrl（带字幕最终视频）> videoUrl（基础视频）
        let selectedVideoUrl = '';

        if (historyItem.finalVideoUrl) {
            // 使用带字幕的最终视频
            if (typeof historyItem.finalVideoUrl === 'string') {
                selectedVideoUrl = historyItem.finalVideoUrl;
            } else if (historyItem.finalVideoUrl.url) {
                selectedVideoUrl = historyItem.finalVideoUrl.url;
            }
            console.log('[selectHistoryVideo] 使用带字幕的最终视频URL:', selectedVideoUrl);
        } else if (historyItem.videoUrl) {
            // 回退到基础视频
            if (typeof historyItem.videoUrl === 'string') {
                selectedVideoUrl = historyItem.videoUrl;
            } else if (historyItem.videoUrl.url) {
                selectedVideoUrl = historyItem.videoUrl.url;
            }
            console.log('[selectHistoryVideo] 使用基础视频URL（未找到最终视频）:', selectedVideoUrl);
        }

        if (selectedVideoUrl) {
            // 🔧 【关键修复】先检查 selectedVideoUrl 是否是 JSON 字符串，如果是就 parse 它
            let cleanUrl = selectedVideoUrl;

            // 如果 selectedVideoUrl 看起来像 JSON，解析它
            if (typeof selectedVideoUrl === 'string' && (selectedVideoUrl.startsWith('{') || selectedVideoUrl.includes('{"'))) {
                console.log('[selectHistoryVideo] 检测到 JSON 格式的 URL，尝试解析:', selectedVideoUrl.substring(0, 100));
                try {
                    const parsed = JSON.parse(selectedVideoUrl);
                    cleanUrl = parsed.finalVideoUrl || parsed.url || selectedVideoUrl;
                    console.log('[selectHistoryVideo] ✅ 已解析 JSON，提取的真实URL:', cleanUrl);
                } catch (e) {
                    console.warn('[selectHistoryVideo] ⚠️ JSON 解析失败，使用原值:', e.message);
                }
            }

            // 统一 URL 格式，确保都包含 file:// 前缀
            const videoUrlForPlayback = cleanUrl.startsWith('file://')
                ? cleanUrl
                : 'file://' + cleanUrl;

            // 🔧 【关键修复】只设置历史视频URL，不修改当前的 finalVideoUrl
            // finalVideoUrl 应该始终保持最新生成的视频，不被历史视频选择影响
            historyVideoUrl.value = videoUrlForPlayback;

            console.log('[selectHistoryVideo] 历史视频URL:', {
                originalUrl: selectedVideoUrl,
                cleanUrl: cleanUrl,
                historyVideoUrl: historyVideoUrl.value,
                finalVideoUrl: finalVideoUrl.value,
                note: 'finalVideoUrl 保持不变，只更新 historyVideoUrl'
            });
        }

        // 加载历史视频对应的形象
        if (historyItem.templateId) {
            try {
                const template = await VideoTemplateService.get(historyItem.templateId);
                if (currentAbortController.signal.aborted) return;

                if (template && template.video) {
                    historyTemplateVideoUrl.value = template.video;
                    console.log('[selectHistoryVideo] ✅ 已加载历史形象:', template.video);
                } else {
                    console.warn('[selectHistoryVideo] ⚠️ 未找到历史形象');
                    // 尝试使用保存的URL
                    if (historyItem.templateUrl) {
                        historyTemplateVideoUrl.value = historyItem.templateUrl;
                    }
                }
            } catch (templateError) {
                if (currentAbortController.signal.aborted) return;
                console.warn('[selectHistoryVideo] 加载模板失败，使用保存的URL:', templateError);
                if (historyItem.templateUrl) {
                    historyTemplateVideoUrl.value = historyItem.templateUrl;
                }
            }
        }

        // 🔧 【优化】使用事件监听快速等待视频加载（0.5-1秒）
        await new Promise<void>((resolve) => {
            const player1 = templateVideoPlayer.value?.$el?.querySelector('video') as HTMLVideoElement;
            const player2 = finalVideoPlayer.value?.$el?.querySelector('video') as HTMLVideoElement;

            if (!player1 || !player2) {
                console.warn('[selectHistoryVideo] 播放器未找到，跳过播放');
                resolve();
                return;
            }

            let player1Ready = false;
            let player2Ready = false;
            let timeout: any = null;

            const tryPlay = () => {
                if (currentAbortController.signal.aborted) {
                    resolve();
                    return;
                }

                if (player1Ready && player2Ready) {
                    if (timeout) clearTimeout(timeout);

                    try {
                        // 重置到开始位置
                        player1.currentTime = 0;
                        player2.currentTime = 0;

                        // 同步播放
                        Promise.all([
                            player1.play().catch(() => {
                            }),
                            player2.play().catch(() => {
                            })
                        ]).then(() => {
                            console.log('[selectHistoryVideo] ✅ 视频已同步播放');
                        });
                    } catch (e) {
                        console.warn('[selectHistoryVideo] 播放失败:', e);
                    }

                    resolve();
                }
            };

            // 监听元数据加载完成事件（通常只需 200-500ms）
            const onPlayer1Ready = () => {
                player1Ready = true;
                console.log('[selectHistoryVideo] 左侧视频已就绪');
                tryPlay();
            };

            const onPlayer2Ready = () => {
                player2Ready = true;
                console.log('[selectHistoryVideo] 右侧视频已就绪');
                tryPlay();
            };

            // 检查是否已经加载好（可能已经在缓存中）
            if (player1.readyState >= 1) {  // HAVE_METADATA 就够了
                player1Ready = true;
            } else {
                player1.addEventListener('loadedmetadata', onPlayer1Ready, {once: true});
                player1.addEventListener('canplay', onPlayer1Ready, {once: true});
            }

            if (player2.readyState >= 1) {
                player2Ready = true;
            } else {
                player2.addEventListener('loadedmetadata', onPlayer2Ready, {once: true});
                player2.addEventListener('canplay', onPlayer2Ready, {once: true});
            }

            // 立即尝试播放（如果都准备好了）
            tryPlay();

            // 超时保护：最多等待 2 秒（比之前的 5 秒快）
            timeout = setTimeout(() => {
                console.warn('[selectHistoryVideo] 等待超时，强制开始播放');
                player1Ready = true;
                player2Ready = true;
                tryPlay();
            }, 2000);
        });

    } catch (error) {
        console.error('[selectHistoryVideo] ❌ 选择历史视频失败:', error);
        Message.error(t('加载历史视频失败'));
    } finally {
        isLoadingHistoryVideo.value = false;
    }
};

/**
 * 同步播放两个视频（改进版：时间轴同步）
 */
const syncPlayVideos = async () => {
    try {
        // 获取两个视频播放器的DOM元素
        const player1 = templateVideoPlayer.value?.$el?.querySelector('video') as HTMLVideoElement;
        const player2 = finalVideoPlayer.value?.$el?.querySelector('video') as HTMLVideoElement;

        if (!player1 || !player2) {
            console.warn('[syncPlayVideos] 播放器未就绪');
            return;
        }

        // 同步到相同的时间点（取两者的平均值）
        const avgTime = (player1.currentTime + player2.currentTime) / 2;
        player1.currentTime = avgTime;
        player2.currentTime = avgTime;

        // 确保两个视频都已缓冲到当前位置
        await Promise.all([
            new Promise<void>((resolve) => {
                if (player1.readyState >= 2) {
                    resolve();
                } else {
                    player1.addEventListener('canplay', () => resolve(), {once: true});
                }
            }),
            new Promise<void>((resolve) => {
                if (player2.readyState >= 2) {
                    resolve();
                } else {
                    player2.addEventListener('canplay', () => resolve(), {once: true});
                }
            })
        ]);

        // 同步播放
        await Promise.all([
            player1.play(),
            player2.play()
        ]);

        console.log('[syncPlayVideos] 同步播放成功, 时间点:', avgTime);
    } catch (error) {
        console.error('[syncPlayVideos] 同步播放失败:', error);
    }
};

/**
 * 同步暂停两个视频
 */
const syncPauseVideos = () => {
    try {
        const player1 = templateVideoPlayer.value?.$el?.querySelector('video') as HTMLVideoElement;
        const player2 = finalVideoPlayer.value?.$el?.querySelector('video') as HTMLVideoElement;

        if (player1) {
            player1.pause();
        }
        if (player2) {
            player2.pause();
        }

        console.log('[syncPauseVideos] 同步暂停成功');
    } catch (error) {
        console.error('[syncPauseVideos] 同步暂停失败:', error);
    }
};

/**
 * 启动性能监控
 */
const startPerformanceMonitor = () => {
    if (performanceMonitorInterval) {
        clearInterval(performanceMonitorInterval);
    }

    let lastLeftFrames = 0;
    let lastRightFrames = 0;
    let lastTime = performance.now();

    performanceMonitorInterval = setInterval(() => {
        try {
            const player1 = templateVideoPlayer.value?.$el?.querySelector('video') as HTMLVideoElement;
            const player2 = finalVideoPlayer.value?.$el?.querySelector('video') as HTMLVideoElement;

            const now = performance.now();
            const timeDiff = (now - lastTime) / 1000;

            // 左侧视频
            if (player1) {
                const quality1 = (player1 as any).getVideoPlaybackQuality?.();
                if (quality1) {
                    const fps1 = Math.round((quality1.totalVideoFrames - lastLeftFrames) / timeDiff);
                    const dropped1 = quality1.droppedVideoFrames;

                    const fpsElem = document.getElementById('left-fps');
                    const droppedElem = document.getElementById('left-dropped');

                    if (fpsElem) fpsElem.textContent = fps1 || '0';
                    if (droppedElem) {
                        droppedElem.textContent = dropped1 || '0';
                        droppedElem.className = dropped1 > 10 ? 'text-red-400 font-bold ml-1' :
                            dropped1 > 0 ? 'text-yellow-400 font-bold ml-1' :
                                'text-green-400 font-bold ml-1';
                    }

                    lastLeftFrames = quality1.totalVideoFrames;
                }
            }

            // 右侧视频
            if (player2) {
                const quality2 = (player2 as any).getVideoPlaybackQuality?.();
                if (quality2) {
                    const fps2 = Math.round((quality2.totalVideoFrames - lastRightFrames) / timeDiff);
                    const dropped2 = quality2.droppedVideoFrames;

                    const fpsElem = document.getElementById('right-fps');
                    const droppedElem = document.getElementById('right-dropped');

                    if (fpsElem) fpsElem.textContent = fps2 || '0';
                    if (droppedElem) {
                        droppedElem.textContent = dropped2 || '0';
                        droppedElem.className = dropped2 > 10 ? 'text-red-400 font-bold ml-1' :
                            dropped2 > 0 ? 'text-yellow-400 font-bold ml-1' :
                                'text-green-400 font-bold ml-1';
                    }

                    lastRightFrames = quality2.totalVideoFrames;
                }
            }

            lastTime = now;
        } catch (error) {
            console.error('[startPerformanceMonitor] 性能监控错误:', error);
        }
    }, 1000);

    console.log('[startPerformanceMonitor] 性能监控已启动');
};

/**
 * 停止性能监控
 */
const stopPerformanceMonitor = () => {
    if (performanceMonitorInterval) {
        clearInterval(performanceMonitorInterval);
        performanceMonitorInterval = null;
        console.log('[stopPerformanceMonitor] 性能监控已停止');
    }
};

// 关闭浏览器窗口
const closeBrowserView = async () => {
    showBrowserView.value = false;

    // 关闭对应平台的浏览器
    if (currentBrowserPlatform.value) {
        try {
            await window.$mapi.publish.closeBrowser({platform: currentBrowserPlatform.value});
            console.log(`已关闭${currentBrowserPlatform.value}浏览器`);
            currentBrowserPlatform.value = "";
        } catch (error) {
            console.error(`关闭浏览器失败:`, error);
        }
    }
};

// 一键仿写所有标题 - 直接替换生成5个新标题
const rewriteAllTitles = async () => {
    if (topicLibrary.value.length === 0) {
        Message.warning(t("没有可用的标题"));
        return;
    }

    // 检查是否选中了对标
    if (selectedAccountIndex.value === null) {
        Message.warning(t("请先选择一个对标"));
        return;
    }

    const currentAccount = learnedAccounts.value[selectedAccountIndex.value];
    if (!currentAccount || !currentAccount.topicLibrary || currentAccount.topicLibrary.length === 0) {
        Message.warning(t("当前对标没有选题"));
        return;
    }

    // 检查是否配置了文本模型
    if (!settings.value.textModelKey) {
        Message.error(t("请先在设置中配置文本模型"));
        return;
    }

    // 解析 textModelKey (格式: providerId|modelId)
    const [providerId, modelId] = settings.value.textModelKey.split('|');
    if (!providerId || !modelId) {
        Message.error(t("文本模型配置格式错误"));
        return;
    }

    // 标记所有为仿写中
    currentAccount.topicLibrary.forEach(topic => {
        topic.isRewriting = true;
    });

    try {
        const titles = currentAccount.topicLibrary.map(t => t.rewritten || t.original);
        const accountName = currentAccount.name;

        // 获取模型配置
        const {useModelStore} = await import('../../module/Model/store/model');
        const modelStore = useModelStore();

        const provider = modelStore.providers.find(p => p.id === providerId);
        if (!provider) {
            Message.error(t("未找到配置的模型提供商"));
            currentAccount.topicLibrary.forEach(topic => {
                topic.isRewriting = false;
            });
            return;
        }

        const model = provider.data.models.find(m => m.id === modelId);
        if (!model) {
            Message.error(t("未找到配置的模型"));
            currentAccount.topicLibrary.forEach(topic => {
                topic.isRewriting = false;
            });
            return;
        }

        // 构建API URL
        let apiUrl = provider.apiUrl;
        if (provider.data.apiHost) {
            apiUrl = provider.data.apiHost;
        }
        if (provider.type === 'openai') {
            apiUrl = buildChatCompletionsUrl(apiUrl);
        }

        const modelConfig = {
            providerId: provider.id,
            modelId: model.id,
            apiUrl: apiUrl,
            apiHost: provider.data.apiHost || '',
            apiKey: provider.data.apiKey || '',
            type: provider.type
        };

        // 调用AI进行标题仿写 - 生成5个新标题
        const result = await window.$mapi.ipAgent.rewriteTitles({
            titles,
            accountName,
            modelConfig,
            rewritePrompt: settings.value.topicRewritePrompt
        });

        if (result.success && result.rewrittenTitles) {
            // 直接替换当前账号的选题库为新的6个标题
            currentAccount.topicLibrary = result.rewrittenTitles.slice(0, 6).map((title: string) => ({
                original: title,
                rewritten: null,
                isRewriting: false,
                script: null,
                isGeneratingScript: false
            }));
            Message.success(t("仿写完成！已生成6个新标题"));
        } else {
            currentAccount.topicLibrary.forEach(topic => {
                topic.isRewriting = false;
            });
            Message.error(result.message || t("仿写失败，请重试"));
        }
    } catch (error) {
        console.error("仿写标题失败:", error);
        if (selectedAccountIndex.value !== null) {
            const account = learnedAccounts.value[selectedAccountIndex.value];
            if (account) {
                account.topicLibrary.forEach(topic => {
                    topic.isRewriting = false;
                });
            }
        }
        Message.error(t("网络错误，请检查连接"));
    }
};

// 选择标题
const selectTopic = (index: number) => {
    selectedTopicIndex.value = index;
};

// 撰写文案 - 根据选中的标题生成文案
const generateScriptFromTopic = async () => {
    // 根据当前页签选择不同的处理逻辑
    if (activeIPBrainTab.value === 'videoWrite') {
        // 智能视频仿写模式
        await generateScriptFromVideoContent();
    } else {
        // IP智能大脑模式
        await generateScriptFromIPBrain();
    }
};

// IP智能大脑模式 - 基于选题生成文案
const generateScriptFromIPBrain = async () => {
    if (selectedAccountIndex.value === null) {
        Message.warning(t("请先选择一个对标"));
        return;
    }

    if (selectedTopicIndex.value === null) {
        Message.warning(t("请先在选题库中选择一个标题"));
        return;
    }

    const topic = topicLibrary.value[selectedTopicIndex.value];
    if (!topic) {
        Message.error(t("未找到选中的标题"));
        return;
    }

    if (!settings.value.textModelKey) {
        Message.error(t("请先在设置中配置文本模型"));
        return;
    }

    const titleToUse = topic.rewritten || topic.original;
    isGeneratingScript.value = true;

    try {
        // 获取模型配置
        const [providerId, modelId] = settings.value.textModelKey.split('|');
        const {useModelStore} = await import('../../module/Model/store/model');
        const modelStore = useModelStore();

        const provider = modelStore.providers.find(p => p.id === providerId);
        const model = provider?.data.models.find(m => m.id === modelId);

        if (!provider || !model) {
            Message.error(t("模型配置错误"));
            isGeneratingScript.value = false;
            return;
        }

        // 构建API URL
        let apiUrl = provider.apiUrl;
        if (provider.data.apiHost) {
            apiUrl = provider.data.apiHost;
        }
        if (provider.type === 'openai') {
            apiUrl = buildChatCompletionsUrl(apiUrl);
        }

        const modelConfig = {
            providerId: provider.id,
            modelId: model.id,
            apiUrl: apiUrl,
            apiHost: provider.data.apiHost || '',
            apiKey: provider.data.apiKey || '',
            type: provider.type
        };

        // 获取当前账号名称
        const accountName = selectedAccountIndex.value !== null
            ? learnedAccounts.value[selectedAccountIndex.value]?.name || ''
            : '';

        // 🆕 根据选择的语言动态构建提示词
        let finalScriptPrompt = settings.value.scriptPrompt;
        if (audioLanguage.value && audioLanguage.value !== '中文') {
            // 在提示词开头添加语言要求
            finalScriptPrompt = `请用${audioLanguage.value}输出文案。\n\n` + finalScriptPrompt;
            console.log(`[generateScriptFromTopic] 已添加语言前缀: ${audioLanguage.value}`);
        }

        // 调用AI生成文案
        const result = await window.$mapi.ipAgent.generateScript({
            title: titleToUse,
            accountName: accountName,
            count: scriptWordCount.value,
            modelConfig,
            scriptPrompt: finalScriptPrompt  // 🆕 使用带语言前缀的提示词
        });

        if (result.success && result.script) {
            scriptContent.value = result.script;
            try {
                const _u = JSON.parse(localStorage.getItem('auth_user') || '{}');
                window.require('electron').ipcRenderer.invoke('auth:reportGeneration', {
                    userId: _u.id,
                    type: 'script',
                    detail: 'IP大脑文案'
                });
            } catch (e) {
            }
            Message.success(t("文案生成完成"));
        } else {
            Message.error(t("文案生成失败，请重试"));
        }
    } catch (error) {
        console.error("生成文案失败:", error);
        Message.error(t("网络错误，请检查连接"));
    } finally {
        isGeneratingScript.value = false;
    }
};

// 智能视频仿写模式 - 基于识别内容进行仿写
const generateScriptFromVideoContent = async () => {
    if (!recognizedText.value) {
        Message.warning(t("请先使用智能视频仿写功能识别视频内容"));
        return;
    }

    if (!settings.value.textModelKey) {
        Message.error(t("请先在设置中配置文本模型"));
        return;
    }

    isGeneratingScript.value = true;

    try {
        // 获取模型配置
        const [providerId, modelId] = settings.value.textModelKey.split('|');
        const {useModelStore} = await import('../../module/Model/store/model');
        const modelStore = useModelStore();

        const provider = modelStore.providers.find(p => p.id === providerId);
        const model = provider?.data.models.find(m => m.id === modelId);

        if (!provider || !model) {
            Message.error(t("模型配置错误"));
            isGeneratingScript.value = false;
            return;
        }

        // 构建API URL
        let apiUrl = provider.apiUrl;
        if (provider.data.apiHost) {
            apiUrl = provider.data.apiHost;
        }
        if (provider.type === 'openai') {
            apiUrl = buildChatCompletionsUrl(apiUrl);
        }

        const modelConfig = {
            providerId: provider.id,
            modelId: model.id,
            apiUrl: apiUrl,
            apiHost: provider.data.apiHost || '',
            apiKey: provider.data.apiKey || '',
            type: provider.type
        };

        // 使用仿写提示词进行仿写
        const finalRewritePrompt = (settings.value.rewritePrompt || '').trim().length > 0
            ? settings.value.rewritePrompt
            : `请基于以下视频原文案，创作一个新的仿写文案：\n\n原文案：{{content}}\n\n要求：\n1. 保持原文案的核心内容和风格\n2. 适当改变表达方式和用词\n3. 确保新文案通顺自然\n4. 长度约{{count}}字\n\n请直接输出仿写后的文案：`;

        // 替换占位符
        let prompt = finalRewritePrompt
            .replace(/{content}/g, recognizedText.value)
            .replace(/{{content}}/g, recognizedText.value)
            .replace(/{{count}}/g, String(scriptWordCount.value))
            .replace(/{count}/g, String(scriptWordCount.value));

        // 🆕 根据选择的语言动态添加语言前缀（与文案生成保持一致）
        if (audioLanguage.value && audioLanguage.value !== '中文') {
            prompt = `请用${audioLanguage.value}输出文案。\n\n` + prompt;
            console.log(`[generateScriptFromVideoContent] 已添加语言前缀: ${audioLanguage.value}`);
        }

        // 日志：显示发送给AI的完整信息
        console.log('【智能视频仿写】发送给AI的完整信息：', {
            识别的原始内容: recognizedText.value,
            目标字数: scriptWordCount.value,
            完整提示词: prompt,
            模型信息: {
                providerId: provider.id,
                providerTitle: provider.title,
                modelId: model.id,
                modelName: model.name
            }
        });

        // 调用模型API
        const result = await modelStore.chat(
            provider.id,
            model.id,
            prompt,
            {loading: false}
        );

        // 日志：显示AI的返回结果
        console.log('【智能视频仿写】AI返回结果：', result);

        if (result && result.code === 0 && result.data?.content) {
            scriptContent.value = result.data.content;
            try {
                const _u = JSON.parse(localStorage.getItem('auth_user') || '{}');
                window.require('electron').ipcRenderer.invoke('auth:reportGeneration', {
                    userId: _u.id,
                    type: 'script',
                    detail: '视频仿写文案'
                });
            } catch (e) {
            }
            Message.success(t("文案仿写完成"));
        } else {
            const errorMsg = typeof result?.msg === 'string'
                ? result.msg
                : t("文案仿写失败，请重试");
            Message.error(errorMsg);
        }
    } catch (error) {
        console.error("仿写文案失败:", error);
        Message.error(t("网络错误，请检查连接"));
    } finally {
        isGeneratingScript.value = false;
    }
};

/**
 * AI法务检测
 */
const handleLegalCheck = async () => {
    if (!scriptContent.value || scriptContent.value.trim().length === 0) {
        Message.warning(t('请先输入文案内容'));
        return;
    }

    if (!settings.value.textModelKey) {
        Message.warning(t('请先在设置中配置文案模型'));
        return;
    }

    try {
        isCheckingLegal.value = true;
        legalCheckLoading.value = true;
        legalCheckDialogVisible.value = true;

        const [providerId, modelId] = settings.value.textModelKey.split('|');
        const {useModelStore} = await import("../../module/Model/store/model");
        const modelStore = useModelStore();

        const prompt = `你是一名专业的短视频法务审核专家。请审核以下短视频的文案是否存在违禁词、敏感词、虚假宣传、极限词（如"第一"、"最好"）等法律风险以及短视频平台常见的违禁词，避免绝对化表述和违禁词，避免负向，消极的立场，对大健康，医疗等重点行业要严格审核。

【待审核文案】
${scriptContent.value}

【审核要求】
1. 找出文案中的所有违禁词/敏感词。
2. 为每个违禁词提供一个合规的替换词（如果建议直接删除，替换词为空字符串）。
3. 说明每个违禁词的违规原因。
4. 给出整体审核意见。
5. 给出修正后的完整优化文案。

【输出格式】
请直接返回 JSON 格式：
{
  "risks": [
    {
      "word": "违禁词原文",
      "recommendation": "替换词",
      "reason": "违规原因"
    }
  ],
  "analysis": "整体审核意见",
  "fixedText": "修正后的完整文案",
  "hasRisk": true/false
}

除 JSON 外不要输出任何其他内容。`;

        const result = await modelStore.chat(providerId, modelId, prompt, {loading: false});

        if (!result || result.code !== 0 || !result.data?.content) {
            throw new Error(result?.msg || t('AI审核请求失败'));
        }

        let content = result.data.content;
        const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            content = jsonMatch[1] || jsonMatch[0];
        }

        let parsed: any;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            parsed = {
                risks: [],
                analysis: result.data.content,
                fixedText: '',
                hasRisk: true
            };
        }

        const risks = parsed.risks || [];
        const highlightedText = highlightRisksInText(scriptContent.value, risks);

        legalCheckLoading.value = false;
        legalCheckResult.value = {
            hasViolations: parsed.hasRisk === true || risks.length > 0,
            risks: risks,
            analysis: parsed.analysis || '',
            highlightedText: highlightedText,
            fixedText: parsed.fixedText || '',
            totalCount: risks.length
        };

        if (risks.length === 0) {
            Message.success(t('未检测到违规内容'));
        } else {
            const riskWords = [...new Set(risks.map((r: any) => r.word))];
            Message.warning(t('检测到') + ` ${risks.length} ` + t('处违规内容') + `：${riskWords.join('、')}`);
        }

    } catch (error: any) {
        legalCheckLoading.value = false;
        legalCheckDialogVisible.value = false;
        console.error('[handleLegalCheck] 检测失败:', error);
        Message.error(t('检测失败：') + (error?.message || error));
    } finally {
        isCheckingLegal.value = false;
    }
};

const highlightRisksInText = (text: string, risks: { word: string }[]): string => {
    let result = text;
    const sortedRisks = [...risks].sort((a, b) => b.word.length - a.word.length);
    sortedRisks.forEach(risk => {
        const escaped = risk.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escaped, 'g'), `<span class="bg-red-200 text-red-800 px-1 rounded">${risk.word}</span>`);
    });
    return result;
};

const handleFixViolations = () => {
    if (legalCheckResult.value.fixedText) {
        scriptContent.value = legalCheckResult.value.fixedText;
        legalCheckDialogVisible.value = false;
        Message.success(t('已采用AI优化后的文案'));
    } else if (legalCheckResult.value.risks && legalCheckResult.value.risks.length > 0) {
        let fixed = scriptContent.value;
        const sortedRisks = [...legalCheckResult.value.risks].sort((a, b) => b.word.length - a.word.length);
        sortedRisks.forEach(risk => {
            const escaped = risk.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            fixed = fixed.replace(new RegExp(escaped, 'g'), risk.recommendation || '');
        });
        scriptContent.value = fixed;
        legalCheckDialogVisible.value = false;
        Message.success(t('已自动修正所有违规内容'));
    } else {
        Message.info(t('没有需要修正的内容'));
    }
};

// 生成标题、标签和关键词 - 根据文案内容生成
const generateTitleTags = async () => {
    if (!scriptContent.value) {
        Message.warning(t("请先生成或输入文案内容"));
        return;
    }

    if (!settings.value.textModelKey) {
        Message.error(t("请先在设置中配置文本模型"));
        return;
    }

    isGeneratingTitleTags.value = true;

    try {
        const [providerId, modelId] = settings.value.textModelKey.split('|');
        const {useModelStore} = await import('../../module/Model/store/model');
        const modelStore = useModelStore();

        const provider = modelStore.providers.find(p => p.id === providerId);
        const model = provider?.data.models.find(m => m.id === modelId);

        if (!provider || !model) {
            Message.error(t("模型配置错误"));
            isGeneratingTitleTags.value = false;
            return;
        }

        // 构建API URL
        let apiUrl = provider.apiUrl;
        if (provider.data.apiHost) {
            apiUrl = provider.data.apiHost;
        }
        if (provider.type === 'openai') {
            apiUrl = buildChatCompletionsUrl(apiUrl);
        }

        const modelConfig = {
            providerId: provider.id,
            modelId: model.id,
            apiUrl: apiUrl,
            apiHost: provider.data.apiHost || '',
            apiKey: provider.data.apiKey || '',
            type: provider.type
        };

        // 调用AI生成标题、标签和关键词
        const result = await window.$mapi.ipAgent.generateTitleTags({
            content: scriptContent.value,
            modelConfig,
            titleTagPrompt: settings.value.titleTagPrompt
        });

        if (result.success && result.titleTags) {
            // 解析返回的JSON结果
            try {
                // 清理可能的多余字符
                let cleanedJson = result.titleTags.trim();

                // 移除可能的markdown代码块标记（双重保险）
                cleanedJson = cleanedJson.replace(/```json\s*/gi, '');
                cleanedJson = cleanedJson.replace(/```\s*/g, '');
                cleanedJson = cleanedJson.trim();

                // 尝试提取JSON对象（如果有多余的文本）
                const jsonMatch = cleanedJson.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    cleanedJson = jsonMatch[0];
                }

                console.log("清理后的JSON:", cleanedJson);

                const parsed = JSON.parse(cleanedJson);
                // 清除标题中的书名号《》和引号
                generatedTitle.value = (parsed.title || "").replace(/[《》""'']/g, '').trim();
                // 兼容tags为数组或字符串格式
                // 清除标签和关键词中的括号说明（如"火锅（核心主题）"→"火锅"）
                // 如果清除后为空，则去掉括号保留内容（如"（核心主题）"→"核心主题"）
                const stripParenthetical = (str: string): string => {
                    const result = str.replace(/[（(][^）)]*[）)]/g, '').trim();
                    return result || str.replace(/[（）()]/g, '').trim();
                };

                if (Array.isArray(parsed.tags)) {
                    generatedTags.value = parsed.tags.map((t: string) => stripParenthetical(String(t))).filter((t: string) => t).join(", ");
                } else if (typeof parsed.tags === 'string' && parsed.tags.trim()) {
                    // 将中文逗号替换为英文逗号，确保标签组件能正确分割
                    generatedTags.value = stripParenthetical(parsed.tags.trim().replace(/，/g, ','));
                } else {
                    generatedTags.value = "";
                }

                // 🔴 关键修复：处理分类关键词格式
                if (parsed.keywords && typeof parsed.keywords === 'object' && !Array.isArray(parsed.keywords)) {
                    console.log('[generateTitleTags] ✅ 检测到分类关键词格式:', parsed.keywords);

                    const categories = ['重点词/成语词', '描述词', '行动词', '情感词'];
                    const newGroupKeywordTexts: { [key: string]: string } = {...groupKeywordTexts.value};

                    categories.forEach(cat => {
                        if (parsed.keywords[cat] && Array.isArray(parsed.keywords[cat])) {
                            const cleanedKeywords = parsed.keywords[cat].map((k: string) => stripParenthetical(String(k))).filter((k: string) => k && k.trim());
                            const text = cleanedKeywords.join('\n');
                            console.log(`[generateTitleTags] 📝 更新 ${cat}: ${text.length} 字符`);

                            // 🔴 关键：先调用 updateGroupKeywords（会触发 IPC 保存）
                            try {
                                updateGroupKeywords(cat, text);
                                console.log(`[generateTitleTags] ✅ 已调用 updateGroupKeywords("${cat}")，应该触发 [keywordGroup:IPC:saveGroup] 日志`);
                            } catch (err) {
                                console.error(`[generateTitleTags] ❌ updateGroupKeywords("${cat}") 失败:`, err);
                            }

                            // 然后更新 groupKeywordTexts 确保UI显示
                            newGroupKeywordTexts[cat] = text;
                        } else {
                            newGroupKeywordTexts[cat] = '';
                        }
                    });

                    // 强制触发响应式更新
                    groupKeywordTexts.value = newGroupKeywordTexts;
                    console.log('[generateTitleTags] ✅ groupKeywordTexts 已更新:', {
                        '重点词/成语词': newGroupKeywordTexts['重点词/成语词']?.length || 0,
                        '描述词': newGroupKeywordTexts['描述词']?.length || 0,
                        '行动词': newGroupKeywordTexts['行动词']?.length || 0,
                        '情感词': newGroupKeywordTexts['情感词']?.length || 0
                    });

                    // 等待一个 tick 确保 UI 更新
                    await nextTick();
                    console.log('[generateTitleTags] ✅ nextTick 完成，UI应该已更新');

                    // 兼容旧代码：合并所有关键词
                    const allKeywords: string[] = [];
                    categories.forEach(cat => {
                        if (parsed.keywords[cat] && Array.isArray(parsed.keywords[cat])) {
                            allKeywords.push(...parsed.keywords[cat].map((k: string) => stripParenthetical(String(k))).filter((k: string) => k && k.trim()));
                        }
                    });
                    generatedKeywords.value = allKeywords.join("\n");
                } else if (Array.isArray(parsed.keywords)) {
                    // 兼容旧格式：keywords是数组
                    const cleanedList = parsed.keywords.map((k: string) => stripParenthetical(String(k))).filter((k: string) => k && k.trim());
                    generatedKeywords.value = cleanedList.join("\n");
                    // 🔧 修复：数组关键词也分配到第一个默认分组
                    if (cleanedList.length > 0) {
                        const firstGroupName = '重点词/成语词';
                        const text = cleanedList.join('\n');
                        try {
                            updateGroupKeywords(firstGroupName, text);
                            const newGroupKeywordTexts = {...groupKeywordTexts.value};
                            newGroupKeywordTexts[firstGroupName] = text;
                            groupKeywordTexts.value = newGroupKeywordTexts;
                        } catch (err) {
                            console.error(`[generateTitleTags] updateGroupKeywords failed:`, err);
                        }
                    }
                } else if (typeof parsed.keywords === 'string' && parsed.keywords.trim()) {
                    // 🔧 修复：keywords为字符串时，分配到第一个默认分组，不再丢弃
                    console.log('[generateTitleTags] keywords为字符串格式，分配到默认分组');
                    generatedKeywords.value = stripParenthetical(parsed.keywords.trim());
                    const keywordList = parsed.keywords.trim().split(/[,，\n]+/).map((k: string) => stripParenthetical(k.trim())).filter((k: string) => k);
                    if (keywordList.length > 0) {
                        const firstGroupName = '重点词/成语词';
                        const text = keywordList.join('\n');
                        try {
                            updateGroupKeywords(firstGroupName, text);
                            const newGroupKeywordTexts = {...groupKeywordTexts.value};
                            newGroupKeywordTexts[firstGroupName] = text;
                            groupKeywordTexts.value = newGroupKeywordTexts;
                        } catch (err) {
                            console.error(`[generateTitleTags] updateGroupKeywords failed:`, err);
                        }
                    }
                } else {
                    generatedKeywords.value = "";
                }

                Message.success(t("标题、标签和关键词生成完成"));
                try {
                    const _u = JSON.parse(localStorage.getItem('auth_user') || '{}');
                    window.require('electron').ipcRenderer.invoke('auth:reportGeneration', {
                        userId: _u.id,
                        type: 'script',
                        detail: '标题标签关键词'
                    });
                } catch (e) {
                }

                // 🔴 关键修复：生成完成后，强制刷新 KeywordGroupManager 组件UI
                await nextTick();
                if (keywordGroupManagerRef.value && keywordGroupManagerRef.value.loadGroups) {
                    console.log('[generateTitleTags] 🔄 生成完成，强制刷新 KeywordGroupManager 组件UI');
                    keywordGroupManagerRef.value.loadGroups(keywordGroups.value);
                } else {
                    console.warn('[generateTitleTags] ⚠️ keywordGroupManagerRef未找到或没有loadGroups方法');
                }
            } catch (parseError) {
                console.error("JSON解析错误:", parseError);
                console.error("原始内容:", result.titleTags);

                // 清除标签和关键词中的括号说明
                const stripParenthetical = (str: string): string => {
                    const result = str.replace(/[（(][^）)]*[）)]/g, '').trim();
                    return result || str.replace(/[（）()]/g, '').trim();
                };

                // 🔧 修复：JSON解析失败时，尝试从纯文本中提取标题/标签/关键词
                const rawText = result.titleTags || '';
                const rawLines = rawText.split('\n').filter((l: string) => l.trim());

                let extractedTitle = '';
                let extractedTags = '';
                const extractedCategoryKeywords: { [key: string]: string[] } = {};
                let currentCategory = '';
                const categoryNames = ['重点词/成语词', '描述词', '行动词', '情感词'];

                for (const line of rawLines) {
                    const trimmed = line.trim();
                    // 提取分类关键词
                    let foundCat = false;
                    for (const catName of categoryNames) {
                        if (trimmed.includes(catName)) {
                            currentCategory = catName;
                            const afterColon = trimmed.split(/[：:]/).slice(1).join('：').trim();
                            if (afterColon) {
                                const words = afterColon.split(/[,，、\s]+/).map((w: string) => stripParenthetical(w)).filter((w: string) => w.trim());
                                if (!extractedCategoryKeywords[catName]) extractedCategoryKeywords[catName] = [];
                                extractedCategoryKeywords[catName].push(...words);
                            }
                            foundCat = true;
                            break;
                        }
                    }
                    if (foundCat) continue;

                    // 当前分类下的关键词
                    if (currentCategory) {
                        const words = trimmed.split(/[,，、\s]+/).map((w: string) => stripParenthetical(w)).filter((w: string) => w.trim());
                        if (words.length > 0 && !trimmed.includes('标题') && !trimmed.includes('标签')) {
                            if (!extractedCategoryKeywords[currentCategory]) extractedCategoryKeywords[currentCategory] = [];
                            extractedCategoryKeywords[currentCategory].push(...words);
                        }
                    }

                    if (trimmed.includes('标题') || trimmed.includes('Title')) {
                        extractedTitle = trimmed.split(/[：:]/).slice(1).join('：').trim() || extractedTitle;
                    }
                    if (trimmed.includes('标签') || trimmed.includes('Tags')) {
                        extractedTags = stripParenthetical(trimmed.split(/[：:]/).slice(1).join('：').trim()) || extractedTags;
                    }
                }

                // 使用提取到的数据（清除标题中的书名号和引号）
                generatedTitle.value = (extractedTitle || rawText.substring(0, 100)).replace(/[《》""'']/g, '').trim();
                generatedTags.value = extractedTags;

                // 处理分类关键词
                const hasCatKw = Object.keys(extractedCategoryKeywords).length > 0;
                if (hasCatKw) {
                    const categories = ['重点词/成语词', '描述词', '行动词', '情感词'];
                    const newGroupKeywordTexts: { [key: string]: string } = {...groupKeywordTexts.value};
                    const allKeywords: string[] = [];

                    categories.forEach(cat => {
                        if (extractedCategoryKeywords[cat] && extractedCategoryKeywords[cat].length > 0) {
                            const text = extractedCategoryKeywords[cat].join('\n');
                            try {
                                updateGroupKeywords(cat, text);
                            } catch (err) {
                                console.error(err);
                            }
                            newGroupKeywordTexts[cat] = text;
                            allKeywords.push(...extractedCategoryKeywords[cat]);
                        }
                    });
                    groupKeywordTexts.value = newGroupKeywordTexts;
                    generatedKeywords.value = allKeywords.join('\n');
                    Message.success(t("标题、标签和关键词生成完成"));
                } else {
                    generatedKeywords.value = "";
                    Message.warning(t("结果解析失败，请检查返回格式"));
                }
            }
        } else {
            Message.error(t("生成失败，请重试"));
        }
    } catch (error) {
        console.error("生成标题标签关键词失败:", error);
        Message.error(t("网络错误，请检查连接"));
    } finally {
        isGeneratingTitleTags.value = false;
    }
};

// 打开视频仿写链接输入对话框
const openVideoRewriteDialog = () => {
    videoRewriteUrl.value = "";
    showVideoRewriteDialog.value = true;
};

// 粘贴剪贴板内容到视频链接输入框
const pasteVideoRewriteUrl = async () => {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            videoRewriteUrl.value = text.trim();
            Message.success(t("已粘贴"));
        } else {
            Message.warning(t("剪贴板为空"));
        }
    } catch (e) {
        Message.warning(t("无法读取剪贴板，请手动粘贴"));
    }
};

// 🆕 爆款文案生成函数
const generateFromCustomPrompt = async () => {
    if (!settings.value.textModelKey) {
        Message.error(t("请先在设置中配置文本模型"));
        return;
    }

    showCustomPromptOptionsDialog.value = true;
    isGeneratingCustomPrompt.value = true;
    customPromptProgress.value = t("正在生成爆款文案...");
    customPromptOptions.value = [];

    try {
        const {useModelStore} = await import("../../module/Model/store/model");
        const modelStore = useModelStore();

        const [providerId, modelId] = settings.value.textModelKey.split('|');
        const provider = modelStore.providers.find(p => p.id === providerId);
        const model = provider?.data.models.find(m => m.id === modelId);

        if (!provider || !model) {
            throw new Error(t("找不到指定的文本模型"));
        }

        let apiUrl = provider.apiUrl;
        if (provider.data.apiHost) {
            apiUrl = provider.data.apiHost;
        }
        if (provider.type === 'openai') {
            apiUrl = buildChatCompletionsUrl(apiUrl);
        }

        const promptParts: string[] = [];
        promptParts.push("你是一个爆款短视频文案专家，擅长创作高播放量、高互动的短视频口播文案。");
        promptParts.push("请根据以下信息输出 3 个不同方向的爆款短视频文案方案。");
        promptParts.push(`【视频类型】${viralVideoType.value}`);
        promptParts.push(`【文案类型】${viralCopyType.value}`);

        if (viralPersona.value && viralPersona.value.trim()) {
            promptParts.push(`【行业+人设】${viralPersona.value.trim()}`);
        }
        if (viralProduct.value && viralProduct.value.trim()) {
            promptParts.push(`【产品/业务】${viralProduct.value.trim()}`);
        }
        if (viralSellingPoint.value && viralSellingPoint.value.trim()) {
            promptParts.push(`【卖点+价格】${viralSellingPoint.value.trim()}`);
        }
        if (viralOther.value && viralOther.value.trim()) {
            promptParts.push(`【其他要求】${viralOther.value.trim()}`);
        }

        promptParts.push("");
        promptParts.push("要求：");
        promptParts.push("1. 开头3秒必须有强吸引力的钩子，一开口就能留住用户");
        promptParts.push(`2. 内容贴合「${viralCopyType.value}」风格特点`);
        promptParts.push("3. 语言自然口语化，适合短视频口播");
        promptParts.push("4. 结尾要有引导互动的话术（关注、点赞、评论、收藏）");
        promptParts.push("5. 不使用表情符号和特殊符号");
        promptParts.push(`6. 字数控制在${viralWordCount.value}字左右`);
        promptParts.push("7. 3 个方案要明显区分角度，不要只改几个词");
        promptParts.push('8. 只返回 JSON，格式必须是 {"options":["方案1","方案2","方案3"]}，不要输出 markdown，不要补充解释');

        const finalPrompt = promptParts.join('\n');

        console.log('[爆款文案] 调用模型生成文案:', {
            provider: provider.name,
            model: model.name,
            videoType: viralVideoType.value,
            copyType: viralCopyType.value,
            persona: viralPersona.value,
            product: viralProduct.value,
            sellingPoint: viralSellingPoint.value,
            other: viralOther.value
        });
        console.log('[爆款文案] 完整Prompt内容:\n', finalPrompt);

        const result = await modelStore.chat(
            provider.id,
            model.id,
            finalPrompt,
            {loading: false}
        );

        console.log('[爆款文案] 模型返回结果:', result);

        if (result && result.code === 0 && result.data?.content) {
            const options = parseCustomPromptOptions(result.data.content);
            if (!options.length) {
                throw new Error(t("模型未返回可用文案方案"));
            }

            customPromptOptions.value = options;
            selectedCustomPromptIndex.value = 0;
            showCustomPromptOptionsDialog.value = true;
            customPromptProgress.value = `已生成 ${options.length} 个爆款文案方案，请在弹窗中选择`;
            try {
                const _u = JSON.parse(localStorage.getItem('auth_user') || '{}');
                window.require('electron').ipcRenderer.invoke('auth:reportGeneration', {
                    userId: _u.id,
                    type: 'script',
                    detail: '爆款文案'
                });
            } catch (e) {
            }
            Message.success(t("已生成爆款文案方案，请在弹窗中选择"));
        } else {
            const errorMsg = typeof result?.msg === 'string'
                ? result.msg
                : t("文案生成失败，请重试");
            throw new Error(errorMsg);
        }

    } catch (error: any) {
        console.error('[爆款文案] 生成失败:', error);
        customPromptProgress.value = "";
        Message.error(t("生成文案失败：") + (error?.message || error));
    } finally {
        isGeneratingCustomPrompt.value = false;
    }
};

// ==================== 字幕模板管理 ====================

// 模板选择下拉框选项
const startVideoRewriteProcessOptimized = async () => {
    if (!videoRewriteUrl.value || !videoRewriteUrl.value.trim()) {
        Message.warning(t("请粘贴视频分享文本"));
        return;
    }

    const normalizedInput = normalizeVideoRewriteInput(videoRewriteUrl.value);
    if (!normalizedInput.ok) {
        Message.error(normalizedInput.message);
        return;
    }

    if (!settings.value.textModelKey) {
        Message.error(t("请先在设置中配置文本模型"));
        showVideoRewriteDialog.value = false;
        return;
    }

    showVideoRewriteDialog.value = false;
    isVideoRewriting.value = true;
    recognizedText.value = "";
    videoRewriteProgress.value = t("正在解析和仿写...");

    try {
        const {useModelStore} = await import("../../module/Model/store/model");
        const modelStore = useModelStore();

        const [providerId, modelId] = settings.value.textModelKey.split('|');
        const provider = modelStore.providers.find(p => p.id === providerId);
        const model = provider?.data.models.find(m => m.id === modelId);

        if (!provider || !model) {
            throw new Error(t("找不到指定的文本模型"));
        }

        let apiUrl = provider.apiUrl;
        if (provider.data.apiHost) {
            apiUrl = provider.data.apiHost;
        }
        if (provider.type === 'openai') {
            apiUrl = buildChatCompletionsUrl(apiUrl);
        }

        const dashscopeProvider = modelStore.providers.find(p => p.id === 'dashscope');
        const aliyunApiKey = dashscopeProvider?.data?.apiKey || '';

        const ossConfig = dashscopeProvider?.data?.ossAccessKeyId ? {
            accessKeyId: dashscopeProvider.data.ossAccessKeyId,
            accessKeySecret: dashscopeProvider.data.ossAccessKeySecret,
            bucket: dashscopeProvider.data.ossBucket,
            region: dashscopeProvider.data.ossRegion,
            endpoint: dashscopeProvider.data.ossEndpoint
        } : null;

        const isLocalMode = settings.value.asrMode?.startsWith('server-');
        let asrServerInfo = null;

        if (isLocalMode) {
            const serverKey = settings.value.asrMode;
            console.log('[视频仿写] 本地模式，获取 ASR 服务器信息...', {
                asrMode: settings.value.asrMode,
                serverKey: serverKey
            });

            const asrServer = await serverStore.getByKey(serverKey);
            console.log('[视频仿写] getByKey 结果:', asrServer);

            if (asrServer) {
                asrServerInfo = await serverStore.serverInfo(asrServer);
                console.log('[视频仿写] serverInfo 结果:', asrServerInfo);
            } else {
                console.error('[视频仿写] 未找到 ASR 服务器:', serverKey);
            }
        } else {
            console.log('[视频仿写] 在线模式', {
                asrMode: settings.value.asrMode
            });
        }

        const modelConfig = {
            providerId: provider.id,
            modelId: model.id,
            apiUrl: apiUrl,
            apiHost: provider.data.apiHost || '',
            apiKey: provider.data.apiKey || '',
            type: provider.type || 'chat',
            aliyunApiKey: aliyunApiKey,
            ossConfig: ossConfig,
            asrMode: isLocalMode ? 'local' : 'online',
            asrServerInfo: asrServerInfo
        };

        videoRewriteProgress.value = t("正在解析视频链接...");

        const result = await window.$mapi.ipAgent.processDouyinShare({
            shareText: normalizedInput.value,
            modelConfig: modelConfig,
            rewriteConfig: {
                style: 'casual',
                length: 'medium',
                keepHashtags: true,
                keepEmoji: true
            },
            customPrompt: settings.value.rewritePrompt
        });

        if (!result.success) {
            throw new Error(result.error || t("解析或仿写失败"));
        }

        recognizedText.value = result.original.description;
        scriptContent.value = result.rewritten.description;
        videoRewriteProgress.value = t("仿写完成");

        console.log("[视频仿写优化] 解析成功:", {
            originalUrl: result.original.videoUrl,
            originalText: result.original.description,
            rewrittenText: result.rewritten.description,
            hashtags: result.original.hashtags
        });

        Message.success(t("仿写完成，已为您生成新文案"));

    } catch (error: any) {
        console.error("[视频仿写优化] 失败:", error);
        const errorMessage = error.message || error.toString() || t("未知错误");
        Message.error(t("仿写失败: ") + errorMessage);
    } finally {
        isVideoRewriting.value = false;
        videoRewriteProgress.value = "";
    }
};
const startVideoRewriteProcess = async () => {
    if (!videoRewriteUrl.value || !videoRewriteUrl.value.trim()) {
        Message.warning(t("请输入视频链接"));
        return;
    }

    // 从分享文本中提取URL
    const inputText = videoRewriteUrl.value.trim();
    let videoUrl = inputText;

    // 使用正则提取URL（支持抖音、快手等短链接）
    const urlPattern = /https?:\/\/[^\s]+/gi;
    const urlMatches = inputText.match(urlPattern);

    if (urlMatches && urlMatches.length > 0) {
        // 优先使用找到的第一个URL
        videoUrl = urlMatches[0];
        // 清理URL末尾可能的无效字符
        videoUrl = videoUrl.replace(/[，。！？、\s]+$/, '');
        console.log("[视频仿写] 从分享文本中提取到URL:", videoUrl);
    }

    // 检查配置
    if (!settings.value.textModelKey) {
        Message.error(t("请先在设置中配置文本模型"));
        showVideoRewriteDialog.value = false;
        return;
    }

    // 检查ASR配置
    if (settings.value.asrMode === 'local' && !settings.value.asrModelKey) {
        Message.error(t("请先在设置中配置本地语音识别服务器"));
        showVideoRewriteDialog.value = false;
        return;
    }

    showVideoRewriteDialog.value = false;
    isVideoRewriting.value = true;
    recognizedText.value = "";
    videoRewriteProgress.value = "";

    try {
        // 1. 下载视频
        videoRewriteProgress.value = t("正在下载视频...");
        console.log("开始下载视频:", videoUrl);

        // @ts-ignore
        const downloadRes = await window.$mapi.ipAgent.downloadVideo({url: videoUrl});

        if (!downloadRes.success) {
            throw new Error(downloadRes.message || "下载视频失败");
        }

        const videoPath = downloadRes.videoPath;
        console.log("视频下载成功:", videoPath);

        // 2. 提取音频
        videoRewriteProgress.value = t("正在提取音频...");

        console.log("开始提取音频:", videoPath);
        // @ts-ignore
        const extractResult = await window.$mapi.ipAgent.extractAudioFromVideo({videoPath});
        if (!extractResult.success) {
            throw new Error(extractResult.message || "音频提取失败");
        }
        const audioPath = extractResult.audioPath;
        console.log("音  提取成功:", audioPath);

        // 3. 语音识别 (ASR)
        videoRewriteProgress.value = t("正在识别语音...");

        let fullText = '';

        // 判断使用在线还是本地ASR
        if (settings.value.asrMode === 'online') {
            // 在线模式：使用阿里云FunASR
            console.log("[ASR] 使用在线模式：阿里云FunASR");

            // 获取阿里云API Key
            const modelStore = (await import("../../module/Model/store/model")).useModelStore();
            const dashscopeProvider = modelStore.providers.find(p => p.id === 'dashscope');
            // 🔧 如果用户没配置，使用内置的硬编码 API Key
            const apiKey = dashscopeProvider?.data?.apiKey || getSystemConfigSync().aliyun_bailian_api_key;

            // 调用阿里云FunASR
            // 获取OSS配置（如果有配置则使用快速录音识别模式）
            const ossConfig = dashscopeProvider?.data?.ossAccessKeyId ? {
                accessKeyId: dashscopeProvider.data.ossAccessKeyId,
                accessKeySecret: dashscopeProvider.data.ossAccessKeySecret,
                bucket: dashscopeProvider.data.ossBucket,
                region: dashscopeProvider.data.ossRegion,
                endpoint: dashscopeProvider.data.ossEndpoint
            } : undefined;

            // 调试日志
            console.log("[ASR] dashscopeProvider 完整数据:", {
                id: dashscopeProvider?.id,
                data: dashscopeProvider?.data,
                hasOssAccessKeyId: !!dashscopeProvider?.data?.ossAccessKeyId,
                ossBucket: dashscopeProvider?.data?.ossBucket,
                ossRegion: dashscopeProvider?.data?.ossRegion,
                ossEndpoint: dashscopeProvider?.data?.ossEndpoint,
                willUseRecordedMode: !!ossConfig
            });

            const asrResult = await ipcRenderer.invoke('aliyun:funasr:recognize', {
                audioPath: audioPath,
                config: {
                    apiKey: apiKey,
                    model: 'fun-asr',  // 仅使用录音文件识别模式
                    format: 'wav',
                    sampleRate: 16000,
                    language: ['zh'],
                    ossConfig: ossConfig  // 传递OSS配置（录音识别必需）
                }
            });

            if (!asrResult.success) {
                throw new Error(asrResult.error || t("阿里云语音识别失败"));
            }

            // 解析结果
            if (asrResult.sentences && asrResult.sentences.length > 0) {
                fullText = asrResult.sentences.map((s: any) => s.text).join("");
            } else if (asrResult.fullText) {
                fullText = asrResult.fullText;
            }

            console.log("[ASR] 阿里云FunASR识别完成，文本长度:", fullText.length);

        } else {
            // 本地模式：使用本地服务器
            console.log("[ASR] 使用本地模式");

            if (!settings.value.asrModelKey) {
                throw new Error(t("请先在设置中配置本地语音识别服务器"));
            }

            // 获取ASR服务器配置
            const asrServer = await serverStore.getByKey(settings.value.asrModelKey);
            if (!asrServer) {
                throw new Error(t("找不到指定的语音识别服务，请检查设置"));
            }

            const asrServerInfo = await serverStore.serverInfo(asrServer);
            if (!asrServerInfo) {
                throw new Error(t("语音识别服务不可用"));
            }

            console.log("开始调用ASR服务:", asrServerInfo.name, "ID:", asrServerInfo.id);

            // 调用ASR服务
            const asrRes = await serverStore.call(asrServerInfo, "asr", {
                id: `video_rewrite_${Date.now()}`,
                audio: audioPath
            });

            if (asrRes.code !== 0) {
                throw new Error(asrRes.msg || t("语音识别失败"));
            }

            // 解析识别结果
            const records = asrRes.data?.data?.records;

            if (!records || !Array.isArray(records) || records.length === 0) {
                console.warn("ASR返回结果为空或格式不正确:", asrRes);
                throw new Error(t("语音识别结果为空"));
            }

            // 拼接所有文本
            fullText = records.map((r: any) => r.text).join("");
            console.log("本地ASR识别完成，文本长度:", fullText.length);
        }

        if (!fullText) {
            throw new Error(t("未能识别出有效文本"));
        }

        recognizedText.value = fullText;
        videoRewriteProgress.value = t("语音识别完成，开始仿写...");

        // 4. 开始仿写 (调用现有的 generateScriptFromVideoContent)
        await generateScriptFromVideoContent();

    } catch (error: any) {
        console.error("视频仿写流程失败:", error);
        const errorMessage = error.message || error.toString() || t("未知错误");

        // 根据错误类型显示更友好的提示
        if (errorMessage.includes("download") || errorMessage.includes("下载")) {
            Message.error(t("视频下载失败: ") + errorMessage);
        } else if (errorMessage.includes("extract") || errorMessage.includes("ffmpeg")) {
            Message.error(t("音频提取失败: ") + errorMessage);
        } else if (errorMessage.includes("asr") || errorMessage.includes("识别")) {
            Message.error(t("语音识别失败: ") + errorMessage);
        } else {
            Message.error(t("流程执行失败: ") + errorMessage);
        }
    } finally {
        isVideoRewriting.value = false;
        videoRewriteProgress.value = "";
    }
};

// 为单个标题生成文案
const generateScript = async (index: number) => {
    if (selectedAccountIndex.value === null) {
        Message.warning(t("请先选择一个对标"));
        return;
    }

    const topic = topicLibrary.value[index];
    if (!topic || topic.isGeneratingScript) return;

    const titleToUse = topic.rewritten || topic.original;
    const accountName = learnedAccounts.value[selectedAccountIndex.value]?.name || '';

    topic.isGeneratingScript = true;

    try {
        // 调用AI生成文案
        const result = await window.$mapi.ipAgent.generateScript({
            title: titleToUse,
            accountName: accountName
        });

        if (result.success && result.script) {
            topic.script = result.script;
            try {
                const _u = JSON.parse(localStorage.getItem('auth_user') || '{}');
                window.require('electron').ipcRenderer.invoke('auth:reportGeneration', {
                    userId: _u.id,
                    type: 'script',
                    detail: '标题文案'
                });
            } catch (e) {
            }
            Message.success(t("文案生成完成"));
        } else {
            Message.error(t("文案生成失败，请重试"));
        }
    } catch (error) {
        console.error("生成文案失败:", error);
        Message.error(t("网络错误，请检查连接"));
    } finally {
        topic.isGeneratingScript = false;
    }
};

// 删除已学习的账号
const removeAccount = async (index: number) => {
    // 获取要删除的账号名称
    const accountName = learnedAccounts.value[index]?.name;

    if (!accountName) {
        learnedAccounts.value.splice(index, 1);
        // 如果删除的是当前选中的账号，调整选中索引
        if (selectedAccountIndex.value === index) {
            if (learnedAccounts.value.length > 0) {
                selectedAccountIndex.value = 0; // 选中第一个
            } else {
                selectedAccountIndex.value = null; // 没有账号了
            }
        } else if (selectedAccountIndex.value !== null && selectedAccountIndex.value > index) {
            // 如果选中的账号在删除的账号后面，索引减1
            selectedAccountIndex.value--;
        }
        return;
    }

    // 删除账号
    learnedAccounts.value.splice(index, 1);

    console.log("=== 删除账号 ===");
    console.log("账号名称:", accountName);
    console.log("剩余账号数量:", learnedAccounts.value.length);

    // 如果删除的是当前选中的账号，调整选中索引
    if (selectedAccountIndex.value === index) {
        if (learnedAccounts.value.length > 0) {
            selectedAccountIndex.value = 0; // 选中第一个
        } else {
            selectedAccountIndex.value = null; // 没有账号了
        }
    } else if (selectedAccountIndex.value !== null && selectedAccountIndex.value > index) {
        // 如果选中的账号在删除的账号后面，索引减1
        selectedAccountIndex.value--;
    }

    // 清除选题选中状态
    selectedTopicIndex.value = null;

    console.log("当前选中账号索引:", selectedAccountIndex.value);
    Message.success(t("已删除账号") + ` ${accountName}`);
};

// 刷新选题库（已改为执行一键仿写功能）
const refreshTopics = () => {
    rewriteAllTitles();
};

// 清空所有用户数据
const resetAllUserData = () => {
    // 弹出确认对话框
    Dialog.confirm(
        t("这将清空学习到的对标、选题库、文案、生成的音频视频预览、标题标签、字幕音乐、以及所有平台登录信息等所有内容。此操作无法撤销！"),
        t("确定要清空所有数据吗？")
    ).then(async () => {
        try {
            // 清空学习到的对标和选题库
            learnedAccounts.value = [];
            selectedAccountIndex.value = null;
            selectedTopicIndex.value = null;

            // 清空文案编辑框
            recognizedText.value = "";
            scriptContent.value = "";

            // 清空生成的内容
            generatedTitle.value = "";
            generatedTags.value = "";
            generatedKeywords.value = "";

            // 清空音频视频预览
            audioPreviewUrl.value = "";
            latestAudioTaskId.value = "";
            videoPreviewUrl.value = "";
            latestVideoTaskId.value = "";

            // 清空视频处理预览
            processedVideoUrl.value = "";
            finalVideoUrl.value = "";
            coverPreviewUrl.value = "";

            // 清空字幕和音乐设置预览（保留设置项，只清空预览）
            enableSubtitle.value = false;
            enableBGM.value = false;

            viralVideoType.value = "口播文案";
            viralCopyType.value = "人设型";
            viralPersona.value = "";
            viralProduct.value = "";
            viralSellingPoint.value = "";
            viralOther.value = "";
            viralWordCount.value = 300;

            // 清空提取的关键词
            extractedKeywords.value = [];

            // 🆕 清空所有平台登录信息（包括Cookie和浏览器数据）
            const platforms = ['douyin', 'kuaishou', 'shipin', 'xiaohongshu'];
            for (const platform of platforms) {
                try {
                    // 调用新的API，完全清除浏览器数据和Cookie
                    await window.$mapi.platform.clearBrowserData({platform});
                    publishPlatforms.value[platform].loggedIn = false;
                    publishPlatforms.value[platform].nickname = '';
                    console.log(`✅ 已清除${platform}的浏览器数据和Cookie`);
                } catch (error) {
                    console.error(`清除${platform}登录失败:`, error);
                }
            }

            // 保存空状态到本地存储
            StorageUtil.set("VideoIPAgent.workData", {
                learnedAccounts: [],
                selectedAccountIndex: null,
                selectedTopicIndex: null,
                scriptWordCount: scriptWordCount.value,
                recognizedText: "",
                scriptContent: "",
                generatedTitle: "",
                generatedTags: "",
                generatedKeywords: "",
                audioPreviewUrl: "",
                latestAudioTaskId: "",
                videoPreviewUrl: "",
                latestVideoTaskId: "",
                processedVideoUrl: "",
                finalVideoUrl: "",
                coverPreviewUrl: "",
                enableSubtitle: false,
                selectedSubtitleStyleId: selectedSubtitleStyleId.value,
                subtitleFontSizeScale: subtitleFontSizeScale.value,
                subtitlePosition: subtitlePosition.value,
                selectedSubtitleTemplate: selectedSubtitleTemplate.value,
                enableKeywordEffects: enableKeywordEffects.value,
                enableBGM: false,
                selectedBGMPath: selectedBGMPath.value,
                bgmVolume: bgmVolume.value
            });

            Message.success(t("已清空所有数据（包括平台登录信息）"));
        } catch (error) {
            console.error("清空数据失败:", error);
            Message.error(t("清空数据失败"));
        }
    }).catch(() => {
        // 用户点击取消，不做任何操作
    });
};

// 数据持久化 - 保存工作数据
const saveWorkData = () => {
    const workData = {
        learnedAccounts: learnedAccounts.value,
        selectedAccountIndex: selectedAccountIndex.value,
        selectedTopicIndex: selectedTopicIndex.value,
        scriptWordCount: scriptWordCount.value,
        recognizedText: recognizedText.value,
        scriptContent: scriptContent.value,
        generatedTitle: generatedTitle.value,
        generatedTags: generatedTags.value,
        generatedKeywords: generatedKeywords.value,
        audioPreviewUrl: audioPreviewUrl.value,
        latestAudioTaskId: latestAudioTaskId.value,
        videoPreviewUrl: videoPreviewUrl.value,
        latestVideoTaskId: latestVideoTaskId.value,
        // audioVoicePromptId 已移除，统一使用 settings.voicePromptId
        audioEmotion: audioEmotion.value,
        audioSpeed: audioSpeed.value,
        videoDigitalHumanModelKey: settings.value.videoDigitalHumanModelKey,
        videoTemplateId: videoTemplateId.value,
        // 保存生成状态
        isGeneratingAudio: isGeneratingAudio.value,
        isGeneratingVideo: isGeneratingVideo.value,
        // 保存视频处理结果
        processedVideoUrl: processedVideoUrl.value,
        finalVideoUrl: finalVideoUrl.value,
        // 保存封面预览
        coverPreviewUrl: coverPreviewUrl.value,
        // 保存字幕和BGM设置
        enableSubtitle: enableSubtitle.value,
        selectedSubtitleStyleId: selectedSubtitleStyleId.value,
        subtitleFontSizeScale: subtitleFontSizeScale.value,
        subtitlePosition: subtitlePosition.value,
        selectedSubtitleTemplate: selectedSubtitleTemplate.value,
        enableKeywordEffects: enableKeywordEffects.value,
        enableBGM: enableBGM.value,
        selectedBGMPath: selectedBGMPath.value,
        bgmVolume: bgmVolume.value,
        viralVideoType: viralVideoType.value,
        viralCopyType: viralCopyType.value,
        viralPersona: viralPersona.value,
        viralProduct: viralProduct.value,
        viralSellingPoint: viralSellingPoint.value,
        viralOther: viralOther.value,
        viralWordCount: viralWordCount.value
    };

    // 🔧 调试日志
    console.log('[saveWorkData] 🔄 正在保存工作数据:', {
        audioPreviewUrl: workData.audioPreviewUrl,
        videoPreviewUrl: workData.videoPreviewUrl,
        scriptContent: workData.scriptContent?.substring(0, 50) + '...',
        generatedTitle: workData.generatedTitle,
        timestamp: new Date().toISOString()
    });

    StorageUtil.set("VideoIPAgent.workData", workData);

    console.log('[saveWorkData] ✅ 工作数据已保存到本地存储');
};

// 数据持久化 - 加载工作数据
const loadWorkData = async () => {
    try {
        console.log('[loadWorkData] 📂 开始加载工作数据...');

        // 🔧 诊断：检查localStorage中是否存在数据
        const rawStorageValue = window.localStorage.getItem("VideoIPAgent.workData");
        console.log('[loadWorkData] 📊 localStorage中的原始值:', {
            exists: rawStorageValue !== null,
            length: rawStorageValue?.length || 0,
            preview: rawStorageValue ? rawStorageValue.substring(0, 100) + '...' : 'null'
        });

        const workData = StorageUtil.getObject("VideoIPAgent.workData");

        if (workData) {
            console.log('[loadWorkData] ✅ 找到保存的工作数据:', {
                audioPreviewUrl: workData.audioPreviewUrl,
                videoPreviewUrl: workData.videoPreviewUrl,
                scriptContent: workData.scriptContent?.substring(0, 50) + '...',
                generatedTitle: workData.generatedTitle,
                timestamp: new Date().toISOString()
            });

            // 使用 nextTick 来确保组件完全挂载后再更新数据
            await nextTick();

            // 一次性更新所有数据   减少响应式更新次数
            // 处理向后兼容：如果存在旧的topicLibrary格式，需要迁移
            if (workData.learnedAccounts && Array.isArray(workData.learnedAccounts)) {
                // 检查是否是新格式（每个账号都有topicLibrary字段）
                const isNewFormat = workData.learnedAccounts.length > 0 &&
                    workData.learnedAccounts[0].hasOwnProperty('topicLibrary');

                if (isNewFormat) {
                    // 新格式：learnedAccounts包含topicLibrary
                    learnedAccounts.value = workData.learnedAccounts.map((acc: any) => {
                        // 确保每个账号都有topicLibrary字段
                        if (!acc.topicLibrary) {
                            acc.topicLibrary = [];
                        }
                        return acc;
                    });
                } else {
                    // 旧格式：learnedAccounts和topicLibrary分开存储
                    const oldAccounts = workData.learnedAccounts || [];
                    const oldTopicLibrary = workData.topicLibrary || [];

                    // 迁移旧数据：将topicLibrary分配给对应的账号
                    learnedAccounts.value = oldAccounts.map((acc: any) => {
                        // 为每个账号分配属于它的选题（基于accountName）
                        const accountTopics = oldTopicLibrary
                            .filter((topic: any) => topic.accountName === acc.name)
                            .map((topic: any) => ({
                                original: topic.original,
                                rewritten: topic.rewritten || null,
                                isRewriting: false,
                                script: topic.script || null,
                                isGeneratingScript: false
                            }));

                        return {
                            name: acc.name,
                            url: acc.url,
                            topicLibrary: accountTopics.slice(0, 6) // 限制最多6个
                        };
                    });
                }
            } else {
                learnedAccounts.value = [];
            }

            // 恢复选中的对标索引
            selectedAccountIndex.value = workData.selectedAccountIndex ?? (learnedAccounts.value.length > 0 ? 0 : null);
            selectedTopicIndex.value = workData.selectedTopicIndex ?? null;
            scriptWordCount.value = workData.scriptWordCount || 100;
            recognizedText.value = workData.recognizedText || "";
            scriptContent.value = workData.scriptContent || "";
            generatedTitle.value = workData.generatedTitle || "";
            generatedTags.value = workData.generatedTags || "";
            generatedKeywords.value = workData.generatedKeywords || "";
            // 🔧 恢复音频路径（现在保存在持久化目录中，重启后不会被删除）
            audioPreviewUrl.value = workData.audioPreviewUrl || "";
            latestAudioTaskId.value = workData.latestAudioTaskId || "";
            videoPreviewUrl.value = workData.videoPreviewUrl || "";
            latestVideoTaskId.value = workData.latestVideoTaskId || "";
            // 兼容旧数据：如果工作数据中有 audioVoicePromptId，同步到 settings.voicePromptId
            if (workData.audioVoicePromptId && !settings.value.voicePromptId) {
                settings.value.voicePromptId = workData.audioVoicePromptId;
            }
            audioEmotion.value = workData.audioEmotion || "自然";
            audioSpeed.value = workData.audioSpeed || 1.0;
            settings.value.videoDigitalHumanModelKey = workData.videoDigitalHumanModelKey || "__CLOUD__";
            videoTemplateId.value = workData.videoTemplateId || 0;
            // 不直接恢复生成状态，而是通过 resumeTaskPolling 来判断
            // isGeneratingAudio.value = workData.isGeneratingAudio || false;
            // isGeneratingVideo.value = workData.isGeneratingVideo || false;
            // 恢复视频处理结果
            processedVideoUrl.value = workData.processedVideoUrl || "";
            finalVideoUrl.value = workData.finalVideoUrl || "";
            // 恢复封面预览
            coverPreviewUrl.value = workData.coverPreviewUrl || "";
            // 恢复字幕和BGM设置
            enableSubtitle.value = workData.enableSubtitle || false;
            selectedSubtitleStyleId.value = workData.selectedSubtitleStyleId || "";
            subtitleFontSizeScale.value = workData.subtitleFontSizeScale || 100;
            subtitlePosition.value = workData.subtitlePosition || 'bottom';
            selectedSubtitleTemplate.value = workData.selectedSubtitleTemplate || "";
            // 🆕 修复：加载数据时默认关闭编辑模式，防止“每次打开还是编辑模式”的问题
            isEditingSubtitleTemplate.value = false;
            editingTemplateId.value = '';
            enableKeywordEffects.value = workData.enableKeywordEffects || false;
            enableBGM.value = workData.enableBGM || false;
            selectedBGMPath.value = workData.selectedBGMPath || "";
            bgmVolume.value = workData.bgmVolume || 30;
            viralVideoType.value = workData.viralVideoType || "口播文案";
            viralCopyType.value = workData.viralCopyType || "人设型";
            viralPersona.value = workData.viralPersona || "";
            viralProduct.value = workData.viralProduct || "";
            viralSellingPoint.value = workData.viralSellingPoint || "";
            viralOther.value = workData.viralOther || "";
            viralWordCount.value = workData.viralWordCount || 300;

            console.log('[loadWorkData] ✅ 工作数据已恢复到内存，当前状态:', {
                audioPreviewUrl: audioPreviewUrl.value,
                videoPreviewUrl: videoPreviewUrl.value,
                timestamp: new Date().toISOString()
            });
        } else {
            console.log('[loadWorkData] ⚠️ 未找到保存的工作数据，使用默认值');
        }
    } catch (error: any) {
        console.error('[loadWorkData] ❌ 加载工作数据失败:', {
            error: error,
            message: error?.message,
            stack: error?.stack
        });
    }
};

// 创建并保存默认分组到数据库
const createAndSaveDefaultGroups = async () => {
    console.log('[createAndSaveDefaultGroups] ===================== 开始创建默认分组 =====================');

    // 创建4个系统默认分组（每个分组初始为空关键词）- 必须有唯一id
    const defaultGroups = [
        {
            id: 'group_重点词_成语词',
            name: '重点词/成语词',
            description: '视频中的重点词汇和成语',
            color: '#FF6B6B',
            keywords: []
        },
        {
            id: 'group_行动词',
            name: '行动词',
            description: '需要强调的行动动词',
            color: '#4ECDC4',
            keywords: []
        },
        {
            id: 'group_描述词',
            name: '描述词',
            description: '描述性的形容词和副词',
            color: '#45B7D1',
            keywords: []
        },
        {
            id: 'group_情感词',
            name: '情感词',
            description: '表达情感的词汇',
            color: '#F7DC6F',
            keywords: []
        }
    ];

    console.log('[createAndSaveDefaultGroups] 准备创建 ' + defaultGroups.length + ' 个默认分组');

    // 设置到内存中
    keywordGroups.value = defaultGroups;
    console.log('[createAndSaveDefaultGroups] ✅ keywordGroups.value 已设置，分组数:', keywordGroups.value.length);

    // 保存到数据库
    try {
        console.log('[createAndSaveDefaultGroups] 准备保存默认分组到数据库...');
        const result = await KeywordGroupService.saveGroups(defaultGroups);

        console.log('[createAndSaveDefaultGroups] saveGroups() 返回结果:', result);

        if (result.success) {
            console.log('[createAndSaveDefaultGroups] ✅ 默认分组已保存到数据库');
        } else {
            console.warn('[createAndSaveDefaultGroups] ⚠️ 保存默认分组到数据库失败:', {
                success: result.success,
                failedCount: result.failedCount,
                message: result.failedCount + ' 个分组保存失败'
            });
        }
    } catch (error) {
        console.error('[createAndSaveDefaultGroups] ❌ 保存到数据库出错:', {
            message: error?.message,
            stack: error?.stack
        });
    }

    // 同时保存到localStorage作为备份
    try {
        console.log('[createAndSaveDefaultGroups] 备份保存默认分组到 localStorage...');
        localStorage.setItem('zhenqianba_keyword_groups', JSON.stringify(defaultGroups));
        console.log('[createAndSaveDefaultGroups] ✅ localStorage 备份完成');
    } catch (e) {
        console.error('[createAndSaveDefaultGroups] ❌ 保存到localStorage失败:', e?.message);
    }

    console.log('[createAndSaveDefaultGroups] ===================== 创建默认分组完毕 =====================');
};

// 异步初始化关键词分组 - 从数据库加载
const initializeKeywordGroupsAsync = async () => {
    console.log('[initializeKeywordGroupsAsync] ===================== 开始异步初始化 =====================');

    const MAX_RETRIES = 3;
    const TIMEOUT_MS = 5000;
    let lastError = null;

    // 重试循环
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`[initializeKeywordGroupsAsync] 开始尝试 ${attempt}/${MAX_RETRIES}...`);
            console.log('[initializeKeywordGroupsAsync] 1️⃣ 准备从数据库加载关键词分组...');

            // 先尝试从数据库加载（带超时保护）
            console.log('[initializeKeywordGroupsAsync] 2️⃣ 调用 KeywordGroupService.getAllGroups()...');

            // 创建超时Promise
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('getAllGroups timeout after ' + TIMEOUT_MS + 'ms')), TIMEOUT_MS)
            );

            // 与getAllGroups竞速，优先完成者胜出
            const dbGroups = await Promise.race([
                KeywordGroupService.getAllGroups(),
                timeoutPromise
            ]);

            console.log('[initializeKeywordGroupsAsync] 3️⃣ getAllGroups() 返回结果:', {
                success: !!dbGroups,
                isArray: Array.isArray(dbGroups),
                length: dbGroups?.length || 0,
                groups: dbGroups?.map(g => ({name: g.name, id: g.id})) || []
            });

            if (dbGroups && dbGroups.length > 0) {
                // 🔧 修复：使用扩展操作符创建新数组引用，确保Vue响应式系统检测到变化
                keywordGroups.value = [...dbGroups];
                keywordGroupsInitializeAttempted = false; // 🔧 重置标志，允许后续调用
                console.log('[initializeKeywordGroupsAsync] ✅ 从数据库成功加载关键词分组，数量:', dbGroups.length);
                console.log('[initializeKeywordGroupsAsync] 赋值后keywordGroups.value:', {
                    length: keywordGroups.value.length,
                    names: keywordGroups.value.map(g => g.name)
                });

                // 🔧 【新增】检查并恢复被删除的系统分组
                const systemGroupNames = ['重点词/成语词', '行动词', '描述词', '情感词'];
                const existingNames = keywordGroups.value.map(g => g.name);
                const missingGroups = systemGroupNames.filter(name => !existingNames.includes(name));

                if (missingGroups.length > 0) {
                    console.warn('[initializeKeywordGroupsAsync] ⚠️ 检测到缺失的系统分组:', missingGroups);

                    // 定义系统分组的完整配置
                    const systemGroupConfigs = {
                        '重点词/成语词': {description: '视频中的重点词汇和成语', color: '#FF6B6B'},
                        '行动词': {description: '需要强调的行动动词', color: '#4ECDC4'},
                        '描述词': {description: '描述性的形容词和副词', color: '#45B7D1'},
                        '情感词': {description: '表达情感的词汇', color: '#F7DC6F'}
                    };

                    // 恢复缺失的系统分组
                    for (const groupName of missingGroups) {
                        const config = systemGroupConfigs[groupName];
                        const restoredGroup = {
                            id: `group_${groupName.replace(/\//g, '_')}`,
                            name: groupName,
                            description: config.description,
                            color: config.color,
                            keywords: [],
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        };

                        // 添加到内存中
                        keywordGroups.value.push(restoredGroup);

                        // 保存到数据库
                        try {
                            await KeywordGroupService.saveGroup(restoredGroup);
                            console.log(`[initializeKeywordGroupsAsync] ✅ 已恢复系统分组: ${groupName}`);
                        } catch (error) {
                            console.error(`[initializeKeywordGroupsAsync] ❌ 恢复系统分组失败: ${groupName}`, error);
                        }
                    }

                    console.log('[initializeKeywordGroupsAsync] ✅ 系统分组恢复完成，当前分组数:', keywordGroups.value.length);
                }

                // 🔧 【修复】保存到localStorage，确保下次加载时能获取
                try {
                    localStorage.setItem('zhenqianba_keyword_groups', JSON.stringify(keywordGroups.value));
                    console.log('[initializeKeywordGroupsAsync] ✅ 关键词分组已保存到localStorage');
                } catch (e) {
                    console.warn('[initializeKeywordGroupsAsync] 保存到localStorage失败:', e);
                }
                console.log('[initializeKeywordGroupsAsync] 分组详情:', keywordGroups.value.map(g => ({
                    name: g.name,
                    keywords: g.keywords?.length || 0,
                    // 🔧 【诊断】检查每个分组的字体信息
                    styleOverrideFontName: g.styleOverride?.fontName,
                    styleOverrideFontPath: g.styleOverride?.fontPath,
                    hasFontInfo: !!(g.styleOverride?.fontName || g.styleOverride?.fontPath)
                })));

                // 🆕 【关键修复】应用当前模板的音效配置到已加载的分组
                // 音效配置存储在模板的 keywordGroupsStyles 中，而不是数据库分组中
                try {
                    if (selectedSubtitleTemplate.value && subtitleTemplates.value.length > 0) {
                        const currentTemplate = subtitleTemplates.value.find(t => t.id === selectedSubtitleTemplate.value);
                        if (currentTemplate?.config?.keywordGroupsStyles) {
                            let styles = currentTemplate.config.keywordGroupsStyles;
                            // 解析字符串格式的配置
                            if (typeof currentTemplate.config === 'string') {
                                try {
                                    const parsed = JSON.parse(currentTemplate.config);
                                    styles = parsed.keywordGroupsStyles;
                                } catch (e) {
                                }
                            }

                            if (Array.isArray(styles) && styles.length > 0) {
                                console.log('[initializeKeywordGroupsAsync] 🔊 同步模板音效配置到分组...');
                                styles.forEach((styleConfig: any) => {
                                    const targetGroup = keywordGroups.value.find(g => g.name === styleConfig.groupName);
                                    if (targetGroup && (styleConfig.soundEffectId || styleConfig.soundEffectConfig)) {
                                        targetGroup.soundEffectId = styleConfig.soundEffectId;
                                        targetGroup.soundEffectConfig = styleConfig.soundEffectConfig;
                                        targetGroup.effectId = styleConfig.effectId;
                                        targetGroup.styleOverride = styleConfig.styleOverride;
                                        targetGroup.color = styleConfig.color;
                                        console.log(`[initializeKeywordGroupsAsync] 🔊 已同步分组 "${targetGroup.name}" 的音效配置:`, {
                                            soundEffectId: targetGroup.soundEffectId,
                                            effectId: targetGroup.effectId
                                        });
                                    }
                                });
                            }
                        }
                    }
                } catch (syncError) {
                    console.warn('[initializeKeywordGroupsAsync] ⚠️ 同步模板音效配置失败:', syncError);
                }

                console.log('[initializeKeywordGroupsAsync] ===================== 异步初始化完毕 =====================');
                return;
            }

            // 数据库中没有数据，不创建默认分组，直接设置为空数组
            console.log('[initializeKeywordGroupsAsync] 4️⃣ 数据库中没有数据，不创建默认分组');
            await createAndSaveDefaultGroups();

            console.log('[initializeKeywordGroupsAsync] 5️⃣ createAndSaveDefaultGroups() 完成，当前keywordGroups.value:', {
                length: keywordGroups.value?.length || 0,
                names: keywordGroups.value?.map(g => g.name) || []
            });

            // 验证keywordGroups确实被初始化了
            if (!keywordGroups.value || keywordGroups.value.length === 0) {
                console.error('[initializeKeywordGroupsAsync] ❌ 空数组设置失败或未被赋值！强制使用本地存储');
                initializeKeywordGroups();
            } else {
                console.log('[initializeKeywordGroupsAsync] ✅ 空数组成功设置且已赋值');
            }

            // 成功完成，不再重试
            console.log('[initializeKeywordGroupsAsync] ===================== 异步初始化完毕 =====================');
            return;

        } catch (error) {
            lastError = error;
            const waitMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 指数退避：1s, 2s, 4s

            console.warn(`[initializeKeywordGroupsAsync] ⚠️ 尝试 ${attempt}/${MAX_RETRIES} 失败:`, {
                message: error?.message,
                errorType: error?.constructor?.name || 'Unknown',
                timeout: error?.message?.includes('timeout'),
                willRetry: attempt < MAX_RETRIES
            });

            if (attempt < MAX_RETRIES) {
                console.log(`[initializeKeywordGroupsAsync] 等待 ${waitMs}ms 后进行下一次尝试...`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
        }
    }

    // 所有重试都失败了，使用降级方案
    console.error('[initializeKeywordGroupsAsync] ❌ 所有 ' + MAX_RETRIES + ' 次尝试都失败，最后的错误:', {
        message: lastError?.message,
        stack: lastError?.stack
    });
    console.warn('[initializeKeywordGroupsAsync] 降级使用本地存储...');
    initializeKeywordGroups();

    console.log('[initializeKeywordGroupsAsync] ===================== 异步初始化完毕（降级方案） =====================');
};

// 原有的同步初始化函数（备用方案）
const initializeKeywordGroups = () => {
    try {
        console.log('[initializeKeywordGroups] 开始初始化关键词分组...');
        console.log('[initializeKeywordGroups] 当前keywordGroups.value长度:', keywordGroups.value?.length || 0);

        const stored = localStorage.getItem('zhenqianba_keyword_groups');
        console.log('[initializeKeywordGroups] localStorage中的数据:', stored ? '有数据' : '无数据');

        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                console.log('[initializeKeywordGroups] 解析成功，数据类型:', typeof parsed, '长度:', parsed?.length || 0);

                // 【修复】如果localStorage中的数据是空数组，不自动创建默认分组
                if (Array.isArray(parsed) && parsed.length === 0) {
                    console.log('[initializeKeywordGroups] localStorage中是空数组，不自动创建默认分组');
                    // 不自动创建默认分组，直接使用空数组
                    keywordGroups.value = [];
                    console.log('[initializeKeywordGroups] keywordGroups.value 已设置为空数组');
                } else {
                    keywordGroups.value = parsed;
                    keywordGroupsInitializeAttempted = false; // 🔧 重置标志，允许后续调用

                    // 🔧 关键词规范化：确保所有关键词都是对象格式 { keyword: "text", enabled: true }
                    keywordGroups.value.forEach((group: any) => {
                        if (group.keywords && Array.isArray(group.keywords)) {
                            group.keywords = group.keywords.map((kw: any) => {
                                if (typeof kw === 'string') {
                                    return {keyword: kw, enabled: true};
                                } else if (typeof kw === 'object' && kw !== null) {
                                    return {
                                        keyword: String(kw.keyword || ''),
                                        enabled: Boolean(kw.enabled !== false)
                                    };
                                }
                                return {keyword: '', enabled: true};
                            });
                        }
                    });

                    console.log('[initializeKeywordGroups] 赋值后keywordGroups.value长度:', keywordGroups.value?.length || 0);
                    console.log('[initializeKeywordGroups] 从localStorage加载了关键词分组:', keywordGroups.value);
                    keywordGroups.value.forEach((group, index) => {
                        console.log(`[initializeKeywordGroups] 分组${index + 1}: "${group.name}", 关键词数量: ${group.keywords?.length || 0}`);
                    });
                }
            } catch (parseError) {
                console.error('[initializeKeywordGroups] JSON解析失败:', parseError);
                keywordGroups.value = [];
            }
        } else {
            // localStorage为空，不自动创建默认分组
            console.log('[initializeKeywordGroups] localStorage为空，不自动创建默认分组');
            keywordGroups.value = [];
            console.log('[initializeKeywordGroups] keywordGroups.value 已设置为空数组');
            // 保存空数组到localStorage
            try {
                localStorage.setItem('zhenqianba_keyword_groups', JSON.stringify([]));
            } catch (e) {
                console.error('保存空数组到本地存储失败:', e);
            }
            console.log('[initializeKeywordGroups] 已将空数组保存到localStorage');
        }

        // 最终验证
        console.log('[initializeKeywordGroups] 初始化完成，最终keywordGroups.value长度:', keywordGroups.value?.length || 0);
        if (keywordGroups.value && keywordGroups.value.length > 0) {
            console.log('[initializeKeywordGroups] 最终分组列表:');
            keywordGroups.value.forEach((group, index) => {
                console.log(`  ${index + 1}. "${group.name}" (ID: ${group.id}) - 关键词: ${group.keywords?.length || 0}`);
            });
        } else {
            console.error('[initializeKeywordGroups] ❌ 初始化后keywordGroups仍然为空！');
        }
    } catch (error) {
        console.error('[initializeKeywordGroups] 加载分组失败:', error);
        // 不创建默认分组，直接使用空数组
        keywordGroups.value = [];
        console.log('[initializeKeywordGroups] 发生错误，keywordGroups.value 已设置为空数组');
    }
};

// 监听数据变化自动保存 - 【优化】使用防抖替代deep:true
// 改为防抖延迟1秒保存，避免频繁触发
const debouncedSaveWorkData = createDebounce(() => {
    // 关键修复：当loadTemplate正在执行时（currentLoadedTemplateId不为空），不应该保存
    // 这样可以防止loadTemplate修改的值被watch覆盖
    if (!currentLoadedTemplateId.value) {
        saveWorkData();
    }
}, 1000);

watch([learnedAccounts, topicLibrary, selectedTopicIndex, scriptWordCount, recognizedText, scriptContent,
        generatedTitle, generatedTags, generatedKeywords, audioPreviewUrl, latestAudioTaskId, videoPreviewUrl, latestVideoTaskId,
        audioEmotion, audioSpeed, videoTemplateId,
        isGeneratingAudio, isGeneratingVideo, processedVideoUrl, finalVideoUrl, coverPreviewUrl,
        enableSubtitle, selectedSubtitleStyleId, subtitleFontSizeScale, subtitlePosition, selectedSubtitleTemplate, enableKeywordEffects, enableBGM, selectedBGMPath, bgmVolume,
        viralVideoType, viralCopyType, viralPersona, viralProduct, viralSellingPoint, viralOther, viralWordCount],
    () => {
        // 🔧 优化：检查自动保存开关，一键智能执行时禁用以避免localStorage频繁写入
        if (!isAutoSavingEnabled.value) return;
        debouncedSaveWorkData();
    },
    {deep: false}  // 🔧 【关键修复】改为 deep: false，仅监听引用变化而不是深层属性变化，大幅减少计算成本
);

// 监听模板列表的关闭，清除currentLoadedTemplateId标志
watch(showTemplateList, (newVal) => {
    if (!newVal) {
        // 模板列表关闭时，清除标志，恢复正常的自动保存
        currentLoadedTemplateId.value = '';
        console.log('[watch showTemplateList] 模板列表已关闭，清除currentLoadedTemplateId');
    }
});

// 🔧 【修复】监听生成状态的变化，自动保存/清除本地存储
// 这样确保即使组件被卸载重载，也能恢复状态
watch(
    [isGeneratingAudio, isGeneratingVideo, isGeneratingSubtitle],
    ([newAudio, newVideo, newSubtitle]) => {
        // 当任何状态变为 false 时，清除对应的本地存储
        if (!newAudio) {
            localStorage.removeItem('videoIPAgent_isGeneratingAudio');
        }
        if (!newVideo) {
            localStorage.removeItem('videoIPAgent_isGeneratingVideo');
        }
        if (!newSubtitle) {
            localStorage.removeItem('videoIPAgent_isGeneratingSubtitle');
        }
    }
);


// 生成语音
// 🔧 优化：添加参数控制是否启动内部轮询（一键工作流中不需要）
const generateAudio = async (options: { skipPolling?: boolean } = {}) => {
    if (!scriptContent.value) {
        Message.warning(t("请先生成或输入文案内容"));
        return;
    }

    // 🆕 语言-音色不匹配时弹出警告
    if (voiceLanguageMismatch.value) {
        const confirmed = await new Promise<boolean>((resolve) => {
            Modal.warning({
                title: t('语言与音色不匹配'),
                content: `当前选择的语言是「${audioLanguage.value}」，但音色适合「${currentVoiceLanguageLabel.value}」，生成的语音将以音色语言为准。建议选择${audioLanguage.value}音色${recommendedVoiceNames.value.length > 0 ? '，如：' + recommendedVoiceNames.value.join('、') : ''}。是否仍要继续？`,
                okText: t('继续生成'),
                cancelText: t('去修改'),
                hideCancel: false,
                onOk: () => resolve(true),
                onCancel: () => resolve(false),
            });
        });
        if (!confirmed) return;
    }

    console.log("准备生成语音，文案内容:", scriptContent.value);
    console.log("文案内容长度:", scriptContent.value.length);
    console.log("[TTS] 使用模式:", settings.value.voiceMode);

    // 防止重复点击
    if (isGeneratingAudio.value) {
        Message.warning(t("正在生成中,请稍候..."));
        return;
    }

    // 开始新任务前，清空之前的预览URL，并重置选择状态
    audioPreviewUrl.value = "";
    selectedAudioIndex.value = null; // 🆕 重置选择索引
    selectedAudioUrl.value = "";     // 🆕 重置选择的URL，确保显示最新生成的
    isGeneratingAudio.value = true;
    localStorage.setItem('videoIPAgent_isGeneratingAudio', 'true');

    try {
        // ==================== 在线模式 ====================
        if (settings.value.voiceMode === 'online') {

            // 🆕 RunningHub 模式（V2）
            if (settings.value.onlineTtsModel === 'runninghub' || settings.value.onlineTtsModel === 'runninghub_t2' || settings.value.onlineTtsModel === 'runninghub_t3' || settings.value.onlineTtsModel === 'runninghub_t4' || settings.value.onlineTtsModel === 'runninghub_t5' || settings.value.onlineTtsModel === 'runninghub_t6') {
                const rhVersion = settings.value.onlineTtsModel === 'runninghub_t2' ? 't2' : settings.value.onlineTtsModel === 'runninghub_t3' ? 't3' : settings.value.onlineTtsModel === 'runninghub_t4' ? 't4' : settings.value.onlineTtsModel === 'runninghub_t5' ? 't5' : settings.value.onlineTtsModel === 'runninghub_t6' ? 't6' : 'v2';
                console.log(`[TTS] 使用在线模式：RunningHub ${rhVersion}`);

                // 🔧 硬编码 API Key
                const runninghubApiKey = getSystemConfigSync().runninghub_api_key;

                // 获取音色信息（复用声音音色的音频）
                const promptIdToUse = settings.value.voicePromptId;
                if (!promptIdToUse) {
                    throw new Error(t("请先选择声音音色"));
                }

                // 获取音色的音频URL
                let audioFileName = '';
                const promptId = String(promptIdToUse);
                if (promptId.startsWith('sys_')) {
                    // 系统音色：使用默认克隆音频
                    audioFileName = '05c303fcfac1ab1976b4eeca832f4b0c0ff8b90ff624c952c9117b343a8ddebd.mp3';
                    console.log("[TTS] 系统音色使用默认音频");
                } else {
                    // 用户自定义音色：获取音频路径并上传
                    const {StorageService} = await import('../../service/StorageService');
                    const prompt = await StorageService.get(promptIdToUse);
                    if (!prompt) {
                        throw new Error(t("声音音色不存在"));
                    }

                    console.log("[TTS] RunningHub使用音色:", prompt.title, prompt.content);

                    // 检查是否有已缓存的RunningHub文件名
                    if (prompt.content?.runninghubAudioFileName) {
                        audioFileName = prompt.content.runninghubAudioFileName;
                        console.log("[TTS] 使用缓存的RunningHub文件名:", audioFileName);
                    } else {
                        // 需要上传音频到RunningHub
                        const audioPath = prompt.content?.url || prompt.content?.audioPath;
                        if (audioPath) {
                            console.log("[TTS] 准备上传音频到RunningHub:", audioPath);
                            try {
                                const uploadResult = await ipcRenderer.invoke('runninghub:uploadFile', {
                                    filePath: audioPath,
                                    fileType: 'audio'
                                });
                                if (uploadResult.success && uploadResult.fileName) {
                                    audioFileName = uploadResult.fileName;
                                    console.log("[TTS] 音频上传成功:", audioFileName);
                                    // 缓存到音色配置中
                                    prompt.content.runninghubAudioFileName = audioFileName;
                                    if (prompt.id) {
                                        await StorageService.update(prompt.id, prompt);
                                    }
                                } else {
                                    console.warn("[TTS] 音频上传失败，使用默认音频:", uploadResult.error);
                                    audioFileName = '05c303fcfac1ab1976b4eeca832f4b0c0ff8b90ff624c952c9117b343a8ddebd.mp3';
                                }
                            } catch (uploadError) {
                                console.warn("[TTS] 音频上传异常，使用默认音频:", uploadError);
                                audioFileName = '05c303fcfac1ab1976b4eeca832f4b0c0ff8b90ff624c952c9117b343a8ddebd.mp3';
                            }
                        } else {
                            console.warn("[TTS] 音色没有音频路径，使用默认音频");
                            audioFileName = '05c303fcfac1ab1976b4eeca832f4b0c0ff8b90ff624c952c9117b343a8ddebd.mp3';
                        }
                    }
                }

                // 🔧 获取用户设置的文件存储路径
                let outputPath: string | undefined = undefined;
                try {
                    const hubRoot = await window.$mapi.config.get('hubRoot');
                    if (hubRoot) {
                        // 🔧 检查 hubRoot 路径是否真实存在
                        const hubRootExists = await ipcRenderer.invoke('file:exists', hubRoot);
                        if (hubRootExists) {
                            const audioDir = await ipcRenderer.invoke('path:join', hubRoot, 'audioCache');
                            outputPath = await ipcRenderer.invoke('path:join', audioDir, `runninghub_${Date.now()}.mp3`);
                        } else {
                            console.warn("[TTS] hubRoot 路径不存在:", hubRoot, "，将使用默认临时目录");
                        }
                    }
                } catch (e) {
                    console.warn("[TTS] 获取持久化路径失败:", e);
                }

                // 调用RunningHub TTS
                // 添加10分钟超时控制
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(t("语音生成超时，请稍后重试")));
                    }, 600000); // 10分钟
                });

                // 🆕 在开始生成前创建任务记录，以获取taskId
                const record: TaskRecord = {
                    biz: "SoundGenerate",
                    title: await window.$mapi.file.textToName(scriptContent.value),
                    serverName: "RunningHub",
                    serverTitle: `RunningHub ${rhVersion.toUpperCase()}语音`,
                    serverVersion: "1.0",
                    modelConfig: {
                        type: "TTS",
                        server: "RunningHub",
                        promptId: promptIdToUse,
                        text: scriptContent.value,
                        version: rhVersion,
                    },
                };
                // 提交任务并获取ID (此时状态为 queue)
                const taskId = await TaskService.submit(record);
                console.log("[TTS] Created RunningHub task:", taskId);

                // 立即更新状态为 running (因为是内联执行，跳过调度器)
                await TaskService.update(taskId, {status: 'running', startTime: Date.now()});

                const runninghubResult = await Promise.race([
                    ipcRenderer.invoke('runninghub:tts:synthesize', {
                        text: scriptContent.value,
                        config: {
                            apiKey: runninghubApiKey,
                            audioFileName: audioFileName,
                            speed: audioSpeed.value || 1.0,
                            emotion: audioEmotion.value !== '无' ? audioEmotion.value : undefined,
                            outputPath: outputPath,
                            version: rhVersion
                        }
                    }),
                    timeoutPromise
                ]);

                if (!runninghubResult.success) {
                    throw new Error(runninghubResult.error || t("RunningHub语音合成失败"));
                }

                const audioPath = runninghubResult.audioPath;
                if (!audioPath) {
                    throw new Error(t("音频文件生成失败"));
                }

                console.log("[TTS] RunningHub生成成功:", audioPath);
                audioPreviewUrl.value = audioPath;
                localStorage.setItem('ipAgent_last_audio', audioPath);
                localStorage.setItem('ipAgent_last_text', scriptContent.value);

                // 🔧 【关键修复】手动更新任务状态为成功，并保存结果到数据库
                // 因为这里是内联执行，没有经过后台任务调度器的正常流程
                await TaskService.update(taskId, {
                    status: 'success',
                    result: {
                        url: audioPath,
                        audioUrl: audioPath
                    },
                    endTime: Date.now()
                });
                console.log("[TTS] RunningHub任务状态已更新到数据库:", taskId);

                try {
                    const _u = JSON.parse(localStorage.getItem('auth_user') || '{}');
                    window.require('electron').ipcRenderer.invoke('auth:reportGeneration', {
                        userId: _u.id,
                        type: 'voice',
                        detail: 'RunningHub TTS'
                    });
                } catch (e) {
                }

                // 🆕 延迟一点刷新，确保数据库已写入
                setTimeout(() => {
                    loadGeneratedAudioHistory();
                }, 1000);

                // 🔧 【关键修复】清空旧任务ID，避免一键智能流程使用旧任务中的音频
                latestAudioTaskId.value = "";

                saveWorkData();

                Message.success(t("语音生成完成"));
                isGeneratingAudio.value = false;
                return;
            }

            // T1多模态语音模型：跳过V1代码，由下方的CosyVoiceV2 (T1)分支处理
            if (settings.value.onlineTtsModel === 'cosyvoiceV2') {
                // 不执行V1代码，直接跳到CosyVoiceV2 (T1)分支
            } else if (settings.value.onlineTtsModel === 'aliyun-cosyvoice') {
                // ==================== V1 阿里云 CosyVoice 模式 ====================
                console.log("[TTS] 使用在线模式：V1 阿里云 CosyVoice");

                const promptIdToUse = settings.value.voicePromptId;
                if (!promptIdToUse) {
                    throw new Error(t("请先选择声音音色"));
                }

                // 阿里云 CosyVoice 音色映射（统一数据源）
                let voiceId = 'longanhuan';
                const isSystemVoice = typeof promptIdToUse === 'string' && promptIdToUse.startsWith('sys_');

                if (isSystemVoice) {
                    voiceId = systemVoiceMapCosyvoice[promptIdToUse] || 'longanhuan';
                } else {
                    const {StorageService} = await import('../../service/StorageService');
                    const prompt = await StorageService.get(promptIdToUse);
                    if (!prompt) {
                        throw new Error(t("声音音色不存在"));
                    }
                    voiceId = prompt.content.aliyunVoiceId || 'longanhuan';
                }

                // 🔧 获取用户设置的文件存储路径
                let outputPath: string | undefined = undefined;
                try {
                    const hubRoot = await window.$mapi.config.get('hubRoot');
                    if (hubRoot) {
                        const hubRootExists = await ipcRenderer.invoke('file:exists', hubRoot);
                        if (hubRootExists) {
                            const audioDir = await ipcRenderer.invoke('path:join', hubRoot, 'audioCache');
                            outputPath = await ipcRenderer.invoke('path:join', audioDir, `cosyvoice_${Date.now()}.mp3`);
                        }
                    }
                } catch (e) {
                    console.warn("[TTS] 获取持久化路径失败:", e);
                }

                // 🆕 在开始生成前创建任务记录
                const record: TaskRecord = {
                    biz: "SoundGenerate",
                    title: await window.$mapi.file.textToName(scriptContent.value),
                    serverName: "Aliyun",
                    serverTitle: "V1 阿里云 CosyVoice",
                    serverVersion: "1.0",
                    modelConfig: {
                        type: "AliyunCosyVoice",
                        text: scriptContent.value,
                        voice: voiceId,
                        speed: audioSpeed.value,
                        model: 'cosyvoice-v3-flash',
                    },
                };
                const taskId = await TaskService.submit(record);
                console.log("[TTS] Created Aliyun CosyVoice task:", taskId);

                // 立即更新状态为 running
                await TaskService.update(taskId, {status: 'running', startTime: Date.now()});

                // 构建情绪 instruction（V1 CosyVoice 通过 instruction 控制情绪）
                const emotionMapFixed: Record<string, string> = {
                    '开心': 'happy',
                    '悲伤': 'sad',
                    '愤怒': 'angry',
                    '恐惧': 'fearful',
                    '惊讶': 'surprised',
                    '厌恶': 'disgusted'
                };
                const emotionMapNatural: Record<string, string> = {
                    '开心': '请用非常开心的语气说话',
                    '悲伤': '请用悲伤的语气说话',
                    '愤怒': '请用愤怒的口气说话',
                    '恐惧': '请用恐惧的语气说话',
                    '惊讶': '请用惊讶的语气说话',
                    '厌恶': '请用厌恶的语气说话'
                };

                let instruction = '';
                if (audioEmotion.value !== '自动') {
                    if (isSystemVoice && INSTRUCT_SUPPORTED_VOICES.includes(voiceId)) {
                        // 支持 Instruct 的系统音色：使用固定格式
                        const emotionKey = emotionMapFixed[audioEmotion.value];
                        if (emotionKey) {
                            instruction = `你说话的情感是${emotionKey}。`;
                        }
                    } else if (!isSystemVoice) {
                        // 复刻音色：使用自然语言指令
                        instruction = emotionMapNatural[audioEmotion.value] || '';
                    }
                    // 其他系统音色不支持 Instruct，忽略情绪选择
                }

                // 获取阿里云 API Key
                const modelStoreModule = await import("../../module/Model/store/model");
                const modelStore = modelStoreModule.useModelStore();
                await modelStore.refreshBuildIn();
                const dashscopeProvider = modelStore.providers.find(p => p.id === 'dashscope');
                const apiKey = dashscopeProvider?.data?.apiKey || getSystemConfigSync().aliyun_bailian_api_key;

                const cosyvoiceParams: any = {
                    apiKey,
                    model: 'cosyvoice-v3-flash',
                    voice: voiceId,
                    text: scriptContent.value,
                    rate: audioSpeed.value,
                    format: 'mp3',
                    sampleRate: 22050,
                    ...(instruction ? {instruction} : {}),
                    ...(outputPath ? {outputPath} : {}),
                };

                // 调用阿里云 CosyVoice 实时语音合成 API
                const cosyvoiceResult = await window.$mapi.aliyun.cosyvoice.synthesizeRealtime(cosyvoiceParams);

                if (!cosyvoiceResult.success) {
                    await TaskService.update(taskId, {
                        status: 'fail',
                        statusMsg: cosyvoiceResult.error || 'Unknown error',
                        endTime: Date.now()
                    });
                    throw new Error(cosyvoiceResult.error || t("阿里云 CosyVoice 语音合成失败"));
                }

                const audioPath = cosyvoiceResult.audioPath;
                if (!audioPath) {
                    throw new Error(t("音频文件生成失败"));
                }

                console.log("[TTS] 阿里云 CosyVoice 生成成功:", audioPath);
                audioPreviewUrl.value = audioPath;
                localStorage.setItem('ipAgent_last_audio', audioPath);
                localStorage.setItem('ipAgent_last_text', scriptContent.value);

                // 更新任务状态为成功
                await TaskService.update(taskId, {
                    status: 'success',
                    result: {
                        url: audioPath,
                        audioUrl: audioPath
                    },
                    endTime: Date.now()
                });
                console.log("[TTS] 阿里云 CosyVoice 任务状态已更新到数据库:", taskId);

                setTimeout(() => {
                    loadGeneratedAudioHistory();
                }, 1000);

                latestAudioTaskId.value = "";
                saveWorkData();

                Message.success(t("语音生成完成"));
                isGeneratingAudio.value = false;
                return;
            } else {
                // ==================== 千问多语言/方言模式（已弃用） ====================
                console.log("[TTS] 使用在线模式：千问 TTS Instruct");

                // 获取阿里云API Key
                const modelStoreModule = await import("../../module/Model/store/model");
                const modelStore = modelStoreModule.useModelStore();
                const dashscopeProvider = modelStore.providers.find(p => p.id === 'dashscope');
                // 🔧 如果用户没配置，使用内置的硬编码 API Key
                const apiKey = dashscopeProvider?.data?.apiKey || getSystemConfigSync().aliyun_bailian_api_key;

                // 获取音色信息
                const promptIdToUse = settings.value.voicePromptId;
                if (!promptIdToUse) {
                    throw new Error(t("请先选择声音音色"));
                }

                let voiceId: string;
                let model = 'qwen3-tts-flash';

                // 音色映射已从 config/systemVoices.ts 统一导入

                const isSystemVoice = typeof promptIdToUse === 'string' && promptIdToUse.startsWith('sys_');

                if (isSystemVoice) {
                    voiceId = systemVoiceMapCosyvoice[promptIdToUse] || 'longanhuan';
                    console.log("[TTS] 使用系统内置音色:", {
                        selectedPromptId: promptIdToUse,
                        language: audioLanguage.value,
                        baseVoice: systemVoiceMapCosyvoice[promptIdToUse],
                        finalVoice: voiceId
                    });
                } else {
                    const {StorageService} = await import('../../service/StorageService');
                    const prompt = await StorageService.get(promptIdToUse);
                    if (!prompt) {
                        throw new Error(t("声音音色不存在"));
                    }

                    voiceId = prompt.content?.aliyunVoiceId || 'longanhuan';
                    // 使用音色存储的 targetModel（兼容旧音色：默认 cosyvoice-v2）
                    model = prompt.content?.targetModel || 'cosyvoice-v2';

                    console.log("[TTS] 使用用户自定义音色:", {
                        promptTitle: prompt.title,
                        aliyunVoiceId: prompt.content?.aliyunVoiceId,
                        voiceId: voiceId,
                        model: model,
                        language: audioLanguage.value,
                        dialectMode: 'hint-only'
                    });
                }

                // 🔧 获取用户设置的文件存储路径（环境设置-文件存储路径）
                let outputPath: string | undefined = undefined;
                try {
                    const hubRoot = await window.$mapi.config.get('hubRoot');
                    if (hubRoot) {
                        // 🔧 检查 hubRoot 路径是否真实存在（盘符不存在、路径无效等情况）
                        const hubRootExists = await ipcRenderer.invoke('file:exists', hubRoot);
                        if (hubRootExists) {
                            // 在 hubRoot 下创建 audioCache 子目录存储音频文件
                            const audioDir = await ipcRenderer.invoke('path:join', hubRoot, 'audioCache');
                            // 生成音频文件路径（使用时间戳确保唯一性）
                            outputPath = await ipcRenderer.invoke('path:join', audioDir, `audio_${Date.now()}.mp3`);
                            console.log("[TTS] 使用持久化音频路径:", outputPath);
                        } else {
                            console.warn("[TTS] hubRoot 路径不存在:", hubRoot, "，将使用默认临时目录");
                        }
                    } else {
                        console.warn("[TTS] 未配置 hubRoot，将使用默认临时目录");
                    }
                } catch (e) {
                    console.warn("[TTS] 获取持久化路径失败，使用默认临时目录:", e);
                }

                // 调用阿里云CosyVoice
                // 🆕 构造指令（提取为变量以便调试）
                // 🆕 构造指令（提取为变量以便调试）
                // 🔧 优化：日语使用原生指令，其他外语仅依赖 language_hints 以减少模型混淆
                const instruction = (() => {
                    const lang = audioLanguage.value;
                    const dialects = ['上海话', '北京话', '四川话', '南京话', '陕西话', '闽南语', '天津话', '粤语'];
                    const isSystemVoice = typeof promptIdToUse === 'string' && promptIdToUse.startsWith('sys_');

                    if (!isSystemVoice && dialects.includes(lang)) {
                        return `请用${lang}表达。`;
                    }

                    if (!isSystemVoice && lang && lang !== '中文' && lang !== '中文（普通话）') {
                        return `请用${lang}表达。`;
                    }

                    if (lang === '日语') {
                        return undefined;
                    }

                    return undefined;
                })();

                // 🆕 构造 language_hints 参数
                const languageHints = (() => {
                    const lang = audioLanguage.value;

                    if (!lang || lang === '中文' || lang === '中文（普通话）') {
                        return undefined;
                    }

                    const hintsMap: Record<string, string> = {
                        '英语': 'en',
                        '法语': 'fr',
                        '德语': 'de',
                        '日语': 'ja',
                        '韩语': 'ko',
                        '俄语': 'ru',
                        '意大利语': 'it',
                        '西班牙语': 'es',
                        '葡萄牙语': 'pt',
                        '上海话': 'Chinese',
                        '北京话': 'Chinese',
                        '四川话': 'Chinese',
                        '南京话': 'Chinese',
                        '陕西话': 'Chinese',
                        '闽南语': 'Chinese',
                        '天津话': 'Chinese',
                        '粤语': 'Chinese'
                    };

                    return hintsMap[lang];
                })();

                // 🔧 关键修复：VC（声音克隆）模型不应设置 instructions，否则会覆盖克隆音色的特征
                // 仅非 VC 模型（qwen3-tts-flash）使用默认 instruction
                const isVcModel = model.includes('-vc');
                const finalInstruction = isVcModel ? instruction : (instruction || '请用自然、清晰、适合短视频配音的风格朗读。');

                // 构造配置对象
                const cosyVoiceConfig = {
                    apiKey: apiKey,
                    model: model,
                    voice: voiceId,
                    format: outputPath?.toLowerCase().endsWith('.mp3') ? 'mp3' : 'wav',
                    sampleRate: 24000,
                    volume: 100,
                    rate: audioSpeed.value || 1.0,
                    instruction: finalInstruction,
                    language_hints: languageHints,
                    language: audioLanguage.value,
                    outputPath: outputPath
                };


                // 🆕 在开始生成前创建任务记录，以获取taskId
                const record: TaskRecord = {
                    biz: "SoundGenerate",
                    title: await window.$mapi.file.textToName(scriptContent.value),
                    serverName: "CosyVoice",
                    serverTitle: "阿里云CosyVoice",
                    serverVersion: "3.0",
                    modelConfig: {
                        type: "TTS",
                        server: "CosyVoice",
                        promptId: promptIdToUse,
                        voiceId: voiceId,
                        text: scriptContent.value,
                    },
                };
                // 提交任务并获取ID (此时状态为 queue)
                const taskId = await TaskService.submit(record);
                console.log("[TTS] Created CosyVoice task:", taskId);

                // 立即更新状态为 running
                await TaskService.update(taskId, {status: 'running', startTime: Date.now()});

                // 调用阿里云CosyVoice
                // 添加10分钟超时控制
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(t("语音生成超时，请稍后重试")));
                    }, 600000); // 10分钟
                });

                const ttsResult = await Promise.race([
                    ipcRenderer.invoke('aliyun:cosyvoice:synthesize', {
                        text: scriptContent.value,
                        config: cosyVoiceConfig
                    }),
                    timeoutPromise
                ]);

                if (!ttsResult.success) {
                    // 失败也要更新状态
                    await TaskService.update(taskId, {
                        status: 'fail',
                        statusMsg: ttsResult.error || 'Unknown error',
                        endTime: Date.now()
                    });
                    throw new Error(ttsResult.error || t("阿里云语音合成失败"));
                }

                // 获取生成的音频路径
                const audioPath = ttsResult.audioPath;
                if (!audioPath) {
                    throw new Error(t("音频文件生成失败"));
                }

                console.log("[TTS] 阿里云CosyVoice生成成功:", audioPath);
                audioPreviewUrl.value = audioPath;
                // 🔧 保存到 localStorage 以便刷新后恢复
                localStorage.setItem('ipAgent_last_audio', audioPath);
                localStorage.setItem('ipAgent_last_text', scriptContent.value);

                // 🔧 【关键修复】手动更新任务状态为成功，并保存结果到数据库
                // CosyVoice 也是内联执行，需要手动更新 DB
                await TaskService.update(taskId, {
                    status: 'success',
                    result: {
                        url: audioPath,
                        audioUrl: audioPath
                    },
                    endTime: Date.now()
                });
                console.log("[TTS] CosyVoice任务状态已更新到数据库:", taskId);

                try {
                    const _u = JSON.parse(localStorage.getItem('auth_user') || '{}');
                    window.require('electron').ipcRenderer.invoke('auth:reportGeneration', {
                        userId: _u.id,
                        type: 'voice',
                        detail: 'CosyVoice TTS'
                    });
                } catch (e) {
                }

                // 🆕 成功后立即刷新音频历史记录
                setTimeout(() => {
                    loadGeneratedAudioHistory();
                }, 1000);

                // 🔧 【关键修复】清空旧任务ID，避免一键智能流程使用旧任务中的音频
                latestAudioTaskId.value = "";

                // 🔧 【关键修复】立即保存工作数据，确保重启后可以恢复
                saveWorkData();

                Message.success(t("语音生成完成"));
                isGeneratingAudio.value = false;
                return;
            } // end V1 else
        }

        // ==================== T1 多模态语音模型 ====================
        if (settings.value.onlineTtsModel === 'cosyvoiceV2') {
            console.log("[TTS] 使用在线模式：T1 多模态语音模型");

            // 获取阿里云API Key（与CosyVoice共用）
            const modelStoreModule = await import("../../module/Model/store/model");
            const modelStore = modelStoreModule.useModelStore();
            const dashscopeProvider = modelStore.providers.find(p => p.id === 'dashscope');
            const apiKey = dashscopeProvider?.data?.apiKey || getSystemConfigSync().aliyun_bailian_api_key;

            if (!apiKey) {
                throw new Error(t("请先在模型设置中配置阿里云百炼API Key"));
            }

            // 获取音色信息（与V1一致，通过 voicePromptId 解析）
            const promptIdToUse = settings.value.voicePromptId;
            if (!promptIdToUse) {
                throw new Error(t("请先选择声音音色"));
            }

            // V3 系统音色映射已从 config/systemVoices.ts 统一导入

            let voiceId: string;
            const isSystemVoice = typeof promptIdToUse === 'string' && promptIdToUse.startsWith('sys_');

            let t1Model = 'cosyvoice-v3.5-plus';
            if (isSystemVoice) {
                voiceId = systemVoiceMapCosyvoice[promptIdToUse] || 'longanhuan';
                // 系统音色 ID 格式对齐 cosyvoice-v3-flash，必须使用 cosyvoice-v3-flash 模型
                t1Model = 'cosyvoice-v3-flash';
                console.log("[TTS] T1 系统音色映射:", promptIdToUse, "->", voiceId, "model:", t1Model);
            } else {
                const {StorageService} = await import('../../service/StorageService');
                const prompt = await StorageService.get(promptIdToUse);
                if (!prompt) {
                    throw new Error(t("声音音色不存在"));
                }
                // 克隆音色使用 aliyunVoiceId，并根据存储的 targetModel 选择合成模型（兼容旧音色）
                voiceId = prompt.content?.aliyunVoiceId;
                if (!voiceId) {
                    // 克隆未完成注册时直接报错：回退默认音色会与 targetModel 不匹配（v2 音色配 v3.5 模型触发 418）
                    throw new Error(t("该音色尚未完成克隆注册，请重新进行声音克隆后再使用"));
                }
                t1Model = prompt.content?.targetModel || 'cosyvoice-v2';
                console.log("[TTS] T1 自定义音色:", voiceId, "model:", t1Model);
            }

            // 获取持久化输出路径
            let outputPath: string | undefined = undefined;
            try {
                const hubRoot = await window.$mapi.config.get('hubRoot');
                if (hubRoot) {
                    // 🔧 检查 hubRoot 路径是否真实存在
                    const hubRootExists = await ipcRenderer.invoke('file:exists', hubRoot);
                    if (hubRootExists) {
                        const audioDir = await ipcRenderer.invoke('path:join', hubRoot, 'audioCache');
                        outputPath = await ipcRenderer.invoke('path:join', audioDir, `t1_model_${Date.now()}.mp3`);
                        console.log("[TTS] T1 多模态语音模型使用持久化音频路径:", outputPath);
                    } else {
                        console.warn("[TTS] hubRoot 路径不存在:", hubRoot, "，将使用默认临时目录");
                    }
                }
            } catch (e) {
                console.warn("[TTS] 获取持久化路径失败，使用默认临时目录:", e);
            }

            // 创建任务记录
            const record: TaskRecord = {
                biz: "SoundGenerate",
                title: await window.$mapi.file.textToName(scriptContent.value),
                serverName: "T1Model",
                serverTitle: "T1 多模态语音模型",
                serverVersion: "1.0",
                modelConfig: {
                    type: "TTS",
                    server: "T1Model",
                    model: "cosyvoice-v3.5-plus",
                    voice: voiceId,
                    text: scriptContent.value,
                },
            };
            const taskId = await TaskService.submit(record);
            console.log("[TTS] Created T1 多模态语音模型 task:", taskId);

            await TaskService.update(taskId, {status: 'running', startTime: Date.now()});

            // 调用 CosyVoice V2 合成
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(t("语音生成超时，请稍后重试")));
                }, 600000);
            });

            const v2Result = await Promise.race([
                ipcRenderer.invoke('aliyun:cosyvoiceV2:synthesize', {
                    text: scriptContent.value,
                    config: {
                        apiKey: apiKey,
                        model: t1Model,
                        voice: voiceId,
                        format: 'mp3',
                        sampleRate: 24000,
                        volume: 100,
                        rate: audioSpeed.value || 1.0,
                        pitch: 1.0,
                        outputPath: outputPath,
                    }
                }),
                timeoutPromise
            ]) as any;

            if (!v2Result.success) {
                await TaskService.update(taskId, {
                    status: 'fail',
                    statusMsg: v2Result.error || 'Unknown error',
                    endTime: Date.now()
                });
                throw new Error(v2Result.error || t("T1多模态语音模型合成失败"));
            }

            const audioPath = v2Result.audioPath;
            if (!audioPath) {
                throw new Error(t("音频文件生成失败"));
            }

            console.log("[TTS] T1 多模态语音模型生成成功:", audioPath);
            audioPreviewUrl.value = audioPath;
            localStorage.setItem('ipAgent_last_audio', audioPath);
            localStorage.setItem('ipAgent_last_text', scriptContent.value);

            await TaskService.update(taskId, {
                status: 'success',
                result: {
                    url: audioPath,
                    audioUrl: audioPath
                },
                endTime: Date.now()
            });
            console.log("[TTS] T1 多模态语音模型任务状态已更新到数据库:", taskId);

            try {
                const _u = JSON.parse(localStorage.getItem('auth_user') || '{}');
                window.require('electron').ipcRenderer.invoke('auth:reportGeneration', {
                    userId: _u.id,
                    type: 'voice',
                    detail: 'T1 CosyVoice TTS'
                });
            } catch (e) {
            }

            setTimeout(() => {
                loadGeneratedAudioHistory();
            }, 1000);

            latestAudioTaskId.value = "";
            saveWorkData();

            Message.success(t("语音生成完成"));
            isGeneratingAudio.value = false;
            return;
        }

        // ==================== 本地模式：原有逻辑 ====================
        console.log("[TTS] 使用本地模式");

        // 🔧 兼容性修复：如果 voiceMode 本身就是模型Key (非 'local'/'online')，说明可能是通过在线选择器选了某种模型
        // 这种情况下 ServerSelector 被隐藏了，导致 voiceModelKey 为空。我们需要自动使用 voiceMode 作为 key。
        if (settings.value.voiceMode && settings.value.voiceMode !== 'local' && settings.value.voiceMode !== 'online' && !settings.value.voiceModelKey) {
            console.log("[TTS Fix] voiceMode 包含模型Key，自动同步到 voiceModelKey:", settings.value.voiceMode);
            settings.value.voiceModelKey = settings.value.voiceMode;

            // 同时也保存这个 key 到备份，防止下次又丢
            localStorage.setItem('backup_voiceModelKey', settings.value.voiceMode);
        }


        // 🔧 尝试从备份恢复 voiceModelKey
        if (!settings.value.voiceModelKey) {
            const backup = localStorage.getItem('backup_voiceModelKey');
            if (backup) {
                console.log("[TTS Info] 尝试从本地备份恢复 voiceModelKey:", backup);
                settings.value.voiceModelKey = backup;
            }
        }

        if (!settings.value.voiceModelKey) {
            console.error("[TTS Error] voiceModelKey is empty. Settings:", JSON.stringify(settings.value));

            Message.error(t("请先在设置中配置本地声音模型服务器"));
            isGeneratingAudio.value = false;
            return;
        }

        const {useServerStore} = await import('../../store/modules/server');
        const serverStore = useServerStore();
        const server = await serverStore.getByKey(settings.value.voiceModelKey);

        if (!server) {
            Message.error(t("声音模型未找到，请检查设置"));
            isGeneratingAudio.value = false;
            return;
        }

        // 使用设置中的音色ID
        const promptIdToUse = settings.value.voicePromptId;

        if (!promptIdToUse) {
            Message.error(t("请先选择声音音色"));
            isGeneratingAudio.value = false;
            return;
        }

        // 获取音色信息
        const {StorageService} = await import('../../service/StorageService');
        const prompt = await StorageService.get(promptIdToUse);
        if (!prompt) {
            Message.error(t("声音音色不存在"));
            isGeneratingAudio.value = false;
            return;
        }

        // 构建克隆参数,包含语速和情绪
        const cloneParam: any = {
            speed: audioSpeed.value
        };

        // 如果支持情绪参数,则添加
        if (audioEmotion.value && audioEmotion.value !== "无") {
            cloneParam.emotion = audioEmotion.value;
        }

        const record: TaskRecord = {
            biz: "SoundGenerate",
            title: await window.$mapi.file.textToName(scriptContent.value),
            serverName: server.name,
            serverTitle: server.title,
            serverVersion: server.version,
            modelConfig: {
                type: "SoundClone",
                cloneServerKey: settings.value.voiceModelKey,
                cloneParam: cloneParam,
                promptId: promptIdToUse,
                promptTitle: prompt.title,
                promptUrl: prompt.content.url,
                promptText: prompt.content.promptText,
                text: scriptContent.value,
            },
        };

        const taskId = await TaskService.submit(record);
        latestAudioTaskId.value = taskId;

        // 🔧 修复：如果后台任务已禁用，自动启动以确保任务能够执行
        const taskStatus = taskStore.getBackgroundTaskStatus();
        if (!taskStatus.enabled) {
            console.log('[generateAudio] 后台任务已禁用，自动启动以确保语音生成任务执行');
            await taskStore.startBackgroundTasks();
        }

        Message.success(t("语音生成任务已提交，请稍候..."));

        // 🔧 优化：如果是一键工作流调用，跳过内部轮询，由外部统一管理
        if (options.skipPolling) {
            console.log('[generateAudio] 跳过内部轮询，由一键工作流统一管理');
            return;
        }

        // ✅ 事件驱动等待（替代轮询）
        try {
            const result = await waitForTaskCompletion({
                taskId,
                timeout: 3600000,  // 🔧 调整超时时间为60分钟，防止长文案超时
                fallbackPolling: true,
                pollingInterval: 5000,  // fallback轮询间隔改为5秒
                onCancelCheck: () => !isGeneratingAudio.value  // 如果用户取消则中止等待
            });

            console.log('[generateAudio] 任务完成，result类型:', typeof result, 'result:', result);
            console.log('[generateAudio] result.url:', result.url);
            console.log('[generateAudio] 完整任务对象:', {
                result: result,
                hasUrl: !!result?.url,
                resultKeys: result ? Object.keys(result) : []
            });

            // ✅ 修复：尝试从多个字段提取URL
            let audioUrl = result?.url || result;

            // 如果result是空对象，尝试从数据库重新查询完整任务
            if (!audioUrl || (typeof audioUrl === 'object' && Object.keys(audioUrl).length === 0)) {
                console.warn('[generateAudio] ⚠️ result为空，尝试从数据库重新查询任务:', taskId);
                try {
                    const fullTask = await TaskService.get(taskId);
                    console.log('[generateAudio] 从数据库查询到完整任务:', fullTask);
                    console.log('[generateAudio] 任务所有字段:', JSON.stringify(fullTask, null, 2));

                    // 尝试多个可能的结果字段
                    audioUrl = fullTask?.result?.url ||
                        fullTask?.jobResult?.url ||
                        fullTask?.result ||
                        fullTask?.jobResult;
                    console.log('[generateAudio] 从数据库提取的URL:', audioUrl);

                    // 如果仍然没有URL，尝试从文件系统查找最近生成的音频
                    if (!audioUrl || (typeof audioUrl === 'object' && Object.keys(audioUrl).length === 0)) {
                        console.warn('[generateAudio] ⚠️ 从数据库仍未找到URL，尝试从文件系统查找...');
                        try {
                            const resultFiles = await window.$mapi.ipAgent.getResultFilesRecently('audio', 5);
                            if (resultFiles && resultFiles.length > 0) {
                                audioUrl = resultFiles[0];
                                console.log('[generateAudio] 从文件系统查找到最近的音频文件:', audioUrl);
                            }
                        } catch (fsError) {
                            console.warn('[generateAudio] 从文件系统查找失败:', fsError);
                        }
                    }
                } catch (error) {
                    console.error('[generateAudio] 从数据库查询失败:', error);
                }
            }

            // 🔧 验证 audioUrl 有效性
            if (!audioUrl || (typeof audioUrl === 'object' && Object.keys(audioUrl).length === 0)) {
                console.error('[generateAudio] ❌ 音频URL为空或无效:', audioUrl);
                throw new Error("音频生成失败：结果为空。这可能是旧任务或任务执行异常，请重新生成音频。");
            }

            if (typeof audioUrl !== 'string') {
                console.error('[generateAudio] ❌ URL不是字符串类型:', typeof audioUrl, audioUrl);
                throw new Error("音频URL格式错误，请重新生成音频。");
            }

            // 验证URL不是"{}"这样的无效字符串
            if (audioUrl === '{}' || audioUrl === 'null' || audioUrl === 'undefined' || audioUrl.trim() === '') {
                console.error('[generateAudio] ❌ 音频URL是无效字符串:', audioUrl);
                throw new Error("音频生成失败：结果无效。请重新生成音频。");
            }

            // 🔧 关键：使用 nextTick 确保 key 绑定能触发组件更新
            await nextTick();
            audioPreviewUrl.value = audioUrl;
            console.log("语音生成完成，URL:", audioPreviewUrl.value, '类型:', typeof audioPreviewUrl.value);

            // 🔧 【关键修复】立即保存工作数据，确保重启后可以恢复
            saveWorkData();

            Message.success(t("语音生成完成"));
            Message.success(t("语音生成完成"));
            try {
                const _u = JSON.parse(localStorage.getItem('auth_user') || '{}');
                window.require('electron').ipcRenderer.invoke('auth:reportGeneration', {
                    userId: _u.id,
                    type: 'voice',
                    detail: '本地声音克隆'
                });
            } catch (e) {
            }
            isGeneratingAudio.value = false;

            // 🆕 成功后立即刷新音频历史记录
            await loadGeneratedAudioHistory();

        } catch (waitError) {
            if (waitError.message.includes("超时")) {
                Message.info(t("语音生成时间较长，任务继续在后台执行，您可以在任务列表查看进度"));
            } else if (waitError.message.includes("取消")) {
                Message.info(t("语音生成已停止"));
            } else {
                Message.error(t("语音生成失败：") + waitError.message);
            }
            isGeneratingAudio.value = false;
        }

    } catch (error) {
        console.error("生成语音失败:", error);
        Message.error(t("生成语音失败：") + (error?.message || t("未知错误")));
        isGeneratingAudio.value = false;
    }
};

// 🆕 解析 SRT 文件内容为 records（用于自动生成字幕数据）
const splitScriptIntoSubtitleLines = (text: string, maxCharsPerLine = 14): string[] => {
    const normalized = String(text || '').replace(/\r/g, '\n');
    const roughLines = normalized
        .split(/[，。！？、；\n]+/)
        .map(line => line.trim())
        .filter(line => line.length > 0);

    const seedLines = roughLines.length > 1 ? roughLines : [normalized.replace(/[\r\n]+/g, ' ').trim()].filter(Boolean);
    const finalLines: string[] = [];

    for (const line of seedLines) {
        if (line.length <= maxCharsPerLine) {
            finalLines.push(line);
            continue;
        }

        let remaining = line;
        while (remaining.length > maxCharsPerLine) {
            finalLines.push(remaining.slice(0, maxCharsPerLine).trim());
            remaining = remaining.slice(maxCharsPerLine).trim();
        }
        if (remaining.length > 0) {
            finalLines.push(remaining);
        }
    }

    return finalLines.filter(Boolean);
};
const buildTimedSubtitleRecords = (
    lines: string[],
    totalDuration: number,
    includeWords = false
): any[] => {
    const totalText = lines.join('');
    let currentTime = 0;

    return lines.map((line) => {
        const lineDuration = totalText.length > 0 ? (line.length / totalText.length) * totalDuration : 0;
        const record = {
            text: line,
            start: currentTime,
            end: currentTime + lineDuration,
            words: includeWords ? [] : undefined,
        };
        currentTime += lineDuration;
        return record;
    });
};
const parseSrtToRecords = (srtContent: string): any[] => {
    const records: any[] = [];
    const blocks = srtContent.trim().split(/\n\s*\n/);

    console.log('[parseSrtToRecords] 解析SRT，共', blocks.length, '个块');

    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 3) continue;

        // 第1行：序号
        // 第2行：时间轴 (00:00:00,000 --> 00:00:03,000)
        // 第3行及以后：文本内容
        const timeLine = lines[1];
        const text = lines.slice(2).join('\n');

        const timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
        if (!timeMatch) continue;

        // 保持毫秒为单位（混剪处理需要毫秒）
        const startTime = parseInt(timeMatch[1]) * 3600000 + parseInt(timeMatch[2]) * 60000 + parseInt(timeMatch[3]) * 1000 + parseInt(timeMatch[4]);
        const endTime = parseInt(timeMatch[5]) * 3600000 + parseInt(timeMatch[6]) * 60000 + parseInt(timeMatch[7]) * 1000 + parseInt(timeMatch[8]);

        records.push({
            text: text.trim(),
            start: startTime,
            end: endTime
        });
    }

    console.log('[parseSrtToRecords] 解析完成，共', records.length, '条记录');
    return records;
};

// 生成视频
// 🔧 优化：添加参数控制是否启动内部轮询（一键工作流中不需要）
const generateVideo = async (options: { skipPolling?: boolean } = {}) => {
    if (!audioPreviewUrl.value) {
        Message.warning(t("请先生成语音"));
        return;
    }

    if (!settings.value.videoDigitalHumanModelKey) {
        Message.error(t("请先在设置中选择数字人模型"));
        return;
    }

    if (!videoTemplateId.value) {
        Message.error(t("请先选择视频形象"));
        return;
    }

    // 防止重复点击
    if (isGeneratingVideo.value) {
        Message.warning(t("正在生成中,请稍候..."));
        return;
    }

    // 开始新任务前，清空之前的预览URL
    videoPreviewUrl.value = "";
    processedVideoUrl.value = "";
    isGeneratingVideo.value = true;
    // 🔧 【修复】保存视频生成状态到本地存储，避免切换页面后状态丢失
    localStorage.setItem('videoIPAgent_isGeneratingVideo', 'true');

    let taskId: any = null;

    try {
        // 检查是否是云端模式（支持云端模式1和云端模式2和推送模型）
        const isCloudMode = settings.value.videoDigitalHumanModelKey?.startsWith('__CLOUD') || settings.value.videoDigitalHumanModelKey?.startsWith('__SERVER_DH_');
        const isCloudMode2 = settings.value.videoDigitalHumanModelKey === '__CLOUD_1942022968606355458__';
        const isCloudMode3 = settings.value.videoDigitalHumanModelKey === '__CLOUD_MODEL_3__';
        const isCloudMode4 = settings.value.videoDigitalHumanModelKey === '__CLOUD_MODEL_4__';
        const isCloudMode5 = settings.value.videoDigitalHumanModelKey === '__CLOUD_MODEL_5__';
        const isCloudMode6 = settings.value.videoDigitalHumanModelKey === '__CLOUD_MODEL_6__';
        const isCloudMode7 = settings.value.videoDigitalHumanModelKey === '__CLOUD_MODEL_7__';
        const isCloudMode8 = settings.value.videoDigitalHumanModelKey === '__CLOUD_MODEL_8__';
        const isCloudBeauty = settings.value.videoDigitalHumanModelKey === '__CLOUD_BEAUTY__';
        const isServerPushDH = settings.value.videoDigitalHumanModelKey?.startsWith('__SERVER_DH_');
        const isSelfServerMode = settings.value.videoDigitalHumanModelKey === '__SELF_SERVER__';
        console.log('[generateVideo] 🌩️ 数字人模式:', isCloudMode ? (isCloudMode8 ? '网络节点08' : isCloudMode7 ? '网络节点07' : isCloudMode6 ? '网络节点06' : isCloudMode5 ? '网络节点05' : isCloudMode4 ? '网络节点04' : isCloudMode3 ? '网络节点03' : isCloudMode2 ? '网络节点02' : isServerPushDH ? '推送数字人' : isCloudBeauty ? '极速' : '网络节点01') : (isSelfServerMode ? '自主算力机' : '本地'));

        if (isCloudMode) {
            const {useAuthStore} = await import('../../store/modules/auth');
            const authStore = useAuthStore();
            if (authStore.user?.cloud_digital_human_disabled) {
                Message.error(t("请选择正确的数字人模型"));
                isGeneratingVideo.value = false;
                return;
            }
        }

        // 获取服务器信息（仅本地模式需要）
        let server: any = null;
        if (!isCloudMode && !isSelfServerMode) {
            const {useServerStore} = await import('../../store/modules/server');
            const serverStore = useServerStore();
            server = await serverStore.getByKey(settings.value.videoDigitalHumanModelKey);

            if (!server) {
                Message.error(t("数字人模型未找到"));
                isGeneratingVideo.value = false;
                return;
            }
        }

        // 自主算力机模式：验证配置
        if (isSelfServerMode && !settings.value.selfServerId) {
            Message.error(t("请先配置自主算力机服务器ID"));
            isGeneratingVideo.value = false;
            return;
        }

        const {VideoTemplateService} = await import('../../service/VideoTemplateService');
        const videoTemplate = await VideoTemplateService.get(videoTemplateId.value);
        if (!videoTemplate) {
            Message.error(t("视频形象未找到"));
            isGeneratingVideo.value = false;
            return;
        }

        const {TimeUtil} = await import('../../lib/util');

        // 🔧 核心修复：直接使用播放器显示的音频，播放器为空则报错
        console.log('[generateVideo] 🔍 播放器音频URL:', audioPreviewUrl.value);

        if (!audioPreviewUrl.value) {
            console.error('[generateVideo] ❌ 播放器音频为空');
            Message.error('请先生成音频');
            isGeneratingVideo.value = false;
            return;
        }

        console.log('[generateVideo] ✅ 使用播放器音频:', audioPreviewUrl.value);
        console.log('[generateVideo] ⏱️ 音频时长:', audioDuration.value, '秒');
        const record: TaskRecord = {
            biz: "VideoGen",
            title: await window.$mapi.file.textToName(videoTemplate.name + "_" + TimeUtil.datetimeString()),
            serverName: isCloudMode ? (isCloudMode8 ? '__CLOUD_MODEL_8__' : isCloudMode7 ? '__CLOUD_MODEL_7__' : isCloudMode6 ? '__CLOUD_MODEL_6__' : isCloudMode5 ? '__CLOUD_MODEL_5__' : isCloudMode4 ? '__CLOUD_MODEL_4__' : isCloudMode3 ? '__CLOUD_MODEL_3__' : isCloudMode2 ? '__CLOUD_1942022968606355458__' : (isCloudBeauty ? '__CLOUD_BEAUTY__' : isServerPushDH ? settings.value.videoDigitalHumanModelKey : '__CLOUD__')) : (isSelfServerMode ? '__SELF_SERVER__' : server.name),
            serverTitle: isCloudMode ? (isCloudMode8 ? '网络节点08' : isCloudMode7 ? '网络节点07' : isCloudMode6 ? '网络节点06' : isCloudMode5 ? '网络节点05' : isCloudMode4 ? '网络节点04' : isCloudMode3 ? '网络节点03' : isCloudMode2 ? '网络节点02' : (isCloudBeauty ? '极速模型' : isServerPushDH ? '推送数字人' : '网络节点01')) : (isSelfServerMode ? '自主算力机' : server.title),
            serverVersion: isCloudMode ? '1.0' : (isSelfServerMode ? '1.0' : server.version),
            modelConfig: {
                videoTemplateId: videoTemplateId.value,
                videoTemplateName: videoTemplate.name,
                videoTemplateUrl: videoTemplate.video,
                soundType: "soundCustom",
                soundGenerateId: "",
                soundGenerateText: scriptContent.value,
                soundCustomFile: audioPreviewUrl.value,
                soundAudioFile: audioPreviewUrl.value,
                audioDuration: audioDuration.value > 0 ? audioDuration.value : undefined,
                cloudBeautyMode: isCloudBeauty ? cloudBeautyMode.value : undefined,
            },
            param: {},
        };

        taskId = await TaskService.submit(record);
        latestVideoTaskId.value = taskId;

        // 🔧 修复：如果后台任务已禁用，自动启动以确保任务能够执行
        const taskStatus = taskStore.getBackgroundTaskStatus();
        if (!taskStatus.enabled) {
            console.log('[generateVideo] 后台任务已禁用，自动启动以确保视频生成任务执行');
            await taskStore.startBackgroundTasks();
        }

        // 记录任务日志
        await TaskService.log(taskId, "info", "视频生成任务已提交", {
            processName: "VideoGen",
            progress: 0,
            metadata: {
                template: videoTemplate.name,
                audioTaskId: latestAudioTaskId.value
            }
        });

        Message.success(t("视频生成任务已提交，请稍候..."));

        // 🔧 优化：如果是一键工作流调用，跳过内部轮询，由外部统一管理
        if (options.skipPolling) {
            console.log('[generateVideo] 跳过内部轮询，由一键工作流统一管理');
            return;
        }

        // ✅ 事件驱动等待（替代轮询）
        try {
            const result = await waitForTaskCompletion({
                taskId,
                timeout: 600000,  // 🔧 【调整】从5分钟改为10分钟超时
                fallbackPolling: true,
                pollingInterval: 5000,  // fallback轮询间隔改为5秒
                onCancelCheck: () => !isGeneratingVideo.value  // 如果用户取消则中止等待
            });

            // ✅ 修复：尝试从多个字段提取URL
            let videoUrl = result?.url || result;

            // 如果result是空对象，尝试从数据库重新查询完整任务
            if (!videoUrl || (typeof videoUrl === 'object' && Object.keys(videoUrl).length === 0)) {
                console.warn('[generateVideo] ⚠️ result为空，尝试从数据库重新查询任务:', taskId);
                try {
                    const fullTask = await TaskService.get(taskId);
                    console.log('[generateVideo] 从数据库查询到完整任务:', fullTask);
                    console.log('[generateVideo] 任务所有字段:', JSON.stringify(fullTask, null, 2));

                    // 尝试多个可能的结果字段
                    videoUrl = fullTask?.result?.url ||
                        fullTask?.jobResult?.url ||
                        fullTask?.result ||
                        fullTask?.jobResult;
                    console.log('[generateVideo] 从数据库提取的URL:', videoUrl);

                    // 如果仍然没有URL，尝试从文件系统查找最近生成的视频
                    if (!videoUrl || (typeof videoUrl === 'object' && Object.keys(videoUrl).length === 0)) {
                        console.warn('[generateVideo] ⚠️ 从数据库仍未找到URL，尝试从文件系统查找...');
                        try {
                            const resultFiles = await window.$mapi.ipAgent.getResultFilesRecently('video', 5);
                            if (resultFiles && resultFiles.length > 0) {
                                videoUrl = resultFiles[0];
                                console.log('[generateVideo] 从文件系统查找到最近的视频文件:', videoUrl);
                            }
                        } catch (fsError) {
                            console.warn('[generateVideo] 从文件系统查找失败:', fsError);
                        }
                    }
                } catch (error) {
                    console.error('[generateVideo] 从数据库查询失败:', error);
                }
            }

            if (typeof videoUrl !== 'string') {
                videoUrl = JSON.stringify(videoUrl);
                console.warn('[generateVideo] ⚠️ URL不是字符串，已转换:', videoUrl);
            }

            // 🔧 关键：使用 nextTick 确保 key 绑定能触发组件更新
            await nextTick();

            try {
                const hubRootPath = await window.$mapi.config.get("hubRoot", "");
                if (hubRootPath && videoUrl && !videoUrl.startsWith(hubRootPath)) {
                    const savedPath = await DataService.saveFile(videoUrl.replace(/^file:\/\//, ''), {saveGroup: 'video'});
                    if (savedPath) {
                        console.log('[generateVideo] ✅ 视频已重新保存到存储路径:', savedPath);
                        videoUrl = savedPath;
                    }
                }
            } catch (e) {
                console.warn('[generateVideo] 重新保存视频到存储路径失败:', e);
            }

            videoPreviewUrl.value = videoUrl;
            console.log("视频生成完成，URL:", videoPreviewUrl.value, '类型:', typeof videoPreviewUrl.value);

            // 🆕 自动生成字幕数据（作为后续混剪和字幕渲染的时间轴基准）
            console.log('[generateVideo] 🎬 视频生成完成，开始自动生成字幕数据...');
            try {
                const subtitleResult = await generateFullSubtitle();
                if (subtitleResult.success && subtitleResult.srtPath) {
                    console.log('[generateVideo] ✅ 字幕数据自动生成成功:', subtitleResult.srtPath);

                    // 读取生成的 SRT 文件并解析为 records
                    try {
                        const srtContent = await window.$mapi.file.read(subtitleResult.srtPath, {isDataPath: false});
                        const records = parseSrtToRecords(srtContent);

                        if (records && records.length > 0) {
                            await window.$mapi.file.write("cache-subtitle-records.json", JSON.stringify(records));
                            localStorage.setItem('videoIPAgent_srtPath', subtitleResult.srtPath);
                            saveSubtitleReuseMeta({
                                videoPath: videoUrl,
                                scriptText: scriptContent.value,
                                srtPath: subtitleResult.srtPath,
                                records,
                            });
                            // 保存到混剪配置
                            const mixCutConfig = await window.$mapi.config.get('videoMixCutSettings') || {};
                            mixCutConfig.records = records;
                            mixCutConfig.subtitleFilePath = subtitleResult.srtPath;
                            await window.$mapi.config.set('videoMixCutSettings', mixCutConfig);

                            console.log('[generateVideo] ✅ 字幕数据已保存，共', records.length, '条记录');
                            Message.success(t('视频和字幕数据生成完成'));
                        }
                    } catch (parseError) {
                        console.error('[generateVideo] ❌ 解析字幕数据失败:', parseError);
                    }
                } else {
                    console.warn('[generateVideo] ⚠️ 字幕数据生成失败:', subtitleResult.error);
                    // 不影响主流程，只是没有字幕数据
                }
            } catch (subtitleError) {
                console.error('[generateVideo] ❌ 自动生成字幕时出错:', subtitleError);
                // 不影响主流程
            }

            // 🔧 【关键修复】立即保存工作数据，确保重启后可以恢复
            saveWorkData();

            await TaskService.log(taskId, "info", "视频生成完成", {
                processName: "VideoGen",
                progress: 100,
                processPath: result.url || result
            });
            Message.success(t("视频生成完成"));
            isGeneratingVideo.value = false;

        } catch (waitError) {
            if (waitError.message.includes("超时")) {
                await TaskService.log(taskId, "warn", "前端等待超时，任务继续在后台执行", {
                    processName: "VideoGen",
                    metadata: {note: "任务继续在后台执行"}
                });
                Message.info(t("视频生成时间较长，任务继续在后台执行，您可以在任务列表查看进度"));
            } else if (waitError.message.includes("取消")) {
                await TaskService.log(taskId, "warn", "视频生成已停止", {
                    processName: "VideoGen"
                });
                Message.info(t("视频生成已停止"));
            } else {
                const errorMsg = waitError.message || "未知错误";
                await TaskService.log(taskId, "error", `视频生成失败: ${errorMsg}`, {
                    processName: "VideoGen",
                    metadata: {
                        error: errorMsg,
                        hint: "请查看模型服务日志获取详细错误信息"
                    }
                });
                Message.error(t("视频生成失败：") + errorMsg);
            }
            isGeneratingVideo.value = false;
        }

    } catch (error) {
        console.error("生成视频失败:", error);
        if (taskId) {
            await TaskService.log(taskId, "error", `生成视频异常: ${error.message}`, {
                processName: "VideoGen",
                metadata: {error: error.toString(), stack: error.stack}
            });
        }
        Message.error(t("生成视频失败：") + (error?.message || t("未知错误")));
        isGeneratingVideo.value = false;

        // 清理定时器
        if (videoCheckInterval) {
            clearInterval(videoCheckInterval);
            videoCheckInterval = null;
        }
        if (videoCheckTimeout) {
            clearTimeout(videoCheckTimeout);
            videoCheckTimeout = null;
        }
    }
    // 🔧 GPU清理由 VideoGen.ts successFunc 统一执行（延迟2秒等待 saveWorkData 完成）
};

// 处理绿幕替换图片选择
const handleGreenScreenImageSelect = async (file: File) => {
    try {
        // 将文件保存到临时目录
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        // 获取文件扩展名
        const ext = file.name.split('.').pop() || 'png';
        const tempPath = await window.$mapi.file.temp(ext);

        // 写入临时文件
        await window.$mapi.file.writeBuffer(tempPath, uint8Array, {
            isDataPath: false,
        });

        greenScreenImagePath.value = tempPath;
        Message.success(t("图片已选择"));
    } catch (error: any) {
        console.error("保存绿幕图片失败:", error);
        Message.error(t("保存图片失败: ") + (error.message || error));
    }
};

// 自动处理视频 - 使用FFmpeg剪辑静音部分
const autoProcessVideo = async () => {
    isProcessingVideo.value = true;  // 🔧 设置处理中状态
    try {
        let result = null;  // 声明 result 变量

        // 🔧 改进：检查是否启用了自动剪气口
        if (enableSilenceRemoval.value) {
            // 🔧 改进：从settings中读取用户配置的参数
            const silenceThreshold = settings.value.silenceThreshold || -40;
            const silenceDuration = settings.value.silenceDuration || 1;
            const minPauseDuration = settings.value.minPauseDuration || 0.15;

            Message.info(t(`正在处理视频...
删除音量低于${silenceThreshold}dB且超过${silenceDuration}秒的停顿，保留${(minPauseDuration * 1000).toFixed(0)}ms的自然停顿`));

            console.log('[autoProcessVideo] 使用以下参数处理视频:', {
                silenceThreshold,
                silenceDuration,
                minPauseDuration,
                inputVideo: videoPreviewUrl.value.substring(0, 50) + "..."
            });

            // 调用后端FFmpeg处理
            result = await window.$mapi.ipAgent.processSilenceDetection({
                inputVideo: videoPreviewUrl.value,
                silenceThreshold: silenceThreshold,
                silenceDuration: silenceDuration,
                minPauseDuration: minPauseDuration
            });
        } else {
            // 🔧 未启用剪气口 - 直接使用原视频，构造假的 result 对象
            console.log('[autoProcessVideo] 未启用剪气口，跳过静音检测');
            result = {
                success: true,
                outputVideo: videoPreviewUrl.value
            };
        }

        if (result.success && result.outputVideo) {
            processedVideoUrl.value = result.outputVideo;

            if (enableSilenceRemoval.value) {
                Message.success(t("视频处理完成！") + (result.message || ""));
            } else {
                console.log('[autoProcessVideo] 跳过剪气口，直接进入后续处理');
            }

            console.log('[autoProcessVideo] 视频处理成功:', {
                outputVideo: result.outputVideo,
                message: result.message
            });

            // 【新增】混剪处理
            if (enableMixCut.value) {
                try {
                    console.log('[autoProcessVideo] 开始混剪处理');
                    const mixCutConfig = await window.$mapi.config.get('videoMixCutSettings');

                    console.log('[autoProcessVideo] 读取到的混剪配置:', {
                        configExists: !!mixCutConfig,
                        enabled: mixCutConfig?.enabled,
                        mode: mixCutConfig?.mode,
                        recordsCount: mixCutConfig?.records?.length,  // 🆕 添加 records 数量
                        fixedModeEnabled: mixCutConfig?.fixedModeConfig?.enabled,
                        keywordModeEnabled: mixCutConfig?.keywordModeConfig?.enabled,
                        keywordGroupCount: mixCutConfig?.keywordModeConfig?.groups?.length
                    });

                    if (!mixCutConfig || !mixCutConfig.enabled) {
                        console.warn('[autoProcessVideo] ⚠️ 混剪功能未启用 - 请在【设置→视频混剪】中启用混剪功能');
                        Message.warning(t('混剪功能未启用，请在设置中启用'));
                        // 不需要return，继续后续流程
                    } else {
                        Message.info(t('正在执行混剪处理...'));

                        // 导入混剪核心模块
                        const {
                            FixedModeProcessor,
                            KeywordModeProcessor,
                            SrtGenerator,
                            FFmpegCommandBuilder,
                            MaterialManager
                        } = await import('../../lib/mixCutVideo');
                        const KeywordGroupService = (await import('../../service/KeywordGroupService')).default;

                        // 获取视频时长
                        const videoDuration = await MaterialManager.getVideoDuration(result.outputVideo);
                        console.log(`[autoProcessVideo] 视频时长: ${videoDuration.toFixed(1)}秒`);

                        if (videoDuration <= 0) {
                            throw new Error('无法获取视频时长');
                        }

                        let replacements: any[] = [];

                        // 🔍 诊断日志：打印混剪配置
                        console.log('[autoProcessVideo] 混剪配置:', {
                            mode: mixCutConfig.mode,
                            fixedEnabled: mixCutConfig.fixedModeConfig?.enabled,
                            keywordEnabled: mixCutConfig.keywordModeConfig?.enabled
                        });

                        // 处理固定模式
                        if (mixCutConfig.mode === 'fixed' && mixCutConfig.fixedModeConfig.enabled) {
                            console.log('[autoProcessVideo] 使用固定模式处理');
                            console.log('[autoProcessVideo] 固定模式配置详情:', {
                                enabled: mixCutConfig.fixedModeConfig.enabled,
                                opening: {
                                    enabled: mixCutConfig.fixedModeConfig.opening?.enabled,
                                    materialFolderPath: mixCutConfig.fixedModeConfig.opening?.materialFolderPath
                                },
                                middle: {
                                    enabled: mixCutConfig.fixedModeConfig.middle?.enabled,
                                    materialFolderPath: mixCutConfig.fixedModeConfig.middle?.materialFolderPath
                                },
                                ending: {
                                    enabled: mixCutConfig.fixedModeConfig.ending?.enabled,
                                    materialFolderPath: mixCutConfig.fixedModeConfig.ending?.materialFolderPath
                                }
                            });

                            const fixedReplacements = await FixedModeProcessor.process(
                                result.outputVideo,
                                mixCutConfig.fixedModeConfig,
                                videoDuration
                            );

                            console.log('[autoProcessVideo] 固定模式生成 ' + fixedReplacements.length + ' 个替换点');
                            replacements.push(...fixedReplacements);
                        } else if (mixCutConfig.mode === 'fixed') {
                            console.warn('[autoProcessVideo] 固定模式未启用:', {
                                mode: mixCutConfig.mode,
                                fixedModeEnabled: mixCutConfig.fixedModeConfig?.enabled
                            });
                        }

                        // 🔧 新增：处理关键词模式
                        if (mixCutConfig.mode === 'keyword' && mixCutConfig.keywordModeConfig.enabled) {
                            console.log('[autoProcessVideo] 使用关键词模式处理');

                            // 🆕 优先使用 localStorage 中的最新数据，避免使用配置文件中的旧数据
                            let subtitleFilePath = mixCutConfig.subtitleFilePath;
                            let records = null;

                            console.log('[autoProcessVideo] 尝试从缓存文件加载最新字幕数据');
                            try {
                                const cachedRecords = await window.$mapi.file.read("cache-subtitle-records.json");
                                if (cachedRecords) {
                                    records = JSON.parse(cachedRecords);
                                    console.log('[autoProcessVideo] ✅ 从缓存文件加载了', records.length, '条字幕记录（最新）');
                                }
                            } catch (error) {
                                console.error('[autoProcessVideo] 从缓存文件加载失败:', error);
                            }

                            // 如果缓存文件没有，才使用配置文件中的 records
                            if (!records || records.length === 0) {
                                console.log('[autoProcessVideo] 缓存文件无数据，尝试从配置文件加载');
                                records = mixCutConfig.records;
                                if (records && records.length > 0) {
                                    console.log('[autoProcessVideo] 从配置文件加载了', records.length, '条字幕记录');
                                }
                            }

                            // 如果仍然没有 records，才生成 SRT
                            if ((!records || records.length === 0) && !subtitleFilePath) {
                                console.log('[autoProcessVideo] 无 records 且无字幕文件，开始自动生成 SRT...');
                                Message.info(t('正在生成字幕...'));
                                try {
                                    subtitleFilePath = await SrtGenerator.generateFromVideo(result.outputVideo);
                                    console.log('[autoProcessVideo] ✅ SRT 字幕自动生成成功:', subtitleFilePath);
                                    Message.success(t('字幕生成完成'));
                                } catch (error: any) {
                                    console.error('[autoProcessVideo] ❌ SRT 字幕生成失败:', error);
                                    throw new Error(`关键词模式需要字幕数据，但自动生成失败: ${error.message}`);
                                }
                            } else if (records && records.length > 0) {
                                console.log('[autoProcessVideo] 使用 records 数据，共', records.length, '条记录');
                            } else {
                                console.log('[autoProcessVideo] 使用已提供的字幕文件:', subtitleFilePath);
                            }

                            // 获取关键词分组数据
                            const keywordGroups = await KeywordGroupService.getAllGroups();
                            console.log('[autoProcessVideo] 获取到 ' + keywordGroups.length + ' 个关键词分组');

                            // 🆕 检查 records 数据是否与当前视频匹配
                            if (records && records.length > 0) {
                                const lastRecord = records[records.length - 1];
                                const recordsEndTime = lastRecord.end / 1000; // 毫秒 -> 秒
                                const timeDifference = Math.abs(videoDuration - recordsEndTime);

                                console.log('[autoProcessVideo] 字幕数据检查:', {
                                    videoDuration: videoDuration.toFixed(2),
                                    recordsEndTime: recordsEndTime.toFixed(2),
                                    timeDifference: timeDifference.toFixed(2),
                                    recordsCount: records.length
                                });

                                // 如果时间差超过 5 秒，可能是旧数据
                                if (timeDifference > 5) {
                                    console.warn('[autoProcessVideo] ⚠️ 警告：字幕数据与视频时长不匹配，可能是旧数据');
                                    Message.warning(t('检测到字幕数据可能不匹配当前视频，建议重新生成字幕'));
                                }
                            }

                            // 🆕 根据数据来源选择处理方法
                            let keywordReplacements: any[];
                            if (records && records.length > 0) {
                                // 优先使用 records 数据
                                console.log('[autoProcessVideo] 使用 records 数据处理关键词模式');
                                keywordReplacements = await KeywordModeProcessor.processFromRecords(
                                    records,
                                    mixCutConfig.keywordModeConfig,
                                    keywordGroups
                                );
                            } else {
                                // 回退到 SRT 文件
                                console.log('[autoProcessVideo] 使用 SRT 文件处理关键词模式');
                                keywordReplacements = await KeywordModeProcessor.process(
                                    subtitleFilePath,
                                    mixCutConfig.keywordModeConfig,
                                    keywordGroups
                                );
                            }

                            console.log('[autoProcessVideo] 关键词模式生成 ' + keywordReplacements.length + ' 个替换点');
                            replacements.push(...keywordReplacements);
                        }

                        // 🆕 新增：处理字幕模式
                        if (mixCutConfig.mode === 'subtitle' && mixCutConfig.subtitleModeConfig?.enabled) {
                            console.log('[autoProcessVideo] 使用字幕模式处理');

                            // 从步骤2获取records数据
                            let records = mixCutConfig.records;
                            if (!records || records.length === 0) {
                                console.log('[autoProcessVideo] 配置中无records，尝试从缓存文件加载');

                                try {
                                    const cachedRecords = await window.$mapi.file.read("cache-subtitle-records.json");
                                    if (cachedRecords) {
                                        records = JSON.parse(cachedRecords);
                                        console.log('[autoProcessVideo] 从缓存文件加载了', records.length, '条字幕');
                                    }
                                } catch (error) {
                                    console.error('[autoProcessVideo] 从缓存文件加载失败:', error);
                                }

                                // 如果缓存文件也没有，再尝试从任务记录加载
                                if (!records || records.length === 0) {
                                    console.log('[autoProcessVideo] 缓存文件也无records，尝试从任务记录加载');
                                    try {
                                        const tasks = await TaskService.list('VideoGen', 1);
                                        const successTasks = tasks.filter(t => t.status === 'success');
                                        if (successTasks.length > 0) {
                                            const latestTask = successTasks.sort((a, b) =>
                                                (b.endTime || 0) - (a.endTime || 0)
                                            )[0];
                                            if (latestTask.result?.records) {
                                                records = latestTask.result.records;
                                                console.log('[autoProcessVideo] 从任务记录加载了', records.length, '条字幕');
                                            }
                                        }
                                    } catch (error) {
                                        console.error('[autoProcessVideo] 加载records失败:', error);
                                    }
                                }
                            }

                            if (!records || records.length === 0) {
                                throw new Error('字幕模式需要ASR识别结果，但未找到数据。请先生成口播视频。');
                            }

                            // 导入字幕模式处理器
                            const {SubtitleModeProcessor} = await import('../../lib/mixCutVideo');

                            // 🔧 修复：从 records 中提取字幕文本作为 scriptLines
                            // 字幕模式下，scriptLines 应该是 ASR 识别的字幕文本数组
                            const scriptLines = records.map(r => r.text);
                            console.log('[autoProcessVideo] 字幕模式 scriptLines:', {
                                count: scriptLines.length,
                                sample: scriptLines.slice(0, 3)
                            });

                            const subtitleReplacements = await SubtitleModeProcessor.process(
                                records,
                                mixCutConfig.subtitleModeConfig,
                                scriptLines  // 传递字幕文本数组
                            );

                            console.log('[autoProcessVideo] 字幕模式生成 ' + subtitleReplacements.length + ' 个替换点');
                            replacements.push(...subtitleReplacements);
                        }

                        if (replacements.length === 0) {
                            console.log('[autoProcessVideo] 没有检测到替换点，跳过混剪');
                            Message.info(t('未检测到任何替换点，跳过混剪'));
                        } else {
                            // 生成输出路径
                            const outputPath = await window.$mapi.file.temp('mp4', 'mixed_');

                            // 🔧 修复：从实际视频文件读取分辨率，而不是硬编码 1920x1080
                            let videoResolution = {width: 1920, height: 1080};
                            try {
                                const videoInfo = await ffprobeVideoInfo(result.outputVideo);
                                videoResolution = {width: videoInfo.width, height: videoInfo.height};
                                console.log('[autoProcessVideo] 读取到实际视频分辨率:', videoResolution);
                            } catch (error) {
                                console.warn('[autoProcessVideo] 获取视频分辨率失败，使用默认值 1920x1080:', error);
                            }

                            console.log('[autoProcessVideo] 开始执行混剪处理');

                            // 通过后端API执行混剪
                            const mixCutResult = await window.$mapi.ipAgent.processVideoMixCut({
                                inputVideo: result.outputVideo,
                                replacements: replacements,
                                outputPath: outputPath,
                                videoResolution: videoResolution,
                                videoDuration: videoDuration,
                                displayMode: mixCutConfig.displayMode || 'pip'
                            });

                            if (mixCutResult && mixCutResult.success && mixCutResult.outputVideo) {
                                // 更新视频预览URL
                                processedVideoUrl.value = mixCutResult.outputVideo;
                                console.log('[autoProcessVideo] 混剪处理完成:', mixCutResult.outputVideo);
                                Message.success(t('混剪处理完成！'));
                            } else {
                                throw new Error(mixCutResult?.message || '混剪处理失败');
                            }
                        }
                    }
                } catch (error: any) {
                    console.error('[autoProcessVideo] 混剪处理失败:', error);
                    Message.error(t('混剪处理失败：') + (error?.message || error));
                }
            }

            // 【新增】绿幕替换处理
            if (enableGreenScreen.value) {
                if (!greenScreenImagePath.value) {
                    Message.warning(t('已启用绿幕切换但未上传替换图片，跳过绿幕处理'));
                    console.warn('[autoProcessVideo] 绿幕切换已启用但未上传替换图片');
                } else {
                    try {
                        console.log('[autoProcessVideo] 开始绿幕替换处理:', {
                            inputVideo: processedVideoUrl.value,
                            backgroundImage: greenScreenImagePath.value
                        });
                        Message.info(t('正在执行绿幕替换...'));

                        const greenScreenResult = await window.$mapi.ipAgent.processGreenScreen({
                            inputVideo: processedVideoUrl.value,
                            backgroundImage: greenScreenImagePath.value
                        });

                        if (greenScreenResult && greenScreenResult.success && greenScreenResult.outputVideo) {
                            processedVideoUrl.value = greenScreenResult.outputVideo;
                            console.log('[autoProcessVideo] 绿幕替换完成:', greenScreenResult.outputVideo);
                            Message.success(t('绿幕替换完成！'));
                        } else {
                            throw new Error(greenScreenResult?.message || '绿幕替换失败');
                        }
                    } catch (error: any) {
                        console.error('[autoProcessVideo] 绿幕替换失败:', error);
                        Message.error(t('绿幕替换失败：') + (error?.message || error));
                    }
                }
            }
        } else {
            Message.error(result.message || t("视频处理失败"));
            console.error('[autoProcessVideo] 处理失败:', result);
        }
    } catch (error) {
        console.error('[autoProcessVideo] 处理视频失败:', error);
        Message.error(t("处理视频失败：") + (error?.message || t("未知错误")));
    } finally {
        isProcessingVideo.value = false;
    }
};


// FUNASR字幕生成
const generateFunasrSubtitle = async () => {
    if (!videoPreviewUrl.value) {
        Message.error(t("请先生成视频"));
        return;
    }

    funasrGenerating.value = true;
    try {
        const result = await window.$mapi.ipAgent.generateFunasrSubtitle({
            videoPath: videoPreviewUrl.value.replace('file://', ''),
            language: funasrLanguage.value,
            maxCharsPerLine: 20
        });

        if (result.success) {
            srtFile.value = result.srtPath;
            funasrSegments.value = result.segments;
            Message.success(t("FUNASR字幕生成成功"));
        } else {
            Message.error(result.message || t("FUNASR字幕生成失败"));
        }
    } catch (error: any) {
        Message.error(t("FUNASR字幕生成失败: ") + (error.message || error));
    } finally {
        funasrGenerating.value = false;
    }
};

// 新版字幕生成（使用ZimuShengcheng服务）
const selectSrtFile = async () => {
    const file = await window.$mapi.file.open({
        title: t("选择SRT字幕文件"),
        filters: [
            {
                name: t("字幕文件"),
                extensions: ["srt", "vtt"],
            },
        ],
    });

    if (file) {
        srtFile.value = file;
    }
};

// 识别关键词
const extractKeywords = async (silent: boolean = false) => {
    // 检查是否有文本可用：优先使用SRT文件，其次使用自定义文本，最后使用原始脚本
    if (!srtFile.value && !customText.value && !scriptContent.value) {
        if (!silent) {
            Message.error(t("请先输入文案、生成字幕或上传自定义文本"));
        }
        return;
    }

    // 获取字幕文本
    let subtitleText = '';
    if (srtFile.value) {
        try {
            const content = await window.$mapi.file.read(srtFile.value, {isDataPath: false});
            // 从SRT中提取纯文本
            subtitleText = content.replace(/\d+\n/g, '').replace(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/g, '');
        } catch (error) {
            if (!silent) {
                Message.error(t("读取字幕文件失败"));
            }
            return;
        }
    } else if (customText.value) {
        subtitleText = customText.value;
    } else {
        // 使用原始脚本作为最后的备选方案
        subtitleText = scriptContent.value;
    }

    keywordsExtracting.value = true;
    try {
        const modelConfig = {
            providerId: settings.value.textModelKey?.split('|')[0] || 'openai',
            modelId: settings.value.textModelKey?.split('|')[1] || 'gpt-3.5-turbo',
            apiUrl: 'https://api.openai.com/v1/chat/completions',
            apiKey: process.env.OPENAI_API_KEY || ''
        };

        const result = await window.$mapi.ipAgent.extractKeywords({
            subtitleText,
            modelConfig
        });

        if (result.success) {
            extractedKeywords.value = result.keywords || [];
            if (!silent) {
                if (result.degraded) {
                    Message.warning(result.message || t("关键词识别超时，已跳过关键词特效"));
                } else {
                    Message.success(t(`识别到 ${(result.keywords || []).length} 个关键词`));
                }
            }
        } else {
            if (!silent) {
                Message.error(result.message || t("关键词识别失败"));
            }
        }
    } catch (error: any) {
        if (!silent) {
            Message.error(t("关键词识别失败: ") + (error.message || error));
        }
    } finally {
        keywordsExtracting.value = false;
    }
};

// 处理关键词标记变化
const onMarkersChange = (markers: any[]) => {
    keywordMarkers.value = markers;
};

// 处理关键词分组变化（来自KeywordGroupManager组件）
const onKeywordGroupsChange = (groups: any[]) => {
    console.log('[onKeywordGroupsChange] 被调用:', {
        groupsCount: groups?.length || 0,
        groups: groups?.map(g => ({name: g.name, id: g.id, hasStyle: !!g.styleOverride})),
        currentGroupsCount: keywordGroups.value?.length || 0,
        stackTrace: new Error().stack?.split('\n')[1]?.trim()
    });
    keywordGroups.value = groups;
    console.log('[onKeywordGroupsChange] keywordGroups.value已更新');

    // 检查是否有任何分组设置了样式，如果有则自动启用关键词特效
    const hasGroupsWithStyles = groups && groups.some((group: any) =>
        group.styleOverride && (group.styleOverride.fontColor || group.styleOverride.fontSize)
    );

    if (hasGroupsWithStyles) {
        console.log('[onKeywordGroupsChange] 检测到分组有样式设置，自动启用关键词特效');
        enableKeywordEffects.value = true;
    }

    // 保存到数据库（主要存储）
    KeywordGroupService.saveGroups(groups)
        .then(async result => {
            if (result.success) {
                console.log('[onKeywordGroupsChange] ✓ 分组已保存到数据库');

                // 🆕 关键修复：从数据库重新加载数据，刷新内存缓存
                try {
                    console.log('[onKeywordGroupsChange] 🔄 从数据库重新加载数据到内存缓存...');
                    const freshGroups = await KeywordGroupService.getAllGroups();

                    // 更新 SmartSubtitleService 的内存缓存
                    const {loadKeywordGroupsFromJSON} = await import('../../service/SmartSubtitleService');
                    loadKeywordGroupsFromJSON(JSON.stringify(freshGroups));

                    console.log('[onKeywordGroupsChange] ✅ 内存缓存已刷新，数量:', freshGroups.length);
                } catch (error) {
                    console.error('[onKeywordGroupsChange] ❌ 刷新内存缓存失败:', error);
                }
            } else {
                console.warn('[onKeywordGroupsChange] ⚠️ 保存到数据库失败，failedCount:', result.failedCount);
            }
        })
        .catch(error => {
            console.error('[onKeywordGroupsChange] ❌ 保存到数据库出错:', error);
        });

    // 同时保存到本地存储作为备份
    try {
        localStorage.setItem('zhenqianba_keyword_groups', JSON.stringify(groups));
    } catch (e) {
        console.error('[onKeywordGroupsChange] 保存到localStorage失败:', e);
    }

    // 重要：不要调用 classifyGeneratedKeywords()，因为现在关键词直接从 keywordGroups 读取
};

// 分类生成的关键词
const classifyGeneratedKeywords = () => {
    // 重置分类
    classifiedKeywords.value = {
        '重点词/成语词': [],
        '描述词': [],
        '行动词': [],
        '情感词': []
    };

    if (!generatedKeywords.value.trim()) {
        return;
    }

    const keywords = generatedKeywords.value.split('\n').filter(k => k.trim());

    // 创建关键词到分组名称的映射
    const keywordToGroupMap: { [keyword: string]: string } = {};
    keywordGroups.value.forEach(group => {
        const groupName = group.name;
        if (group.keywords && Array.isArray(group.keywords)) {
            group.keywords.forEach((kw: any) => {
                const keyword = typeof kw === 'string' ? kw : kw.keyword;
                if (keyword) {
                    keywordToGroupMap[keyword] = groupName;
                }
            });
        }
    });

    // 按照分组名称分类关键词
    keywords.forEach(keyword => {
        const groupName = keywordToGroupMap[keyword];
        if (groupName && classifiedKeywords.value[groupName]) {
            classifiedKeywords.value[groupName].push(keyword);
        }
    });
};

// 新增：直接从分组中获取关键词
const getGroupKeywords = (groupName: string): string[] => {
    console.log(`[getGroupKeywords] 查找分组: "${groupName}" (字符长度: ${groupName.length})`);

    // 🔴 关键修复：检查keywordGroups是否已初始化
    if (!keywordGroups.value || keywordGroups.value.length === 0) {
        // 🔧 防止死循环：只在首次尝试初始化
        if (!keywordGroupsInitializeAttempted) {
            console.warn(`[getGroupKeywords] ⚠️ keywordGroups未初始化 (长度: ${keywordGroups.value?.length || 0})，尝试触发初始化...`);
            keywordGroupsInitializeAttempted = true;

            // 尝试从localStorage加载
            initializeKeywordGroups();

            // 再次检查
            if (!keywordGroups.value || keywordGroups.value.length === 0) {
                console.error(`[getGroupKeywords] ❌ 初始化后keywordGroups仍然为空，无法查找分组 "${groupName}"`);
                return [];
            }
        } else {
            // 已经尝试过初始化但仍然为空，直接返回空数组避免死循环
            console.warn(`[getGroupKeywords] ⚠️ 已尝试过初始化但keywordGroups仍为空，返回空数组避免死循环`);
            return [];
        }
    }

    console.log(`[getGroupKeywords] 当前keywordGroups.value:`, {
        isArray: Array.isArray(keywordGroups.value),
        length: keywordGroups.value?.length || 0,
        groups: keywordGroups.value?.map(g => ({
            name: g.name,
            nameLength: g.name?.length || 0,
            nameCharCode: g.name?.split('').map(c => c.charCodeAt(0)),
            id: g.id,
            keywordsCount: g.keywords?.length || 0
        }))
    });

    // 使用多种方式查找分组
    let group = keywordGroups.value.find(g => g.name === groupName);

    // 如果精确匹配失败，尝试trim后匹配
    if (!group) {
        console.log(`[getGroupKeywords] 精确匹配失败，尝试trim匹配`);
        group = keywordGroups.value.find(g => g.name.trim() === groupName.trim());
    }

    // 如果还是失败，尝试包含匹配
    if (!group) {
        console.log(`[getGroupKeywords] trim匹配失败，尝试包含匹配`);
        group = keywordGroups.value.find(g => g.name.includes(groupName) || groupName.includes(g.name));
    }

    if (!group) {
        console.error(`[getGroupKeywords] ❌ 找不到分组: ${groupName}`);
        console.error(`[getGroupKeywords] 查找目标字符编码:`, groupName.split('').map(c => `${c}(${c.charCodeAt(0)})`));
        console.error(`[getGroupKeywords] 可用的分组名称:`, keywordGroups.value?.map(g => ({
            name: g.name,
            charCodes: g.name?.split('').map(c => `${c}(${c.charCodeAt(0)})`)
        })));
        return [];
    }

    const keywords = group.keywords || [];
    const result = keywords.map((k: any) => k.keyword || k);
    console.log(`[getGroupKeywords] ✅ 分组 "${groupName}" 找到 ${keywords.length} 个关键词:`, result);
    return result;
};

// 新增：直接在分组中更新关键词
const updateGroupKeywords = (groupName: string, text: string) => {
    console.log(`[updateGroupKeywords] 更新分组 "${groupName}"`, {
        inputText: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
        keywordGroupsCount: keywordGroups.value.length
    });

    // 将文本分割成关键词数组，过滤掉空行
    const keywords = text.split('\n').map(k => k.trim()).filter(k => k);

    // 找到对应的分组
    let group = keywordGroups.value.find(g => g.name === groupName);
    if (!group) {
        // 🔴 关键修复：分组不存在时自动创建，而不是静默失败
        console.warn(`[updateGroupKeywords] 找不到分组: ${groupName}，自动创建`);
        const systemGroupConfigs: { [key: string]: { description: string, color: string } } = {
            '重点词/成语词': {description: '视频中的重点词汇和成语', color: '#FF6B6B'},
            '行动词': {description: '需要强调的行动动词', color: '#4ECDC4'},
            '描述词': {description: '描述性的形容词和副词', color: '#45B7D1'},
            '情感词': {description: '表达情感的词汇', color: '#F7DC6F'}
        };
        const config = systemGroupConfigs[groupName] || {description: groupName, color: '#999999'};
        group = {
            id: `group_${groupName.replace(/\//g, '_')}`,
            name: groupName,
            description: config.description,
            color: config.color,
            keywords: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        keywordGroups.value.push(group);
        console.log(`[updateGroupKeywords] ✅ 已自动创建分组: ${groupName}，id: ${group.id}`);
    }

    // 直接更新分组中的关键词
    group.keywords = keywords.map(keyword => ({
        keyword: keyword,
        enabled: true
    }));

    console.log(`[updateGroupKeywords] 分组 "${groupName}" 更新后的关键词:`, group.keywords);

    // 🔴 关键修复：保存到数据库（主要存储）
    console.log(`[updateGroupKeywords] 准备保存到数据库...`);
    KeywordGroupService.saveGroup(group)
        .then(result => {
            if (result.success) {
                console.log(`[updateGroupKeywords] ✅ 分组 "${groupName}" 已保存到数据库，ID:`, result.id);
            } else {
                console.error(`[updateGroupKeywords] ❌ 保存到数据库失败:`, result.message);
            }
        })
        .catch(error => {
            console.error(`[updateGroupKeywords] ❌ 保存到数据库出错:`, error);
        });

    // 同时保存到本地存储作为备份
    try {
        localStorage.setItem('zhenqianba_keyword_groups', JSON.stringify(keywordGroups.value));
        console.log(`[updateGroupKeywords] ✅ 分组 "${groupName}" 已   存到localStorage`);
    } catch (error) {
        console.error(`[updateGroupKeywords] ❌ 保存到localStorage出错:`, error);
    }

    // 🔴 关键：强制触发响应式更新 - 创建新数组引用
    keywordGroups.value = [...keywordGroups.value];

    // 🔴 关键修复：触发分组变化事件，通知 KeywordGroupManager 组件刷新
    onKeywordGroupsChange(keywordGroups.value);

    // 🔴 关键修复：立即刷新 KeywordGroupManager 组件UI
    nextTick(() => {
        if (keywordGroupManagerRef.value && keywordGroupManagerRef.value.loadGroups) {
            console.log(`[updateGroupKeywords] 🔄 刷新 KeywordGroupManager 组件UI`);
            keywordGroupManagerRef.value.loadGroups(keywordGroups.value);
        } else {
            console.warn(`[updateGroupKeywords] ⚠️ keywordGroupManagerRef未找到或没有loadGroups方法`);
        }
    });

    console.log(`[updateGroupKeywords] ✅ 分组 "${groupName}" 更新完成，已保存并刷新UI`);
};

// 一键清空所有分类关键词
const clearCurrentKeywords = () => {
    const totalCount = keywordTabOptions.reduce((sum, tab) => sum + getGroupKeywords(tab.value).length, 0);
    if (totalCount === 0) return;
    Dialog.confirm(t('确定要清空所有分类的关键词吗？此操作无法撤销！'), t('确认清空')).then(() => {
        keywordTabOptions.forEach(tab => {
            groupKeywordTexts.value[tab.value] = '';
            updateGroupKeywords(tab.value, '');
        });
    }).catch(() => {
    });
};

// 新增：处理关键词输入框的变化
const handleGroupKeywordChange = (groupName: string, event?: Event) => {
    const value = event ? (event.target as HTMLTextAreaElement).value : groupKeywordTexts.value[groupName];

    console.log(`[handleGroupKeywordChange] 处理分组 "${groupName}" 的文本变化:`, {
        value: value.substring(0, 100) + (value.length > 100 ? '...' : ''),
        length: value.length
    });

    // 使用现有的updateGroupKeywords函数处理
    updateGroupKeywords(groupName, value);

    // 更新响应式数据
    groupKeywordTexts.value[groupName] = value;

    // 【修复】同步更新到KeywordGroupManager组件
    nextTick(() => {
        if (keywordGroupManagerRef.value && keywordGroupManagerRef.value.loadGroups) {
            keywordGroupManagerRef.value.loadGroups(keywordGroups.value);
            console.log(`[handleGroupKeywordChange] 已同步到KeywordGroupManager组件`);
        }
    });
};

// 新增：初始化关键词输入框的文本
const initializeGroupKeywordTexts = () => {
    console.log('[initializeGroupKeywordTexts] 初始化关键词输入框文本');

    keywordTabOptions.forEach(tab => {
        const keywords = getGroupKeywords(tab.value);
        groupKeywordTexts.value[tab.value] = keywords.join('\n');
        console.log(`[initializeGroupKeywordTexts] 分组 "${tab.value}": ${keywords.length} 个关键词`);
    });
};

// 更新某个分类页签的关键词（保留旧函数兼容性）
const updateTabKeywords = (tabValue: string, text: string) => {
    updateGroupKeywords(tabValue, text);
};

// 新增函数：将编辑框中的关键词同步到对应的分组
const syncKeywordsToGroup = (groupName: string, keywords: string[]) => {
    // 找到对应的分组
    const group = keywordGroups.value.find(g => g.name === groupName);
    if (!group) {
        console.warn(`找不到分组: ${groupName}`);
        return;
    }

    // 获取现有关键词列表
    const existingKeywords = new Set(group.keywords.map((k: any) => k.keyword));

    // 找出需要添加的新关键词
    const newKeywords = keywords.filter(k => !existingKeywords.has(k));

    // 添加新关键词到分组
    newKeywords.forEach(keyword => {
        group.keywords.push({
            keyword: keyword,
            enabled: true
        });
    });

    // 找出需要删除的关键词（编辑框中删除的）
    const keywordsSet = new Set(keywords);
    group.keywords = group.keywords.filter((k: any) => keywordsSet.has(k.keyword));

    // 触发分组变化事件，保存到本地存储
    onKeywordGroupsChange(keywordGroups.value);

    // 重要：强制刷新KeywordGroupManager组件，使其UI立即显示更新
    nextTick(() => {
        if (keywordGroupManagerRef.value && keywordGroupManagerRef.value.loadGroups) {
            keywordGroupManagerRef.value.loadGroups(keywordGroups.value);
        }
    });

    console.log(`已同步分组 "${groupName}" 的关键词:`, keywords);
};

// 更新 generatedKeywords（同步所有分类的关键词）
const updateGeneratedKeywords = () => {
    const allKeywords: string[] = [];
    Object.values(classifiedKeywords.value).forEach(keywords => {
        allKeywords.push(...keywords);
    });

    // 设置标志，表示这是内部更新，避免触发重新分类
    isUpdatingKeywords.value = true;
    generatedKeywords.value = allKeywords.join('\n');
    // 使用 nextTick 确保 watch 已经执行完毕再重置标志
    nextTick(() => {
        isUpdatingKeywords.value = false;
    });
};

// 监听 generatedKeywords 变化 - 仅当外部更改时才重新分类
watch(generatedKeywords, () => {
    // 如果是内部更新，则跳过重新分类
    if (isUpdatingKeywords.value) {
        return;
    }
    // 外部更改时才重新分类
    classifyGeneratedKeywords();
});

// 添加watch监听keywordGroups变化 - 【优化】移除deep:true和immediate:true
// 改为浅层监听，仅在长度改变时才响应
watch(
    () => keywordGroups.value?.length || 0,  // 只监听长度，不监听内部属性
    (newLength, oldLength) => {
        console.log('[watch keywordGroups.length] 长度变化:', {newLength, oldLength});

        // 仅当长度变化时才同步到输入框
        if (newLength > 0) {
            console.log('[watch keywordGroups] 同步keywordGroups到输入框');
            nextTick(() => {
                initializeGroupKeywordTexts();
            });
        }
    }
    // 移除 { deep: true, immediate: true } - 不在初始化时触发，避免级联更新
);

// 保存字幕模板列表到本地存储
const saveSubtitleTemplates = () => {
    try {
        // 🆕 关键修复：只保存用户模板和复刻模板，不保存系统模板副本
        // 系统模板始终从硬编码的 SYSTEM_TEMPLATES 加载，无需持久化
        const userOnlyTemplates = subtitleTemplates.value.filter((t: any) => !isSystemTemplate(t.id) && t.isSystem !== true);
        console.log('[saveSubtitleTemplates] 保存', userOnlyTemplates.length, '个用户/复刻模板到localStorage');
        localStorage.setItem(SUBTITLE_TEMPLATES_STORAGE_KEY, JSON.stringify(userOnlyTemplates));
    } catch (e) {
        console.warn('保存字幕模板失败:', e);
    }
};

// 复刻模板
const cloneTemplate = async (templateId: string) => {
    try {
        const sourceTemplate = subtitleTemplates.value.find(t => t.id === templateId);
        if (!sourceTemplate) {
            Message.error(t('找不到源模板'));
            return;
        }

        console.log('[cloneTemplate] 开始复制模板:', templateId);
        Message.loading({content: '正在复制模板...', duration: 0, id: 'clone'});

        const newId = await duplicateSubtitleTemplate(templateId);

        console.log('[cloneTemplate] 复制成功，新模板ID:', newId);

        await loadSubtitleTemplates();

        if (newId) {
            selectedSubtitleTemplate.value = newId;
            await handleTemplateChange(newId);

            nextTick(() => {
                isEditingSubtitleTemplate.value = true;
                editingTemplateId.value = newId;
            });
        }

        Message.success(t('模板复制成功'));
    } catch (error) {
        console.error('复制模板失败:', error);
        Message.error(t('复制模板失败: ') + (error as Error).message);
    } finally {
        Message.clear('clone');
    }
};

// ==================== 字幕模板管理 ====================

// 模板选择下拉框选项
const templateSelectOptions = computed(() => {
    return subtitleTemplates.value.map(t => ({
        value: t.id,
        label: t.name
    }));
});

const FORMAL_INLINE_SYSTEM_TEMPLATE_IDS = new Set([
    'template_system_11',
    'template_system_22',
    'template_system_33',
    'template_system_44',
    'template_system_55',
    'template_system_66',
    'template_system_77',
    'template_system_88',
]);

const mergeSystemKeywordGroupsStyles = (templateId: string, bundledStyles: any, dbStyles: any) => {
    if (!Array.isArray(dbStyles)) {
        return bundledStyles;
    }

    if (!Array.isArray(bundledStyles)) {
        return dbStyles;
    }

    const mergedStyles = bundledStyles.map((bundledStyle: any, index: number) => {
        const dbStyle = dbStyles[index];
        if (!dbStyle) {
            return bundledStyle;
        }

        const mergedStyle = {
            ...bundledStyle,
            ...dbStyle,
        };

        if (FORMAL_INLINE_SYSTEM_TEMPLATE_IDS.has(templateId)) {
            if (Object.prototype.hasOwnProperty.call(bundledStyle, 'soundEffectId')) {
                mergedStyle.soundEffectId = bundledStyle.soundEffectId ?? null;
            }
            if (Object.prototype.hasOwnProperty.call(bundledStyle, 'soundEffectConfig')) {
                mergedStyle.soundEffectConfig = bundledStyle.soundEffectConfig ?? null;
            }
        }

        return mergedStyle;
    });

    if (dbStyles.length > bundledStyles.length) {
        mergedStyles.push(...dbStyles.slice(bundledStyles.length));
    }

    return mergedStyles;
};

// 从本地存储加载模板列表（合并系统内置模板）
const loadSubtitleTemplates = async () => {
    try {
        // 1. 首先加载用户自定义模板（从localStorage）
        let userTemplates: any[] = [];
        const stored = localStorage.getItem(SUBTITLE_TEMPLATES_STORAGE_KEY);
        if (stored) {
            try {
                const loadedTemplates = JSON.parse(stored);
                // 过滤掉旧的系统模板（避免重复）
                // 🆕 关键修复：只保留 isSystem !== true 或 ID 不在系统模板列表中的模板
                userTemplates = loadedTemplates.filter((t: any) => !isSystemTemplate(t.id) && t.isSystem !== true);
                console.log('[loadSubtitleTemplates] 从localStorage加载用户模板:', userTemplates.length, '个', {
                    templates: userTemplates.map(t => ({id: t.id, name: t.name, isSystem: t.isSystem}))
                });
            } catch (e) {
                console.warn('[loadSubtitleTemplates] 解析localStorage失败:', e);
                userTemplates = [];
            }
        }

        // 2. 系统模板策略：优先使用硬编码模板，确保首次启动立即显示8个
        // 数据库模板作为异步增强（可能包含用户修改）
        let systemTemplates: any[] = JSON.parse(JSON.stringify(SYSTEM_TEMPLATES));
        console.log('[loadSubtitleTemplates] ✅ 首先加载硬编码系统模板:', systemTemplates.length, '个');

        // 从数据库获取模板（系统模板 + 用户模板）
        try {
            const result = await window.$mapi.ipAgent.getSubtitleTemplates({metadataOnly: false});
            if (result && result.success && result.templates && result.templates.length > 0) {
                const dbSystemTemplates = result.templates.filter((t: any) => t.is_system === 1);
                const dbSystemTemplateMap = new Map<string, any>();
                for (const rawTemplate of dbSystemTemplates) {
                    const normalizedTemplate = {...rawTemplate};
                    if (typeof normalizedTemplate.config === 'string') {
                        try {
                            normalizedTemplate.config = JSON.parse(normalizedTemplate.config);
                        } catch (error) {
                            console.warn('[loadSubtitleTemplates] Failed to parse db system template config:', normalizedTemplate.id, error);
                            normalizedTemplate.config = {};
                        }
                    }
                    dbSystemTemplateMap.set(normalizedTemplate.id, normalizedTemplate);
                }

                const bundledSystemTemplateIds = new Set(SYSTEM_TEMPLATES.map((template: any) => template.id));
                systemTemplates = SYSTEM_TEMPLATES.map((bundledTemplate: any) => {
                    const dbTemplate = dbSystemTemplateMap.get(bundledTemplate.id);
                    if (!dbTemplate) {
                        return bundledTemplate;
                    }

                    const bundledConfig = bundledTemplate.config || {};
                    const dbConfig = dbTemplate.config || {};
                    const bundledPreviewConfig = bundledConfig.previewConfig || {};
                    const dbPreviewConfig = dbConfig.previewConfig || {};
                    const mergedPreviewConfig = {
                        ...bundledPreviewConfig,
                        ...dbPreviewConfig,
                        backgroundImage: bundledPreviewConfig.backgroundImage || dbPreviewConfig.backgroundImage,
                        backgroundKey: bundledPreviewConfig.backgroundKey || dbPreviewConfig.backgroundKey,
                    };

                    return {
                        ...bundledTemplate,
                        ...dbTemplate,
                        name: dbTemplate.name ?? bundledTemplate.name,
                        description: dbTemplate.description ?? bundledTemplate.description,
                        isSystem: true,
                        is_system: 1,
                        readonly: dbTemplate.readonly ?? bundledTemplate.readonly,
                        config: {
                            ...bundledConfig,
                            ...dbConfig,
                            subtitleStyle: dbConfig.subtitleStyle ?? bundledConfig.subtitleStyle,
                            titleSubtitleConfig: dbConfig.titleSubtitleConfig ?? bundledConfig.titleSubtitleConfig,
                            keywordGroupsStyles: mergeSystemKeywordGroupsStyles(
                                bundledTemplate.id,
                                bundledConfig.keywordGroupsStyles,
                                dbConfig.keywordGroupsStyles
                            ),
                            previewConfig: mergedPreviewConfig
                        }
                    };
                });

                const extraSystemTemplates = Array.from(dbSystemTemplateMap.values())
                    .filter((template: any) => !bundledSystemTemplateIds.has(template.id))
                    .map((template: any) => ({
                        ...template,
                        isSystem: true,
                        is_system: 1,
                        config: template.config || {}
                    }));

                if (extraSystemTemplates.length > 0) {
                    systemTemplates.push(...extraSystemTemplates);
                }

                console.log('[loadSubtitleTemplates] Using merged system templates:', {
                    bundledCount: SYSTEM_TEMPLATES.length,
                    dbCount: dbSystemTemplates.length,
                    mergedCount: systemTemplates.length,
                    extraCount: extraSystemTemplates.length
                });

                const dbUserTemplates = result.templates.filter((t: any) => t.is_system !== 1);
                for (const dbTemplate of dbUserTemplates) {
                    const alreadyExists = userTemplates.some((t: any) => t.id === dbTemplate.id);
                    if (!alreadyExists) {
                        if (typeof dbTemplate.config === 'string') {
                            try {
                                dbTemplate.config = JSON.parse(dbTemplate.config);
                            } catch (e) {
                            }
                        }
                        userTemplates.push(dbTemplate);
                    }
                }
                console.log('[loadSubtitleTemplates] 从数据库加载用户模板后总数:', userTemplates.length, '个');
            }
        } catch (e) {
            console.warn('[loadSubtitleTemplates] 获取数据库模板失败，使用硬编码模板:', e);
        }

        // 3. 合并系统模板和用户模板
        subtitleTemplates.value = [...systemTemplates, ...userTemplates];

        console.log('[loadSubtitleTemplates] 合并后模板总数:', subtitleTemplates.value.length,
            '(系统模板:', systemTemplates.length, ', 用户模板:', userTemplates.length, ')');

        // 4. 只保存用户模板到localStorage，不保存系统模板副本
        // 这样可以避免系统模板硬编码的数据覆盖用户的修改
        try {
            localStorage.setItem(SUBTITLE_TEMPLATES_STORAGE_KEY, JSON.stringify(userTemplates));
            console.log('[loadSubtitleTemplates] ✅ 已将', userTemplates.length, '个用户模板保存到localStorage');
        } catch (e) {
            console.warn('[loadSubtitleTemplates] 保存到localStorage失败:', e);
        }
    } catch (error) {
        console.error('加载字幕模板失败:', error);
        // 兜底：至少使用硬编码的系统模板
        const fallbackSystemTemplates = JSON.parse(JSON.stringify(SYSTEM_TEMPLATES));
        subtitleTemplates.value = fallbackSystemTemplates;
    }
};

// 保存指定模板的所有参数到模板对象
const saveCurrentTemplateState = async (templateId?: string) => {
    // 获取要保存的模板ID
    const targetId = templateId || selectedSubtitleTemplate.value;
    if (!targetId) {
        console.log('[saveCurrentTemplateState] 没有模板ID，跳过保存');
        return;
    }

    // 找到要保存的模板对象
    const currentTemplate = subtitleTemplates.value.find(t => t.id === targetId);
    if (!currentTemplate) {
        console.log('[saveCurrentTemplateState] 找不到模板对象:', targetId);
        return;
    }

    console.log('[saveCurrentTemplateState] 保存当前模板的所有参数:', currentTemplate.name);

    // 获取当前的字幕样式（来自SubtitleStyleSelector）
    const currentSubtitleStyle = subtitleStyleSelectorRef.value?.getSelectedStyle?.();

    // 🔧 关键修复：深拷贝样式对象，参考特效字幕的做法
    // 避免多个模板共享同一个引用，导致修改一个影响另一个
    // ✅ 修复：使用手动字段提取而不是 structuredClone 来避免 Proxy 对象问题
    const subtitleStyleCopy = currentSubtitleStyle ? {
        id: currentSubtitleStyle.id,
        name: currentSubtitleStyle.name,
        description: currentSubtitleStyle.description,
        preview: currentSubtitleStyle.preview,
        fontName: currentSubtitleStyle.fontName,
        fontNameType: currentSubtitleStyle.fontNameType,
        fontSize: currentSubtitleStyle.fontSize,
        fontColor: currentSubtitleStyle.fontColor,
        outlineColor: currentSubtitleStyle.outlineColor,
        outlineWidth: currentSubtitleStyle.outlineWidth,
        backgroundColor: currentSubtitleStyle.backgroundColor,
        backgroundOpacity: currentSubtitleStyle.backgroundOpacity,
        position: currentSubtitleStyle.position,
        shadowOffset: currentSubtitleStyle.shadowOffset,
        shadowBlur: currentSubtitleStyle.shadowBlur,
        shadowColor: currentSubtitleStyle.shadowColor,
        fontStyle: currentSubtitleStyle.fontStyle,
        fontWeight: currentSubtitleStyle.fontWeight
    } : null;

    console.log('[saveCurrentTemplateState] 当前字幕样式:', {
        fontColor: subtitleStyleCopy?.fontColor,
        fontSize: subtitleStyleCopy?.fontSize,
        outlineWidth: subtitleStyleCopy?.outlineWidth,
        enableKeywordEffects: enableKeywordEffects.value
    });

    // 关键修复：只保存每个分组在这个模板中的样式配置，不保存分组定义和词
    // 分组定义（名称、词）保存在全局的keywordGroups中，所有模板共享
    // 🔧 重要：深拷贝样式配置，避免多个模板共享同一个对象引用
    // 🆕 新增：保存音效相关配置到模板
    const keywordGroupsStyles = keywordGroups.value.map(group => ({
        groupName: group.name,           // 用分组名称关联全局定义
        styleOverride: group.styleOverride ? {...group.styleOverride} : undefined,  // 深拷贝：每个模板有独立的样式对象
        effectId: group.effectId,        // 该模板的特效ID
        color: group.color,              // 该模板的颜色
        // 🆕 音效配置
        soundEffectId: group.soundEffectId,  // 该模板的音效ID
        soundEffectConfig: group.soundEffectConfig ? {...group.soundEffectConfig} : undefined  // 深拷贝：音效参数
    }));

    console.log('[saveCurrentTemplateState] 保存的关键词分组样式:', {
        count: keywordGroupsStyles.length,
        styles: keywordGroupsStyles,
        // 🆕 详细显示每个分组的音效配置
        soundEffects: keywordGroupsStyles.map(s => ({
            groupName: s.groupName,
            soundEffectId: s.soundEffectId,
            hasSoundConfig: !!s.soundEffectConfig
        }))
    });

    // 完整保存所有参数到模板配置对象
    const previewConfig =
        currentTemplate.config?.previewConfig
            ? JSON.parse(JSON.stringify(currentTemplate.config.previewConfig))
            : currentTemplateConfig.value?.previewConfig
                ? JSON.parse(JSON.stringify(currentTemplateConfig.value.previewConfig))
                : undefined;

    const newConfig = {
        subtitleStyleId: selectedSubtitleStyleId.value,
        subtitleFontSizeScale: subtitleFontSizeScale.value,
        subtitlePosition: subtitlePosition.value,
        enableKeywordEffects: enableKeywordEffects.value,  // 关键：保存特效启用状态
        keywordRenderMode:
            currentTemplate.config?.keywordRenderMode ||
            currentTemplateConfig.value?.keywordRenderMode ||
            'floating',
        keywordGroupsStyles: keywordGroupsStyles,          // 关键修复：只保存样式配置，不保存分组定义
        screenWidth: smartSubtitleConfig.value.screenWidth,
        screenHeight: smartSubtitleConfig.value.screenHeight,
        fontSize: smartSubtitleConfig.value.fontSize,
        fontFamily: smartSubtitleConfig.value.fontFamily,
        subtitleStyle: subtitleStyleCopy,             // 🔧 修复：使用深拷贝的样式对象
        // 注：minSubtitleDuration 仅用于特效字幕，不保存到模板，作为全局设置
        // ✨ 新增：保存标题字幕配置
        // 🆕 关键修复：确保 titleSubtitleConfig 不被意外重置
        // 必须保持原有的配置，只在完全不存在时才使用默认值
        titleSubtitleConfig: (currentTemplate.config && currentTemplate.config.titleSubtitleConfig)
            ? currentTemplate.config.titleSubtitleConfig
            : getDefaultTitleSubtitleConfig(),
        previewConfig: previewConfig
    };

    // 直接更新模板的config对象
    currentTemplate.config = newConfig;

    // 🔧 修复：同时更新 currentTemplateConfig，确保生成时使用最新配置
    if (currentTemplate.id === selectedSubtitleTemplate.value) {
        currentTemplateConfig.value = newConfig;
        console.log('[saveCurrentTemplateState] ✅ 已同步 currentTemplateConfig 为最新配置');
    }

    console.log('[saveCurrentTemplateState] 模板参数已更新:', {
        id: currentTemplate.id,
        name: currentTemplate.name,
        enableKeywordEffects: newConfig.enableKeywordEffects,
        keywordGroupsStylesCount: keywordGroupsStyles.length,
        subtitleStyle: newConfig.subtitleStyle
    });

    // 保存到localStorage和数据库（模板配置）
    await saveTemplatesToStorage(getTemplateStorageOptions(currentTemplate.id));  // 等待保存完成

    // 关键：同时保存当前的关键词分组到数据库（数据库优先）
    try {
        const result = await KeywordGroupService.saveGroups(keywordGroups.value);
        if (result.success) {
            console.log('[saveCurrentTemplateState] ✓ 关键词分组已保存到数据库');
        } else {
            console.warn('[saveCurrentTemplateState] ⚠️ 关键词分组保存到数据库失败，failedCount:', result.failedCount);
        }
    } catch (error) {
        console.error('[saveCurrentTemplateState] ❌ 保存关键词分组到数据库出错:', error);
    }
};

// 处理模板切换
const handleTemplateChange = async (templateId: string) => {
    console.log('[handleTemplateChange] 开始切换模板:', {
        from: currentLoadedTemplateId.value,
        to: templateId
    });

    // 🆕 修复：在切换模板前，先保存当前模板的状态（包括音效配置）
    const currentTemplateId = selectedSubtitleTemplate.value;
    if (currentTemplateId && currentTemplateId !== templateId) {
        console.log('[handleTemplateChange] 🔊 保存当前模板状态前先保存，模板ID:', currentTemplateId);
        await saveCurrentTemplateState(currentTemplateId);
    }

    // 🆕 修复：切换模板时，如果正在编辑其他模板，自动退出编辑模式
    if (isEditingSubtitleTemplate.value && editingTemplateId.value !== templateId) {
        console.log('[handleTemplateChange] 切换模板，自动退出编辑模式');
        isEditingSubtitleTemplate.value = false;
        editingTemplateId.value = '';
    }

    // 注意：当@change事件触发时，selectedSubtitleTemplate已经被v-model更新
    // 但loadTemplate中会根据previousLoadedTemplateId和currentLoadedTemplateId来处理状态保存
    // 所以这里只需要直接加载新模板即可

    const template = subtitleTemplates.value.find(t => t.id === templateId);
    if (template) {
        // 关键修复：如果 config 是字符串，需要解析为对象
        let config = template.config;
        if (typeof config === 'string') {
            try {
                config = JSON.parse(config);
                console.log('[handleTemplateChange] ✓ 已将 config 从字符串解析为对象');
            } catch (e) {
                console.error('[handleTemplateChange] 解析 config 字符串失败:', e);
                config = template.config;
            }
        }

        console.log('[handleTemplateChange] 找到模板:', {
            id: template.id,
            name: template.name,
            config: config
        });
        currentTemplateConfig.value = config;
        // 更新预览样式
        updatePreviewStyle(config);
        // 重要修复：调用 loadTemplate 来加载完整的模板配置到UI中，需要临时更新 template.config
        const originalConfig = template.config;
        template.config = config;
        await loadTemplate(template);
        template.config = originalConfig; // 恢复原始值

        // 关键修复：loadTemplate完成后立即清除标志，让watch能保存这次选择
        // 这样selectedSubtitleTemplate的变化就能被正确保存
        currentLoadedTemplateId.value = '';
    } else {
        console.warn('[handleTemplateChange] 找不到模板:', templateId);
    }
};

// 🆕 开始编辑指定模板
const startEditTemplate = async (templateId: string) => {
    console.log('[startEditTemplate] 开始编辑模板:', templateId);

    // 先选中该模板
    if (selectedSubtitleTemplate.value !== templateId) {
        selectedSubtitleTemplate.value = templateId;
        await handleTemplateChange(templateId);
    }

    // 设置编辑模式，这将触发 SubtitleStyleSelector 挂载 (v-if)
    editingTemplateId.value = templateId;
    isEditingSubtitleTemplate.value = true;

    // 🔧 关键修复：等待组件挂载后，显式加载模板样式
    // 因为 loadTemplate 执行时组件可能未挂载（v-if为false），导致样式加载被跳过
    // 且组件挂载时的 onMounted 会加载默认样式，所以必须在这里覆盖
    nextTick(async () => {
        try {
            if (subtitleStyleSelectorRef.value) {
                console.log('[startEditTemplate] 等待 SubtitleStyleSelector 初始化...');
                // 等待 onMounted 完成（包括默认样式的加载）
                if (typeof subtitleStyleSelectorRef.value.waitForInitialization === 'function') {
                    await subtitleStyleSelectorRef.value.waitForInitialization();
                }

                // 获取当前模板配置
                const template = subtitleTemplates.value.find(t => t.id === templateId);
                if (template && template.config && template.config.subtitleStyle) {
                    console.log('[startEditTemplate] 重新应用模板样式（覆盖默认值）:', template.config.subtitleStyle);

                    if (subtitleStyleSelectorRef.value.loadStyleFromObject) {
                        await subtitleStyleSelectorRef.value.loadStyleFromObject(template.config.subtitleStyle);
                        syncEditingPreviewSubtitleStyle(template.config.subtitleStyle);
                        // 🔧 修复：不再清空 selectedSubtitleStyleId，保持样式的连续性
                        // 即使 modelValue 为空，SubtitleStyleSelector 仍会保持已加载的样式
                    }
                }
            }
        } catch (e) {
            console.error('[startEditTemplate] 重新加载样式失败:', e);
        }
    });
};

// 处理保存按钮点击
const handleSaveButtonClick = async () => {
    // 如果正在编辑且有编辑中的模板ID，则执行保存并退出
    if (isEditingSubtitleTemplate.value && editingTemplateId.value) {
        try {
            await saveCurrentTemplateState(editingTemplateId.value);

            // 🔧 修复：保存后立即更新 currentTemplateConfig，确保生成时使用最新配置
            const savedTemplate = subtitleTemplates.value.find(t => t.id === editingTemplateId.value);
            if (savedTemplate?.config) {
                currentTemplateConfig.value = savedTemplate.config;
                console.log('[handleSaveButtonClick] ✅ 已同步 currentTemplateConfig 为最新配置');
            }

            // 退出编辑模式
            isEditingSubtitleTemplate.value = false;
            editingTemplateId.value = '';
            Message.success('模板已更新并保存');
        } catch (error) {
            console.error('[handleSaveButtonClick] 保存失败:', error);
            Message.error('保存失败，请重试');
        }
    } else {
        // 否则打开新建模板对话框
        openSaveTemplateDialog();
    }
};


// 导出单个字幕模板
const handleExportSubtitleTemplate = async (templateId: string, templateName: string) => {
    try {
        console.log('[VideoIPAgent] 导出字幕模板:', templateId, templateName);
        await exportAndDownloadSubtitleTemplate(templateId);
        Message.success(`字幕模板"${templateName}"导出成功`);
    } catch (error) {
        Message.error(`导出失败: ${(error as Error).message}`);
        console.error('[VideoIPAgent] 导出失败:', error);
    }
};

// 导出全部字幕模板
const handleExportAllSubtitleTemplates = async () => {
    try {
        console.log('[VideoIPAgent] 导出全部字幕模板');
        await exportAndDownloadSubtitleTemplates(false);
        Message.success('所有字幕模板导出成功');
    } catch (error) {
        Message.error(`导出失败: ${(error as Error).message}`);
        console.error('[VideoIPAgent] 导出全部失败:', error);
    }
};

const handleImportSubtitleTemplate = async () => {
    try {
        const result = await importSubtitleTemplateFromFile();
        if (result.success) {
            Message.success(result.message || '导入成功');
            await loadSubtitleTemplates();
            if (result.id) {
                selectedSubtitleTemplate.value = result.id;
                await handleTemplateChange(result.id);
            }
        } else if (result.message && result.message !== '用户取消导入') {
            Message.error(result.message);
        }
    } catch (error: any) {
        Message.error(`导入失败: ${error?.message || '未知错误'}`);
        console.error('[VideoIPAgent] 导入字幕模板失败:', error);
    }
};

// 🆕 确认删除模板
const confirmDeleteTemplate = (templateId: string) => {
    const template = subtitleTemplates.value.find(t => t.id === templateId);
    if (!template) return;

    // 检查是否为系统模板（根据数据库标记，不依赖硬编码列表）
    const isSystemTemplate = template.is_system === 1;

    // 系统模板在非开发模式下不可删除
    if (isSystemTemplate && !isDev.value) {
        Message.warning('系统内置模板在生产环境不可删除，仅在开发模式下可删除');
        return;
    }

    Modal.confirm({
        title: '确认删除',
        content: `确定要删除模板"${template.name}"吗？${isSystemTemplate ? '这是系统模板，' : ''}此操作不可恢复。`,
        okText: '删除',
        cancelText: '取消',
        okButtonProps: {status: 'danger'},
        onOk: async () => {
            await deleteTemplateById(templateId);
        }
    });
};

// 🆕 删除指定模板
const deleteTemplateById = async (templateId: string) => {
    const template = subtitleTemplates.value.find(t => t.id === templateId);
    if (!template) {
        Message.error('模板不存在');
        return;
    }

    const isSystemTemplate = template.is_system === 1;

    // 系统模板在非开发模式下不可删除
    if (isSystemTemplate && !isDev.value) {
        Message.error('系统内置模板在生产环境不可删除，仅在开发模式下可删除');
        return;
    }

    try {
        // 如果是系统模板，调用后端API
        if (true) {
            console.log('[deleteTemplateById] 删除系统模板:', templateId);
            const result = await window.$mapi.ipAgent.deleteSubtitleTemplate({
                id: templateId,
                isDev: isDev.value
            });

            if (!result.success) {
                Message.error(result.message || '删除模板失败');
                console.error('[deleteTemplateById] 删除系统模板失败:', result.message);
                return;
            }
            console.log('[deleteTemplateById] ✅ 系统模板已删除');
        }

        // 从本地数组移除
        const index = subtitleTemplates.value.findIndex(t => t.id === templateId);
        if (index > -1) {
            subtitleTemplates.value.splice(index, 1);
        }

        // 保存到存储
        await saveTemplatesToStorage();
        Message.success('模板已删除');

        // 如果删除的是当前编辑的模板，退出编辑模式
        if (editingTemplateId.value === templateId) {
            isEditingSubtitleTemplate.value = false;
            editingTemplateId.value = '';
        }

        // 如果删除的是当前选中的模板，清空选择
        if (selectedSubtitleTemplate.value === templateId) {
            selectedSubtitleTemplate.value = '';
        }
    } catch (error) {
        Message.error('删除模板失败: ' + (error?.message || '未知错误'));
        console.error('[deleteTemplateById] 删除模板异常:', error);
    }
};

// ✨ 将字幕模板设为系统模板
const handleSetSubtitleAsSystem = async (templateId: string, templateName: string) => {
    try {
        console.log('[VideoIPAgent] 设为系统模板:', templateId, templateName);

        // 找到对应的模板
        const template = subtitleTemplates.value.find(t => t.id === templateId);
        if (!template) {
            Message.error('模板不存在');
            return;
        }

        // 检查开发模式
        if (!isDev.value) {
            Message.warning('仅在开发模式下可以设置系统模板');
            return;
        }

        // 更新本地模板
        template.is_system = 1;
        template.isSystem = true;

        // 保存到本地存储
        await saveTemplatesToStorage(getTemplateStorageOptions(templateId, true));

        Message.success(`已将"${templateName}"设为系统模板`);
        console.log('[VideoIPAgent] 系统模板设置成功');
    } catch (error) {
        console.error('[VideoIPAgent] 设为系统模板失败:', error);
        Message.error('设置失败：' + (error as Error).message);
    }
};

// 更新预览样式
const updatePreviewStyle = (config: any) => {
    try {
        // 🆕 增强：关键修复：如果 config 是字符串，需要解析为对象
        if (typeof config === 'string') {
            try {
                config = JSON.parse(config);
                console.log('[updatePreviewStyle] ✓ 已将 config 从字符串解析为对象');
            } catch (e) {
                console.error('[updatePreviewStyle] 解析 config 字符串失败:', e);
            }
        }

        // 🆕 增强：验证 config 不为 null/undefined
        if (!config || typeof config !== 'object') {
            console.warn('[updatePreviewStyle] 无效的配置，使用默认值:', config);
            config = {
                fontColor: '#FFFFFF',
                fontSize: 48,
                outlineColor: '#000000',
                outlineWidth: 3
            };
        }

        // 改进：区分数据来源 - 从 getSelectedStyle() 还是从 template.config
        // getSelectedStyle() 返回的对象直接有 fontColor 属性
        // template.config 返回的对象有 styleOverride 属性
        const isFromSelectedStyle = !config.styleOverride && config.fontColor !== undefined;
        const styleInfo = isFromSelectedStyle ? config : (config.styleOverride || {});

        // 🆕 改进：使用可选链和空值合并确保安全访问
        const fontColor = styleInfo?.fontColor ?? config?.fontColor ?? '#FFFFFF';
        const outlineColor = styleInfo?.outlineColor ?? config?.outlineColor ?? '#000000';
        const backgroundColor = styleInfo?.backgroundColor ?? config?.backgroundColor ?? 'transparent';
        const fontSize = styleInfo?.fontSize ?? config?.fontSize ?? 48;
        const outlineWidth = styleInfo?.outlineWidth ?? config?.outlineWidth ?? 3;
        const backgroundOpacity = styleInfo?.backgroundOpacity ?? config?.backgroundOpacity ?? 0;

        // 🆕 增强：严格的类型验证和多层级回退
        // 确保 fontColor 始终是有效的字符串
        const safeFontColor = (typeof fontColor === 'string' && fontColor?.trim())
            ? fontColor
            : '#FFFFFF';

        const safeOutlineColor = (typeof outlineColor === 'string' && outlineColor?.trim())
            ? outlineColor
            : '#000000';

        const safeBackgroundColor = (typeof backgroundColor === 'string' && backgroundColor?.trim())
            ? backgroundColor
            : 'transparent';

        // 确保 fontSize 是有效数字
        const safeFontSize = (typeof fontSize === 'number' && fontSize > 0) ? fontSize : 48;

        // 确保 outlineWidth 是有效数字
        const safeOutlineWidth = (typeof outlineWidth === 'number' && outlineWidth >= 0) ? outlineWidth : 3;

        // 确保 backgroundOpacity 是有效数字
        const safeBackgroundOpacity = (typeof backgroundOpacity === 'number' && backgroundOpacity >= 0)
            ? backgroundOpacity
            : 0;

        // 🆕 提取字体名称
        const fontName = styleInfo?.fontName ?? config?.fontName ?? 'Microsoft YaHei Bold';
        const safeFontName = (typeof fontName === 'string' && fontName?.trim())
            ? fontName
            : 'Microsoft YaHei Bold';

        previewStyle.value = {
            fontName: safeFontName,
            fontColor: safeFontColor,
            fontSize: safeFontSize,
            outlineColor: safeOutlineColor,
            outlineWidth: safeOutlineWidth,
            backgroundColor: safeBackgroundColor,
            backgroundOpacity: safeBackgroundOpacity
        };

        console.log('[updatePreviewStyle] ✅ 已初始化预览样式 (来源:' + (isFromSelectedStyle ? 'getSelectedStyle' : 'template') + '):', previewStyle.value);
    } catch (error) {
        console.error('[updatePreviewStyle] ❌ 更新预览样式失败:', error);
        // 失败时使用安全的默认值
        previewStyle.value = {
            fontName: 'Microsoft YaHei Bold',
            fontColor: '#FFFFFF',
            fontSize: 48,
            outlineColor: '#000000',
            outlineWidth: 3,
            backgroundColor: 'transparent',
            backgroundOpacity: 0
        };
    }
};

// 🆕 处理SubtitleStyleSelector发出的样式变化事件
const handleSubtitleStyleChange = (style: any) => {
    console.log('[handleSubtitleStyleChange] 收到样式变化事件:', style);
    if (style && typeof style === 'object') {
        updatePreviewStyle(style);
        syncEditingPreviewSubtitleStyle(style);
    }
};

watch([subtitleFontSizeScale, subtitlePosition], () => {
    nextTick(() => {
        syncEditingPreviewSubtitleStyle();
    });
});

watch([isEditingSubtitleTemplate, selectedSubtitleTemplate], () => {
    nextTick(() => {
        if (!isEditingSubtitleTemplate.value) {
            liveEditingSubtitleStyle.value = null;
            return;
        }
        syncEditingPreviewSubtitleStyle();
    });
});

// 保存模板到本地存储
const getTemplateStorageOptions = (templateId?: string, exportSystemTemplates: boolean = false) => {
    if (!templateId) {
        return {
            systemTemplateIds: [] as string[],
            exportSystemTemplates: false
        };
    }

    const template = subtitleTemplates.value.find((item: any) => item.id === templateId);
    if (!template || template.is_system !== 1) {
        return {
            systemTemplateIds: [] as string[],
            exportSystemTemplates: false
        };
    }

    return {
        systemTemplateIds: [template.id],
        exportSystemTemplates
    };
};

const saveTemplatesToStorage = async (options: {
    systemTemplateIds?: string[];
    exportSystemTemplates?: boolean;
} = {}) => {
    try {
        const systemTemplates = subtitleTemplates.value.filter((t: any) => t.is_system === 1);
        const userOnlyTemplates = subtitleTemplates.value.filter((t: any) => t.is_system !== 1);
        const systemTemplateIdsToPersist = new Set((options.systemTemplateIds || []).filter(Boolean));
        const systemTemplatesToPersist = systemTemplates.filter((template: any) => systemTemplateIdsToPersist.has(template.id));

        console.log('[saveTemplatesToStorage] 准备保存:', {
            systemCount: systemTemplates.length,
            systemPersistCount: systemTemplatesToPersist.length,
            userCount: userOnlyTemplates.length,
            exportSystemTemplates: options.exportSystemTemplates === true
        });

        if (systemTemplatesToPersist.length > 0) {
            const results: boolean[] = [];
            for (const template of systemTemplatesToPersist) {
                try {
                    const cleanConfig = JSON.parse(JSON.stringify(template.config || {}));
                    const result = await (window as any).$mapi.subtitleCover.saveSystemTemplate({
                        type: 'subtitle',
                        id: template.id,
                        name: template.name,
                        description: template.description,
                        config: cleanConfig
                    }, true);

                    if (result.success) {
                        console.log(`[saveTemplatesToStorage] 已保存系统模板 "${template.name}" (${template.id})`);
                        results.push(true);
                    } else {
                        console.warn(`[saveTemplatesToStorage] 系统模板 "${template.name}" 保存失败:`, result.message);
                        results.push(false);
                    }
                } catch (error) {
                    console.error(`[saveTemplatesToStorage] 系统模板 "${template.name}" 保存异常:`, error);
                    results.push(false);
                }
            }

            const successCount = results.filter(Boolean).length;
            console.log('[saveTemplatesToStorage] 系统模板保存完成:', successCount + '/' + systemTemplatesToPersist.length, '成功');

            if (isDev.value && options.exportSystemTemplates === true && successCount > 0) {
                try {
                    const exportResult = await window.$mapi.ipAgent.exportSubtitleTemplates({
                        includeSystemOnly: true
                    });

                    if (exportResult?.success) {
                        console.log('[saveTemplatesToStorage] 已同步导出系统字幕模板到打包配置:', exportResult.configPath);
                    } else {
                        console.warn('[saveTemplatesToStorage] 系统字幕模板已保存，但导出打包配置失败:', exportResult?.message || exportResult?.error);
                    }
                } catch (exportError) {
                    console.warn('[saveTemplatesToStorage] 系统字幕模板已保存，但导出打包配置异常:', exportError);
                }
            }
        }

        if (userOnlyTemplates.length > 0) {
            console.log('[saveTemplatesToStorage] 保存', userOnlyTemplates.length, '个用户模板到数据库和 localStorage');
            for (const template of userOnlyTemplates) {
                try {
                    const cleanConfig = JSON.parse(JSON.stringify(template.config || {}));
                    if (template.id) {
                        const result = await window.$mapi.ipAgent.saveSubtitleTemplate({
                            id: template.id,
                            name: template.name,
                            description: template.description,
                            config: cleanConfig,
                            isDev: false
                        });

                        if (result.success) {
                            console.log(`[saveTemplatesToStorage] 已保存用户模板 "${template.name}"`);
                        } else {
                            console.warn(`[saveTemplatesToStorage] 用户模板 "${template.name}" 保存失败:`, result.message);
                        }
                    }
                } catch (error) {
                    console.error(`[saveTemplatesToStorage] 用户模板 "${template.name}" 保存异常:`, error);
                }
            }
            localStorage.setItem(SUBTITLE_TEMPLATES_STORAGE_KEY, JSON.stringify(userOnlyTemplates));
        } else {
            localStorage.removeItem(SUBTITLE_TEMPLATES_STORAGE_KEY);
        }

        console.log('[saveTemplatesToStorage] 所有模板保存完成');
    } catch (error) {
        console.error('[saveTemplatesToStorage] 保存字幕模板失败:', error);
        throw error;
    }
};

const openSaveTemplateDialog = () => {
    console.log('[openSaveTemplateDialog] 打开新建模板对话框');

    // 关键修复：新建模板前，先保存当前加载的模板（如果有）
    if (currentLoadedTemplateId.value && previousLoadedTemplateId.value !== currentLoadedTemplateId.value) {
        console.log('[openSaveTemplateDialog] 新建前保存当前模板:', currentLoadedTemplateId.value);
        // 异步保存，不阻塞对话框打开
        saveCurrentTemplateState(currentLoadedTemplateId.value).catch(error => {
            console.error('[openSaveTemplateDialog] 保存模板时出错:', error);
        });
    }

    // 清空模板表单
    templateName.value = '';
    templateDescription.value = '';
    saveAsSystemTemplate.value = false;  // ✨ 重置系统模板选项

    // 重要：清空当前加载的模板ID，这样新建模板不会继承当前模板
    previousLoadedTemplateId.value = currentLoadedTemplateId.value;
    currentLoadedTemplateId.value = '';
    selectedSubtitleTemplate.value = '';

    console.log('[openSaveTemplateDialog] 已清空当前模板标记，准备新建全新模板');

    showTemplateDialog.value = true;
};

// 保存当前字幕配置为模板
const saveSubtitleTemplate = async () => {
    console.log('[saveSubtitleTemplate] 开始保存模板');

    if (!templateName.value.trim()) {
        Message.error('请输入模板名称');
        return;
    }

    // 检查名称是否重复
    if (subtitleTemplates.value.some(t => t.name === templateName.value)) {
        Message.error('该模板名称已存在，请使用其他名称');
        return;
    }

    // 记录当前的全局参数
    console.log('[saveSubtitleTemplate] 当前全局参数:', {
        selectedSubtitleStyleId: selectedSubtitleStyleId.value,
        subtitleFontSizeScale: subtitleFontSizeScale.value,
        subtitlePosition: subtitlePosition.value,
        enableKeywordEffects: enableKeywordEffects.value,
        screenWidth: smartSubtitleConfig.value.screenWidth,
        screenHeight: smartSubtitleConfig.value.screenHeight,
        fontSize: smartSubtitleConfig.value.fontSize,
        fontFamily: smartSubtitleConfig.value.fontFamily
    });

    // 提取关键词组的样式配置（不保存整个keywordGroups，只保存样式）
    // 🆕 新增：保存音效相关配置到模板
    const keywordGroupsConfig = keywordGroups.value.map(group => ({
        name: group.name,
        description: group.description,
        color: group.color,
        styleOverride: group.styleOverride, // 只保存样式，不保存keywords
        effectId: group.effectId,
        // 🆕 音效配置
        soundEffectId: group.soundEffectId,
        soundEffectConfig: group.soundEffectConfig
    }));

    // 新增：获取 SubtitleStyleSelector 的完整样式
    const subtitleStyle = subtitleStyleSelectorRef.value?.getSelectedStyle?.();

    // 🔧 关键修复：深拷贝样式对象，避免引用共享
    // ✅ 修复：使用手动字段提取而不是 structuredClone 来避免 Proxy 对象问题
    const subtitleStyleCopy = subtitleStyle ? {
        id: subtitleStyle.id,
        name: subtitleStyle.name,
        description: subtitleStyle.description,
        preview: subtitleStyle.preview,
        fontName: subtitleStyle.fontName,
        fontNameType: subtitleStyle.fontNameType,
        fontSize: subtitleStyle.fontSize,
        fontColor: subtitleStyle.fontColor,
        outlineColor: subtitleStyle.outlineColor,
        outlineWidth: subtitleStyle.outlineWidth,
        backgroundColor: subtitleStyle.backgroundColor,
        backgroundOpacity: subtitleStyle.backgroundOpacity,
        position: subtitleStyle.position,
        shadowOffset: subtitleStyle.shadowOffset,
        shadowBlur: subtitleStyle.shadowBlur,
        shadowColor: subtitleStyle.shadowColor,
        fontStyle: subtitleStyle.fontStyle,
        fontWeight: subtitleStyle.fontWeight,
        alignment: subtitleStyle.alignment
    } : null;

    console.log('[saveSubtitleTemplate] 获取到的字幕样式:', {
        fontName: subtitleStyleCopy?.fontName,
        fontSize: subtitleStyleCopy?.fontSize,
        fontColor: subtitleStyleCopy?.fontColor,
        outlineColor: subtitleStyleCopy?.outlineColor,
        outlineWidth: subtitleStyleCopy?.outlineWidth,  // 关键：检查描边宽度
        shadowOffset: subtitleStyleCopy?.shadowOffset,
        backgroundColor: subtitleStyleCopy?.backgroundColor,
        backgroundOpacity: subtitleStyleCopy?.backgroundOpacity,
        position: subtitleStyleCopy?.position,
        alignment: subtitleStyleCopy?.alignment
    });

    // 关键：为新模板生成唯一的 styleId 并保存样式到数据库
    const templateId = 'template_' + Date.now();
    const styleId = 'style_' + templateId;

    // 立即保存样式到数据库
    if (subtitleStyle && subtitleStyleSelectorRef.value?.saveCustomStyle) {
        try {
            console.log('[saveSubtitleTemplate] 保存样式到数据库, styleId:', styleId);
            await subtitleStyleSelectorRef.value.saveCustomStyle(styleId);
            console.log('[saveSubtitleTemplate] ✅ 样式已保存到数据库');
        } catch (error) {
            console.error('[saveSubtitleTemplate] ❌ 保存样式失败:', error);
        }
    }

    const previewConfig =
        currentSelectedTemplate.value?.config?.previewConfig
            ? JSON.parse(JSON.stringify(currentSelectedTemplate.value.config.previewConfig))
            : currentTemplateConfig.value?.previewConfig
                ? JSON.parse(JSON.stringify(currentTemplateConfig.value.previewConfig))
                : undefined;

    const titleSubtitleConfig =
        currentSelectedTemplate.value?.config?.titleSubtitleConfig
            ? JSON.parse(JSON.stringify(currentSelectedTemplate.value.config.titleSubtitleConfig))
            : currentTemplateConfig.value?.titleSubtitleConfig
                ? JSON.parse(JSON.stringify(currentTemplateConfig.value.titleSubtitleConfig))
                : getDefaultTitleSubtitleConfig();

    const template = {
        id: templateId,
        name: templateName.value,
        description: templateDescription.value,
        createdAt: Date.now(),
        is_system: saveAsSystemTemplate.value && isDev.value ? 1 : 0,
        isSystem: saveAsSystemTemplate.value && isDev.value,
        config: {
            subtitleStyleId: styleId,
            subtitleFontSizeScale: subtitleFontSizeScale.value,
            subtitlePosition: subtitlePosition.value,
            enableKeywordEffects: enableKeywordEffects.value,
            keywordRenderMode:
                currentSelectedTemplate.value?.config?.keywordRenderMode ||
                currentTemplateConfig.value?.keywordRenderMode ||
                'floating',
            keywordGroups: keywordGroupsConfig,
            screenWidth: smartSubtitleConfig.value.screenWidth,
            screenHeight: smartSubtitleConfig.value.screenHeight,
            fontSize: smartSubtitleConfig.value.fontSize,
            fontFamily: smartSubtitleConfig.value.fontFamily,
            subtitleStyle: subtitleStyleCopy,
            titleSubtitleConfig: titleSubtitleConfig,
            previewConfig: previewConfig
        }
    };
    console.log('[saveSubtitleTemplate] 新模板对象:', {
        id: template.id,
        name: template.name,
        subtitleStyle_outlineWidth: template.config.subtitleStyle?.outlineWidth,  // 关键：验证是否被保存
        subtitleStyle_shadowOffset: template.config.subtitleStyle?.shadowOffset,
        config: {
            subtitleStyleId: template.config.subtitleStyleId,
            subtitleFontSizeScale: template.config.subtitleFontSizeScale,
            subtitlePosition: template.config.subtitlePosition,
            enableKeywordEffects: template.config.enableKeywordEffects,
            screenWidth: template.config.screenWidth,
            screenHeight: template.config.screenHeight,
            fontSize: template.config.fontSize,
            fontFamily: template.config.fontFamily
        }
    });

    subtitleTemplates.value.push(template);
    console.log('[saveSubtitleTemplate] 保存后的所有模板:', subtitleTemplates.value.map(t => ({
        id: t.id,
        name: t.name,
        subtitleStyleId: t.config.subtitleStyleId,
        subtitleFontSizeScale: t.config.subtitleFontSizeScale,
        subtitlePosition: t.config.subtitlePosition,
        enableKeywordEffects: t.config.enableKeywordEffects
    })));

    await saveTemplatesToStorage(getTemplateStorageOptions(template.id, saveAsSystemTemplate.value && isDev.value));

    // ✨ 如果设置为系统模板，自动导出到配置文件
    if (saveAsSystemTemplate.value && isDev.value) {
        Message.success('系统模板已保存，并同步到打包配置');
    } else {
        Message.success('模板保存成功');
    }

    showTemplateDialog.value = false;

    // 重要：新建模板后，不要自动加载，保持当前状态不变
    // previousLoadedTemplateId和currentLoadedTemplateId已经在openSaveTemplateDialog中清空
    // 这样用户可以继续编辑，或者主动选择一个模板来加载
    console.log('[saveSubtitleTemplate] 模板保存完成，当前状态:', {
        currentLoadedTemplateId: currentLoadedTemplateId.value,
        selectedSubtitleTemplate: selectedSubtitleTemplate.value
    });
};

// 加载模板
const loadTemplate = async (template: any) => {
    try {
        // 关键修复：如果 config 是字符串，需要解析为对象
        let config = template.config;
        if (typeof config === 'string') {
            try {
                config = JSON.parse(config);
                console.log('[loadTemplate] ✓ 已将 config 从字符串解析为对象');
            } catch (e) {
                console.error('[loadTemplate] 解析 config 字符串失败:', e);
                config = template.config;
            }
        }

        console.log('[loadTemplate] 开始加载模板:', {
            name: template.name,
            id: template.id,
            previousLoadedTemplateId: previousLoadedTemplateId.value,
            currentLoadedTemplateId: currentLoadedTemplateId.value
        });

        console.log('[loadTemplate] 模板配置详情:', {
            subtitleStyleId: config.subtitleStyleId,
            subtitleFontSizeScale: config.subtitleFontSizeScale,
            subtitlePosition: config.subtitlePosition,
            enableKeywordEffects: config.enableKeywordEffects,
            screenWidth: config.screenWidth,
            screenHeight: config.screenHeight,
            fontSize: config.fontSize,
            fontFamily: config.fontFamily
        });

        // 关键修复：在加载新模板前，先保存前一个加载的模板的状态
        if (previousLoadedTemplateId.value && previousLoadedTemplateId.value !== template.id) {
            console.log('[loadTemplate] 保存前一个模板的状态:', previousLoadedTemplateId.value);
            // 异步保存，不阻塞模板加载
            saveCurrentTemplateState(previousLoadedTemplateId.value).catch(error => {
                console.error('[loadTemplate] 保存前一个模板时出错:', error);
            });
        }

        // 标记当前加载的模板ID，防止参数变化被保存到workData
        previousLoadedTemplateId.value = currentLoadedTemplateId.value; // 保存旧的currentLoadedTemplateId到previousLoadedTemplateId
        currentLoadedTemplateId.value = template.id;

        // 记录修改前的值
        console.log('[loadTemplate] 修改前的全局参数:', {
            selectedSubtitleStyleId: selectedSubtitleStyleId.value,
            subtitleFontSizeScale: subtitleFontSizeScale.value,
            subtitlePosition: subtitlePosition.value,
            enableKeywordEffects: enableKeywordEffects.value
        });

        // 确保赋值的是字符串，而不是ref对象
        const styleId = config.subtitleStyleId || '';
        selectedSubtitleStyleId.value = typeof styleId === 'string' ? styleId : (styleId.value || '');

        const fontScale = config.subtitleFontSizeScale;
        subtitleFontSizeScale.value = typeof fontScale === 'number' ? fontScale : (fontScale?.value || 100);

        const position = config.subtitlePosition || 'bottom';
        subtitlePosition.value = typeof position === 'string' ? (position as 'top' | 'center' | 'bottom') : (position?.value || 'bottom');

        enableKeywordEffects.value = config.enableKeywordEffects || false;

        // 注：minSubtitleDuration 仅用于特效字幕，不从模板中加载，保持全局设置

        // 记录修改后的值
        console.log('[loadTemplate] 修改后的全局参数:', {
            selectedSubtitleStyleId: selectedSubtitleStyleId.value,
            subtitleFontSizeScale: subtitleFontSizeScale.value,
            subtitlePosition: subtitlePosition.value,
            enableKeywordEffects: enableKeywordEffects.value,
            minSubtitleDuration: settings.value.minSubtitleDuration
        });

        // 关键修复：应用该模板的样式配置到全局的关键词分组上
        // keywordGroups的分组定义（名称、词）来自全局的keywordGroups
        // 模板只提供该模板为每个分组设置的样式（styleOverride, effectId, color）

        // 关键修复：确保keywordGroups已经初始化，如果为空则从localStorage加载或创建默认分组
        if (!keywordGroups.value || keywordGroups.value.length === 0) {
            console.log('[loadTemplate] ⚠️  keywordGroups为空，尝试从localStorage恢复');
            try {
                const stored = localStorage.getItem('zhenqianba_keyword_groups');
                if (stored) {
                    const parsed = JSON.parse(stored);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        keywordGroups.value = parsed;
                        console.log('[loadTemplate] ✓ 从localStorage成功恢复keywordGroups，数量:', parsed.length);
                    } else {
                        console.warn('[loadTemplate] localStorage中的keywordGroups为空，不自动创建默认分组');
                        keywordGroups.value = []; // 【修复】不自动创建默认分组
                    }
                } else {
                    console.warn('[loadTemplate] localStorage中没有keywordGroups，不自动创建默认分组');
                    keywordGroups.value = []; // 【修复】不自动创建默认分组
                }
            } catch (error) {
                console.error('[loadTemplate] 从localStorage恢复keywordGroups失败:', error);
                keywordGroups.value = []; // 【修复】不自动创建默认分组
            }
        }

        console.log('[loadTemplate] 开始应用模板的关键词分组样式:', {
            configHasKeywordGroupsStyles: !!config.keywordGroupsStyles,
            configStylesCount: config.keywordGroupsStyles?.length || 0,
            globalGroupsCount: keywordGroups.value.length
        });

        // 🔧 关键修复：每次加载模板时，都应该应用该模板保存的样式配置
        // 不应该因为用户编辑过就永远保留旧样式
        // 这样可以确保：切换模板 → 自动应用新模板的样式

        // 首先清空所有分组的样式（重置为无样式状态）
        keywordGroups.value.forEach((group: any) => {
            // 只清空样式覆盖，保留分组本身和关键词定义
            group.styleOverride = undefined;
            group.effectId = undefined;
            group.color = undefined;
            // 🆕 同时清空音效配置
            group.soundEffectId = undefined;
            group.soundEffectConfig = undefined;
        });

        console.log('[loadTemplate] 🔧 已清空所有分组的样式覆盖，准备应用模板配置');

        // 然后应用当前模板的样式配置
        if (config.keywordGroupsStyles && config.keywordGroupsStyles.length > 0) {
            // 逐个应用模板的样式配置到全局分组
            config.keywordGroupsStyles.forEach((styleConfig: any) => {
                // 按名称找到对应的全局分组
                const targetGroup = keywordGroups.value.find(g => g.name === styleConfig.groupName);

                if (targetGroup) {
                    // 应用该模板的样式覆盖到分组上
                    console.log('[loadTemplate] 应用模板样式到分组:', {
                        groupName: styleConfig.groupName,
                        styleOverride: styleConfig.styleOverride,
                        effectId: styleConfig.effectId,
                        color: styleConfig.color,
                        // 🆕 添加音效配置日志
                        soundEffectId: styleConfig.soundEffectId,
                        soundEffectConfig: styleConfig.soundEffectConfig
                    });

                    // 🔧 重要：深拷贝样式配置，确保不同模板的样式互不影响
                    // 🆕 新增：加载音效配置
                    Object.assign(targetGroup, {
                        styleOverride: styleConfig.styleOverride ? {...styleConfig.styleOverride} : undefined,  // 深拷贝
                        effectId: styleConfig.effectId,
                        effectDuration: styleConfig.effectDuration,  // 🆕 恢复特效时长
                        color: styleConfig.color,
                        soundEffectId: styleConfig.soundEffectId,
                        soundEffectConfig: styleConfig.soundEffectConfig ? {...styleConfig.soundEffectConfig} : undefined
                    });

                    // 🆕 验证音效是否加载成功
                    console.log('[loadTemplate] 🔊 音效配置加载结果:', {
                        groupName: targetGroup.name,
                        soundEffectId: targetGroup.soundEffectId,
                        soundEffectConfig: targetGroup.soundEffectConfig
                    });
                } else {
                    console.warn('[loadTemplate] 找不到分组:', styleConfig.groupName);
                }
            });
        } else if (config.keywordGroups && config.keywordGroups.length > 0) {
            // 兼容旧版本数据：如果存在keywordGroups（旧格式），进行迁移
            console.log('[loadTemplate] 检测到旧格式的keywordGroups数据，进行兼容处理');
            config.keywordGroups.forEach((configGroup: any) => {
                const targetGroup = keywordGroups.value.find(g => g.name === configGroup.name);
                if (targetGroup) {
                    // 🔧 重要：即使是旧格式也要深拷贝，确保不同模板的样式互不影响
                    Object.assign(targetGroup, {
                        styleOverride: configGroup.styleOverride ? {...configGroup.styleOverride} : undefined,  // 深拷贝
                        effectId: configGroup.effectId,
                        color: configGroup.color
                    });
                }
            });
        }

        // 关键修复：加载模板后检查是否有keyword groups with styles，如果有则自动启用
        const hasGroupsWithStylesAfterLoad = keywordGroups.value.some((group: any) =>
            group.styleOverride && (group.styleOverride.fontColor || group.styleOverride.fontSize)
        );
        if (hasGroupsWithStylesAfterLoad && !enableKeywordEffects.value) {
            console.log('[loadTemplate] 检测到keyword groups有样式，自动启用enableKeywordEffects');
            enableKeywordEffects.value = true;
        }

        console.log('[loadTemplate] 加载后的 keywordGroups:', {
            count: keywordGroups.value.length,
            groups: keywordGroups.value.map(g => ({
                name: g.name,
                keywordCount: g.keywords?.length || 0,
                styleOverride: g.styleOverride,
                effectId: g.effectId
            }))
        });

        smartSubtitleConfig.value.screenWidth = config.screenWidth;
        smartSubtitleConfig.value.screenHeight = config.screenHeight;
        smartSubtitleConfig.value.fontSize = config.fontSize;
        if (config.fontFamily) {
            smartSubtitleConfig.value.fontFamily = config.fontFamily;
        }

        // 关键修复：应用模板样式后，保存keywordGroups回localStorage，确保数据持久化
        try {
            localStorage.setItem('zhenqianba_keyword_groups', JSON.stringify(keywordGroups.value));
            console.log('[loadTemplate] ✓ keywordGroups已保存到localStorage');
        } catch (error) {
            console.error('[loadTemplate] 保存keywordGroups到localStorage失败:', error);
        }

        // 同时更新KeywordGroupManager组件中的数据（关键修复：确保UI同步）
        if (keywordGroupManagerRef.value) {
            keywordGroupManagerRef.value.loadGroups(keywordGroups.value);
        }

        // 重要：不要调用 onKeywordGroupsChange，避免 classifyGeneratedKeywords 重置数据
        // 直接保存到本地存储
        try {
            localStorage.setItem('zhenqianba_keyword_groups', JSON.stringify(keywordGroups.value));
        } catch (e) {
            console.error('保存分组到本地存储失败:', e);
        }

        // 🔧 关键修复：参考特效字幕的方式，直接从模板配置中加载完整的样式对象
        // 而不是通过 styleId 从数据库加载，这样每个模板的样式完全独立

        // 🆕 【关键修复】等待 subtitleStyleSelectorRef 挂载
        // 首次选择模板时，组件可能尚未挂载，需要等待
        let retryCount = 0;
        const maxRetries = 10;
        const retryInterval = 100; // ms

        while (!subtitleStyleSelectorRef.value && retryCount < maxRetries) {
            console.log(`[loadTemplate] ⏳ 等待 SubtitleStyleSelector 组件挂载... (${retryCount + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, retryInterval));
            retryCount++;
        }

        if (subtitleStyleSelectorRef.value?.loadStyleFromObject) {
            try {
                // 🆕 关键修复：等待组件初始化完成，防止样式被组件自身的初始化逻辑（加载默认值）覆盖
                // 这解决了"保存后重启又恢复默认"的问题
                if (typeof subtitleStyleSelectorRef.value?.waitForInitialization === 'function') {
                    console.log('[loadTemplate] 等待 SubtitleStyleSelector 初始化...');
                    await subtitleStyleSelectorRef.value.waitForInitialization();
                    console.log('[loadTemplate] SubtitleStyleSelector 初始化完成，继续加载模板');
                }

                if (config.subtitleStyle && typeof config.subtitleStyle === 'object') {
                    // 优先使用模板配置中保存的完整样式对象（类似特效字幕的方式）
                    console.log('[loadTemplate] 从模板配置加载完整样式对象:', config.subtitleStyle);
                    await subtitleStyleSelectorRef.value.loadStyleFromObject(config.subtitleStyle);

                    // 🔧 修复：不再清空 selectedSubtitleStyleId，保持样式的连续性
                    // 这样当 SubtitleStyleSelector 重新挂载时，不会被迫加载默认样式
                    // selectedSubtitleStyleId 保持不变，让样式对象保持有效
                    console.log('[loadTemplate] ✅ 已从模板配置加载字幕样式（保持 selectedSubtitleStyleId）');
                } else {
                    // 降级方案：如果模板中没有保存完整样式，尝试从数据库加载（兼容旧数据）
                    const styleId = config.subtitleStyleId || '';
                    if (styleId && subtitleStyleSelectorRef.value?.loadStyle) {
                        console.log('[loadTemplate] 模板中无完整样式，从数据库加载 styleId:', styleId);
                        await subtitleStyleSelectorRef.value.loadStyle(styleId);
                    } else {
                        console.log('[loadTemplate] ⚠️ 模板中无样式数据，使用默认样式');
                    }
                }
            } catch (error) {
                console.error('[loadTemplate] 加载字幕样式失败:', error);
            }
        } else {
            console.warn('[loadTemplate] ⚠️ SubtitleStyleSelector 组件未就绪，样式加载将延迟到组件挂载后');
            // 保存配置到 currentTemplateConfig，等组件挂载后再应用
            currentTemplateConfig.value = config;
        }

        // ✨ 新增：加载标题字幕配置
        // 🆕 关键修复：谨慎处理默认值合并，防止丢失已有数据
        if (config.titleSubtitleConfig && typeof config.titleSubtitleConfig === 'object') {
            try {
                console.log('[loadTemplate] 原始 titleSubtitleConfig:', {
                    enabled: config.titleSubtitleConfig?.enabled,
                    sourceTitle: config.titleSubtitleConfig?.sourceTitle,
                    linesCount: config.titleSubtitleConfig?.lines?.length,
                    maxCharsPerLine: config.titleSubtitleConfig?.maxCharsPerLine
                });

                // 🆕 改进：只在字段完全缺失时才使用默认值，不要无条件覆盖
                const defaultConfig = getDefaultTitleSubtitleConfig();
                const mergedConfig: any = {};

                // 逐个字段处理，只填补缺失的字段
                for (const key in defaultConfig) {
                    if (config.titleSubtitleConfig[key] !== undefined && config.titleSubtitleConfig[key] !== null) {
                        // 保留原有的值
                        mergedConfig[key] = config.titleSubtitleConfig[key];
                    } else {
                        // 使用默认值
                        mergedConfig[key] = defaultConfig[key];
                    }
                }

                config.titleSubtitleConfig = mergedConfig;

                console.log('[loadTemplate] ✅ 已从模板配置加载标题字幕配置:', {
                    enabled: config.titleSubtitleConfig?.enabled,
                    sourceTitle: config.titleSubtitleConfig?.sourceTitle,
                    linesCount: config.titleSubtitleConfig?.lines?.length
                });
            } catch (error) {
                console.error('[loadTemplate] 加载标题字幕配置失败:', error);
                config.titleSubtitleConfig = getDefaultTitleSubtitleConfig();
            }
        } else {
            // 如果模板中没有titleSubtitleConfig，使用默认配置
            console.log('[loadTemplate] ⚠️ 模板中没有 titleSubtitleConfig，使用默认配置');
            config.titleSubtitleConfig = getDefaultTitleSubtitleConfig();
        }

        // ✨ 将修改后的config保存回模板对象
        template.config = config;

        // 保存到localStorage
        const templateInArray = subtitleTemplates.value.find(t => t.id === template.id);
        if (templateInArray) {
            templateInArray.config = config;
            await saveTemplatesToStorage();
        }

        showTemplateList.value = false;

        // 关键修复：加载完成后立即清除标记，允许后续的watch保存
        currentLoadedTemplateId.value = '';

        Message.success('模板加载成功');
    } catch (error) {
        console.error('加载模板失败:', error);
        Message.error('加载模板失败');
        // 错误时也要清除标记
        currentLoadedTemplateId.value = '';
    }
};

// 删除模板
const deleteTemplate = async (templateId: string) => {
    const index = subtitleTemplates.value.findIndex(t => t.id === templateId);
    if (index > -1) {
        const template = subtitleTemplates.value[index];
        const templateName = template.name;
        const isSystemTemplate = template.is_system === 1;

        try {
            // 如果是系统模板，需要调用后端API
            if (true) {
                console.log('[deleteTemplate] 删除系统模板:', templateId, '开发模式:', isDev.value);

                if (isSystemTemplate && !isDev.value) {
                    Message.error('系统默认模板不能删除');
                    return;
                }

                // 调用后端 API 删除系统模板
                const result = await window.$mapi.ipAgent.deleteSubtitleTemplate({
                    id: templateId,
                    isDev: isDev.value
                });

                if (!result.success) {
                    Message.error(result.message || '删除模板失败');
                    console.error('[deleteTemplate] 删除系统模板失败:', result.message);
                    return;
                }
                console.log('[deleteTemplate] ✅ 系统模板已删除:', templateName);
            }

            // 从本地数组移除
            subtitleTemplates.value.splice(index, 1);

            // 保存到存储
            await saveTemplatesToStorage();

            Message.success(`模板"${templateName}"已删除`);
            console.log('[deleteTemplate] 模板已从本地移除:', templateName);
        } catch (error) {
            Message.error('删除模板失败: ' + (error?.message || '未知错误'));
            console.error('[deleteTemplate] 删除模板异常:', error);
        }
    }
};

// 初始化时加载模板列表
onMounted(async () => {
    await loadSubtitleTemplates();

    // 🆕 将字幕预览生成函数暴露给全局，供 SettingMixCut 调用
    (window as any).$videoIPAgent = {
        generateSubtitlePreview,
        getScriptContent: () => scriptContent.value,  // 🆕 暴露获取文案内容的函数
        getSrtFilePath: () => srtFile.value,  // 🆕 暴露获取SRT文件路径的函数
        generateFullSubtitle  // 🆕 暴露完整字幕生成函数
    };
});

// 选择背景音乐文件
const selectBGMFile = async () => {
    try {
        const result = await window.$mapi.ipAgent.selectMusicFile();
        if (result.success && result.filePath) {
            selectedBGMPath.value = result.filePath;
            Message.success(t("音乐文件已选择"));
            // 停止当前播放的音乐
            stopBGMPreview();
        }
    } catch (error) {
        console.error("选择音乐失败:", error);
        Message.error(t("选择音乐失败"));
    }
};

// 试听背景音乐
const previewBGM = () => {
    if (!selectedBGMPath.value) {
        Message.warning(t("请先选择音乐文件"));
        return;
    }

    try {
        // 如果正在播放，则停止
        if (isPlayingBGM.value && bgmAudioPlayer.value) {
            stopBGMPreview();
            return;
        }

        // 创建或重用音频播放器
        if (!bgmAudioPlayer.value) {
            bgmAudioPlayer.value = new Audio();

            // 监听播放结束事件
            bgmAudioPlayer.value.addEventListener('ended', () => {
                isPlayingBGM.value = false;
            });

            // 监听错误事件
            bgmAudioPlayer.value.addEventListener('error', (e) => {
                console.error("音乐播放失败:", e);
                Message.error(t("音乐播放失败"));
                isPlayingBGM.value = false;
            });
        }

        // 设置音频源并播放
        bgmAudioPlayer.value.src = selectedBGMPath.value;
        bgmAudioPlayer.value.volume = bgmVolume.value / 100;
        bgmAudioPlayer.value.play();
        isPlayingBGM.value = true;

    } catch (error) {
        console.error("试听音乐失败:", error);
        Message.error(t("试听音乐失败"));
        isPlayingBGM.value = false;
    }
};

// 停止试听背景音乐
const stopBGMPreview = () => {
    if (bgmAudioPlayer.value) {
        bgmAudioPlayer.value.pause();
        bgmAudioPlayer.value.currentTime = 0;
        isPlayingBGM.value = false;
    }
};

// 加载系统乐库列表
const loadSystemBGMList = async () => {
    isLoadingBGMList.value = true;
    try {
        // 获取bgm目录路径（兼容开发环境和生产环境）
        let bgmDir: string;
        try {
            bgmDir = await window.$mapi.file.getBGMDir();
            console.log("[系统乐库] getBGMDir 返回路径:", bgmDir);
        } catch (e) {
            // 回退：使用 process.cwd() + /bgm
            bgmDir = await ipcRenderer.invoke('path:join', process.cwd(), 'bgm');
            console.log("[系统乐库] getBGMDir 失败，回退路径:", bgmDir);
        }

        const entries = await window.$mapi.file.readDir(bgmDir, {extensions: ['mp3', 'wav', 'flac', 'aac']});
        console.log("[系统乐库] bgm目录条目数:", entries.length, entries.map(e => e.name));

        // 按分类组织
        const categories: { name: string; files: { name: string; path: string }[] }[] = [];
        const rootFiles: { name: string; path: string }[] = [];

        for (const entry of entries) {
            if (entry.isDirectory) {
                // 读取子目录中的音乐文件
                const subEntries = await window.$mapi.file.readDir(entry.path, {extensions: ['mp3', 'wav', 'flac', 'aac']});
                const files = subEntries
                    .filter(e => !e.isDirectory)
                    .map(e => ({name: e.name, path: e.path}));
                console.log(`[系统乐库] 分类 "${entry.name}" 文件数:`, files.length);
                if (files.length > 0) {
                    categories.push({name: entry.name, files});
                }
            } else {
                rootFiles.push({name: entry.name, path: entry.path});
            }
        }

        // 如果有根目录音乐文件，添加一个"推荐"分类
        if (rootFiles.length > 0) {
            categories.unshift({name: '推荐', files: rootFiles});
        }

        console.log("[系统乐库] 最终分类数:", categories.length, categories.map(c => `${c.name}(${c.files.length})`));
        bgmCategories.value = categories;
        if (categories.length > 0 && !selectedBGMCategory.value) {
            selectedBGMCategory.value = categories[0].name;
        }
    } catch (error) {
        console.error("加载系统乐库失败:", error);
        bgmCategories.value = [];
    } finally {
        isLoadingBGMList.value = false;
    }
};

// 选择系统乐库中的音乐
const selectSystemBGM = async (filePath: string) => {
    if (selectedBGMPath.value === filePath) {
        // 点击同一首歌，切换播放/暂停
        if (audioPlayerRef.value) {
            audioPlayerRef.value.doTogglePlayPause();
        }
        return;
    }
    // 点击不同的歌，选中并播放
    selectedBGMPath.value = filePath;
    stopBGMPreview();
    // 等待 AudioPlayer 加载后自动播放
    nextTick(() => {
        setTimeout(() => {
            if (audioPlayerRef.value) {
                audioPlayerRef.value.doPlay();
            }
        }, 100);
    });
    Message.success(t("音乐文件已选择"));
};

// 切换音乐来源
watch(bgmSourceType, (val) => {
    if (val === 'system') {
        if (bgmCategories.value.length === 0) {
            loadSystemBGMList().then(() => {
                nextTick(() => {
                    bgmCategorySelectVisible.value = true;
                });
            });
        } else {
            nextTick(() => {
                bgmCategorySelectVisible.value = true;
            });
        }
    } else if (val === 'local' && !selectedBGMPath.value) {
        selectBGMFile();
    }
});

// 选择上传视频文件（用于生成字幕）
const selectUploadVideoFile = async () => {
    try {
        const result = await window.$mapi.ipAgent.selectVideoFile();
        if (result.success && result.filePath) {
            uploadedVideoPath.value = result.filePath;
            // 同时设置为处理视频URL，以便字幕生成使用
            processedVideoUrl.value = `file://${result.filePath}`;
            Message.success(t("视频文件已选择"));
        }
    } catch (error) {
        console.error("选择视频失败:", error);
        Message.error(t("选择视频失败"));
    }
};

// 清除上传的视频
const clearUploadedVideo = () => {
    uploadedVideoPath.value = "";
    // 如果当前处理视频是上传的视频，也清除它
    if (processedVideoUrl.value && processedVideoUrl.value.includes(uploadedVideoPath.value)) {
        processedVideoUrl.value = "";
    }
    Message.info(t("已清除上传的视频"));
};

// 下载视频
const downloadVideo = async (videoUrl: string, fileName: string) => {
    try {
        Message.info(t("正在下载视频..."));
        const result = await window.$mapi.file.download({
            url: videoUrl,
            fileName: fileName || "video.mp4"
        });

        if (result && result.success) {
            Message.success(t("视频下载成功"));
        } else {
            Message.error(t("视频下载失败"));
        }
    } catch (error) {
        console.error("下载视频失败:", error);
        Message.error(t("下载视频失败：") + (error?.message || t("未知错误")));
    }
};

const formatDate = (dateStr: string | number | Date) => {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return '';
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        return `${month}-${day} ${hours}:${minutes}`;
    } catch {
        return '';
    }
};

const openFileLocation = async (filePath: string) => {
    if (!filePath) return;
    try {
        let cleanPath = filePath.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
        cleanPath = decodeURIComponent(cleanPath);
        await window.$mapi.shell.showItemInFolder(cleanPath);
    } catch (e) {
        console.warn('打开文件位置失败:', e);
    }
};

// 🆕 生成字幕预览（只生成records，不渲染视频）
const generateSubtitlePreview = async (): Promise<{ success: boolean; records?: any[]; error?: string }> => {
    try {
        console.log('[generateSubtitlePreview] 开始生成字幕预览');

        // 检查是否有处理后的视频
        const inputVideo = processedVideoUrl.value;
        if (!inputVideo) {
            console.warn('[generateSubtitlePreview] 未找到处理后的视频');
            return {success: false, error: '请先在视频编辑区域处理视频（步骤3：自动处理）'};
        }

        const originalVideoUrl = inputVideo.replace(/^file:\/\//, '');
        console.log('[generateSubtitlePreview] 使用视频:', originalVideoUrl);

        // 提取音频
        Message.info(t("正在提取音频..."));
        const audioResult = await window.$mapi.ipAgent.extractAudioFromVideo({
            videoPath: originalVideoUrl
        });

        if (!audioResult.success || !audioResult.audioPath) {
            console.error('[generateSubtitlePreview] 音频提取失败:', audioResult);
            return {success: false, error: audioResult.message || '提取音频失败'};
        }

        console.log('[generateSubtitlePreview] 音频提取成功:', audioResult.audioPath);

        let records = [];

        // 根据字幕生成方式选择处理逻辑
        const subtitleMode = setting.configGet('subtitleMode', 'funasr').value;

        console.log('[generateSubtitlePreview] 字幕生成方式:', subtitleMode);

        if (subtitleMode === 'volumeDetect') {
            // 本地音量检测方式
            if (!scriptContent.value || scriptContent.value.trim().length === 0) {
                return {success: false, error: '请先输入文案内容'};
            }

            Message.info(t("正在检测音频段落..."));
            const volumeResult = await (window as any).$mapi.aliyun.audio.detectVolume({
                audioPath: audioResult.audioPath,
                config: {
                    silenceThreshold: -50,
                    minSilenceDuration: 0.5,
                    minSoundDuration: 0.2
                }
            });

            if (!volumeResult.success || !volumeResult.segments || volumeResult.segments.length === 0) {
                return {success: false, error: volumeResult.error || '未检测到声音片段'};
            }

            console.log('[generateSubtitlePreview] 检测到', volumeResult.segments.length, '个声音片段');

            Message.info(t("正在分配文本到音频段落..."));
            const textResult = await (window as any).$mapi.aliyun.audio.allocateText({
                text: scriptContent.value,
                segments: volumeResult.segments
            });

            if (!textResult.success || !textResult.subtitles) {
                return {success: false, error: textResult.error || '文本时间分配失败'};
            }

            records = (textResult.subtitles || []).map((s: any) => ({
                text: s.text,
                start: (s.startTime || s.start) * 1000,
                end: (s.endTime || s.end) * 1000,
                words: s.words?.map((w: any) => ({
                    word: w.word || w.text,
                    start: (w.start || 0) * 1000,
                    end: (w.end || 0) * 1000
                })) || []
            }));
        } else {
            // FUNASR在线识别
            Message.info(t("正在进行语音识别..."));

            if (settings.value.asrMode === 'online') {
                // 使用在线模型（FunASR）
                const {useModelStore} = await import("../../module/Model/store/model");
                const modelStore = useModelStore();
                const dashscopeProvider = modelStore.providers.find(p => p.id === 'dashscope');
                const aliyunApiKey = dashscopeProvider?.data?.apiKey || getSystemConfigSync().aliyun_bailian_api_key;

                const _sysOssCfg = getSystemConfigSync();
                const ossConfig = dashscopeProvider?.data?.ossAccessKeyId ? {
                    accessKeyId: dashscopeProvider.data.ossAccessKeyId,
                    accessKeySecret: dashscopeProvider.data.ossAccessKeySecret,
                    bucket: dashscopeProvider.data.ossBucket,
                    region: dashscopeProvider.data.ossRegion,
                    endpoint: dashscopeProvider.data.ossEndpoint
                } : {
                    accessKeyId: _sysOssCfg.aliyun_oss_access_key_id,
                    accessKeySecret: _sysOssCfg.aliyun_oss_access_key_secret,
                    bucket: _sysOssCfg.aliyun_oss_bucket,
                    region: _sysOssCfg.aliyun_oss_region,
                    endpoint: `oss-${_sysOssCfg.aliyun_oss_region}.aliyuncs.com`
                };

                const asrResult: any = await ipcRenderer.invoke('aliyun:funasr:recognize', {
                    audioPath: audioResult.audioPath,
                    config: {
                        apiKey: aliyunApiKey,
                        ossConfig: ossConfig || undefined,
                        model: 'qwen3-asr-flash-filetrans',  // 使用 Qwen3 ASR 模型（文件转写）
                        format: 'wav',
                        sampleRate: 16000
                    }
                });

                if (!asrResult.success || !asrResult.sentences) {
                    return {success: false, error: asrResult.message || asrResult.error || '语音识别失败'};
                }

                records = asrResult.sentences.map((s: any) => ({
                    text: s.text,
                    start: s.begin_time,
                    end: s.end_time,
                    words: s.words || []
                }));
            } else {
                // 本地ASR服务器
                const {useServerStore} = await import("../../store/modules/server");
                const serverStore = useServerStore();
                const server = await serverStore.getByKey(settings.value.asrServerKey);

                if (!server) {
                    return {success: false, error: 'ASR服务器未找到'};
                }

                const serverInfo = await serverStore.serverInfo(server);
                const asrResult = await serverStore.call(serverInfo, "asr", {
                    id: serverStore.generateTaskId("VideoSubtitleASR", Date.now()),
                    audio: audioResult.audioPath,
                    param: {}
                });

                if (asrResult.code !== 0 || asrResult.data?.type !== 'success') {
                    return {success: false, error: asrResult.msg || '语音识别失败'};
                }

                records = asrResult.data?.data?.records || [];
            }
        }

        if (records.length === 0) {
            return {success: false, error: '未识别到语音内容'};
        }

        console.log('[generateSubtitlePreview] 生成了', records.length, '条字幕记录');

        await window.$mapi.file.write("cache-subtitle-records.json", JSON.stringify(records));

        return {success: true, records};
    } catch (error: any) {
        console.error('[generateSubtitlePreview] 生成失败:', error);
        return {success: false, error: error.message || '未知错误'};
    }
};

// 🆕 生成完整的字幕文件（SRT格式）- 用于字幕模式
const generateFullSubtitle = async (): Promise<{ success: boolean; srtPath?: string; error?: string }> => {
    try {
        console.log('[generateFullSubtitle] 开始生成完整字幕文件');

        // 🔧 修复：使用步骤2生成的语音文件，而不是从视频提取音频
        if (!audioPreviewUrl.value) {
            console.warn('[generateFullSubtitle] 未找到生成的语音文件');
            return {success: false, error: '请先在步骤2生成语音'};
        }

        const audioPath = audioPreviewUrl.value.replace(/^file:\/\//, '');
        console.log('[generateFullSubtitle] 使用语音文件:', audioPath);

        // 🔧 修复：需要视频文件来生成SRT（ZimuShengcheng需要视频尺寸）
        if (!videoPreviewUrl.value) {
            console.error('[generateFullSubtitle] 未找到口播视频');
            return {success: false, error: '请先在步骤2生成口播视频'};
        }

        const videoPath = videoPreviewUrl.value.replace(/^file:\/\//, '');
        console.log('[generateFullSubtitle] 使用视频文件:', videoPath);

        // 根据字幕生成方式选择处理逻辑
        const subtitleMode = setting.configGet('subtitleMode', 'funasr').value;
        console.log('[generateFullSubtitle] 字幕生成方式:', subtitleMode);

        let records = [];
        let shouldSkipUserTextCorrection = subtitleMode === 'volumeDetect';


        if (subtitleMode === 'volumeDetect') {
            // 本地音量检测方式
            if (!scriptContent.value || scriptContent.value.trim().length === 0) {
                return {success: false, error: '请先输入文案内容'};
            }

            Message.info(t("正在检测音频段落..."));
            const volumeResult = await (window as any).$mapi.aliyun.audio.detectVolume({
                audioPath: audioPath,
                config: {
                    silenceThreshold: -50,
                    minSilenceDuration: 0.5,
                    minSoundDuration: 0.2
                }
            });

            if (!volumeResult.success || !volumeResult.segments || volumeResult.segments.length === 0) {
                return {success: false, error: volumeResult.error || '未检测到声音片段'};
            }

            console.log('[generateFullSubtitle] 检测到', volumeResult.segments.length, '个声音片段');

            Message.info(t("正在分配文本到音频段落..."));
            const textResult = await (window as any).$mapi.aliyun.audio.allocateText({
                text: scriptContent.value,
                segments: volumeResult.segments
            });

            if (!textResult.success || !textResult.subtitles) {
                return {success: false, error: textResult.error || '文本时间分配失败'};
            }

            records = (textResult.subtitles || []).map((s: any) => ({
                text: s.text,
                start: (s.startTime || s.start),
                end: (s.endTime || s.end)
            }));
        } else {
            // FUNASR在线识别
            Message.info(t("正在进行语音识别..."));

            if (settings.value.asrMode === 'online') {
                // 使用在线模型（FunASR）
                const {useModelStore} = await import("../../module/Model/store/model");
                const modelStore = useModelStore();
                const dashscopeProvider = modelStore.providers.find(p => p.id === 'dashscope');
                const aliyunApiKey = dashscopeProvider?.data?.apiKey || getSystemConfigSync().aliyun_bailian_api_key;

                const _sysOssCfg2 = getSystemConfigSync();
                const ossConfig = (dashscopeProvider?.data?.ossAccessKeyId) ? {
                    accessKeyId: dashscopeProvider.data.ossAccessKeyId,
                    accessKeySecret: dashscopeProvider.data.ossAccessKeySecret,
                    bucket: dashscopeProvider.data.ossBucket,
                    region: dashscopeProvider.data.ossRegion,
                    endpoint: dashscopeProvider.data.ossEndpoint
                } : {
                    accessKeyId: _sysOssCfg2.aliyun_oss_access_key_id,
                    accessKeySecret: _sysOssCfg2.aliyun_oss_access_key_secret,
                    bucket: _sysOssCfg2.aliyun_oss_bucket,
                    region: _sysOssCfg2.aliyun_oss_region,
                    endpoint: `oss-${_sysOssCfg2.aliyun_oss_region}.aliyuncs.com`
                };

                const asrResult: any = await ipcRenderer.invoke('aliyun:funasr:recognize', {
                    audioPath: audioPath,
                    config: {
                        apiKey: aliyunApiKey,
                        ossConfig: ossConfig
                    }
                });

                console.log('[generateFullSubtitle] ASR识别返回结果:', asrResult);

                if (!asrResult.success) {
                    console.error('[generateFullSubtitle] ASR识别失败:', asrResult);
                    return {success: false, error: asrResult.message || asrResult.error || 'ASR识别失败'};
                }

                if (!asrResult.sentences || !Array.isArray(asrResult.sentences)) {
                    console.error('[generateFullSubtitle] ASR返回数据格式错误:', asrResult);
                    return {success: false, error: 'ASR返回数据格式错误'};
                }

                // 🔧 关键修复：检查并修正时间字段
                console.log('[generateFullSubtitle] ASR sentences 示例:', asrResult.sentences[0]);

                records = asrResult.sentences.map((item: any) => {
                    // 兼容不同的字段名
                    let start = item.startTime ?? item.start ?? item.begin_time ?? 0;
                    let end = item.endTime ?? item.end ?? item.end_time ?? 0;

                    // 🔧 关键修复：检查时间单位，如果小于1000，可能是秒，需要转换为毫秒
                    if (start < 1000 && start > 0) {
                        console.warn('[generateFullSubtitle] startTime 疑似为秒，转换为毫秒:', start);
                        start = start * 1000;
                    }
                    if (end < 1000 && end > 0) {
                        console.warn('[generateFullSubtitle] endTime 疑似为秒，转换为毫秒:', end);
                        end = end * 1000;
                    }

                    // 🔧 关键修复：如果 start > end，交换它们
                    const actualStart = Math.min(start, end);
                    const actualEnd = Math.max(start, end);

                    console.log('[generateFullSubtitle] 处理记录:', {
                        text: item.text?.substring(0, 20) + '...',
                        原始start: item.startTime ?? item.start,
                        原始end: item.endTime ?? item.end,
                        修正后start: actualStart,
                        修正后end: actualEnd
                    });

                    return {
                        text: item.text,
                        start: actualStart,
                        end: actualEnd
                    };
                });

                console.log('[generateFullSubtitle] 转换后的 records:', records);

                // 🔧 新增：如果句子太少（<5个），尝试使用词级时间戳或用户文案重新分割
                if (records.length < 5) {
                    console.warn('[generateFullSubtitle] 句子数量太少 (', records.length, ')，尝试重新分割');

                    let usedWordLevelSplit = false;
                    let allWords: any[] = [];
                    for (const sentence of asrResult.sentences) {
                        if (sentence.words && Array.isArray(sentence.words)) {
                            allWords.push(...sentence.words);
                        }
                    }

                    if (allWords.length > 0) {
                        console.log('[generateFullSubtitle] 使用词级时间戳重新分割，共', allWords.length, '个词');

                        const newRecords: any[] = [];
                        let currentText = '';
                        let currentStart = 0;
                        let currentEnd = 0;
                        let isFirst = true;

                        for (let i = 0; i < allWords.length; i++) {
                            const word = allWords[i];
                            const wordText = word.text || '';

                            if (isFirst) {
                                currentStart = word.begin_time || word.startTime || 0;
                                isFirst = false;
                            }

                            currentText += wordText;
                            currentEnd = word.end_time || word.endTime || 0;

                            const isPunctuation = /[，。！？、；]/.test(wordText);
                            const isLastWord = i === allWords.length - 1;

                            if (isPunctuation || isLastWord) {
                                if (currentText.trim().length > 0) {
                                    newRecords.push({
                                        text: currentText.trim(),
                                        start: currentStart,
                                        end: currentEnd
                                    });
                                }
                                currentText = '';
                                isFirst = true;
                            }
                        }

                        if (newRecords.length > records.length) {
                            console.log('[generateFullSubtitle] 词级分割成功：从', records.length, '个句子增加到', newRecords.length, '个');
                            shouldSkipUserTextCorrection = true;
                            usedWordLevelSplit = true;
                            records = newRecords;
                        }
                    }

                    if (!usedWordLevelSplit && scriptContent.value && scriptContent.value.trim().length > 0) {
                        console.log('[generateFullSubtitle] 词级分割不足，回退到文案切段');

                        const userLines = splitScriptIntoSubtitleLines(scriptContent.value, 14);
                        console.log('[generateFullSubtitle] 用户文案分割为', userLines.length, '行');

                        if (userLines.length > records.length) {
                            let totalDuration = records[records.length - 1].end - records[0].start;

                            try {
                                console.log('[generateFullSubtitle] 尝试获取音频时长，文件路径:', audioPath);
                                const {ffprobeGetMediaDuration} = await import('../../lib/ffprobe');
                                const audioDuration = await ffprobeGetMediaDuration(audioPath, false);

                                if (audioDuration > 0) {
                                    totalDuration = audioDuration * 1000;
                                    console.log('[generateFullSubtitle] ✅ 使用音频实际时长:', audioDuration, '秒 (', totalDuration, 'ms)');
                                } else {
                                    console.warn('[generateFullSubtitle] 音频时长无效:', audioDuration);
                                }
                            } catch (error) {
                                console.error('[generateFullSubtitle] 获取音频时长失败:', error);
                                console.warn('[generateFullSubtitle] 使用 ASR 返回的时间范围:', totalDuration, 'ms');
                            }

                            const totalText = userLines.join('');
                            const newRecords: any[] = [];
                            let currentTime = 0;

                            for (const line of userLines) {
                                const lineDuration = (line.length / totalText.length) * totalDuration;
                                newRecords.push({
                                    text: line,
                                    start: currentTime,
                                    end: currentTime + lineDuration
                                });
                                currentTime += lineDuration;
                            }

                            console.log('[generateFullSubtitle] 文案分割成功：从', records.length, '个句子增加到', newRecords.length, '个');
                            console.log('[generateFullSubtitle] 时间范围: 0 -', (currentTime / 1000).toFixed(2), '秒');
                            shouldSkipUserTextCorrection = true;
                            records = newRecords;
                        }
                    }
                }


                // 🔧 新增：修正第一个句子的开始时间，应该从 0 或接近 0 开始
                if (records.length > 0 && records[0].start > 1000) {
                    console.warn('[generateFullSubtitle] 第一个句子的开始时间异常:', records[0].start, '毫秒，修正为 0');
                    const offset = records[0].start;
                    // 所有时间都减去偏移量
                    records = records.map(r => ({
                        text: r.text,
                        start: Math.max(0, r.start - offset),
                        end: Math.max(0, r.end - offset)
                    }));
                    console.log('[generateFullSubtitle] 时间偏移修正完成，第一个句子:', records[0]);
                }
            } else {
                // 使用本地模型
                if (!settings.value.asrModelKey) {
                    return {success: false, error: '请先在设置中配置语音识别模型'};
                }

                const server = await serverStore.getByKey(settings.value.asrModelKey);
                if (!server) {
                    return {success: false, error: '未找到语音识别模型'};
                }

                const serverInfo = await serverStore.serverInfo(server);
                const asrResult = await serverStore.call(serverInfo, "asr", {
                    id: serverStore.generateTaskId("VideoSubtitleASR", Date.now()),
                    audio: audioPath,
                    param: {}
                });

                if (asrResult.code !== 0 || asrResult.data?.type !== 'success') {
                    return {success: false, error: asrResult.msg || '语音识别失败'};
                }

                records = (asrResult.data.data || []).map((item: any) => ({
                    text: item.text,
                    start: item.start,
                    end: item.end
                }));
            }
        }

        if (records.length === 0) {
            return {success: false, error: '未识别到语音内容'};
        }

        console.log('[generateFullSubtitle] 识别完成，共', records.length, '条记录');
        console.log('[generateFullSubtitle] records 示例:', records.slice(0, 3));

        // 🔧 修复：使用 ZimuShengcheng.generate() 生成SRT，和05生成字幕使用相同逻辑
        Message.info(t("正在生成字幕文件..."));

        const service = new ZimuShengcheng();

        // 获取视频尺寸
        let videoWidth = 1920;
        let videoHeight = 1080;
        try {
            const videoInfo = await ffprobeVideoInfo(videoPath);
            if (videoInfo && videoInfo.width && videoInfo.height) {
                videoWidth = videoInfo.width;
                videoHeight = videoInfo.height;
                console.log('[generateFullSubtitle] 获取到视频尺寸:', videoWidth, 'x', videoHeight);
            }
        } catch (error) {
            console.warn('[generateFullSubtitle] 获取视频尺寸失败，使用默认值:', error);
        }

        // 生成输出路径：使用视频所在目录
        const lastSlashIndex = Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\'));
        const videoDir = lastSlashIndex >= 0 ? videoPath.substring(0, lastSlashIndex) : videoPath;
        const timestamp = Date.now();
        const outputPath = `${videoDir}/video_with_subtitle_${timestamp}.mp4`;

        // 获取字幕样式（和 autoGenerateSubtitleAndBGM 使用相同逻辑）
        let subtitleStyleForGeneration = null;

        // 首先从模板配置获取（优先选项）
        if (currentTemplateConfig.value && currentTemplateConfig.value.subtitleStyle) {
            console.log('[generateFullSubtitle] 从模板配置获取样式');
            subtitleStyleForGeneration = {...currentTemplateConfig.value.subtitleStyle};

            // 应用字体大小缩放
            if (subtitleStyleForGeneration.fontSize) {
                subtitleStyleForGeneration.fontSize = Math.round(subtitleStyleForGeneration.fontSize * (subtitleFontSizeScale.value / 100));
            }
        } else {
            // 降级：尝试从组件ref获取
            console.log('[generateFullSubtitle] 尝试从组件获取样式');
            subtitleStyleForGeneration = subtitleStyleSelectorRef.value && subtitleStyleSelectorRef.value.getSelectedStyle?.();
        }

        if (!subtitleStyleForGeneration) {
            console.log('[generateFullSubtitle] 使用默认样式');
            subtitleStyleForGeneration = {
                fontSize: Math.round(48 * (subtitleFontSizeScale.value / 100)),
                fontColor: '#FFFFFF',
                outlineColor: '#000000',
                outlineWidth: 3,
                position: subtitlePosition.value || 'bottom',
                fontName: 'Microsoft YaHei Bold',
                shadowOffset: 2,
                backgroundColor: 'transparent',
                backgroundOpacity: 0
            };
        }

        // 确保使用用户选择的位置
        if (subtitlePosition.value) {
            subtitleStyleForGeneration.position = subtitlePosition.value;
        }

        console.log('[generateFullSubtitle] 最终样式:', subtitleStyleForGeneration);

        console.log('[generateFullSubtitle] 准备调用 ZimuShengcheng.generate');
        console.log('[generateFullSubtitle] 输出路径:', outputPath);

        const zimuResult = await service.generate({
            videoPath: videoPath,
            videoWidth: videoWidth,
            videoHeight: videoHeight,
            userText: scriptContent.value || undefined,
            funasrSegments: records,
            skipTextCorrection: shouldSkipUserTextCorrection,
            subtitleStyle: subtitleStyleForGeneration,
            keywordGroups: [],
            fontDir: '',
            outputPath: outputPath,
            minSubtitleDuration: settings.value.minSubtitleDuration || 0,
            normalSubtitleX: settings.value.normalSubtitleX || 0,
            normalSubtitleY: settings.value.normalSubtitleY || 0,
            effectSubtitleX: settings.value.effectSubtitleX || 0,
            effectSubtitleY: settings.value.effectSubtitleY || 0,
            keywordGroupPositions: {},
            maxCharsPerLine: 20
        });

        console.log('[generateFullSubtitle] ZimuShengcheng.generate 返回结果:', zimuResult);

        if (!zimuResult.success || !zimuResult.srtPath) {
            console.error('[generateFullSubtitle] SRT生成失败:', zimuResult);
            return {success: false, error: zimuResult.message || '生成SRT文件失败'};
        }

        console.log('[generateFullSubtitle] SRT文件生成成功:', zimuResult.srtPath);
        srtFile.value = zimuResult.srtPath;

        Message.success(t('字幕文件生成成功'));
        return {success: true, srtPath: zimuResult.srtPath, records};
    } catch (error: any) {
        console.error('[generateFullSubtitle] 生成失败:', error);
        return {success: false, error: error.message || '生成完整字幕失败'};
    }
};

// 自动生成
// 字幕和BGM自动生成
const autoGenerateSubtitleAndBGM = async (videoFile: string): Promise<void> => {
    if (!enableSubtitle.value && !enableBGM.value) {
        Message.warning(t("请至少勾选一个功能"));
        return;
    }

    // 防止重复点击
    if (isGeneratingSubtitle.value) {
        Message.warning(t("正在处理中,请稍候..."));
        return;
    }

    // 【关键修复】生成字幕必须使用视频编辑区域处理的视频（processedVideoUrl）
    // 不使用生成的口播视频（videoPreviewUrl），只能使用编辑区域的视频
    const inputVideo = processedVideoUrl.value;

    if (!inputVideo) {
        Message.warning(t("请先在视频编辑区域处理视频"));
        return;
    }

    const originalVideoUrl = inputVideo.replace(/^file:\/\//, '');

    console.log('[autoGenerateSubtitleAndBGM] 视频输入选择:', {
        processedVideoUrl: processedVideoUrl.value,
        selectedInputVideo: inputVideo,
        originalVideoUrl: originalVideoUrl,
        note: '生成字幕绝对使用视频编辑区域的视频（processedVideoUrl）'
    });

    try {
        isGeneratingSubtitle.value = true;
        // 🔧 【修复】保存字幕生成状态到本地存储，避免切换页面后状态丢失
        localStorage.setItem('videoIPAgent_isGeneratingSubtitle', 'true');
        // 清除旧的最终视频URL
        finalVideoUrl.value = "";
        localStorage.removeItem('videoIPAgent_finalVideoUrl');

        // 【关键修复】使用原始视频作为输入，避免字幕叠加
        let currentVideo = originalVideoUrl;

        // 保存音频时间戳和路径，用于后续生成最终音频文件
        let originalAudioTimestamp: number | undefined = undefined;
        let originalAudioPath: string | undefined = undefined;

        // 步骤1: 如果勾选了字幕，使用文案生成字幕（优先）或ASR识别
        if (enableSubtitle.value) {
            // 如果没有选择字幕样式，给出提示但继续使用默认样式
            if (!selectedSubtitleStyleId.value) {
                Message.info(t("未选择字幕样式，将使用默认样式"));
                console.log("使用默认字幕样式");
            }

            let srtResult: any = null;
            let records = [];
            let existingSrtPath: string | null = null;
            let shouldSkipTextCorrection = false;
            const subtitleReuseMeta = getSubtitleReuseMeta();

            const tryReuseRecords = async (candidateRecords: any[], source: string) => {
                if (!Array.isArray(candidateRecords) || candidateRecords.length === 0) {
                    return false;
                }


                const normalizedCurrentVideo = normalizeSubtitleVideoPath(currentVideo);
                const normalizedCurrentText = normalizeSubtitleCacheText(scriptContent.value || '');
                const fastPathTextSimilarity = subtitleReuseMeta?.scriptText && normalizedCurrentText
                    ? LevenshteinMatcher.similarity(subtitleReuseMeta.scriptText, normalizedCurrentText)
                    : 1;
                const hitCurrentSessionFastPath = !!subtitleReuseMeta
                    && subtitleReuseMeta.videoPath === normalizedCurrentVideo
                    && fastPathTextSimilarity >= 0.45
                    && (source !== 'current-srtFile' || !subtitleReuseMeta.srtPath || subtitleReuseMeta.srtPath === existingSrtPath);

                if (hitCurrentSessionFastPath) {
                    shouldSkipTextCorrection = true;
                    records = candidateRecords.map((item: any) => ({
                        text: item.text,
                        start: item.start,
                        end: item.end,
                        words: item.words || [],
                    }));

                    console.log('[autoGenerateSubtitleAndBGM] ✅ 命中当前会话字幕复用快速路径:', {
                        source,
                        count: records.length,
                        fastPathTextSimilarity,
                        srtPath: existingSrtPath || subtitleReuseMeta?.srtPath || '',
                    });
                    return true;
                }

                const validation = await validateCachedSubtitleRecords(
                    candidateRecords,
                    currentVideo,
                    scriptContent.value
                );

                console.log('[autoGenerateSubtitleAndBGM] 字幕复用校验:', {
                    source,
                    valid: validation.valid,
                    reason: validation.reason,
                    similarity: validation.similarity,
                    durationDelta: validation.durationDelta,
                    recordsCount: candidateRecords.length,
                });

                if (!validation.valid) {
                    return false;
                }

                shouldSkipTextCorrection = true;
                records = candidateRecords.map((item: any) => ({
                    text: item.text,
                    start: item.start,
                    end: item.end,
                    words: item.words || [],
                }));

                console.log('[autoGenerateSubtitleAndBGM] ✅ 复用字幕数据成功:', {source, count: records.length});
                return true;
            };

            // 1. 优先复用当前内存中的字幕分段
            await tryReuseRecords(funasrSegments.value as any[], 'memory-funasrSegments');

            // 2. 其次复用当前已经生成好的字幕文件
            if (records.length === 0 && srtFile.value) {
                try {
                    const fs = await import('fs');
                    if (fs.existsSync(srtFile.value)) {
                        existingSrtPath = srtFile.value;
                        console.log('[autoGenerateSubtitleAndBGM] ✅ 复用当前字幕文件:', existingSrtPath);
                    }
                } catch (error) {
                    console.warn('[autoGenerateSubtitleAndBGM] 检查当前字幕文件失败:', error);
                }
            }

            if (records.length === 0 && existingSrtPath) {
                try {
                    console.log('[autoGenerateSubtitleAndBGM] 解析 SRT 文件:', existingSrtPath);
                    const fs = await import('fs');
                    const srtContent = fs.readFileSync(existingSrtPath, 'utf-8');
                    const parsedSrtRecords = parseSrtToRecords(srtContent);
                    await tryReuseRecords(parsedSrtRecords, 'current-srtFile');
                } catch (error) {
                    console.error('[autoGenerateSubtitleAndBGM] 解析 SRT 文件失败:', error);
                    Message.error(t('解析字幕文件失败，将重新进行语音识别'));
                    existingSrtPath = null;
                }
            }

            // 3. 最后才尝试复用磁盘缓存
            if (records.length === 0) {
                try {
                    const cachedRecords = await window.$mapi.file.read("cache-subtitle-records.json");
                    if (cachedRecords) {
                        const parsed = JSON.parse(cachedRecords);
                        await tryReuseRecords(parsed, 'disk-cache');
                    }
                } catch (e) {
                    console.warn('[autoGenerateSubtitleAndBGM] 读取缓存字幕数据失败:', e);
                }
            }

            if (records.length > 0) {
                console.log('[autoGenerateSubtitleAndBGM] 使用已复用的字幕数据，跳过音频提取和ASR识别');
                Message.success(t("复用已生成的字幕数据，跳过语音识别"));
            } else {

                // 从视频提取音频（支持缓存）
                Message.info(t("正在检查音频文件..."));

                const audioResult = await window.$mapi.ipAgent.extractAudioFromVideo({
                    videoPath: currentVideo.replace(/^file:\/\//, '')
                });

                if (!audioResult.success || !audioResult.audioPath) {
                    Message.error(audioResult.message || t("提取音频失败"));
                    return;
                }

                if (audioResult.cached) {
                    Message.success(t("使用已缓存的音频文件，跳过提取步骤"));
                    console.log('音频缓存命中:', audioResult.audioPath);
                } else {
                    Message.success(t("音频提取完成"));
                    console.log('新提取音频:', audioResult.audioPath);
                }

                // 如果没有可复用字幕，才进行语音识别
                console.log('[autoGenerateSubtitleAndBGM] 未找到可复用字幕，开始ASR识别');

                // 🆕 根据字幕生成方式选择处理逻辑
                const subtitleMode = setting.configGet('subtitleMode', 'funasr').value;

                console.log('[autoGenerateSubtitleAndBGM] 字幕生成方式:', subtitleMode);

                if (subtitleMode === 'volumeDetect') {
                    // ========== 方式2: 本地音量检测 ==========
                    console.log('[autoGenerateSubtitleAndBGM] 使用本地音量检测方式');
                    Message.info(t("使用本地音量检测..."));

                    if (!scriptContent.value || scriptContent.value.trim().length === 0) {
                        Message.error(t("请先输入文案内容"));
                        return;
                    }

                    try {
                        // 检测音频段落
                        console.log('[autoGenerateSubtitleAndBGM] 开始检测音频段落...');
                        console.log('[autoGenerateSubtitleAndBGM] 音频文件路径:', audioResult.audioPath);

                        const volumeResult = await (window as any).$mapi.aliyun.audio.detectVolume({
                            audioPath: audioResult.audioPath,
                            config: {
                                silenceThreshold: -50,  // 🔧 降低阈值，使其更宽松，避免漏掉较小的声音
                                minSilenceDuration: 0.5,
                                minSoundDuration: 0.2   // 🔧 降低最小声音时长，捕捉更短的声音段
                            }
                        });

                        console.log('[autoGenerateSubtitleAndBGM] 音量检测结果:', volumeResult);

                        if (!volumeResult.success || !volumeResult.segments || volumeResult.segments.length === 0) {
                            Message.error(t("音量检测失败: ") + (volumeResult.error || t("未检测到声音片段")));
                            return;
                        }

                        console.log(`[autoGenerateSubtitleAndBGM] ✅ 音量检测完成，检测到 ${volumeResult.segments.length} 个声音片段`);

                        // 🔍 输出检测到的声音片段详情
                        console.log('\n========== 🔊 检测到的声音片段 ==========');
                        volumeResult.segments.forEach((seg: any, idx: number) => {
                            console.log(`  片段${idx + 1}: ${seg.startTime.toFixed(2)}s - ${seg.endTime.toFixed(2)}s (${seg.duration.toFixed(2)}s)`);
                        });
                        console.log('=========================================\n');

                        // 分配文本到音频段落
                        console.log('[autoGenerateSubtitleAndBGM] 开始分配文本到音频段落...');
                        const textResult = await (window as any).$mapi.aliyun.audio.allocateText({
                            text: scriptContent.value,
                            segments: volumeResult.segments
                        });

                        if (!textResult.success || !textResult.subtitles) {
                            Message.error(t("文本时间分配失败: ") + (textResult.error || t("未知错误")));
                            return;
                        }

                        console.log(`[autoGenerateSubtitleAndBGM] ✅ 文本时间分配完成，生成 ${textResult.subtitles.length} 条字幕`);

                        // 🔍 输出分配后的字幕时间
                        console.log('\n========== 📝 分配后的字幕 ==========');
                        textResult.subtitles.forEach((s: any, idx: number) => {
                            // 🔧 安全检查
                            if (!s) {
                                console.error(`⚠️ 字幕${idx + 1}对象为空`);
                                return;
                            }
                            const startTime = s.startTime ?? s.start;
                            const endTime = s.endTime ?? s.end;
                            if (typeof startTime !== 'number' || typeof endTime !== 'number') {
                                console.error(`⚠️ 字幕${idx + 1}时间数据异常:`, {
                                    startTime: s.startTime,
                                    start: s.start,
                                    endTime: s.endTime,
                                    end: s.end,
                                    text: s.text?.substring(0, 30)
                                });
                                return;
                            }
                            const preview = s.text?.substring(0, 40) + (s.text?.length > 40 ? '...' : '');
                            console.log(`  字幕${idx + 1}: ${startTime.toFixed(2)}s - ${endTime.toFixed(2)}s | "${preview}"`);
                        });
                        console.log('=====================================\n');

                        // 转换为 records 格式（兼容后续逻辑）
                        shouldSkipTextCorrection = true;
                        records = (textResult.subtitles || []).map((s: any, index: number) => ({
                            text: s.text,
                            start: (s.startTime || s.start) * 1000,  // 转换为毫秒
                            end: (s.endTime || s.end) * 1000,        // 转换为毫秒
                            words: s.words?.map((w: any) => ({
                                word: w.word || w.text,
                                start: (w.start || 0) * 1000,  // 转换为毫秒
                                end: (w.end || 0) * 1000       // 转换为毫秒
                            })) || []
                        }));

                        console.log('[autoGenerateSubtitleAndBGM] 本地音量检测方式处理完成，records数量:', records.length);

                        // 🔍 输出转换后的records时间（毫秒）
                        console.log('\n========== 📝 转换后的records（毫秒） ==========');
                        records.slice(0, 5).forEach((r: any, idx: number) => {
                            const preview = r.text.substring(0, 40) + (r.text.length > 40 ? '...' : '');
                            console.log(`  Record${idx + 1}: ${r.start}ms - ${r.end}ms (${(r.start / 1000).toFixed(2)}s - ${(r.end / 1000).toFixed(2)}s) | "${preview}"`);
                        });
                        console.log('===============================================\n');

                    } catch (error: any) {
                        console.error('[autoGenerateSubtitleAndBGM] 本地音量检测失败:', error);
                        Message.error(t("本地音量检测失败: ") + (error.message || error));
                        return;
                    }
                } else {
                    // ========== 方式1: FUNASR在线识别（默认） ==========
                    Message.info(t("正在进行语音识别..."));

                    // 🔧 根据设置的模式选择ASR方式
                    if (settings.value.asrMode === 'online') {
                        // 使用在线模型（FunASR）
                        console.log('[autoGenerateSubtitleAndBGM] 使用在线模式 - FunASR');
                        Message.info(t("使用FunASR进行语音识别..."));

                        // 1. 获取阿里云配置 (API Key 和 OSS Config)
                        const {useModelStore} = await import("../../module/Model/store/model");
                        const modelStore = useModelStore();
                        const dashscopeProvider = modelStore.providers.find(p => p.id === 'dashscope');
                        // 🔧 如果用户没配置，使用内置的硬编码 API Key
                        const aliyunApiKey = dashscopeProvider?.data?.apiKey || getSystemConfigSync().aliyun_bailian_api_key;

                        const _sysOssCfg3 = getSystemConfigSync();
                        const ossConfig = dashscopeProvider?.data?.ossAccessKeyId ? {
                            accessKeyId: dashscopeProvider.data.ossAccessKeyId,
                            accessKeySecret: dashscopeProvider.data.ossAccessKeySecret,
                            bucket: dashscopeProvider.data.ossBucket,
                            region: dashscopeProvider.data.ossRegion,
                            endpoint: dashscopeProvider.data.ossEndpoint
                        } : {
                            accessKeyId: _sysOssCfg3.aliyun_oss_access_key_id,
                            accessKeySecret: _sysOssCfg3.aliyun_oss_access_key_secret,
                            bucket: _sysOssCfg3.aliyun_oss_bucket,
                            region: _sysOssCfg3.aliyun_oss_region,
                            endpoint: `oss-${_sysOssCfg3.aliyun_oss_region}.aliyuncs.com`
                        };


                        // 2. 调用 FunASR (直接使用ipcRenderer，避免$mapi未定义问题)
                        console.log('[autoGenerateSubtitleAndBGM] 调用 aliyun:funasr:recognize IPC接口');
                        const asrResult: any = await ipcRenderer.invoke('aliyun:funasr:recognize', {
                            audioPath: audioResult.audioPath,
                            config: {
                                apiKey: aliyunApiKey,
                                ossConfig: ossConfig || undefined,
                                model: 'qwen3-asr-flash-filetrans',  // 使用 Qwen3 ASR 模型（文件转写）
                                format: 'wav',
                                sampleRate: 16000
                            }
                        });

                        if (!asrResult.success || !asrResult.sentences) {
                            Message.error(t("语音识别失败: ") + (asrResult.message || asrResult.error || t("未知错误")));
                            return;
                        }

                        // 转换FunASR结果格式(Ref: aliyun/main.ts line 108)
                        // 后端返回的是 { success, fullText, sentences, error, requestId }
                        // sentences结构: { text, startTime, endTime, words: [...] } (单位: 毫秒)
                        // ZimuShengcheng期望: { text, start, end, words: [...] } (单位: 毫秒 - 内部会自动转换为秒)
                        records = (asrResult.sentences || []).map((s: any) => ({
                            text: s.text,
                            start: s.startTime,
                            end: s.endTime,
                            words: s.words?.map((w: any) => ({
                                word: w.text,
                                start: w.startTime,
                                end: w.endTime
                            }))
                        }));

                        if (records.length === 0 && asrResult.fullText) {
                            records = [{
                                text: asrResult.fullText,
                                start: 0,
                                end: 0,
                                words: []
                            }];
                        }

                        if (records.length < 5) {
                            let usedWordLevelSplit = false;
                            const allWords: any[] = [];
                            for (const sentence of asrResult.sentences || []) {
                                if (Array.isArray(sentence.words)) {
                                    allWords.push(...sentence.words);
                                }
                            }

                            if (allWords.length > 0) {
                                const newRecords: any[] = [];
                                let currentText = '';
                                let currentStart = 0;
                                let currentEnd = 0;
                                let isFirst = true;

                                for (let i = 0; i < allWords.length; i++) {
                                    const word = allWords[i];
                                    const wordText = word.text || '';
                                    if (isFirst) {
                                        currentStart = word.begin_time || word.startTime || 0;
                                        isFirst = false;
                                    }
                                    currentText += wordText;
                                    currentEnd = word.end_time || word.endTime || 0;
                                    const isPunctuation = /[，。！？、；]/.test(wordText);
                                    const isLastWord = i === allWords.length - 1;
                                    if (isPunctuation || isLastWord) {
                                        if (currentText.trim().length > 0) {
                                            newRecords.push({
                                                text: currentText.trim(),
                                                start: currentStart,
                                                end: currentEnd,
                                                words: []
                                            });
                                        }
                                        currentText = '';
                                        isFirst = true;
                                    }
                                }

                                if (newRecords.length > records.length) {
                                    shouldSkipTextCorrection = true;
                                    usedWordLevelSplit = true;
                                    records = newRecords;
                                }
                            }

                            if (!usedWordLevelSplit && scriptContent.value && scriptContent.value.trim().length > 0 && records.length > 0) {
                                const userLines = splitScriptIntoSubtitleLines(scriptContent.value, 14);

                                if (userLines.length > records.length) {
                                    const totalDuration = Math.max(0, records[records.length - 1].end - records[0].start);
                                    const totalText = userLines.join('');
                                    let currentTime = 0;
                                    const newRecords = userLines.map((line) => {
                                        const lineDuration = totalText.length > 0 ? (line.length / totalText.length) * totalDuration : 0;
                                        const next = {
                                            text: line,
                                            start: currentTime,
                                            end: currentTime + lineDuration,
                                            words: []
                                        };
                                        currentTime += lineDuration;
                                        return next;
                                    });
                                    if (newRecords.length > 0) {
                                        shouldSkipTextCorrection = true;
                                        records = newRecords;
                                    }
                                }
                            }
                        }

                        // 📊 详细输出FunASR识别结果
                        // 📊 详细输出FunASR识别结果
                        console.log('[autoGenerateSubtitleAndBGM] 阿里云FunASR识别完成，保留原始毫秒单位，records数量:', records.length);
                        console.log('\n========== 📝 FunASR识别结果 ==========');
                        console.log('完整文本:', asrResult.fullText || records.map(r => r.text).join(''));
                        console.log('\n句子详情:');
                        records.forEach((record: any, idx: number) => {
                            const preview = record.text.substring(0, 50) + (record.text.length > 50 ? '...' : '');
                            console.log(`  句子${idx + 1}: ${(record.start / 1000).toFixed(2)}s - ${(record.end / 1000).toFixed(2)}s | "${preview}"`);
                        });
                        console.log('=========================================\n');

                        if (records.length > 0) {
                            console.log('[autoGenerateSubtitleAndBGM] 首条字幕示例(ms):', records[0]);
                        }

                        // ✅ 原始文案已在 ZimuShengcheng.generate() 中通过 userText 参数传递
                        // ZimuShengcheng 内部会使用 Levenshtein 算法自动校对 ASR 结果
                        console.log('[autoGenerateSubtitleAndBGM] 📝 将使用原始文案进行Levenshtein校对');
                        console.log('  原始文案长度:', scriptContent.value?.length || 0, '字符');
                        console.log('  ASR段落数:', records.length);

                    } else {
                        // 使用本地模型
                        console.log('[autoGenerateSubtitleAndBGM] 使用本地模式 - 本地ASR服务');

                        if (!settings.value.asrModelKey) {
                            Message.error(t("请先在设置中配置语音识别模型"));
                            return;
                        }

                        // 获取ASR服务器配置
                        const server = await serverStore.getByKey(settings.value.asrModelKey);
                        if (!server) {
                            Message.error(t("未找到语音识别模型"));
                            return;
                        }

                        const serverInfo = await serverStore.serverInfo(server);

                        // 调用ASR服务
                        const asrResult = await serverStore.call(serverInfo, "asr", {
                            id: serverStore.generateTaskId("VideoSubtitleASR", Date.now()),
                            audio: audioResult.audioPath,
                            param: {}
                        });

                        if (asrResult.code !== 0 || asrResult.data?.type !== 'success') {
                            Message.error(t("语音识别失败: ") + (asrResult.msg || t("未知错误")));
                            return;
                        }

                        // 获取识别结果
                        console.log('[autoGenerateSubtitleAndBGM] ASR识别完成，准备处理结果...');
                        console.log('[autoGenerateSubtitleAndBGM] asrResult结构:', {
                            code: asrResult.code,
                            hasData: !!asrResult.data,
                            dataType: asrResult.data?.type,
                            hasRecords: !!(asrResult.data?.data?.records)
                        });

                        records = asrResult.data?.data?.records || [];
                        console.log('[autoGenerateSubtitleAndBGM] 提取的records数量:', records.length);
                        console.log('[autoGenerateSubtitleAndBGM] records示例:', records.length > 0 ? records[0] : '无数据');
                    }
                }  // 关闭 else { // 方式1: FUNASR在线识别
            }  // 🔧 关闭 else { 无缓存字幕数据，需要ASR识别 }

            if (records.length === 0) {
                console.error('[autoGenerateSubtitleAndBGM] 错误：未识别到语音内容');
                Message.error(t("未识别到语音内容"));
                return;
            }

            console.log('[autoGenerateSubtitleAndBGM] ✅ ASR结果验证通过，开始准备字幕生成参数...');

            // 生成SRT文件
            // 根据字体大小和屏幕宽度计算每行最大字符数，确保及时换行不超出屏幕
            const baseFontSize = (subtitleStyleSelectorRef.value && subtitleStyleSelectorRef.value.getSelectedStyle?.())?.fontSize || 48;
            const actualFontSize = baseFontSize * (subtitleFontSizeScale.value / 100);

            // 🆕【多语言支持】根据字体检测语言类型，使用不同的换行策略
            const selectedFontName = (subtitleStyleSelectorRef.value && subtitleStyleSelectorRef.value.getSelectedStyle?.())?.fontName || 'Microsoft YaHei Bold';

            // 判断字体支持的语言类型
            let charWidthRatio = 0.6; // 默认值（混合语言）
            if (selectedFontName.includes('Malgun')) {
                // 韩文字体：韩文字符宽度约为字体大小的0.8倍（韩文有较多组合符号）
                charWidthRatio = 0.75;
            } else if (selectedFontName.includes('Meiryo') || selectedFontName.includes('Japanese')) {
                // 日文字体：日文字符宽度约为字体大小的0.85倍
                charWidthRatio = 0.8;
            } else if (selectedFontName.includes('Noto Sans CJK') || selectedFontName.includes('Noto Serif CJK')) {
                // Noto系列（中日韩）：需要针对实际内容调整，保守设置
                charWidthRatio = 0.7;
            } else if (selectedFontName.includes('SimHei') || selectedFontName.includes('Microsoft YaHei') || selectedFontName.includes('SimSun')) {
                // 中文字体：中文字符宽度约为字体大小的1倍
                charWidthRatio = 1.0;
            }

            // 考虑屏幕宽度和边距（根据常见视频宽度计算）
            // 标准宽屏：1920px - 480px(左右边距) = 1440px可用宽度
            // 竖屏/方形视频需要更小的边距
            const maxAvailableWidth = 1920 - 480; // 减去左右边距

            // ✅【改进】更准确的字符数计算，考虑字符宽度比例
            const charsPerLineByWidth = Math.floor((maxAvailableWidth / actualFontSize) / charWidthRatio);

            // 根据语言类型设置合理的范围
            let minChars = 6;
            let maxChars = 20;
            if (selectedFontName.includes('Malgun')) {
                // 韩文较宽，保守一点
                maxChars = 16;
            } else if (selectedFontName.includes('Noto')) {
                // Noto字体较宽，保守处理
                maxChars = 18;
            }

            const maxCharsPerLine = Math.max(minChars, Math.min(maxChars, charsPerLineByWidth));

            // 📊 调试信息：输出字幕换行计算详情
            console.log('[autoGenerateSubtitleAndBGM] 字幕换行计算:', {
                字体名称: selectedFontName,
                字符宽度比例: charWidthRatio,
                字体大小: actualFontSize,
                可用宽度: maxAvailableWidth,
                计算的每行字符数: charsPerLineByWidth,
                最终每行字符数: maxCharsPerLine,
                建议: `如果字幕超出屏幕，请调整字体大小或减少字幕文案长度`
            });

            // 🆕 关键修复：生成视频前，先保存当前模板的所有修改（包括背景颜色）
            // 这确保 currentTemplateConfig.value.subtitleStyle 包含用户的最新修改
            const currentTemplateId = selectedSubtitleTemplate.value;
            if (currentTemplateId) {
                console.log('[autoGenerateSubtitleAndBGM] 生成视频前验证模板状态（样式已在编辑时保存）');
                const template = subtitleTemplates.value.find(t => t.id === currentTemplateId);
                if (template?.config?.subtitleStyle) {
                    console.log('[autoGenerateSubtitleAndBGM] ✅ 模板样式有效，可以安全生成');
                } else {
                    console.warn('[autoGenerateSubtitleAndBGM] ⚠️ 模板中无样式配置，将使用默认值');
                }

                if (template?.config) {
                    if (!currentTemplateConfig.value) {
                        currentTemplateConfig.value = template.config;
                        console.log('[autoGenerateSubtitleAndBGM] ✅ 已从模板配置同步 currentTemplateConfig');
                    }

                    if (template.config.enableKeywordEffects !== undefined) {
                        enableKeywordEffects.value = template.config.enableKeywordEffects;
                        console.log('[autoGenerateSubtitleAndBGM] ✅ 已从模板配置同步 enableKeywordEffects:', enableKeywordEffects.value);
                    }

                    if (template.config.keywordGroupsStyles && template.config.keywordGroupsStyles.length > 0) {
                        for (const style of template.config.keywordGroupsStyles) {
                            const targetGroup = keywordGroups.value.find((g: any) => g.name === style.groupName);
                            if (targetGroup) {
                                if (style.styleOverride) targetGroup.styleOverride = {...style.styleOverride};
                                if (style.effectId) targetGroup.effectId = style.effectId;
                                if (style.color) targetGroup.color = style.color;
                                if (style.soundEffectId) targetGroup.soundEffectId = style.soundEffectId;
                                if (style.soundEffectConfig) targetGroup.soundEffectConfig = {...style.soundEffectConfig};
                            }
                        }
                        console.log('[autoGenerateSubtitleAndBGM] ✅ 已从模板配置同步 keywordGroups 样式');
                    }
                }
            }

            // 获取字幕样式（用于生成ASS格式字幕）
            // 🔧 修复：优先从模板配置获取，因为样式在编辑时已保存
            let subtitleStyleForGeneration = null;

            // 首先从模板配置获取（优先选项）
            if (currentTemplateConfig.value && currentTemplateConfig.value.subtitleStyle) {
                console.log("生成字幕 - 从模板配置获取样式:", currentTemplateConfig.value.subtitleStyle);
                subtitleStyleForGeneration = {...currentTemplateConfig.value.subtitleStyle};

                // 应用字体大小缩放
                if (subtitleStyleForGeneration.fontSize) {
                    subtitleStyleForGeneration.fontSize = Math.round(subtitleStyleForGeneration.fontSize * (subtitleFontSizeScale.value / 100));
                }
            } else {
                // 降级：尝试从组件ref获取（仅当模板配置中没有时）
                console.log("生成字幕 - 模板配置中无样式，尝试从组件获取");
                subtitleStyleForGeneration = subtitleStyleSelectorRef.value && subtitleStyleSelectorRef.value.getSelectedStyle?.();
            }

            console.log("生成字幕 - 获取到的样式:", subtitleStyleForGeneration);
            console.log("生成字幕 - subtitlePosition:", subtitlePosition.value);

            if (!subtitleStyleForGeneration) {
                console.log("生成字幕 - 组件返回undefined，尝试从本地存储读取");
                // 尝试从本地存储读取
                const savedStyle = StorageUtil.getObject("SubtitleStyleSelector.customStyle");
                if (savedStyle) {
                    console.log("生成字幕 - 从本地存储读取到样式:", savedStyle);
                    // 应用字体大小缩放
                    const baseFontSize = savedStyle.fontSize || 48;
                    const actualFontSize = Math.round(baseFontSize * (subtitleFontSizeScale.value / 100));

                    // 确保fontName是字符串
                    let fontName = savedStyle.fontName || 'Microsoft YaHei Bold';
                    if (typeof fontName === 'object' && fontName !== null) {
                        fontName = fontName.value || fontName.label || 'Microsoft YaHei Bold';
                    } else if (typeof fontName !== 'string') {
                        fontName = String(fontName || 'Microsoft YaHei Bold');
                    }

                    // 确保backgroundOpacity是0-1之间的数字
                    let backgroundOpacity = savedStyle.backgroundOpacity ?? 0;
                    if (typeof backgroundOpacity === 'string') {
                        if (backgroundOpacity.endsWith('%')) {
                            backgroundOpacity = parseFloat(backgroundOpacity) / 100;
                        } else {
                            backgroundOpacity = parseFloat(backgroundOpacity);
                        }
                    }
                    if (isNaN(backgroundOpacity) || backgroundOpacity < 0) {
                        backgroundOpacity = 0;
                    } else if (backgroundOpacity > 1 && backgroundOpacity <= 100) {
                        backgroundOpacity = backgroundOpacity / 100;
                    } else if (backgroundOpacity > 1) {
                        backgroundOpacity = 1;
                    }

                    subtitleStyleForGeneration = {
                        ...savedStyle,
                        fontName: fontName,  // 确保是字符串
                        fontSize: actualFontSize,
                        position: subtitlePosition.value || savedStyle.position || 'bottom',
                        backgroundOpacity: backgroundOpacity  // 确保是0-1范围的数字
                    };
                    console.log("生成字幕 - 应用本地存储样式后:", subtitleStyleForGeneration);
                } else {
                    console.log("生成字幕 - 本地存储也没有，使用默认样式");
                    subtitleStyleForGeneration = {
                        fontSize: Math.round(48 * (subtitleFontSizeScale.value / 100)),
                        fontColor: '#FFFFFF',
                        outlineColor: '#000000',
                        outlineWidth: 3,
                        position: subtitlePosition.value || 'bottom',
                        fontName: 'Microsoft YaHei Bold',
                        shadowOffset: 2,
                        backgroundColor: 'transparent',
                        backgroundOpacity: 0
                    };
                }
            } else {
                // 即使从组件获取到样式，也确保格式正确
                // 确保fontName是字符串
                if (subtitleStyleForGeneration.fontName && typeof subtitleStyleForGeneration.fontName === 'object') {
                    subtitleStyleForGeneration.fontName = subtitleStyleForGeneration.fontName.value || subtitleStyleForGeneration.fontName.label || 'Microsoft YaHei Bold';
                }
                // 确保backgroundOpacity是数字
                if (typeof subtitleStyleForGeneration.backgroundOpacity === 'string') {
                    let opacity = subtitleStyleForGeneration.backgroundOpacity;
                    if (opacity.endsWith('%')) {
                        subtitleStyleForGeneration.backgroundOpacity = parseFloat(opacity) / 100;
                    } else {
                        subtitleStyleForGeneration.backgroundOpacity = parseFloat(opacity);
                    }
                }
                if (isNaN(subtitleStyleForGeneration.backgroundOpacity) || subtitleStyleForGeneration.backgroundOpacity < 0) {
                    subtitleStyleForGeneration.backgroundOpacity = 0;
                } else if (subtitleStyleForGeneration.backgroundOpacity > 1 && subtitleStyleForGeneration.backgroundOpacity <= 100) {
                    subtitleStyleForGeneration.backgroundOpacity = subtitleStyleForGeneration.backgroundOpacity / 100;
                } else if (subtitleStyleForGeneration.backgroundOpacity > 1) {
                    subtitleStyleForGeneration.backgroundOpacity = 1;
                }
            }

            // 确保使用用户选择的位置
            if (subtitlePosition.value) {
                subtitleStyleForGeneration.position = subtitlePosition.value;
            }

            // 最终验证和修正样式数据
            if (!subtitleStyleForGeneration) {
                subtitleStyleForGeneration = {
                    fontSize: Math.round(48 * (subtitleFontSizeScale.value / 100)),
                    fontColor: '#FFFFFF',
                    outlineColor: '#000000',
                    outlineWidth: 3,
                    position: subtitlePosition.value || 'bottom',
                    fontName: 'Microsoft YaHei Bold',
                    shadowOffset: 2,
                    backgroundColor: 'transparent',
                    backgroundOpacity: 0
                };
            }

            // 最终确保字体名称是字符串
            if (subtitleStyleForGeneration.fontName && typeof subtitleStyleForGeneration.fontName === 'object') {
                subtitleStyleForGeneration.fontName = subtitleStyleForGeneration.fontName.value || subtitleStyleForGeneration.fontName.label || 'Microsoft YaHei Bold';
            } else if (!subtitleStyleForGeneration.fontName || typeof subtitleStyleForGeneration.fontName !== 'string') {
                subtitleStyleForGeneration.fontName = String(subtitleStyleForGeneration.fontName || 'Microsoft YaHei Bold');
            }
            subtitleStyleForGeneration.fontName = subtitleStyleForGeneration.fontName.trim() || 'Microsoft YaHei Bold';

            // 最终确保背景透明度是数字
            let finalOpacity = subtitleStyleForGeneration.backgroundOpacity ?? 0;
            if (typeof finalOpacity === 'string') {
                if (finalOpacity.endsWith('%')) {
                    finalOpacity = parseFloat(finalOpacity) / 100;
                } else {
                    finalOpacity = parseFloat(finalOpacity);
                }
            }
            if (isNaN(finalOpacity) || finalOpacity < 0) {
                finalOpacity = 0;
            } else if (finalOpacity > 1) {
                if (finalOpacity <= 100) {
                    finalOpacity = finalOpacity / 100;
                } else {
                    finalOpacity = 1;
                }
            }
            subtitleStyleForGeneration.backgroundOpacity = finalOpacity;

            // 确保背景颜色存在
            if (!subtitleStyleForGeneration.backgroundColor) {
                subtitleStyleForGeneration.backgroundColor = 'transparent';
            }

            console.log("生成字幕 - 最终样式（已验证）:", subtitleStyleForGeneration);
            console.log("生成字幕 - 最终样式详情:", JSON.stringify(subtitleStyleForGeneration, null, 2));
            console.log("生成字幕 - 字体名称（最终）:", {
                value: subtitleStyleForGeneration?.fontName,
                type: typeof subtitleStyleForGeneration?.fontName,
                length: subtitleStyleForGeneration?.fontName?.length
            });
            console.log("生成字幕 - 背景透明度（最终）:", {
                value: subtitleStyleForGeneration?.backgroundOpacity,
                type: typeof subtitleStyleForGeneration?.backgroundOpacity,
                backgroundColor: subtitleStyleForGeneration?.backgroundColor,
                willShowBackground: subtitleStyleForGeneration?.backgroundColor !== 'transparent' && (subtitleStyleForGeneration?.backgroundOpacity || 0) > 0
            });

            // 传递音频路径和时间戳，确保字幕文件使用与音频文件相同的时间戳
            // 同时传递原始文案，用于替换ASR识别可能不准确的文字
            // 准备关键词数据（如果启用了关键词特效）
            let keywordGroupsForSubtitle: any[] = [];

            if (enableKeywordEffects.value) {
                // 检查是否有有效的关键词分组
                let hasValidKeywordGroups = keywordGroups.value && keywordGroups.value.length > 0;
                let hasKeywordsInGroups = false;

                if (hasValidKeywordGroups) {
                    // 检查分组中是否有实际的关键词
                    hasKeywordsInGroups = keywordGroups.value.some((group: any) =>
                        group.keywords && group.keywords.length > 0
                    );
                }

                // 如果分组为空或没有关键词，但提取了关键词，则自动创建分组
                if ((!hasValidKeywordGroups || !hasKeywordsInGroups) && extractedKeywords.value && extractedKeywords.value.length > 0) {
                    console.warn("字幕生成 - 关键词分组为空或没有关键词，将自动从提取的关键词创建分组");

                    // 创建一个临时分组，包含所有提取的关键词
                    keywordGroupsForSubtitle = [{
                        id: 'auto_group_' + Date.now(),
                        name: '自动识别的关键词',
                        description: '智能识别出的关键词',
                        keywords: extractedKeywords.value.map((kw: any) => ({
                            keyword: typeof kw === 'string' ? kw : kw.keyword || kw,
                            enabled: true
                        })),
                        color: '#FF6B6B',
                        styleOverride: {
                            fontName: subtitleStyleForGeneration?.fontName || 'Microsoft YaHei Bold',  // ✅ 新增：使用全局字体
                            fontPath: subtitleStyleForGeneration?.fontPath,  // ✅ 新增：使用全局字体路径
                            fontColor: '#FFD700',
                            outlineColor: '#000000',
                            outlineWidth: 3,
                            fontSize: 48
                        },
                        createdAt: Date.now()
                    }];
                } else if (hasValidKeywordGroups && hasKeywordsInGroups) {
                    // 传递完整的关键词分组信息到后端
                    // ✅ 修复：使用 map() 而不是 structuredClone 来避免 Proxy 对象问题
                    keywordGroupsForSubtitle = keywordGroups.value.map((group: any) => ({
                        id: group.id,
                        name: group.name,
                        description: group.description,
                        keywords: Array.isArray(group.keywords) ? group.keywords.map((kw: any) => ({
                            keyword: typeof kw === 'string' ? kw : (kw.keyword || ''),
                            enabled: kw.enabled !== false
                        })) : [],
                        color: group.color,
                        styleOverride: group.styleOverride ? {
                            fontName: group.styleOverride.fontName,  // ✅ 新增：字体名称
                            fontPath: group.styleOverride.fontPath,  // ✅ 新增：字体路径
                            fontColor: group.styleOverride.fontColor,
                            outlineColor: group.styleOverride.outlineColor,
                            outlineWidth: group.styleOverride.outlineWidth,
                            fontSize: group.styleOverride.fontSize
                        } : null,
                        effectId: group.effectId,
                        // 🆕 添加音效配置
                        soundEffectId: group.soundEffectId,
                        soundEffectConfig: group.soundEffectConfig ? {
                            volume: group.soundEffectConfig.volume,
                            pitch: group.soundEffectConfig.pitch,
                            fadeIn: group.soundEffectConfig.fadeIn,
                            fadeOut: group.soundEffectConfig.fadeOut,
                            triggerTime: group.soundEffectConfig.triggerTime
                        } : null,
                        // 🆕 添加特效时长
                        effectDuration: group.effectDuration,
                        createdAt: group.createdAt
                    }));
                }

                const templateKeywordGroupStyles = currentSelectedTemplate.value?.config?.keywordGroupsStyles || currentTemplateConfig.value?.keywordGroupsStyles;
                if (Array.isArray(templateKeywordGroupStyles) && keywordGroupsForSubtitle.length > 0) {
                    for (const style of templateKeywordGroupStyles) {
                        const targetGroup = keywordGroupsForSubtitle.find((g: any) => g.name === style.groupName);
                        if (!targetGroup) {
                            continue;
                        }
                        if (Object.prototype.hasOwnProperty.call(style, 'soundEffectId')) {
                            targetGroup.soundEffectId = style.soundEffectId ?? null;
                        }
                        if (Object.prototype.hasOwnProperty.call(style, 'soundEffectConfig')) {
                            targetGroup.soundEffectConfig = style.soundEffectConfig ? {
                                volume: style.soundEffectConfig.volume,
                                pitch: style.soundEffectConfig.pitch,
                                fadeIn: style.soundEffectConfig.fadeIn,
                                fadeOut: style.soundEffectConfig.fadeOut,
                                triggerTime: style.soundEffectConfig.triggerTime,
                            } : null;
                        }
                    }
                    console.log('[autoGenerateSubtitleAndBGM] ✅ 已从模板 keywordGroupsStyles 兜底同步音效配置到生成参数');
                }


                const normalizedScriptText = normalizeSubtitleCacheText(scriptContent.value || '');
                const matchedKeywordCount = keywordGroupsForSubtitle.reduce((count: number, group: any) => {
                    const groupKeywords = Array.isArray(group.keywords) ? group.keywords : [];
                    return count + groupKeywords.filter((kw: any) => {
                        const rawKeyword = typeof kw === 'string' ? kw : kw?.keyword;
                        const normalizedKeyword = normalizeSubtitleCacheText(rawKeyword || '');
                        return !!normalizedKeyword && normalizedScriptText.includes(normalizedKeyword);
                    }).length;
                }, 0);

                if (matchedKeywordCount === 0 && Array.isArray(templateKeywordGroupStyles) && templateKeywordGroupStyles.length > 0) {
                    const fallbackKeywordTexts = (
                        (Array.isArray(extractedKeywords.value) ? extractedKeywords.value.map((kw: any) => typeof kw === 'string' ? kw : kw?.keyword) : [])
                    ).concat(
                        generatedKeywords.value ? generatedKeywords.value.split('\n') : []
                    ).map((kw: any) => String(kw || '').trim()).filter(Boolean);

                    const uniqueFallbackKeywords = Array.from(new Set(fallbackKeywordTexts));
                    const preferredStyle = templateKeywordGroupStyles.find((style: any) => style?.groupName === '重点词/成语词')
                        || templateKeywordGroupStyles.find((style: any) => !!style?.soundEffectId)
                        || templateKeywordGroupStyles[0];

                    if (preferredStyle && uniqueFallbackKeywords.length > 0) {
                        keywordGroupsForSubtitle = [{
                            id: `template_fallback_${Date.now()}`,
                            name: preferredStyle.groupName || '重点词/成语词',
                            description: '模板关键词回填',
                            keywords: uniqueFallbackKeywords.map((keyword) => ({keyword, enabled: true})),
                            color: preferredStyle.color || '#FFD700',
                            styleOverride: preferredStyle.styleOverride ? {...preferredStyle.styleOverride} : null,
                            effectId: preferredStyle.effectId || null,
                            soundEffectId: preferredStyle.soundEffectId ?? null,
                            soundEffectConfig: preferredStyle.soundEffectConfig ? {...preferredStyle.soundEffectConfig} : null,
                            effectDuration: preferredStyle.effectDuration,
                            createdAt: Date.now(),
                        }];
                        console.warn('[autoGenerateSubtitleAndBGM] 当前分组关键词与文案完全不匹配，已使用模板关键词回填方案', {
                            fallbackGroup: preferredStyle.groupName,
                            fallbackKeywordsCount: uniqueFallbackKeywords.length,
                        });
                    }
                }
                if (keywordGroupsForSubtitle.length > 0) {
                    console.log("字幕生成 - 将应用关键词分组特效:", {
                        groupCount: keywordGroupsForSubtitle.length,
                        groups: keywordGroupsForSubtitle.map(g => ({
                            id: g.id,
                            name: g.name,
                            keywordCount: g.keywords?.length || 0,
                            effectId: g.effectId,
                            effectDuration: g.effectDuration,  // 🆕 调试时长
                            hasStyleOverride: !!g.styleOverride
                        }))
                    });
                } else {
                    console.warn("字幕生成 - 启用了关键词特效，但没有可用的关键词");
                }
            }

            // 关键修复：从keywordGroupsForSubtitle中提取所有关键词
            // 这样后端才能知道哪些词需要应用特效
            let keywordsToApplyEffects: string[] = [];
            if (keywordGroupsForSubtitle && keywordGroupsForSubtitle.length > 0) {
                const keywordSet = new Set<string>();
                for (const group of keywordGroupsForSubtitle) {
                    if (group.keywords && Array.isArray(group.keywords)) {
                        for (const kw of group.keywords) {
                            // 提取关键词文本，支持字符串或对象格式
                            let keyword = typeof kw === 'string' ? kw : (kw.keyword || '');

                            // 规范化：trim空白、排除空字符串
                            keyword = (keyword && typeof keyword === 'string') ? keyword.trim() : '';

                            // 只有有效的关键词才添加到集合（自动去重）
                            if (keyword && keyword.length > 0) {
                                keywordSet.add(keyword);
                            }
                        }
                    }
                }
                keywordsToApplyEffects = Array.from(keywordSet);
                console.log('字幕生成 - 从keywordGroups中提取的关键词（已去重）:', {
                    count: keywordsToApplyEffects.length,
                    keywords: keywordsToApplyEffects
                });

                // 🔍 详细调试：输出每个分组的样式和效果信息
                console.log('字幕生成 - keywordGroupsForSubtitle详细信息:', {
                    groupsCount: keywordGroupsForSubtitle.length,
                    groups: keywordGroupsForSubtitle.map((g: any) => ({
                        id: g.id,
                        name: g.name,
                        keywords: g.keywords?.map((kw: any) => typeof kw === 'string' ? kw : kw.keyword),
                        effectId: g.effectId,
                        styleOverride: g.styleOverride,
                        color: g.color
                    }))
                });
            }

            // 重要：新模板的 inline-emphasis 不依赖 effectId，而是直接在普通字幕内高亮关键词
            const keywordRenderModeForGeneration =
                currentKeywordRenderMode.value === 'inline-emphasis'
                    ? 'inline-emphasis'
                    : 'floating';
            const shouldEnableKeywordEffects = enableKeywordEffects.value && keywordGroupsForSubtitle.length > 0;

            const hasValidEffectConfigs = keywordGroupsForSubtitle.some(group => {
                const hasKeywords = !!(group.keywords && group.keywords.length > 0);
                if (!hasKeywords) {
                    return false;
                }

                if (keywordRenderModeForGeneration === 'inline-emphasis') {
                    return true;
                }

                return !!(group.effectId && group.effectId.trim() !== '');
            });

            console.log('[autoGenerateSubtitleAndBGM] 准备传递给后端:', {
                enableKeywordEffects: enableKeywordEffects.value,
                keywordGroupsForSubtitleLength: keywordGroupsForSubtitle.length,
                keywordRenderModeForGeneration,
                hasValidEffectConfigs: hasValidEffectConfigs,
                shouldEnableKeywordEffects: shouldEnableKeywordEffects,
                keywordsCount: keywordsToApplyEffects.length,
                keywords: keywordsToApplyEffects,
                keywordGroups: keywordGroupsForSubtitle.length > 0 ? keywordGroupsForSubtitle.map((g: any) => ({
                    id: g.id,
                    name: g.name,
                    effectId: g.effectId,
                    styleOverride: g.styleOverride,
                    hasKeywords: !!(g.keywords && g.keywords.length > 0),
                    keywordsList: g.keywords?.map((kw: any) => typeof kw === 'string' ? kw : kw.keyword)
                })) : []
            });

            // 使用新版ZimuShengcheng字幕生成系统（完全替代旧系统）
            // 直接在前端调用ZimuShengcheng，避免IPC复杂性
            console.log('[autoGenerateSubtitleAndBGM] 开始直接调用ZimuShengcheng.generate()...');
            console.log('[autoGenerateSubtitleAndBGM] 当前视频路径:', currentVideo);
            console.log('[autoGenerateSubtitleAndBGM] records数量:', records?.length);
            console.log('[autoGenerateSubtitleAndBGM] subtitleStyleForGeneration:', subtitleStyleForGeneration);
            console.log('[autoGenerateSubtitleAndBGM] keywordGroupsForSubtitle数量:', keywordGroupsForSubtitle?.length);

            const service = new ZimuShengcheng();
            console.log('[autoGenerateSubtitleAndBGM] ZimuShengcheng实例创建完成');

            // 生成输出路径：使用固定的命名格式，避免后缀递归累积
            // 不依赖输入文件名，而是使用时间戳生成唯一的输出文件名
            const videoPath = currentVideo.replace(/^file:\/\//, ''); // 移除file://前缀
            const lastSlashIndex = Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\'));
            const videoDir = lastSlashIndex >= 0 ? videoPath.substring(0, lastSlashIndex) : videoPath;
            const timestamp = new Date().getTime();
            const outputPath = `${videoDir}/video_with_subtitle_${timestamp}.mp4`;
            console.log('[autoGenerateSubtitleAndBGM] 输出路径已生成:', outputPath);

            // ✅ 添加超时保护：整个字幕生成过程最多60秒
            const generationTimeout = setTimeout(() => {
                console.error('[autoGenerateSubtitleAndBGM] 字幕生成超时（60秒），强制中断');
                Message.error(t("字幕生成超时，请重试"));
            }, 60000);

            // ✅ 将 zimuResult 声明移到 try 块外，以便在后续代码中使用
            let zimuResult: any = null;

            try {
                console.log('[autoGenerateSubtitleAndBGM] 准备调用service.generate()，参数准备完成');

                // 获取实际视频尺寸
                const videoPath = currentVideo.replace(/^file:\/\//, '');
                let videoWidth = 1920;
                let videoHeight = 1080;
                console.log('[autoGenerateSubtitleAndBGM] 🔍 开始获取视频尺寸...', {videoPath});
                try {
                    console.log('[autoGenerateSubtitleAndBGM] 调用 ffprobeVideoInfo...');

                    // 🔧 添加超时保护（10秒）
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('ffprobe 超时（10秒）')), 10000)
                    );

                    const videoInfo = await Promise.race([
                        ffprobeVideoInfo(videoPath),
                        timeoutPromise
                    ]);

                    console.log('[autoGenerateSubtitleAndBGM] ffprobeVideoInfo 返回:', videoInfo);
                    videoWidth = videoInfo.width;
                    videoHeight = videoInfo.height;
                    console.log('[autoGenerateSubtitleAndBGM] ✅ 视频实际尺寸:', videoWidth, 'x', videoHeight, {
                        isPortrait: videoHeight > videoWidth
                    });
                } catch (e: any) {
                    console.error('[autoGenerateSubtitleAndBGM] ❌ 无法获取视频尺寸，错误详情:', {
                        message: e?.message || e,
                        name: e?.name,
                        stack: e?.stack
                    });
                    console.warn('[autoGenerateSubtitleAndBGM] 使用默认值: 1920x1080');
                }

                // 🔧 关键修复：确保标题配置包含用户最新编辑的标题内容
                let titleSubtitleConfigForGeneration = currentSelectedTemplate.value?.config?.titleSubtitleConfig
                    ? {
                        ...currentSelectedTemplate.value.config.titleSubtitleConfig,
                        sourceTitle: generatedTitle.value  // ✅ 使用最新的用户编辑的标题！
                    }
                    : {
                        enabled: false,
                        sourceTitle: generatedTitle.value,
                        maxCharsPerLine: 15,
                        maxLines: 5,
                        lineSpacingPercent: 7,
                        topMarginPercent: 5,
                        lines: []
                    };

                // ✅ 关键修复2：根据最新的 sourceTitle 重新生成 lines 数组！
                // 这样后端才能使用最新的标题内容
                if (titleSubtitleConfigForGeneration.sourceTitle) {
                    console.log('[autoGenerateSubtitleAndBGM] 根据最新标题重新生成标题行配置...');
                    titleSubtitleConfigForGeneration.lines = generateTitleLines(
                        titleSubtitleConfigForGeneration,
                        videoWidth,
                        videoHeight
                    );
                    console.log('[autoGenerateSubtitleAndBGM] 标题行配置已更新:', {
                        sourceTitle: titleSubtitleConfigForGeneration.sourceTitle,
                        lineCount: titleSubtitleConfigForGeneration.lines.length,
                        lines: titleSubtitleConfigForGeneration.lines.map(l => l.text)
                    });
                }

                // 🆕 读取画中画配置
                let videoMixCutSettings = settings.value.videoMixCutSettings;
                if (!videoMixCutSettings) {
                    try {
                        videoMixCutSettings = await window.$mapi.config.get('videoMixCutSettings');
                        console.log('[autoGenerateSubtitleAndBGM] 从配置文件读取画中画设置:', videoMixCutSettings);
                    } catch (e) {
                        console.warn('[autoGenerateSubtitleAndBGM] 读取画中画配置失败:', e);
                        videoMixCutSettings = null;
                    }
                }

                zimuResult = await service.generate({
                    videoPath: videoPath,
                    videoWidth: videoWidth,
                    videoHeight: videoHeight,
                    userText: scriptContent.value,
                    skipTextCorrection: shouldSkipTextCorrection,
                    funasrSegments: records.map(r => ({
                        text: r.text,
                        start: r.start,
                        end: r.end,
                        words: r.words || []
                    })),
                    subtitleStyle: subtitleStyleForGeneration,
                    keywordGroups: shouldEnableKeywordEffects && hasValidEffectConfigs ? keywordGroupsForSubtitle : [],
                    keywordRenderMode: keywordRenderModeForGeneration,
                    // 🔧 新增：明确传递特效启用标志
                    enableKeywordEffects: shouldEnableKeywordEffects && hasValidEffectConfigs,
                    // 🔧 新增：传递特效调试信息
                    debugInfo: {
                        hasValidEffectConfigs,
                        groupsWithEffects: keywordGroupsForSubtitle.filter(g => g.effectId && g.effectId.trim() !== '').length,
                        groupsWithKeywords: keywordGroupsForSubtitle.filter(g => g.keywords && g.keywords.length > 0).length,
                        totalGroups: keywordGroupsForSubtitle.length
                    },
                    fontDir: 'C:/Windows/Fonts',
                    outputPath: outputPath,
                    minSubtitleDuration: settings.value.minSubtitleDuration,  // 🔧 使用全局设置的特效字幕最小显示时长（仅控制特效）
                    normalSubtitleX: settings.value.normalSubtitleX,
                    normalSubtitleY: settings.value.normalSubtitleY,
                    effectSubtitleX: settings.value.effectSubtitleX,
                    effectSubtitleY: settings.value.effectSubtitleY,
                    keywordGroupPositions: settings.value.keywordGroupPositions,  // 🔧 传递关键词分组位置配置
                    disableSmartLayout: settings.value.disableSmartLayout,
                    avoidanceConfig: settings.value.avoidanceConfig,  // 🔧 传递避让配置
                    // 🆕 音效系统配置：检查是否有关键词分组配置了音效
                    soundEffectSettings: (() => {
                        const hasSoundEffects = keywordGroupsForSubtitle.some((g: any) => g.soundEffectId);
                        console.log('[autoGenerateSubtitleAndBGM] 🔊 音效配置检查:', {
                            enabled: hasSoundEffects,
                            groupsCount: keywordGroupsForSubtitle.length,
                            groupsSoundEffects: keywordGroupsForSubtitle.map((g: any) => ({
                                name: g.name,
                                soundEffectId: g.soundEffectId,
                                hasSoundConfig: !!g.soundEffectConfig
                            }))
                        });
                        return {
                            enabled: hasSoundEffects,  // 如果有任何分组配置了音效ID，则启用
                            masterVolume: 0.7,
                            mixMode: 'overlay'
                        };
                    })(),

                    // ✨ 新增：标题字幕配置（✅ 修复：使用包含最新标题的配置）
                    titleSubtitleConfig: titleSubtitleConfigForGeneration,

                    // ✨ 新增：视频时长（从videoInfo获取）
                    videoDuration: (() => {
                        try {
                            // 尝试从已获取的videoInfo中提取时长，或者从records中计算
                            if (records && records.length > 0) {
                                const lastRecord = records[records.length - 1];
                                return lastRecord.end || 0;
                            }
                            return 0;
                        } catch (e) {
                            console.warn('[autoGenerateSubtitleAndBGM] 无法获取视频时长，使用0');
                            return 0;
                        }
                    })(),

                    // 🆕 新增：传递画中画配置
                    videoMixCutSettings: videoMixCutSettings
                });

                // ✅ 清除超时器
                clearTimeout(generationTimeout);

                console.log('[autoGenerateSubtitleAndBGM] ZimuShengcheng.generate() 完成:', {
                    success: zimuResult.success,
                    outputPath: zimuResult.outputPath,
                    message: zimuResult.message
                });

                if (!zimuResult.success) {
                    Message.error(zimuResult.message || t("新版字幕生成失败"));
                    return;
                }
            } catch (error: any) {
                // ✅ 清除超时器
                clearTimeout(generationTimeout);
                console.error('[autoGenerateSubtitleAndBGM] 字幕生成过程异常:', error);
                Message.error(t("字幕生成失败: ") + (error?.message || error));
                return;
            }

            // ✅ 新系统直接生成视频，更新结果
            // 新系统已经完成了所有字幕生成工作（包括特效字幕），不需要再调用旧的addSubtitleToVideo
            if (!zimuResult) {
                console.error('[autoGenerateSubtitleAndBGM] zimuResult 为空，无法继续');
                return;
            }

            funasrSegments.value = records;

            // 🔍 输出识别结果摘要，方便调试
            console.log('========== FUNASR识别结果已保存 ==========');
            console.log('识别记录数:', records.length);
            console.log('使用控制台命令查看完整结果:');
            console.log('  __debugFunasrSegments.value');
            console.log('快速预览:');
            records.forEach((r: any, idx: number) => {
                console.log(`  [${idx + 1}] "${r.text.substring(0, 30)}..." (${(r.start / 1000).toFixed(2)}s - ${(r.end / 1000).toFixed(2)}s)`);
            });
            console.log('========================================');

            // 🔧 修复：字幕生成的结果不应该影响"03视频编辑区域"
            // 字幕生成的视频应该只更新 currentVideo，不更新 processedVideoUrl
            // processedVideoUrl 专门用于显示"03视频编辑区域"的处理后视频
            // 删除：processedVideoUrl.value = zimuResult.outputPath || currentVideo;

            // 设置SRT文件路径（用于展示区显示和后续处理）
            if (zimuResult.srtPath) {
                srtFile.value = zimuResult.srtPath;
                saveSubtitleReuseMeta({
                    videoPath: originalVideoUrl,
                    scriptText: scriptContent.value,
                    srtPath: zimuResult.srtPath,
                    records,
                });
                try {
                    await window.$mapi.file.write('cache-subtitle-records.json', JSON.stringify(records));
                } catch (cacheError) {
                    console.warn('[autoGenerateSubtitleAndBGM] 写入字幕缓存失败:', cacheError);
                }
                console.log('[autoGenerateSubtitleAndBGM] 已设置SRT文件路径:', zimuResult.srtPath);
                console.log('[autoGenerateSubtitleAndBGM] 🎯 字幕文件完整路径:', zimuResult.srtPath);
                Message.success(t('字幕文件已生成：') + zimuResult.srtPath);
            }

            // 保存音频时间戳和路径，用于后续生成最终音频文件
            if (typeof audioResult !== 'undefined') {
                originalAudioTimestamp = audioResult.timestamp;
                originalAudioPath = audioResult.audioPath;
            }

            // ✅ 关键修复：新系统已经生成带字幕的视频，直接使用新系统的输出
            // 跳过后续所有旧逻辑（自动提取关键词、调用addSubtitleToVideo等），避免字幕重复叠加
            // 🔧 安全检查：确保outputPath不为空，否则报错（避免使用没有字幕的视频）
            if (!zimuResult.outputPath) {
                console.error('[autoGenerateSubtitleAndBGM] ❌ zimuResult.outputPath为空！字幕生成可能失败');
                console.error('[autoGenerateSubtitleAndBGM] zimuResult完整信息:', zimuResult);
                Message.error(t("字幕视频生成失败：输出路径为空"));
                return;
            }
            currentVideo = zimuResult.outputPath;
            Message.success(t("字幕生成完成（新系统）"));
            console.log('[autoGenerateSubtitleAndBGM] ✅ 新系统字幕生成完成，跳过旧系统逻辑，直接使用新系统生成的视频:', currentVideo);

            // 跳过后续的所有旧逻辑，直接进入BGM处理阶段
            // 注释掉以下所有代码块，因为新系统已经完成了字幕生成
            /*

            // 自动提取关键词用于特效（只在用户勾选了关键词特效时）
            if (enableKeywordEffects.value && extractedKeywords.value.length === 0) {
                try {
                    Message.info(t("正在自动提取关键词..."));

                    // 优先使用ASR识别结果作为字幕文本（更准确）
                    let subtitleText = '';

                    // 从ASR结果提取文本
                    if (funasrSegments.value && funasrSegments.value.length > 0) {
                        subtitleText = funasrSegments.value
                            .map(seg => seg.text || seg.sentence || '')
                            .join(' ')
                            .trim();
                    }

                    // 如果没有ASR结果，使用文案内容
                    if (!subtitleText && scriptContent.value) {
                        subtitleText = scriptContent.value.trim();
                    }

                    if (subtitleText && settings.value.textModelKey) {
                        // 解析模型配置
                        const [providerId, modelId] = settings.value.textModelKey.split('|');
                        const server = await serverStore.getByKey(settings.value.textModelKey);

                        if (server) {
                            const serverInfo = await serverStore.serverInfo(server);

                            const keywordResult = await window.$mapi.ipAgent.extractKeywords({
                                subtitleText,
                                modelConfig: {
                                    providerId,
                                    modelId,
                                    apiUrl: serverInfo.apiUrl || serverInfo.apiHost,
                                    apiKey: serverInfo.apiKey || ''
                                }
                            });

                            if (keywordResult.success && keywordResult.keywords && keywordResult.keywords.length > 0) {
                                extractedKeywords.value = keywordResult.keywords;
                                console.log(`自动提取到 ${keywordResult.keywords.length} 个关键词:`, keywordResult.keywords.map(k => k.keyword));
                                Message.success(t(`自动识别到 ${keywordResult.keywords.length} 个关键词`));
                            } else {
                                console.log("自动提取关键词失败，将使用默认关键词或跳过");
                            }
                        }
                    } else {
                        console.log("未配置文本模型或字幕内容为空，跳过自动关键词提取");
                    }
                } catch (error) {
                    console.warn("自动提取关键词失败:", error);
                    // 不中断流程，继续处理
                }
            } else {
                console.log(`已有 ${extractedKeywords.value.length} 个关键词，跳过自动提取`);
            }

            // 获取选中的字幕样式，如果没有则使用默认样式
            // 优先使用生成字幕时使用的样式（subtitleStyleForGeneration），确保一致性
            let selectedStyle: any = null;

            // 如果有生成字幕时的样式，优先使用它（确保字体和背景透明度一致）
            if (subtitleStyleForGeneration && typeof subtitleStyleForGeneration === 'object') {
                selectedStyle = { ...subtitleStyleForGeneration };
                console.log("添加字幕到视频 - 使用生成字幕时的样式:", selectedStyle);
            } else {
                // 否则从组件获取 - 添加类型检查
                try {
                    const componentStyle = subtitleStyleSelectorRef.value?.getSelectedStyle?.();
                    if (componentStyle && typeof componentStyle === 'object') {
                        selectedStyle = componentStyle;
                    } else {
                        console.warn('[autoGenerateSubtitleAndBGM] ⚠️ getSelectedStyle 返回了非对象或为空');
                    }
                } catch (error) {
                    console.error('[autoGenerateSubtitleAndBGM] ❌ 调用 getSelectedStyle 异常:', error);
                }
            }

            if (!selectedStyle) {
                console.log("未找到选中的字幕样式，尝试从本地存储读取");
                // 尝试从本地存储读取
                const savedStyle = StorageUtil.getObject("SubtitleStyleSelector.customStyle");
                if (savedStyle) {
                    console.log("从本地存储读取到字幕样式:", savedStyle);
                    // 应用字体大小缩放
                    const baseFontSize = savedStyle.fontSize || 48;
                    const actualFontSize = Math.round(baseFontSize * (subtitleFontSizeScale.value / 100));

                        // 确保fontName是字符串
                        let fontName = savedStyle.fontName || 'Microsoft YaHei Bold';
                        if (typeof fontName === 'object' && fontName !== null) {
                            fontName = fontName.value || fontName.label || 'Microsoft YaHei Bold';
                        } else if (typeof fontName !== 'string') {
                            fontName = String(fontName || 'Microsoft YaHei Bold');
                        }
                        fontName = fontName.trim() || 'Microsoft YaHei Bold';

                        // 确保backgroundOpacity是数字
                        let backgroundOpacity = savedStyle.backgroundOpacity ?? 0;
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

                    selectedStyle = {
                        ...savedStyle,
                            fontName: fontName,  // 确保是字符串
                        fontSize: actualFontSize,
                            position: subtitlePosition.value || savedStyle.position || 'bottom',
                            backgroundOpacity: backgroundOpacity  // 确保是0-1范围的数字
                    };
                    console.log("应用本地存储样式后:", selectedStyle);
                } else {
                    console.log("本地存储也没有，使用默认样式");
                    selectedStyle = {
                        fontSize: Math.round(48 * (subtitleFontSizeScale.value / 100)),
                        fontColor: '#FFFFFF',
                        outlineColor: '#000000',
                        outlineWidth: 3,
                        position: subtitlePosition.value || 'bottom',
                        fontName: 'Microsoft YaHei Bold',
                        shadowOffset: 2,
                        backgroundColor: 'transparent',
                        backgroundOpacity: 0
                    };
                }
            }

            // 确保selectedStyle包含所有必要字段
            if (selectedStyle && typeof selectedStyle === 'object' && !selectedStyle.fontName) {
                selectedStyle.fontName = 'Microsoft YaHei Bold';
            } else if (!selectedStyle || typeof selectedStyle !== 'object') {
                selectedStyle = {
                    fontSize: Math.round(48 * (subtitleFontSizeScale.value / 100)),
                    fontColor: '#FFFFFF',
                    outlineColor: '#000000',
                    outlineWidth: 3,
                    position: subtitlePosition.value || 'bottom',
                    fontName: 'Microsoft YaHei Bold',
                    shadowOffset: 2,
                    backgroundColor: 'transparent',
                    backgroundOpacity: 0
                };
            }
            if (selectedStyle.backgroundOpacity === undefined || selectedStyle.backgroundOpacity === null) {
                selectedStyle.backgroundOpacity = 0;
            }
            if (!selectedStyle.backgroundColor) {
                selectedStyle.backgroundColor = 'transparent';
            }

            // 解析高亮词 - 优先使用生成的关键词，其次使用设置中的关键词
            let highlightWords = [];

            // 如果启用了关键词特效且有生成的关键词，使用生成的关键词
            if (enableKeywordEffects.value && generatedKeywords.value && generatedKeywords.value.trim()) {
                highlightWords = generatedKeywords.value.split('\n').filter(w => w.trim());
                console.log("使用生成的关键词作为特效关键词:", highlightWords);
            } else if (settings.value.subtitleHighlightWords) {
                // 否则使用设置中的高亮词
                highlightWords = settings.value.subtitleHighlightWords.split('\n').filter(w => w.trim());
                console.log("使用设置中的关键词:", highlightWords);
            }

            Message.info(t("正在添加字幕到视频..."));

            // 将字幕样式对象转换为纯数据对象(确保可以被IPC序列化)
            // 添加防守检查：确保 selectedStyle 有效
            if (!selectedStyle || typeof selectedStyle !== 'object') {
                console.error('[autoGenerateSubtitleAndBGM] ❌ selectedStyle 无效！', {
                    selectedStyle,
                    type: typeof selectedStyle
                });
                Message.error('字幕样式未正确加载，请检查样式选择器');
                return;
            }

            // 手动提取样式对象中所有可序列化的字段，避免structuredClone失败
            const cleanStyle = {
                fontSize: selectedStyle.fontSize,
                fontColor: selectedStyle.fontColor,
                outlineColor: selectedStyle.outlineColor,
                outlineWidth: selectedStyle.outlineWidth,
                backgroundColor: selectedStyle.backgroundColor,
                backgroundOpacity: selectedStyle.backgroundOpacity,
                fontName: selectedStyle.fontName,
                position: selectedStyle.position,
                shadowOffset: selectedStyle.shadowOffset,
                shadowBlur: selectedStyle.shadowBlur,
                shadowColor: selectedStyle.shadowColor,
                fontStyle: selectedStyle.fontStyle,
                fontWeight: selectedStyle.fontWeight
            };

            // 验证序列化结果
            console.log('[autoGenerateSubtitleAndBGM] 序列化后的样式:', {
                fontColor: cleanStyle?.fontColor,
                fontSize: cleanStyle?.fontSize,
                fontName: cleanStyle?.fontName,
                hasAllFields: cleanStyle?.fontColor && cleanStyle?.fontName && cleanStyle?.fontSize ? true : false
            });

            // 确保字体名称是字符串
            if (cleanStyle.fontName && typeof cleanStyle.fontName === 'object') {
                cleanStyle.fontName = cleanStyle.fontName.value || cleanStyle.fontName.label || 'Microsoft YaHei Bold';
            } else if (!cleanStyle.fontName || typeof cleanStyle.fontName !== 'string') {
                cleanStyle.fontName = String(cleanStyle.fontName || 'Microsoft YaHei Bold');
            }
            cleanStyle.fontName = cleanStyle.fontName.trim() || 'Microsoft YaHei Bold';

            // 确保背景透明度是数字
            let cleanBackgroundOpacity = cleanStyle.backgroundOpacity ?? 0;
            if (typeof cleanBackgroundOpacity === 'string') {
                if (cleanBackgroundOpacity.endsWith('%')) {
                    cleanBackgroundOpacity = parseFloat(cleanBackgroundOpacity) / 100;
                } else {
                    cleanBackgroundOpacity = parseFloat(cleanBackgroundOpacity);
                }
            }
            if (isNaN(cleanBackgroundOpacity) || cleanBackgroundOpacity < 0) {
                cleanBackgroundOpacity = 0;
            } else if (cleanBackgroundOpacity > 1) {
                if (cleanBackgroundOpacity <= 100) {
                    cleanBackgroundOpacity = cleanBackgroundOpacity / 100;
                } else {
                    cleanBackgroundOpacity = 1;
                }
            }
            cleanStyle.backgroundOpacity = cleanBackgroundOpacity;

            // 确保背景颜色存在
            if (!cleanStyle.backgroundColor) {
                cleanStyle.backgroundColor = 'transparent';
            }

            // 强制使用用户选择的位置（优先级最高）
            // 确保位置信息正确传递和执行
            if (subtitlePosition.value) {
                cleanStyle.position = subtitlePosition.value;
            } else if (cleanStyle.position) {
                // 如果样式中有位置，使用样式的
            } else {
                // 默认底部
                cleanStyle.position = 'bottom';
            }

            console.log("添加字幕到视频 - cleanStyle最终样式:", {
                fontName: cleanStyle.fontName,
                fontNameType: typeof cleanStyle.fontName,
                backgroundColor: cleanStyle.backgroundColor,
                backgroundOpacity: cleanStyle.backgroundOpacity,
                backgroundOpacityType: typeof cleanStyle.backgroundOpacity,
                willShowBackground: cleanStyle.backgroundColor !== 'transparent' && cleanStyle.backgroundOpacity > 0
            });

            // 获取关键词特效样式和关键词列表
            // 只在用户勾选了关键词特效时才应用
            let keywordStyle = null;
            let keywordsData = [];

            // 检查用户是否勾选了关键词特效
            if (enableKeywordEffects.value) {
                // 优先级1: 使用用户分组中的关键词（最高优先级）
                if (keywordGroups.value && keywordGroups.value.length > 0) {
                    // ✅ 修复：从分组中收集关键词，并创建 keywordMarkers 保留分组关联
                    const groupKeywords = new Set<string>();
                    const groupKeywordMap = new Map<string, string>();  // keyword -> groupId

                    for (const group of keywordGroups.value) {
                        if (group.keywords && group.keywords.length > 0) {
                            for (const kw of group.keywords) {
                                if (kw.enabled !== false) {  // 默认启用
                                    const keyword = kw.keyword.trim();
                                    if (keyword && !groupKeywords.has(keyword)) {
                                        groupKeywords.add(keyword);
                                        // ✅ 保存关键词与分组的关联
                                        groupKeywordMap.set(keyword, group.id);
                                    }
                                }
                            }
                        }
                    }

                    if (groupKeywords.size > 0) {
                        keywordsData = Array.from(groupKeywords).map(keyword => ({
                            keyword: keyword,
                            enabled: true
                        }));

                        // ✅ 创建 keywordMarkers，将每个关键词与其分组关联
                        keywordMarkers.value = Array.from(groupKeywords).map(keyword => ({
                            text: keyword,
                            groupId: groupKeywordMap.get(keyword) || '',
                            positions: [],
                            count: 1
                        }));

                        console.log("✅ 使用用户分组中的关键词（优先级最高）:", keywordsData);
                        console.log("✅ 创建 keywordMarkers:", keywordMarkers.value);
                    }
                }

                // 优先级2: 使用extractedKeywords（AI提取的关键词）
                if (keywordsData.length === 0 && extractedKeywords.value && extractedKeywords.value.length > 0) {
                    keywordsData = extractedKeywords.value.map(kw => ({
                        keyword: kw.keyword,
                        enabled: true
                    }));
                    console.log("使用AI提取的关键词:", keywordsData);
                }

                // 优先级3: 使用generatedKeywords（生成的关键词文本）
                if (keywordsData.length === 0 && generatedKeywords.value && generatedKeywords.value.trim()) {
                    const keywords = generatedKeywords.value.split('\n').filter(w => w.trim());
                    keywordsData = keywords.map(keyword => ({
                        keyword: keyword.trim(),
                        enabled: true
                    }));
                    console.log("使用生成的关键词文本:", keywordsData);
                }

                // 优先级4: 使用highlightWords（设置中的高亮词）
                if (keywordsData.length === 0 && highlightWords && highlightWords.length > 0) {
                    keywordsData = highlightWords.map(keyword => ({
                        keyword: keyword.trim(),
                        enabled: true
                    }));
                    console.log("使用设置中的高亮词:", keywordsData);
                }

                // 如果有关键词数据，获取特效样式
                if (keywordsData.length > 0) {
                    // 尝试获取用户选择的特效样式
                    keywordStyle = keywordEffectSelectorRef.value && keywordEffectSelectorRef.value.getSelectedStyle?.();

                    // 如果没有选择样式，使用默认样式
                    if (!keywordStyle) {
                        keywordStyle = {
                            fontSize: 72,
                            fontColor: '#FFD700',  // 金色
                            outlineColor: '#000000',
                            outlineWidth: 3,
                            shadowBlur: 0
                        };
                        console.log("使用默认关键词特效样式");
                    }

                    console.log("关键词特效已启用:", {
                        keywordStyle,
                        keywordsCount: keywordsData.length,
                        keywords: keywordsData.map(k => k.keyword)
                    });
                } else {
                    console.log("未找到关键词，跳过特效");
                }
            } else {
                console.log("用户未勾选关键词特效，跳过关键词特效应用");
            }

            console.log("添加字幕到视频，最终配置:", {
                userSelectedPosition: subtitlePosition.value,
                stylePosition: selectedStyle.position,
                finalPosition: cleanStyle.position,
                fontSize: cleanStyle.fontSize,
                highlightWords: highlightWords,
                keywordsDataCount: keywordsData.length,
                hasKeywordStyle: !!keywordStyle,
                fullStyle: JSON.stringify(cleanStyle, null, 2)
            });

            // 添加字幕到视频
            // 确保所有对象都可以被IPC序列化（深拷贝并清理）
            const cleanKeywordStyle = keywordStyle ? {
                fontSize: keywordStyle.fontSize,
                fontName: keywordStyle.fontName,  // ✅ 关键修复：添加字体名称（每组关键词字体都不一样）
                fontPath: keywordStyle.fontPath,  // ✅ 添加字体路径（如果字体管理器提供）
                fontColor: keywordStyle.fontColor,
                outlineColor: keywordStyle.outlineColor,
                outlineWidth: keywordStyle.outlineWidth,
                shadowBlur: keywordStyle.shadowBlur,
                shadowColor: keywordStyle.shadowColor,
                backgroundColor: keywordStyle.backgroundColor,  // ✅ 添加背景颜色
                backgroundOpacity: keywordStyle.backgroundOpacity  // ✅ 添加背景透明度
            } : null;

            // 🔧 关键词样式诊断：确保每组关键词有自己的字体
            if (cleanKeywordStyle && cleanKeywordStyle.fontName) {
                console.log('[关键词样式诊断] cleanKeywordStyle已包含fontName:', {
                    fontName: cleanKeywordStyle.fontName,
                    fontSize: cleanKeywordStyle.fontSize,
                    fontColor: cleanKeywordStyle.fontColor,
                    hasCustomFont: cleanKeywordStyle.fontName !== cleanStyle.fontName
                });
            } else if (keywordStyle) {
                console.warn('[关键词样式诊断] ⚠️ cleanKeywordStyle缺失fontName:', {
                    originalKeywordStyle: keywordStyle,
                    cleanKeywordStyle: cleanKeywordStyle
                });
            }

            const cleanTopTitleStyle = enableTopTitle.value && topTitleStyle.value ? {
                fontSize: topTitleStyle.value.fontSize,
                fontColor: topTitleStyle.value.fontColor,
                outlineColor: topTitleStyle.value.outlineColor,
                outlineWidth: topTitleStyle.value.outlineWidth,
                backgroundColor: topTitleStyle.value.backgroundColor,
                backgroundOpacity: topTitleStyle.value.backgroundOpacity,
                position: topTitleStyle.value.position
            } : null;

            // ✅ 关键修复：清理所有参数，确保可序列化
            // 这些参数可能包含 Proxy 对象或其他无法序列化的数据
            let cleanKeywordMarkers: any[] = [];
            let cleanKeywordsData: any[] = [];
            let cleanHighlightWords: string[] = [];

            try {
                if (keywordMarkers.value && Array.isArray(keywordMarkers.value) && keywordMarkers.value.length > 0) {
                    cleanKeywordMarkers = keywordMarkers.value.map((marker: any) => ({
                        text: marker.text,
                        groupId: marker.groupId,
                        positions: marker.positions || [],
                        count: marker.count || 1
                    }));
                }
            } catch (e) {
                console.warn('[autoGenerateSubtitleAndBGM] 清理 keywordMarkers 失败:', e);
            }

            try {
                if (keywordsData && Array.isArray(keywordsData) && keywordsData.length > 0) {
                    cleanKeywordsData = keywordsData.map((kw: any) => ({
                        keyword: typeof kw === 'string' ? kw : (kw.keyword || ''),
                        enabled: kw.enabled !== false
                    }));
                }
            } catch (e) {
                console.warn('[autoGenerateSubtitleAndBGM] 清理 keywordsData 失败:', e);
            }

            try {
                if (highlightWords && Array.isArray(highlightWords) && highlightWords.length > 0) {
                    cleanHighlightWords = highlightWords.map((word: any) =>
                        typeof word === 'string' ? word : String(word)
                    );
                }
            } catch (e) {
                console.warn('[autoGenerateSubtitleAndBGM] 清理 highlightWords 失败:', e);
            }

            // 使用srtFile.value而不是srtResult.srtPath，因为情感分析可能已经将其替换为ASS文件
            // ✅ 修复：清理并发送 keywordGroups 到后端
            let cleanKeywordGroups: any[] = [];
            try {
                if (keywordGroups.value && Array.isArray(keywordGroups.value) && keywordGroups.value.length > 0) {
                    cleanKeywordGroups = keywordGroups.value.map((group: any) => ({
                        id: group.id,
                        name: group.name,
                        description: group.description,
                        keywords: Array.isArray(group.keywords) ? group.keywords.map((kw: any) => ({
                            keyword: typeof kw === 'string' ? kw : (kw.keyword || ''),
                            enabled: kw.enabled !== false
                        })) : [],
                        color: group.color,
                        styleOverride: group.styleOverride ? {
                            fontName: group.styleOverride.fontName,      // ✅ 关键修复：添加字体名称（每组关键词字体都不一样）
                            fontPath: group.styleOverride.fontPath,      // ✅ 添加字体路径（如果可用）
                            fontSize: group.styleOverride.fontSize,
                            fontColor: group.styleOverride.fontColor,
                            outlineColor: group.styleOverride.outlineColor,
                            outlineWidth: group.styleOverride.outlineWidth,
                            backgroundColor: group.styleOverride.backgroundColor,  // ✅ 添加背景颜色
                            backgroundOpacity: group.styleOverride.backgroundOpacity  // ✅ 添加背景透明度
                        } : null,
                        effectId: group.effectId,
                        createdAt: group.createdAt
                    }));
                    console.log('[autoGenerateSubtitleAndBGM] 将发送 keywordGroups 到后端:', {
                        count: cleanKeywordGroups.length,
                        groups: cleanKeywordGroups.map(g => ({
                            id: g.id,
                            name: g.name,
                            effectId: g.effectId,
                            styleOverrideFontName: g.styleOverride?.fontName  // ✅ 诊断：显示字体名称
                        }))
                    });
                }
            } catch (e) {
                console.warn('[autoGenerateSubtitleAndBGM] 清理 keywordGroups 失败:', e);
            }

            const addSubtitleResult = await window.$mapi.ipAgent.addSubtitleToVideo({
                inputVideo: currentVideo,
                srtPath: srtFile.value,  // 修复：使用srtFile.value，支持ASS和SRT
                subtitleStyle: cleanStyle,
                highlightWords: cleanHighlightWords,  // ✅ 使用清理后的数据
                keywordStyle: cleanKeywordStyle,
                keywords: cleanKeywordsData,  // ✅ 使用清理后的数据（drawtext特效层需要）
                keywordMarkers: cleanKeywordMarkers,  // ✅ 使用清理后的 keywordMarkers
                keywordGroups: cleanKeywordGroups,  // ✅ 发送 keywordGroups 到后端！
                enableTopTitle: enableTopTitle.value,
                topTitleStyle: cleanTopTitleStyle,
                topTitleText: generatedTitle.value
            });

            console.log('[autoGenerateSubtitleAndBGM] 已传递 keywordMarkers 到后端:', {
                markerCount: keywordMarkers.value?.length || 0,
                hasKeywordMarkers: (keywordMarkers.value?.length || 0) > 0
            });

            if (!addSubtitleResult.success || !addSubtitleResult.outputVideo) {
                Message.error(addSubtitleResult.message || t("添加字幕失败"));
                return;
            }

            currentVideo = addSubtitleResult.outputVideo;
            Message.success(t("字幕添加完成"));
            */

            // 新系统逻辑结束，继续BGM处理
        }

        // 步骤2: 如果勾选了BGM，添加背景音乐
        if (enableBGM.value) {
            if (!selectedBGMPath.value) {
                Message.warning(t("请先选择背景音乐"));
                return;
            }

            Message.info(t("正在添加背景音乐..."));

            const bgmResult = await window.$mapi.ipAgent.addBGMToVideo({
                inputVideo: currentVideo,
                bgmPath: selectedBGMPath.value,
                bgmVolume: bgmVolume.value
            });

            if (!bgmResult.success || !bgmResult.outputVideo) {
                Message.error(bgmResult.message || t("添加背景音乐失败"));
                return;
            }

            currentVideo = bgmResult.outputVideo;

            // 提示文件已保存到程序目录
            if (bgmResult.outputDir) {
                Message.success(t("背景音乐添加完成，文件已保存到：") + bgmResult.outputDir);
            } else {
                Message.success(t("背景音乐添加完成"));
            }
        }

        // 🔧 【修复】设置最终视频URL + 保存到localStorage确保切换页面后仍可显示
        // 关键：使用 nextTick 确保 key 绑定能触发组件更新
        await nextTick();

        // 🔧 【关键修复】确保 URL 格式正确，并解析任何 JSON 格式的 URL
        // 如果 currentVideo 是 JSON 字符串，先解析出真实路径
        let cleanVideoUrl = currentVideo;
        if (typeof currentVideo === 'string' && (currentVideo.startsWith('{') || currentVideo.includes('{"'))) {
            console.warn('[autoGenerateSubtitleAndBGM] ⚠️ currentVideo 检测到 JSON 格式，尝试解析...', currentVideo.substring(0, 100));
            try {
                const parsed = JSON.parse(currentVideo);
                cleanVideoUrl = parsed.finalVideoUrl || parsed.url || currentVideo;
                console.log('[autoGenerateSubtitleAndBGM] ✅ 已解析 JSON，提取的真实URL:', cleanVideoUrl);
            } catch (e) {
                console.warn('[autoGenerateSubtitleAndBGM] ⚠️ JSON 解析失败，使用原值:', e.message);
            }
        }

        // 如果还没有 file:// 前缀，则添加；如果已有则不重复添加
        const videoUrlForStorage = cleanVideoUrl;
        const videoUrlForPlayback = cleanVideoUrl.startsWith('file://') ? cleanVideoUrl : 'file://' + cleanVideoUrl;

        finalVideoUrl.value = videoUrlForPlayback;

        // 🔧 【关键修复】保存为JSON格式，包含标志位，确保恢复时知道这是字幕视频
        const finalVideoData = {
            url: videoUrlForStorage,
            hasSubtitle: true,  // 标记：这个视频包含字幕
            timestamp: Date.now(),
            generatedBy: enableSubtitle.value ? 'subtitle' : (enableBGM.value ? 'bgm' : 'unknown')
        };
        localStorage.setItem('videoIPAgent_finalVideoUrl', JSON.stringify(finalVideoData));

        // 从最终视频提取音频，使用与字幕相同的时间戳，确保对应关系
        // 这样最终音频文件与字幕文件会有相同的时间戳，便于对应
        if (enableSubtitle.value && originalAudioTimestamp && originalAudioPath) {
            try {
                // 从原始音频路径获取输出目录
                const lastSlash = Math.max(originalAudioPath.lastIndexOf('\\'), originalAudioPath.lastIndexOf('/'));
                const outputDir = lastSlash > 0 ? originalAudioPath.substring(0, lastSlash) : '';
                const pathSeparator = outputDir.includes('\\') ? '\\' : '/';
                const finalAudioPath = outputDir + pathSeparator + `audio_final_${originalAudioTimestamp}.wav`;

                // 使用增强版提取音频函数，从最终视频提取音频
                const finalAudioResult = await window.$mapi.ipAgent.extractAudioFromVideoEnhanced({
                    videoPath: currentVideo.replace(/^file:\/\//, ''),
                    format: 'wav',
                    quality: '320',
                    sampleRate: '44100',
                    outputPath: finalAudioPath  // 使用与字幕相同的时间戳
                });

                if (finalAudioResult.success) {
                    console.log("最终音频已提取并保存:", finalAudioPath);
                    // 同时将原始音频文件重命名，标记为原始音频
                    try {
                        const renamedOriginalPath = outputDir + pathSeparator + `audio_original_${originalAudioTimestamp}.wav`;
                        await window.$mapi.file.copy(originalAudioPath, renamedOriginalPath, {isDataPath: false});
                    } catch (e) {
                        console.warn("重命名原始音频失败（不影响主流程）:", e);
                    }
                }
            } catch (error) {
                console.warn("提取最终音频失败（不影响主流程）:", error);
                // 不中断主流程
            }
        }

        // 最终视频也保存到程序目录（通过后端处理）
        Message.success(t("处理完成！文件已保存到程序目录的 video-output 文件夹"));

        // 🔧 【关键修复】将带字幕的最终视频URL保存到VideoGen任务记录的result字段
        // 这样在历史记录中可以直接获取到带字幕的最终视频，而不是只有基础视频
        let targetTaskId = latestVideoTaskId.value;

        // 🔧 备选方案：如果 latestVideoTaskId 为空，尝试从最近的 VideoGen 任务中获取
        if (!targetTaskId) {
            try {
                console.log('[autoGenerateSubtitleAndBGM] ⚠️ latestVideoTaskId 为空，尝试从最近的 VideoGen 任务中获取...');
                const records = await TaskService.list('VideoGen', 1);
                if (records.length > 0) {
                    // 找到最近的成功任务
                    const latestRecord = records
                        .filter(r => r.status === 'success')
                        .sort((a, b) => (b.endTime || b.startTime || 0) - (a.endTime || a.startTime || 0))[0];

                    if (latestRecord) {
                        targetTaskId = latestRecord.id;
                        console.log('[autoGenerateSubtitleAndBGM] ✅ 找到最近的 VideoGen 任务:', targetTaskId);
                    }
                }
            } catch (e) {
                console.warn('[autoGenerateSubtitleAndBGM] 获取最近的 VideoGen 任务失败:', e);
            }
        }

        // 🔧 【关键修复】为每一次生成字幕创建一个新的任务记录
        // 这样历史列表中就能显示所有的字幕版本，而不仅仅是最新的一个
        console.log('[autoGenerateSubtitleAndBGM] 📋 检查任务记录保存条件:', {
            hasTargetTaskId: !!targetTaskId,
            targetTaskId: targetTaskId,
            hasFinalVideoUrl: !!finalVideoUrl.value,
            finalVideoUrl: finalVideoUrl.value?.substring(0, 50) + '...',
            latestVideoTaskIdVariable: latestVideoTaskId.value,
            note: '如果两个都为空，字幕视频不会保存到历史记录'
        });

        if (!targetTaskId) {
            console.error('[autoGenerateSubtitleAndBGM] ❌ targetTaskId为空！可能原因：');
            console.error('  1. 没有先生成视频（latestVideoTaskId未设置）');
            console.error('  2. 数据库中没有VideoGen类型的成功任务');
            console.error('  3. 请先点击"生成视频"，再点击"生成字幕和BGM"');
            Message.error(t('❌ 未找到视频任务！请先生成视频，再生成字幕'));
        }

        if (!finalVideoUrl.value) {
            console.error('[autoGenerateSubtitleAndBGM] ❌ finalVideoUrl为空！这不应该发生');
            console.error('  检查前面的字幕生成步骤是否成功');
        }

        if (targetTaskId && finalVideoUrl.value) {
            try {
                console.log('[autoGenerateSubtitleAndBGM] ✅ 条件满足，为每次字幕生成创建独立的任务记录...');

                // 获取原始任务信息
                const originalTask = await TaskService.get(targetTaskId);

                if (originalTask) {
                    // ✅ 【修复】为每次字幕生成创建新的独立任务记录
                    // 使用当前时间戳确保每次都是新记录
                    const now = Date.now();
                    const timestamp = new Date(now).toLocaleTimeString();

                    const newTaskData = {
                        biz: 'VideoGen',
                        type: originalTask.type || 1,
                        title: `${originalTask.title || '未命名'} (字幕${timestamp})`,
                        status: 'success',
                        startTime: now,
                        endTime: now,
                        serverName: originalTask.serverName || '',
                        serverTitle: originalTask.serverTitle || '',
                        serverVersion: originalTask.serverVersion || '',
                        param: JSON.stringify(originalTask.param || {}),
                        modelConfig: JSON.stringify(originalTask.modelConfig || {}),
                        jobResult: JSON.stringify({}),
                        result: JSON.stringify({
                            url: originalTask.result?.url || '',
                            finalVideoUrl: finalVideoUrl.value
                        })
                    };

                    // ✅ 直接使用数据库API插入，绕过TaskService的复杂逻辑
                    const newTaskId = await window.$mapi.db.insert(
                        `INSERT INTO data_task (biz, type, title, status, startTime, endTime, serverName, serverTitle,
                                                serverVersion, param, modelConfig, jobResult, result)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            newTaskData.biz,
                            newTaskData.type,
                            newTaskData.title,
                            newTaskData.status,
                            newTaskData.startTime,
                            newTaskData.endTime,
                            newTaskData.serverName,
                            newTaskData.serverTitle,
                            newTaskData.serverVersion,
                            newTaskData.param,
                            newTaskData.modelConfig,
                            newTaskData.jobResult,
                            newTaskData.result
                        ]
                    );

                    console.log('[autoGenerateSubtitleAndBGM] ✅ 新任务记录已创建:', {
                        newTaskId,
                        title: newTaskData.title,
                        finalVideoUrl: finalVideoUrl.value.substring(0, 50) + '...'
                    });

                    // 验证任务是否正确保存
                    const savedTask = await TaskService.get(newTaskId);
                    console.log('[autoGenerateSubtitleAndBGM] 验证新任务:', {
                        id: newTaskId,
                        hasFinalVideoUrl: !!savedTask?.result?.finalVideoUrl,
                        resultRaw: savedTask?.result
                    });

                    // 刷新历史列表
                    setTimeout(async () => {
                        try {
                            console.log('[autoGenerateSubtitleAndBGM] 🔄 刷新历史列表...');
                            await loadGeneratedVideoHistory();

                            const foundInHistory = generatedVideoHistory.value.find(item => item.id === newTaskId);
                            if (foundInHistory) {
                                console.log('[autoGenerateSubtitleAndBGM] ✅ 新任务已出现在历史列表顶部');
                                Message.success(t('✅ 字幕视频已保存到历史记录'));
                            } else {
                                console.error('[autoGenerateSubtitleAndBGM] ❌ 新任务未在历史列表中');
                            }
                        } catch (error) {
                            console.error('[autoGenerateSubtitleAndBGM] 刷新失败:', error);
                        }
                    }, 500);
                } else {
                    console.warn('[autoGenerateSubtitleAndBGM] ⚠️ 无法获取原始任务');
                }
            } catch (error) {
                console.error('[autoGenerateSubtitleAndBGM] ❌ 创建任务失败:', error);
            }
        } else {
            console.error('[autoGenerateSubtitleAndBGM] ❌ 无法保存字幕视频到历史记录！原因：', {
                targetTaskId: targetTaskId || '(缺失)',
                finalVideoUrl: finalVideoUrl.value ? '有' : '(缺失)',
                note: '这意味着生成的字幕视频不会出现在历史列表中'
            });
            Message.warning(t("⚠️ 警告：字幕视频未保存到历史记录（不会显示在历史列表中）"));
        }
    } catch (error: any) {
        console.error("生成字幕和BGM失败:", error);
        Message.error(t("处理失败：") + (error?.message || String(error)));
    } finally {
        isGeneratingSubtitle.value = false;
        // 🔧 【修复】只清除字幕生成状态，保留最终视频URL
        // finalVideoUrl 需要持久化，以便切换页面后仍能看到结果
        localStorage.removeItem('videoIPAgent_isGeneratingSubtitle');
        // 注意：不删除 finalVideoUrl，让用户切换页面后仍能看到结果
    }
};

// 自动生成封面
const generateCover = async () => {
    // 使用原始视频（没有字幕的视频）生成封面，这样看起来更干净
    // 优先级：原始视频 > 处理后的视频（不包含最终带字幕的视频）
    let inputVideo = videoPreviewUrl.value || processedVideoUrl.value;

    if (!inputVideo) {
        if (coverConfig.value?.coverStyle?.customVideoPath) {
            inputVideo = coverConfig.value.coverStyle.customVideoPath;
        }
    }

    if (!inputVideo) {
        Message.warning(t("请先生成视频或上传素材"));
        return;
    }

    console.log("封面生成使用视频:", inputVideo);
    console.log("视频类型:", inputVideo === videoPreviewUrl.value ? "原始视频" : "处理后视频");

    // 检查是否有标题文字
    if (!generatedTitle.value || !generatedTitle.value.trim()) {
        Message.warning(t("请先生成标题文字"));
        return;
    }

    // 检查是否选择了模板，如果没有则尝试自动选择第一个模板
    if (!coverConfig.value?.templateId) {
        try {
            const result = await window.$mapi.ipAgent.getCoverTemplates();
            if (result.success && result.templates && result.templates.length > 0) {
                // 自动选择第一个模板
                const firstTemplate = result.templates[0];
                const templateResult = await window.$mapi.ipAgent.getCoverTemplate({id: firstTemplate.id});

                if (templateResult.success && templateResult.template) {
                    const {id, name, thumbnailPath, createdAt, updatedAt, ...pureConfig} = templateResult.template;
                    coverConfig.value = {
                        templateId: firstTemplate.id,
                        coverStyle: pureConfig
                    };
                    coverTemplateName.value = name;
                    console.log('[自动选择模板]:', name);
                    Message.success(t("已自动选择模板：") + name);
                }
            } else {
                Message.warning(t("请先在封面设置中选择模板"));
                return;
            }
        } catch (error) {
            console.error('自动选择模板失败:', error);
            Message.warning(t("请先在封面设置中选择模板"));
            return;
        }
    }

    try {
        isGeneratingCover.value = true;
        coverPreviewUrl.value = "";

        console.log('=== 开始生成封面 ===');
        console.log('coverConfig.value:', JSON.stringify(coverConfig.value, null, 2));
        console.log('coverTemplateName.value:', coverTemplateName.value);

        // 关键诊断：检查 coverConfig 是否包含必要的字段
        if (coverConfig.value?.coverStyle) {
            const style = coverConfig.value.coverStyle;
            console.log('=== 封面配置诊断 ===');
            console.log('配置字段数量:', Object.keys(style).length);
            console.log('配置字段列表:', Object.keys(style));
            console.log('关键字段检查:');
            console.log('  - titleText:', style.titleText);
            console.log('  - titleFontFamily:', style.titleFontFamily);
            console.log('  - titleBackgroundEnabled:', style.titleBackgroundEnabled);
            console.log('  - backgroundBlurEnabled:', style.backgroundBlurEnabled);
            console.log('  - extractPerson:', style.extractPerson);
            console.log('  - personSize:', style.personSize);
            console.log('  - personOutlineColor:', style.personOutlineColor);
            console.log('  - personOutlineWidth:', style.personOutlineWidth);
            console.log('=== 诊断结束 ===');
        }

        Message.info(t("正在提取视频出彩帧..."));

        // 获取封面样式配置
        // 优先使用高级设置中保存的配置，否则使用默认配置
        const hasCoverStyle = coverConfig.value?.coverStyle &&
            Object.keys(coverConfig.value.coverStyle).length > 0;

        console.log('hasCoverStyle:', hasCoverStyle);
        console.log('coverConfig.value?.coverStyle keys:', coverConfig.value?.coverStyle ? Object.keys(coverConfig.value.coverStyle) : 'undefined');

        let selectedEffectStyle = hasCoverStyle
            ? coverConfig.value.coverStyle
            : ((coverEffectSelectorRef.value && coverEffectSelectorRef.value.getSelectedStyle?.()) || coverStyle.value);

        console.log('selectedEffectStyle (before clean):', JSON.stringify(selectedEffectStyle, null, 2));

        // 确保effectStyle是可序列化的纯数据对象（IPC要求）
        // 手动提取字段，避免structuredClone失败
        // ✅ 修复：从 coverConfig 中手动提取所有可序列化的字段，避免Proxy对象
        const cleanEffectStyle: any = coverConfig.value?.coverStyle ? {
            // 基础配置
            backgroundEnabled: coverConfig.value.coverStyle.backgroundEnabled,
            backgroundBlurEnabled: coverConfig.value.coverStyle.backgroundBlurEnabled,
            backgroundBlurIntensity: coverConfig.value.coverStyle.backgroundBlurIntensity,
            personBorderEnabled: coverConfig.value.coverStyle.personBorderEnabled,
            personBorderStyle: coverConfig.value.coverStyle.personBorderStyle,
            personBorderColor: coverConfig.value.coverStyle.personBorderColor,
            personBorderWidth: coverConfig.value.coverStyle.personBorderWidth,
            personBorderDashLength: coverConfig.value.coverStyle.personBorderDashLength,
            personBorderGapLength: coverConfig.value.coverStyle.personBorderGapLength,
            personSize: coverConfig.value.coverStyle.personSize,
            personPosition: coverConfig.value.coverStyle.personPosition ? {
                x: coverConfig.value.coverStyle.personPosition.x,
                y: coverConfig.value.coverStyle.personPosition.y
            } : undefined,
            personRotation: coverConfig.value.coverStyle.personRotation,
            backgroundSize: coverConfig.value.coverStyle.backgroundSize,
            backgroundPosition: coverConfig.value.coverStyle.backgroundPosition ? {
                x: coverConfig.value.coverStyle.backgroundPosition.x,
                y: coverConfig.value.coverStyle.backgroundPosition.y
            } : undefined,
            autoSplitText: coverConfig.value.coverStyle.autoSplitText,
            titleMaxLength: coverConfig.value.coverStyle.titleMaxLength,
            subtitleMaxLength: coverConfig.value.coverStyle.subtitleMaxLength,
            titleText: coverConfig.value.coverStyle.titleText,
            titleFontFamily: coverConfig.value.coverStyle.titleFontFamily,
            titleFontSize: coverConfig.value.coverStyle.titleFontSize,
            titleFontWeight: coverConfig.value.coverStyle.titleFontWeight,
            titleColor: coverConfig.value.coverStyle.titleColor,
            titleStrokeColor: coverConfig.value.coverStyle.titleStrokeColor,
            titleStrokeWidth: coverConfig.value.coverStyle.titleStrokeWidth,
            titleShadowColor: coverConfig.value.coverStyle.titleShadowColor,
            titleShadowOffsetX: coverConfig.value.coverStyle.titleShadowOffsetX,
            titleShadowOffsetY: coverConfig.value.coverStyle.titleShadowOffsetY,
            titleShadowBlur: coverConfig.value.coverStyle.titleShadowBlur,
            titleShadowEnabled: coverConfig.value.coverStyle.titleShadowEnabled,
            titleShadowLayers: Array.isArray(coverConfig.value.coverStyle.titleShadowLayers) ?
                coverConfig.value.coverStyle.titleShadowLayers.map((layer: any) => ({
                    offsetX: layer.offsetX,
                    offsetY: layer.offsetY,
                    blur: layer.blur,
                    color: layer.color,
                    opacity: layer.opacity,
                    enabled: layer.enabled
                })) : [],
            titlePosition: coverConfig.value.coverStyle.titlePosition ? {
                x: coverConfig.value.coverStyle.titlePosition.x,
                y: coverConfig.value.coverStyle.titlePosition.y
            } : undefined,
            titleRotation: coverConfig.value.coverStyle.titleRotation,
            titleDirection: coverConfig.value.coverStyle.titleDirection,
            titleCharSpacing: coverConfig.value.coverStyle.titleCharSpacing,
            titleLineSpacing: coverConfig.value.coverStyle.titleLineSpacing,
            titleMaxCharsPerLine: coverConfig.value.coverStyle.titleMaxCharsPerLine,
            titleBackgroundEnabled: coverConfig.value.coverStyle.titleBackgroundEnabled,
            titleBackgroundColor: coverConfig.value.coverStyle.titleBackgroundColor,
            titleBackgroundOpacity: coverConfig.value.coverStyle.titleBackgroundOpacity,
            titleBackgroundShape: coverConfig.value.coverStyle.titleBackgroundShape,
            titleBackgroundSize: coverConfig.value.coverStyle.titleBackgroundSize ? {
                width: coverConfig.value.coverStyle.titleBackgroundSize.width,
                height: coverConfig.value.coverStyle.titleBackgroundSize.height
            } : undefined,
            titleBackgroundPosition: coverConfig.value.coverStyle.titleBackgroundPosition ? {
                x: coverConfig.value.coverStyle.titleBackgroundPosition.x,
                y: coverConfig.value.coverStyle.titleBackgroundPosition.y
            } : undefined,
            titleBackgroundPoints: Array.isArray(coverConfig.value.coverStyle.titleBackgroundPoints) ?
                coverConfig.value.coverStyle.titleBackgroundPoints.map((p: any) => ({
                    x: p.x,
                    y: p.y
                })) : [],
            titleBackgroundRadius: coverConfig.value.coverStyle.titleBackgroundRadius,
            titleBackgroundRotation: coverConfig.value.coverStyle.titleBackgroundRotation,
            subtitleText: coverConfig.value.coverStyle.subtitleText,
            subtitleFontFamily: coverConfig.value.coverStyle.subtitleFontFamily,
            subtitleFontSize: coverConfig.value.coverStyle.subtitleFontSize,
            subtitleFontWeight: coverConfig.value.coverStyle.subtitleFontWeight,
            subtitleColor: coverConfig.value.coverStyle.subtitleColor,
            subtitleStrokeColor: coverConfig.value.coverStyle.subtitleStrokeColor,
            subtitleStrokeWidth: coverConfig.value.coverStyle.subtitleStrokeWidth,
            subtitleShadowColor: coverConfig.value.coverStyle.subtitleShadowColor,
            subtitleShadowOffsetX: coverConfig.value.coverStyle.subtitleShadowOffsetX,
            subtitleShadowOffsetY: coverConfig.value.coverStyle.subtitleShadowOffsetY,
            subtitleShadowBlur: coverConfig.value.coverStyle.subtitleShadowBlur,
            subtitleShadowEnabled: coverConfig.value.coverStyle.subtitleShadowEnabled,
            subtitleShadowLayers: Array.isArray(coverConfig.value.coverStyle.subtitleShadowLayers) ?
                coverConfig.value.coverStyle.subtitleShadowLayers.map((layer: any) => ({
                    offsetX: layer.offsetX,
                    offsetY: layer.offsetY,
                    blur: layer.blur,
                    color: layer.color,
                    opacity: layer.opacity,
                    enabled: layer.enabled
                })) : [],
            subtitlePosition: coverConfig.value.coverStyle.subtitlePosition ? {
                x: coverConfig.value.coverStyle.subtitlePosition.x,
                y: coverConfig.value.coverStyle.subtitlePosition.y
            } : undefined,
            subtitleRotation: coverConfig.value.coverStyle.subtitleRotation,
            subtitleDirection: coverConfig.value.coverStyle.subtitleDirection,
            subtitleCharSpacing: coverConfig.value.coverStyle.subtitleCharSpacing,
            subtitleLineSpacing: coverConfig.value.coverStyle.subtitleLineSpacing,
            subtitleMaxCharsPerLine: coverConfig.value.coverStyle.subtitleMaxCharsPerLine,
            subtitleBackgroundEnabled: coverConfig.value.coverStyle.subtitleBackgroundEnabled,
            subtitleBackgroundColor: coverConfig.value.coverStyle.subtitleBackgroundColor,
            subtitleBackgroundOpacity: coverConfig.value.coverStyle.subtitleBackgroundOpacity,
            subtitleBackgroundShape: coverConfig.value.coverStyle.subtitleBackgroundShape,
            subtitleBackgroundSize: coverConfig.value.coverStyle.subtitleBackgroundSize ? {
                width: coverConfig.value.coverStyle.subtitleBackgroundSize.width,
                height: coverConfig.value.coverStyle.subtitleBackgroundSize.height
            } : undefined,
            subtitleBackgroundPosition: coverConfig.value.coverStyle.subtitleBackgroundPosition ? {
                x: coverConfig.value.coverStyle.subtitleBackgroundPosition.x,
                y: coverConfig.value.coverStyle.subtitleBackgroundPosition.y
            } : undefined,
            subtitleBackgroundPoints: Array.isArray(coverConfig.value.coverStyle.subtitleBackgroundPoints) ?
                coverConfig.value.coverStyle.subtitleBackgroundPoints.map((p: any) => ({
                    x: p.x,
                    y: p.y
                })) : [],
            subtitleBackgroundRadius: coverConfig.value.coverStyle.subtitleBackgroundRadius,
            subtitleBackgroundRotation: coverConfig.value.coverStyle.subtitleBackgroundRotation,
            maskEnabled: coverConfig.value.coverStyle.maskEnabled,
            maskSize: coverConfig.value.coverStyle.maskSize,
            maskPosition: coverConfig.value.coverStyle.maskPosition ? {
                x: coverConfig.value.coverStyle.maskPosition.x,
                y: coverConfig.value.coverStyle.maskPosition.y
            } : undefined,
            maskOpacity: coverConfig.value.coverStyle.maskOpacity,
            maskShape: coverConfig.value.coverStyle.maskShape
        } : {};

        console.log('=== 生成封面 - 配置详情 ===');
        console.log('hasCoverStyle:', hasCoverStyle);
        console.log('coverConfig.value?.coverStyle keys:', coverConfig.value?.coverStyle ? Object.keys(coverConfig.value.coverStyle) : []);
        console.log('templateId:', coverConfig.value?.templateId);
        console.log('templateName:', coverTemplateName.value);
        console.log('cleanEffectStyle keys:', Object.keys(cleanEffectStyle));
        console.log('cleanEffectStyle (完整):', JSON.stringify(cleanEffectStyle, null, 2));
        console.log('=== 配置详情结束 ===');

        // ✅ 修复：确保 titlePosition 不丢失
        // 优先使用 coverConfig 中保存的位置，其次使用 cleanEffectStyle 中的位置
        if (coverConfig.value?.coverStyle?.titlePosition) {
            // 直接赋值而不使用structuredClone
            cleanEffectStyle.titlePosition = {
                x: coverConfig.value.coverStyle.titlePosition.x,
                y: coverConfig.value.coverStyle.titlePosition.y
            };
            console.log('[封面生成] 从 coverConfig 恢复 titlePosition:', cleanEffectStyle.titlePosition);
        } else if (!cleanEffectStyle.titlePosition) {
            // 如果都没有，使用默认值（中下部）
            cleanEffectStyle.titlePosition = {x: 50, y: 80};
            console.warn('[封面生成] titlePosition 丢失，使用默认值:', cleanEffectStyle.titlePosition);
        } else {
            console.log('[封面生成] 使用 cleanEffectStyle 中的 titlePosition:', cleanEffectStyle.titlePosition);
        }

        // 同样确保 subtitlePosition 不丢失
        if (coverConfig.value?.coverStyle?.subtitlePosition && !cleanEffectStyle.subtitlePosition) {
            // 直接赋值而不使用structuredClone
            cleanEffectStyle.subtitlePosition = {
                x: coverConfig.value.coverStyle.subtitlePosition.x,
                y: coverConfig.value.coverStyle.subtitlePosition.y
            };
            console.log('[封面生成] 从 coverConfig 恢复 subtitlePosition:', cleanEffectStyle.subtitlePosition);
        }

        // ✅ 修复：确保字体名称正确传递（从coverConfig中恢复）
        if (coverConfig.value?.coverStyle?.titleFontFamily) {
            cleanEffectStyle.titleFontFamily = coverConfig.value.coverStyle.titleFontFamily;
            console.log('[封面生成] 从 coverConfig 恢复 titleFontFamily:', cleanEffectStyle.titleFontFamily);
        }
        if (coverConfig.value?.coverStyle?.subtitleFontFamily) {
            cleanEffectStyle.subtitleFontFamily = coverConfig.value.coverStyle.subtitleFontFamily;
            console.log('[封面生成] 从 coverConfig 恢复 subtitleFontFamily:', cleanEffectStyle.subtitleFontFamily);
        }

        // ✅ 再次深拷贝整个 cleanEffectStyle，确保所有嵌套对象都可序列化
        // ✅ 修复：使用手动字段提取而不是structuredClone来避免Proxy对象问题
        const serializableEffectStyle = {...cleanEffectStyle};

        // ✅ 立即清理不可序列化的字段（Electron IPC 要求）
        // 必须在这里清理，而不是在 finalTemplate 创建后，因为这些字段会被 spread 到 finalTemplate
        delete serializableEffectStyle._converted;
        // ✅ 修复：保留 titleBackgroundPoints 和 subtitleBackgroundPoints（polygon顶点数据需要传递给Python）
        // delete serializableEffectStyle.titleBackgroundPoints;
        // delete serializableEffectStyle.subtitleBackgroundPoints;

        Message.info(t("正在生成封面..."));

        // ✅ 关键修复：始终使用04区域生成的标题，模板只提供样式和排版信息
        // 1. 从04区域获取原始标题
        let titleTextToUse = generatedTitle.value;
        let subtitleTextToUse = '';

        // 2. 如果模板启用了自动切割，按照模板的切割规则处理04标题
        if (coverConfig.value?.coverStyle?.autoSplitText) {
            const titleMaxLength = coverConfig.value.coverStyle.titleMaxLength || 20;
            const subtitleMaxLength = coverConfig.value.coverStyle.subtitleMaxLength || 30;

            console.log('[自动切割] 拆分前:', {
                titleText: titleTextToUse,
                titleLength: titleTextToUse.length,
                titleMaxLength: titleMaxLength,
                willBeSplit: titleTextToUse.length > titleMaxLength
            });

            // 切割标题
            if (titleTextToUse.length > titleMaxLength) {
                const mainTitle = titleTextToUse.substring(0, titleMaxLength);
                const subTitle = titleTextToUse.substring(titleMaxLength, titleMaxLength + subtitleMaxLength);

                // ✅ 修复：不再硬编码"每2个字换行"
                // 让后端根据 titleMaxCharsPerLine 参数来决定折行
                // 前端只负责按字数长度限制文本
                titleTextToUse = mainTitle;
                subtitleTextToUse = subTitle;

                console.log('[自动切割] 拆分后:', {
                    original: generatedTitle.value,
                    title: mainTitle,
                    subtitle: subTitle,
                    titleLength: mainTitle.length,
                    subtitleLength: subTitle.length,
                    note: '后端将根据 titleMaxCharsPerLine 和 subtitleMaxCharsPerLine 进行折行'
                });
            } else {
                console.log('[自动切割] 文本未超过限制，不需要拆分');
            }
        }

        // 3. 更新 serializableEffectStyle，使用04标题 + 模板样式
        serializableEffectStyle.titleText = titleTextToUse;
        serializableEffectStyle.subtitleText = subtitleTextToUse;

        console.log('[封面生成] 使用04区域标题 + 模板样式:', {
            source: '04标题生成区域',
            originalTitle: generatedTitle.value,
            processedTitle: titleTextToUse,
            subtitle: subtitleTextToUse,
            autoSplit: coverConfig.value?.coverStyle?.autoSplitText,
            hasTitleLineBreaks: titleTextToUse.includes('\n'),
            titleLines: titleTextToUse.split('\n').length
        });

        // ✅ 关键修复：转换模板格式为后端期望的格式
        // 确保所有参数正确传递给后端，包括字体、间距等
        // ✅ 修复：使用对象扩展而不是structuredClone来避免Proxy对象问题
        const convertedStyle = {...serializableEffectStyle};

        // ✅ 关键修复：从 coverConfig 优先读取所有参数，确保使用最新的用户设置
        // coverConfig.value.coverStyle 是最可靠的数据源，因为它是用户最后应用的配置
        const mainStyle = coverConfig.value?.coverStyle || {};
        const subStyle = coverConfig.value?.coverStyle || {};

        // ✅ 修复：优先使用 titleMaxCharsPerLine（每行字数），其次 titleMaxLength（总长度限制），最后使用默认值 10
        let mainMaxCharsPerLine = mainStyle.titleMaxCharsPerLine || mainStyle.titleMaxLength || convertedStyle.titleMaxCharsPerLine || convertedStyle.titleMaxLength || 10;

        let mainDirection = mainStyle.titleDirection || convertedStyle.titleDirection || 'horizontal';
        let mainCharSpacing = mainStyle.titleCharSpacing !== undefined ? mainStyle.titleCharSpacing : convertedStyle.titleCharSpacing;
        let mainLineSpacing = mainStyle.titleLineSpacing !== undefined ? mainStyle.titleLineSpacing : convertedStyle.titleLineSpacing;

        // ✅ 修复：优先使用 subtitleMaxCharsPerLine（每行字数），其次 subtitleMaxLength（总长度限制），最后使用默认值 15
        let subMaxCharsPerLine = subStyle.subtitleMaxCharsPerLine || subStyle.subtitleMaxLength || convertedStyle.subtitleMaxCharsPerLine || convertedStyle.subtitleMaxLength || 15;

        console.log('[最终决定] mainMaxCharsPerLine:', mainMaxCharsPerLine, '来源检查:', {
            'mainStyle.titleMaxLength': mainStyle.titleMaxLength,
            'mainStyle.titleMaxCharsPerLine': mainStyle.titleMaxCharsPerLine,
            'convertedStyle.titleMaxLength': convertedStyle.titleMaxLength,
            'convertedStyle.titleMaxCharsPerLine': convertedStyle.titleMaxCharsPerLine
        });
        console.log('[最终决定] subMaxCharsPerLine:', subMaxCharsPerLine);
        let subDirection = subStyle.subtitleDirection || convertedStyle.subtitleDirection || 'horizontal';
        let subCharSpacing = subStyle.subtitleCharSpacing !== undefined ? subStyle.subtitleCharSpacing : convertedStyle.subtitleCharSpacing;
        let subLineSpacing = subStyle.subtitleLineSpacing !== undefined ? subStyle.subtitleLineSpacing : convertedStyle.subtitleLineSpacing;

        // 详细日志：显示参数来源
        console.log('[生成封面] mainStyle.titleMaxLength:', mainStyle.titleMaxLength);
        console.log('[生成封面] mainStyle.titleMaxCharsPerLine:', mainStyle.titleMaxCharsPerLine);
        console.log('[生成封面] convertedStyle.titleMaxLength:', convertedStyle.titleMaxLength);
        console.log('[生成封面] convertedStyle.titleMaxCharsPerLine:', convertedStyle.titleMaxCharsPerLine);
        console.log('[生成封面] 使用的关键参数（从 coverConfig 读取）:', {
            main: {
                maxCharsPerLine: mainMaxCharsPerLine,
                direction: mainDirection,
                charSpacing: mainCharSpacing,
                lineSpacing: mainLineSpacing
            },
            sub: {
                maxCharsPerLine: subMaxCharsPerLine,
                direction: subDirection,
                charSpacing: subCharSpacing,
                lineSpacing: subLineSpacing
            }
        });

        if (convertedStyle.titleText || convertedStyle.subtitleText) {
            if (!convertedStyle.titles) {
                convertedStyle.titles = {main: {}, sub: {}};
            }

            // 转换主标题字段 - 包含所有样式参数，并确保有默认值
            if (!convertedStyle.titles.main) {
                convertedStyle.titles.main = {};
            }

            // 获取字体大小用于计算默认间距
            const mainFontSize = convertedStyle.titleFontSize || 120;

            convertedStyle.titles.main.text = convertedStyle.titleText || '';
            convertedStyle.titles.main.maxLength = mainMaxCharsPerLine;  // ✅ 使用从 coverConfig 读取的值
            convertedStyle.titles.main.fontSize = mainFontSize;
            convertedStyle.titles.main.fontWeight = convertedStyle.titleFontWeight;
            convertedStyle.titles.main.color = convertedStyle.titleColor;
            convertedStyle.titles.main.strokeColor = convertedStyle.titleStrokeColor;
            convertedStyle.titles.main.strokeWidth = convertedStyle.titleStrokeWidth;
            convertedStyle.titles.main.position = convertedStyle.titlePosition;
            convertedStyle.titles.main.direction = mainDirection;  // ✅ 使用从 coverConfig 读取的值
            // ✅ 使用从 coverConfig 读取的间距值，如果没有则使用默认值
            convertedStyle.titles.main.charSpacing = (mainCharSpacing !== undefined && mainCharSpacing !== null)
                ? mainCharSpacing
                : Math.round(mainFontSize * 0.2);
            convertedStyle.titles.main.lineSpacing = (mainLineSpacing !== undefined && mainLineSpacing !== null)
                ? mainLineSpacing
                : Math.round(mainFontSize * 1.2);
            convertedStyle.titles.main.fontFamily = convertedStyle.titleFontFamily || 'SimHei';  // ✅ 字体名称，有默认值
            convertedStyle.titles.main.fontName = convertedStyle.titleFontFamily || 'SimHei';  // ✅ 备用字段名
            // ✅ 新增：传递阴影参数（从 coverConfig 读取，确保与画布一致）
            convertedStyle.titles.main.shadowEnabled = mainStyle.titleShadowEnabled !== undefined ? mainStyle.titleShadowEnabled : (convertedStyle.titleShadowEnabled || false);
            convertedStyle.titles.main.shadowColor = mainStyle.titleShadowColor || convertedStyle.titleShadowColor || '#000000';
            convertedStyle.titles.main.shadowOffsetX = mainStyle.titleShadowOffsetX !== undefined ? mainStyle.titleShadowOffsetX : (convertedStyle.titleShadowOffsetX || 0);
            convertedStyle.titles.main.shadowOffsetY = mainStyle.titleShadowOffsetY !== undefined ? mainStyle.titleShadowOffsetY : (convertedStyle.titleShadowOffsetY || 0);
            convertedStyle.titles.main.shadowBlur = mainStyle.titleShadowBlur !== undefined ? mainStyle.titleShadowBlur : (convertedStyle.titleShadowBlur || 0);
            // ✅ 新增：传递多层阴影数据（清理不可序列化的字段）
            convertedStyle.titles.main.shadowLayers = (mainStyle.titleShadowLayers || convertedStyle.titleShadowLayers || []).map((layer: any) => ({
                offsetX: layer.offsetX,
                offsetY: layer.offsetY,
                blur: layer.blur,
                color: layer.color,
                opacity: layer.opacity,
                enabled: layer.enabled
            }));

            // 转换副标题字段 - 包含所有样式参数，并确保有默认值
            if (!convertedStyle.titles.sub) {
                convertedStyle.titles.sub = {};
            }

            // 获取字体大小用于计算默认间距
            const subFontSize = convertedStyle.subtitleFontSize || 60;

            convertedStyle.titles.sub.text = convertedStyle.subtitleText || '';
            convertedStyle.titles.sub.maxLength = subMaxCharsPerLine;  // ✅ 使用从 coverConfig 读取的值
            convertedStyle.titles.sub.fontSize = subFontSize;
            convertedStyle.titles.sub.fontWeight = convertedStyle.subtitleFontWeight;
            convertedStyle.titles.sub.color = convertedStyle.subtitleColor;
            convertedStyle.titles.sub.strokeColor = convertedStyle.subtitleStrokeColor;
            convertedStyle.titles.sub.strokeWidth = convertedStyle.subtitleStrokeWidth;
            convertedStyle.titles.sub.position = convertedStyle.subtitlePosition;
            convertedStyle.titles.sub.direction = subDirection;  // ✅ 使用从 coverConfig 读取的值
            // ✅ 使用从 coverConfig 读取的间距值，如果没有则使用默认值
            convertedStyle.titles.sub.charSpacing = (subCharSpacing !== undefined && subCharSpacing !== null)
                ? subCharSpacing
                : Math.round(subFontSize * 0.2);
            convertedStyle.titles.sub.lineSpacing = (subLineSpacing !== undefined && subLineSpacing !== null)
                ? subLineSpacing
                : Math.round(subFontSize * 1.2);
            convertedStyle.titles.sub.fontFamily = convertedStyle.subtitleFontFamily || 'SimHei';  // ✅ 字体名称，有默认值
            convertedStyle.titles.sub.fontName = convertedStyle.subtitleFontFamily || 'SimHei';  // ✅ 备用字段名
            // ✅ 新增：传递副标题阴影参数（从 coverConfig 读取，确保与画布一致）
            convertedStyle.titles.sub.shadowEnabled = subStyle.subtitleShadowEnabled !== undefined ? subStyle.subtitleShadowEnabled : (convertedStyle.subtitleShadowEnabled || false);
            convertedStyle.titles.sub.shadowColor = subStyle.subtitleShadowColor || convertedStyle.subtitleShadowColor || '#000000';
            convertedStyle.titles.sub.shadowOffsetX = subStyle.subtitleShadowOffsetX !== undefined ? subStyle.subtitleShadowOffsetX : (convertedStyle.subtitleShadowOffsetX || 0);
            convertedStyle.titles.sub.shadowOffsetY = subStyle.subtitleShadowOffsetY !== undefined ? subStyle.subtitleShadowOffsetY : (convertedStyle.subtitleShadowOffsetY || 0);
            convertedStyle.titles.sub.shadowBlur = subStyle.subtitleShadowBlur !== undefined ? subStyle.subtitleShadowBlur : (convertedStyle.subtitleShadowBlur || 0);
            // ✅ 新增：传递多层阴影数据（清理不可序列化的字段）
            convertedStyle.titles.sub.shadowLayers = (subStyle.subtitleShadowLayers || convertedStyle.subtitleShadowLayers || []).map((layer: any) => ({
                offsetX: layer.offsetX,
                offsetY: layer.offsetY,
                blur: layer.blur,
                color: layer.color,
                opacity: layer.opacity,
                enabled: layer.enabled
            }));

            console.log('[生成封面] 格式转换完成（包含所有参数）:', {
                main: {
                    maxLength: convertedStyle.titles.main.maxLength,
                    direction: convertedStyle.titles.main.direction,
                    charSpacing: convertedStyle.titles.main.charSpacing,
                    lineSpacing: convertedStyle.titles.main.lineSpacing,
                    fontFamily: convertedStyle.titles.main.fontFamily,
                    shadowLayers: convertedStyle.titles.main.shadowLayers
                },
                sub: {
                    maxLength: convertedStyle.titles.sub.maxLength,
                    direction: convertedStyle.titles.sub.direction,
                    charSpacing: convertedStyle.titles.sub.charSpacing,
                    lineSpacing: convertedStyle.titles.sub.lineSpacing,
                    fontFamily: convertedStyle.titles.sub.fontFamily,
                    shadowLayers: convertedStyle.titles.sub.shadowLayers
                }
            });
            console.log('[传递给Python] titles.main.maxLength:', convertedStyle.titles.main.maxLength, '(应该是4)');
            console.log('[传递给Python] titles.sub.maxLength:', convertedStyle.titles.sub.maxLength, '(应该是7)');
        }

        // ✅ 关键修复：创建全新的干净对象，只包含可序列化的字段
        // 不使用 spread 操作符，避免继承不可序列化的属性
        const finalTemplate: any = {
            // 基础配置
            backgroundEnabled: serializableEffectStyle.backgroundEnabled,
            backgroundBlurEnabled: serializableEffectStyle.backgroundBlurEnabled,
            backgroundBlurIntensity: serializableEffectStyle.backgroundBlurIntensity,
            personBorderEnabled: serializableEffectStyle.personBorderEnabled,
            personBorderStyle: serializableEffectStyle.personBorderStyle,
            personBorderColor: serializableEffectStyle.personBorderColor,
            personBorderWidth: serializableEffectStyle.personBorderWidth,
            personBorderDashLength: serializableEffectStyle.personBorderDashLength,
            personBorderGapLength: serializableEffectStyle.personBorderGapLength,
            personSize: serializableEffectStyle.personSize,
            personPosition: serializableEffectStyle.personPosition,
            personRotation: serializableEffectStyle.personRotation,
            backgroundSize: serializableEffectStyle.backgroundSize,
            backgroundPosition: serializableEffectStyle.backgroundPosition,
            autoSplitText: serializableEffectStyle.autoSplitText,
            titleMaxLength: serializableEffectStyle.titleMaxLength,
            subtitleMaxLength: serializableEffectStyle.subtitleMaxLength,
            titleText: serializableEffectStyle.titleText,
            titleFontFamily: serializableEffectStyle.titleFontFamily,
            titleFontSize: serializableEffectStyle.titleFontSize,
            titleFontWeight: serializableEffectStyle.titleFontWeight,
            titleColor: serializableEffectStyle.titleColor,
            titleStrokeColor: serializableEffectStyle.titleStrokeColor,
            titleStrokeWidth: serializableEffectStyle.titleStrokeWidth,
            titleShadowColor: serializableEffectStyle.titleShadowColor,
            titleShadowOffsetX: serializableEffectStyle.titleShadowOffsetX,
            titleShadowOffsetY: serializableEffectStyle.titleShadowOffsetY,
            titleShadowBlur: serializableEffectStyle.titleShadowBlur,
            titleShadowEnabled: serializableEffectStyle.titleShadowEnabled,
            titleShadowLayers: (serializableEffectStyle.titleShadowLayers || []).map((layer: any) => ({
                offsetX: layer.offsetX,
                offsetY: layer.offsetY,
                blur: layer.blur,
                color: layer.color,
                opacity: layer.opacity,
                enabled: layer.enabled
            })),
            titlePosition: serializableEffectStyle.titlePosition,
            titleRotation: serializableEffectStyle.titleRotation,
            titleDirection: serializableEffectStyle.titleDirection,
            titleCharSpacing: serializableEffectStyle.titleCharSpacing,
            titleLineSpacing: serializableEffectStyle.titleLineSpacing,
            titleMaxCharsPerLine: serializableEffectStyle.titleMaxCharsPerLine,
            titleBackgroundEnabled: serializableEffectStyle.titleBackgroundEnabled,
            titleBackgroundColor: serializableEffectStyle.titleBackgroundColor,
            titleBackgroundOpacity: serializableEffectStyle.titleBackgroundOpacity,
            titleBackgroundShape: serializableEffectStyle.titleBackgroundShape,
            titleBackgroundSize: serializableEffectStyle.titleBackgroundSize,
            titleBackgroundPosition: serializableEffectStyle.titleBackgroundPosition,
            titleBackgroundRadius: serializableEffectStyle.titleBackgroundRadius,
            titleBackgroundRotation: serializableEffectStyle.titleBackgroundRotation,
            titleBackgroundPoints: serializableEffectStyle.titleBackgroundPoints,  // ✅ 修复：添加polygon顶点数据
            subtitleText: serializableEffectStyle.subtitleText,
            subtitleFontFamily: serializableEffectStyle.subtitleFontFamily,
            subtitleFontSize: serializableEffectStyle.subtitleFontSize,
            subtitleFontWeight: serializableEffectStyle.subtitleFontWeight,
            subtitleColor: serializableEffectStyle.subtitleColor,
            subtitleStrokeColor: serializableEffectStyle.subtitleStrokeColor,
            subtitleStrokeWidth: serializableEffectStyle.subtitleStrokeWidth,
            subtitleShadowColor: serializableEffectStyle.subtitleShadowColor,
            subtitleShadowOffsetX: serializableEffectStyle.subtitleShadowOffsetX,
            subtitleShadowOffsetY: serializableEffectStyle.subtitleShadowOffsetY,
            subtitleShadowBlur: serializableEffectStyle.subtitleShadowBlur,
            subtitleShadowEnabled: serializableEffectStyle.subtitleShadowEnabled,
            subtitleShadowLayers: (serializableEffectStyle.subtitleShadowLayers || []).map((layer: any) => ({
                offsetX: layer.offsetX,
                offsetY: layer.offsetY,
                blur: layer.blur,
                color: layer.color,
                opacity: layer.opacity,
                enabled: layer.enabled
            })),
            subtitlePosition: serializableEffectStyle.subtitlePosition,
            subtitleRotation: serializableEffectStyle.subtitleRotation,
            subtitleDirection: serializableEffectStyle.subtitleDirection,
            subtitleCharSpacing: serializableEffectStyle.subtitleCharSpacing,
            subtitleLineSpacing: serializableEffectStyle.subtitleLineSpacing,
            subtitleMaxCharsPerLine: serializableEffectStyle.subtitleMaxCharsPerLine,
            subtitleBackgroundEnabled: serializableEffectStyle.subtitleBackgroundEnabled,
            subtitleBackgroundColor: serializableEffectStyle.subtitleBackgroundColor,
            subtitleBackgroundOpacity: serializableEffectStyle.subtitleBackgroundOpacity,
            subtitleBackgroundShape: serializableEffectStyle.subtitleBackgroundShape,
            subtitleBackgroundSize: serializableEffectStyle.subtitleBackgroundSize,
            subtitleBackgroundPosition: serializableEffectStyle.subtitleBackgroundPosition,
            subtitleBackgroundRadius: serializableEffectStyle.subtitleBackgroundRadius,
            subtitleBackgroundRotation: serializableEffectStyle.subtitleBackgroundRotation,
            subtitleBackgroundPoints: serializableEffectStyle.subtitleBackgroundPoints,  // ✅ 修复：添加polygon顶点数据
            maskEnabled: serializableEffectStyle.maskEnabled,
            maskSize: serializableEffectStyle.maskSize,
            maskPosition: serializableEffectStyle.maskPosition,
            maskOpacity: serializableEffectStyle.maskOpacity,
            maskShape: serializableEffectStyle.maskShape,
            // 转换后的 titles 结构
            titles: convertedStyle.titles
        };

        console.log('[最终配置] finalTemplate.titles.main.maxLength:', finalTemplate.titles?.main?.maxLength, '(应该是4)');
        console.log('[最终配置] finalTemplate.titles.sub.maxLength:', finalTemplate.titles?.sub?.maxLength, '(应该是7)');

        // 🔧 检查是否有自定义视频，优先使用自定义视频
        let videoToUse = inputVideo;
        if (coverConfig.value?.coverStyle?.customVideoPath) {
            videoToUse = coverConfig.value.coverStyle.customVideoPath;
            console.log('[generateCover] 使用自定义视频:', videoToUse);
        } else {
            console.log('[generateCover] 使用默认视频:', videoToUse);
        }

        // 生成封面
        // 🔧 使用拆分后的标题（如果启用了自动拆分）
        let actualTitleText = titleTextToUse;
        if (generatedTitle.value) {
            console.log('[generateCover] Using split title:', {
                fullTitle: generatedTitle.value,
                mainTitle: titleTextToUse,
                subtitle: subtitleTextToUse,
                note: '保持使用拆分后的标题，避免覆盖'
            });
            // ✅ 修复：不覆盖 titleText 为完整标题，保持拆分后的标题
            // actualTitleText 已经被设置为 titleTextToUse（拆分后的主标题）
            // finalTemplate 中的 titleText 和 subtitleText 也已被正确设置
            // 不再覆盖它们为完整的 generatedTitle
        }

        const coverResult = await window.$mapi.ipAgent.generateVideoCover({
            videoPath: videoToUse.replace(/^file:\/\//, ''),
            titleText: actualTitleText,
            template: finalTemplate,  // ✅ 包含所有必要字段的完整模板
            effectStyle: finalTemplate  // ✅ 同时保留 effectStyle 以兼容其他代码
        });

        if (!coverResult.success || !coverResult.coverPath) {
            const errorMsg = coverResult.message || coverResult.error || t("生成封面失败");
            console.error("封面生成失败:", coverResult);
            Message.error(errorMsg);
            return;
        }

        // 显示封面预览（确保路径格式正确）
        coverPreviewUrl.value = coverResult.coverPath || coverResult.finalCoverPath || '';

        Message.success(t("封面生成完成！文件已保存到程序目录的 video-output 文件夹"));

    } catch (error: any) {
        console.error("生成封面失败:", error);
        const errorMsg = error?.message || error?.error || String(error) || t("未知错误");
        Message.error(t("生成封面失败：") + errorMsg);
    } finally {
        isGeneratingCover.value = false;
    }
};
// 处理封面配置应用
const handleCoverConfigApply = (config: any, templateName?: string) => {
    console.log('[VideoIPAgent] 应用封面配置:', {
        templateId: config?.templateId,
        hasCoverStyle: !!config?.coverStyle,
        coverStyleKeys: config?.coverStyle ? Object.keys(config.coverStyle) : [],
        templateName
    });

    // 保存配置到coverConfig
    coverConfig.value = config;

    // 保存模板名称
    if (templateName) {
        coverTemplateName.value = templateName;
    }

    // 关闭对话框
    showCoverSettingsDialog.value = false;

    // 提示用户配置已应用
    Message.success(templateName ? `已应用模板：${templateName}` : '已应用自定义配置');

    // 如果已经有封面，提示用户重新生成
    if (coverPreviewUrl.value) {
        Message.info('配置已更新，请重新生成封面以查看效果');
    }
};


// 获取平台中文名称
const getPlatformName = (platform: string): string => {
    const names = {
        douyin: '抖音',
        kuaishou: '快手',
        shipin: '视频号',
        xiaohongshu: '小红书'
    };
    return names[platform] || platform;
};

// 平台登录
const loginPlatform = async (platform: string) => {
    try {
        Message.info(t(`正在打开${getPlatformName(platform)}登录窗口...`));

        const result = await window.$mapi.publish.login({platform});

        if (result.success) {
            publishPlatforms.value[platform].loggedIn = true;
            publishPlatforms.value[platform].nickname = result.userInfo?.nickname || '';
            Message.success(t(`${getPlatformName(platform)}登录成功！`));

            // 登录成功后，再次检查该平台的登录状态，确保状态同步（只检查数据库，不打开浏览器）
            setTimeout(async () => {
                try {
                    const statusResult = await window.$mapi.publish.checkLoginStatus({platform, checkBrowser: false});
                    if (statusResult.success && statusResult.isLoggedIn) {
                        publishPlatforms.value[platform].loggedIn = true;
                        publishPlatforms.value[platform].nickname = statusResult.userInfo?.nickname || '';
                        console.log(`${platform}登录状态已确认:`, statusResult.userInfo);
                    }
                } catch (error) {
                    console.error(`检查${platform}登录状态失败:`, error);
                }
            }, 500);
        } else {
            Message.error(result.message || t('登录失败'));
        }
    } catch (error) {
        console.error(`${platform}登录失败:`, error);
        Message.error(t('登录失败：') + (error?.message || t('未知错误')));
    }
};

// 检查单个平台登录状态（用户点击刷新按钮时，实际打开浏览器检查）
const checkPlatformLoginStatus = async (platform: string) => {
    publishPlatforms.value[platform].refreshing = true;
    currentBrowserPlatform.value = platform;  // 记录当前打开的平台
    try {
        // 传递 checkBrowser: true 表示需要实际打开浏览器检查
        const result = await window.$mapi.publish.checkLoginStatus({platform, checkBrowser: true});
        if (result.success && result.isLoggedIn) {
            publishPlatforms.value[platform].loggedIn = true;
            publishPlatforms.value[platform].nickname = result.userInfo?.nickname || '';
            Message.success(t(`${getPlatformName(platform)}已登录`));
        } else {
            publishPlatforms.value[platform].loggedIn = false;
            publishPlatforms.value[platform].nickname = '';
            Message.warning(t(`${getPlatformName(platform)}未登录`));
        }
    } catch (error) {
        console.error(`检查${platform}登录状态失败:`, error);
        Message.error(t(`检查${getPlatformName(platform)}状态失败`));
    } finally {
        publishPlatforms.value[platform].refreshing = false;
    }
};

// 清除平台登录（包括Cookie和浏览器数据）
const clearPlatformLogin = async (platform: string) => {
    try {
        // 调用新的API，完全清除浏览器数据和Cookie
        const result = await window.$mapi.platform.clearBrowserData({platform});

        if (result.success) {
            // 更新前端状态
            publishPlatforms.value[platform].loggedIn = false;
            publishPlatforms.value[platform].nickname = '';
            Message.success(t(`已清除${getPlatformName(platform)}的浏览器数据和Cookie`));
        } else {
            Message.error(result.message || t(`清除${getPlatformName(platform)}失败`));
        }
    } catch (error) {
        console.error(`清除${platform}登录失败:`, error);
        Message.error(t(`清除${getPlatformName(platform)}登录失败`));
    }
};

// 🔥 从数据库刷新所有平台的登录状态（用于 AccountManager 变更后同步）
const refreshAllPlatformStatus = async () => {
    try {
        const result = await window.$mapi.publish.listAccounts();
        if (result.success) {
            const allAccounts = result.data;
            const platforms = ['douyin', 'kuaishou', 'shipin', 'xiaohongshu'];
            for (const platform of platforms) {
                // 查找该平台是否有 active + hasCookies 的账号
                const activeAccount = allAccounts.find((a: any) => a.platform === platform && a.loginStatus === 'active' && a.hasCookies);
                if (activeAccount) {
                    publishPlatforms.value[platform].loggedIn = true;
                    publishPlatforms.value[platform].nickname = activeAccount.nickname || '';
                } else {
                    publishPlatforms.value[platform].loggedIn = false;
                    publishPlatforms.value[platform].nickname = '';
                }
            }
        }
    } catch (e) {
        console.error('刷新平台状态失败:', e);
    }
};

// 清除所有平台的登录（一键清除）
const clearAllPlatformCookies = async () => {
    try {
        Modal.confirm({
            title: t('确认清除'),
            content: t('确定要清除所有平台的登录信息和Cookie吗？这可能需要您重新扫码登录。'),
            okText: t('确定'),
            cancelText: t('取消'),
            onOk: async () => {
                const platforms = ['douyin', 'kuaishou', 'shipin', 'xiaohongshu'];
                let successCount = 0;

                for (const platform of platforms) {
                    try {
                        const result = await window.$mapi.platform.clearBrowserData({platform});
                        if (result.success) {
                            publishPlatforms.value[platform].loggedIn = false;
                            publishPlatforms.value[platform].nickname = '';
                            successCount++;
                        }
                    } catch (err) {
                        console.error(`清除${platform}失败:`, err);
                    }
                }

                if (successCount > 0) {
                    Message.success(t(`已成功清除 ${successCount} 个平台的登录信息`));
                } else {
                    Message.warning(t('没有清除任何平台信息'));
                }
            }
        });
    } catch (error) {
        console.error('清除所有平台登录失败:', error);
        Message.error(t('操作失败'));
    }
};

// 检查所有平台登录状态（初始化时只检查数据库状态，不打开浏览器）
const checkAllLoginStatus = async () => {
    const platforms = ['douyin', 'kuaishou', 'shipin', 'xiaohongshu'];

    for (const platform of platforms) {
        try {
            // 不传递 checkBrowser 参数，或传递 false，表示只检查数据库状态，不打开浏览器
            const result = await window.$mapi.publish.checkLoginStatus({platform, checkBrowser: false});
            if (result.success && result.isLoggedIn) {
                publishPlatforms.value[platform].loggedIn = true;
                publishPlatforms.value[platform].nickname = result.userInfo?.nickname || '';
            } else {
                publishPlatforms.value[platform].loggedIn = false;
                publishPlatforms.value[platform].nickname = '';
            }
        } catch (error) {
            console.error(`检查${platform}登录状态失败:`, error);
            publishPlatforms.value[platform].loggedIn = false;
            publishPlatforms.value[platform].nickname = '';
        }
    }
};

// 发布视频
const publishVideo = async (options: { autoPublish?: boolean } = {}) => {
    const selectedPlatforms = Object.keys(publishPlatforms.value).filter(
        platform => publishPlatforms.value[platform].checked
    );

    if (selectedPlatforms.length === 0) {
        Message.warning(t('请至少选择一个发布平台'));
        return;
    }

    if (!finalVideoUrl.value) {
        Message.warning(t('请先生成最终视频'));
        return;
    }

    if (!coverPreviewUrl.value) {
        Message.warning(t('请先生成封面'));
        return;
    }

    if (!generatedTitle.value) {
        Message.warning(t('请先生成标题'));
        return;
    }

    // 实时检查后端登录状态（发布前需要实际检查浏览器，确保登录有效）
    const notLoggedIn = [];
    for (const platform of selectedPlatforms) {
        try {
            // 发布前只检查数据库中的登录状态，不打开浏览器以提高效率
            const statusResult = await window.$mapi.publish.checkLoginStatus({platform, checkBrowser: false});
            if (!statusResult.success || !statusResult.isLoggedIn) {
                notLoggedIn.push(platform);
            } else {
                // 同步更新前端状态
                publishPlatforms.value[platform].loggedIn = true;
                publishPlatforms.value[platform].nickname = statusResult.userInfo?.nickname || '';
            }
        } catch (error) {
            console.error(`检查${platform}登录状态失败:`, error);
            notLoggedIn.push(platform);
        }
    }

    if (notLoggedIn.length > 0) {
        const platformNames = notLoggedIn.map(p => getPlatformName(p)).join('、');
        Message.warning(t(`请先登录：${platformNames}`));
        return;
    }

    isPublishing.value = true;
    publishResults.value = [];

    try {
        const videoPath = finalVideoUrl.value.replace(/^file:\/\//, '');
        const coverPath = coverPreviewUrl.value.replace(/^file:\/\//, '');
        const tags = generatedTags.value ? generatedTags.value.split(/[,，]/).map(t => t.trim()).filter(Boolean) : [];

        for (let i = 0; i < selectedPlatforms.length; i++) {
            const platform = selectedPlatforms[i];
            const platformName = getPlatformName(platform);

            publishProgress.value = `正在发布到${platformName}... (${i + 1}/${selectedPlatforms.length})`;
            Message.info(publishProgress.value);

            try {
                // 添加超时控制，最多等待10分钟
                const publishPromise = window.$mapi.publish.execute({
                    platform,
                    videoPath,
                    coverPath,
                    title: generatedTitle.value,
                    description: scriptContent.value || generatedTitle.value,
                    tags,
                    autoPublish: options.autoPublish,
                    accountId: publishPlatforms.value[platform].selectedAccountId || undefined
                });

                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('发布超时（10分钟），请检查浏览器窗口')), 600000);
                });

                const result = await Promise.race([publishPromise, timeoutPromise]);

                if (result.status === 'verification_required' || result.status === 'manual_pending' || result.pending) {
                    const displayMessage = result.message || (result.status === 'verification_required'
                        ? '检测到验证码，等待用户在浏览器中完成验证'
                        : '发布已提交，等待用户手动确认');
                    publishResults.value.push({
                        platform: platformName,
                        success: false,
                        pending: true,
                        status: result.status || 'manual_pending',
                        message: displayMessage,
                        videoUrl: result.videoUrl
                    });
                    Message.warning(t(`${platformName}需继续确认：${displayMessage}`));
                } else if (result.success) {
                    // 根据是否自动发布显示不同消息
                    const displayMessage = options.autoPublish
                        ? '发布完成'
                        : (result.message || '准备完成，请手动发布');
                    publishResults.value.push({
                        platform: platformName,
                        success: true,
                        pending: false,
                        status: result.status || 'success',
                        message: displayMessage,
                        videoUrl: result.videoUrl
                    });
                    if (options.autoPublish) {
                        Message.success(t(`${platformName}发布完成！`));
                    } else {
                        Message.success(t(`${platformName}准备完成！请在浏览器中检查内容后手动点击发布按钮`));
                    }
                } else {
                    publishResults.value.push({
                        platform: platformName,
                        success: false,
                        pending: false,
                        status: result.status || 'failed',
                        message: result.message || '发布失败'
                    });
                    Message.error(t(`${platformName}发布失败：${result.message}`));
                }
            } catch (error) {
                console.error(`${platform}发布失败:`, error);
                publishResults.value.push({
                    platform: platformName,
                    success: false,
                    pending: false,
                    status: 'failed',
                    message: error?.message || '发布失败'
                });
                Message.error(t(`${platformName}发布失败：${error?.message}`));
            }

            if (i < selectedPlatforms.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        const successCount = publishResults.value.filter(r => r.status === 'success').length;
        const pendingCount = publishResults.value.filter(r => r.pending || r.status === 'verification_required' || r.status === 'manual_pending').length;
        const totalCount = publishResults.value.length;
        const failedCount = totalCount - successCount - pendingCount;

        if (successCount === totalCount) {
            Message.success(t(`全部发布成功！(${successCount}/${totalCount})`));
        } else if (pendingCount > 0 && failedCount === 0) {
            Message.warning(t(`发布已提交，等待确认 ${pendingCount}/${totalCount}`));
        } else if (successCount > 0 || pendingCount > 0) {
            Message.warning(t(`发布结果：成功 ${successCount}，待确认 ${pendingCount}，失败 ${failedCount}`));
        } else {
            Message.error(t('全部发布失败'));
        }

        publishProgress.value = `发布完成：成功 ${successCount}，待确认 ${pendingCount}，失败 ${failedCount}`;

    } catch (error) {
        console.error('发布视频失败:', error);
        Message.error(t('发布失败：') + (error?.message || t('未知错误')));
    } finally {
        // 确保无论如何都会重置发布状态
        isPublishing.value = false;
        console.log('发布流程结束，状态已重置');
    }
};

// 定时发布
const schedulePublish = () => {
    if (!scheduledPublishTime.value) {
        Message.warning(t('请先选择发布时间'));
        return;
    }
    const targetTime = new Date(scheduledPublishTime.value).getTime();
    const now = Date.now();
    const delay = targetTime - now;
    if (delay <= 0) {
        Message.warning(t('发布时间必须晚于当前时间'));
        return;
    }
    if (scheduledPublishTimer) {
        clearTimeout(scheduledPublishTimer);
    }
    isScheduledPublishing.value = true;
    const timeStr = new Date(scheduledPublishTime.value).toLocaleString('zh-CN');
    Message.success(t(`已设置定时发布，将在 ${timeStr} 自动发布`));
    scheduledPublishTimer = setTimeout(async () => {
        isScheduledPublishing.value = false;
        scheduledPublishTime.value = '';
        scheduledPublishTimer = null;
        await publishVideo({autoPublish: true});
    }, delay);
};

const cancelScheduledPublish = () => {
    if (scheduledPublishTimer) {
        clearTimeout(scheduledPublishTimer);
        scheduledPublishTimer = null;
    }
    isScheduledPublishing.value = false;
    scheduledPublishTime.value = '';
    Message.info(t('已取消定时发布'));
};

// 停止脚本清理函数（已禁用，保留调用点以兼容旧流程）
const cleanupGPU = async (forceKill: boolean = false) => {
    console.log(`[cleanupGPU] 已禁用任务后的停止脚本清理，forceKill=${forceKill}`);
    return true;
};

// 一键智能全流程自动化
const startOneClickIntelligence = async () => {
    if (isOneClickRunning.value) {
        Message.warning(t("一键智能流程正在运行中，请稍候..."));
        return;
    }

    // 🔧 优化：禁用自动保存，避免频繁localStorage写入导致卡顿
    const savedAutoSaveState = isAutoSavingEnabled.value;
    isAutoSavingEnabled.value = false;

    // 初始化状态
    isOneClickRunning.value = true;
    showProgressDialog.value = true;
    currentStep.value = '';
    progressPercent.value = 0;
    progressErrorMessage.value = '';
    canCancelProgress.value = true;

    try {
        // 构建上下文
        const context: OneClickContext = {
            scriptContent,
            generateAudio,
            isGeneratingAudio,
            audioPreviewUrl,
            latestAudioTaskId,
            generateVideo,
            isGeneratingVideo,
            videoPreviewUrl,
            latestVideoTaskId,
            autoProcessVideo,
            isProcessingVideo,
            processedVideoUrl,
            generateTitleTags,
            isGeneratingTitleTags,
            generatedTitle,
            autoGenerateSubtitleAndBGM,
            enableSubtitle,
            isGeneratingSubtitle,
            enableBGM,
            selectedBGMPath,
            generateCover,
            isGeneratingCover,
            publishVideo,
            publishPlatforms,
            isPublishing
        };

        // 执行一键智能流程
        await executeOneClickIntelligence(context, {
            onProgress: (step: string, progress: number) => {
                currentStep.value = step;
                progressPercent.value = progress;
                console.log(`[一键智能] ${step}: ${progress}%`);
            },
            onError: (step: string, error: Error) => {
                progressErrorMessage.value = `${step}: ${error.message}`;
                canCancelProgress.value = false;
                console.error(`[一键智能] 错误 - ${step}:`, error);
                Message.error(t('一键智能流程执行失败：') + error.message);
            },
            onComplete: async () => {
                console.log('[一键智能] 流程全部完成');
                Message.success(t('一键智能流程全部完成！'));
                canCancelProgress.value = false;

                // 🔧 【关键修复】立即刷新历史视频列表，确保显示最新生成的视频
                try {
                    console.log('[一键智能] 🔄 刷新历史视频列表...');
                    await loadGeneratedVideoHistory();
                    console.log('[一键智能] ✅ 历史视频列表刷新完成');
                } catch (refreshError) {
                    console.warn('[一键智能] ⚠️ 刷新历史视频列表失败:', refreshError);
                }

                // 🔧 关键修复：立即关闭弹窗，不阻塞 UI
                // 延迟关闭弹窗，让用户看到完成提示
                setTimeout(() => {
                    showProgressDialog.value = false;
                }, 1500);

                // 保留旧调用点，但 cleanupGPU 当前已禁用，不再执行停止脚本
                setTimeout(async () => {
                    console.log('[一键智能] 开始后台 GPU 清理...');
                    await cleanupGPU(true);  // 强制模式
                    console.log('[一键智能] 后台 GPU 清理完成');
                }, 100);
            },
            onCancelCheck: () => {
                // 检查是否已取消
                return !isOneClickRunning.value;
            }
        });
    } catch (error: any) {
        const errorMessage = error?.message || t('未知错误');
        progressErrorMessage.value = errorMessage;
        canCancelProgress.value = false;
        console.error('[一键智能] 执行失败:', error);
        Message.error(t('一键智能流程执行失败：') + errorMessage);
        // 错误时不自动关闭，让用户看到错误信息
    } finally {
        isOneClickRunning.value = false;
        // 🔧 优化：恢复自动保存开关，执行完成后自动保存数据
        isAutoSavingEnabled.value = savedAutoSaveState;
        // 立即保存一次，确保数据持久化
        saveWorkData();

        // 🔧 移除 finally 块的 GPU 清理
        // 原因：finally 会在任何时候执行，包括语音生成后
        // 导致数字人生成流程中断（先生成语音→清理GPU→无法生成视频）
        // GPU 清理应该只在真正完成时执行（onComplete 中已有）
    }
};

// 取消一键智能流程
const cancelOneClickIntelligence = async () => {
    // 先隐藏进度对话框，防止特效遮挡确认对话框
    showProgressDialog.value = false;

    Modal.confirm({
        title: t('确认取消'),
        content: t('确定要取消一键智能流程吗？这将停止所有正在运行的任务（语音合成、数字人合成等）。'),
        okText: t('确定'),
        cancelText: t('取消'),
        zIndex: 10003,
        maskZIndex: 10003,
        onOk: async () => {
            try {
                // 取消所有正在运行的任务
                const tasksToCancel: Array<{ biz: string; bizId: string | number }> = [];

                // 取消语音生成任务
                if (latestAudioTaskId.value) {
                    try {
                        const audioTask = await TaskService.get(latestAudioTaskId.value);
                        if (audioTask && (audioTask.status === 'running' || audioTask.status === 'wait' || audioTask.status === 'queue')) {
                            tasksToCancel.push({biz: 'SoundGenerate', bizId: latestAudioTaskId.value});
                            console.log('[cancelOneClickIntelligence] 准备取消语音生成任务:', latestAudioTaskId.value);
                        }
                    } catch (error) {
                        console.error('[cancelOneClickIntelligence] 获取语音任务状态失败:', error);
                    }
                }

                // 取消视频生成任务
                if (latestVideoTaskId.value) {
                    try {
                        const videoTask = await TaskService.get(latestVideoTaskId.value);
                        if (videoTask && (videoTask.status === 'running' || videoTask.status === 'wait' || videoTask.status === 'queue')) {
                            tasksToCancel.push({biz: 'VideoGen', bizId: latestVideoTaskId.value});
                            console.log('[cancelOneClickIntelligence] 准备取消视频生成任务:', latestVideoTaskId.value);
                        }
                    } catch (error) {
                        console.error('[cancelOneClickIntelligence] 获取视频任务状态失败:', error);
                    }
                }

                // 执行取消操作
                for (const task of tasksToCancel) {
                    try {
                        taskStore.requestCancel(task.biz, task.bizId);
                        console.log(`[cancelOneClickIntelligence] 已请求取消任务: ${task.biz}-${task.bizId}`);
                    } catch (error) {
                        console.error(`[cancelOneClickIntelligence] 取消任务失败: ${task.biz}-${task.bizId}`, error);
                    }
                }

                // 停止所有轮询
                if (audioCheckInterval) {
                    clearInterval(audioCheckInterval);
                    audioCheckInterval = null;
                }
                if (audioCheckTimeout) {
                    clearTimeout(audioCheckTimeout);
                    audioCheckTimeout = null;
                }
                if (videoCheckInterval) {
                    clearInterval(videoCheckInterval);
                    videoCheckInterval = null;
                }
                if (videoCheckTimeout) {
                    clearTimeout(videoCheckTimeout);
                    videoCheckTimeout = null;
                }

                // 重置状态
                isOneClickRunning.value = false;
                isGeneratingAudio.value = false;
                isGeneratingVideo.value = false;
                isProcessingVideo.value = false;
                isGeneratingTitleTags.value = false;
                isGeneratingSubtitle.value = false;
                isGeneratingCover.value = false;
                showProgressDialog.value = false;

                if (tasksToCancel.length > 0) {
                    Message.success(t(`已取消一键智能流程，并停止 ${tasksToCancel.length} 个正在运行的任务`));
                } else {
                    Message.info(t('已取消一键智能流程'));
                }

                // 保留旧调用点，但 cleanupGPU 当前已禁用，不再执行停止脚本
                await cleanupGPU(true);  // 强制模式
            } catch (error: any) {
                console.error('[cancelOneClickIntelligence] 取消流程时出错:', error);
                isOneClickRunning.value = false;
                showProgressDialog.value = false;
                Message.error(t('取消流程失败：') + (error?.message || '未知错误'));
            }
        }
    });
};

// 恢复任务结果并继续轮询进行中的任务
const resumeTaskPolling = async () => {
    // 🔧 优化：减少控制台输出，只在开发模式输出
    if (import.meta.env.DEV) {
        console.log("=== 页面加载，恢复任务状态 ===");
        console.log("latestAudioTaskId:", latestAudioTaskId.value);
        console.log("audioPreviewUrl:", audioPreviewUrl.value);
        console.log("latestVideoTaskId:", latestVideoTaskId.value);
        console.log("videoPreviewUrl:", videoPreviewUrl.value);
    }

    // 清除所有轮询定时器
    if (audioCheckInterval) {
        clearInterval(audioCheckInterval);
        audioCheckInterval = null;
    }
    if (audioCheckTimeout) {
        clearTimeout(audioCheckTimeout);
        audioCheckTimeout = null;
    }
    if (videoCheckInterval) {
        clearInterval(videoCheckInterval);
        videoCheckInterval = null;
    }
    if (videoCheckTimeout) {
        clearTimeout(videoCheckTimeout);
        videoCheckTimeout = null;
    }

    // 检查音频任务状态
    if (latestAudioTaskId.value) {
        const audioTask = await TaskService.get(latestAudioTaskId.value);
        if (import.meta.env.DEV) {
            console.log("检查音频任务:", audioTask?.status, "result:", JSON.stringify(audioTask?.result));
        }

        if (audioTask) {
            if (audioTask.status === "success") {
                // 🔧 关键改进：尝试多个来源获取 URL
                let audioUrl = null;

                // 1. 首先尝试从 result.url 获取
                if (audioTask.result?.url) {
                    audioUrl = audioTask.result.url;
                }
                // 2. 如果 result 是空对象或字符串URL，直接使用
                else if (typeof audioTask.result === 'string' && audioTask.result.trim()) {
                    audioUrl = audioTask.result;
                }
                // 3. 尝试从 jobResult 获取
                else if (audioTask.jobResult?.data?.data?.url) {
                    audioUrl = audioTask.jobResult.data.data.url;
                } else if (typeof audioTask.jobResult === 'string' && audioTask.jobResult.trim()) {
                    audioUrl = audioTask.jobResult;
                }

                if (audioUrl) {
                    // 🔧 优化：检查文件是否存在，避免加载不存在的文件
                    try {
                        const fileExists = await window.$mapi.file.exists(audioUrl);
                        if (fileExists) {
                            // 任务已完成且文件存在，恢复结果
                            if (import.meta.env.DEV) {
                                console.log("恢复已完成的音频任务结果:", audioUrl);
                            }
                            audioPreviewUrl.value = audioUrl;
                            isGeneratingAudio.value = false;
                        } else {
                            // 文件不存在，清除任务引用
                            if (import.meta.env.DEV) {
                                console.warn("音频文件不存在，清除任务引用:", audioUrl);
                            }
                            latestAudioTaskId.value = null;
                            audioPreviewUrl.value = '';
                            isGeneratingAudio.value = false;
                        }
                    } catch (error) {
                        console.error("检查音频文件失败:", error);
                        // 检查失败时也清除引用
                        latestAudioTaskId.value = null;
                        audioPreviewUrl.value = '';
                        isGeneratingAudio.value = false;
                    }
                } else {
                    // 🔧 result 为空或无效：任务完成但结果为空，可能是旧任务或执行异常
                    console.warn("[resumeTaskPolling] ⚠️ 音频任务已完成但结果为空:", {
                        result: audioTask.result,
                        jobResult: audioTask.jobResult,
                        resultType: typeof audioTask.result,
                        resultKeys: Object.keys(audioTask.result || {})
                    });
                    latestAudioTaskId.value = null;
                    audioPreviewUrl.value = '';
                    isGeneratingAudio.value = false;
                }
            } else if (audioTask.status === "running" || audioTask.status === "pending") {
                // 任务正在进行中，恢复生成状态并继续轮询
                if (import.meta.env.DEV) {
                    console.log("恢复进行中的音频任务，继续轮询");
                }

                // 🔧 关键修复：检查组件是否仍然被挂载，防止卸载后创建定时器
                if (!isComponentMounted) {
                    console.warn("[resumeTaskPolling] 组件已卸载，停止创建音频轮询定时器");
                    return;
                }

                isGeneratingAudio.value = true;

                // 重新启动轮询
                audioCheckInterval = setInterval(async () => {
                    // 🔧 再次检查组件是否仍在挂载中
                    if (!isComponentMounted) {
                        clearInterval(audioCheckInterval);
                        return;
                    }
                    const task = await TaskService.get(latestAudioTaskId.value);
                    if (task && task.status === "success" && task.result?.url) {
                        audioPreviewUrl.value = task.result.url;
                        Message.success(t("语音生成完成"));
                        try {
                            const _u = JSON.parse(localStorage.getItem('auth_user') || '{}');
                            window.require('electron').ipcRenderer.invoke('auth:reportGeneration', {
                                userId: _u.id,
                                type: 'voice',
                                detail: '轮询声音克隆'
                            });
                        } catch (e) {
                        }
                        clearInterval(audioCheckInterval);
                        clearTimeout(audioCheckTimeout);
                        audioCheckInterval = null;
                        audioCheckTimeout = null;
                        isGeneratingAudio.value = false;
                    } else if (task && (task.status === "failed" || task.status === "stopped" || task.status === "cancelled")) {
                        const statusMsg = task.status === "stopped" || task.status === "cancelled"
                            ? t("语音生成已停止")
                            : t("语音生成失败：") + (task.statusMsg || "未知错误");
                        Message.info(statusMsg);
                        clearInterval(audioCheckInterval);
                        clearTimeout(audioCheckTimeout);
                        audioCheckInterval = null;
                        audioCheckTimeout = null;
                        isGeneratingAudio.value = false;
                    }
                }, 2000);

                // 3分钟后停止轮询
                audioCheckTimeout = setTimeout(() => {
                    if (audioCheckInterval) {
                        clearInterval(audioCheckInterval);
                        audioCheckInterval = null;
                    }
                    if (isGeneratingAudio.value) {
                        Message.info(t("语音生成时间较长，任务继续在后台执行，您可以在任务列表查看进度"));
                        isGeneratingAudio.value = false;
                    }
                    audioCheckTimeout = null;
                }, 180000);
            } else {
                // 任务失败或停止
                isGeneratingAudio.value = false;
            }
        }
    }

    // 检查视频任务状态
    if (latestVideoTaskId.value) {
        const videoTask = await TaskService.get(latestVideoTaskId.value);
        if (import.meta.env.DEV) {
            console.log("检查视频任务:", videoTask?.status);
        }

        if (videoTask) {
            // 🔧 修复：移除重复的文件检查逻辑，只在后面的事件驱动部分处理已完成的任务
            // 这里只处理运行中的任务，避免与第6902-6938行的逻辑重复
            if (videoTask.status === "running" || videoTask.status === "pending") {
                // 任务正在进行中，恢复生成状态并继续轮询
                if (import.meta.env.DEV) {
                    console.log("恢复进行中的视频任务，继续轮询");
                }

                // 🔧 关键修复：检查组件是否仍然被挂载，防止卸载后创建定时器
                if (!isComponentMounted) {
                    console.warn("[resumeTaskPolling] 组件已卸载，停止创建视频轮询定时器");
                    return;
                }

                isGeneratingVideo.value = true;

                let checkCount = 0;
                const maxChecks = 150;

                // 重新启动轮询
                videoCheckInterval = setInterval(async () => {
                    try {
                        // 🔧 再次检查组件是否仍在挂载中
                        if (!isComponentMounted) {
                            clearInterval(videoCheckInterval);
                            clearTimeout(videoCheckTimeout);
                            return;
                        }

                        checkCount++;
                        const task = await TaskService.get(latestVideoTaskId.value);

                        if (!task) {
                            clearInterval(videoCheckInterval);
                            clearTimeout(videoCheckTimeout);
                            videoCheckInterval = null;
                            videoCheckTimeout = null;
                            isGeneratingVideo.value = false;
                            return;
                        }

                        if (task.status === "success" && task.result?.url) {
                            videoPreviewUrl.value = task.result.url;
                            Message.success(t("视频生成完成"));
                            clearInterval(videoCheckInterval);
                            clearTimeout(videoCheckTimeout);
                            videoCheckInterval = null;
                            videoCheckTimeout = null;
                            isGeneratingVideo.value = false;
                        } else if (task.status === "fail" || task.status === "failed") {
                            const errorMsg = task.statusMsg || "未知错误";
                            Message.error(t("视频生成失败：") + errorMsg);
                            clearInterval(videoCheckInterval);
                            clearTimeout(videoCheckTimeout);
                            videoCheckInterval = null;
                            videoCheckTimeout = null;
                            isGeneratingVideo.value = false;
                        } else if (task.status === "stopped" || task.status === "cancelled") {
                            Message.info(t("视频生成已停止"));
                            clearInterval(videoCheckInterval);
                            clearTimeout(videoCheckTimeout);
                            videoCheckInterval = null;
                            videoCheckTimeout = null;
                            isGeneratingVideo.value = false;
                        } else if (checkCount >= maxChecks) {
                            clearInterval(videoCheckInterval);
                            videoCheckInterval = null;
                            if (isGeneratingVideo.value) {
                                Message.info(t("视频生成时间较长，任务继续在后台执行，您可以在任务列表查看进度"));
                                isGeneratingVideo.value = false;
                            }
                        }
                    } catch (err) {
                        console.error("检查视频任务状态时出错:", err);
                    }
                }, 2000);

                // 5分钟后停止轮询
                videoCheckTimeout = setTimeout(() => {
                    if (videoCheckInterval) {
                        clearInterval(videoCheckInterval);
                        videoCheckInterval = null;
                    }
                    if (isGeneratingVideo.value) {
                        Message.info(t("视频生成时间较长，任务继续在后台执行，您可以在任务列表查看进度"));
                        isGeneratingVideo.value = false;
                    }
                    videoCheckTimeout = null;
                }, 300000);
            } else {
                // 任务失败或停止
                isGeneratingVideo.value = false;
            }
        }
    }

    // 🔧 【关键修复】重新等待进行中的任务（事件驱动）
    // 不用轮询，而是重新注册事件监听，使用事件驱动方式
    try {
        // 恢复音频任务监听
        if (latestAudioTaskId.value && !isGeneratingAudio.value) {
            const audioTask = await TaskService.get(latestAudioTaskId.value);
            if (audioTask) {
                if (audioTask.status === 'success') {
                    // ✅ 【关键修复】任务已完成，直接恢复结果URL（不等待异步回调）
                    console.log('[resumeTaskPolling] 📻 发现已完成的音频任务，直接恢复结果...');
                    let audioUrl = audioTask.result?.url || audioTask.result;

                    // 🔧 严格验证 URL 有效性
                    if (typeof audioUrl !== 'string' || !audioUrl || audioUrl === 'null' || audioUrl === 'undefined' || audioUrl === '{}') {
                        console.warn('[resumeTaskPolling] 📻 ⚠️ 音频任务已完成但结果无效:', {
                            result: audioTask.result,
                            audioUrl: audioUrl
                        });
                        latestAudioTaskId.value = null;
                        audioPreviewUrl.value = '';
                    } else {
                        await nextTick();
                        audioPreviewUrl.value = audioUrl;
                        console.log('[resumeTaskPolling] 📻 音频URL已直接恢复:', audioPreviewUrl.value);
                    }
                } else if (audioTask.status === 'running' || audioTask.status === 'pending' || audioTask.status === 'queue') {
                    console.log('[resumeTaskPolling] 📻 发现进行中的音频任务，重新等待...');
                    isGeneratingAudio.value = true;

                    // 使用事件驱动方式重新等待任务完成
                    waitForTaskCompletion({
                        taskId: latestAudioTaskId.value,
                        timeout: 600000, // 10分钟超时
                        fallbackPolling: true
                    })
                        .then(async (result) => {
                            console.log('[resumeTaskPolling] 📻 音频任务完成，结果类型:', typeof result, '结果:', result);

                            // 🔧 关键修复：严格验证 URL 有效性
                            let audioUrl = result?.url || result;

                            // 确保 URL 是一个有效的字符串
                            if (typeof audioUrl !== 'string' || !audioUrl || audioUrl === 'null' || audioUrl === 'undefined' || audioUrl === '{}') {
                                console.error('[resumeTaskPolling] 📻 ❌ 无效的音频URL，结果:', {
                                    resultType: typeof result,
                                    result: result,
                                    audioUrl: audioUrl
                                });
                                isGeneratingAudio.value = false;
                                Message.error(t("语音生成失败：无效的音频文件路径"));
                                return;
                            }

                            await nextTick();
                            audioPreviewUrl.value = audioUrl;
                            isGeneratingAudio.value = false;
                            Message.success(t("语音生成完成"));
                            try {
                                const _u = JSON.parse(localStorage.getItem('auth_user') || '{}');
                                window.require('electron').ipcRenderer.invoke('auth:reportGeneration', {
                                    userId: _u.id,
                                    type: 'voice',
                                    detail: '恢复声音克隆'
                                });
                            } catch (e) {
                            }
                            console.log('[resumeTaskPolling] 📻 音频URL已设置:', audioPreviewUrl.value);
                        })
                        .catch((error) => {
                            console.error('[resumeTaskPolling] 📻 音频任务失败:', error);
                            isGeneratingAudio.value = false;
                            if (error.message !== '用户已取消任务') {
                                Message.error(t("语音生成失败：") + error.message);
                            }
                        });
                }
            }
        }

        // 恢复视频任务监听
        if (latestVideoTaskId.value && !isGeneratingVideo.value) {
            const videoTask = await TaskService.get(latestVideoTaskId.value);
            if (videoTask) {
                if (videoTask.status === 'success') {
                    // 🔧 关键改进：尝试多个来源获取 URL
                    console.log('[resumeTaskPolling] 🎬 发现已完成的视频任务，尝试恢复结果...');
                    let videoUrl = null;

                    // 1. 首先尝试从 result.url 获取
                    if (videoTask.result?.url) {
                        videoUrl = videoTask.result.url;
                    }
                    // 2. 如果 result 是字符串URL，直接使用
                    else if (typeof videoTask.result === 'string' && videoTask.result.trim()) {
                        videoUrl = videoTask.result;
                    }
                    // 3. 尝试从 jobResult 获取
                    else if (videoTask.jobResult?.data?.data?.url) {
                        videoUrl = videoTask.jobResult.data.data.url;
                    } else if (typeof videoTask.jobResult === 'string' && videoTask.jobResult.trim()) {
                        videoUrl = videoTask.jobResult;
                    }

                    if (videoUrl && videoUrl !== '{}' && videoUrl !== 'null' && videoUrl !== 'undefined') {
                        await nextTick();
                        videoPreviewUrl.value = videoUrl;
                        console.log('[resumeTaskPolling] 🎬 视频URL已直接恢复:', videoPreviewUrl.value);
                    } else {
                        // result 为空或无效
                        console.warn('[resumeTaskPolling] ⚠️ 视频任务已完成但结果为空:', {
                            result: videoTask.result,
                            jobResult: videoTask.jobResult
                        });
                        latestVideoTaskId.value = null;
                        videoPreviewUrl.value = '';
                    }
                } else if (videoTask.status === 'running' || videoTask.status === 'pending' || videoTask.status === 'queue') {
                    console.log('[resumeTaskPolling] 🎬 发现进行中的视频任务，重新等待...');
                    isGeneratingVideo.value = true;

                    // 使用事件驱动方式重新等待任务完成
                    waitForTaskCompletion({
                        taskId: latestVideoTaskId.value,
                        timeout: 600000, // 10分钟超时
                        fallbackPolling: true
                    })
                        .then(async (result) => {
                            console.log('[resumeTaskPolling] 🎬 视频任务完成事件已触发');

                            // 🔧 关键修复：不依赖 waitForTaskCompletion 的返回值，直接从数据库查询任务
                            // 因为 successFunc 可能还在执行，result 可能不完整
                            try {
                                const completedTask = await TaskService.get(latestVideoTaskId.value);
                                console.log('[resumeTaskPolling] 📋 从数据库查询到任务，result:', {
                                    url: completedTask?.result?.url,
                                    status: completedTask?.status,
                                    endTime: completedTask?.endTime
                                });

                                const videoUrl = completedTask?.result?.url;

                                // 确保 URL 是一个有效的字符串
                                if (typeof videoUrl !== 'string' || !videoUrl || videoUrl === 'null' || videoUrl === 'undefined' || videoUrl === '{}') {
                                    console.error('[resumeTaskPolling] 🎬 ❌ 无效的视频URL，任务结果:', {
                                        status: completedTask?.status,
                                        resultUrl: videoUrl,
                                        fullResult: completedTask?.result
                                    });
                                    isGeneratingVideo.value = false;
                                    Message.error(t("视频生成失败：无效的视频文件路径"));
                                    return;
                                }

                                await nextTick();
                                videoPreviewUrl.value = videoUrl;
                                isGeneratingVideo.value = false;
                                Message.success(t("视频生成完成"));
                                console.log('[resumeTaskPolling] 🎬 视频URL已设置:', videoPreviewUrl.value);
                            } catch (queryError: any) {
                                console.error('[resumeTaskPolling] ❌ 查询任务失败:', queryError?.message);
                                isGeneratingVideo.value = false;
                                Message.error(t("视频生成失败：") + queryError?.message);
                            }
                        })
                        .catch((error) => {
                            console.error('[resumeTaskPolling] 🎬 视频任务失败:', error);
                            isGeneratingVideo.value = false;
                            if (error.message !== '用户已取消任务') {
                                Message.error(t("视频生成失败：") + error.message);
                            }
                        });
                }
            }
        }
    } catch (e) {
        console.warn('[resumeTaskPolling] 恢复任务等待失败:', e);
    }

    // 🔧 优化：减少控制台输出
    if (import.meta.env.DEV) {
        console.log("=== 任务状态恢复完成 ===");
    }
};

/**
 * 设置IPC事件监听：处理来自主进程的字幕生成请求
 * 前端在这里执行完整的ZimuShengcheng七步流程
 */
const setupSubtitleGenerationListener = () => {
    console.log('[setupSubtitleGenerationListener] 开始设置IPC监听器');

    // 监听来自主进程的字幕生成请求
    ipcRenderer.on('ipAgent:performSubtitleGeneration', async (event, params) => {
        console.log('[ipAgent:performSubtitleGeneration] 收到主进程请求:', {
            videoPath: params.videoPath,
            userText: params.userText?.substring(0, 50) + '...',
            segmentsCount: params.funasrSegments.length
        });

        try {
            // 创建ZimuShengcheng实例，执行完整的七步流程
            const service = new ZimuShengcheng();

            console.log('[ipAgent:performSubtitleGeneration] 开始执行ZimuShengcheng.generate()');

            // 这里调用新的ZimuShengcheng服务，完成完整的七步流程：
            // 1. 文案修正
            // 2. 关键词匹配
            // 3. 智能排列
            // 4. 生成ASS文件
            // 5. 生成drawtext命令
            // 6. 构建FFmpeg命令
            // 7. 执行FFmpeg
            console.log('[ipAgent:performSubtitleGeneration] 配置检查:', {
                settingsMinDuration: settings.value.minSubtitleDuration,
                settingsFull: settings.value
            });

            const result = await service.generate({
                videoPath: params.videoPath,
                videoWidth: params.videoWidth,
                videoHeight: params.videoHeight,
                userText: params.userText,
                funasrSegments: params.funasrSegments,
                subtitleStyle: params.subtitleStyle,
                keywordGroups: params.keywordGroups,
                keywordRenderMode: params.keywordRenderMode,
                fontDir: params.fontDir,
                outputPath: params.outputPath,
                minSubtitleDuration: settings.value.minSubtitleDuration,  // 🔧 使用全局设置的特效字幕最小显示时长（仅控制特效）
                normalSubtitleX: settings.value.normalSubtitleX,
                normalSubtitleY: settings.value.normalSubtitleY,
                effectSubtitleX: settings.value.effectSubtitleX,
                effectSubtitleY: settings.value.effectSubtitleY,
                keywordGroupPositions: settings.value.keywordGroupPositions,  // 🔧 传递关键词分组位置配置
                disableSmartLayout: settings.value.disableSmartLayout,
                avoidanceConfig: settings.value.avoidanceConfig,  // 🔧 传递避让配置
                // 🆕 音效系统配置
                soundEffectSettings: {
                    enabled: params.keywordGroups?.some((g: any) => g.soundEffectId),  // 如果有任何分组配置了音效ID，则启用
                    masterVolume: 0.7,
                    mixMode: 'overlay'
                }
            });

            console.log('[ipAgent:performSubtitleGeneration] ZimuShengcheng执行完成:', {
                success: result.success,
                outputPath: result.outputPath,
                message: result.message
            });

            // 返回结果给主进程
            // 使用ipcRenderer.send()，发送给主进程的ipcMain.once监听器
            ipcRenderer.send('ipAgent:generateSubtitleV2Result', {
                success: result.success,
                outputPath: result.outputPath,
                message: result.message,
                statistics: result.statistics,
                // 如果需要主进程继续执行FFmpeg，可以返回FFmpeg命令
                ffmpegCommand: result.ffmpegCommand
            });

            console.log('[ipAgent:performSubtitleGeneration] 已向主进程发送结果');

        } catch (error: any) {
            console.error('[ipAgent:performSubtitleGeneration] 字幕生成失败:', error);

            // 返回错误结果给主进程
            ipcRenderer.send('ipAgent:generateSubtitleV2Result', {
                success: false,
                message: '字幕生成失败: ' + (error?.message || '未知错误'),
                error: error?.message
            });

            console.log('[ipAgent:performSubtitleGeneration] 已向主进程发送错误结果');
        }
    });

    console.log('[setupSubtitleGenerationListener] IPC监听器设置完成');
};

// 设置ASR识别IPC监听器
const setupAsrRecognizeListener = () => {
    console.log('[setupAsrRecognizeListener] 🔧 开始设置ASR IPC监听器');
    console.log('[setupAsrRecognizeListener] ipcRenderer 是否可用:', !!ipcRenderer);
    console.log('[setupAsrRecognizeListener] serverStore 是否可用:', !!serverStore);

    // 监听来自主进程的ASR识别请求
    ipcRenderer.on('ipAgent:performAsrRecognize', async (event, params) => {
        console.log('[ipAgent:performAsrRecognize] 🎯 收到主进程ASR请求:', {
            asrModelKey: params?.asrModelKey,
            audioPath: params?.audioPath,
            paramsType: typeof params,
            timestamp: new Date().toISOString()
        });

        try {
            // 获取ASR服务器配置
            const server = await serverStore.getByKey(params.asrModelKey);
            if (!server) {
                throw new Error("未找到语音识别模型");
            }

            const serverInfo = await serverStore.serverInfo(server);

            console.log('[ipAgent:performAsrRecognize] 开始调用ASR服务...');

            // 调用ASR服务
            const asrResult = await serverStore.call(serverInfo, "asr", {
                id: serverStore.generateTaskId("VideoRewriteASR", Date.now()),
                audio: params.audioPath,
                param: {}
            });

            console.log('[ipAgent:performAsrRecognize] ASR服务调用完成:', {
                code: asrResult.code,
                dataType: asrResult.data?.type
            });

            // 返回结果给主进程
            ipcRenderer.send('ipAgent:asrRecognizeResult', {
                success: true,
                data: asrResult
            });

            console.log('[ipAgent:performAsrRecognize] 已向主进程发送ASR结果');

        } catch (error: any) {
            console.error('[ipAgent:performAsrRecognize] ASR识别失败:', error);

            // 返回错误结果给主进程
            ipcRenderer.send('ipAgent:asrRecognizeResult', {
                success: false,
                message: 'ASR识别失败: ' + (error?.message || '未知错误'),
                error: error?.message
            });

            console.log('[ipAgent:performAsrRecognize] 已向主进程发送错误结果');
        }
    });

    console.log('[setupAsrRecognizeListener] ASR IPC监听器设置完成');
};

// 手动调试函数 - 暴露到window对象用于控制台调试
const debugKeywordGroups = () => {
    console.log('=== 关键词分组调试信息 ===');
    console.log('keywordGroups.value:', keywordGroups.value);
    console.log('分组数量:', keywordGroups.value?.length || 0);
    if (keywordGroups.value && keywordGroups.value.length > 0) {
        keywordGroups.value.forEach((group, index) => {
            console.log(`分组${index + 1}:`, {
                name: group.name,
                id: group.id,
                keywordsCount: group.keywords?.length || 0,
                keywords: group.keywords
            });
        });
    }

    console.log('\n=== 测试getGroupKeywords ===');
    const testNames = ['重点词/成语词', '行动词', '描述词', '情感词'];
    testNames.forEach(name => {
        const result = getGroupKeywords(name);
        console.log(`${name}:`, result);
    });

    return keywordGroups.value;
};

// 暴露到window对象用于调试
if (typeof window !== 'undefined') {
    (window as any).debugKeywordGroups = debugKeywordGroups;
    (window as any).manualInitializeGroups = initializeKeywordGroups;
    (window as any).checkLocalStorage = () => {
        const stored = localStorage.getItem('zhenqianba_keyword_groups');
        console.log('localStorage中的zhenqianba_keyword_groups:', stored);
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                console.log('解析后的数据:', parsed);
            } catch (e) {
                console.error('解析失败:', e);
            }
        } else {
            console.log('localStorage中没有数据');
        }
        return stored;
    };
}

// 监听关键词特效开关，自动识别关键词
watch(enableKeywordEffects, async (newValue) => {
    if (newValue && extractedKeywords.value.length === 0) {
        // 当开启关键词特效且还没有识别过关键词时，自动识别
        if (scriptContent.value || srtFile.value || customText.value) {
            try {
                // 使用silent=true，在后台自动识别，不显示成功或失败提示
                await extractKeywords(true);
            } catch (error) {
                // 自动识别失败时不显示错误提示（用户可以手动点击按钮重试）
                console.warn('[enableKeywordEffects-watch] 自动关键词识别失败:', error);
            }
        }
    }
});


// 🔧 停止所有任务（立即停止所有运行中的任务）
const stopAllTasks = async () => {
    try {
        console.log('[stopAllTasks] 🛑 开始停止所有任务...');

        // 1. 取消所有运行中的任务
        if (latestAudioTaskId.value) {
            try {
                console.log(`[stopAllTasks] 取消音频任务: ${latestAudioTaskId.value}`);
                await taskStore.requestCancel('SoundGenerate', latestAudioTaskId.value);
            } catch (e) {
                console.warn(`[stopAllTasks] 取消音频任务失败: ${e}`);
            }
        }

        if (latestVideoTaskId.value) {
            try {
                console.log(`[stopAllTasks] 取消视频任务: ${latestVideoTaskId.value}`);
                await taskStore.requestCancel('VideoGen', latestVideoTaskId.value);
            } catch (e) {
                console.warn(`[stopAllTasks] 取消视频任务失败: ${e}`);
            }
        }

        // 2. 立即重置所有状态变量
        console.log('[stopAllTasks] 重置所有状态变量...');
        isOneClickRunning.value = false;
        isGeneratingScript.value = false;
        isGeneratingTitleTags.value = false;
        isGeneratingAudio.value = false;
        isGeneratingVideo.value = false;
        isGeneratingSubtitle.value = false;
        isGeneratingCover.value = false;

        // 3. 关闭进度对话框
        showProgressDialog.value = false;

        // 4. 清理任务ID引用
        latestAudioTaskId.value = "";
        latestVideoTaskId.value = "";

        // 5. 从localStorage清理生成状态
        localStorage.removeItem('videoIPAgent_isGeneratingAudio');
        localStorage.removeItem('videoIPAgent_isGeneratingVideo');
        localStorage.removeItem('videoIPAgent_isGeneratingSubtitle');

        console.log('[stopAllTasks] 本地模型进程复用已默认启用，停止任务时不再额外执行强杀脚本');

        console.log('[stopAllTasks] ✅ 所有任务已停止');
        Message.success(t('已停止所有任务'));
    } catch (error: any) {
        console.error('[stopAllTasks] 停止任务失败:', error);
        Message.error(t('停止任务失败：') + (error?.message || '未知错误'));
    }
};

// 关闭所有后台任务（仅关闭功能，不支持开启）
const stopAllBackgroundTasks = async () => {
    try {
        if (isBackgroundTaskRunning.value) {
            Modal.confirm({
                title: t('确认关闭'),
                content: t('确定要关闭所有后台任务吗？'),
                okText: t('确定'),
                cancelText: t('取消'),
                zIndex: 10003,
                maskZIndex: 10003,
                onOk: async () => {
                    try {
                        await taskStore.stopBackgroundTasks();
                        Message.success(t('所有后台任务已关闭'));
                        // isBackgroundTaskRunning会自动通过computed更新
                    } catch (error: any) {
                        console.error('关闭后台任务失败:', error);
                        Message.error(t('操作失败：') + (error?.message || '未知错误'));
                    }
                }
            });
        }
    } catch (error: any) {
        console.error('关闭后台任务失败:', error);
        Message.error(t('操作失败：') + (error?.message || '未知错误'));
    }
};

console.log('[CRITICAL] 🔥 onMounted 函数定义已读取');

onMounted(async () => {
    // 🔥 最关键的修复：首先立即加载工作数据，不要等待其他初始化
    console.log('[onMounted] 🔥🔥🔥 优先加载工作数据 🔥🔥🔥');
    try {
        await loadWorkData();
        console.log('[onMounted] ✅ 工作数据已在最前面加载完成');
    } catch (e) {
        console.error('[onMounted] ❌ 前置 loadWorkData 失败:', e);
    }

    console.error('%c[onMounted] ⚠️⚠️⚠️ 组件挂载函数被调用 ⚠️⚠️⚠️', 'color: red; font-size: 20px; font-weight: bold; background: yellow;');

    console.log('%c[onMounted] 🚀 VideoIPAgent 组件挂载开始', 'color: red; font-size: 16px; font-weight: bold;');

    // 🔍 添加全局调试接口，方便在控制台查看FUNASR识别结果
    (window as any).__debugFunasrSegments = funasrSegments;
    console.log('💡 提示：可以在控制台使用 window.__debugFunasrSegments 查看FUNASR识别结果');
    console.log('💡 或者直接输入: __debugFunasrSegments.value');

    // 🔧 诊断：打印localStorage中所有关键数据
    try {
        console.log('[onMounted] 📦 localStorage中的VideoIPAgent相关数据:');
        const allKeys = Object.keys(window.localStorage);
        const videoIPAgentKeys = allKeys.filter(k => k.includes('VideoIPAgent') || k.includes('ipAgent') || k.includes('videoIPAgent'));
        videoIPAgentKeys.forEach(key => {
            const value = window.localStorage.getItem(key);
            console.log(`  - ${key}: ${value ? value.substring(0, 50) + '...' : 'null'}`);
        });
        if (videoIPAgentKeys.length === 0) {
            console.warn('[onMounted] ⚠️ localStorage中未找到任何VideoIPAgent相关数据');
        }
    } catch (e) {
        console.error('[onMounted] ❌ 检查localStorage失败:', e);
    }

    // 🔧 关键修复：标记组件已挂载
    isComponentMounted = true;

    // 加载各平台账号列表（发布时的账号选择下拉）
    loadPublishAccounts();

    // 🔧 自动迁移localStorage数据：aigcpanel → zhenqianba
    try {
        const oldKeywordGroups = localStorage.getItem('aigcpanel_keyword_groups');
        const oldSubtitleTemplates = localStorage.getItem('aigcpanel_subtitle_templates');

        if (oldKeywordGroups && !localStorage.getItem('zhenqianba_keyword_groups')) {
            localStorage.setItem('zhenqianba_keyword_groups', oldKeywordGroups);
            console.log('[数据迁移] ✅ 已迁移 keyword_groups');
        }

        if (oldSubtitleTemplates && !localStorage.getItem('zhenqianba_subtitle_templates')) {
            localStorage.setItem('zhenqianba_subtitle_templates', oldSubtitleTemplates);
            console.log('[数据迁移] ✅ 已迁移 subtitle_templates');
        }
    } catch (error) {
        console.error('[数据迁移] 迁移失败:', error);
    }

    try {
        // 等待 serverStore 初始化完成
        console.log('[onMounted] 1️⃣ 等待 serverStore 初始化...');
        console.log('[onMounted] ⏳ 即将调用 serverStore.waitReady()...');

        try {
            await serverStore.waitReady();
            console.log('[onMounted] ✅ serverStore.waitReady() 完成');
        } catch (waitError: any) {
            console.error('[onMounted] ❌ serverStore.waitReady() 出错:', {
                message: waitError?.message,
                error: waitError
            });
            throw waitError;
        }

        console.log('[onMounted] ✓ serverStore 初始化完成');

        // 等待下一个tick确保组件完全挂载
        console.log('[onMounted] ⏳ 等待下一个 tick...');
        await nextTick();
        console.log('[onMounted] ✅ nextTick 完成');

        // 加载设置
        console.log('[onMounted] 2️⃣ 加载设置...');
        await loadSettings();
        console.log('[onMounted] ✓ 设置加载完成（已等待异步完成）');

        // 📥 加载提示词配置
        try {
            console.log('[onMounted] 3️⃣ 加载提示词配置...');
            const savedPrompts = await window.$mapi.config.get('prompts');
            if (savedPrompts) {
                if (savedPrompts.scriptPrompt) settings.value.scriptPrompt = savedPrompts.scriptPrompt;
                if (savedPrompts.titleTagPrompt) settings.value.titleTagPrompt = savedPrompts.titleTagPrompt;
                if (savedPrompts.topicRewritePrompt) settings.value.topicRewritePrompt = savedPrompts.topicRewritePrompt;
                if (savedPrompts.rewritePrompt) settings.value.rewritePrompt = savedPrompts.rewritePrompt;
                console.log('[onMounted] ✅ 提示词配置加载完成');
            } else {
                console.log('[onMounted] ℹ️ 未找到保存的提示词配置，使用默认值');
            }
        } catch (error) {
            console.warn('[onMounted] ⚠️ 加载提示词配置失败，使用默认值:', error);
        }

        // isBackgroundTaskRunning通过computed自动更新
        console.log('[onMounted] 后台任务状态:', isBackgroundTaskRunning.value);

        // 🔧 恢复上次状态（从 localStorage）
        // 注意：现在音频文件保存在用户设置的 hubRoot 目录中，重启后会保留
        console.log('[onMounted] ⏳ 开始恢复上次状态...');
        try {
            const lastAudio = localStorage.getItem('ipAgent_last_audio');
            const lastText = localStorage.getItem('ipAgent_last_text');

            if (lastAudio) {
                console.log("恢复上次生成的语音:", lastAudio);
                audioPreviewUrl.value = lastAudio;
            }
            if (lastText && !scriptContent.value) {
                console.log("恢复上次的文案:", lastText);
                scriptContent.value = lastText;
            }
            console.log('[onMounted] ✅ 上次状态恢复完成');
        } catch (e) {
            console.warn("恢复状态失败:", e);
        }

        // 🔧 注意：loadWorkData 已在 onMounted 最前面执行过，这里跳过避免重复

        // 🔧 【修复】加载字幕模板 - 确保模板11被加载
        // 注意：如果在loadSettings中已经导入了配置（首次运行），则不需要再次加载
        console.log('[onMounted] 3.5️⃣ 检查字幕模板...');
        if (subtitleTemplates.value.length === 0) {
            console.log('[onMounted] 字幕模板列表为空，从数据库和localStorage加载...');
            await loadSubtitleTemplates();
        } else {
            console.log('[onMounted] 字幕模板已存在（可能在loadSettings中加载），跳过重复加载');
        }
        console.log('[onMounted] ✓ 字幕模板检查完成，总数:', subtitleTemplates.value?.length || 0);

        // 关键修复：必须先初始化关键词分组，然后再加载模板
        // 因为loadTemplate会尝试应用模板的样式到keywordGroups上
        // 所以keywordGroups必须已经存在（包括4个默认分组）
        console.log('[onMounted] 4️⃣ 异步初始化关键词分组（从数据库加载）...');

        // 🔧 【修复】改成非阻塞方式，防止初始化过程卡住设置页面
        // 让keywordGroups在后台加载，同时主进程继续执行
        initializeKeywordGroupsAsync().then(() => {
            console.log('[onMounted.background] ✓ initializeKeywordGroupsAsync 执行完成');
            console.log('[onMounted.background] keywordGroups.value长度:', keywordGroups.value?.length || 0);
            if (keywordGroups.value && keywordGroups.value.length > 0) {
                console.log('[onMounted.background] ✅ 关键词分组初始化成功（来自数据库）');
            } else {
                console.warn('[onMounted.background] ⚠️ 关键词分组初始化完成但可能为空');
            }
        }).catch(err => {
            console.error('[onMounted.background] ❌ 关键词分组初始化失败:', err);
        });

        console.log('[onMounted] ⚡ 关键词分组已触发后台加载，继续执行其他初始化...');

        // 重要：如果有保存的模板ID，自动加载该模板
        // 必须在loadWorkData和initializeKeywordGroups之后执行
        if (selectedSubtitleTemplate.value) {
            console.log('[onMounted] 尝试加载保存的模板，ID:', selectedSubtitleTemplate.value);
            const template = subtitleTemplates.value.find(t => t.id === selectedSubtitleTemplate.value);
            if (template) {
                console.log('[onMounted] ✅ 找到模板，自动加载:', template.name);
                await loadTemplate(template);
            } else {
                console.warn('[onMounted] ❌ 找不到模板ID为', selectedSubtitleTemplate.value, '的模板');
                console.warn('[onMounted] 可用的模板:', subtitleTemplates.value.map(t => ({id: t.id, name: t.name})));
            }
        } else {
            console.log('[onMounted] 没有保存的模板ID，跳过自动加载');
        }

        // 等待下一个tick，确保KeywordGroupManager组件已经挂载并初始化
        await nextTick();
        await nextTick(); // 再等待一个tick确保KeywordGroupManager的初始化完成

        // 同步VideoIPAgent的keywordGroups到KeywordGroupManager组件
        if (keywordGroupManagerRef.value && keywordGroupManagerRef.value.loadGroups) {
            console.log('[onMounted] 准备同步keywordGroups到KeywordGroupManager:', {
                groupsCount: keywordGroups.value?.length || 0,
                groups: keywordGroups.value?.map(g => ({name: g.name, id: g.id}))
            });
            keywordGroupManagerRef.value.loadGroups(keywordGroups.value);
            console.log('[onMounted] ✅ 同步完成');
        } else {
            console.warn('[onMounted] KeywordGroupManager组件未准备好');
        }

        // 设置IPC事件监听：处理来自主进程的字幕生成请求
        setupSubtitleGenerationListener();

        // 设置IPC事件监听：处理来自主进程的ASR识别请求
        setupAsrRecognizeListener();

        // 🔧 性能优化：推迟非关键操作到下一事件循环
        // 这样可以让页面更快地完成初始化并变为可交互状态
        // 而不是阻塞在恢复任务轮询和检查登录状态上
        Promise.resolve().then(async () => {
            try {
                console.log('[onMounted.background] 开始执行后台初始化任务...');

                // 恢复任务轮询状态
                await resumeTaskPolling();

                // 🔧 修改：页面加载时从数据库读取登录状态（不打开浏览器）
                // 这样切换页面后状态不会丢失
                await checkAllLoginStatus();

                console.log('[onMounted.background] 后台初始化任务完成（已从数据库恢复登录状态）');
            } catch (error) {
                console.error('onMounted background initialization error:', error);
            }
        });

        // 🔧 注册新任务类型
        console.log('[onMounted] 5️⃣ 注册任务类型...');
        taskStore.register('VideoTitleGeneration', VideoTitleGeneration);
        taskStore.register('VideoSubtitleAndBGM', VideoSubtitleAndBGM);
        console.log('[onMounted] ✓ 任务类型注册完成');

        // 🔧 【新增修复】恢复运行中的任务状态
        // 问题：组件切换页面时，加载状态 refs 被销毁，导致返回时看不到转圈圈
        // 解决：检查任务存储中是否有运行中的任务，并恢复 UI 状态
        console.log('[onMounted] 6️⃣ 检查是否有运行中的任务需要恢复...');
        try {
            // 从 taskStore.records 获取所有运行中的任务
            const runningTasks = taskStore.records?.filter((r: any) =>
                r.status === 'running' || r.status === 'querying' || r.status === 'queue'
            ) || [];

            if (runningTasks.length > 0) {
                console.log('[onMounted] 🔄 发现运行中的任务，恢复 UI 状态:', runningTasks);

                // 检查每个任务的 biz 类型，恢复对应的加载状态
                runningTasks.forEach((task: any) => {
                    // 根据任务的 biz 类型判断应该恢复哪个状态
                    const biz = task.biz || '';
                    const bizId = task.bizId || '';

                    console.log(`[onMounted] 发现运行中的任务: biz=${biz}, status=${task.status}`);

                    // 检查是否为音频相关任务 - 支持 SoundGenerate、Audio等多种命名
                    if (biz === 'SoundGenerate' || biz.includes('Audio') || biz.includes('audio') || biz.includes('语音') || biz.includes('Speech') || biz.includes('Sound')) {
                        console.log('[onMounted] 📻 恢复音频生成状态');
                        isGeneratingAudio.value = true;
                    }
                    // 检查是否为视频相关任务 - 支持 VideoGen、Video等多种命名
                    if (biz === 'VideoGen' || biz.includes('Video') || biz.includes('video') || biz.includes('视频') || biz.includes('口播')) {
                        console.log('[onMounted] 🎬 恢复视频生成状态');
                        isGeneratingVideo.value = true;
                    }
                    // 检查是否为字幕相关任务 - 支持 VideoSubtitleAndBGM等多种命名
                    if (biz === 'VideoSubtitleAndBGM' || biz.includes('Subtitle') || biz.includes('subtitle') || biz.includes('字幕')) {
                        console.log('[onMounted] 📝 恢复字幕生成状态');
                        isGeneratingSubtitle.value = true;
                    }
                });

                console.log('[onMounted] ✓ UI 状态恢复完成', {
                    isGeneratingAudio: isGeneratingAudio.value,
                    isGeneratingVideo: isGeneratingVideo.value,
                    isGeneratingSubtitle: isGeneratingSubtitle.value
                });
            } else {
                console.log('[onMounted] ✓ 没有运行中的任务');
            }

            // 🔧 【注意】字幕生成没有 TaskRecord，需要单独处理
            // 语音和视频任务已移至 resumeTaskPolling 使用事件驱动
            // 字幕生成不支持事件驱动，只能用 localStorage 恢复
            try {
                // 🔧 【修复】恢复最终视频URL，确保字幕生成完成后切换页面仍可看到结果
                const savedFinalVideoUrl = localStorage.getItem('videoIPAgent_finalVideoUrl');
                if (savedFinalVideoUrl) {
                    console.log('[onMounted] 📝 从 localStorage 恢复最终视频URL...');
                    await nextTick();

                    // 🔧 【关键修复】检查是否是 JSON 格式，如果是则解析并验证标志位
                    let parsedUrl = '';
                    let hasSubtitle = false;

                    if (typeof savedFinalVideoUrl === 'string' && (savedFinalVideoUrl.startsWith('{') || savedFinalVideoUrl.includes('{"'))) {
                        console.log('[onMounted] 🔍 检测到 localStorage 中的 URL 是 JSON 格式，尝试解析...');
                        try {
                            const parsed = JSON.parse(savedFinalVideoUrl);
                            parsedUrl = parsed.url || parsed.finalVideoUrl || '';
                            hasSubtitle = parsed.hasSubtitle === true;  // 🔧 只有标志位为true才认为有字幕
                            console.log('[onMounted] ✅ JSON 解析成功:', {
                                hasUrl: !!parsedUrl,
                                hasSubtitle: hasSubtitle,
                                generatedBy: parsed.generatedBy,
                                timestamp: new Date(parsed.timestamp).toLocaleString()
                            });
                        } catch (e) {
                            console.warn('[onMounted] ⚠️ JSON 解析失败:', e.message);
                            // 如果JSON解析失败，直接当作普通URL处理
                            parsedUrl = savedFinalVideoUrl;
                            hasSubtitle = false;
                        }
                    } else {
                        // 如果不是JSON格式，说明这是旧版本的纯URL字符串，不信任
                        console.warn('[onMounted] ⚠️ localStorage 中的URL格式不正确（非JSON），不加载');
                        parsedUrl = '';
                        hasSubtitle = false;
                    }

                    // 🔧 【关键修复】只有当 hasSubtitle === true 才恢复，防止加载没有字幕的视频
                    if (parsedUrl && hasSubtitle) {
                        // 确保 URL 有 file:// 前缀
                        const videoUrlForPlayback = parsedUrl.startsWith('file://') ? parsedUrl : 'file://' + parsedUrl;
                        finalVideoUrl.value = videoUrlForPlayback;
                        console.log('[onMounted] ✅ 已恢复最终视频URL:', videoUrlForPlayback.substring(0, 50) + '...');
                        // 关键修复：如果有最终视频URL，说明任务已完成，不应该显示"处理中"
                        isGeneratingSubtitle.value = false;
                        // 清除"处理中"状态
                        localStorage.removeItem('videoIPAgent_isGeneratingSubtitle');
                    } else if (parsedUrl && !hasSubtitle) {
                        // 检测到没有字幕的视频，直接清除这个错误的localStorage数据
                        console.warn('[onMounted] ⚠️ 检测到没有字幕的视频数据，已清除');
                        localStorage.removeItem('videoIPAgent_finalVideoUrl');
                        isGeneratingSubtitle.value = false;
                    } else {
                        // 只有当没有最终结果时，才恢复"处理中"状态
                        const savedSubtitleState = localStorage.getItem('videoIPAgent_isGeneratingSubtitle');
                        if (savedSubtitleState === 'true') {
                            console.log('[onMounted] 📝 从 localStorage 恢复字幕生成状态（处理中）');
                            isGeneratingSubtitle.value = true;
                        }
                    }
                } else {
                    // 只有当没有最终结果时，才恢复"处理中"状态
                    const savedSubtitleState = localStorage.getItem('videoIPAgent_isGeneratingSubtitle');
                    if (savedSubtitleState === 'true') {
                        console.log('[onMounted] 📝 从 localStorage 恢复字幕生成状态（处理中）');
                        isGeneratingSubtitle.value = true;
                    }
                }
            } catch (e) {
                console.warn('[onMounted] 从 localStorage 恢复字幕状态失败:', e);
            }
        } catch (e) {
            console.warn('[onMounted] 恢复任务状态失败:', e);
        }

        // 🆕 自动加载音频历史记录
        await loadGeneratedAudioHistory();

    } catch (error) {
        console.error("VideoIPAgent onMounted error:", error);
    }
});

// 故障排查：如果keywordGroups在渲染时仍为空，自动触发初始化
// 这是一个failsafe机制，用于处理onMounted失败的情况
let initializeAttempted = false;

// 🔧 已禁用：这个 watcher 可能导致初始化时的性能问题
// 关键词分组的初始化已在 onMounted 中处理
// const keywordGroupsWatcher = watch(
//     () => keywordGroups.value?.length || 0,
//     async (newLength, oldLength) => {
//         console.log('[keywordGroupsWatcher] keywordGroups长度变化:', { oldLength, newLength, initializeAttempted });
//
//         // 如果长度仍为0，且还未尝试初始化，则尝试初始化
//         if (newLength === 0 && !initializeAttempted) {
//             console.warn('[keywordGroupsWatcher] ⚠️ 检测到keywordGroups为空，触发应急初始化');
//             initializeAttempted = true;
//             try {
//                 await initializeKeywordGroupsAsync();
//                 console.log('[keywordGroupsWatcher] ✅ 应急初始化完成');
//             } catch (error) {
//                 console.error('[keywordGroupsWatcher] ❌ 应急初始化失败:', error);
//             }
//         }
//     },
//     { immediate: true, flush: 'post' }
// );

// 全局错误处理 - 捕获Vue组件更新错误

onErrorCaptured((error, instance, info) => {
    const errorMessage = error.message || String(error);
    const isFontColorError = errorMessage.includes('fontColor') || errorMessage.includes("Cannot read properties of undefined (reading 'fontColor')");

    // 🆕 增强：收集初始化状态信息
    const subtitleStyleInitialized = subtitleStyleSelectorRef.value?.isInitialized?.() ?? 'unknown';

    console.error('VideoIPAgent Vue error caught:', {
        error: errorMessage,
        componentName: instance?.$options?.name || 'Unknown',
        info,
        isFontColorError,
        timestamp: new Date().toISOString(),
        stack: error.stack?.split('\n').slice(0, 3).join('\n'),
        // 🆕 新增：初始化状态诊断
        subtitleStyleInitialized,
        subtitleSelectorRefExists: !!subtitleStyleSelectorRef.value
    });

    // 对于fontColor相关的错误，进行额外的诊断和修复
    if (isFontColorError) {
        console.error('[ERROR DIAGNOSTICS] fontColor 错误诊断:');
        console.error('  - previewStyle.value:', previewStyle.value);
        console.error('  - safePreviewStyle:', safePreviewStyle.value);
        console.error('  - DEFAULT_PREVIEW_STYLE:', DEFAULT_PREVIEW_STYLE);
        // 🆕 新增：SubtitleStyleSelector 初始化状态
        console.error('  - SubtitleStyleSelector 初始化状态:', subtitleStyleInitialized);
        console.error('  - subtitleStyleSelectorRef.value 存在:', !!subtitleStyleSelectorRef.value);

        // 🆕 增强：如果是初始化时序问题，给出明确提示
        if (subtitleStyleInitialized === false || subtitleStyleInitialized === 'unknown') {
            console.error('⚠️ SubtitleStyleSelector 尚未初始化完成，这可能是时序问题的原因');
            console.error('建议：调用 getSafeSubtitleStyle() 而非直接访问样式属性');
        }

        // 尝试修复：重新初始化previewStyle
        if (!previewStyle.value || !previewStyle.value.fontColor) {
            console.log('[ERROR RECOVERY] 尝试恢复 previewStyle...');
            previewStyle.value = structuredClone(DEFAULT_PREVIEW_STYLE);
        }
    }

    // 阻止错误继续传播，防止应用崩溃
    return false;
});

onBeforeUnmount(() => {
    // 🔧 关键修复：标记组件已卸载，防止背景任务继续创建定时器
    isComponentMounted = false;
    console.log('[onBeforeUnmount] 🔧 标记组件已卸载，背景任务将停止');

    // 注销任务类型
    taskStore.unregister('VideoTitleGeneration');
    taskStore.unregister('VideoSubtitleAndBGM');
    console.log('[onBeforeUnmount] 已注销任务类型');

    // 移除IPC事件监听器
    ipcRenderer.removeAllListeners('ipAgent:performSubtitleGeneration');
    console.log('[onBeforeUnmount] 已移除ipAgent:performSubtitleGeneration监听器');

    // 移除ASR IPC事件监听器
    ipcRenderer.removeAllListeners('ipAgent:performAsrRecognize');
    console.log('[onBeforeUnmount] 已移除ipAgent:performAsrRecognize监听器');

    // 清理音频播放器
    stopBGMPreview();
    if (bgmAudioPlayer.value) {
        bgmAudioPlayer.value = null;
    }

    // 清理定时器
    stopSelfServerCheckTimer();
    if (performanceMonitorInterval) {
        clearInterval(performanceMonitorInterval);
        performanceMonitorInterval = null;
        console.log('[onBeforeUnmount] 已清理性能监控器');
    }
    if (audioCheckInterval) {
        clearInterval(audioCheckInterval);
        audioCheckInterval = null;
    }
    if (audioCheckTimeout) {
        clearTimeout(audioCheckTimeout);
        audioCheckTimeout = null;
    }
    if (videoCheckInterval) {
        clearInterval(videoCheckInterval);
        videoCheckInterval = null;
    }
    if (videoCheckTimeout) {
        clearTimeout(videoCheckTimeout);
        videoCheckTimeout = null;
    }
    console.log('[onBeforeUnmount] 所有定时器已清理完成');

    // 组件卸载时保存数据
    saveWorkData();
});

const activeWorkflowStep = ref(0);
const workflowSteps = [
 {name:'灵感与文案',hint:'学习、构思与编辑'},
 {name:'声音与形象',hint:'选择声音与出镜形象'},
 {name:'视频与编排',hint:'合成、字幕与音乐'},
 {name:'封面与发布',hint:'完成作品并分享'}
];
const focusWorkflowStep = (index: number) => {
 activeWorkflowStep.value = index;
 const column = document.querySelector('.studio-creation-grid')?.children[index] as HTMLElement | undefined;
 if (!column) return;
 column.setAttribute('tabindex','-1');
 column.setAttribute('aria-label',workflowSteps[index].name);
 column.focus({preventScroll:true});
 column.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
};
const onWorkspaceCommand = (event: Event) => {
 if(!document.querySelector('.video-ip-agent-shell')) return;
 const command = (event as CustomEvent).detail;
 if(command==='agent-settings')openSettingsDialog();
 if(command==='agent-stop')stopAllTasks();
 if(command==='agent-reset')resetAllUserData();
 if(command==='agent-run')startOneClickIntelligence();
};
onMounted(()=>window.addEventListener('ipbot:command',onWorkspaceCommand));
onBeforeUnmount(()=>window.removeEventListener('ipbot:command',onWorkspaceCommand));

// 瀑布流布局：伸缩某个面板时其它列自动上移补位，避免 grid 自动行高把同行列绑在一起
const MASONRY_ROW_UNIT = 8;
let masonryObserver: ResizeObserver | null = null;
const updateMasonrySpans = () => {
    const grid = document.querySelector('.studio-creation-grid') as HTMLElement | null;
    if (!grid) return;
    const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;
    for (const child of Array.from(grid.children) as HTMLElement[]) {
        const height = child.getBoundingClientRect().height;
        child.style.gridRowEnd = `span ${computeRowSpan(height, MASONRY_ROW_UNIT, gap)}`;
    }
};
onMounted(() => {
    const grid = document.querySelector('.studio-creation-grid') as HTMLElement | null;
    if (!grid || typeof ResizeObserver === 'undefined') return;
    grid.style.gridAutoRows = `${MASONRY_ROW_UNIT}px`;
    updateMasonrySpans();
    masonryObserver = new ResizeObserver(updateMasonrySpans);
    for (const child of Array.from(grid.children)) masonryObserver.observe(child);
});
onBeforeUnmount(() => {
    masonryObserver?.disconnect();
    masonryObserver = null;
});
const handleCoverStyleUpdate = (style: any) => {
    coverStyle.value = style;
    if (coverConfig.value) coverConfig.value.coverStyle = JSON.parse(JSON.stringify(style));
};
</script>

<template>
    <!-- 🔧 【调整】移除h-full让页面根据内容自动调整高度，消除灰色空白 -->
    <div class="video-ip-agent-shell overflow-y-auto custom-scrollbar" style="background: #0a0a0a; position: relative;">
        <Teleport v-if="isTopbarRouteHostReady && router.currentRoute.value.path === '/video' && (!router.currentRoute.value.query.tab || router.currentRoute.value.query.tab === 'ipAgent')" to="#app-topbar-route-host">
            <div class="video-agent-top-workbar">
                
                <div class="video-agent-top-workbar__actions">
                    <button
                        class="video-agent-top-btn video-agent-top-btn--primary"
                        :class="{ 'video-agent-top-btn--running': isOneClickRunning }"
                        :disabled="isOneClickRunning"
                        @click="() => startOneClickIntelligence()"
                    >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                  d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                        </svg>
                        <span>{{ isOneClickRunning ? t('运行中...') : t('自动模式') }}</span>
                    </button>

                    <button class="video-agent-top-btn video-agent-top-btn--muted" :disabled="!hasRunningTasks" @click="() => stopAllTasks()">
                        <svg class="w-4 h-4" :class="hasRunningTasks ? 'animate-stop-icon' : ''" fill="none"
                             stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                  d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                  d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"></path>
                        </svg>
                        <span>{{ t("停止任务") }}</span>
                    </button>
                    <button class="video-agent-top-btn video-agent-top-btn--danger" @click="() => resetAllUserData()">
                        <icon-delete class="w-4 h-4"/>
                        <span>{{ t("清空数据") }}</span>
                    </button>
                </div>
                <div>
                    <button class="video-agent-top-btn video-agent-top-btn--muted"
                            @click="() => openSettingsDialog()">
                        <icon-settings class="w-4 h-4"/>
                        <span>{{ t("智能体配置") }}</span>
                    </button>
                </div>
            </div>
        </Teleport>

        <!-- 法律警告横幅 -->
        <IPAgentWarning/>

        <div class="studio-workspace-intro"><div><div class="studio-eyebrow">数字人视频创作</div><h1>从一个灵感，到一条好视频<span>。</span></h1><p>让 AI 串联文案、声音与形象，专注你的创作表达。</p></div><div class="studio-workspace-badge"><span></span>IP 口播智能体</div></div>
<nav class="workflow-navigation" aria-label="创作流程"><button v-for="(step,index) in workflowSteps" :key="step.name" type="button" :aria-current="activeWorkflowStep===index?'step':undefined" @click="focusWorkflowStep(index)"><b>{{index+1}}</b><span>{{step.name}}<small>{{step.hint}}</small></span></button></nav>
<div class="cyberpunk-dashboard flex flex-col w-full">
            <div class="studio-creation-grid grid grid-cols-4 gap-2 w-full p-2">
                <!-- 第1列：IP大脑 + 文案编辑 -->
                <!-- 🔧 【调整】使用flex布局让列内容底部对齐 -->
                <div class="flex flex-col gap-1.5">
                    <!-- 01 深度学习 -->
                    <div class="bg-[#141414] border border-[#333] rounded-xl overflow-hidden hover-glow-effect"
                         :class="{'section-processing': isVideoRewriting}">
                        <div
                            class="section-card-header flex items-center justify-between cursor-pointer transition-all duration-300 px-4 py-2.5"
                            :class="{'border-b border-[#333]': !collapsed.ipBrain}"
                            role="button" tabindex="0" :aria-expanded="!collapsed.ipBrain" @keydown.enter.prevent="collapsed.ipBrain = !collapsed.ipBrain" @keydown.space.prevent="collapsed.ipBrain = !collapsed.ipBrain" @click="collapsed.ipBrain = !collapsed.ipBrain">
                            <div class="flex items-center gap-3">
                                <div
                                    class="relative w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden"
                                    style="background: linear-gradient(135deg, #2563eb, #06b6d4);">
                                    <div class="absolute inset-0 opacity-30"
                                         style="background: radial-gradient(circle at 30% 20%, rgba(255,255,255,0.5), transparent 60%);"></div>
                                    <span class="relative text-[15px] font-black text-white tracking-widest">01</span>
                                </div>
                                <div class="flex flex-col">
                                    <h3 class="text-[15px] font-bold tracking-wider bg-gradient-to-r from-sky-300 via-cyan-300 to-blue-400 bg-clip-text text-transparent">
                                        视频文案提炼</h3>
                                    <span class="text-[10px] font-medium text-slate-500 tracking-wider mt-0.5">VIDEO COPY INSIGHTS</span>
                                </div>
                            </div>
                            <div class="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-300"
                                 :class="!collapsed.ipBrain ? 'bg-blue-500/15 rotate-180' : 'bg-white/[0.04]'">
                                <svg class="w-4 h-4 transition-transform"
                                     :class="!collapsed.ipBrain ? 'text-blue-400' : 'text-slate-500'" fill="none"
                                     stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                          d="M19 9l-7 7-7-7"/>
                                </svg>
                            </div>
                        </div>

                        <div v-show="!collapsed.ipBrain" class="p-3">
                            <!-- IP深度学习内部页签切换 -->
                            <a-radio-group v-model="activeIPBrainTab" @change="handleIPBrainTabChange" type="button"
                                           size="small" class="ip-brain-tab mb-2.5 w-full grid grid-cols-3 gap-1.5">
                                <a-radio value="videoWrite" class="text-center text-[14px]">{{
                                        t("视频学习")
                                    }}
                                </a-radio>
                                <a-radio value="customPrompt" class="text-center text-[14px]">{{
                                        t("爆款文案")
                                    }}
                                </a-radio>
                                <a-radio value="ipBrain" class="text-center text-[14px]">{{ t("IP学习") }}</a-radio>
                            </a-radio-group>

                            <!-- IP深度学习 tab 内容 -->
                            <div v-show="activeIPBrainTab === 'ipBrain'">
                                <div class="flex justify-end">
                                    <a-button
                                        type="primary"
                                        size="small"
                                        @click="openAddIPDialog"
                                        :disabled="learnedAccounts.length >= 5"
                                    >
                                        {{ t("添加IP大脑") }}
                                        <span v-if="learnedAccounts.length >= 5" class="ml-1">({{
                                                t("已达上限")
                                            }})</span>
                                    </a-button>
                                </div>

                                <!-- 已学习到的对标 -->
                                <div class="mt-3">
                                    <div class="text-[14px] mb-2" style="color: var(--theme-text-primary);">
                                        {{ t("已学习到的对标") }}
                                        <span class="text-[14px] ml-1" style="color: var(--theme-text-muted);">({{
                                                learnedAccounts.length
                                            }}/5)</span>
                                    </div>
                                    <div v-if="learnedAccounts.length > 0" class="space-y-1">
                                        <div
                                            v-for="(account, index) in learnedAccounts"
                                            :key="account.url"
                                            class="text-[14px] p-2 rounded flex justify-between items-center cursor-pointer transition-all bg-white/5 border border-white/5 hover:bg-white/10"
                                            :class="{ 'active': selectedAccountIndex === index }"
                                            @click="() => { selectedAccountIndex = index; selectedTopicIndex = null; }"
                                        >
                                            <span class="truncate flex-1"
                                                  style="color: var(--theme-text-primary);">{{ account.name }}</span>
                                            <span class="text-[14px] mr-1" style="color: var(--theme-text-muted);">({{
                                                    account.topicLibrary?.length || 0
                                                }}/6)</span>
                                            <a-button size="mini" type="text" @click.stop="removeAccount(index)"
                                                      class="ml-1">
                                                {{ t("删除") }}
                                            </a-button>
                                        </div>
                                    </div>
                                    <div v-else class="text-[14px] py-2" style="color: var(--theme-text-muted);">
                                        {{ t("暂无对标") }}
                                    </div>
                                </div>

                                <!-- 选题库 -->
                                <div class="mt-3">
                                    <div class="flex items-center justify-between mb-2">
                                        <div class="text-[14px]" style="color: var(--theme-text-primary);">
                                            {{ t("选题库") }}
                                            <span v-if="selectedAccountIndex !== null" class="text-[14px] ml-1"
                                                  style="color: #94a3b8;">
                                            ({{ learnedAccounts[selectedAccountIndex]?.name || '' }})
                                        </span>
                                        </div>
                                        <div class="flex gap-1.5">
                                            <a-button
                                                size="mini"
                                                type="primary"
                                                :loading="topicLibrary.some(t => t.isRewriting)"
                                                @click="refreshTopics"
                                                v-if="topicLibrary.length > 0 && selectedAccountIndex !== null"
                                            >
                                                <icon-refresh/>
                                            </a-button>
                                        </div>
                                    </div>

                                    <div v-if="selectedAccountIndex === null" class="text-[14px] py-2 text-center"
                                         style="color: #64748b;">
                                        {{ t("请先选择一个对标") }}
                                    </div>
                                    <div v-else-if="topicLibrary.length > 0"
                                         class="space-y-3 max-h-60 overflow-y-auto custom-scrollbar">
                                        <div
                                            v-for="(topic, index) in topicLibrary"
                                            :key="`${selectedAccountIndex}-${topic.original}-${index}`"
                                            class="topic-item p-2 rounded-lg border text-[14px] cursor-pointer transition-all duration-200"
                                            :class="selectedTopicIndex === index
                                            ? 'bg-blue-500/20 border-blue-400 ring-2 ring-blue-400/50 shadow-lg shadow-blue-500/20'
                                            : 'bg-white/5 border-white/5 hover:bg-white/10 hover:border-white/10'"
                                            @click="selectTopic(index)"
                                        >
                                            <div class="flex items-center gap-2">
                                                <div v-if="selectedTopicIndex === index"
                                                     class="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0"></div>
                                                <div
                                                    :style="selectedTopicIndex === index ? 'color: #93c5fd;' : 'color: #e2e8f0;'">
                                                    {{ topic.original }}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div v-else class="text-[14px] py-2 text-center" style="color: #64748b;">
                                        {{ t("暂无选题") }}
                                    </div>
                                </div>
                            </div>

                            <!-- 智能视频学习 tab 内容 -->
                            <div v-show="activeIPBrainTab === 'videoWrite'">
                                <!-- 🔧 【调整】改为space-y-3减少间距，消除绿色空白 -->
                                <!-- 视频仿写模式 -->
                                <div class="space-y-3">
                                    <!-- 🔧 输入链接 + 一键仿写按钮 同一行 -->
                                    <div class="flex gap-2 items-center">
                                        <a-input
                                            v-model="videoRewriteUrl"
                                            :placeholder="t('输入某音、某手、某书等视频链接 . . .')"
                                            size="small"
                                            class="flex-1 dark-input-override small-placeholder"
                                            style="min-height: 40px;"
                                        />
                                        <a-button size="small" @click="pasteVideoRewriteUrl">
                                            {{ t("粘贴") }}
                                        </a-button>
                                        <a-button type="primary" size="small" :loading="isVideoRewriting"
                                                  @click="startVideoRewriteProcessOptimized">
                                            {{ t("一键仿写") }}
                                        </a-button>
                                    </div>

                                    <!-- 禁止仿写提示 -->
                                    <div class="flex items-center gap-1.5 text-[12px] text-amber-400">
                                        <icon-exclamation-circle-fill class="text-[14px] flex-shrink-0 mt-0.5"/>
                                        <span>禁止仿写涉政夸大低俗抹黑及各类不良违规内容</span>
                                    </div>

                                    <div v-if="videoRewriteProgress" class="text-[14px] text-blue-400">
                                        {{ videoRewriteProgress }}
                                    </div>

                                    <!-- 🔧 【调整】将识别的原始内容移到这里 -->
                                    <div class="space-y-1">
                                        <div class="text-[14px] font-medium flex items-center gap-1.5"
                                             style="color: var(--theme-text-primary);">
                                            <span>{{ t("识别的原始内容") }}</span>
                                            <span v-if="!recognizedText"
                                                  style="color: #64748b;">({{ t("使用视频仿写功能后显示") }})</span>
                                        </div>
                                        <div class="relative">
                                            <!-- 🔧 【调整】增加最小高度从60px改为240px，最大高度改为280px -->
                                            <textarea
                                                v-model="recognizedText"
                                                readonly
                                                :placeholder="t('使用【打开视频链接】功能后，识别的原始内容将显示在这里...')"
                                                class="font-mono p-2 w-full custom-scrollbar modern-textarea"
                                                style="min-height: 240px; max-height: 280px; overflow-y: auto; font-size: 14px; line-height: 1.6;"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- 🆕 爆款文案 tab 内容 -->
                            <div v-show="activeIPBrainTab === 'customPrompt'">
                                <div class="space-y-2.5">
                                    <!-- 视频类型 (必选) -->
                                    <div class="space-y-1">
                                        <div class="text-[14px] font-medium flex items-center gap-1.5"
                                             style="color: var(--theme-text-primary);">
                                            {{ t("视频类型") }}
                                            <span class="text-[14px]" style="color: #f87171;">*</span>
                                        </div>
                                        <a-select v-model="viralVideoType" size="small"
                                                  class="w-full dark-input-override">
                                            <a-option value="口播文案">{{ t("口播文案") }}</a-option>
                                            <a-option value="广告投放文案">{{ t("广告投放文案") }}</a-option>
                                        </a-select>
                                    </div>

                                    <!-- 文案类型 (必选) -->
                                    <div class="space-y-1">
                                        <div class="text-[14px] font-medium flex items-center gap-1.5"
                                             style="color: var(--theme-text-primary);">
                                            {{ t("文案类型") }}
                                            <span class="text-[14px]" style="color: #f87171;">*</span>
                                        </div>
                                        <a-select v-model="viralCopyType" size="small"
                                                  class="w-full dark-input-override">
                                            <a-option value="人设型">{{ t("人设型") }}</a-option>
                                            <a-option value="流量型">{{ t("流量型") }}</a-option>
                                            <a-option value="变现型">{{ t("变现型") }}</a-option>
                                            <a-option value="获客型">{{ t("获客型") }}</a-option>
                                            <a-option value="案例型">{{ t("案例型") }}</a-option>
                                            <a-option value="招商型">{{ t("招商型") }}</a-option>
                                            <a-option value="营销型">{{ t("营销型") }}</a-option>
                                            <a-option value="电商带货型">{{ t("电商带货型") }}</a-option>
                                        </a-select>
                                    </div>

                                    <!-- 行业+人设 (可选) -->
                                    <div class="space-y-1">
                                        <div class="text-[14px] font-medium" style="color: var(--theme-text-primary);">
                                            {{ t("行业+人设") }}
                                            <span class="text-[14px]" style="color: #94a3b8;">{{ t("（可选）") }}</span>
                                        </div>
                                        <a-input
                                            v-model="viralPersona"
                                            size="small"
                                            :placeholder="t('例如：餐饮店，我叫斌哥，在上海，有10年餐饮经验')"
                                            class="dark-input-override"
                                        />
                                    </div>

                                    <!-- 产品/业务 (可选) -->
                                    <div class="space-y-1">
                                        <div class="text-[14px] font-medium" style="color: var(--theme-text-primary);">
                                            {{ t("产品/业务") }}
                                            <span class="text-[14px]" style="color: #94a3b8;">{{ t("（可选）") }}</span>
                                        </div>
                                        <a-input
                                            v-model="viralProduct"
                                            size="small"
                                            :placeholder="t('例如：纸巾，麻辣烫，房产，教培，财务...')"
                                            class="dark-input-override"
                                        />
                                    </div>

                                    <!-- 卖点+价格 (可选) -->
                                    <div class="space-y-1">
                                        <div class="text-[14px] font-medium" style="color: var(--theme-text-primary);">
                                            {{ t("卖点+价格") }}
                                            <span class="text-[14px]" style="color: #94a3b8;">{{ t("（可选）") }}</span>
                                        </div>
                                        <a-input
                                            v-model="viralSellingPoint"
                                            size="small"
                                            :placeholder="t('例如：纸张柔软亲肤，正常价99，今天只要59元')"
                                            class="dark-input-override"
                                        />
                                    </div>

                                    <!-- 其他要求 (可选) -->
                                    <div class="space-y-1">
                                        <div class="text-[14px] font-medium" style="color: var(--theme-text-primary);">
                                            {{ t("其他要求") }}
                                            <span class="text-[14px]" style="color: #94a3b8;">{{ t("（可选）") }}</span>
                                        </div>
                                        <a-textarea
                                            v-model="viralOther"
                                            :placeholder="t('例如：风格幽默，突出性价比，适合30-50岁人群...')"
                                            :auto-size="{ minRows: 2, maxRows: 4 }"
                                            size="small"
                                            class="dark-input-override"
                                        />
                                    </div>

                                    <!-- 目标字数 -->
                                    <div class="space-y-1">
                                        <div class="text-[14px] font-medium" style="color: var(--theme-text-primary);">
                                            {{ t("目标字数") }}
                                        </div>
                                        <div class="flex items-center gap-2">
                                            <a-slider
                                                v-model="viralWordCount"
                                                :min="50"
                                                :max="1500"
                                                :step="50"
                                                class="flex-1"
                                            />
                                            <a-input-number
                                                v-model="viralWordCount"
                                                :min="50"
                                                :max="1500"
                                                :step="50"
                                                size="small"
                                                style="width: 80px;"
                                                class="dark-input-override"
                                            />
                                        </div>
                                    </div>

                                    <!-- 生成按钮 -->
                                    <div class="flex justify-end">
                                        <a-button
                                            type="primary"
                                            size="small"
                                            :loading="isGeneratingCustomPrompt"
                                            @click="generateFromCustomPrompt"
                                        >
                                            {{ isGeneratingCustomPrompt ? t("生成中...") : t("生成爆款文案") }}
                                        </a-button>
                                    </div>

                                    <!-- 进度提示 -->
                                    <div v-if="customPromptProgress" class="text-[14px] text-blue-400">
                                        {{ customPromptProgress }}
                                    </div>

                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 视频文案编辑 -->
                    <div
                        class="bg-[#141414] border border-[#333] rounded-xl overflow-hidden hover-glow-effect flex flex-col"
                        :class="{'flex-grow': !collapsed.scriptEdit, 'section-processing': isGeneratingScript || isGeneratingCustomPrompt}">
                        <div
                            class="section-card-header flex items-center justify-between cursor-pointer transition-all duration-300 px-4 py-2.5"
                            :class="{'border-b border-[#333]': !collapsed.scriptEdit}"
                            role="button" tabindex="0" :aria-expanded="!collapsed.scriptEdit" @keydown.enter.prevent="collapsed.scriptEdit = !collapsed.scriptEdit" @keydown.space.prevent="collapsed.scriptEdit = !collapsed.scriptEdit" @click="collapsed.scriptEdit = !collapsed.scriptEdit">
                            <div class="flex items-center gap-3">
                                <div class="w-2 h-2 rounded-full bg-blue-400/60"></div>
                                <h3 class="text-[14px] font-semibold tracking-wide text-slate-300">视频文案编辑</h3>
                            </div>
                            <div class="w-6 h-6 rounded-md flex items-center justify-center transition-all duration-300"
                                 :class="!collapsed.scriptEdit ? 'bg-blue-500/15 rotate-180' : 'bg-white/[0.03]'">
                                <svg class="w-3.5 h-3.5"
                                     :class="!collapsed.scriptEdit ? 'text-blue-400' : 'text-slate-500'" fill="none"
                                     stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                          d="M19 9l-7 7-7-7"/>
                                </svg>
                            </div>
                        </div>

                        <div v-show="!collapsed.scriptEdit" class="p-3 space-y-2.5">
                            <!-- 仿写后的文案编辑框 -->
                            <div class="space-y-1">
                                <div class="text-[14px] font-medium" style="color: var(--theme-text-primary);">
                                    {{ t("文案内容") }}
                                </div>
                                <div class="relative">
                                    <!-- 🔧 【调整】增加文案编辑输入框的最小高度从200px改为320px -->
                                    <textarea
                                        v-model="scriptContent"
                                        :placeholder="t('文案内容将显示在这里...')"
                                        class="font-mono p-2 w-full custom-scrollbar modern-textarea"
                                        style="min-height: 320px; max-height: 350px; overflow-y: auto; font-size: 14px; line-height: 1.6;"
                                    />
                                </div>
                            </div>

                            <div class="flex gap-2 items-center pt-1 justify-end">
                                <a-input-number v-model="scriptWordCount" class="theme-compact-number" size="small"
                                                addon-after="字" style="width: 100px" :min="100" :max="2000"/>

                                <!-- 🆕 语言选择器 -->
                                <a-select
                                    v-model="audioLanguage"
                                    class="theme-compact-select"
                                    :options="audioLanguageOptions"
                                    size="small"
                                    style="width: 120px;"
                                    :placeholder="t('选择语言')"
                                />

                                <a-button size="small" type="primary" :loading="isGeneratingScript"
                                          @click="generateScriptFromTopic">
                                    {{ isGeneratingScript ? t("生成中...") : t("撰写文案") }}
                                </a-button>
                                <a-button size="small" type="primary" :loading="isCheckingLegal"
                                          @click="handleLegalCheck">
                                    {{ isCheckingLegal ? t("检测中...") : t("AI法务") }}
                                </a-button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 第2列：02 音视频生成（完整） -->
                <!-- 🔧 【调整】使用flex布局让列内容底部对齐 -->
                <div class="flex flex-col gap-1.5">
                    <div class="bg-[#141414] border border-[#333] rounded-xl overflow-hidden hover-glow-effect"
                         :class="{'section-processing': isGeneratingAudio || isGeneratingVideo}">
                        <div
                            class="section-card-header flex items-center justify-between cursor-pointer transition-all duration-300 px-4 py-2.5"
                            :class="{'border-b border-[#333]': !collapsed.audioVideo}"
                            role="button" tabindex="0" :aria-expanded="!collapsed.audioVideo" @keydown.enter.prevent="collapsed.audioVideo = !collapsed.audioVideo" @keydown.space.prevent="collapsed.audioVideo = !collapsed.audioVideo" @click="collapsed.audioVideo = !collapsed.audioVideo">
                            <div class="flex items-center gap-3">
                                <div
                                    class="relative w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden"
                                    style="background: linear-gradient(135deg, #14b8a6, #10b981);">
                                    <div class="absolute inset-0 opacity-30"
                                         style="background: radial-gradient(circle at 30% 20%, rgba(255,255,255,0.5), transparent 60%);"></div>
                                    <span class="relative text-[15px] font-black text-white tracking-widest">02</span>
                                </div>
                                <div class="flex flex-col">
                                    <h3 class="text-[15px] font-bold tracking-wider bg-gradient-to-r from-teal-300 via-emerald-300 to-cyan-400 bg-clip-text text-transparent">
                                        {{ t("音频视频生成") }}</h3>
                                    <span class="text-[10px] font-medium text-slate-500 tracking-wider mt-0.5">VOICE & AVATAR STUDIO</span>
                                </div>
                            </div>
                            <div class="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-300"
                                 :class="!collapsed.audioVideo ? 'bg-cyan-500/15 rotate-180' : 'bg-white/[0.04]'">
                                <svg class="w-4 h-4 transition-transform"
                                     :class="!collapsed.audioVideo ? 'text-cyan-400' : 'text-slate-500'" fill="none"
                                     stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                          d="M19 9l-7 7-7-7"/>
                                </svg>
                            </div>
                        </div>

                        <!-- 🔧 【调整】改为space-y-3减少元素间距，消除空白 -->
                        <div v-show="!collapsed.audioVideo" class="p-3 space-y-2.5">
                            <!-- 音频生成 -->
                            <div>
                                <div class="space-y-3">
                                    <!-- 音色选择 + 系统音色/我的音色 Tab -->
                                    <div>
                                        <div class="flex items-center gap-3 mb-1">
                                            <div class="text-[14px] text-slate-200">{{ t("音色选择") }}</div>
                                            <div class="flex gap-1.5">
                                                <a-button type="text" size="mini" @click="openVoiceDialog('system')">
                                                    {{ t("系统音色") }}
                                                </a-button>
                                                <a-button type="text" size="mini" @click="openVoiceDialog('my')">
                                                    {{ t("我的音色") }}
                                                </a-button>
                                                <a-button type="text" size="mini" @click="soundPromptEditRef?.add()">
                                                    <template #icon>
                                                        <icon-plus/>
                                                    </template>
                                                    {{ t("克隆音色") }}
                                                </a-button>
                                            </div>
                                        </div>
                                        <SoundPromptSelector ref="soundPromptSelectorRef"
                                                             v-model="settings.voicePromptId"
                                                             class="dark-input-override"
                                                             :ttsModel="settings.onlineTtsModel"/>
                                    </div>

                                    <!-- 情绪、语速、语言 - 一行显示 -->
                                    <div class="grid grid-cols-3 gap-2">
                                        <!-- 情绪选择 -->
                                        <div>
                                            <div class="text-[14px] text-slate-200 mb-1.5">{{ t("情绪") }}</div>
                                            <a-select v-model="audioEmotion" size="small"
                                                      class="w-full dark-input-override">
                                                <a-option v-for="opt in emotionOptions" :key="opt.value"
                                                          :value="opt.value">{{ opt.label }}
                                                </a-option>
                                            </a-select>
                                        </div>

                                        <!-- 语速选择 -->
                                        <div>
                                            <div class="text-[14px] text-slate-200 mb-1.5">{{ t("语速") }}</div>
                                            <a-input-number
                                                v-model="audioSpeed"
                                                :min="speedRange.min"
                                                :max="speedRange.max"
                                                :step="speedRange.step"
                                                size="small"
                                                class="w-full dark-input-override"
                                            />
                                        </div>

                                        <!-- 语言选择 -->
                                        <div>
                                            <div class="text-[14px] text-slate-200 mb-1.5">{{ t("语言") }}</div>
                                            <a-select
                                                v-model="audioLanguage"
                                                :options="audioLanguageOptions"
                                                size="small"
                                                class="w-full dark-input-override"
                                            />
                                        </div>
                                    </div>

                                    <!-- 情绪不支持提示 -->
                                    <div v-if="audioEmotion !== '自动' && !currentVoiceSupportsInstruct"
                                         class="text-[14px] text-amber-400 flex items-center gap-1.5.5">
                                        <icon-exclamation-circle-fill/>
                                        {{ t('当前系统音色不支持情绪控制，选择将被忽略') }}
                                    </div>

                                    <!-- 切换语音模型 + 生成语音按钮 -->
                                    <div class="flex items-center gap-2">
                                        <a-select v-model="settings.onlineTtsModel" size="small"
                                                  class="flex-1 dark-input-override">
                                            <a-option
                                                v-for="m in ttsModelConfigs.filter(m => m.id !== 'aliyun-cosyvoice')"
                                                :key="m.id" :value="m.id">{{ m.name }}
                                            </a-option>
                                        </a-select>
                                        <a-button
                                            type="primary"
                                            size="small"
                                            class="flex-1"
                                            :loading="isGeneratingAudio"
                                            @click="generateAudio"
                                        >
                                            {{ isGeneratingAudio ? t("生成中...") : t("生成语音") }}
                                        </a-button>
                                    </div>

                                    <!-- 🆕 语言-音色不匹配警告 -->
                                    <div v-if="voiceLanguageMismatch"
                                         class="text-[14px] text-amber-400 flex items-start gap-1.5 p-2 bg-amber-900/20 rounded-lg border border-amber-500/30">
                                        <icon-exclamation-circle-fill class="mt-0.5 shrink-0"/>
                                        <div>
                                            <span>当前选择的语言是「{{
                                                    audioLanguage
                                                }}」，但音色适合「{{
                                                    currentVoiceLanguageLabel
                                                }}」，语音将以音色为准。建议选择{{
                                                    audioLanguage
                                                }}音色{{
                                                    recommendedVoiceNames.length > 0 ? '，如：' + recommendedVoiceNames.join('、') : ''
                                                }}</span>
                                        </div>
                                    </div>

                                    <!-- 音频预览与选择 -->
                                    <div class="mt-3 p-3 rounded-lg border"
                                         :class="isLightTheme ? 'bg-white border-gray-200' : 'bg-[#1a1a1a] border-[#333]'">
                                        <div class="flex items-center justify-between mb-2">
                                            <div class="text-[14px] text-slate-400">{{ t("音频预览") }}</div>
                                            <div class="flex items-center gap-2">
                                                <a-select
                                                    v-model="selectedAudioIndex"
                                                    size="mini"
                                                    style="width: 160px;"
                                                    :placeholder="generatedAudioHistory.length > 0 ? t('选择历史音频') : t('暂无历史记录')"
                                                    :disabled="generatedAudioHistory.length === 0"
                                                    @change="selectAudioForVideo"
                                                    allow-clear
                                                >
                                                    <a-option :value="null">{{ t("最新生成") }}</a-option>
                                                    <a-option
                                                        v-for="(item, index) in generatedAudioHistory"
                                                        :key="item.id"
                                                        :value="index"
                                                    >
                                                        {{ dayjs(item.timestamp).format('YYYY-MM-DD HH:mm:ss') }}
                                                    </a-option>
                                                </a-select>
                                                <a-button type="text" size="mini" @click="loadGeneratedAudioHistory"
                                                          class="text-gray-500 hover:text-white">
                                                    <icon-refresh/>
                                                </a-button>
                                                <a-button v-if="selectedAudioUrl || audioPreviewUrl" type="text"
                                                          size="mini"
                                                          @click="openFileLocation(selectedAudioUrl || audioPreviewUrl)"
                                                          class="text-gray-500 hover:text-white">
                                                    <icon-folder/>
                                                </a-button>
                                            </div>
                                        </div>
                                        <div v-if="selectedAudioUrl || audioPreviewUrl">
                                            <AudioPlayer
                                                :key="selectedAudioUrl || audioPreviewUrl"
                                                :url="selectedAudioUrl || audioPreviewUrl"
                                                @duration-change="audioDuration = $event"
                                            />
                                        </div>
                                        <div v-else class="text-center py-4 text-gray-500 text-[14px]">
                                            {{ t("暂无音频，请生成或选择历史记录") }}
                                        </div>
                                    </div>

                                    <!-- 视频模板选择 -->
                                    <div class="mt-3">
                                        <div class="flex items-center gap-2 mb-2">
                                            <div class="text-[14px] text-gray-600 dark:text-slate-300">{{
                                                    t("选择形象")
                                                }}
                                            </div>
                                            <div class="flex gap-1.5">
                                                <a-button type="text" size="mini" @click="showSystemAvatarDialog">
                                                    {{ t("系统形象") }}
                                                </a-button>
                                                <a-button type="text" size="mini" @click="showMyAvatarDialog">
                                                    {{ t("我的形象") }}
                                                </a-button>
                                                <a-button type="text" size="mini" @click="videoTemplateEditRef?.add()">
                                                    <template #icon>
                                                        <icon-plus/>
                                                    </template>
                                                    {{ t("添加形象") }}
                                                </a-button>
                                            </div>
                                        </div>
                                        <VideoTemplateSelector ref="videoTemplateSelectorRef" v-model="videoTemplateId"
                                                               size="small" class="dark-input-override"/>
                                        <div class="grid grid-cols-3 gap-y-2 mt-2">
                                            <a-checkbox v-model="enableBeautyWhiten">{{ t("美颜美牙") }}</a-checkbox>
                                            <a-checkbox v-model="enableVideoEnhance">{{ t("画质增强") }}</a-checkbox>
                                            <a-checkbox v-model="enableSmartColor">{{ t("智能调色") }}</a-checkbox>
                                            <a-checkbox v-model="enableVideoDenoise">{{ t("视频降噪") }}</a-checkbox>
                                            <a-checkbox v-model="enableAutoFrame">{{ t("自动补帧") }}</a-checkbox>
                                            <a-checkbox v-model="enableMotionStab">{{ t("运镜防抖") }}</a-checkbox>
                                        </div>
                                        <div class="flex items-start gap-1.5 text-[12px] text-amber-400 mt-1">
                                            <icon-exclamation-circle-fill class="text-[14px] flex-shrink-0 mt-0.5"/>
                                            <span>开启的功能越多，生成视频的速度会越慢</span>
                                        </div>
                                    </div>

                                    <div class="flex gap-2 mt-3">
                                        <div class="flex-1 video-gen-model-selector">
                                            <ServerSelector
                                                v-model="settings.videoDigitalHumanModelKey"
                                                functionName="videoGen"
                                                :show-cloud="true"
                                                :show-self-server="true"
                                            />
                                        </div>
                                        <a-button
                                            type="primary"
                                            size="small"
                                            class="flex-1"
                                            :loading="isGeneratingVideo"
                                            @click="generateVideo"
                                        >
                                            {{ isGeneratingVideo ? t("生成中...") : t("生成口播视频") }}
                                        </a-button>
                                    </div>
                                    <div class="text-[12px] text-gray-400 mt-1">{{
                                            t("若生成失败请切换网络代理节点")
                                        }}
                                    </div>

                                    <!-- 视频预览 -->
                                    <div class="mt-2">
                                        <div class="text-[14px] text-slate-200 mb-1.5">{{ t("视频预览") }}</div>
                                        <div v-if="videoPreviewUrl"
                                             class="aspect-video bg-black rounded overflow-hidden">
                                            <VideoPlayer :key="videoPreviewUrl" :url="'file://' + videoPreviewUrl"/>
                                        </div>
                                        <div v-else
                                             class="aspect-video bg-gray-100 rounded flex items-center justify-center">
                                            <div class="text-[14px] text-gray-400">{{ t("暂无视频预览") }}</div>
                                        </div>
                                    </div>

                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 03 视频编辑 -->
                    <div
                        class="bg-[#141414] border border-[#333] rounded-xl overflow-hidden hover-glow-effect flex flex-col"
                        :class="{'flex-grow': !collapsed.videoEdit, 'section-processing': isProcessingVideo}">
                        <div
                            class="section-card-header flex items-center justify-between cursor-pointer transition-all duration-300 px-4 py-2.5"
                            :class="{'border-b border-[#333]': !collapsed.videoEdit}"
                            role="button" tabindex="0" :aria-expanded="!collapsed.videoEdit" @keydown.enter.prevent="collapsed.videoEdit = !collapsed.videoEdit" @keydown.space.prevent="collapsed.videoEdit = !collapsed.videoEdit" @click="collapsed.videoEdit = !collapsed.videoEdit">
                            <div class="flex items-center gap-3">
                                <div
                                    class="relative w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden"
                                    style="background: linear-gradient(135deg, #0ea5e9, #6366f1);">
                                    <div class="absolute inset-0 opacity-30"
                                         style="background: radial-gradient(circle at 30% 20%, rgba(255,255,255,0.5), transparent 60%);"></div>
                                    <span class="relative text-[15px] font-black text-white tracking-widest">03</span>
                                </div>
                                <div class="flex flex-col">
                                    <h3 class="text-[15px] font-bold tracking-wider bg-gradient-to-r from-sky-300 via-blue-300 to-indigo-400 bg-clip-text text-transparent">
                                        {{ t("视频编辑") }}</h3>
                                    <span class="text-[10px] font-medium text-slate-500 tracking-wider mt-0.5">EDIT & FINISH</span>
                                </div>
                            </div>
                            <div class="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-300"
                                 :class="!collapsed.videoEdit ? 'bg-cyan-500/15 rotate-180' : 'bg-white/[0.04]'">
                                <svg class="w-4 h-4 transition-transform"
                                     :class="!collapsed.videoEdit ? 'text-cyan-400' : 'text-slate-500'" fill="none"
                                     stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                          d="M19 9l-7 7-7-7"/>
                                </svg>
                            </div>
                        </div>

                        <div v-show="!collapsed.videoEdit" class="p-3 space-y-2.5">
                            <div class="flex gap-4">
                                <a-checkbox v-model="enableMixCut">{{ t("启用画中画") }}</a-checkbox>
                                <a-checkbox v-model="enableSilenceRemoval">{{ t("自动剪气口") }}</a-checkbox>
                                <a-checkbox v-model="enableGreenScreen">{{ t("启动绿幕背景") }}</a-checkbox>
                            </div>
                            <div v-if="enableMixCut" class="flex items-start gap-1.5 text-[12px] text-amber-400 mt-1">
                                <icon-exclamation-circle-fill class="text-[14px] flex-shrink-0 mt-0.5"/>
                                <span>画中画需用心构图设计，搭配不当易杂乱，拉低整体质感</span>
                            </div>
                            <div v-if="enableGreenScreen"
                                 class="flex items-start gap-1.5 text-[12px] text-amber-400 mt-1">
                                <icon-exclamation-circle-fill class="text-[14px] flex-shrink-0 mt-0.5"/>
                                <span>绿幕拍摄需光线均匀纯色干净，否则抠像粗糙影响成片质感</span>
                            </div>

                            <!-- 绿幕替换图片上传 - 只在勾选启动绿幕切换时显示 -->
                            <a-button
                                v-if="enableMixCut"
                                size="small"
                                type="outline"
                                block
                                @click="openMixCutMaterialDialog"
                            >
                                {{ t("画中画设置") }}
                            </a-button>
                            <div v-if="enableGreenScreen"
                                 class="space-y-3 p-2 rounded bg-white/5 border border-white/5">
                                <div class="text-[14px] text-gray-400 mb-1.5">{{ t("上传替换图片") }}</div>
                                <WebFileSelectButton accept="image/*" @select-file="handleGreenScreenImageSelect">
                                    <template #default>
                                        <a-button type="outline" block size="small">
                                            <template #icon>
                                                <icon-upload/>
                                            </template>
                                            {{ greenScreenImagePath ? t("重新选择图片") : t("上传替换图片") }}
                                        </a-button>
                                    </template>
                                </WebFileSelectButton>
                                <div v-if="greenScreenImagePath" class="text-[14px] text-gray-500 truncate">
                                    {{ greenScreenImagePath.split(/[/\\]/).pop() }}
                                </div>
                            </div>

                            <div class="flex justify-end">
                                <a-button
                                    type="primary"
                                    size="small"
                                    style="min-width: 120px;"
                                    :loading="isProcessingVideo"
                                    @click="autoProcessVideo"
                                    :disabled="!videoPreviewUrl"
                                >
                                    {{ isProcessingVideo ? t("处理中...") : t("自动处理") }}
                                </a-button>
                            </div>

                            <div v-if="processedVideoUrl" class="mt-2">
                                <div class="text-[14px] text-gray-400 mb-1.5">{{ t("处理后视频") }}</div>
                                <div class="aspect-video bg-black rounded overflow-hidden">
                                    <VideoPlayer :key="processedVideoUrl" :url="'file://' + processedVideoUrl"/>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 第3列：04标题生成 + 05字幕和音乐 -->
                <!-- 🔧 【调整】使用flex布局让列内容底部对齐 -->
                <div class="flex flex-col gap-1.5">
                    <!-- 04 标题标签关键词生成 -->
                    <div class="bg-[#141414] border border-[#333] rounded-xl overflow-hidden hover-glow-effect"
                         :class="{'section-processing': isGeneratingTitleTags}">
                        <div
                            class="section-card-header flex items-center justify-between cursor-pointer transition-all duration-300 px-4 py-2.5"
                            :class="{'border-b border-[#333]': !collapsed.titleTags}"
                            role="button" tabindex="0" :aria-expanded="!collapsed.titleTags" @keydown.enter.prevent="collapsed.titleTags = !collapsed.titleTags" @keydown.space.prevent="collapsed.titleTags = !collapsed.titleTags" @click="collapsed.titleTags = !collapsed.titleTags">
                            <div class="flex items-center gap-3">
                                <div
                                    class="relative w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden"
                                    style="background: linear-gradient(135deg, #f59e0b, #f97316);">
                                    <div class="absolute inset-0 opacity-30"
                                         style="background: radial-gradient(circle at 30% 20%, rgba(255,255,255,0.5), transparent 60%);"></div>
                                    <span class="relative text-[15px] font-black text-white tracking-widest">04</span>
                                </div>
                                <div class="flex flex-col">
                                    <h3 class="text-[15px] font-bold tracking-wider bg-gradient-to-r from-amber-300 via-orange-300 to-yellow-400 bg-clip-text text-transparent">
                                        {{ t("标题标签设置") }}</h3>
                                    <span class="text-[10px] font-medium text-slate-500 tracking-wider mt-0.5">TITLE & TAG PLANNING</span>
                                </div>
                            </div>
                            <div class="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-300"
                                 :class="!collapsed.titleTags ? 'bg-teal-500/15 rotate-180' : 'bg-white/[0.04]'">
                                <svg class="w-4 h-4 transition-transform"
                                     :class="!collapsed.titleTags ? 'text-teal-400' : 'text-slate-500'" fill="none"
                                     stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                          d="M19 9l-7 7-7-7"/>
                                </svg>
                            </div>
                        </div>

                        <div v-show="!collapsed.titleTags" class="p-3 space-y-3">
                            <div class="flex gap-2">
                                <a-button size="small" class="flex-1" @click="openSubtitleTemplateSettings">
                                    {{ t("字幕设置") }}
                                </a-button>
                                <a-button type="primary" size="small" class="flex-1" :loading="isGeneratingTitleTags"
                                          @click="generateTitleTags">
                                    {{ isGeneratingTitleTags ? t("生成中...") : t("生成标题标签关键词") }}
                                </a-button>
                            </div>

                            <!-- 生成的标题 -->
                            <div>
                                <div class="text-[14px] mb-1.5 flex items-center gap-1.5">
                                    <span style="color: var(--theme-text-primary); font-weight: 600;">{{
                                            t("生成的标题")
                                        }}</span>
                                    <span class="text-[13px] text-gray-500 font-normal">（{{ t("可编辑") }}）</span>
                                </div>
                                <a-textarea v-model="generatedTitle" :placeholder="t('标题将显示在这里...')" :rows="2"
                                            size="small" class="dark-input-override"/>
                            </div>

                            <!-- 生成的标签 -->
                            <div>
                                <div class="text-[14px] mb-1.5 flex items-center gap-1.5">
                                    <span style="color: var(--theme-text-primary); font-weight: 600;">{{
                                            t("生成的标签")
                                        }}</span>
                                    <span class="text-[13px] text-gray-500 font-normal">（{{ t("可编辑") }}）</span>
                                </div>
                                <a-textarea v-model="generatedTags"
                                            :placeholder="t('标签将显示在这里，用英文逗号分隔...')" :rows="2"
                                            size="small" class="dark-input-override"/>
                            </div>

                            <!-- 生成的关键词 - 左侧分类选择 + 右侧内容框 -->
                            <div>
                                <div class="flex items-center justify-between mb-2 cursor-pointer"
                                     role="button" tabindex="0" :aria-expanded="!collapsed.generatedKeywords" @keydown.enter.prevent="collapsed.generatedKeywords = !collapsed.generatedKeywords" @keydown.space.prevent="collapsed.generatedKeywords = !collapsed.generatedKeywords" @click="collapsed.generatedKeywords = !collapsed.generatedKeywords">
                                    <div class="flex items-center gap-1.5">
                                        <span style="color: var(--theme-text-primary); font-weight: 600;">{{
                                                t("生成的关键词")
                                            }}</span>
                                        <span class="text-[13px] text-gray-500 font-normal">（{{
                                                t("可在字幕模版里设置关键词规则")
                                            }}）</span>
                                    </div>
                                    <icon-down v-if="!collapsed.generatedKeywords"
                                               class="text-gray-400 transition-transform"/>
                                    <icon-up v-else class="text-gray-400 transition-transform"/>
                                </div>
                                <div v-show="!collapsed.generatedKeywords" class="flex gap-2">
                                    <!-- 左侧分类列表 -->
                                    <div class="flex flex-col gap-1 shrink-0">
                                        <div
                                            v-for="tab in keywordTabOptions"
                                            :key="tab.value"
                                            class="px-2 py-1.5 text-[13px] rounded cursor-pointer transition-colors whitespace-nowrap"
                                            :class="selectedKeywordTab === tab.value ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'"
                                            @click="selectedKeywordTab = tab.value"
                                        >{{ tab.label }}
                                        </div>
                                    </div>
                                    <!-- 右侧内容框 -->
                                    <div class="flex-1">
                                        <a-textarea
                                            :model-value="groupKeywordTexts[selectedKeywordTab] || ''"
                                            @update:model-value="(val) => { groupKeywordTexts[selectedKeywordTab] = val; updateGroupKeywords(selectedKeywordTab, val); }"
                                            :placeholder="`每行一个关键词...`"
                                            :auto-size="{ minRows: 3, maxRows: 15 }"
                                            :max-length="10000"
                                            allow-clear
                                            @change="handleGroupKeywordChange(selectedKeywordTab)"
                                            class="dark-input-override"
                                            style="font-family: 'Courier New', monospace; font-size: 13px; line-height: 1.5;"
                                        />
                                        <div class="flex items-center justify-between mt-1">
                                            <div class="text-[12px]" style="color: #94a3b8;">
                                                已添加 {{ getGroupKeywords(selectedKeywordTab).length }} 个关键词
                                            </div>
                                            <a-button size="mini" type="text" status="danger"
                                                      @click="clearCurrentKeywords">{{ t("一键清空") }}
                                            </a-button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 05 字幕和音乐 -->
                    <!--                    <div class="bg-[#141414] border border-[#333] rounded-xl overflow-hidden hover-glow-effect flex flex-col" :class="{'flex-grow': !collapsed.subtitleMusic, 'section-processing': isGeneratingSubtitle}">-->
                    <!--                        <div class="section-card-header flex items-center justify-between cursor-pointer transition-all duration-300 px-4 py-2.5" :class="{'border-b border-[#333]': !collapsed.subtitleMusic}" role="button" tabindex="0" :aria-expanded="!collapsed.subtitleMusic" @keydown.enter.prevent="collapsed.subtitleMusic = !collapsed.subtitleMusic" @keydown.space.prevent="collapsed.subtitleMusic = !collapsed.subtitleMusic" @click="collapsed.subtitleMusic = !collapsed.subtitleMusic">-->
                    <!--                            <div class="flex items-center gap-3">-->
                    <!--                                <div class="relative w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden" style="background: linear-gradient(135deg, #22c55e, #14b8a6);">-->
                    <!--                                    <div class="absolute inset-0 opacity-30" style="background: radial-gradient(circle at 30% 20%, rgba(255,255,255,0.5), transparent 60%);"></div>-->
                    <!--                                    <span class="relative text-[15px] font-black text-white tracking-widest">05</span>-->
                    <!--                                </div>-->
                    <!--                                <div class="flex flex-col">-->
                    <!--                                    <h3 class="text-[15px] font-bold tracking-wider bg-gradient-to-r from-emerald-300 via-lime-300 to-teal-400 bg-clip-text text-transparent">{{ t("字幕配乐编排") }}</h3>-->
                    <!--                                    <span class="text-[10px] font-medium text-slate-500 tracking-wider mt-0.5">SUBTITLE & SCORE</span>-->
                    <!--                                </div>-->
                    <!--                            </div>-->
                    <!--                            <div class="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-300" :class="!collapsed.subtitleMusic ? 'bg-emerald-500/15 rotate-180' : 'bg-white/[0.04]'">-->
                    <!--                                <svg class="w-4 h-4 transition-transform" :class="!collapsed.subtitleMusic ? 'text-emerald-400' : 'text-slate-500'" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>-->
                    <!--                            </div>-->
                    <!--                        </div>-->

                    <!--                        <div class="p-3 space-y-3">-->
                    <!--                            &lt;!&ndash; 字幕生成 &ndash;&gt;-->
                    <!--                            <div class="space-y-2">-->
                    <!--                                <div class="flex items-center gap-4">-->
                    <!--                                    <a-checkbox v-model="enableSubtitle" size="small">{{ t("自动生成字幕") }}</a-checkbox>-->
                    <!--                                    <a-checkbox v-model="enableSmartSubtitle" size="small">{{ t("启用智能字幕") }}</a-checkbox>-->
                    <!--                                </div>-->
                    <!--                                <div class="flex items-center gap-2">-->
                    <!--                                    <a-button size="small" type="outline" @click="openSubtitleTemplateSettings">-->
                    <!--                                        <template #icon>-->
                    <!--                                            <icon-settings />-->
                    <!--                                        </template>-->
                    <!--                                        {{ t("模板选择") }}-->
                    <!--                                    </a-button>-->
                    <!--                                    <div class="text-[13px] truncate" style="color: #94a3b8;">-->
                    <!--                                        {{ t("已选模板") }}: {{ currentSelectedTemplate?.name || t("未选择") }}-->
                    <!--                                    </div>-->
                    <!--                                </div>-->
                    <!--                            </div>-->

                    <!--                            &lt;!&ndash; 上传视频生成字幕（已隐藏） &ndash;&gt;-->
                    <!--                            <div v-show="false" class="border border-dashed border-[#444] rounded-lg p-3 bg-[#1a1a1a]">-->
                    <!--                                <div class="flex items-center justify-between">-->
                    <!--                                    <span class="text-[14px]" style="color: #94a3b8;">{{ t("上传视频生成字幕") }}</span>-->
                    <!--                                    <a-button-->
                    <!--                                        size="small"-->
                    <!--                                        type="outline"-->
                    <!--                                        @click="selectUploadVideoFile"-->
                    <!--                                    >-->
                    <!--                                        {{ t("选择视频") }}-->
                    <!--                                    </a-button>-->
                    <!--                                </div>-->
                    <!--                                <div v-if="uploadedVideoPath" class="mt-2">-->
                    <!--                                    <div class="flex items-center justify-between">-->
                    <!--                                        <div class="text-[14px] truncate flex-1 mr-2" style="color: #10b981;">-->
                    <!--                                            {{ uploadedVideoPath.split(/[/\\]/).pop() }}-->
                    <!--                                        </div>-->
                    <!--                                        <a-button-->
                    <!--                                            size="mini"-->
                    <!--                                            type="text"-->
                    <!--                                            status="danger"-->
                    <!--                                            @click="clearUploadedVideo"-->
                    <!--                                        >-->
                    <!--                                            {{ t("清除") }}-->
                    <!--                                        </a-button>-->
                    <!--                                    </div>-->
                    <!--                                    <div class="text-[14px] mt-1 truncate" style="color: #64748b;">-->
                    <!--                                        {{ uploadedVideoPath }}-->
                    <!--                                    </div>-->
                    <!--                                </div>-->
                    <!--                                <div v-else class="text-[14px] mt-2" style="color: #64748b;">-->
                    <!--                                    {{ t("支持 MP4、AVI、MOV、MKV 等格式") }}-->
                    <!--                                </div>-->
                    <!--                            </div>-->

                    <!--                            &lt;!&ndash; 背景音乐 &ndash;&gt;-->
                    <!--                            <div class="space-y-2">-->
                    <!--                                <a-checkbox v-model="enableBGM" size="small">{{ t("添加背景音乐") }}</a-checkbox>-->
                    <!--                                &lt;!&ndash; 音乐来源选择 &ndash;&gt;-->
                    <!--                                <div v-if="enableBGM" class="space-y-2">-->
                    <!--                                    <div class="flex items-center gap-2">-->
                    <!--                                        <a-radio-group v-model="bgmSourceType" size="small" type="button">-->
                    <!--                                            <a-radio value="local" @click="bgmCategorySelectVisible = false; selectBGMFile()">{{ t("选择本地音乐") }}</a-radio>-->
                    <!--                                            <a-radio value="system">{{ t("系统乐库") }}</a-radio>-->
                    <!--                                        </a-radio-group>-->
                    <!--                                        <span class="text-[13px]" style="color: #94a3b8;">{{ t("音量") }}</span>-->
                    <!--                                        <a-input-number-->
                    <!--                                            v-model="bgmVolume"-->
                    <!--                                            class="theme-compact-number"-->
                    <!--                                            size="small"-->
                    <!--                                            style="width: 70px"-->
                    <!--                                            :min="0"-->
                    <!--                                            :max="100"-->
                    <!--                                            :disabled="!enableBGM"-->
                    <!--                                            @focus="bgmCategorySelectVisible = false"-->
                    <!--                                        />-->
                    <!--                                        <span class="text-[13px]" style="color: #94a3b8;">%</span>-->
                    <!--                                    </div>-->

                    <!--                                    &lt;!&ndash; 本地音乐：点击直接打开文件选择 &ndash;&gt;-->

                    <!--                                    &lt;!&ndash; 系统乐库 &ndash;&gt;-->
                    <!--                                    <div v-if="bgmSourceType === 'system'" class="space-y-2">-->
                    <!--                                        <a-select-->
                    <!--                                            v-model="selectedBGMCategory"-->
                    <!--                                            v-model:popup-visible="bgmCategorySelectVisible"-->
                    <!--                                            :placeholder="t('选择分类')"-->
                    <!--                                            size="small"-->
                    <!--                                            class="w-full dark-input-override"-->
                    <!--                                        >-->
                    <!--                                            <a-option v-for="cat in bgmCategories" :key="cat.name" :value="cat.name">{{ cat.name }}</a-option>-->
                    <!--                                        </a-select>-->
                    <!--                                        <div v-if="selectedBGMCategory" class="max-h-[120px] overflow-y-auto rounded border border-[#333] bg-[#1a1a1a]">-->
                    <!--                                            <div-->
                    <!--                                                v-for="file in (bgmCategories.find(c => c.name === selectedBGMCategory)?.files || [])"-->
                    <!--                                                :key="file.path"-->
                    <!--                                                class="flex items-center justify-between px-2 py-1.5 text-[13px] cursor-pointer transition-colors"-->
                    <!--                                                :class="selectedBGMPath === file.path ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300 hover:bg-white/5'"-->
                    <!--                                                @click="selectSystemBGM(file.path); bgmCategorySelectVisible = false"-->
                    <!--                                            >-->
                    <!--                                                <span class="truncate flex-1">{{ file.name }}</span>-->
                    <!--                                                <icon-play-arrow v-if="selectedBGMPath !== file.path" class="text-gray-500 shrink-0 ml-1" />-->
                    <!--                                                <icon-check-circle-fill v-else class="text-blue-400 shrink-0 ml-1" />-->
                    <!--                                            </div>-->
                    <!--                                            <div v-if="!(bgmCategories.find(c => c.name === selectedBGMCategory)?.files?.length)" class="text-center py-3 text-gray-500 text-[13px]">-->
                    <!--                                                {{ t("该分类暂无音乐") }}-->
                    <!--                                            </div>-->
                    <!--                                        </div>-->
                    <!--                                    </div>-->

                    <!--                                    &lt;!&ndash; 已选音乐试听播放器 &ndash;&gt;-->
                    <!--                                    <AudioPlayer-->
                    <!--                                        ref="audioPlayerRef"-->
                    <!--                                        v-if="selectedBGMPath"-->
                    <!--                                        :key="selectedBGMPath"-->
                    <!--                                        :url="selectedBGMPath"-->
                    <!--                                        :file-name="selectedBGMPath.split(/[\\/]/).pop()"-->
                    <!--                                        @duration-change="bgmPreviewDuration = $event"-->
                    <!--                                    />-->
                    <!--                                </div>-->
                    <!--                            </div>-->

                    <!--                            &lt;!&ndash; 生成按钮 &ndash;&gt;-->
                    <!--                            <div class="flex justify-end pt-1">-->
                    <!--                                <a-button-->
                    <!--                                    type="primary"-->
                    <!--                                    size="small"-->
                    <!--                                    :loading="isGeneratingSubtitle"-->
                    <!--                                    @click="autoGenerateSubtitleAndBGM"-->
                    <!--                                    :disabled="!enableSubtitle && !enableBGM"-->
                    <!--                                >-->
                    <!--                                    {{ isGeneratingSubtitle ? t("处理中...") : t("自动生成字幕和BGM") }}-->
                    <!--                                </a-button>-->
                    <!--                            </div>-->

                    <!--                            &lt;!&ndash; 最终视频预览 &ndash;&gt;-->
                    <!--                            <div v-if="finalVideoUrl" class="pt-1">-->
                    <!--                                <div class="flex items-center justify-between mb-2">-->
                    <!--                                    <div class="text-[14px]" style="color: var(&#45;&#45;theme-text-primary);">{{ t("最终视频预览") }}</div>-->
                    <!--                                    &lt;!&ndash; 对比预览按钮 - 只在两个视频都存在时显示 &ndash;&gt;-->
                    <!--                                    <a-button-->
                    <!--                                        v-if="videoPreviewUrl && finalVideoUrl"-->
                    <!--                                        size="mini"-->
                    <!--                                        type="outline"-->
                    <!--                                        @click="showComparisonDialog = true"-->
                    <!--                                        class="comparison-toggle-btn"-->
                    <!--                                    >-->
                    <!--                                        <template #icon>-->
                    <!--                                            <icon-swap />-->
                    <!--                                        </template>-->
                    <!--                                        {{ t("对比预览") }}-->
                    <!--                                    </a-button>-->
                    <!--                                </div>-->

                    <!--                                &lt;!&ndash; 单视频显示 &ndash;&gt;-->
                    <!--                                <div class="aspect-video bg-black rounded overflow-hidden">-->
                    <!--                                    <VideoPlayer :key="finalVideoUrl" :url="finalVideoUrl" />-->
                    <!--                                </div>-->
                    <!--                            </div>-->
                    <!--                        </div>-->
                    <!--                    </div>-->
                    <div
                        class="bg-[#141414] border border-[#333] rounded-xl overflow-hidden hover-glow-effect flex flex-col"
                        :class="{'section-processing': isGeneratingSubtitle}">
                        <div
                            class="section-card-header flex items-center justify-between cursor-pointer transition-all duration-300 px-4 py-2.5"
                            :class="{'border-b border-[#333]': !collapsed.subtitleMusic}"
                            role="button" tabindex="0" :aria-expanded="!collapsed.subtitleMusic" @keydown.enter.prevent="collapsed.subtitleMusic = !collapsed.subtitleMusic" @keydown.space.prevent="collapsed.subtitleMusic = !collapsed.subtitleMusic" @click="collapsed.subtitleMusic = !collapsed.subtitleMusic">
                            <div class="flex items-center gap-3">
                                <div
                                    class="relative w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden"
                                    style="background: linear-gradient(135deg, #22c55e, #14b8a6);">
                                    <div class="absolute inset-0 opacity-30"
                                         style="background: radial-gradient(circle at 30% 20%, rgba(255,255,255,0.5), transparent 60%);"></div>
                                    <span class="relative text-[15px] font-black text-white tracking-widest">05</span>
                                </div>
                                <div class="flex flex-col">
                                    <h3 class="text-[15px] font-bold tracking-wider bg-gradient-to-r from-emerald-300 via-lime-300 to-teal-400 bg-clip-text text-transparent">
                                        {{ t("视频生成") }}</h3>
                                    <span class="text-[10px] font-medium text-slate-500 tracking-wider mt-0.5">SUBTITLE & SCORE</span>
                                </div>
                            </div>
                            <div class="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-300"
                                 :class="!collapsed.subtitleMusic ? 'bg-emerald-500/15 rotate-180' : 'bg-white/[0.04]'">
                                <svg class="w-4 h-4 transition-transform"
                                     :class="!collapsed.subtitleMusic ? 'text-emerald-400' : 'text-slate-500'"
                                     fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                          d="M19 9l-7 7-7-7"/>
                                </svg>
                            </div>
                        </div>

                        <div class="p-3 space-y-3">
                            <!-- 字幕生成 -->
                            <div class="space-y-2">
                                <div class="flex items-center gap-4">
                                    <a-checkbox v-model="enableSubtitle" size="small">{{
                                            t("自动生成字幕")
                                        }}
                                    </a-checkbox>
                                    <a-checkbox v-model="enableSmartSubtitle" size="small">{{
                                            t("启用智能字幕")
                                        }}
                                    </a-checkbox>
                                </div>
                                <div class="flex items-center gap-2">
                                    <a-button size="small" type="outline" @click="openSubtitleTemplateSettings">
                                        <template #icon>
                                            <icon-settings/>
                                        </template>
                                        {{ t("模板选择") }}
                                    </a-button>
                                    <div class="text-[13px] truncate" style="color: #94a3b8;">
                                        {{ t("已选模板") }}: {{ currentSelectedTemplate?.name || t("未选择") }}
                                    </div>
                                </div>
                            </div>

                            <!-- 上传视频生成字幕（已隐藏） -->
                            <div v-show="false" class="border border-dashed border-[#444] rounded-lg p-3 bg-[#1a1a1a]">
                                <div class="flex items-center justify-between">
                                    <span class="text-[14px]" style="color: #94a3b8;">{{ t("上传视频生成字幕") }}</span>
                                    <a-button
                                        size="small"
                                        type="outline"
                                        @click="selectUploadVideoFile"
                                    >
                                        {{ t("选择视频") }}
                                    </a-button>
                                </div>
                                <div v-if="uploadedVideoPath" class="mt-2">
                                    <div class="flex items-center justify-between">
                                        <div class="text-[14px] truncate flex-1 mr-2" style="color: #10b981;">
                                            {{ uploadedVideoPath.split(/[/\\]/).pop() }}
                                        </div>
                                        <a-button
                                            size="mini"
                                            type="text"
                                            status="danger"
                                            @click="clearUploadedVideo"
                                        >
                                            {{ t("清除") }}
                                        </a-button>
                                    </div>
                                    <div class="text-[14px] mt-1 truncate" style="color: #64748b;">
                                        {{ uploadedVideoPath }}
                                    </div>
                                </div>
                                <div v-else class="text-[14px] mt-2" style="color: #64748b;">
                                    {{ t("支持 MP4、AVI、MOV、MKV 等格式") }}
                                </div>
                            </div>

                            <!-- 背景音乐 -->
                            <div class="space-y-2">
                                <a-checkbox v-model="enableBGM" size="small">{{ t("添加背景音乐") }}</a-checkbox>
                                <!-- 音乐来源选择 -->
                                <div v-if="enableBGM" class="space-y-2">
                                    <div class="flex items-center gap-2">
                                        <a-radio-group v-model="bgmSourceType" size="small" type="button">
                                            <a-radio value="local"
                                                     @click="bgmCategorySelectVisible = false; selectBGMFile()">
                                                {{ t("选择本地音乐") }}
                                            </a-radio>
                                            <a-radio value="system">{{ t("系统乐库") }}</a-radio>
                                        </a-radio-group>
                                        <span class="text-[13px]" style="color: #94a3b8;">{{ t("音量") }}</span>
                                        <a-input-number
                                            v-model="bgmVolume"
                                            class="theme-compact-number"
                                            size="small"
                                            style="width: 70px"
                                            :min="0"
                                            :max="100"
                                            :disabled="!enableBGM"
                                            @focus="bgmCategorySelectVisible = false"
                                        />
                                        <span class="text-[13px]" style="color: #94a3b8;">%</span>
                                    </div>

                                    <!-- 本地音乐：点击直接打开文件选择 -->

                                    <!-- 系统乐库 -->
                                    <div v-if="bgmSourceType === 'system'" class="space-y-2">
                                        <a-select
                                            v-model="selectedBGMCategory"
                                            v-model:popup-visible="bgmCategorySelectVisible"
                                            :placeholder="t('选择分类')"
                                            size="small"
                                            class="w-full dark-input-override"
                                        >
                                            <a-option v-for="cat in bgmCategories" :key="cat.name" :value="cat.name">
                                                {{ cat.name }}
                                            </a-option>
                                        </a-select>
                                        <div v-if="selectedBGMCategory"
                                             class="max-h-[120px] overflow-y-auto rounded border border-[#333] bg-[#1a1a1a]">
                                            <div
                                                v-for="file in (bgmCategories.find(c => c.name === selectedBGMCategory)?.files || [])"
                                                :key="file.path"
                                                class="flex items-center justify-between px-2 py-1.5 text-[13px] cursor-pointer transition-colors"
                                                :class="selectedBGMPath === file.path ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300 hover:bg-white/5'"
                                                @click="selectSystemBGM(file.path); bgmCategorySelectVisible = false"
                                            >
                                                <span class="truncate flex-1">{{ file.name }}</span>
                                                <icon-play-arrow v-if="selectedBGMPath !== file.path"
                                                                 class="text-gray-500 shrink-0 ml-1"/>
                                                <icon-check-circle-fill v-else class="text-blue-400 shrink-0 ml-1"/>
                                            </div>
                                            <div
                                                v-if="!(bgmCategories.find(c => c.name === selectedBGMCategory)?.files?.length)"
                                                class="text-center py-3 text-gray-500 text-[13px]">
                                                {{ t("该分类暂无音乐") }}
                                            </div>
                                        </div>
                                    </div>

                                    <!-- 已选音乐试听播放器 -->
                                    <AudioPlayer
                                        ref="audioPlayerRef"
                                        v-if="selectedBGMPath"
                                        :key="selectedBGMPath"
                                        :url="selectedBGMPath"
                                        :file-name="selectedBGMPath.split(/[\\/]/).pop()"
                                        @duration-change="bgmPreviewDuration = $event"
                                    />
                                </div>
                            </div>

                            <!-- 生成按钮 -->
                            <div class="flex justify-end pt-1">
                                <a-button
                                    type="primary"
                                    size="small"
                                    :loading="isGeneratingSubtitle"
                                    @click="autoGenerateSubtitleAndBGM"
                                    :disabled="!enableSubtitle && !enableBGM"
                                >
                                    {{ isGeneratingSubtitle ? t("处理中...") : t("自动生成字幕和BGM") }}
                                </a-button>
                            </div>
                        </div>
                    </div>
                    <div class="bg-[#141414] border border-[#333] rounded-xl overflow-hidden hover-glow-effect"
                         :class="{'section-processing': isGeneratingCover}">
                        <div
                            class="section-card-header flex items-center justify-between cursor-pointer transition-all duration-300 px-4 py-2.5"
                            :class="{'border-b border-[#333]': !collapsed.coverMake}"
                            role="button" tabindex="0" :aria-expanded="!collapsed.coverMake" @keydown.enter.prevent="collapsed.coverMake = !collapsed.coverMake" @keydown.space.prevent="collapsed.coverMake = !collapsed.coverMake" @click="collapsed.coverMake = !collapsed.coverMake">
                            <div class="flex items-center gap-3">
                                <div
                                    class="relative w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden"
                                    style="background: linear-gradient(135deg, #ec4899, #8b5cf6);">
                                    <div class="absolute inset-0 opacity-30"
                                         style="background: radial-gradient(circle at 30% 20%, rgba(255,255,255,0.5), transparent 60%);"></div>
                                    <span class="relative text-[15px] font-black text-white tracking-widest">06</span>
                                </div>
                                <div class="flex flex-col">
                                    <h3 class="text-[15px] font-bold tracking-wider bg-gradient-to-r from-pink-300 via-fuchsia-300 to-violet-400 bg-clip-text text-transparent">
                                        {{ t("封面视觉设计") }}</h3>
                                    <span class="text-[10px] font-medium text-slate-500 tracking-wider mt-0.5">COVER DESIGN</span>
                                </div>
                            </div>
                            <div class="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-300"
                                 :class="!collapsed.coverMake ? 'bg-indigo-500/15 rotate-180' : 'bg-white/[0.04]'">
                                <svg class="w-4 h-4 transition-transform"
                                     :class="!collapsed.coverMake ? 'text-indigo-400' : 'text-slate-500'" fill="none"
                                     stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                          d="M19 9l-7 7-7-7"/>
                                </svg>
                            </div>
                        </div>

                        <div class="p-3 space-y-3">
                            <div class="flex gap-2">
                                <a-button
                                    type="primary"
                                    size="small"
                                    class="flex-1"
                                    :loading="isGeneratingCover"
                                    @click="generateCover"
                                >
                                    {{ isGeneratingCover ? t("生成中...") : t("自动生成封面") }}
                                </a-button>
                                <a-button
                                    size="small"
                                    class="flex-1"
                                    @click="showCoverSettingsDialog = true"
                                >
                                    <template #icon>
                                        <icon-settings/>
                                    </template>
                                    {{ t("封面设置") }}
                                </a-button>
                            </div>
                            <div v-if="coverConfig.templateId" class="text-[14px] text-blue-400">
                                {{ t("已选模板") }}: {{ coverTemplateName }}
                            </div>

                            <!-- 封面预览 -->
                            <div>
                                <div class="flex items-center justify-between mb-2">
                                    <div class="text-[14px]" style="color: var(--theme-text-primary);">{{
                                            t("封面预览")
                                        }}
                                    </div>
                                    <a-button v-if="coverPreviewUrl" type="text" size="mini"
                                              @click="openFileLocation(coverPreviewUrl)"
                                              class="text-slate-400 hover:text-white">
                                        <template #icon>
                                            <icon-folder/>
                                        </template>
                                        {{ t("打开位置") }}
                                    </a-button>
                                </div>
                                <div v-if="coverPreviewUrl"
                                     class="aspect-video bg-black rounded overflow-hidden cursor-pointer relative group"
                                     @dblclick="showCoverImageDialog = true">
                                    <img
                                        :src="coverPreviewUrl.startsWith('file://') ? coverPreviewUrl : 'file://' + coverPreviewUrl"
                                        :alt="t('封面预览')"
                                        class="w-full h-full object-contain"/>
                                    <!-- 双击提示 -->
                                    <div
                                        class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all duration-200 flex items-center justify-center opacity-0 group-hover:opacity-100">
                                        <span class="text-white text-[14px] bg-black bg-opacity-50 px-2 py-1 rounded">{{
                                                t("双击查看大图")
                                            }}</span>
                                    </div>
                                </div>
                                <div v-else class="aspect-video bg-gray-100 rounded flex items-center justify-center">
                                    <span class="text-[14px]" style="color: #64748b;">{{ t("暂无封面预览") }}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 第4列：06封面制作 + 07视频发布 -->
                <!-- 🔧 【调整】使用flex布局让列内容底部对齐 -->
                <div class="flex flex-col gap-1.5">
                    <!-- 工具按钮区 -->
                    <div v-if="false" class="border rounded-xl p-3"
                         :class="isLightTheme ? 'bg-white border-gray-200' : 'bg-[#141414] border-[#333]'">
                        <div class="flex flex-col gap-2">
                            <!-- 🔥 科技感任务控制面板 -->
                            <div class="flex flex-col gap-2.5">
                                <!-- 主操作按钮区 -->
                                <div class="grid grid-cols-2 gap-2">
                                    <button
                                        @click="startOneClickIntelligence"
                                        class="group relative flex items-center justify-center gap-2 h-9 rounded-xl font-bold text-[13px] transition-all duration-300 cursor-pointer bg-transparent border-0 hover:scale-[1.04]"
                                        :disabled="isOneClickRunning">
                                        <!-- 渐变旋转边框 -->
                                        <div
                                            class="absolute inset-0 rounded-xl p-[1.5px] animate-border-spin transition-all duration-300 group-hover:p-[2px]"
                                            style="-webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask-composite: exclude; --border-angle: 0deg; background: conic-gradient(from var(--border-angle), #0f766e, #0891b2, #06b6d4, #0f766e);"></div>
                                        <!-- hover发光层 -->
                                        <div
                                            class="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                                            style="box-shadow: 0 0 18px rgba(8,145,178,0.38), 0 0 30px rgba(6,182,212,0.22);"></div>
                                        <!-- hover背景微光 -->
                                        <div
                                            class="absolute inset-[1.5px] rounded-[10px] bg-cyan-500/0 group-hover:bg-cyan-500/10 transition-colors duration-300"></div>
                                        <!-- 运行时内填充 -->
                                        <div v-if="isOneClickRunning"
                                             class="absolute inset-[1.5px] rounded-[10px] bg-cyan-500/20"></div>
                                        <!-- 运行光条 -->
                                        <div v-if="isOneClickRunning"
                                             class="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shimmer rounded-xl"></div>
                                        <svg v-if="!isOneClickRunning" class="w-5 h-5 relative z-10 text-cyan-400"
                                             fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                                  d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                                        </svg>
                                        <svg v-else class="w-4 h-4 animate-spin relative z-10 text-cyan-300" fill="none"
                                             viewBox="0 0 24 24">
                                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor"
                                                    stroke-width="4"></circle>
                                            <path class="opacity-75" fill="currentColor"
                                                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        <span
                                            class="relative z-10 bg-gradient-to-r from-teal-300 via-cyan-300 to-sky-300 bg-clip-text text-transparent">{{
                                                isOneClickRunning ? t('运行中...') : t('自动模式')
                                            }}</span>
                                    </button>
                                    <button
                                        @click="openSettingsDialog"
                                        class="relative overflow-hidden flex items-center justify-center gap-2 h-9 rounded-xl font-bold text-[13px] transition-all duration-300 border-0 cursor-pointer"
                                        :class="isLightTheme
                                ? 'bg-gradient-to-r from-teal-600 to-cyan-500 text-white shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/35 hover:scale-[1.02]'
                                : 'bg-gradient-to-r from-teal-600 to-cyan-500 text-white shadow-[0_0_15px_rgba(8,145,178,0.35)] hover:shadow-[0_0_25px_rgba(6,182,212,0.5)] hover:scale-[1.02]'">
                                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                                        </svg>
                                        {{ t("智能体配置") }}
                                    </button>
                                </div>

                                <!-- 辅助操作区 -->
                                <div class="grid grid-cols-2 gap-2">
                                    <button
                                        @click="stopAllTasks"
                                        class="flex items-center justify-center gap-2 h-9 rounded-xl font-semibold text-[13px] transition-all duration-300 cursor-pointer"
                                        :class="hasRunningTasks
                                ? (isLightTheme
                                    ? 'text-rose-500 bg-rose-50 border border-rose-200 hover:bg-rose-100'
                                    : 'text-rose-400 bg-rose-500/10 border border-rose-500/25 hover:bg-rose-500/20')
                                : (isLightTheme
                                    ? 'text-gray-400 bg-gray-50 border border-gray-200 hover:text-gray-600 hover:bg-gray-100'
                                    : 'text-slate-500 bg-white/[0.03] border border-white/[0.06] hover:text-slate-300 hover:bg-white/[0.06]')">
                                        <svg class="w-5 h-5" :class="hasRunningTasks ? 'animate-stop-icon' : ''"
                                             fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                                  d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                                  d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"></path>
                                        </svg>
                                        {{ t("停止任务") }}
                                    </button>
                                    <button
                                        @click="resetAllUserData"
                                        class="flex items-center justify-center gap-2 h-9 rounded-xl font-semibold text-[13px] transition-all duration-300 cursor-pointer"
                                        :class="isLightTheme
                                ? 'text-gray-400 bg-gray-50 border border-gray-200 hover:text-rose-500 hover:bg-rose-50 hover:border-rose-200'
                                : 'text-slate-500 bg-white/[0.03] border border-white/[0.06] hover:text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/20'">
                                        <icon-delete class="w-5 h-5"/>
                                        {{ t("清除数据") }}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <!-- 最终视频预览 -->
                    <div
                        class="bg-[#141414] border border-[#333] rounded-xl overflow-hidden hover-glow-effect flex flex-col"
                        :class="{'section-processing': isGeneratingSubtitle}">
                        <div class="pt-1">
                            <div class="flex items-center justify-between mb-2">
                                <div class="text-[14px]" style="color: var(--theme-text-primary);">
                                    {{ '　' + t("最终视频预览") }}
                                </div>
                                <!-- 对比预览按钮 - 只在两个视频都存在时显示 -->
                                <a-button
                                    v-if="videoPreviewUrl && finalVideoUrl"
                                    size="mini"
                                    type="outline"
                                    @click="showComparisonDialog = true"
                                    class="comparison-toggle-btn"
                                >
                                    <template #icon>
                                        <icon-swap/>
                                    </template>
                                    {{ t("对比预览") }}
                                </a-button>
                            </div>

                            <!-- 单视频显示 -->
                            <div class="aspect-video bg-black rounded">
                                <VideoPlayer v-if="finalVideoUrl||finalVideoUrl.value" :key="finalVideoUrl" :url="finalVideoUrl"
                                             style="height: 679px"/>
                                <div
                                    v-else
                                    class="bg-gray-100 rounded flex items-center justify-center bg-[#23272d]"
                                    style="min-height: 681px;"
                                ><span class="text-[14px] text-gray-400">{{ t("暂无视频预览") }}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    <!-- 07 视频发布 -->
                    <div
                        class="bg-[#141414] border border-[#333] rounded-xl overflow-hidden hover-glow-effect flex flex-col"
                        :class="{'flex-grow': !collapsed.videoPublish, 'section-processing': isPublishing}">
                        <div
                            class="section-card-header flex items-center justify-between px-4 py-2.5 border-b border-[#333]">
                            <div class="flex items-center gap-3">
                                <div
                                    class="relative w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden"
                                    style="background: linear-gradient(135deg, #8b5cf6, #3b82f6);">
                                    <div class="absolute inset-0 opacity-30"
                                         style="background: radial-gradient(circle at 30% 20%, rgba(255,255,255,0.5), transparent 60%);"></div>
                                    <span class="relative text-[15px] font-black text-white tracking-widest">07</span>
                                </div>
                                <div class="flex flex-col">
                                    <h3 class="text-[15px] font-bold tracking-wider bg-gradient-to-r from-violet-300 via-indigo-300 to-sky-400 bg-clip-text text-transparent">
                                        视频发布</h3>
                                    <span class="text-[10px] font-medium text-slate-500 tracking-wider mt-0.5">PUBLISH CENTER</span>
                                </div>
                            </div>
                            <!-- 🔧 账号管理按钮 -->
                            <div class="flex items-center gap-1.5">
                                <a-button
                                    type="text"
                                    size="mini"
                                    class="text-gray-400 hover:text-blue-400"
                                    @click.stop="showAccountManager = true"
                                >
                                    <template #icon>
                                        <icon-user-group/>
                                    </template>
                                    {{ t("账号管理") }}
                                </a-button>
                            </div>
                        </div>

                        <div class="p-3 space-y-2.5">
                            <!-- 平台卡片列表 -->
                            <div class="grid grid-cols-2 gap-2">
                                <!-- 抖音 -->
                                <div
                                    class="publish-platform-card group relative overflow-hidden rounded-xl p-3 border transition-all duration-300 hover:scale-[1.02]"
                                    :class="publishPlatforms.douyin.checked ? 'border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 to-teal-500/5' : 'border-[#2a2a2a] bg-[#1a1a1a] hover:border-cyan-500/30'"
                                    @click="publishPlatforms.douyin.checked = !publishPlatforms.douyin.checked">
                                    <div class="flex items-center gap-2.5 mb-2">
                                        <div class="w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden"
                                             style="background: #000000;">
                                            <img src="@/assets/image/outvideo/douyin.png"
                                                 class="w-full h-full object-contain" alt="抖音"/>
                                        </div>
                                        <div class="flex-1 min-w-0">
                                            <div class="text-[13px] font-bold text-white leading-tight">抖音</div>
                                            <div class="text-[10px] text-slate-500 mt-0.5">DOUYIN</div>
                                        </div>
                                        <!-- 选中指示器 -->
                                        <div
                                            class="w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-300"
                                            :class="publishPlatforms.douyin.checked ? 'border-cyan-500 bg-cyan-500' : 'border-slate-600 bg-transparent'">
                                            <svg v-if="publishPlatforms.douyin.checked" class="w-3 h-3 text-white"
                                                 fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3"
                                                      d="M5 13l4 4L19 7"/>
                                            </svg>
                                        </div>
                                    </div>
                                    <a-select
                                        v-model="publishPlatforms.douyin.selectedAccountId"
                                        :placeholder="t('选择账号')"
                                        size="mini"
                                        allow-clear
                                        class="w-full"
                                        style="--color-primary: #ec4899;"
                                        @click.stop
                                        @change="(val) => { publishPlatforms.douyin.checked = !!val; }"
                                    >
                                        <a-option v-for="acc in publishPlatforms.douyin.accounts" :key="acc.id"
                                                  :value="acc.id">
                                            <div class="flex items-center gap-1.5">
                                                <span class="text-[13px]">{{ acc.nickname || '未命名' }}</span>
                                                <span v-if="acc.loginStatus === 'active'"
                                                      class="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0"></span>
                                                <span v-else
                                                      class="w-1.5 h-1.5 rounded-full bg-slate-600 flex-shrink-0"></span>
                                            </div>
                                        </a-option>
                                    </a-select>
                                </div>

                                <!-- 快手 -->
                                <div
                                    class="publish-platform-card group relative overflow-hidden rounded-xl p-3 border transition-all duration-300 hover:scale-[1.02]"
                                    :class="publishPlatforms.kuaishou.checked ? 'border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 to-teal-500/5' : 'border-[#2a2a2a] bg-[#1a1a1a] hover:border-cyan-500/30'"
                                    @click="publishPlatforms.kuaishou.checked = !publishPlatforms.kuaishou.checked">
                                    <div class="flex items-center gap-2.5 mb-2">
                                        <div class="w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden"
                                             style="background: #FF6900;">
                                            <img src="@/assets/image/outvideo/kuaishou.png"
                                                 class="w-full h-full object-contain" alt="快手"/>
                                        </div>
                                        <div class="flex-1 min-w-0">
                                            <div class="text-[13px] font-bold text-white leading-tight">快手</div>
                                            <div class="text-[10px] text-slate-500 mt-0.5">KUAISHOU</div>
                                        </div>
                                        <div
                                            class="w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-300"
                                            :class="publishPlatforms.kuaishou.checked ? 'border-cyan-500 bg-cyan-500' : 'border-slate-600 bg-transparent'">
                                            <svg v-if="publishPlatforms.kuaishou.checked" class="w-3 h-3 text-white"
                                                 fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3"
                                                      d="M5 13l4 4L19 7"/>
                                            </svg>
                                        </div>
                                    </div>
                                    <a-select
                                        v-model="publishPlatforms.kuaishou.selectedAccountId"
                                        :placeholder="t('选择账号')"
                                        size="mini"
                                        allow-clear
                                        class="w-full"
                                        style="--color-primary: #f59e0b;"
                                        @click.stop
                                        @change="(val) => { publishPlatforms.kuaishou.checked = !!val; }"
                                    >
                                        <a-option v-for="acc in publishPlatforms.kuaishou.accounts" :key="acc.id"
                                                  :value="acc.id">
                                            <div class="flex items-center gap-1.5">
                                                <span class="text-[13px]">{{ acc.nickname || '未命名' }}</span>
                                                <span v-if="acc.loginStatus === 'active'"
                                                      class="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0"></span>
                                                <span v-else
                                                      class="w-1.5 h-1.5 rounded-full bg-slate-600 flex-shrink-0"></span>
                                            </div>
                                        </a-option>
                                    </a-select>
                                </div>

                                <!-- 视频号 -->
                                <div
                                    class="publish-platform-card group relative overflow-hidden rounded-xl p-3 border transition-all duration-300 hover:scale-[1.02]"
                                    :class="publishPlatforms.shipin.checked ? 'border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 to-teal-500/5' : 'border-[#2a2a2a] bg-[#1a1a1a] hover:border-cyan-500/30'"
                                    @click="publishPlatforms.shipin.checked = !publishPlatforms.shipin.checked">
                                    <div class="flex items-center gap-2.5 mb-2">
                                        <div class="w-8 h-8 flex items-center justify-center">
                                            <img src="@/assets/image/outvideo/shipin.png"
                                                 class="w-full h-full object-contain" alt="视频号"/>
                                        </div>
                                        <div class="flex-1 min-w-0">
                                            <div class="text-[13px] font-bold text-white leading-tight">视频号</div>
                                            <div class="text-[10px] text-slate-500 mt-0.5">CHANNEL</div>
                                        </div>
                                        <div
                                            class="w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-300"
                                            :class="publishPlatforms.shipin.checked ? 'border-cyan-500 bg-cyan-500' : 'border-slate-600 bg-transparent'">
                                            <svg v-if="publishPlatforms.shipin.checked" class="w-3 h-3 text-white"
                                                 fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3"
                                                      d="M5 13l4 4L19 7"/>
                                            </svg>
                                        </div>
                                    </div>
                                    <a-select
                                        v-model="publishPlatforms.shipin.selectedAccountId"
                                        :placeholder="t('选择账号')"
                                        size="mini"
                                        allow-clear
                                        class="w-full"
                                        style="--color-primary: #10b981;"
                                        @click.stop
                                        @change="(val) => { publishPlatforms.shipin.checked = !!val; }"
                                    >
                                        <a-option v-for="acc in publishPlatforms.shipin.accounts" :key="acc.id"
                                                  :value="acc.id">
                                            <div class="flex items-center gap-1.5">
                                                <span class="text-[13px]">{{ acc.nickname || '未命名' }}</span>
                                                <span v-if="acc.loginStatus === 'active'"
                                                      class="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0"></span>
                                                <span v-else
                                                      class="w-1.5 h-1.5 rounded-full bg-slate-600 flex-shrink-0"></span>
                                            </div>
                                        </a-option>
                                    </a-select>
                                </div>

                                <!-- 小红书 -->
                                <div
                                    class="publish-platform-card group relative overflow-hidden rounded-xl p-3 border transition-all duration-300 hover:scale-[1.02]"
                                    :class="publishPlatforms.xiaohongshu.checked ? 'border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 to-teal-500/5' : 'border-[#2a2a2a] bg-[#1a1a1a] hover:border-cyan-500/30'"
                                    @click="publishPlatforms.xiaohongshu.checked = !publishPlatforms.xiaohongshu.checked">
                                    <div class="flex items-center gap-2.5 mb-2">
                                        <div class="w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden"
                                             style="background: #FF2442;">
                                            <img src="@/assets/image/outvideo/xiaohongshu.png"
                                                 class="w-full h-full object-contain" alt="小红书"/>
                                        </div>
                                        <div class="flex-1 min-w-0">
                                            <div class="text-[13px] font-bold text-white leading-tight">小红书</div>
                                            <div class="text-[10px] text-slate-500 mt-0.5">XIAOHONGSHU</div>
                                        </div>
                                        <div
                                            class="w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-300"
                                            :class="publishPlatforms.xiaohongshu.checked ? 'border-cyan-500 bg-cyan-500' : 'border-slate-600 bg-transparent'">
                                            <svg v-if="publishPlatforms.xiaohongshu.checked" class="w-3 h-3 text-white"
                                                 fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3"
                                                      d="M5 13l4 4L19 7"/>
                                            </svg>
                                        </div>
                                    </div>
                                    <a-select
                                        v-model="publishPlatforms.xiaohongshu.selectedAccountId"
                                        :placeholder="t('选择账号')"
                                        size="mini"
                                        allow-clear
                                        class="w-full"
                                        style="--color-primary: #f43f5e;"
                                        @click.stop
                                        @change="(val) => { publishPlatforms.xiaohongshu.checked = !!val; }"
                                    >
                                        <a-option v-for="acc in publishPlatforms.xiaohongshu.accounts" :key="acc.id"
                                                  :value="acc.id">
                                            <div class="flex items-center gap-1.5">
                                                <span class="text-[13px]">{{ acc.nickname || '未命名' }}</span>
                                                <span v-if="acc.loginStatus === 'active'"
                                                      class="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0"></span>
                                                <span v-else
                                                      class="w-1.5 h-1.5 rounded-full bg-slate-600 flex-shrink-0"></span>
                                            </div>
                                        </a-option>
                                    </a-select>
                                </div>
                            </div>

                            <!-- 发布进度 -->
                            <div v-if="publishProgress" class="text-[14px] text-blue-400 p-2 elegant-tip-box rounded">
                                {{ publishProgress }}
                            </div>

                            <!-- 发布结果 -->
                            <div v-if="publishResults.length > 0" class="space-y-1 max-h-32 overflow-y-auto">
                                <div v-for="(result, index) in publishResults" :key="`${result.platform}-${index}`"
                                     class="text-[14px] p-2 rounded"
                                     :class="result.status === 'success'
                                     ? 'bg-green-900/30 text-green-400 border border-green-800'
                                     : ((result.pending || result.status === 'verification_required' || result.status === 'manual_pending')
                                         ? 'bg-amber-900/30 text-amber-300 border border-amber-700'
                                         : 'bg-red-900/30 text-red-400 border border-red-800')">
                                    <div class="font-medium">{{ result.platform }}</div>
                                    <div>{{ result.message }}</div>
                                    <div v-if="result.videoUrl" class="text-blue-400 truncate">{{
                                            result.videoUrl
                                        }}
                                    </div>
                                </div>
                            </div>

                            <!-- 发布 & 定时发布 -->
                            <div class="mt-3 flex gap-2">
                                <button
                                    class="publish-btn publish-btn-now"
                                    :disabled="isPublishing"
                                    @click="publishVideo({ autoPublish: true })"
                                >
                                    <svg v-if="!isPublishing" class="btn-icon" viewBox="0 0 24 24" fill="none"
                                         stroke="currentColor" stroke-width="2">
                                        <path d="M22 2L11 13"/>
                                        <path d="M22 2L15 22L11 13L2 9L22 2Z"/>
                                    </svg>
                                    <svg v-else class="btn-icon animate-spin" viewBox="0 0 24 24" fill="none"
                                         stroke="currentColor" stroke-width="2">
                                        <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
                                        <path d="M12 2a10 10 0 0 1 10 10"/>
                                    </svg>
                                    <span>{{ isPublishing ? t("发布中...") : t("立即发布") }}</span>
                                </button>
                                <button
                                    class="publish-btn publish-btn-schedule"
                                    :class="{ 'is-cancel': isScheduledPublishing }"
                                    @click="isScheduledPublishing ? cancelScheduledPublish() : (showSchedulePanel = true)"
                                >
                                    <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                         stroke-width="2">
                                        <circle cx="12" cy="12" r="10"/>
                                        <polyline points="12 6 12 12 16 14"/>
                                    </svg>
                                    <span v-if="isScheduledPublishing">{{ t("取消定时") }}</span>
                                    <span v-else>{{ t("定时发布") }}</span>
                                </button>
                            </div>

                            <!-- 定时发布弹窗 -->
                            <a-modal
                                v-model:visible="showSchedulePanel"
                                :title="t('定时发布')"
                                :ok-text="t('确认发布')"
                                :cancel-text="t('取消')"
                                :ok-button-props="{ disabled: !scheduledPublishTime }"
                                @ok="schedulePublish(); showSchedulePanel = false;"
                                @cancel="showSchedulePanel = false"
                                width="400px"
                            >
                                <div class="py-4">
                                    <a-date-picker
                                        v-model="scheduledPublishTime"
                                        show-time
                                        format="YYYY-MM-DD HH:mm:ss"
                                        :placeholder="t('选择发布时间')"
                                        style="width: 100%;"
                                    />
                                </div>
                            </a-modal>

                            <!-- 首次运行提示 -->
                            <div class="text-[14px] text-gray-400 mt-2 text-center leading-relaxed opacity-80">
                                {{
                                    t("首次发布：请手动关闭浏览器内出现的任何弹窗提示（说明等），防止干扰脚本，下次即可流畅运行")
                                }}
                            </div>
                        </div>
                    </div>


                </div>
            </div>
        </div>

        <!-- 添加IP大脑弹窗 -->
        <a-modal
            v-model:visible="showAddIPDialog"
            :title="t('添加IP大脑')"
            @ok="startAutoScrape"
            @cancel="showAddIPDialog = false"
            :ok-text="t('开始采集')"
            :cancel-text="t('取消')"
            :ok-loading="isAnalyzing"
            width="600px"
        >
            <div class="space-y-4">
                <div>
                    <label class="block mb-2 font-medium">{{ t("账号主页或分享链接") }}</label>
                    <a-input
                        v-model="douyinUrl"
                        :placeholder="t('请输入抖音账号主页或用户分享链接，例如：https://www.douyin.com/user/...')"
                        size="large"
                    />
                    <div class="text-[14px] text-gray-500 mt-2">
                        {{
                            t("当前 IP 学习支持抖音账号主页、用户分享链接和短链接，程序会自动识别并采集最新 5 个视频标题")
                        }}
                    </div>
                </div>
                <div class="elegant-tip-box p-3 rounded">
                    <div class="text-[14px] text-slate-300">
                        <div class="font-medium mb-1">{{ t("提示") }}:</div>
                        <ul class="list-disc list-inside space-y-1">
                            <li>{{ t("输入账号主页或分享链接后点击「开始采集」按钮") }}</li>
                            <li>{{ t("系统会自动打开浏览器并抓取数据，请保持网络连接正常") }}</li>
                            <li>{{ t("无需任何手动操作，等待采集完成即可") }}</li>
                            <li>{{ t("采集完成后会自动将5个视频标题添加到选题库中") }}</li>
                        </ul>
                    </div>
                </div>
            </div>
        </a-modal>

        <!-- 视频仿写链接输入对话框 -->
        <a-modal
            v-model:visible="showVideoRewriteDialog"
            :title="t('粘贴视频分享文本 - 快速仿写')"
            @ok="startVideoRewriteProcessOptimized"
            @cancel="showVideoRewriteDialog = false"
            :ok-text="t('一键仿写')"
            :cancel-text="t('取消')"
            :ok-loading="isVideoRewriting"
            width="600px"
        >
            <div class="space-y-4">
                <div>
                    <label class="block mb-2 font-medium">{{ t("请粘贴视频分享文本或视频链接") }}</label>
                    <div class="text-[14px] text-gray-500 mb-2">
                        {{ t("支持抖音分享文本、抖音视频链接、抖音短链接，以及直接视频文件链接") }}
                    </div>
                    <a-input
                        v-model="videoRewriteUrl"
                        :placeholder="t('输入某音、小某书、某手支持20多个平台链接')"
                        size="large"
                    />
                </div>
                <div class="elegant-tip-box p-3 rounded">
                    <div class="text-[14px] text-slate-300">
                        <div class="font-medium mb-1">{{ t("提示") }}:</div>
                        <ul class="list-disc list-inside space-y-1">
                            <li>{{ t("已支持抖音分享文本、抖音视频链接、抖音短链接") }}</li>
                            <li>{{ t("支持直接视频文件URL（如.mp4、.mov等）") }}</li>
                            <li>{{ t("快手、小红书、B站、视频号分享链接目前会提示暂不支持") }}</li>
                            <li>{{ t("使用FUNASR进行语音识别") }}</li>
                            <li>{{ t("根据设置的仿写提示词生成仿写文案") }}</li>
                        </ul>
                    </div>
                </div>
            </div>
        </a-modal>

        <!-- 视频对比预览对话框 -->
        <a-modal
            v-model:visible="showComparisonDialog"
            :title="t('视频对比预览')"
            :footer="false"
            width="1600px"
            unmount-on-close
            modal-class="video-comparison-modal"
            @before-open="loadLatestSubtitleVideo"
            @close="() => {
                stopPerformanceMonitor();
                // 🔧 【关键修复】对话框关闭时，重置selectedHistoryIndex，确保下次打开时显示当前视频而不是历史视频
                selectedHistoryIndex.value = null;
            }"
        >
            <div class="space-y-4" style="background: #141414; margin: -20px; padding: 20px;">
                <!-- 【新功能】历史视频选择器 -->
                <div class="p-3 rounded-lg border"
                     :class="isLightTheme ? 'bg-white border-gray-200' : 'bg-[#141414] border-[#333]'">
                    <div class="mb-3">
                        <label class="text-[14px] font-medium mb-2 block text-gray-200">{{ t("选择历史视频") }}</label>
                        <div class="flex items-center gap-2">
                            <a-select
                                v-model="selectedHistoryIndex"
                                :options="generatedVideoHistory.map((item, idx) => ({
                                    // ✅ 简化标签：形象 - 时间(任务ID)
                                    // 所有列表项都是有字幕的，不需要标记
                                    label: `${item.templateName || '未知形象'} - ${dayjs(item.timestamp).format('YYYY-MM-DD HH:mm:ss')}(#${String(item.id).slice(-3)})`,
                                    value: idx,
                                    disabled: false
                                }))"
                                class="flex-1 history-select-override"
                                :placeholder="isLoadingHistory ? t('加载中...') : (generatedVideoHistory.length === 0 ? t('暂无历史记录') : t('选择视频...'))"
                                :loading="isLoadingHistory || isLoadingHistoryVideo"
                                :disabled="isLoadingHistoryVideo"
                                :max-tag-count="1"
                                @change="(val: any) => selectHistoryVideo(val)"
                            />
                            <a-button
                                type="secondary"
                                size="small"
                                @click="loadGeneratedVideoHistory"
                                :loading="isLoadingHistory"
                                :disabled="isLoadingHistoryVideo"
                            >
                                {{ t("刷新") }}
                            </a-button>
                        </div>

                    </div>
                </div>


                <!-- 同步播放控制按钮 -->
                <div class="flex items-center justify-center gap-3 pb-2 border-b border-gray-700">
                    <a-button
                        type="primary"
                        size="small"
                        @click="syncPlayVideos"
                        :disabled="isLoadingHistory || isLoadingHistoryVideo"
                    >
                        <template #icon>
                            <icon-play-arrow/>
                        </template>
                        {{ t("同步播放") }}
                    </a-button>
                    <a-button
                        type="outline"
                        size="small"
                        @click="syncPauseVideos"
                        :disabled="isLoadingHistory || isLoadingHistoryVideo"
                    >
                        <template #icon>
                            <icon-pause/>
                        </template>
                        {{ t("同步暂停") }}
                    </a-button>
                </div>

                <!-- 加载提示 -->
                <div v-if="isLoadingHistory" class="flex items-center justify-center py-8">
                    <a-spin size="large" tip="加载视频列表中..."/>
                </div>

                <!-- 视频切换加载提示 -->
                <div v-else-if="isLoadingHistoryVideo" class="flex items-center justify-center py-8">
                    <a-spin size="large">
                        <template #tip>
                            <div class="text-center">
                                <div class="text-[14px] mb-1.5">正在切换视频...</div>
                                <div class="text-[14px] text-gray-400">等待视频缓冲完成</div>
                            </div>
                        </template>
                    </a-spin>
                </div>

                <!-- 视频对比区域 -->
                <div v-else class="flex items-start justify-center" style="gap: -20px;">
                    <!-- 左侧：形象视频模板 -->
                    <div style="width: 600px;">
                        <!-- 性能指标和标题 - 同一行居中 -->
                        <div class="flex items-center justify-center gap-2 mb-2">
                            <div class="text-[14px] font-mono bg-gray-800 px-3 py-2 rounded border border-gray-700">
                                <span class="text-gray-400">FPS:</span>
                                <span class="text-green-400 font-bold ml-2" id="left-fps">-</span>
                                <span class="text-gray-400 ml-4">丢帧:</span>
                                <span class="text-yellow-400 font-bold ml-2" id="left-dropped">-</span>
                            </div>
                            <div class="text-[14px] font-medium" style="color: var(--theme-text-primary);">
                                {{ selectedHistoryIndex === null ? t("原始形象视频（当前）") : t("原始形象视频（历史）") }}
                            </div>
                        </div>
                        <div class="h-[650px] rounded-lg overflow-hidden bg-[#1a1a1a]">
                            <VideoPlayer
                                v-if="selectedHistoryIndex === null ? templateVideoUrl : historyTemplateVideoUrl"
                                ref="templateVideoPlayer"
                                :key="`dialog-template-${selectedHistoryIndex === null ? templateVideoUrl : historyTemplateVideoUrl}`"
                                :url="selectedHistoryIndex === null
                                    ? (templateVideoUrl.startsWith('file://') ? templateVideoUrl : 'file://' + templateVideoUrl)
                                    : ('file://' + historyTemplateVideoUrl)"
                                preload="auto"
                                :autoplay="false"
                                :autoplay-muted="true"
                                :show-performance="false"
                            />
                            <div v-else class="w-full h-full flex items-center justify-center text-gray-400">
                                {{ t("未找到形象视频") }}
                            </div>
                        </div>
                    </div>

                    <!-- 右侧：最终视频 -->
                    <div style="width: 600px; margin-left: -100px;">
                        <!-- 性能指标和标题 - 同一行居中 -->
                        <div class="flex items-center justify-center gap-2 mb-2">
                            <div class="text-[14px] font-mono bg-gray-800 px-3 py-2 rounded border border-gray-700">
                                <span class="text-gray-400">FPS:</span>
                                <span class="text-green-400 font-bold ml-2" id="right-fps">-</span>
                                <span class="text-gray-400 ml-4">丢帧:</span>
                                <span class="text-yellow-400 font-bold ml-2" id="right-dropped">-</span>
                            </div>
                            <div class="text-[14px] font-medium" style="color: var(--theme-text-primary);">
                                {{ selectedHistoryIndex === null ? t("最终视频（含字幕）") : t("最终视频（历史）") }}
                            </div>
                            <!-- 🔧 【新功能】发布视频选择 -->
                            <div class="ml-auto">
                                <a-checkbox
                                    :model-value="selectedPublishVideoUrl === (selectedHistoryIndex === null ? cleanFinalVideoUrl : cleanHistoryVideoUrl)"
                                    @change="(val) => {
                                        if (val) selectVideoForPublish(selectedHistoryIndex === null ? cleanFinalVideoUrl : cleanHistoryVideoUrl);
                                        else selectVideoForPublish('');
                                    }"
                                    class="force-light-checkbox"
                                >
                                    {{ t("选为发布内容") }}
                                </a-checkbox>
                            </div>
                        </div>
                        <div class="h-[650px] rounded-lg overflow-hidden bg-[#1a1a1a]">
                            <VideoPlayer
                                v-if="selectedHistoryIndex === null ? cleanFinalVideoUrl : cleanHistoryVideoUrl"
                                ref="finalVideoPlayer"
                                :key="`dialog-final-${selectedHistoryIndex === null ? cleanFinalVideoUrl : cleanHistoryVideoUrl}`"
                                :url="selectedHistoryIndex === null ? cleanFinalVideoUrl : cleanHistoryVideoUrl"
                                preload="auto"
                                :autoplay="false"
                                :autoplay-muted="true"
                                :show-performance="false"
                            />
                            <div v-else class="w-full h-full flex items-center justify-center text-gray-400">
                                {{ t("暂无视频") }}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </a-modal>

        <!-- 设置对话框 - 使用标签页 -->
        <a-modal
            v-model:visible="showSettingsDialog"
            :title="t('IP智能体设置')"
            @ok="handleSettingsOk"
            @cancel="handleSettingsCancel"
            :ok-text="t('保存')"
            :cancel-text="t('取消')"
            width="1000px"
        >
            <div class="max-h-[70vh] overflow-y-auto">
                <a-tabs v-model:active-key="activeSettingsTab" type="card">
                    <!-- 模型设置标签页 -->
                    <a-tab-pane key="model" :title="t('模型设置')">
                        <div class="space-y-4 p-4">
                            <!-- 数字人模型 -->
                            <div>
                                <label class="block mb-2 text-[14px] font-medium text-gray-900 dark:text-gray-100">{{
                                        t("数字人模型")
                                    }}<span
                                        class="text-[14px] font-normal text-gray-400 ml-2">（根据网络环境差异，可自行切换代理线路）</span></label>
                                <ServerSelector
                                    v-model="settings.videoDigitalHumanModelKey"
                                    functionName="videoGen"
                                    :show-cloud="true"
                                    :show-self-server="true"
                                    :key="`videoGen-${showSettingsDialog}`"
                                />
                            </div>

                            <!-- 文本模型 -->
                            <div>
                                <label class="block mb-2 text-[14px] font-medium">{{ t("文本模型") }}</label>
                                <ModelSelector v-model="settings.textModelKey" provider-filter="builtInDoubao"/>
                            </div>

                            <!-- 声音模型 -->
                            <div>
                                <label class="block mb-2 text-[14px] font-medium">{{ t("声音模型（声音克隆）") }}</label>
                                <OnlineModelSelector
                                    v-model="settings.voiceMode"
                                    function-name="soundClone"
                                    :key="`voice-${showSettingsDialog}`"
                                />
                                <!-- 本地模式 -->
                                <div v-if="settings.voiceMode === 'local'" class="mt-2">
                                    <ServerSelector
                                        v-model="settings.voiceModelKey"
                                        @update:model-value="handleVoiceModelKeyUpdate"
                                        functionName="soundClone"
                                        size="small"
                                    />
                                </div>
                                <!-- 🆕 在线模式：T1多模态语音模型 -->
                                <div v-if="settings.voiceMode === 'online'"
                                     class="mt-3 p-3 bg-gray-50 rounded-lg border">
                                    <label class="block mb-2 text-[14px] font-medium text-gray-800">{{
                                            t("在线TTS模型")
                                        }}</label>
                                    <a-radio-group v-model="settings.onlineTtsModel" type="button" size="small">
                                        <a-radio value="cosyvoiceV2">T1 多模态语音模型</a-radio>
                                        <a-radio value="runninghub_t2">T2 语音模型</a-radio>
                                        <a-radio value="runninghub_t3">T3 语音模型</a-radio>
                                        <a-radio value="runninghub_t4">T4 语音模型</a-radio>
                                        <a-radio value="runninghub_t5">T5 语音模型</a-radio>
                                        <a-radio value="runninghub_t6">T6 语音模型</a-radio>
                                    </a-radio-group>
                                </div>
                            </div>

                            <!-- 声音音色 -->
                            <div>
                                <label class="block mb-2 text-[14px] font-medium">{{ t("声音音色") }}</label>
                                <SoundPromptSelector v-model="settings.voicePromptId"
                                                     :ttsModel="settings.onlineTtsModel"/>
                            </div>

                            <!-- 语音识别模型 -->
                            <div>
                                <label class="block mb-2 text-[14px] font-medium">{{ t("语音识别模型") }}</label>
                                <OnlineModelSelector
                                    v-model="settings.asrMode"
                                    function-name="asr"
                                    :key="`asr-${showSettingsDialog}`"
                                />
                                <div v-if="settings.asrMode === 'local'" class="mt-2">
                                    <ServerSelector
                                        v-model="settings.asrModelKey"
                                        functionName="asr"
                                        size="small"
                                    />
                                </div>
                            </div>

                            <!-- 极速模型模式选择 -->
                            <div v-if="settings.videoDigitalHumanModelKey === '__CLOUD_BEAUTY__'"
                                 class="p-4 bg-gray-800/50 rounded-lg border border-gray-700">
                                <div class="flex items-center gap-2 mb-3">
                                    <icon-palette class="text-pink-400"/>
                                    <span class="text-[14px] font-medium text-pink-300">{{ t("模式选择") }}</span>
                                </div>
                                <div class="space-y-3">
                                    <label
                                        class="flex items-center gap-3 p-2 rounded cursor-pointer hover:bg-gray-700/50"
                                        :class="cloudBeautyMode === '256o' ? 'bg-pink-900/30 border border-pink-500/40' : 'border border-transparent'">
                                        <input type="radio" v-model="cloudBeautyMode" value="256o"
                                               class="accent-pink-500"/>
                                        <div>
                                            <div class="text-[14px] text-white">极速真实 <span
                                                class="text-[14px] text-pink-400">（默认推荐）</span></div>
                                            <div class="text-[14px] text-gray-400">更真实不美化的效果，速度快</div>
                                        </div>
                                    </label>
                                    <label
                                        class="flex items-center gap-3 p-2 rounded cursor-pointer hover:bg-gray-700/50"
                                        :class="cloudBeautyMode === '384m' ? 'bg-pink-900/30 border border-pink-500/40' : 'border border-transparent'">
                                        <input type="radio" v-model="cloudBeautyMode" value="384m"
                                               class="accent-pink-500"/>
                                        <div>
                                            <div class="text-[14px] text-white">高清版 <span
                                                class="text-[14px] text-yellow-400">（稍慢）</span></div>
                                            <div class="text-[14px] text-gray-400">需要更高分辨率，速度较慢</div>
                                        </div>
                                    </label>
                                    <label
                                        class="flex items-center gap-3 p-2 rounded cursor-pointer hover:bg-gray-700/50"
                                        :class="cloudBeautyMode === '256m' ? 'bg-pink-900/30 border border-pink-500/40' : 'border border-transparent'">
                                        <input type="radio" v-model="cloudBeautyMode" value="256m"
                                               class="accent-pink-500"/>
                                        <div>
                                            <div class="text-[14px] text-white">极速美化</div>
                                            <div class="text-[14px] text-gray-400">美化效果，画质与速度均衡</div>
                                        </div>
                                    </label>
                                </div>
                            </div>

                            <!-- 自主算力机配置 -->
                            <div v-if="settings.videoDigitalHumanModelKey === '__SELF_SERVER__'"
                                 class="p-4 bg-gray-800/50 rounded-lg border border-gray-700">
                                <div class="flex items-center gap-2 mb-3">
                                    <icon-settings class="text-orange-400"/>
                                    <span class="text-[14px] font-medium text-orange-300">{{
                                            t("自主算力机配置")
                                        }}</span>
                                </div>
                                <div class="space-y-3">
                                    <div
                                        class="p-2 bg-red-900/20 rounded border border-red-500/30 text-[14px] text-red-300">
                                        {{ t("请先填写API密钥") }}
                                    </div>
                                    <div>
                                        <label class="block mb-1.5 text-[14px] text-gray-400">{{
                                                t("API公钥 (PublicKey)")
                                            }}</label>
                                        <a-input v-model="settings.selfServerPublicKey" :placeholder="t('输入API公钥')"
                                                 size="small"/>
                                    </div>
                                    <div>
                                        <label class="block mb-1.5 text-[14px] text-gray-400">{{
                                                t("API私钥 (PrivateKey)")
                                            }}</label>
                                        <a-input-password v-model="settings.selfServerPrivateKey"
                                                          :placeholder="t('输入API私钥')" size="small"/>
                                    </div>
                                    <div>
                                        <label class="block mb-1.5 text-[14px] text-gray-400">{{
                                                t("服务器ID")
                                            }}</label>
                                        <a-input v-model="settings.selfServerId" :placeholder="t('输入服务器实例ID')"
                                                 size="small"/>
                                    </div>
                                    <div>
                                        <label class="block mb-1.5 text-[14px] text-gray-400">{{
                                                t("数字人API地址")
                                            }}</label>
                                        <a-input v-model="settings.selfServerApiUrl" placeholder="http://xxx:7860/"
                                                 size="small"/>
                                    </div>

                                    <!-- 状态和启动按钮 -->
                                    <div class="flex items-center gap-3 pt-2">
                                        <div class="flex items-center gap-2">
                                            <span class="text-[14px] text-gray-400">{{ t("状态") }}:</span>
                                            <a-tag v-if="selfServerStatus === 'running'" color="green">
                                                <template #icon>
                                                    <icon-check-circle-fill/>
                                                </template>
                                                {{ t("运行中") }}
                                            </a-tag>
                                            <a-tag v-else-if="selfServerStatus === 'starting'" color="orange">
                                                <template #icon>
                                                    <icon-loading/>
                                                </template>
                                                {{ t("启动中") }}
                                            </a-tag>
                                            <a-tag v-else-if="selfServerStatus === 'stopped'" color="red">
                                                <template #icon>
                                                    <icon-close-circle-fill/>
                                                </template>
                                                {{ t("已停止") }}
                                            </a-tag>
                                            <a-tag v-else color="gray">
                                                {{ t("未知") }}
                                            </a-tag>
                                        </div>
                                        <a-button
                                            v-if="selfServerStatus !== 'running'"
                                            type="primary"
                                            size="small"
                                            :loading="selfServerStatusLoading"
                                            :disabled="!settings.selfServerId || !settings.selfServerPublicKey || !settings.selfServerPrivateKey"
                                            @click="startSelfServer"
                                        >
                                            {{ t("启动机器") }}
                                        </a-button>
                                        <a-button
                                            v-else
                                            type="outline"
                                            size="small"
                                            status="danger"
                                            :loading="selfServerStatusLoading"
                                            @click="stopSelfServer"
                                        >
                                            {{ t("停止机器") }}
                                        </a-button>
                                        <a-button
                                            size="small"
                                            :disabled="!settings.selfServerId || !settings.selfServerPublicKey || !settings.selfServerPrivateKey"
                                            @click="checkSelfServerStatus"
                                        >
                                            {{ t("刷新状态") }}
                                        </a-button>
                                    </div>
                                </div>
                                <div class="mt-2 text-[14px] text-gray-500">
                                    {{ t("请先启动机器，运行状态才能生成视频") }}
                                </div>
                            </div>

                        </div>
                    </a-tab-pane>

                    <!-- 提示词设置标签页 -->
                    <a-tab-pane key="prompts" :title="t('提示词设置')">
                        <div class="space-y-4 p-4">
                            <!-- 生成文案提示词 -->
                            <div>
                                <label class="block mb-2 text-[14px] font-medium">{{ t("生成文案提示词") }}</label>
                                <a-textarea
                                    v-model="settings.scriptPrompt"
                                    :rows="6"
                                    :placeholder="t('输入生成文案的提示词...')"
                                />
                                <div class="text-[14px] text-gray-500 mt-1">
                                    {{ t("可用变量：{title}、{count}") }}
                                </div>
                            </div>

                            <!-- 标题标签关键词提示词 -->
                            <div>
                                <label class="block mb-2 text-[14px] font-medium">{{
                                        t("标题标签关键词提示词")
                                    }}</label>
                                <a-textarea
                                    v-model="settings.titleTagPrompt"
                                    :rows="6"
                                    :placeholder="t('输入标题标签关键词生成的提示词...')"
                                />
                                <div class="text-[14px] text-gray-500 mt-1">
                                    {{ t("可用变量：") + '\u007B\u007Bcontent\u007D\u007D' }}
                                </div>
                            </div>

                            <!-- 选题库仿写提示词 -->
                            <div>
                                <label class="block mb-2 text-[14px] font-medium">{{ t("选题库仿写提示词") }}</label>
                                <a-textarea
                                    v-model="settings.topicRewritePrompt"
                                    :rows="6"
                                    :placeholder="t('输入选题库标题仿写的提示词...')"
                                />
                                <div class="text-[14px] text-gray-500 mt-1">
                                    {{ t("用于一键仿写选题库标题，可用变量：") + '\u007B\u007Bcontent\u007D\u007D' }}
                                </div>
                            </div>

                            <!-- 仿写提示词 -->
                            <div>
                                <label class="block mb-2 text-[14px] font-medium">{{ t("仿写提示词") }}</label>
                                <a-textarea
                                    v-model="settings.rewritePrompt"
                                    :rows="5"
                                    :placeholder="t('输入仿写的提示词...')"
                                />
                                <div class="text-[14px] text-gray-500 mt-1">
                                    {{
                                        t("可用变量：") + '\u007B\u007Bcontent\u007D\u007D、\u007B\u007Bcount\u007D\u007D'
                                    }}
                                </div>
                            </div>
                        </div>
                    </a-tab-pane>

                    <!-- 字幕设置标签页 -->
                    <a-tab-pane key="subtitle" :title="t('字幕设置')">
                        <div class="flex flex-col max-h-[70vh]">
                            <!-- 可滚动内容区域 -->
                            <div v-show="!isEditingSubtitleTemplate" class="flex-1 overflow-y-auto space-y-4 p-4">
                                <!-- 字幕模板选择区域 -->
                                <div
                                    class="p-4 bg-gradient-to-r from-blue-900/20 to-indigo-900/20 rounded-lg border border-blue-500/30">
                                    <div class="flex items-center justify-between mb-4">
                                        <h5 class="font-medium">{{ t("字幕模板") }}</h5>
                                        <div class="flex gap-2">
                                            <a-button
                                                v-if="!isEditingSubtitleTemplate"
                                                type="primary"
                                                size="small"
                                                @click="handleExportAllSubtitleTemplates"
                                            >
                                                <icon-download/>
                                                {{ t("导出全部") }}
                                            </a-button>
                                            <a-button
                                                v-if="!isEditingSubtitleTemplate"
                                                type="outline"
                                                size="small"
                                                @click="handleImportSubtitleTemplate"
                                            >
                                                <icon-upload/>
                                                {{ t("导入模板") }}
                                            </a-button>
                                            <a-button
                                                v-if="!isEditingSubtitleTemplate"
                                                type="primary"
                                                size="small"
                                                @click="handleSaveButtonClick"
                                            >
                                                {{ t("新建模板") }}
                                            </a-button>
                                        </div>
                                    </div>
                                </div>

                                <!-- 模板预览卡片列表 -->
                                <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
                                    <SubtitlePreviewCard
                                        v-for="template in subtitleTemplates"
                                        :key="template.id"
                                        :template-name="template.name"
                                        :subtitle-style="template.config?.subtitleStyle"
                                        :title-subtitle-config="template.config?.titleSubtitleConfig"
                                        :keyword-groups-styles="template.config?.keywordGroupsStyles"
                                        :keyword-render-mode="template.config?.keywordRenderMode"
                                        :preview-config="template.config?.previewConfig"
                                        :is-selected="selectedSubtitleTemplate === template.id"
                                        :preview-scale="0.33"
                                        :is-system="template.is_system === 1 || template.isSystem || isSystemTemplate(template.id)"
                                        :is-dev="isDev"
                                        @select="() => {
                                            selectedSubtitleTemplate = template.id;
                                            handleTemplateChange(template.id);
                                        }"
                                        @edit="() => startEditTemplate(template.id)"
                                        @clone="() => cloneTemplate(template.id)"
                                        @export="() => handleExportSubtitleTemplate(template.id, template.name)"
                                        @delete="() => confirmDeleteTemplate(template.id)"
                                        @set-as-system="() => handleSetSubtitleAsSystem(template.id, template.name)"
                                    />

                                    <!-- 空状态提示 -->
                                    <div
                                        v-if="subtitleTemplates.length === 0"
                                        class="w-full text-center py-8 text-gray-400"
                                    >
                                        <div class="text-lg mb-2">📝</div>
                                        <div>{{ t("暂无字幕模板，点击\"新建模板\"创建") }}</div>
                                    </div>
                                </div>
                            </div>

                            <!-- 🆕 编辑模式区域 - 仅在编辑时显示 -->
                            <template v-if="isEditingSubtitleTemplate && editingTemplateId">
                                <div class="flex-1 overflow-y-auto flex flex-col relative h-full">
                                    <a-divider/>

                                    <!-- 编辑模式头部 -->
                                    <div class="flex items-center justify-between">
                                        <div class="flex items-center gap-2">
                                            <span class="text-blue-600 font-medium">
                                                正在编辑: {{ currentSelectedTemplate?.name || '未知模板' }}
                                            </span>
                                            <a-tag color="blue" size="small">编辑模式</a-tag>
                                        </div>
                                    </div>
                                    <div class="text-[14px] text-gray-500">
                                        修改完成后请点击底部的"保存模板"按钮
                                    </div>

                                    <div class="flex gap-6 items-start mt-4 h-full relative">
                                        <!-- 左侧：固定预览区域 -->
                                        <div class="sticky top-0 z-10 flex-shrink-0" style="width: 320px;">
                                            <div class="text-[14px] text-gray-500 mb-2 font-medium text-center">
                                                实时预览
                                            </div>
                                            <SubtitlePreviewCard
                                                v-if="currentSelectedTemplate?.config"
                                                :template-name="currentSelectedTemplate?.name"
                                                :subtitle-style="editingPreviewSubtitleStyle"
                                                :title-subtitle-config="currentSelectedTemplate.config.titleSubtitleConfig"
                                                :keyword-groups-styles="currentSelectedTemplate.config.keywordGroupsStyles"
                                                :keyword-render-mode="currentSelectedTemplate.config.keywordRenderMode"
                                                :preview-config="currentSelectedTemplate.config.previewConfig"
                                                :preview-scale="0.42"
                                                :show-actions="false"
                                                :show-meta="false"
                                                :card-clickable="false"
                                            />
                                        </div>

                                        <!-- 右侧：滚动设置区域 -->
                                        <div class="flex-1 min-w-0 space-y-6">
                                            <!-- 字幕样式选择器 -->
                                            <div>
                                                <SubtitleStyleSelector
                                                    v-model="selectedSubtitleStyleId"
                                                    v-model:fontSizeScale="subtitleFontSizeScale"
                                                    v-model:subtitlePosition="subtitlePosition"
                                                    ref="subtitleStyleSelectorRef"
                                                    :skip-initial-load="true"
                                                    @style-change="handleSubtitleStyleChange"
                                                />
                                            </div>

                                            <a-divider/>

                                            <!-- 标题字幕设置 -->
                                            <div>
                                                <TitleSubtitleSettings
                                                    v-if="currentSelectedTemplate && currentSelectedTemplate.config"
                                                    v-model="currentSelectedTemplate.config.titleSubtitleConfig"
                                                    :video-width="videoWidth"
                                                    :video-height="videoHeight"
                                                />
                                            </div>

                                            <a-divider/>

                                            <!-- 关键词智能识别与特效 -->
                                            <div
                                                class="p-4 bg-gradient-to-r from-blue-50 to-blue-50 rounded-lg border border-blue-200">
                                                <div class="mb-3">
                                                    <!-- 左侧：关键词特效启用 & 右侧：最小字幕时长 -->
                                                    <div class="flex items-center justify-between">
                                                        <!-- 左侧 -->
                                                        <div class="flex items-center gap-3">
                                                            <a-checkbox v-model="enableKeywordEffects"
                                                                        class="force-light-checkbox">
                                                                <h5 class="font-medium text-gray-900">
                                                                    {{ t("关键词智能识别与特效") }}</h5>
                                                            </a-checkbox>
                                                            <a-tag v-if="!enableKeywordEffects" color="gray"
                                                                   size="small">{{ t("未启用") }}
                                                            </a-tag>
                                                            <a-tag v-else color="blue" size="small">{{
                                                                    t("已启用")
                                                                }}
                                                            </a-tag>
                                                        </div>

                                                    </div>
                                                    <div class="text-[14px] text-gray-600 mt-1 ml-6">
                                                        {{
                                                            t("勾选后启用关键词特效功能，AI自动识别字幕中的关键词并添加醒目的放大特效")
                                                        }}
                                                    </div>
                                                </div>

                                                <div v-if="enableKeywordEffects" class="mt-4 space-y-4">
                                                    <div class="p-3 bg-white rounded-lg border">
                                                        <div class="flex items-center justify-between gap-3">
                                                            <div>
                                                                <h6 class="font-medium text-[14px] text-gray-900">
                                                                    {{ t("关键词呈现方式") }}</h6>
                                                                <div class="text-[14px] text-gray-700 mt-1">
                                                                    {{ t("内联字幕用于新模板，浮动特效用于旧模板") }}
                                                                </div>
                                                            </div>
                                                            <a-radio-group v-model="currentKeywordRenderMode"
                                                                           type="button" size="small">
                                                                <a-radio value="inline-emphasis">{{
                                                                        t("内联字幕")
                                                                    }}
                                                                </a-radio>
                                                                <a-radio value="floating">{{ t("浮动特效") }}</a-radio>
                                                            </a-radio-group>
                                                        </div>
                                                        <div
                                                            class="mt-3 text-[14px] rounded-md px-3 py-2"
                                                            :class="currentKeywordRenderMode === 'inline-emphasis' ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-amber-50 text-amber-700 border border-amber-200'"
                                                        >
                                                            {{
                                                                currentKeywordRenderMode === 'inline-emphasis'
                                                                    ? t("关键词会直接嵌在普通字幕里放大显示，不再单独飞出")
                                                                    : t("关键词会按旧模板方式单独触发浮动/动画特效")
                                                            }}
                                                        </div>
                                                    </div>

                                                    <!-- 关键词自动识别说明 -->
                                                    <div
                                                        class="flex items-center gap-2 p-3 bg-blue-50 rounded border border-blue-200">
                                                        <icon-info-circle class="text-blue-500"/>
                                                        <span class="text-[14px] text-blue-700">
                                                {{ t("关键词将根据字幕内容自动识别和匹配，生成视频时会自动应用特效") }}
                                            </span>
                                                    </div>

                                                    <!-- 关键词特效选择器 -->
                                                    <div v-if="currentKeywordRenderMode === 'floating'">
                                                        <KeywordEffectSelector ref="keywordEffectSelectorRef"/>
                                                    </div>

                                                    <!-- 关键词分组管理 -->
                                                    <div class="p-3 bg-white rounded-lg border">
                                                        <h6 class="font-medium text-[14px] mb-3">{{
                                                                t("关键词分组管理")
                                                            }}</h6>
                                                        <KeywordGroupManager
                                                            ref="keywordGroupManagerRef"
                                                            :enable-keyword-effects="enableKeywordEffects"
                                                            :extracted-keywords="extractedKeywords"
                                                            @update:enable-keyword-effects="enableKeywordEffects = $event"
                                                            @groups-change="onKeywordGroupsChange"
                                                        />
                                                    </div>

                                                    <!-- 提取的关键词展示区 -->
                                                    <div v-if="extractedKeywords.length > 0"
                                                         class="p-3 bg-white rounded-lg border">
                                                        <div
                                                            class="flex items-center justify-between mb-2 cursor-pointer"
                                                            role="button" tabindex="0" :aria-expanded="!collapsed.keywordDisplay" @keydown.enter.prevent="collapsed.keywordDisplay = !collapsed.keywordDisplay" @keydown.space.prevent="collapsed.keywordDisplay = !collapsed.keywordDisplay" @click="collapsed.keywordDisplay = !collapsed.keywordDisplay">
                                                            <h6 class="font-medium text-[14px]">{{ t("提取的关键词") }}
                                                                ({{ extractedKeywords.length }})</h6>
                                                            <icon-down v-if="!collapsed.keywordDisplay"
                                                                       class="text-gray-600 transition-transform"/>
                                                            <icon-up v-else class="text-gray-600 transition-transform"/>
                                                        </div>

                                                        <div v-show="!collapsed.keywordDisplay" class="space-y-3">
                                                            <div class="flex flex-wrap gap-2">
                                                                <a-tag
                                                                    v-for="(kw, index) in extractedKeywords"
                                                                    :key="kw.keyword"
                                                                    color="blue"
                                                                    size="small"
                                                                >
                                                                    {{ kw.keyword }}
                                                                    <span v-if="kw.count"
                                                                          class="ml-1 text-[14px] opacity-70">({{
                                                                            kw.count
                                                                        }})</span>
                                                                </a-tag>
                                                            </div>

                                                            <!-- 关键词标记管理 -->
                                                            <div class="mt-3 pt-3 border-t">
                                                                <KeywordMarker
                                                                    ref="keywordMarkerRef"
                                                                    :keywords="extractedKeywords"
                                                                    :subtitle-segments="funasrSegments"
                                                                    @markers-change="onMarkersChange"
                                                                />
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                </div>
                            </template>
                        </div>
                    </a-tab-pane>

                    <!-- 其他设置标签页 -->
                    <a-tab-pane key="other" :title="t('其他设置')">
                        <div class="space-y-4 p-4">
                            <div>
                                <p class="text-[14px] font-medium">本地模型进程复用已默认启用</p>
                                <div class="text-[14px] text-gray-500 mt-1">
                                    任务结束不再自动执行停止脚本或显存清理；仅在手动取消任务或退出应用时走正常关闭流程
                                </div>
                            </div>

                            <a-divider/>

                            <!-- 字幕位置设置 -->
                            <div class="space-y-4">
                                <p class="text-[14px] font-medium">字幕位置设置</p>

                                <!-- 普通字幕输入框 -->
                                <div class="grid grid-cols-2 gap-4">
                                    <div>
                                        <label class="block mb-2 text-[14px] font-medium">{{
                                                t("普通字幕X位置")
                                            }}</label>
                                        <a-input-number v-model="settings.normalSubtitleX" :min="0" :max="100"
                                                        size="small"/>
                                        <div class="text-[14px] text-gray-500 mt-1">0=左, 50=中, 100=右</div>
                                    </div>
                                    <div>
                                        <label class="block mb-2 text-[14px] font-medium">{{
                                                t("普通字幕Y位置")
                                            }}</label>
                                        <a-input-number v-model="settings.normalSubtitleY" :min="0" :max="100"
                                                        size="small"/>
                                        <div class="text-[14px] text-gray-500 mt-1">0=顶部, 100=底部</div>
                                    </div>
                                </div>

                                <!-- 禁用智能布局选项 -->
                                <div class="mt-4">
                                    <a-checkbox v-model="settings.disableSmartLayout">
                                        <span
                                            class="text-[14px]">禁用智能布局，使用固定位置（勾选后字幕将严格按照设置的坐标显示）</span>
                                    </a-checkbox>
                                </div>
                            </div>

                            <a-divider/>

                            <!-- 关键词分组位置设置 - 左右两栏布局 -->
                            <div class="flex gap-6">
                                <!-- 左侧：位置预览区 -->
                                <div class="flex-shrink-0" style="width: 320px;">
                                    <p class="text-[14px] font-medium mb-3">位置预览</p>
                                    <svg viewBox="0 0 400 300" class="w-full border border-gray-300 rounded bg-white">
                                        <!-- 背景网格 -->
                                        <defs>
                                            <pattern id="grid" width="40" height="30" patternUnits="userSpaceOnUse">
                                                <path d="M 40 0 L 0 0 0 30" fill="none" stroke="#e5e7eb"
                                                      stroke-width="0.5"/>
                                            </pattern>
                                        </defs>
                                        <rect width="400" height="300" fill="url(#grid)"/>

                                        <!-- 普通字幕位置 -->
                                        <circle
                                            :cx="settings.normalSubtitleX * 4"
                                            :cy="300 - settings.normalSubtitleY * 3"
                                            r="5"
                                            fill="#3b82f6"
                                            opacity="0.7"
                                        />
                                        <text
                                            :x="settings.normalSubtitleX * 4 + 8"
                                            :y="300 - settings.normalSubtitleY * 3 + 4"
                                            font-size="10"
                                            fill="#3b82f6"
                                        >
                                            普通字幕
                                        </text>

                                        <!-- 关键词组位置标签 -->
                                        <g v-for="(group, groupIndex) in keywordGroups" :key="group.id">
                                            <circle
                                                :cx="((getGroupX(group.name) ?? getDefaultGroupPos(groupIndex).x) * 4)"
                                                :cy="(300 - (getGroupY(group.name) ?? getDefaultGroupPos(groupIndex).y) * 3)"
                                                r="6"
                                                :fill="getGroupColor(groupIndex)"
                                                :opacity="0.9"
                                            />
                                            <text
                                                :x="((getGroupX(group.name) ?? getDefaultGroupPos(groupIndex).x) * 4 + 10)"
                                                :y="(300 - (getGroupY(group.name) ?? getDefaultGroupPos(groupIndex).y) * 3 + 4)"
                                                font-size="11"
                                                :fill="getGroupColor(groupIndex)"
                                                font-weight="bold"
                                            >
                                                {{ group.name }}
                                            </text>
                                        </g>
                                    </svg>
                                    <p class="text-[14px] text-gray-700 mt-2">拖动右侧滑块调整各分组位置</p>
                                </div>

                                <!-- 右侧：位置调整区 -->
                                <div class="flex-1 space-y-4">
                                    <p class="text-[14px] font-medium mb-3">位置调整</p>

                                    <!-- 避让配置 (全局默认) -->
                                    <div class="p-3 bg-blue-50 rounded border border-blue-200 mb-4">
                                        <p class="text-[14px] font-medium mb-2">全局避让配置</p>
                                        <div class="grid grid-cols-2 gap-4">
                                            <div>
                                                <label class="block mb-1.5 text-[14px] text-black">默认避让方向</label>
                                                <a-select v-model="settings.avoidanceConfig.preferDirection"
                                                          size="small" style="width: 100%">
                                                    <a-option value="right">往右</a-option>
                                                    <a-option value="top">往上</a-option>
                                                </a-select>
                                            </div>
                                            <div>
                                                <label
                                                    class="block mb-1.5 text-[14px] text-black">默认安全距离(px)</label>
                                                <a-input-number
                                                    v-model="settings.avoidanceConfig.safeDistance"
                                                    :min="5"
                                                    :max="100"
                                                    size="small"
                                                    style="width: 100%"
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <!-- 关键词组位置配置列表 -->
                                    <div class="space-y-3 max-h-[300px] overflow-y-auto pr-2">
                                        <div
                                            v-for="(group, index) in keywordGroups"
                                            :key="group.id"
                                            class="p-3 border rounded bg-white"
                                        >
                                            <div class="flex items-center justify-between mb-2">
                                                <div class="flex items-center gap-2">
                                                    <span
                                                        class="w-3 h-3 rounded-full"
                                                        :style="{ backgroundColor: getGroupColor(index) }"
                                                    ></span>
                                                    <span class="text-[14px] font-medium text-black">{{
                                                            group.name
                                                        }}</span>
                                                </div>
                                                <a-button
                                                    size="mini"
                                                    type="text"
                                                    @click="clearGroupPosition(group.name)"
                                                >
                                                    重置
                                                </a-button>
                                            </div>
                                            <div class="grid grid-cols-2 gap-4">
                                                <div>
                                                    <label class="block mb-1.5 text-[14px] text-black">X (%)</label>
                                                    <a-slider
                                                        :model-value="getGroupX(group.name) ?? getDefaultGroupPos(index).x"
                                                        @update:model-value="(val) => setGroupX(group.name, val)"
                                                        :min="0"
                                                        :max="100"
                                                        :show-tooltip="true"
                                                    />
                                                </div>
                                                <div>
                                                    <label class="block mb-1.5 text-[14px] text-black">Y (%)</label>
                                                    <a-slider
                                                        :model-value="getGroupY(group.name) ?? getDefaultGroupPos(index).y"
                                                        @update:model-value="(val) => setGroupY(group.name, val)"
                                                        :min="0"
                                                        :max="100"
                                                        :show-tooltip="true"
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <a-divider/>

                            <!-- 剪气口设置 -->
                            <div class="space-y-4">
                                <p class="text-[14px] font-medium">🎬 剪气口设置 <span class="text-[14px] text-gray-500">（删除视频中的停顿，让口播更流畅）</span>
                                </p>

                                <!-- 音量阈值 -->
                                <div>
                                    <label class="block mb-2 text-[14px] font-medium">{{ t("音量阈值") }}</label>
                                    <div class="flex items-center gap-3">
                                        <a-slider
                                            v-model="settings.silenceThreshold"
                                            :min="-60"
                                            :max="-30"
                                            :step="1"
                                            style="flex: 1"
                                        />
                                        <span class="text-[14px] font-mono w-16">{{
                                                settings.silenceThreshold
                                            }}dB</span>
                                    </div>
                                    <div class="text-[14px] text-gray-500 mt-1">
                                        更负数值 = 检测更严格 | -40dB是推荐值
                                    </div>
                                </div>

                                <!-- 最小停顿时长 -->
                                <div>
                                    <label class="block mb-2 text-[14px] font-medium">{{ t("最小停顿时长") }}</label>
                                    <div class="flex items-center gap-3">
                                        <a-slider
                                            v-model="settings.silenceDuration"
                                            :min="0.5"
                                            :max="2"
                                            :step="0.1"
                                            style="flex: 1"
                                        />
                                        <span class="text-[14px] font-mono w-16">{{
                                                settings.silenceDuration.toFixed(1)
                                            }}秒</span>
                                    </div>
                                    <div class="text-[14px] text-gray-500 mt-1">
                                        超过此时长的停顿才会被删除 | 1秒是推荐值
                                    </div>
                                </div>

                                <!-- 保留最小间隔 -->
                                <div>
                                    <label class="block mb-2 text-[14px] font-medium">{{ t("保留最小间隔") }}</label>
                                    <div class="flex items-center gap-3">
                                        <a-slider
                                            v-model="settings.minPauseDuration"
                                            :min="0.05"
                                            :max="0.3"
                                            :step="0.05"
                                            style="flex: 1"
                                        />
                                        <span class="text-[14px] font-mono w-16">{{
                                                (settings.minPauseDuration * 1000).toFixed(0)
                                            }}ms</span>
                                    </div>
                                    <div class="text-[14px] text-gray-500 mt-1">
                                        保留自然停顿，让视频显得更自然 | 150ms是推荐值
                                    </div>
                                </div>

                                <!-- 提示信息 -->
                                <div class="p-3 bg-blue-50 rounded border border-blue-200">
                                    <p class="text-[14px] text-blue-700">
                                        💡 <strong>工作原理：</strong>分析视频音频，找出低于-40dB（无声）且超过1秒的停顿，删除它们但保留150ms的自然停顿。
                                    </p>
                                    <p class="text-[14px] text-blue-700 mt-2">
                                        📌 在"03视频编辑"区点击"自动处理"按钮即可应用这些设置。
                                    </p>
                                </div>
                            </div>

                            <a-divider/>

                            <!-- 配置导出/导入 -->
                            <div class="space-y-4">
                                <p class="text-[14px] font-medium">{{ t("配置管理") }}</p>
                                <div class="flex gap-4">
                                    <a-button @click="exportSettings" type="primary" status="success">
                                        <template #icon>
                                            <icon-export/>
                                        </template>
                                        {{ t("导出所有设置") }}
                                    </a-button>
                                    <a-button @click="importSettings" type="primary" status="warning">
                                        <template #icon>
                                            <icon-import/>
                                        </template>
                                        {{ t("导入所有设置") }}
                                    </a-button>
                                </div>
                                <div class="text-[14px] text-gray-500">
                                    {{ t("导出当前的提示词、模版、模型选择等所有配置，以便分享或备份。") }}
                                </div>
                            </div>
                        </div>
                    </a-tab-pane>

                    <!-- 画中画设置标签页 -->
                    <a-tab-pane key="mixCut" :title="t('画中画设置')">
                        <div class="space-y-4 p-4 max-h-[70vh] overflow-y-auto">
                            <SettingMixCut ref="settingMixCutRef"/>
                        </div>
                    </a-tab-pane>
                </a-tabs>
            </div>
        </a-modal>


        <!-- 封面样式自定义对话框 -->
        <a-modal
            v-model:visible="showCoverEffectDialog"
            :title="t('封面样式自定义')"
            width="900px"
            :mask-closable="false"
        >
            <CoverEffectSelector
                ref="coverEffectSelectorRef"
                :cover-style="coverStyle"
                @style-change="handleCoverStyleUpdate"
            />

            <template #footer>
                <a-button @click="showCoverEffectDialog = false">{{ t("关闭") }}</a-button>
            </template>
        </a-modal>

        <!-- 封面图片预览弹窗 -->
        <a-modal
            v-model:visible="showCoverImageDialog"
            :title="$t('封面预览')"
            width="80%"
            :footer="false"
            @cancel="showCoverImageDialog = false"
        >
            <div v-if="coverPreviewUrl" class="flex justify-center bg-gray-100 rounded-lg p-4">
                <img
                    :src="coverPreviewUrl.startsWith('file://') ? coverPreviewUrl : 'file://' + coverPreviewUrl"
                    :alt="$t('封面图片')"
                    class="max-w-full max-h-[80vh] object-contain shadow-lg rounded-lg"
                />
            </div>
            <div v-else class="text-center py-8 text-gray-400">
                {{ $t("暂无封面图片") }}
            </div>
        </a-modal>

        <!-- 封面高级设置对话框 -->
        <CoverSettingsDialog
            v-model:visible="showCoverSettingsDialog"
            v-model:config="coverConfig"
            v-model:template-name="coverTemplateName"
            :video-path="videoPreviewUrl || processedVideoUrl || ''"
            :reference-text="generatedTitle"
            :initial-title-style="currentSelectedTemplate?.config?.titleSubtitleConfig?.lines?.[0]"
            @apply="handleCoverConfigApply"
        />

        <!-- 日志对话框 -->
        <a-modal
            v-model:visible="showLogDialog"
            :title="t('任务日志')"
            width="80%"
            :footer="false"
            @cancel="showLogDialog = false"
        >
            <div v-if="currentLogTaskId" class="max-h-[60vh] overflow-y-auto">
                <TaskLogViewer
                    :taskId="currentLogTaskId"
                    :autoRefresh="isGeneratingAudio || isGeneratingVideo"
                    :refreshInterval="2000"
                />
            </div>
            <div v-else class="text-center py-8 text-gray-400">
                {{ t("暂无任务日志") }}
            </div>
        </a-modal>

        <!-- 保存模板对话框 -->
        <a-modal
            v-model:visible="showTemplateDialog"
            title="保存字幕模板"
            @ok="saveSubtitleTemplate"
            @cancel="showTemplateDialog = false"
            ok-text="保存"
            cancel-text="取消"
            width="500px"
        >
            <div class="space-y-4">
                <div>
                    <label class="block text-[14px] font-medium mb-1.5">模板名称</label>
                    <a-input
                        v-model="templateName"
                        placeholder="请输入模板名称"
                        size="small"
                    />
                </div>
                <div>
                    <label class="block text-[14px] font-medium mb-1.5">模板描述（可选）</label>
                    <a-textarea
                        v-model="templateDescription"
                        placeholder="请输入模板描述"
                        :rows="3"
                        size="small"
                    />
                </div>
                <!-- ✨ 系统模板选项（仅开发模式） -->
                <div v-if="isDev" class="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <a-checkbox v-model="saveAsSystemTemplate">
                        <span class="text-yellow-600 font-medium">✨ 保存为系统模板</span>
                        <span class="text-gray-500 text-[14px] ml-2">（自动导出到配置文件）</span>
                    </a-checkbox>
                </div>
                <div class="text-[14px] text-gray-500">
                    <p>保存内容包括：</p>
                    <ul class="list-disc ml-4 mt-1">
                        <li>字幕样式配置</li>
                        <li>字幕位置和大小</li>
                        <li>关键词特效开关</li>
                        <li>所有关键词分组和配置</li>
                        <li>屏幕分辨率和字体设置</li>
                    </ul>
                    <p class="mt-2">
                        <span class="text-blue-600">💡 提示：</span>特效字幕最小显示时长在"其他设置"中配置，仅控制关键词特效动画，不影响普通字幕
                    </p>
                </div>
            </div>
        </a-modal>

        <!-- 加载模板列表对话框 -->
        <a-modal
            v-model:visible="showTemplateList"
            title="加载字幕模板"
            @cancel="showTemplateList = false"
            :footer="null"
            width="600px"
        >
            <div v-if="subtitleTemplates.length > 0" class="space-y-3">
                <div
                    v-for="template in subtitleTemplates"
                    :key="template.id"
                    class="flex items-center justify-between p-3 border rounded"
                >
                    <div class="flex-1">
                        <div class="font-medium text-[14px]">{{ template.name }}</div>
                        <div v-if="template.description" class="text-[14px] text-gray-500 mt-1">
                            {{ template.description }}
                        </div>
                        <div class="text-[14px] text-gray-400 mt-1">
                            创建于: {{ new Date(template.createdAt).toLocaleString() }}
                        </div>
                    </div>
                    <div class="flex gap-2">
                        <a-button
                            type="primary"
                            size="small"
                            @click="loadTemplate(template)"
                        >
                            加载
                        </a-button>
                        <a-popconfirm
                            v-if="!template.is_system || isDev"
                            title="确认删除此模板？"
                            ok-text="删除"
                            cancel-text="取消"
                            @ok="deleteTemplate(template.id)"
                        >
                            <a-button type="secondary" status="danger" size="small">
                                删除
                            </a-button>
                        </a-popconfirm>
                    </div>
                </div>
            </div>
            <div v-else class="text-center py-8 text-gray-400">
                暂无保存的模板
            </div>
        </a-modal>

        <!-- 一键智能进度弹窗 -->
        <AgentProgressDialog
            v-model:visible="showProgressDialog"
            :current-step="currentStep"
            :progress-percent="progressPercent"
            :error-message="progressErrorMessage"
            :can-cancel="canCancelProgress"
            @cancel="cancelOneClickIntelligence"
            @close="showProgressDialog = false"
        />

        <!-- AI法务审核报告对话框 -->
        <a-modal
            v-model:visible="legalCheckDialogVisible"
            :title="t('AI 法务审核报告')"
            width="600px"
            :footer="false"
            :modal-style="{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: '12px' }"
            modal-class="legal-modal-dark"
        >
            <div v-if="legalCheckLoading" class="py-12 flex flex-col items-center gap-5">
                <div class="legal-shield-container">
                    <div class="legal-shield-glow"></div>
                    <svg class="legal-shield-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.25C17.25 22.15 21 17.25 21 12V7L12 2z"
                              fill="rgba(59,130,246,0.15)" stroke="rgba(59,130,246,0.8)" stroke-width="1.2"/>
                        <path d="M12 6L8 8.5v3c0 2.5 1.7 4.8 4 5.4 2.3-.6 4-2.9 4-5.4v-3L12 6z"
                              fill="rgba(59,130,246,0.3)"/>
                        <path d="M10 12l1.5 1.5L14 10.5" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round"
                              stroke-linejoin="round"/>
                    </svg>
                </div>
                <div class="text-center">
                    <div class="text-[14px] font-semibold text-gray-200">{{ t('AI 正在进行法务审核...') }}</div>
                    <div class="text-[14px] text-gray-500 mt-2">{{ t('检查违禁词、敏感词、极限词等法律风险') }}</div>
                </div>
            </div>

            <div v-else class="space-y-4">
                <div class="flex items-center gap-3 p-3 rounded-lg"
                     :class="legalCheckResult.hasViolations ? 'bg-amber-900/20 border border-amber-700/30' : 'bg-emerald-900/20 border border-emerald-700/30'">
                    <icon-exclamation-circle-fill v-if="legalCheckResult.hasViolations"
                                                  class="text-amber-400 text-2xl"/>
                    <icon-check-circle-fill v-else class="text-emerald-400 text-2xl"/>
                    <div>
                        <div class="font-semibold text-[14px]"
                             :class="legalCheckResult.hasViolations ? 'text-amber-300' : 'text-emerald-300'">
                            {{ legalCheckResult.hasViolations ? t('⚠ 发现风险') : t('✓ 内容合规') }}
                        </div>
                        <div class="text-[14px]"
                             :class="legalCheckResult.hasViolations ? 'text-amber-400/70' : 'text-emerald-400/70'">
                            {{
                                legalCheckResult.hasViolations ? `共发现 ${legalCheckResult.totalCount} 处风险` : '文案内容符合规范，可以发布'
                            }}
                        </div>
                    </div>
                </div>

                <div v-if="legalCheckResult.hasViolations" class="space-y-4">
                    <div>
                        <div class="flex items-center gap-1.5 mb-2">
                            <icon-file class="text-gray-400"/>
                            <span class="font-semibold text-[14px] text-gray-300">{{ t('原文案分析') }}</span>
                        </div>
                        <div
                            class="max-h-36 overflow-y-auto border border-[#2a2a3a] rounded-lg p-3 text-[14px] leading-relaxed bg-[#0d0d1a] text-gray-300"
                            v-html="legalCheckResult.highlightedText"
                        ></div>
                    </div>

                    <div v-if="legalCheckResult.fixedText">
                        <div class="flex items-center gap-1.5 mb-2">
                            <icon-edit class="text-emerald-400"/>
                            <span class="font-semibold text-[14px] text-gray-300">{{ t('✨ 优化后文案') }}</span>
                        </div>
                        <div
                            class="max-h-36 overflow-y-auto border border-emerald-800/40 rounded-lg p-3 text-[14px] leading-relaxed bg-emerald-950/30 text-emerald-200">
                            {{ legalCheckResult.fixedText }}
                        </div>
                    </div>

                    <div v-if="legalCheckResult.analysis">
                        <div class="flex items-center gap-1.5 mb-2">
                            <icon-bulb class="text-blue-400"/>
                            <span class="font-semibold text-[14px] text-gray-300">{{ t('📋 AI 审核解读') }}</span>
                        </div>
                        <div
                            class="p-3 bg-blue-950/30 border border-blue-800/30 rounded-lg text-[14px] text-blue-300 leading-relaxed">
                            {{ legalCheckResult.analysis }}
                        </div>
                    </div>

                    <div>
                        <div class="flex items-center gap-1.5 mb-2">
                            <icon-list class="text-red-400"/>
                            <span class="font-semibold text-[14px] text-gray-300">{{ t('风险详情') }}</span>
                        </div>
                        <div
                            class="max-h-48 overflow-y-auto border border-[#2a2a3a] rounded-lg p-2 space-y-1 bg-[#0d0d1a]">
                            <div
                                v-for="(risk, index) in legalCheckResult.risks"
                                :key="index"
                                class="flex items-start gap-3 text-[14px] p-2 rounded hover:bg-[#1a1a2e]"
                            >
                                <span
                                    class="bg-red-900/40 text-red-300 px-2 py-0.5 rounded text-[14px] font-mono whitespace-nowrap shrink-0">{{
                                        risk.word
                                    }}</span>
                                <div class="flex-1 min-w-0">
                                    <div class="flex items-center gap-1.5">
                                        <span class="text-gray-500">→</span>
                                        <span v-if="risk.recommendation"
                                              class="bg-emerald-900/40 text-emerald-300 px-2 py-0.5 rounded text-[14px]">{{
                                                risk.recommendation
                                            }}</span>
                                        <span v-else class="text-gray-500 italic text-[14px]">建议删除</span>
                                    </div>
                                    <div class="text-gray-500 mt-0.5 text-[14px]">{{ risk.reason }}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="flex justify-end gap-2 pt-3 border-t border-[#2a2a3a]">
                    <a-button @click="legalCheckDialogVisible = false" class="legal-modal-btn-close">{{
                            t('关闭')
                        }}
                    </a-button>
                    <a-button v-if="legalCheckResult.hasViolations" type="primary" @click="handleFixViolations">
                        {{ t('采用优化文案') }}
                    </a-button>
                </div>
            </div>
        </a-modal>

        <!-- 账号管理弹窗 -->
        <a-modal v-model:visible="showAccountManager" :title="''" width="640px" :footer="false"
                 modal-class="account-manager-modal" :closable="false">
            <div class="account-modal-wrapper">
                <div class="account-modal-close" @click="showAccountManager = false">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                </div>
                <div class="account-modal-header">
                    <div class="account-modal-title">
                        <svg class="w-5 h-5 text-fuchsia-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
                        </svg>
                        平台账号管理
                    </div>
                    <div class="account-modal-subtitle">统一管理多平台发布账号，授权后即可一键发布视频</div>
                </div>
                <AccountManager @change="refreshAllPlatformStatus"/>
            </div>
        </a-modal>

        <a-modal
            v-model:visible="showCustomPromptOptionsDialog"
            title=""
            :closable="false"
            :footer="false"
            width="min(1120px, calc(100vw - 16px))"
            modal-class="custom-prompt-modal"
            @cancel="showCustomPromptOptionsDialog = false"
        >
            <div class="custom-prompt-dialog custom-prompt-dialog--result-only">
                <button class="custom-prompt-modal-x" @click="showCustomPromptOptionsDialog = false" :title="$t('关闭')">
                    <icon-close/>
                </button>
                <div class="custom-prompt-dialog-head">
                    <div class="custom-prompt-dialog-title">自由创作文案</div>
                </div>

                <div v-if="isGeneratingCustomPrompt"
                     class="custom-prompt-loading-stage custom-prompt-loading-stage--solo">
                    <div class="custom-prompt-loading-core">
                        <div class="custom-prompt-loader-dots">
                            <span></span>
                            <span></span>
                            <span></span>
                            <span></span>
                        </div>
                        <div class="custom-prompt-loading-title">AI 正在创作中...</div>
                        <div class="custom-prompt-loading-desc">正在生成 3 套更适合当前视频场景的爆款文案</div>
                    </div>
                </div>

                <div v-else-if="!customPromptOptions.length" class="custom-prompt-empty custom-prompt-empty--solo">
                    <div class="custom-prompt-empty-title">还没有生成方案</div>
                    <div class="custom-prompt-empty-desc">请先在首页填写生成条件，然后点击生成爆款文案</div>
                </div>

                <div v-else class="custom-prompt-results">
                    <div
                        v-for="(option, index) in customPromptOptions"
                        :key="`custom-prompt-modal-option-${index}`"
                        class="custom-prompt-option-card custom-prompt-option-card--grid"
                        :class="{ 'is-selected': selectedCustomPromptIndex === index }"
                        @click="selectedCustomPromptIndex = index"
                    >
                        <div class="custom-prompt-option-header">
                            <div class="custom-prompt-option-title">方案 {{ index + 1 }}</div>
                            <a-button size="mini" type="primary" @click.stop="useCustomPromptOption(option)">
                                使用
                            </a-button>
                        </div>
                        <div class="custom-prompt-option-content custom-prompt-option-content--grid">
                            {{ option }}
                        </div>
                    </div>
                </div>
            </div>
        </a-modal>
    </div>
    <VideoTemplateEditDialog ref="videoTemplateEditRef" @update="() => videoTemplateSelectorRef?.refresh()"/>
    <SoundPromptEditDialog ref="soundPromptEditRef" @update="() => {}"/>
</template>

<style>
@import "../../assets/styles/elegant-theme.css";

/* 小号placeholder */
.small-placeholder .arco-input::placeholder {
    font-size: 11px !important;
}

/* IP学习页签样式：去掉竖线，加强选中区分 */
.ip-brain-tab.arco-radio-group-button .arco-radio-button::before {
    display: none !important;
    content: none !important;
    width: 0 !important;
    border-left: none !important;
}

.ip-brain-tab.arco-radio-group-button .arco-radio-button {
    border: 1px solid rgba(255, 255, 255, 0.15) !important;
    border-radius: 6px !important;
    background: rgba(255, 255, 255, 0.04) !important;
    color: #94a3b8 !important;
    transition: all 0.2s ease !important;
    position: relative !important;
}

.ip-brain-tab.arco-radio-group-button .arco-radio-button-checked {
    background: rgba(59, 130, 246, 0.15) !important;
    border-color: rgba(59, 130, 246, 0.3) !important;
    color: #93c5fd !important;
    font-weight: 500 !important;
}

.ip-brain-tab.arco-radio-group-button .arco-radio-button:hover:not(.arco-radio-button-checked) {
    background: rgba(255, 255, 255, 0.08) !important;
    border-color: rgba(255, 255, 255, 0.25) !important;
    color: #e2e8f0 !important;
}

/* 全局覆盖：强制显示浅色背景下的复选框边框 */
.force-light-checkbox .arco-checkbox-icon {
    border: 1px solid #86909c !important; /* 灰色边框 */
    background-color: white !important;
}

.force-light-checkbox:hover .arco-checkbox-icon {
    border-color: #165dff !important;
}

.force-light-checkbox.arco-checkbox-checked .arco-checkbox-icon {
    background-color: #165dff !important;
    border-color: #165dff !important;
    color: white !important;
}

.custom-prompt-modal .arco-modal {
    display: flex !important;
    flex-direction: column !important;
    width: min(1120px, calc(100vw - 16px)) !important;
    max-width: calc(100vw - 16px) !important;
    max-height: calc(100vh - 16px) !important;
    margin: 8px auto !important;
    background: radial-gradient(circle at top left, rgba(14, 165, 233, 0.18), transparent 28%),
    radial-gradient(circle at top right, rgba(168, 85, 247, 0.16), transparent 24%),
    linear-gradient(180deg, #09111f 0%, #0f172a 100%) !important;
    border: 1px solid rgba(56, 189, 248, 0.22) !important;
    box-shadow: 0 24px 80px rgba(2, 6, 23, 0.55) !important;
}

.custom-prompt-modal,
.custom-prompt-modal .arco-modal-container,
.custom-prompt-modal .arco-modal-wrapper {
    background: transparent !important;
}

.custom-prompt-modal .arco-modal-content {
    display: flex !important;
    flex-direction: column !important;
    max-height: calc(100vh - 16px) !important;
    background: radial-gradient(circle at top left, rgba(14, 165, 233, 0.18), transparent 28%),
    radial-gradient(circle at top right, rgba(168, 85, 247, 0.16), transparent 24%),
    linear-gradient(180deg, #09111f 0%, #0f172a 100%) !important;
    border-radius: 24px !important;
    overflow: hidden !important;
}

.custom-prompt-modal .arco-modal-header {
    display: none !important;
}

.custom-prompt-modal-x {
    position: absolute;
    top: 10px;
    right: 14px;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--theme-text-secondary, #94a3b8);
    cursor: pointer;
    font-size: 14px;
}

.custom-prompt-modal-x:hover {
    color: var(--theme-text-primary, #f8fafc);
    background: rgba(100, 116, 139, 0.16);
}

.custom-prompt-modal .arco-modal-title {
    color: #e2e8f0 !important;
    font-weight: 700 !important;
}

.custom-prompt-modal .arco-modal-close-btn {
    color: #94a3b8 !important;
}

.custom-prompt-modal .arco-modal-close-btn:hover {
    color: #f8fafc !important;
    background: rgba(30, 41, 59, 0.85) !important;
}

.custom-prompt-modal .arco-modal-body {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    background: transparent !important;
    max-height: calc(100vh - 32px) !important;
    overflow: auto !important;
    padding: 20px 20px 18px !important;
    scrollbar-width: thin;
    scrollbar-color: rgba(100, 116, 139, 0.45) transparent;
}

.custom-prompt-modal .arco-btn:not(.arco-btn-primary) {
    color: #e2e8f0 !important;
    border-color: rgba(71, 85, 105, 0.88) !important;
    background: rgba(15, 23, 42, 0.88) !important;
}

.custom-prompt-modal .arco-btn:not(.arco-btn-primary):hover {
    color: #fff7ed !important;
    border-color: rgba(251, 191, 36, 0.34) !important;
    background: rgba(30, 41, 59, 0.96) !important;
}

.custom-prompt-modal .dark-input-override.arco-input-wrapper,
.custom-prompt-modal .dark-input-override .arco-input-wrapper,
.custom-prompt-modal .dark-input-override.arco-textarea-wrapper,
.custom-prompt-modal .dark-input-override .arco-textarea-wrapper,
.custom-prompt-modal .dark-input-override.arco-select-view,
.custom-prompt-modal .dark-input-override .arco-select-view,
.custom-prompt-modal .dark-input-override.arco-input-number,
.custom-prompt-modal .dark-input-override .arco-input-number {
    background: rgba(15, 23, 42, 0.94) !important;
    border-color: rgba(71, 85, 105, 0.9) !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03) !important;
}

.custom-prompt-modal .dark-input-override.arco-input-wrapper:hover,
.custom-prompt-modal .dark-input-override .arco-input-wrapper:hover,
.custom-prompt-modal .dark-input-override.arco-textarea-wrapper:hover,
.custom-prompt-modal .dark-input-override .arco-textarea-wrapper:hover,
.custom-prompt-modal .dark-input-override.arco-select-view:hover,
.custom-prompt-modal .dark-input-override .arco-select-view:hover,
.custom-prompt-modal .dark-input-override.arco-input-number:hover,
.custom-prompt-modal .dark-input-override .arco-input-number:hover {
    border-color: rgba(251, 191, 36, 0.34) !important;
    background: rgba(15, 23, 42, 0.98) !important;
}

.custom-prompt-modal .dark-input-override.arco-input-focus,
.custom-prompt-modal .dark-input-override .arco-input-focus,
.custom-prompt-modal .dark-input-override.arco-textarea-focus,
.custom-prompt-modal .dark-input-override .arco-textarea-focus,
.custom-prompt-modal .dark-input-override.arco-select-view-focus,
.custom-prompt-modal .dark-input-override .arco-select-view-focus,
.custom-prompt-modal .dark-input-override.arco-input-number-focus,
.custom-prompt-modal .dark-input-override .arco-input-number-focus {
    border-color: rgba(251, 191, 36, 0.54) !important;
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.12) !important;
}

.custom-prompt-modal .dark-input-override input,
.custom-prompt-modal .dark-input-override textarea,
.custom-prompt-modal .dark-input-override .arco-select-view-value,
.custom-prompt-modal .dark-input-override .arco-input-number-input {
    color: #f8fafc !important;
    background: transparent !important;
}

.custom-prompt-modal .dark-input-override input::placeholder,
.custom-prompt-modal .dark-input-override textarea::placeholder,
.custom-prompt-modal .dark-input-override .arco-select-view-placeholder,
.custom-prompt-modal .dark-input-override .arco-input-number-input::placeholder {
    color: rgba(148, 163, 184, 0.82) !important;
}

.custom-prompt-modal .dark-input-override .arco-input-number-step-button,
.custom-prompt-modal .dark-input-override .arco-input-number-mode-button {
    color: #cbd5e1 !important;
    background: rgba(30, 41, 59, 0.88) !important;
    border-color: rgba(71, 85, 105, 0.78) !important;
}

.custom-prompt-modal .dark-input-override .arco-input-number-step-button:hover,
.custom-prompt-modal .dark-input-override .arco-input-number-mode-button:hover {
    color: #fff7ed !important;
    background: rgba(51, 65, 85, 0.96) !important;
}

.custom-prompt-modal .arco-slider-runway {
    background: rgba(51, 65, 85, 0.68) !important;
}

.custom-prompt-modal .arco-slider-bar {
    background: linear-gradient(90deg, #f59e0b, #f97316) !important;
}

.custom-prompt-modal .arco-slider-button {
    border-color: #fbbf24 !important;
    background: #fff7ed !important;
    box-shadow: 0 0 0 4px rgba(251, 191, 36, 0.14) !important;
}

.custom-prompt-dropdown {
    background: rgba(9, 15, 28, 0.98) !important;
    border: 1px solid rgba(71, 85, 105, 0.88) !important;
    box-shadow: 0 18px 40px rgba(2, 6, 23, 0.46) !important;
    backdrop-filter: blur(10px);
}

.custom-prompt-dropdown .arco-select-option {
    color: #e2e8f0 !important;
    background: transparent !important;
}

.custom-prompt-dropdown .arco-select-option:hover,
.custom-prompt-dropdown .arco-select-option-active {
    color: #fff7ed !important;
    background: rgba(51, 65, 85, 0.72) !important;
}

.custom-prompt-dropdown .arco-select-option-selected {
    color: #fde68a !important;
    background: linear-gradient(90deg, rgba(245, 158, 11, 0.18), rgba(249, 115, 22, 0.16)) !important;
}
</style>

<style scoped>

.video-agent-top-workbar {
    position: relative;
    width: 100%;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    pointer-events: none;
}

.video-agent-top-workbar > * {
    pointer-events: auto;
}

.video-agent-top-workbar__title {
    flex: 0 0 auto;
    color: #f8fafc;
    font-size: 19px;
    font-weight: 800;
    line-height: 1;
    white-space: nowrap;
    letter-spacing: 0.01em;
    text-shadow: 0 0 18px rgba(34, 211, 238, 0.16);
}

.video-agent-top-workbar__actions {
    position: absolute;
    left: calc(50% + 128px);
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 72px;
}

.video-agent-top-btn {
    width: auto !important;
    height: auto !important;
    flex: 0 0 auto !important;
    padding: 0 !important;
    border-radius: 0 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 8px;
    border: 0 !important;
    background: transparent !important;
    color: #cbd5e1 !important;
    font-size: 15px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
    transition: all 0.18s ease;
    box-shadow: none !important;
    cursor: pointer;
}

.video-agent-top-btn--primary {
    color: #9ca3af !important;
}

.video-agent-top-btn--primary:hover {
    color: #67e8f9 !important;
    text-shadow: 0 0 14px rgba(103, 232, 249, 0.55);
}

.video-agent-top-btn--muted {
    color: #9ca3af !important;
}

.video-agent-top-btn--muted:hover {
    color: #67e8f9 !important;
    text-shadow: 0 0 14px rgba(103, 232, 249, 0.55);
}

.video-agent-top-btn--danger {
    color: #9ca3af !important;
}

.video-agent-top-btn--danger:hover {
    color: #fb7185 !important;
    text-shadow: 0 0 14px rgba(251, 113, 133, 0.48);
}

.video-agent-top-btn--primary:focus-visible,
.video-agent-top-btn--muted:focus-visible,
.video-agent-top-btn--danger:focus-visible,
.video-agent-top-btn--primary:active,
.video-agent-top-btn--muted:active {
    color: #67e8f9 !important;
    outline: none !important;
    text-shadow: 0 0 14px rgba(103, 232, 249, 0.55);
}

.video-agent-top-btn--danger:active {
    color: #fb7185 !important;
    outline: none !important;
    text-shadow: 0 0 14px rgba(251, 113, 133, 0.48);
}

.video-agent-top-btn--running,
.video-agent-top-btn--running:disabled {
    color: #67e8f9 !important;
    opacity: 1;
    text-shadow: 0 0 14px rgba(103, 232, 249, 0.55);
}

.video-agent-top-btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
    transform: none;
    box-shadow: none;
}

@media (max-width: 1500px) {
    .video-agent-top-workbar {
        gap: 14px;
    }

    .video-agent-top-workbar__title {
        font-size: 16px;
    }

    .video-agent-top-workbar__actions {
        left: calc(50% + 70px);
        gap: 42px;
    }

    .video-agent-top-btn {
        width: auto !important;
        flex-basis: auto !important;
        height: auto !important;
        font-size: 14px;
    }
}

/* 状态面板动态效果 */
@keyframes shimmer {
    0% {
        transform: translateX(-100%);
    }
    100% {
        transform: translateX(100%);
    }
}

.animate-shimmer {
    animation: shimmer 2s ease-in-out infinite;
}

@property --border-angle {
    syntax: '<angle>';
    initial-value: 0deg;
    inherits: false;
}
@keyframes border-spin {
    0% {
        --border-angle: 0deg;
    }
    100% {
        --border-angle: 360deg;
    }
}

.animate-border-spin {
    animation: border-spin 3s linear infinite;
}

.group:hover .animate-border-spin {
    animation-duration: 1s;
}

@keyframes progress-shimmer {
    0% {
        width: 0%;
    }
    50% {
        width: 70%;
    }
    100% {
        width: 100%;
    }
}

.animate-progress-shimmer {
    animation: progress-shimmer 1.5s ease-in-out infinite;
}

@keyframes pulse-glow {
    0%, 100% {
        box-shadow: 0 0 10px rgba(239, 68, 68, 0.4);
    }
    50% {
        box-shadow: 0 0 25px rgba(239, 68, 68, 0.7);
    }
}

.animate-pulse-glow {
    animation: pulse-glow 1.5s ease-in-out infinite;
}

@keyframes pulse-border {
    0%, 100% {
        box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4);
    }
    50% {
        box-shadow: 0 0 0 4px rgba(239, 68, 68, 0);
    }
}

.animate-pulse-border {
    animation: pulse-border 1s ease-in-out infinite;
}

@keyframes bounce-bar {
    0%, 100% {
        transform: scaleY(0.3);
        opacity: 0.4;
    }
    50% {
        transform: scaleY(1);
        opacity: 1;
    }
}

.animate-bounce-bar {
    animation: bounce-bar 0.5s ease-in-out infinite;
}

@keyframes stop-icon {
    0%, 100% {
        transform: scale(1);
    }
    50% {
        transform: scale(0.9);
    }
}

.animate-stop-icon {
    animation: stop-icon 0.3s ease-in-out infinite;
}

/* 生成口播视频区域的模型选择框 - 匹配语音模型选择框样式 */
.video-gen-model-selector :deep(.arco-select) {
    min-width: 0 !important;
    width: 100% !important;
}

.video-gen-model-selector :deep(.arco-select-view-single) {
    background: #2a2a2a;
    border-color: #374151;
    color: #e5e7eb;
    border-radius: 0.5rem;
    height: 32px;
}

/* 保留部分特定于本页面的样式 */
.cyberpunk-dashboard {
    /* 页面特定布局样式 */
}

/* 深色文本域样式 */
.custom-dark-textarea {
    background-color: rgba(30, 35, 45, 0.7) !important;
    border: 1px solid rgba(59, 130, 246, 0.3) !important;
    color: #f3f4f6 !important;
    border-radius: 8px;
}

.custom-dark-textarea:focus {
    background-color: rgba(30, 35, 45, 0.8) !important;
    border-color: #3b82f6 !important;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1) !important;
}

.custom-dark-textarea::placeholder {
    color: #9ca3af !important;
}

.custom-prompt-dialog {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    max-height: calc(100vh - 104px);
}

.custom-prompt-dialog--result-only {
    gap: 12px;
    min-height: 0;
}

.custom-prompt-dialog-head {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding: 0 0 10px;
}

.custom-prompt-dialog-head::after {
    content: "";
    position: absolute;
    left: 0;
    bottom: 0;
    width: 100%;
    height: 1px;
    background: linear-gradient(90deg, rgba(168, 85, 247, 0.56), rgba(168, 85, 247, 0.18), rgba(168, 85, 247, 0));
}

.custom-prompt-dialog-title {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: var(--theme-text-primary, #f3f4f6);
}

.custom-prompt-results {
    position: relative;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
    min-height: 0;
    padding: 18px;
    border-radius: 18px;
    border: 1px solid rgba(168, 85, 247, 0.26);
    background: linear-gradient(180deg, rgba(17, 24, 39, 0.96), rgba(17, 24, 39, 0.88)),
    radial-gradient(circle at top, rgba(168, 85, 247, 0.06), transparent 56%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.custom-prompt-results::before {
    content: "";
    position: absolute;
    inset: 10px;
    border-radius: 14px;
    border: 1px solid rgba(168, 85, 247, 0.12);
    pointer-events: none;
}

.custom-prompt-option-card--grid {
    min-height: 0;
}

.custom-prompt-option-content--grid {
    max-height: none;
    min-height: 0;
    padding-right: 0;
}

.custom-prompt-loading-stage--solo,
.custom-prompt-empty--solo {
    min-height: 420px;
}

.custom-prompt-loading-core {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 18px 0;
}

.custom-prompt-loader-dots {
    position: relative;
    width: 92px;
    height: 92px;
    animation: customPromptDotsSpin 2.2s linear infinite;
}

.custom-prompt-loader-dots span {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 14px;
    height: 14px;
    border-radius: 999px;
    background: linear-gradient(180deg, #fde68a, #f59e0b);
    box-shadow: 0 0 20px rgba(245, 158, 11, 0.3);
    transform: translate(-50%, -50%);
}

.custom-prompt-loader-dots span:nth-child(1) {
    top: 8px;
}

.custom-prompt-loader-dots span:nth-child(2) {
    left: auto;
    right: 8px;
    top: 50%;
    transform: translate(50%, -50%);
}

.custom-prompt-loader-dots span:nth-child(3) {
    top: auto;
    bottom: 8px;
    transform: translate(-50%, 50%);
}

.custom-prompt-loader-dots span:nth-child(4) {
    left: 8px;
    top: 50%;
    transform: translate(-50%, -50%);
}

.custom-prompt-hero {
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 20px 22px;
    border: 1px solid rgba(251, 191, 36, 0.18);
    border-radius: 22px;
    background: radial-gradient(circle at 0% 0%, rgba(249, 115, 22, 0.26), transparent 34%),
    radial-gradient(circle at 100% 0%, rgba(34, 211, 238, 0.22), transparent 28%),
    linear-gradient(135deg, rgba(41, 24, 13, 0.96), rgba(10, 25, 41, 0.92) 58%, rgba(15, 23, 42, 0.96));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 20px 50px rgba(2, 6, 23, 0.38);
}

.custom-prompt-hero::before {
    content: "";
    position: absolute;
    inset: auto -20% -60% auto;
    width: 240px;
    height: 240px;
    border-radius: 999px;
    background: radial-gradient(circle, rgba(56, 189, 248, 0.16), transparent 68%);
    pointer-events: none;
}

.custom-prompt-hero.is-generating::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(110deg, transparent 0%, rgba(255, 255, 255, 0.08) 35%, transparent 65%);
    transform: translateX(-120%);
    animation: customPromptHeroSweep 2.6s ease-in-out infinite;
    pointer-events: none;
}

.custom-prompt-hero-copy {
    position: relative;
    z-index: 1;
    min-width: 0;
}

.custom-prompt-hero-title {
    font-size: 19px;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: #fff7ed;
}

.custom-prompt-hero-desc {
    margin-top: 6px;
    font-size: 13px;
    line-height: 1.7;
    color: rgba(255, 237, 213, 0.82);
}

.custom-prompt-hero-steps {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
}

.custom-prompt-step-chip {
    display: inline-flex;
    align-items: center;
    min-height: 30px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid rgba(148, 163, 184, 0.2);
    background: rgba(15, 23, 42, 0.44);
    color: #f8fafc;
    font-size: 12px;
    font-weight: 600;
    backdrop-filter: blur(6px);
}

.custom-prompt-hero-badge {
    position: relative;
    z-index: 1;
    flex-shrink: 0;
    min-width: 92px;
    text-align: center;
    padding: 10px 14px;
    border-radius: 999px;
    border: 1px solid rgba(251, 191, 36, 0.28);
    background: rgba(251, 191, 36, 0.12);
    color: #fde68a;
    font-size: 12px;
    font-weight: 600;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.custom-prompt-hero-badge.is-generating {
    animation: customPromptBadgePulse 1.8s ease-in-out infinite;
}

.custom-prompt-layout {
    display: grid;
    grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
    gap: 12px;
    min-height: 0;
}

.custom-prompt-panel {
    min-height: 0;
    padding: 16px;
    border-radius: 18px;
    border: 1px solid rgba(71, 85, 105, 0.72);
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(15, 23, 42, 0.92)),
    linear-gradient(135deg, rgba(251, 191, 36, 0.04), transparent 28%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 18px 40px rgba(2, 6, 23, 0.28);
}

.custom-prompt-panel-header {
    margin-bottom: 12px;
}

.custom-prompt-panel-title {
    font-size: 15px;
    font-weight: 700;
    color: #fef3c7;
}

.custom-prompt-panel-subtitle {
    margin-top: 4px;
    font-size: 12px;
    color: #94a3b8;
}

.custom-prompt-form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
}

.custom-prompt-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px;
    border-radius: 18px;
    border: 1px solid rgba(71, 85, 105, 0.52);
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.9), rgba(15, 23, 42, 0.72)),
    radial-gradient(circle at top right, rgba(56, 189, 248, 0.06), transparent 32%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.custom-prompt-field-span-2 {
    grid-column: span 2;
}

.custom-prompt-form-grid > .custom-prompt-field:nth-child(1),
.custom-prompt-form-grid > .custom-prompt-field:nth-child(2) {
    border-color: rgba(251, 191, 36, 0.18);
    background: linear-gradient(180deg, rgba(38, 23, 12, 0.88), rgba(15, 23, 42, 0.72)),
    radial-gradient(circle at top right, rgba(249, 115, 22, 0.12), transparent 34%);
}

.custom-prompt-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: #f8fafc;
}

.custom-prompt-required {
    color: #fb7185;
}

.custom-prompt-optional {
    color: #94a3b8;
    font-size: 12px;
    font-weight: 500;
}

.custom-prompt-wordcount {
    margin-top: 16px;
    padding: 14px;
    border-radius: 18px;
    border: 1px solid rgba(71, 85, 105, 0.52);
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.88), rgba(15, 23, 42, 0.72)),
    radial-gradient(circle at top right, rgba(251, 191, 36, 0.07), transparent 30%);
}

.custom-prompt-wordcount-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
}

.custom-prompt-actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 18px;
    padding-top: 6px;
}

.custom-prompt-progress {
    font-size: 12px;
    line-height: 1.6;
    color: #67e8f9;
    min-height: 20px;
}

.custom-prompt-loading-stage {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: min(320px, calc(100vh - 280px));
    padding: 22px 18px;
    border-radius: 18px;
    border: 1px solid rgba(45, 212, 191, 0.22);
    background: radial-gradient(circle at top, rgba(34, 211, 238, 0.14), transparent 30%),
    linear-gradient(180deg, rgba(12, 18, 34, 0.96), rgba(15, 23, 42, 0.88));
}

.custom-prompt-loading-stage::before {
    content: "";
    position: absolute;
    inset: auto auto -80px -80px;
    width: 200px;
    height: 200px;
    border-radius: 999px;
    background: radial-gradient(circle, rgba(249, 115, 22, 0.16), transparent 68%);
    pointer-events: none;
}

.custom-prompt-loader-orbit {
    position: relative;
    width: 118px;
    height: 118px;
}

.custom-prompt-loader-core,
.custom-prompt-loader-ring {
    position: absolute;
    inset: 0;
    border-radius: 999px;
}

.custom-prompt-loader-core {
    inset: 34px;
    background: radial-gradient(circle, rgba(251, 191, 36, 0.95), rgba(249, 115, 22, 0.9));
    box-shadow: 0 0 28px rgba(249, 115, 22, 0.45);
}

.custom-prompt-loader-ring {
    border: 1px solid rgba(103, 232, 249, 0.18);
}

.custom-prompt-loader-ring::after {
    content: "";
    position: absolute;
    top: -3px;
    left: 50%;
    width: 8px;
    height: 8px;
    margin-left: -4px;
    border-radius: 999px;
    background: #67e8f9;
    box-shadow: 0 0 14px rgba(103, 232, 249, 0.9);
}

.custom-prompt-loader-ring.ring-a {
    animation: customPromptOrbit 2.4s linear infinite;
}

.custom-prompt-loader-ring.ring-b {
    inset: 10px;
    border-color: rgba(251, 191, 36, 0.2);
    animation: customPromptOrbitReverse 2.8s linear infinite;
}

.custom-prompt-loader-ring.ring-c {
    inset: 20px;
    border-color: rgba(248, 113, 113, 0.18);
    animation: customPromptOrbit 1.9s linear infinite;
}

.custom-prompt-loading-title {
    margin-top: 2px;
    font-size: 18px;
    font-weight: 700;
    color: #f8fafc;
}

.custom-prompt-loading-desc {
    max-width: 420px;
    margin-top: 8px;
    text-align: center;
    font-size: 13px;
    line-height: 1.8;
    color: #94a3b8;
}

:global(body[data-theme="soft-light"] .custom-prompt-dialog--result-only) {
    background: transparent !important;
}

:global(body[data-theme="soft-light"] .custom-prompt-loading-stage) {
    border-color: rgba(132, 142, 220, 0.24) !important;
    background: radial-gradient(circle at top, rgba(106, 116, 247, 0.10), transparent 28%),
    linear-gradient(180deg, rgba(248, 250, 255, 0.98), rgba(236, 240, 250, 0.95)) !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.92),
    0 20px 46px rgba(104, 110, 170, 0.12) !important;
}

:global(body[data-theme="soft-light"] .custom-prompt-loading-stage::before) {
    background: radial-gradient(circle, rgba(249, 115, 22, 0.08), transparent 68%) !important;
}

:global(body[data-theme="soft-light"] .custom-prompt-loading-title) {
    color: #1f2749 !important;
    text-shadow: none !important;
    filter: none !important;
    -webkit-text-stroke: 0 !important;
}

:global(body[data-theme="soft-light"] .custom-prompt-loading-desc) {
    color: #5f6d98 !important;
    text-shadow: none !important;
    filter: none !important;
    -webkit-text-stroke: 0 !important;
}

.custom-prompt-loading-cards {
    width: 100%;
    margin-top: 24px;
    display: grid;
    gap: 12px;
}

.custom-prompt-skeleton-card {
    position: relative;
    overflow: hidden;
    padding: 16px;
    border-radius: 18px;
    border: 1px solid rgba(71, 85, 105, 0.46);
    background: rgba(15, 23, 42, 0.72);
}

.custom-prompt-skeleton-card::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(110deg, transparent 18%, rgba(255, 255, 255, 0.08) 42%, transparent 68%);
    transform: translateX(-120%);
    animation: customPromptSkeletonSweep 1.8s ease-in-out infinite;
}

.custom-prompt-skeleton-card:nth-child(2)::after {
    animation-delay: 0.2s;
}

.custom-prompt-skeleton-card:nth-child(3)::after {
    animation-delay: 0.4s;
}

.custom-prompt-skeleton-top {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
}

.custom-prompt-skeleton-dot {
    width: 12px;
    height: 12px;
    border-radius: 999px;
    background: rgba(251, 191, 36, 0.7);
}

.custom-prompt-skeleton-line {
    display: block;
    width: 100%;
    height: 10px;
    margin-top: 10px;
    border-radius: 999px;
    background: linear-gradient(90deg, rgba(51, 65, 85, 0.9), rgba(71, 85, 105, 0.66));
}

.custom-prompt-skeleton-line.short {
    width: 96px;
    margin-top: 0;
}

.custom-prompt-skeleton-line.medium {
    width: 78%;
}

.custom-prompt-empty {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    min-height: min(220px, calc(100vh - 300px));
    padding: 18px;
    border-radius: 16px;
    border: 1px dashed rgba(56, 189, 248, 0.28);
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.72), rgba(2, 6, 23, 0.72));
}

.custom-prompt-empty-title {
    font-size: 16px;
    font-weight: 700;
    color: #f8fafc;
}

.custom-prompt-empty-desc {
    margin-top: 8px;
    font-size: 13px;
    line-height: 1.7;
    color: #94a3b8;
}

.custom-prompt-empty-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
}

.custom-prompt-empty-tag {
    display: inline-flex;
    align-items: center;
    min-height: 30px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid rgba(251, 191, 36, 0.18);
    background: rgba(251, 191, 36, 0.08);
    color: #fde68a;
    font-size: 12px;
    font-weight: 600;
}

.custom-prompt-options {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: calc(100vh - 300px);
    overflow: auto;
    padding-right: 4px;
    scrollbar-width: thin;
    scrollbar-color: rgba(100, 116, 139, 0.45) transparent;
}

.custom-prompt-option-card {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding: 16px;
    border-radius: 14px;
    border: 1px solid rgba(139, 92, 246, 0.22);
    background: linear-gradient(180deg, rgba(31, 41, 55, 0.96), rgba(31, 41, 55, 0.9));
    cursor: pointer;
    transition: border-color 0.24s ease, transform 0.24s ease, box-shadow 0.24s ease, background 0.24s ease;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.custom-prompt-option-poster {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 12px;
}

.custom-prompt-option-rank {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 48px;
    height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid rgba(251, 191, 36, 0.24);
    background: rgba(251, 191, 36, 0.1);
    color: #fde68a;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
}

.custom-prompt-option-accent {
    width: 78px;
    height: 6px;
    border-radius: 999px;
    background: linear-gradient(90deg, rgba(249, 115, 22, 0.82), rgba(56, 189, 248, 0.9));
    box-shadow: 0 0 18px rgba(56, 189, 248, 0.16);
}

.custom-prompt-option-card:hover {
    border-color: rgba(168, 85, 247, 0.36);
    transform: translateY(-2px);
    box-shadow: 0 14px 28px rgba(2, 6, 23, 0.2);
}

.custom-prompt-option-card.is-selected {
    border-color: rgba(99, 102, 241, 0.5);
    background: linear-gradient(180deg, rgba(30, 41, 59, 0.98), rgba(30, 41, 59, 0.94));
    box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.18), 0 18px 34px rgba(37, 99, 235, 0.12);
}

.custom-prompt-option-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    position: relative;
    z-index: 1;
}

.custom-prompt-option-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
}

.custom-prompt-option-radio {
    width: 16px;
    height: 16px;
    border-radius: 999px;
    border: 1px solid rgba(100, 116, 139, 0.9);
    background: transparent;
    flex-shrink: 0;
}

.custom-prompt-option-card.is-selected .custom-prompt-option-radio {
    border-color: #fbbf24;
    background: linear-gradient(135deg, #fbbf24, #f97316);
    box-shadow: inset 0 0 0 3px #0f172a;
}

.custom-prompt-option-title {
    display: inline-flex;
    align-items: center;
    min-height: 34px;
    padding: 0;
    border-radius: 0;
    border: 0;
    background: transparent;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.01em;
    color: #f8fafc;
}

.custom-prompt-option-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
}

.custom-prompt-option-tag {
    display: inline-flex;
    align-items: center;
    min-height: 26px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid rgba(71, 85, 105, 0.76);
    background: rgba(15, 23, 42, 0.78);
    color: #cbd5e1;
    font-size: 11px;
    font-weight: 600;
}

.custom-prompt-option-card.is-selected .custom-prompt-option-tag {
    border-color: rgba(251, 191, 36, 0.24);
    color: #fff7ed;
    background: rgba(60, 33, 10, 0.58);
}

.custom-prompt-option-content {
    position: relative;
    z-index: 1;
    margin-top: 14px;
    padding: 0 4px 0 0;
    border: 0;
    background: transparent;
    font-size: 14px;
    line-height: 1.9;
    white-space: pre-wrap;
    color: #e5e7eb;
    max-height: min(180px, calc(100vh - 420px));
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(100, 116, 139, 0.45) transparent;
}

.custom-prompt-option-card.is-selected .custom-prompt-option-content {
    max-height: min(260px, calc(100vh - 380px));
}

.custom-prompt-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding-top: 2px;
}

.custom-prompt-option-header .arco-btn {
    min-width: 72px;
    border-radius: 999px;
    font-weight: 700;
    box-shadow: 0 10px 22px rgba(14, 165, 233, 0.18);
}

.custom-prompt-modal .arco-modal-body::-webkit-scrollbar,
.custom-prompt-options::-webkit-scrollbar,
.custom-prompt-option-content::-webkit-scrollbar {
    width: 8px;
    height: 8px;
}

.custom-prompt-modal .arco-modal-body::-webkit-scrollbar-track,
.custom-prompt-options::-webkit-scrollbar-track,
.custom-prompt-option-content::-webkit-scrollbar-track {
    background: transparent;
    border-radius: 999px;
}

.custom-prompt-modal .arco-modal-body::-webkit-scrollbar-thumb,
.custom-prompt-options::-webkit-scrollbar-thumb,
.custom-prompt-option-content::-webkit-scrollbar-thumb {
    background: rgba(100, 116, 139, 0.45);
    border-radius: 999px;
    border: 2px solid transparent;
    background-clip: padding-box;
}

.custom-prompt-modal .arco-modal-body::-webkit-scrollbar-thumb:hover,
.custom-prompt-options::-webkit-scrollbar-thumb:hover,
.custom-prompt-option-content::-webkit-scrollbar-thumb:hover {
    background: rgba(148, 163, 184, 0.65);
    background-clip: padding-box;
}

@keyframes customPromptOrbit {
    from {
        transform: rotate(0deg);
    }
    to {
        transform: rotate(360deg);
    }
}

@keyframes customPromptOrbitReverse {
    from {
        transform: rotate(360deg);
    }
    to {
        transform: rotate(0deg);
    }
}

@keyframes customPromptSkeletonSweep {
    from {
        transform: translateX(-120%);
    }
    to {
        transform: translateX(120%);
    }
}

@keyframes customPromptBadgePulse {
    0%,
    100% {
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 0 0 rgba(251, 191, 36, 0);
    }
    50% {
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 0 0 8px rgba(251, 191, 36, 0.06);
    }
}

@keyframes customPromptHeroSweep {
    from {
        transform: translateX(-120%);
    }
    to {
        transform: translateX(120%);
    }
}

@keyframes customPromptDotsSpin {
    0% {
        transform: rotate(0deg);
    }
    100% {
        transform: rotate(360deg);
    }
}

@media (max-width: 1180px), (max-height: 900px) {
    .custom-prompt-layout {
        grid-template-columns: 1fr;
    }

    .custom-prompt-results {
        grid-template-columns: 1fr;
    }

    .custom-prompt-form-grid {
        grid-template-columns: 1fr;
    }

    .custom-prompt-field-span-2 {
        grid-column: auto;
    }

    .custom-prompt-hero {
        flex-direction: column;
    }
}

@media (max-height: 860px) {
    .custom-prompt-dialog {
        gap: 10px;
        max-height: calc(100vh - 82px);
    }

    .custom-prompt-hero,
    .custom-prompt-panel {
        padding: 14px;
        border-radius: 16px;
    }

    .custom-prompt-loading-stage {
        min-height: min(240px, calc(100vh - 240px));
        padding: 16px 14px;
    }

    .custom-prompt-empty {
        min-height: min(180px, calc(100vh - 250px));
    }

    .custom-prompt-options {
        max-height: calc(100vh - 250px);
    }

    .custom-prompt-option-content {
        max-height: min(132px, calc(100vh - 360px));
    }

    .custom-prompt-option-card.is-selected .custom-prompt-option-content {
        max-height: min(188px, calc(100vh - 320px));
    }
}

/* 强制覆盖 Arco Design 的样式以适配深色主题 */
:deep(.arco-checkbox-label),
:deep(.arco-radio-label) {
    color: #e2e8f0 !important; /* text-slate-200 */
}

:deep(.arco-checkbox-checked .arco-checkbox-label),
:deep(.arco-radio-checked .arco-radio-label) {
    color: #fff !important;
    font-weight: 500;
}

:deep(.arco-checkbox-icon) {
    border-color: rgba(255, 255, 255, 0.3);
    background-color: rgba(255, 255, 255, 0.05);
}


/* 统一主按钮主题 */
:global(.video-ip-agent-shell .arco-btn-primary) {
    background: linear-gradient(to right, #0f766e, #0891b2) !important; /* teal-700 to cyan-600 */
    border: none !important;
    color: #ffffff !important;
    box-shadow: 0 10px 15px -3px rgba(8, 145, 178, 0.22) !important;
}

:global(.video-ip-agent-shell .arco-btn-primary:hover:not(:disabled)) {
    background: linear-gradient(to right, #0d9488, #06b6d4) !important; /* teal-600 to cyan-500 */
    box-shadow: 0 0 15px rgba(6, 182, 212, 0.35) !important;
    transform: translateY(-2px);
}

:global(.video-ip-agent-shell .arco-btn-primary:focus),
:global(.video-ip-agent-shell .arco-btn-primary:focus-visible),
:global(.video-ip-agent-shell .arco-btn-primary.arco-btn-status-normal:active),
:global(.video-ip-agent-shell .arco-btn-primary.arco-btn-loading) {
    background: linear-gradient(to right, #0d9488, #06b6d4) !important;
    border: none !important;
    color: #ffffff !important;
    box-shadow: 0 0 0 1px rgba(6, 182, 212, 0.8), 0 0 18px rgba(6, 182, 212, 0.32) !important;
}

:global(.video-ip-agent-shell .arco-btn-primary.arco-btn-disabled) {
    background: rgba(15, 118, 110, 0.22) !important;
    border-color: transparent !important;
    box-shadow: none !important;
    color: rgba(255, 255, 255, 0.3) !important;
}

@property --border-angle {
    syntax: '<angle>';
    initial-value: 0deg;
    inherits: false;
}

@keyframes spinning-border-rotate {
    0% {
        --border-angle: 0deg;
    }
    100% {
        --border-angle: 360deg;
    }
}

:global(body[data-theme] .video-ip-agent-shell .section-processing) {
    position: relative !important;
    overflow: hidden !important;
    isolation: isolate !important;
    background-origin: border-box !important;
    background-clip: padding-box, border-box !important;
}

:global(body[data-theme] .video-ip-agent-shell .section-processing > *) {
    position: relative !important;
    z-index: 1 !important;
}

:global(body[data-theme] .video-ip-agent-shell .section-processing::before),
:global(body[data-theme] .video-ip-agent-shell .section-processing::after) {
    content: none !important;
    display: none !important;
    animation: none !important;
    background: none !important;
}

:global(body[data-theme="dark"] .video-ip-agent-shell .section-processing) {
    border: 2px solid transparent !important;
    background-image: linear-gradient(180deg, rgba(20, 22, 30, 0.98) 0%, rgba(11, 12, 18, 0.98) 100%),
    conic-gradient(
        from var(--border-angle),
        transparent 0%,
        transparent 66%,
        rgba(56, 189, 248, 0.92) 79%,
        rgba(59, 130, 246, 1) 86%,
        rgba(139, 92, 246, 0.92) 93%,
        transparent 100%
    ) !important;
    box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.12),
    0 0 18px rgba(59, 130, 246, 0.12),
    0 0 32px rgba(139, 92, 246, 0.08) !important;
    animation: spinning-border-rotate 2.8s linear infinite !important;
}

:global(body[data-theme="dark"] .video-ip-agent-shell .section-processing:hover) {
    box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.16),
    0 0 24px rgba(59, 130, 246, 0.16),
    0 0 40px rgba(139, 92, 246, 0.12) !important;
}

:global(body[data-theme="soft-light"] .video-ip-agent-shell .section-processing) {
    border: 2px solid transparent !important;
    background-image: linear-gradient(180deg, rgba(255, 255, 255, 0.97) 0%, rgba(244, 246, 255, 0.99) 100%),
    conic-gradient(
        from var(--border-angle),
        transparent 0%,
        transparent 67%,
        rgba(122, 132, 255, 0.86) 80%,
        rgba(106, 116, 247, 1) 87%,
        rgba(101, 183, 255, 0.84) 94%,
        transparent 100%
    ) !important;
    box-shadow: 0 18px 40px rgba(104, 110, 170, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.86) !important;
    animation: spinning-border-rotate 3s linear infinite !important;
}

:global(body[data-theme="soft-light"] .video-ip-agent-shell .section-processing:hover) {
    box-shadow: 0 22px 46px rgba(104, 110, 170, 0.14),
    0 0 0 1px rgba(106, 116, 247, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.90) !important;
}

/* 浅色主题 - 用户信息区域背景 */
::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800/60 to-slate-900/60"]) {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.95) 0%, rgba(248, 250, 252, 0.98) 100%) !important;
    border-color: rgba(226, 232, 240, 0.8) !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800/60 to-slate-900/60"] span) {
    color: #334155 !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800/60 to-slate-900/60"] .text-slate-200) {
    color: #1e293b !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800/60 to-slate-900/60"] .text-slate-500) {
    color: #64748b !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800/60 to-slate-900/60"] .text-slate-400) {
    color: #94a3b8 !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800/60 to-slate-900/60"] svg) {
    color: #475569 !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800/60 to-slate-900/60"] .text-emerald-400) {
    color: #059669 !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800/60 to-slate-900/60"] .text-rose-400) {
    color: #e11d48 !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800/60 to-slate-900/60"] .bg-slate-700\/50) {
    background: rgba(241, 245, 249, 0.6) !important;
    border-color: rgba(203, 213, 225, 0.5) !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800/60 to-slate-900/60"] .bg-slate-700\/50:hover) {
    background: rgba(226, 232, 240, 0.8) !important;
    border-color: rgba(249, 115, 22, 0.3) !important;
}

/* 浅色主题 - 状态指示器区域背景 */
::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800"]) {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(248, 250, 252, 0.99) 100%) !important;
    border-color: rgba(226, 232, 240, 1) !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800"] .text-slate-300) {
    color: #334155 !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800"] .text-slate-500) {
    color: #64748b !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800"] svg) {
    color: #475569 !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800"] .from-slate-600) {
    background: linear-gradient(135deg, #e2e8f0 0%, #cbd5e1 100%) !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800"] .text-slate-400) {
    color: #64748b !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-br from-slate-800"] .from-slate-700) {
    background: linear-gradient(135deg, #cbd5e1 0%, #94a3b8 100%) !important;
}

/* 浅色主题 - 任务运行中状态 */
::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-r from-emerald-900"]) {
    background: linear-gradient(135deg, rgba(236, 253, 245, 0.98) 0%, rgba(209, 250, 229, 0.99) 100%) !important;
    border-color: rgba(52, 211, 153, 0.5) !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-r from-emerald-900"] .text-white) {
    color: #065f46 !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-r from-emerald-900"] .text-emerald-300) {
    color: #059669 !important;
}

::global(body[data-theme="soft-light"] .video-ip-agent-shell [class*="bg-gradient-to-r from-emerald-900"] .bg-black\/30) {
    background: rgba(0, 0, 0, 0.1) !important;
}

.legal-modal-dark .arco-modal-header {
    background: #1a1a2e !important;
    border-bottom: 1px solid #2a2a4a !important;
}

.legal-modal-dark .arco-modal-title {
    color: #e0e0e0 !important;
    font-weight: 600 !important;
}

.legal-modal-dark .arco-modal-close-btn {
    color: #888 !important;
}

.legal-modal-dark .arco-modal-close-btn:hover {
    color: #fff !important;
}

.legal-modal-dark .arco-modal-body {
    background: #1a1a2e !important;
    color: #ccc !important;
}

.legal-modal-dark .arco-btn:not(.arco-btn-primary) {
    background: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid #3a3a5a !important;
    color: #bbb !important;
}

.legal-modal-dark .arco-btn:not(.arco-btn-primary):hover {
    background: rgba(255, 255, 255, 0.1) !important;
    border-color: #5a5a7a !important;
    color: #fff !important;
}

.legal-modal-dark .arco-btn-primary {
    background: linear-gradient(135deg, #3b82f6, #8b5cf6) !important;
    border: none !important;
}

.legal-modal-dark .arco-btn-primary:hover {
    background: linear-gradient(135deg, #60a5fa, #a78bfa) !important;
}

.legal-modal-dark .bg-red-200 {
    background: rgba(220, 38, 38, 0.25) !important;
    color: #fca5a5 !important;
}

.legal-shield-container {
    position: relative;
    width: 80px;
    height: 80px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.legal-shield-glow {
    position: absolute;
    inset: -12px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(59, 130, 246, 0.3) 0%, transparent 70%);
    animation: shield-pulse 1.8s ease-in-out infinite;
}

.legal-shield-icon {
    width: 64px;
    height: 64px;
    position: relative;
    z-index: 1;
    animation: shield-blink 2s ease-in-out infinite;
    filter: drop-shadow(0 0 8px rgba(59, 130, 246, 0.4));
}

@keyframes shield-pulse {
    0%, 100% {
        transform: scale(0.8);
        opacity: 0.3;
    }
    50% {
        transform: scale(1.3);
        opacity: 0.8;
    }
}

@keyframes shield-blink {
    0%, 100% {
        opacity: 0.6;
        transform: scale(1);
    }
    50% {
        opacity: 1;
        transform: scale(1.08);
    }
}

/* 账号管理弹窗标题 */
.account-modal-wrapper {
    position: relative;
}

.account-modal-close {
    position: absolute;
    top: 0;
    right: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: #64748b;
    border-radius: 6px;
    transition: all 0.2s;
}

.account-modal-close:hover {
    color: #f1f5f9;
    background: rgba(255, 255, 255, 0.1);
}

.account-modal-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 16px;
    padding: 0 2px;
}

.account-modal-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    font-weight: 700;
    color: #f1f5f9;
    letter-spacing: 0.02em;
}

.account-modal-subtitle {
    font-size: 12px;
    color: #64748b;
    padding-left: 2px;
}

/* 账号管理弹窗样式覆盖 */
.account-manager-modal .arco-modal {
    background: radial-gradient(circle at 30% 0%, rgba(168, 85, 247, 0.1), transparent 50%),
    radial-gradient(circle at 70% 100%, rgba(236, 72, 153, 0.08), transparent 50%),
    #141414 !important;
    border: 1px solid rgba(168, 85, 247, 0.2) !important;
}

/* 🔵 首页同款卡片发光特效 */
.hover-glow-effect {
    transition: all 0.3s ease;
}

.hover-glow-effect:hover {
    border-color: rgba(59, 130, 246, 0.4) !important;
    box-shadow: 0 8px 24px rgba(59, 130, 246, 0.15) !important;
}

/* 📝 现代文案输入框样式 */
.modern-textarea {
    background-color: rgba(0, 0, 0, 0.2) !important; /* 更深的背景 */
    border: 1px solid rgba(255, 255, 255, 0.1) !important;
    border-radius: 12px !important;
    color: #e2e8f0 !important;
    padding: 16px !important;
    transition: all 0.3s ease;
    resize: none !important; /* 禁用拖拽调整大小，保持美观 */
}

.modern-textarea:hover {
    border-color: rgba(255, 255, 255, 0.3) !important;
    background-color: rgba(0, 0, 0, 0.4) !important;
}

.modern-textarea:focus {
    border-color: #06b6d4 !important;
    background-color: rgba(0, 0, 0, 0.4) !important;
    outline: none;
    box-shadow: 0 0 0 1px #06b6d4 !important;
}


/* 强制浅色背景下的复选框显示 */
:deep(.force-light-checkbox .arco-checkbox-icon) {
    border: 1px solid #c9c9c9 !important;
    background-color: white !important;
}

:deep(.force-light-checkbox.arco-checkbox-checked .arco-checkbox-icon) {
    background-color: #165dff !important;
    border-color: #165dff !important;
    color: white !important;
}

.one-click-img-btn {
    width: 100%;
    height: auto;
    cursor: pointer;
    transition: transform 0.2s ease, filter 0.2s ease;
    border-radius: 12px;
}

.one-click-img-btn:hover {
    transform: translateY(-2px) scale(1.01);
    filter: brightness(1.1);
}

.one-click-img-btn:active {
    transform: scale(0.97);
}

.one-click-running-area {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(20, 20, 20, 0.8);
    border: 1px solid rgba(249, 115, 22, 0.2);
}

.progress-img {
    width: 100%;
    height: auto;
    border-radius: 8px;
}

.mini-img-btn {
    height: 32px;
    width: auto;
    cursor: pointer;
    transition: transform 0.2s ease, filter 0.2s ease;
}

.mini-img-btn:hover {
    transform: translateY(-1px);
    filter: brightness(1.1);
}

.mini-img-btn:active {
    transform: scale(0.95);
}

/* ====== 深色主题：浅色背景区域文字强制深色（避免浅色文字+浅色背景看不清） ====== */
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-gray-50,
::global(body[data-theme="dark"] .video-ip-agent-shell) [class~="bg-white"] {
    color: #000000 !important;
}

::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 .text-gray-700,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 .text-gray-600,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 .text-gray-500,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 .text-gray-400,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 label,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 p,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 span,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-gray-50 .text-gray-700,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-gray-50 .text-gray-600,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-gray-50 .text-gray-500,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-gray-50 .text-gray-400,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-gray-50 label,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-gray-50 p,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-gray-50 span,
::global(body[data-theme="dark"] .video-ip-agent-shell) [class~="bg-white"] .text-gray-700,
::global(body[data-theme="dark"] .video-ip-agent-shell) [class~="bg-white"] .text-gray-600,
::global(body[data-theme="dark"] .video-ip-agent-shell) [class~="bg-white"] .text-gray-500,
::global(body[data-theme="dark"] .video-ip-agent-shell) [class~="bg-white"] .text-gray-400,
::global(body[data-theme="dark"] .video-ip-agent-shell) [class~="bg-white"] label,
::global(body[data-theme="dark"] .video-ip-agent-shell) [class~="bg-white"] p,
::global(body[data-theme="dark"] .video-ip-agent-shell) [class~="bg-white"] span {
    color: #000000 !important;
}

::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 .font-medium,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-gray-50 .font-medium,
::global(body[data-theme="dark"] .video-ip-agent-shell) [class~="bg-white"] .font-medium {
    color: #000000 !important;
}

::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 .text-blue-700,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 .text-blue-600,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 .text-blue-500 {
    color: #1d4ed8 !important;
}

::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 :deep(.arco-btn-text),
::global(body[data-theme="dark"] .video-ip-agent-shell) [class~="bg-white"] :deep(.arco-btn-text) {
    color: #334155 !important;
}

::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-blue-50 :deep(.arco-btn-outline),
::global(body[data-theme="dark"] .video-ip-agent-shell) [class~="bg-white"] :deep(.arco-btn-outline) {
    color: #334155 !important;
    border-color: #94a3b8 !important;
}

/* bg-amber-50 浅色背景区域 */
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-amber-50 {
    color: #1e293b !important;
}

::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-amber-50 .text-amber-700 {
    color: #b45309 !important;
}

::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-amber-50 label,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-amber-50 p,
::global(body[data-theme="dark"] .video-ip-agent-shell) .bg-amber-50 span {
    color: #334155 !important;
}

/* 发布按钮样式 - 科技感设计 */
.publish-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 32px;
    padding: 0 14px;
    border: none;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
}

.publish-btn .btn-icon {
    width: 14px;
    height: 14px;
}

.publish-btn .animate-spin {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from {
        transform: rotate(0deg);
    }
    to {
        transform: rotate(360deg);
    }
}

/* 立即发布按钮 - 蓝色 */
.publish-btn-now {
    background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
    color: #ffffff;
    box-shadow: 0 2px 8px rgba(59, 130, 246, 0.35);
}

.publish-btn-now:hover:not(:disabled) {
    background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.45);
    transform: translateY(-1px);
}

.publish-btn-now:disabled {
    opacity: 0.7;
    cursor: not-allowed;
}

/* 定时发布按钮 - 紫色 */
.publish-btn-schedule {
    background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%);
    color: #ffffff;
    box-shadow: 0 2px 8px rgba(124, 58, 237, 0.35);
}

.publish-btn-schedule:hover {
    background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
    box-shadow: 0 4px 12px rgba(124, 58, 237, 0.45);
    transform: translateY(-1px);
}

.publish-btn-schedule.is-cancel {
    background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
    box-shadow: 0 2px 8px rgba(220, 38, 38, 0.35);
}

.publish-btn-schedule.is-cancel:hover {
    background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
    box-shadow: 0 4px 12px rgba(220, 38, 38, 0.45);
}

</style>
