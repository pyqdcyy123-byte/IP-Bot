// @ts-nocheck
/**
 * 瀛楀箷鐢熸垚涓绘湇鍔?
 * 鏁村悎鎵€鏈夊姛鑳斤紝鎻愪緵瀹屾暣鐨勫瓧骞曠敓鎴愭祦绋?
 */

import { LevenshteinMatcher } from '@/lib/algorithms/Levenshtein';
import { ASSGenerator } from '@/lib/subtitle/ASSGenerator';
import { DrawtextGenerator, DrawtextEffectPresets } from '@/lib/subtitle/DrawtextGenerator';
import { SmartLayoutManager } from '@/lib/subtitle/SmartLayoutManager';
import { SoundEffectGenerator } from '@/service/SoundEffectGenerator';
import type {
  ZimuConfig,
  CorrectedSegment,
  KeywordMatch,
  ArrangedSubtitle,
  LayoutConstraints,
  SubtitleLine,
  SubtitleFrame,
  FFmpegCommand,
  GenerationResult,
  GenerationStatistics,
  ASSStyleConfig,
  ASSDialogueEvent
} from '@/service/ZimuShengcheng.types';
import type { EffectType } from '@/types/smartSubtitle';

export class ZimuShengcheng {
  private config: ZimuConfig;
  private correctedSegments: CorrectedSegment[] = [];
  private keywordMatches: KeywordMatch[] = [];
  private arrangedSubtitles: ArrangedSubtitle[] = [];
  private statistics: GenerationStatistics;

  constructor() {
    this.statistics = {
      totalSegments: 0,
      correctedCount: 0,
      keywordCount: 0,
      normalSubtitles: 0,
      effectSubtitles: 0,
      renderTime: 0,
      processingTime: 0
    };
  }

  /**
   * 主方法：生成字幕
   * @param config 字幕生成配置
   * @returns 生成结果
   */
  async generate(config: ZimuConfig): Promise<GenerationResult> {
    const startTime = Date.now();

    try {
      config.funasrSegments = this.normalizeSegmentTimeline(
        this.normalizeFunasrSegmentsToMilliseconds(config.funasrSegments)
      );
      this.config = config;

      console.log('[ZimuShengcheng] 寮€濮嬬敓鎴愬瓧骞?..', {
        videoPath: config.videoPath,
        userText: String(config.userText || '').substring(0, 50) + '...',
        segments: config.funasrSegments.length,
        subtitleStyle: {
          fontName: config.subtitleStyle?.fontName,
          fontSize: config.subtitleStyle?.fontSize,
          fontColor: config.subtitleStyle?.fontColor,
          backgroundColor: config.subtitleStyle?.backgroundColor
        },
        keywordGroupsCount: config.keywordGroups?.length || 0
      });

      // 1. 文案修正
      console.log('[ZimuShengcheng] 步骤1: 文案修正...');
      this.correctedSegments = config.skipTextCorrection
        ? config.funasrSegments.map(seg => ({
            text: this.removePunctuation(String(seg?.text || '')),
            originalText: String(seg?.text || ''),
            start: seg.start,
            end: seg.end,
            corrected: false,
            confidence: 1.0,
            charTimings: this.buildCleanedCharTimings(seg)
          }))
        : this.correctText(
            config.userText,
            config.funasrSegments
          );

      // 🆕 关键修复：直接从数据库获取最新的关键词分组数据，确保贴纸配置是最新的
      try {
        console.log('[ZimuShengcheng] 🔄 正在从数据库获取最新关键词分组数据...');
        // 动态导入以避免循环依赖
        const KeywordGroupService = (await import('./KeywordGroupService')).default;
        const freshGroups = await KeywordGroupService.getAllGroups();

        if (freshGroups && freshGroups.length > 0 && config.keywordGroups) {
          const freshGroupsMap = new Map(freshGroups.map((g: any) => [g.id, g]));

          let updatedCount = 0;
          config.keywordGroups.forEach((group: any) => {
            const freshGroup = freshGroupsMap.get(group.id);
            if (freshGroup) {
              // 浠呮洿鏂拌创绾哥浉鍏崇殑鏍稿績瀛楁锛屼繚鐣欏墠绔紶閫掔殑鍏朵粬鐘舵€?
              if (freshGroup.stickerId) {
                group.stickerId = freshGroup.stickerId;
                group.stickerConfig = freshGroup.stickerConfig;
                updatedCount++;
              }
            }
          });
          console.log(`[ZimuShengcheng] ✅宸插悓姝?${updatedCount} 个分组的贴纸数据`);
        }
      } catch (error) {
        console.warn('[ZimuShengcheng] ⚠️ 鏃犳硶浠庢暟鎹簱鍚屾鏈€鏂板垎缁勬暟鎹?', error);
      }

      // 2. 鍏抽敭璇嶅尮閰?
      console.log('[ZimuShengcheng] 步骤2: 鍏抽敭璇嶅尮閰?..');
      console.log('[ZimuShengcheng] keywordGroups参数:', {
        hasKeywordGroups: !!config.keywordGroups,
        keywordGroupsLength: config.keywordGroups?.length || 0,
        keywordGroups: config.keywordGroups?.map((g: any) => ({
          id: g.id,
          name: g.name,
          keywordsCount: g.keywords?.length || 0,
          effectId: g.effectId,
          stickerId: g.stickerId,  // 🔍 关键：检查stickerId是否存在
          stickerConfig: g.stickerConfig,
          keywords: g.keywords?.slice(0, 3)
        }))
      });
      this.keywordMatches = this.matchKeywords(
        this.correctedSegments,
        config.keywordGroups
      );
      console.log('[ZimuShengcheng] 鍏抽敭璇嶅尮閰嶇粨鏋?', {
        matchesCount: this.keywordMatches.length,
        matches: this.keywordMatches.slice(0, 5).map(m => ({
          keyword: m.keyword,
          effectType: m.effectType,
          isAnimated: m.isAnimated,
          stickerId: (m as any).stickerId,  // 🔍 关键：检查stickerId鏄惁浼犻€?
          stickerConfig: (m as any).stickerConfig,
          startTime: m.startTime,
          endTime: m.endTime
        }))
      });

      // 3. 智能排列
      console.log('[ZimuShengcheng] 步骤3: 智能字幕排列...');

      // 🔍 鍏抽敭璇婃柇锛氭鏌ョ涓€鏉″瓧骞曠殑鏃堕棿鍊?
      if (this.correctedSegments.length > 0) {
        const firstSeg = this.correctedSegments[0];
        console.log('[ZimuShengcheng] ✅绗竴鏉orrectedSegment时间:', {
          start: firstSeg.start,
          end: firstSeg.end,
          startType: typeof firstSeg.start,
          endType: typeof firstSeg.end,
          text: firstSeg.text.substring(0, 30)
        });
      }

      this.arrangedSubtitles = this.arrangeSubtitles(
        this.correctedSegments,
        this.keywordMatches,
        config
      );
      // 🔍 关键诊断：检查第一条arrangedSubtitle鐨勬椂闂村€?
      if (this.arrangedSubtitles.length > 0) {
        const firstArranged = this.arrangedSubtitles[0];
        console.log('[ZimuShengcheng] ✅绗竴鏉rrangedSubtitle时间:', {
          start: firstArranged.start,
          end: firstArranged.end,
          startType: typeof firstArranged.start,
          endType: typeof firstArranged.end,
          type: firstArranged.type,
          text: firstArranged.text.substring(0, 30)
        });
      }

      console.log(`[ZimuShengcheng] 字幕排列完成: ${this.arrangedSubtitles.length}鏉?(鏅€?${this.arrangedSubtitles.filter(s => s.type === 'normal').length} 特效:${this.arrangedSubtitles.filter(s => s.type !== 'normal').length})`);


      // 4. 生成ASS文件
      console.log('[ZimuShengcheng] 步骤4: 生成ASS文件...');
      const assFiles = await this.generateASSFiles(this.arrangedSubtitles, config);

      // 5. 预解析所有字体路径（使用字体管理器API鑾峰彇缁濆璺緞锛?
      console.log('[ZimuShengcheng] 步骤5: 棰勮В鏋愬瓧浣撹矾寰?..');
      // ✅鏂板锛氬鏋滃惎鐢ㄦ爣棰樺瓧骞曪紝涔熼渶瑕侀瑙ｆ瀽鏍囬瀛楀箷鐨勫瓧浣?
      if (config.titleSubtitleConfig && config.titleSubtitleConfig.enabled && config.titleSubtitleConfig.lines) {
        for (const line of config.titleSubtitleConfig.lines) {
          if (line.fontName) {
            // ✅淇锛氬厛妫€鏌ョ紦瀛橈紝濡傛灉鏈夊氨鐩存帴浣跨敤锛屽惁鍒欒В鏋?
            if (this.fontPathCache.has(line.fontName)) {
              // 缂撳瓨鍛戒腑锛岀洿鎺ユ洿鏂?fontPath
              const cachedPath = this.fontPathCache.get(line.fontName)!;
              line.fontPath = cachedPath;
              console.log(`[ZimuShengcheng] 标题字幕字体使用缓存: ${line.fontName} -> ${cachedPath}`);
            } else {
              console.log(`[ZimuShengcheng] 棰勮В鏋愭爣棰樺瓧骞曞瓧浣? ${line.fontName}`);
              // 使用字体管理器API解析字体路径
              try {
                if (typeof window !== 'undefined' && window.$mapi?.fontManager?.findFontPath) {
                  const result = await window.$mapi.fontManager.findFontPath(line.fontName, 400);
                  if (result && result.success && result.data) {
                    const safeFontPath = await this.copyFontToSafePath(result.data, line.fontName);
                    this.fontPathCache.set(line.fontName, safeFontPath);
                    // ✅鏇存柊閰嶇疆涓殑瀛椾綋璺緞
                    line.fontPath = safeFontPath;
                    console.log(`[ZimuShengcheng] 标题字幕字体解析成功: ${line.fontName} -> ${safeFontPath}`);
                  }
                }
              } catch (error) {
                console.warn(`[ZimuShengcheng] 标题字幕字体解析失败: ${line.fontName}`, error);
                // 使用回退方案
                const fallbackPath = this.resolveFontPathSync(line.fontName);
                this.fontPathCache.set(line.fontName, fallbackPath);
                line.fontPath = fallbackPath;
              }
            }
          }
        }
      }
      await this.preResolveFontPaths(this.arrangedSubtitles);

      // 6. 生成drawtext命令
      console.log('[ZimuShengcheng] 步骤6: 生成drawtext命令...');
      const drawtextCommands = this.generateDrawtextCommands(
        this.arrangedSubtitles,
        config.fontDir
      );
      console.log('[ZimuShengcheng] drawtext命令生成完成:', {
        commandCount: drawtextCommands.length,
        arrangedSubtitlesCount: this.arrangedSubtitles.length,
        normalCount: this.arrangedSubtitles.filter(s => s.type === 'normal').length,
        effectCount: this.arrangedSubtitles.filter(s => s.type !== 'normal').length
      });

      // 🆕 步骤 6.2: 收集贴纸素材
      console.log('[ZimuShengcheng] 步骤6.2: 收集贴纸素材...');

      // 获取资源路径
      const path = await import('path');
      let resourcesPath = path.join(process.cwd(), 'electron/resources/extra');

      try {
        // @ts-ignore
        if (window.$mapi && window.$mapi.app && window.$mapi.app.getResourcesPath) {
          // @ts-ignore
          resourcesPath = await window.$mapi.app.getResourcesPath();
          console.log(`[ZimuShengcheng] ✅璧勬簮璺緞: ${resourcesPath}`);
        } else {
          console.log(`[ZimuShengcheng] ℹ️ 使用 fallback 资源路径: ${resourcesPath}`);
        }
      } catch (e) {
        console.warn(`[ZimuShengcheng] ⚠️ 鑾峰彇璧勬簮璺緞澶辫触锛屼娇鐢?fallback: ${resourcesPath}`, e);
      }

      const stickerAssets = this.collectStickerAssets(this.arrangedSubtitles, resourcesPath);
      console.log('[ZimuShengcheng] 贴纸素材收集结果:', {
        count: stickerAssets.length,
        assets: stickerAssets.map(a => ({
          path: a.path,
          instancesCount: a.instances.length,
          instances: a.instances
        }))
      });
      console.log('[ZimuShengcheng] 贴纸素材收集完成:', {
        uniqueStickers: stickerAssets.length,
        details: stickerAssets.map(s => ({ path: s.path, count: s.instances.length }))
      });

      // 🆕 步骤 6.5: 生成音效（如果启用）
      let soundAudioFilters: string[] = [];
      let soundInstances: any[] = [];

      if (config.soundEffectSettings?.enabled) {
        console.log('[ZimuShengcheng] 步骤6.5: 生成音效...');
        try {
          // 验证音效配置
          const validation = SoundEffectGenerator.validateSoundConfig(config.keywordGroups);
          if (!validation.valid) {
            console.warn('[ZimuShengcheng] 音效配置验证失败:', validation.errors);
          }

          // 生成音效
          const soundResult = await SoundEffectGenerator.generateSoundTrack(
            this.arrangedSubtitles,
            this.keywordMatches,
            config.keywordGroups
          );

          soundAudioFilters = soundResult.ffmpegAudioFilters;
          soundInstances = soundResult.soundInstances;

          console.log('[ZimuShengcheng] 音效生成完成:', {
            soundInstancesCount: soundInstances.length,
            audioFiltersCount: soundAudioFilters.length
          });
        } catch (error) {
          console.warn('[ZimuShengcheng] 闊虫晥鐢熸垚澶辫触锛岀户缁鐞嗚棰戯紙涓嶅惈闊虫晥锛?', error);
          // 闊虫晥鐢熸垚澶辫触涓嶄腑鏂祦绋?
        }
      }

      // 6.5 生成标题字幕drawtext命令（如果启用）
      let titleDrawtextCommands: string[] = [];
      if (config.titleSubtitleConfig && config.titleSubtitleConfig.enabled) {
        console.log('[ZimuShengcheng] 步骤6.5: 生成标题字幕...');
        try {
          titleDrawtextCommands = DrawtextGenerator.generateTitleSubtitle(
            config.titleSubtitleConfig,
            config.videoWidth,
            config.videoHeight,
            this.normalizeMillisecondsToSeconds(config.videoDuration || 0)
          );
          console.log('[ZimuShengcheng] 标题字幕生成完成，命令数:', titleDrawtextCommands.length);
        } catch (error) {
          console.error('[ZimuShengcheng] 标题字幕生成失败:', error);
          // 鏍囬瀛楀箷鐢熸垚澶辫触涓嶄腑鏂祦绋?
        }
      }

      // 7. 构建FFmpeg命令（纯drawtext方案：不再使用ASS鏂囦欢锛?
      console.log('[ZimuShengcheng] 步骤7: 构建FFmpeg命令（纯drawtext鏂规锛?..');

      // ✅鍚堝苟鏍囬瀛楀箷鍜屾櫘閫氬瓧骞曠殑drawtext命令
      // 鏍囬瀛楀箷浼樺厛娓叉煋锛堜綔涓哄簳灞傦級锛岀劧鍚庢槸鏅€氬瓧骞?特效字幕（作为上层）
      const combinedDrawtextCommands = [
        ...titleDrawtextCommands,  // 鏍囬瀛楀箷鍏堟坊鍔?
        ...drawtextCommands         // 鏅€?鐗规晥瀛楀箷鍚庢坊鍔?
      ];

      // 銆愯皟璇曘€戣緭鍑?drawtextCommands 详情
      console.log('[ZimuShengcheng] 合并后的 drawtextCommands 数量:', combinedDrawtextCommands.length);
      console.log('[ZimuShengcheng] 其中标题字幕:', titleDrawtextCommands.length, '鏅€氬瓧骞?', drawtextCommands.length);
      combinedDrawtextCommands.forEach((cmd, i) => {
        console.log(`[ZimuShengcheng] drawtextCommand[${i}]:`, cmd.substring(0, 200) + (cmd.length > 200 ? '...' : ''));
      });

      // 🆕 鏂板锛氫紶閫掗煶鏁堝疄渚嬬敤浜庨煶棰戞贩闊?
      const ffmpegCmd = this.buildFFmpegCommand(
        config.videoPath,
        config.outputPath,
        [], // 【纯drawtext方案】不再传递ASS文件
        combinedDrawtextCommands,  // ✅浣跨敤鍚堝苟鍚庣殑鍛戒护
        config.fontDir,
        soundInstances,  // 音效实例
        stickerAssets    // 🆕 贴纸素材
      );

      // 8. 执行渲染
      console.log('[ZimuShengcheng] 步骤8: 执行FFmpeg渲染...');
      const renderStartTime = Date.now();
      await this.executeFFmpeg(ffmpegCmd);
      this.statistics.renderTime = (Date.now() - renderStartTime) / 1000;

      // 9. 生成调试文件（包含所有字幕详细信息）
      console.log('[ZimuShengcheng] 步骤9: 生成调试文件...');
      const debugPath = await this.generateDebugFile(this.arrangedSubtitles, drawtextCommands, config);

      // 10. 生成SRT鏂囦欢锛堢敤浜庡睍绀哄拰涓嬭浇锛?
      console.log('[ZimuShengcheng] 步骤10: 生成SRT文件...');
      const srtPath = await this.generateSRTFile(this.correctedSegments, config);

      // 11. 统计信息
      this.statistics.totalSegments = this.correctedSegments.length;
      this.statistics.correctedCount = this.correctedSegments.filter(s => s.corrected).length;
      this.statistics.keywordCount = this.keywordMatches.length;
      this.statistics.normalSubtitles = this.arrangedSubtitles.filter(s => s.type === 'normal').length;
      this.statistics.effectSubtitles = this.arrangedSubtitles.filter(s => s.type !== 'normal').length;
      this.statistics.processingTime = (Date.now() - startTime) / 1000;

      console.log('[ZimuShengcheng] 字幕生成完成:', this.statistics);

      // 🆕 鐢讳腑鐢诲鐞嗭細鍦ㄥ瓧骞曠敓鎴愬畬鎴愬悗搴旂敤鐢讳腑鐢绘晥鏋?
      let finalOutputPath = config.outputPath;
      if (config.videoMixCutSettings?.enabled) {
          try {
              console.log('[ZimuShengcheng] 开始应用画中画效果...');
              const { FixedModeProcessor, KeywordModeProcessor, SubtitleModeProcessor, FFmpegCommandBuilder } =
                  await import('../lib/mixCutVideo');

              let replacements: any[] = [];
              const mixCutConfig = config.videoMixCutSettings;

              // 根据模式处理
              if (mixCutConfig.mode === 'fixed' && mixCutConfig.fixedModeConfig) {
                  console.log('[ZimuShengcheng] 使用固定模式处理画中画');
                  replacements = FixedModeProcessor.process(
                      mixCutConfig.fixedModeConfig,
                      config.videoDuration || 0
                  );
              } else if (mixCutConfig.mode === 'keyword' && mixCutConfig.keywordModeConfig) {
                  console.log('[ZimuShengcheng] 使用关键词模式处理画中画');
                  // 关键词模式需要字幕记录，这里暂不支持
                  console.warn('[ZimuShengcheng] 关键词模式暂不支持');
              } else if (mixCutConfig.mode === 'subtitle' && mixCutConfig.subtitleModeConfig) {
                  console.log('[ZimuShengcheng] 使用字幕模式处理画中画');
                  // 字幕模式需要字幕记录，这里暂不支持
                  console.warn('[ZimuShengcheng] 字幕模式暂不支持');
              }

              if (replacements.length > 0) {
                  console.log('[ZimuShengcheng] 生成画中画片段:', replacements.length);
                  const mixCutOutputPath = config.outputPath.replace(/\.mp4$/, '_mixcut.mp4');

                  const ffmpegCmd = FFmpegCommandBuilder.buildOverlayCommand(
                      config.outputPath,  // 杈撳叆锛氬甫瀛楀箷鐨勮棰?
                      replacements,       // 鐢讳腑鐢荤墖娈甸厤缃?
                      mixCutOutputPath,   // 输出：带字幕+画中画的视频
                      { width: config.videoWidth, height: config.videoHeight }
                  );

                  console.log('[ZimuShengcheng] 执行画中画FFmpeg命令...');
                  await this.executeFFmpeg(ffmpegCmd);

                  finalOutputPath = mixCutOutputPath;
                  console.log('[ZimuShengcheng] ✅鐢讳腑鐢诲鐞嗗畬鎴?', finalOutputPath);
              } else {
                  console.log('[ZimuShengcheng] 没有生成画中画片段，跳过处理');
              }
          } catch (error: any) {
              console.error('[ZimuShengcheng] ❌鐢讳腑鐢诲鐞嗗け璐?', error);
              // 涓嶆姏鍑洪敊璇紝缁х画杩斿洖鍘熻棰?
          }
      }

      try {
        const _u = JSON.parse(localStorage.getItem('auth_user') || '{}');
        window.require('electron').ipcRenderer.invoke('auth:reportGeneration', {
          userId: _u.id,
          type: 'subtitle',
          detail: `字幕生成:${this.statistics?.totalSubtitles || 0}条`
        });
      } catch (e) {}

      return {
        success: true,
        outputPath: finalOutputPath,
        srtPath: srtPath,
        debugPath: debugPath,
        message: '字幕生成成功',
        statistics: this.statistics
      };

    } catch (error: any) {
      console.error('[ZimuShengcheng] 字幕生成失败:', error);
      return {
        success: false,
        message: '字幕生成失败: ' + error.message,
        error
      };
    }
  }

  // ==================== 步骤1: 文案修正 ====================

  /**
   * 绉婚櫎鏂囨湰涓殑鎵€鏈夋爣鐐圭鍙?
   * 包括中文标点、英文标点、特殊符号等
   * @private
   */
  private removePunctuation(text: string): string {
    if (!text) return '';

    // 涓枃鏍囩偣绗﹀彿锛氾紝銆傦紒锛燂紱锛氥€侊紙锛夈€屻€嶃€庛€忋€愩€戙€娿€嬧€︹€斅?"
    // 鑻辨枃鏍囩偣绗﹀彿锛?.!?;:()[]{}""''''
    // 其他符号：@#$%^&*-_+=|\<>~`
    const punctuationRegex = /[锛屻€傦紒锛燂紱锛氥€侊紙锛夈€屻€嶃€庛€忋€愩€戙€娿€嬧€︹€斅?"锛屻€傦紒锛燂紱锛氥€侊紙锛夈€屻€嶃€庛€忋€愩€戙€娿€嬧€︹€斅?.\\!?;:\\(\\)\\[\\]\\{\\}\"'"'"@#$%^&*\\-_+=|\\\\<>~`]/g;

    const cleaned = text.replace(punctuationRegex, ' ').replace(/\s+/g, ' ').trim();

    // console.log(`[ZimuShengcheng.removePunctuation] 移除标点符号: "${text}" -> "${cleaned}"`);

    return cleaned;
  }

  /**
   * 修正ASR璇嗗埆缁撴灉锛屾浛鎹负鐢ㄦ埛杈撳叆鐨勬纭枃妗?
   * @private
   */
  private correctText(
    userText: string,
    asrSegments: any[]
  ): CorrectedSegment[] {
    if (!userText || userText.trim() === '') {
      // 如果用户没有输入文案，直接使用ASR结果
      return asrSegments.map(seg => ({
        text: this.removePunctuation(seg.text),
        originalText: seg.text,
        start: seg.start,
        end: seg.end,
        corrected: false,
        confidence: 1.0,
        charTimings: this.buildCleanedCharTimings(seg)
      }));
    }

    // 使用Levenshtein算法修正
    // 使用Levenshtein算法修正
    const correctedSegments = LevenshteinMatcher.correctText(userText, asrSegments);
    const cleanedCorrectedSegments = correctedSegments.map(seg => ({
      ...seg,
      text: this.removePunctuation(seg.text)
    }));

    const validOriginalSegments = asrSegments.filter(seg => {
      const cleanedText = this.removePunctuation(String(seg?.text || ''));
      return cleanedText.trim().length > 0;
    });

    if (validOriginalSegments.length > 1 && cleanedCorrectedSegments.length <= 1) {
      console.warn('[ZimuShengcheng] Levenshtein correction collapsed subtitle segments, fallback to original segmentation', {
        originalCount: validOriginalSegments.length,
        correctedCount: cleanedCorrectedSegments.length,
      });

      return validOriginalSegments.map(seg => ({
        text: this.removePunctuation(String(seg.text || '')),
        originalText: seg.text,
        start: seg.start,
        end: seg.end,
        corrected: false,
        confidence: 1.0,
        charTimings: this.buildCleanedCharTimings(seg)
      }));
    }

    return cleanedCorrectedSegments;
  }

  private normalizeMillisecondsToSeconds(timeValue: number): number {
    if (!Number.isFinite(timeValue) || timeValue <= 0) {
      return 0;
    }

    return timeValue > 1000 ? timeValue / 1000 : timeValue;
  }

  private normalizeFunasrSegmentsToMilliseconds(segments: any[] = []): any[] {
    if (!Array.isArray(segments) || segments.length === 0) {
      return [];
    }

    if (!this.shouldTreatTimelineAsSeconds(segments)) {
      return segments;
    }

    console.log('[ZimuShengcheng] 检测到秒级时间轴，统一转换为毫秒');
    return segments.map((segment: any) => ({
      ...segment,
      start: Number(segment.start || 0) * 1000,
      end: Number(segment.end || 0) * 1000,
      words: Array.isArray(segment.words)
        ? segment.words.map((word: any) => ({
            ...word,
            start: Number(word.start || 0) * 1000,
            end: Number(word.end || 0) * 1000
          }))
        : segment.words,
      timestamp: Array.isArray(segment.timestamp)
        ? segment.timestamp.map((pair: any) => Array.isArray(pair) && pair.length >= 2
            ? [Number(pair[0] || 0) * 1000, Number(pair[1] || 0) * 1000]
            : pair)
        : segment.timestamp
    }));
  }

  private shouldTreatTimelineAsSeconds(segments: any[]): boolean {
    const validSegments = segments.filter((segment: any) =>
      Number.isFinite(Number(segment?.start)) && Number.isFinite(Number(segment?.end))
    );
    if (validSegments.length === 0) {
      return false;
    }

    const maxEnd = Math.max(...validSegments.map((segment: any) => Number(segment.end)));
    const maxDuration = Math.max(...validSegments.map((segment: any) => Number(segment.end) - Number(segment.start)));

    // 只用时间范围判断是否为秒级时间轴。
    // 前端按比例切段后会产生“毫秒但带小数”的合法数据，不能再用小数作为秒级依据。
    return maxEnd <= 600 && maxDuration <= 30;
  }

  private normalizeSegmentTimeline<T extends { text?: string; start: number; end: number }>(segments: T[] = []): T[] {
    if (!Array.isArray(segments) || segments.length === 0) {
      return [];
    }

    const duplicateThresholdMs = 1;
    const invalidDurationPaddingMs = 1;

    const sortableSegments = segments
      .map((segment, index) => {
        const text = typeof segment?.text === 'string' ? segment.text : String(segment?.text ?? '');
        const start = Number(segment?.start ?? 0);
        const end = Number(segment?.end ?? 0);

        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          return null;
        }

        return {
          index,
          segment: {
            ...segment,
            text,
            start: Math.max(0, start),
            end: Math.max(0, end)
          } as T
        };
      })
      .filter((item): item is { index: number; segment: T } => Boolean(item))
      .filter(({ segment }) => segment.text.trim().length > 0)
      .sort((a, b) => {
        if (a.segment.start !== b.segment.start) {
          return a.segment.start - b.segment.start;
        }
        if (a.segment.end !== b.segment.end) {
          return a.segment.end - b.segment.end;
        }
        return a.index - b.index;
      });

    const normalized: T[] = [];
    const removedEmpty = segments.length - sortableSegments.length;
    let mergedDuplicates = 0;
    let fixedInvalidDurations = 0;

    for (const { segment } of sortableSegments) {
      const normalizedStart = Math.max(0, segment.start);
      const normalizedEnd = segment.end > normalizedStart
        ? segment.end
        : normalizedStart + invalidDurationPaddingMs;
      const current = {
        ...segment,
        start: normalizedStart,
        end: normalizedEnd
      } as T;
      if (normalizedEnd !== segment.end) {
        fixedInvalidDurations += 1;
      }
      const previous = normalized[normalized.length - 1];

      if (previous) {
        const isNearDuplicate =
          previous.text.trim() === current.text.trim() &&
          Math.abs(previous.start - current.start) <= duplicateThresholdMs &&
          Math.abs(previous.end - current.end) <= duplicateThresholdMs;

        if (isNearDuplicate) {
          previous.end = Math.max(previous.end, current.end);
          mergedDuplicates += 1;
          continue;
        }

      }

      normalized.push(current);
    }

    if (removedEmpty > 0 || mergedDuplicates > 0 || fixedInvalidDurations > 0) {
      console.log('[ZimuShengcheng] 时间轴校验完成:', {
        before: segments.length,
        after: normalized.length,
        removedEmpty,
        mergedDuplicates,
        fixedInvalidDurations
      });
    }

    return normalized;
  }
  private normalizeArrangedNormalSubtitles(subtitles: ArrangedSubtitle[] = []): ArrangedSubtitle[] {
    if (!Array.isArray(subtitles) || subtitles.length === 0) {
      return [];
    }

    const duplicateThresholdMs = 1;
    const invalidDurationPaddingMs = 1;
    const sorted = [...subtitles].sort((a, b) => {
      if (a.start !== b.start) {
        return a.start - b.start;
      }
      if (a.end !== b.end) {
        return a.end - b.end;
      }
      return a.text.localeCompare(b.text);
    });

    const normalized: ArrangedSubtitle[] = [];
    let mergedDuplicates = 0;
    let fixedInvalidDurations = 0;

    for (const subtitle of sorted) {
      const normalizedStart = Math.max(0, subtitle.start);
      const normalizedEnd = subtitle.end > normalizedStart
        ? subtitle.end
        : normalizedStart + invalidDurationPaddingMs;
      const current: ArrangedSubtitle = {
        ...subtitle,
        start: normalizedStart,
        end: normalizedEnd
      };
      if (normalizedEnd !== subtitle.end) {
        fixedInvalidDurations += 1;
      }
      const previous = normalized[normalized.length - 1];

      if (previous) {
        const isNearDuplicate =
          previous.text.trim() === current.text.trim() &&
          Math.abs(previous.start - current.start) <= duplicateThresholdMs &&
          Math.abs(previous.end - current.end) <= duplicateThresholdMs;

        if (isNearDuplicate) {
          previous.end = Math.max(previous.end, current.end);
          mergedDuplicates += 1;
          continue;
        }

      }

      normalized.push(current);
    }

    if (mergedDuplicates > 0 || fixedInvalidDurations > 0) {
      console.log('[ZimuShengcheng] 普通字幕输出时间轴校验完成:', {
        before: subtitles.length,
        after: normalized.length,
        mergedDuplicates,
        fixedInvalidDurations
      });
    }

    return normalized;
  }
  private buildSegmentCharTimings(segment: any): Array<{ start: number; end: number }> {
    const text = String(segment?.text || '');
    if (!text) {
      return [];
    }

    const segmentStart = Number(segment?.start || 0);
    const segmentEnd = Number(segment?.end || 0);
    const fallbackDuration = (segmentEnd - segmentStart) / Math.max(text.length, 1);
    const fallbackTimings = Array.from({ length: text.length }, (_, index) => ({
      start: segmentStart + index * fallbackDuration,
      end: segmentStart + (index + 1) * fallbackDuration
    }));

    const words = Array.isArray(segment?.words) ? segment.words : [];
    if (words.length === 0) {
      return fallbackTimings;
    }

    const preciseTimings: Array<{ start: number; end: number } | null> = Array(text.length).fill(null);
    let searchStart = 0;

    for (const word of words) {
      const wordText = String(word?.word ?? word?.text ?? '');
      const wordStart = Number(word?.start);
      const wordEnd = Number(word?.end);
      if (!wordText || !Number.isFinite(wordStart) || !Number.isFinite(wordEnd) || wordEnd <= wordStart) {
        continue;
      }

      const wordIndex = text.indexOf(wordText, searchStart);
      if (wordIndex === -1) {
        continue;
      }

      const wordCharDuration = (wordEnd - wordStart) / Math.max(wordText.length, 1);
      for (let i = 0; i < wordText.length && wordIndex + i < preciseTimings.length; i++) {
        preciseTimings[wordIndex + i] = {
          start: wordStart + i * wordCharDuration,
          end: wordStart + (i + 1) * wordCharDuration
        };
      }

      searchStart = wordIndex + wordText.length;
    }

    return preciseTimings.map((timing, index) => timing || fallbackTimings[index]);
  }

  private buildCleanedCharTimings(segment: any): Array<{ start: number; end: number }> {
    const text = String(segment?.text || '');
    const rawCharTimings = this.buildSegmentCharTimings(segment);
    const cleanedTimings: Array<{ start: number; end: number }> = [];

    for (let i = 0; i < text.length; i++) {
      if (this.removePunctuation(text[i])) {
        cleanedTimings.push(rawCharTimings[i]);
      }
    }

    return cleanedTimings;
  }

  private getSegmentRangeTiming(
    segment: CorrectedSegment,
    startIndex: number,
    endIndex: number
  ): { start: number; end: number } {
    const safeStartIndex = Math.max(0, Math.min(startIndex, segment.text.length));
    const safeEndIndex = Math.max(safeStartIndex, Math.min(endIndex, segment.text.length));

    if (Array.isArray(segment.charTimings) && segment.charTimings.length >= safeEndIndex && safeEndIndex > safeStartIndex) {
      return {
        start: segment.charTimings[safeStartIndex].start,
        end: segment.charTimings[safeEndIndex - 1].end
      };
    }

    const charDuration = (segment.end - segment.start) / Math.max(segment.text.length, 1);
    return {
      start: segment.start + safeStartIndex * charDuration,
      end: segment.start + safeEndIndex * charDuration
    };
  }

  // ==================== 步骤2: 鍏抽敭璇嶅尮閰?====================

  /**
   * 鍖归厤鍏抽敭璇嶏紝鎵惧嚭鍝簺鏂囧瓧闇€瑕佸簲鐢ㄧ壒鏁?
   * @private
   */
  private matchKeywords(
    segments: CorrectedSegment[],
    keywordGroups: any[]
  ): KeywordMatch[] {
    const matches: KeywordMatch[] = [];

    // 🔧 淇锛氫娇鐢?Set 追踪已匹配的关键词，防止重复
    const matchedPositions = new Set<string>();

    if (!keywordGroups || keywordGroups.length === 0) {
      return matches;
    }

    console.log('[ZimuShengcheng.matchKeywords] 🔍 开始匹配关键词:', {
      keywordGroupsCount: keywordGroups.length,
      segmentsCount: segments.length
    });

    // 🔍 调试：检查每个分组的贴纸配置
    keywordGroups.forEach((group, idx) => {
      console.log(`[ZimuShengcheng.matchKeywords] 分组 #${idx} "${group.name}" 贴纸配置:`, {
        stickerId: group.stickerId,
        hasStickerConfig: !!group.stickerConfig,
        rawGroup: group
      });
    });

    for (const segment of segments) {
      const text = segment.text;
      let index = 0;

      for (const group of keywordGroups) {
        if (!group.keywords || group.keywords.length === 0) continue;

        for (const kwObj of group.keywords) {
          const keyword = typeof kwObj === 'string' ? kwObj : kwObj.keyword;
          if (!keyword) continue;

          // 清理关键词中的标点符号，确保与已清理的文本相匹配
          const cleanedKeyword = this.removePunctuation(keyword);
          if (!cleanedKeyword) continue; // 如果清理后为空，跳过

          // 查找关键词在文本中的第一个位置（只匹配一次）
          let pos = text.indexOf(cleanedKeyword, index);
          if (pos !== -1) {
            // 🔧 创建唯一的位置key锛岀敤浜庡幓閲?
            const positionKey = `${segment.start.toFixed(3)}-${segment.end.toFixed(3)}-${cleanedKeyword}-${pos}`;

            // 濡傛灉璇ヤ綅缃殑鍏抽敭璇嶅凡缁忚鍖归厤杩囷紝璺宠繃锛堝彧淇濈暀绗竴涓垎缁勭殑鍖归厤锛?
            if (matchedPositions.has(positionKey)) {
              console.log(`[ZimuShengcheng.matchKeywords] 跳过重复关键词匹配: "${keyword}" @ ${pos}`);
              continue;
            }

            matchedPositions.add(positionKey);
            console.log(`[ZimuShengcheng.matchKeywords] 匹配关键词: "${cleanedKeyword}"`);

            // 🔧 优先检查单个关键词项目的特效，如果没有则使用分组级别的特效
            const keywordItem = typeof kwObj === 'string' ? null : kwObj;

            // 浼樺厛绾э細鍗曚釜鍏抽敭璇嶉」鐩壒鏁?> 分组级别特效 > 默认特效
            let rawEffectId = keywordItem?.effectId || group.effectId || group.effectConfig?.type || 'pulse-scale';

            // 銆愯皟璇曟棩蹇椼€戞樉绀哄摢涓骇鍒殑鐗规晥琚娇鐢?
            if (keywordItem?.effectId) {
              console.log('[ZimuShengcheng] 使用关键词级特效:', {
                keyword,
                effectId: keywordItem.effectId,
                source: 'keyword-item'
              });
            } else if (group.effectId) {
              console.log('[ZimuShengcheng] 使用分组级特效:', {
                keyword,
                effectId: group.effectId,
                source: 'group'
              });
            }

            const effectType = this.normalizeEffectType(rawEffectId);

            // 鍒ゆ柇鏄惁涓哄甫鍔ㄧ敾鐨勭壒鏁?
            const isAnimated = this.isAnimatedEffect(effectType);

            // 【调试日志】记录effectId杞崲鍜屽姩鐢诲垽鏂?
            if (rawEffectId || group.effectId) {
              console.log('[ZimuShengcheng] 关键词特效类型:', {
                keyword,
                rawEffectId,
                normalizedEffectType: effectType,
                isAnimated,
                groupId: group.id,
                groupName: group.name
              });
            }

            // 构建样式：优先使用单个关键词项目的样式，其次使用分组样式
            const style = keywordItem?.styleOverride ?
              this.buildKeywordStyleFromConfig(keywordItem.styleOverride) :
              this.buildKeywordStyle(group);

            // 计算时间
            const { start: startTime, end: endTime } = this.getSegmentRangeTiming(
              segment,
              pos,
              pos + cleanedKeyword.length
            );

            // 🔧 使用单个关键词项目的特效配置，如果没有则使用分组配置
            const itemEffectConfig = keywordItem?.effectConfig;
            const groupEffectConfig = group.effectConfig;
            const effectConfig = itemEffectConfig || groupEffectConfig || {
              type: effectType,
              duration: 600,
              delay: 0,
              intensity: 0.8
            };

            // 🔧 淇锟斤拷锟芥纭鐞?effectDuration 单位
            // 确保 duration 以秒为单位，然后转为毫秒
            let durationInSeconds = itemEffectConfig?.duration || groupEffectConfig?.duration || this.config.minSubtitleDuration || 2;

            // 如果 duration 宸茬粡寰堝ぇ锛堣秴杩?00锛夛紝鍋囪瀹冨凡缁忔槸姣锛岃浆鎹㈠洖绉?
            if (durationInSeconds > 100) {
              durationInSeconds = durationInSeconds / 1000;
            }

            // 确保最小时长为 0.1 绉掞紝鏈€澶т负瀛楀箷瀹為檯鏃堕暱鐨?0鍊?
            const minDuration = 0.1;
            const maxDuration = (endTime - startTime) * 10;
            const finalDuration = Math.max(minDuration, Math.min(durationInSeconds, maxDuration));

            const matchData: KeywordMatch = {
              keyword: cleanedKeyword, // 浣跨敤娓呯悊鍚庣殑鍏抽敭璇?
              startIndex: pos,
              endIndex: pos + cleanedKeyword.length,
              startTime,
              endTime,
              groupId: group.id,
              groupName: group.name,
              effectType,
              isAnimated,
              style,
              // 🔧 完整的特效配置（来自单个词汇或分组）
              effectConfig,
              effectStyle: style,
              effectIntensity: itemEffectConfig?.intensity || groupEffectConfig?.intensity || 0.8,
              // 转换为毫秒（确保单位一致）
              effectDuration: finalDuration * 1000,
              // 🆕 浼犻€掕创绾搁厤缃?- 优先从顶层读取（与保存逻辑一致）
              stickerId: (group as any).stickerId || group.styleOverride?.stickerId || group.styleConfig?.stickerId,
              stickerConfig: (group as any).stickerConfig || group.styleOverride?.stickerConfig || group.styleConfig?.stickerConfig
            };

            matches.push(matchData);

            console.log('[ZimuShengcheng.matchKeywords] 添加关键词匹配:', {
              originalKeyword: keyword,
              cleanedKeyword,
              effectType,
              hasItemEffect: !!keywordItem?.effectId,
              hasGroupEffect: !!group.effectId,
              startTime,
              endTime
            });

            // 🆕 鍙尮閰嶄竴娆★紝涓嶅啀缁х画鏌ユ壘璇ュ叧閿瘝鐨勫叾浠栧嚭鐜颁綅缃?
          }
        }
      }
    }

    console.log('[ZimuShengcheng] 匹配到关键词数量:', matches.length);
    return matches;
  }

  /**
   * 灏?effectId（kebab-case）转换为 SNAKE_CASE 格式
   * 渚嬪锛?pulse-scale' -> 'PULSE_SCALE'
   * @private
   */
  private normalizeEffectType(effectId: string | undefined): string {
    if (!effectId || effectId === 'none') {
      return 'PULSE_SCALE'; // 默认特效
    }

    // 濡傛灉宸茬粡鏄?SNAKE_CASE 鏍煎紡锛岀洿鎺ヨ繑鍥?
    if (/^[A-Z_]+$/.test(effectId)) {
      return effectId;
    }

    // 转换 kebab-case 鎴?camelCase 鍒?SNAKE_CASE
    return effectId
      .replace(/-/g, '_')  // 将连字符替换为下划线
      .replace(/([a-z])([A-Z])/g, '$1_$2')  // 处理驼峰命名
      .toUpperCase();  // 转为大写
  }

  /**
   * 鍒ゆ柇鐗规晥鏄惁涓哄甫鍔ㄧ敾鐨勭壒鏁?
   * @private
   * 【强制模式】所有关键词都使用动画特效，不受限制
   */
  private isAnimatedEffect(effectType: EffectType | string): boolean {
    // 銆愬己鍒惰繑鍥?true】确保所有关键词都显示为动画特效
    console.log(`[ZimuShengcheng.isAnimatedEffect] 强制返回 true, effectType=${effectType}`);
    return true;
  }

  /**
   * 鏋勫缓鍏抽敭璇嶆牱寮?
   * @private
   */
  private buildKeywordStyle(group: any): any {
    // 优先使用styleOverride，其次styleConfig锛屾渶鍚庝娇鐢ㄩ粯璁ゅ€?
    const style = group.styleOverride || group.styleConfig || {};

    // ✅娣诲姞璇婃柇鏃ュ織锛氳褰曟牱寮忔瀯寤鸿繃绋?
    console.log('[ZimuShengcheng] 构建关键词样式:', {
      groupId: group.id,
      groupName: group.name,
      styleOverride: group.styleOverride,
      styleConfig: group.styleConfig,
      finalStyle: {
        fontName: style.fontName || this.config.subtitleStyle.fontName,
        fontSize: style.fontSize || this.config.subtitleStyle.fontSize * 1.5,
        fontColor: style.fontColor || '#FFD700'
      }
    });

    return {
      fontName: style.fontName || this.config.subtitleStyle.fontName,
      fontSize: style.fontSize || this.config.subtitleStyle.fontSize * 1.5, // 鐗规晥瀛楀箷榛樿澶?.5鍊?
      fontColor: style.fontColor || '#FFD700', // 默认金色
      outlineColor: style.outlineColor || '#FF8C00',
      // 🔧 淇锛氫娇鐢??? 允许0值（无描边）
      outlineWidth: style.outlineWidth ?? 4,
      shadowColor: style.shadowColor,
      shadowBlur: style.shadowBlur,
      shadowOffset: style.shadowOffset,
      backgroundColor: style.backgroundColor || 'transparent',
      backgroundOpacity: style.backgroundOpacity || 0
    };
  }

  /**
   * 🔧 修复：从styleConfig构建KeywordStyle
   * @private
   */
  private buildKeywordStyleFromConfig(styleConfig: any): KeywordStyle {
    if (!styleConfig) {
      return this.buildKeywordStyle({ styleConfig: {} });
    }

    return {
      fontName: styleConfig.fontName || this.config.subtitleStyle.fontName,
      fontSize: styleConfig.fontSize || this.config.subtitleStyle.fontSize * 1.5,
      fontColor: styleConfig.fontColor || '#FFD700',
      outlineColor: styleConfig.outlineColor || '#FF8C00',
      // 🔧 淇锛氫娇鐢??? 允许0值（无描边）
      outlineWidth: styleConfig.outlineWidth ?? 4,
      shadowColor: styleConfig.shadowColor,
      shadowBlur: styleConfig.shadowBlur,
      backgroundColor: styleConfig.backgroundColor || 'transparent',
      backgroundOpacity: styleConfig.backgroundOpacity || 0
    };
  }

  // ==================== 步骤3: 智能排列 ====================

  /**
   * 智能排列字幕，处理换行、换帧、特效字幕定位等
   * @private
   */
  private arrangeSubtitles(
    segments: CorrectedSegment[],
    keywords: KeywordMatch[],
    config: ZimuConfig
  ): ArrangedSubtitle[] {
    const arranged: ArrangedSubtitle[] = [];

    // 🔧 添加全局去重Set,防止同一个关键词被多个segment重复创建
    const createdEffectSubtitles = new Set<string>();

    // 璋冭瘯鏃ュ織锛氭鏌ラ厤缃?
    console.log('[ZimuShengcheng.arrangeSubtitles] 🔧 閰嶇疆妫€鏌?', {
      configMinSubtitleDuration: config.minSubtitleDuration,
      thisConfigMinSubtitleDuration: this.config?.minSubtitleDuration,
      keywordsCount: keywords.length
    });

    // 计算布局约束
    const constraints = this.calculateLayoutConstraints(config);

    // 🔧 淇锛氳繃婊ゆ帀鍙寘鍚?\n 或空白的 segments锛岄槻姝㈢敓鎴愮┖鐧藉瓧骞?
    const validSegments = segments.filter(seg => {
      const trimmed = seg.text.trim();
      // 只保留非空的且不只是换行符的 segments
      const isValid = trimmed.length > 0 && !trimmed.match(/^[\s\n\r\t"'""'']+$/);
      if (!isValid && seg.text) {
        console.log(`[ZimuShengcheng.arrangeSubtitles] 过滤掉空白段: "${seg.text}"`, {
          originalText: seg.text,
          trimmed: trimmed,
          reason: trimmed.length === 0 ? '完全空白' : '只包含换行符'
        });
      }
      return isValid;
    });

    console.log(`[ZimuShengcheng.arrangeSubtitles] Segment 过滤: ${segments.length} -> ${validSegments.length}`, {
      filtered: segments.length - validSegments.length
    });

    for (const segment of validSegments) {
      // 检查该段是否包含关键词
      // 改为基于时间的匹配，避免重复匹配
      const segmentKeywords: KeywordMatch[] = [];
      console.log('[ZimuShengcheng] 检查 segment 中的关键词:', {
        segmentText: segment.text.substring(0, 30),
        segmentTime: `${segment.start.toFixed(3)}-${segment.end.toFixed(3)}`,
        totalKeywords: keywords.length
      });

      // 浣跨敤鏃堕棿鑼冨洿鍖归厤锛岃€屼笉鏄枃鏈悳绱?
      for (const kw of keywords) {
        // 检查关键词的时间是否与当前segment重叠
        if ((kw.startTime >= segment.start && kw.startTime < segment.end) ||
          (kw.endTime > segment.start && kw.endTime <= segment.end) ||
          (kw.startTime <= segment.start && kw.endTime >= segment.end)) {
          // 关键词出现在此segment涓?
          segmentKeywords.push(kw);
          console.log(`[ZimuShengcheng] 关键词时间匹配成功: "${kw.keyword}"`, {
            segmentTime: `${segment.start.toFixed(3)}-${segment.end.toFixed(3)}`,
            keywordTime: `${kw.startTime.toFixed(3)}-${kw.endTime.toFixed(3)}`,
            segmentPreview: segment.text.substring(0, 30) + "..."
          });
        }
      }

      // ✅娣诲姞璇婃柇鏃ュ織
      if (segmentKeywords.length > 0) {
        console.log('[ZimuShengcheng] segment 中找到关键词:', {
          segmentText: segment.text.substring(0, 30),
          segmentTime: `${segment.start.toFixed(3)}-${segment.end.toFixed(3)}`,
          keywords: segmentKeywords.map(kw => ({
            keyword: kw.keyword,
            time: `${kw.startTime.toFixed(3)}-${kw.endTime.toFixed(3)}`,
            isAnimated: kw.isAnimated,
            effectType: kw.effectType
          }))
        });
      }

      // 【新策略】无论是否有关键词，都创建一个完整的普通字幕（包含所有原始文本）
      // 普通字幕显示完整的原始文本，标点符号替换为空格
      const normalSubtitle = this.createNormalSubtitle(segment, config, constraints, segmentKeywords);
      if (normalSubtitle) {
        arranged.push(normalSubtitle);
      }

      if (this.isInlineKeywordRenderMode(config)) {
        continue;
      }

      if ((normalSubtitle as any)?._suppressEffectSubtitle) {
        console.log('[ZimuShengcheng] 当前字幕以普通字幕整句显示，跳过浮动关键词特效:', {
          segmentText: segment.text.substring(0, 30),
          keywordCount: segmentKeywords.length
        });
        continue;
      }

      // 濡傛灉鏈夊叧閿瘝锛屼负姣忎釜鍏抽敭璇嶅垱寤虹壒鏁堝瓧骞?      // 特效字幕和普通字幕并行显示，互不干扰
      if (segmentKeywords.length > 0) {
        // 🔧 鍏抽敭淇锛氭鏌ユ槸鍚︽湁澶氫釜鍏抽敭璇嶅悓鏃跺嚭鐜?
        // 濡傛灉鏈夊涓瓧骞曞悓鏃舵樉绀猴紝浣跨敤闈欐€佺壒鏁堣€屼笉鏄姩鐢荤壒鏁?
        // 杩欐牱鍙互閬垮厤鍔ㄧ敾浣嶇疆鍙樺寲瀵艰嚧鐨勮仛闆嗛棶棰?
        const hasMultipleSimultaneous = segmentKeywords.some((kw1, i) =>
          segmentKeywords.some((kw2, j) =>
            i !== j &&
            kw1.startTime < kw2.endTime && kw2.startTime < kw1.endTime
          )
        );

        for (const keyword of segmentKeywords) {
          // 🔧 检查是否已经创建过这个特效字幕(鍩轰簬鍏抽敭璇嶆枃鏈?时间)
          const effectKey = `${keyword.keyword}-${keyword.startTime.toFixed(3)}-${keyword.endTime.toFixed(3)}`;
          if (createdEffectSubtitles.has(effectKey)) {
            console.log('[ZimuShengcheng] 跳过重复特效字幕:', {
              keyword: keyword.keyword,
              time: `${keyword.startTime.toFixed(2)}s-${keyword.endTime.toFixed(2)}s`
            });
            continue;
          }
          createdEffectSubtitles.add(effectKey);

          // 涓鸿鍏抽敭璇嶅垱寤轰竴涓椂闂寸墖娈靛璞?
          const keywordPart = {
            text: keyword.keyword,
            start: keyword.startTime,
            end: keyword.endTime,
            isKeyword: true
          };

          // 🔧 鍏抽敭锛氬鏋滄湁澶氫釜瀛楀箷鍚屾椂鍑虹幇锛岄兘浣跨敤闈欐€佺壒鏁?
          // 这样避免了动画位置变化问题，保证字幕停留在分配的位置
          if (keyword.isAnimated && !hasMultipleSimultaneous) {
            // 鍗曚釜瀛楀箷涓旀湁鍔ㄧ敾锛氬垱寤哄姩鐢荤壒鏁堝瓧骞?
            const effectSubtitle = this.createAnimatedEffectSubtitle(keywordPart, keyword, config);
            arranged.push(effectSubtitle);
            console.log('[ZimuShengcheng] 创建动画特效字幕:', {
              keyword: keyword.keyword,
              effectType: keyword.effectType,
              type: effectSubtitle.type
            });
          } else {
            // 多个同时出现 鎴?涓嶅甫鍔ㄧ敾锛氬垱寤洪潤鎬佺壒鏁堝瓧骞?
            const effectSubtitle = this.createStaticEffectSubtitle(keywordPart, keyword, config);
            arranged.push(effectSubtitle);
            console.log('[ZimuShengcheng] 创建静态特效字幕:', {
              keyword: keyword.keyword,
              type: effectSubtitle.type,
              hasMultiple: hasMultipleSimultaneous
            });
          }
        }
      }
    }

    // 🔧 鏀硅繘锛氭€绘槸鍚敤鏅鸿兘甯冨眬锛屼絾瀹冧細鏅鸿兘鍒ゆ柇鏄惁闇€瑕佽皟鏁?
    // 濡傛灉娌℃湁瀹為檯鐨勫爢鍙狅紙澶氫釜瀛楀箷鍚屾椂鏄剧ず锛夛紝瀹冨皢淇濇寔鐢ㄦ埛鐨勫師濮嬪潗鏍?
    // 濡傛灉鏈夊爢鍙狅紝鎵嶄細搴旂敤鍒嗘暎绠楁硶锛岄槻姝㈠瓧骞曢噸鍙?

    console.log('[ZimuShengcheng.arrangeSubtitles] 启用智能碰撞检测（智能模式 - 浠呭湪鏈夊爢鍙犳椂璋冩暣锛?', {
      total: arranged.length,
      normal: arranged.filter(s => s.type === 'normal').length,
      effect_complex: arranged.filter(s => s.type === 'effect_complex').length,
      effect_simple: arranged.filter(s => s.type === 'effect_simple').length
    });

    // 🔧 修复竖屏视频字幕位置：检测视频方向，为竖屏添加更大的安全边距
    const isPortrait = config.videoHeight > config.videoWidth;
    // 瀵逛簬绔栧睆瑙嗛锛屼娇鐢ㄦ洿灏忕殑杈硅窛鐧惧垎姣旓紙纭繚瀛楀箷涓嶄細瓒呭嚭灞忓箷锛?
    // 绔栧睆锛氫娇鐢?4% 鐨勫瀭鐩磋竟璺濓紙鐩告瘮妯睆鐨?10%锛?
    // 这样 1280px 高的视频：margin = 51px锛堟瘮鍘熸潵鐨?128px 更安全）
    const verticalMarginPercent = isPortrait ? 0.04 : 0.1;
    const horizontalMarginPercent = isPortrait ? 0.05 : 0.1;

    const layoutManager = new SmartLayoutManager(
      config.videoWidth,
      config.videoHeight,
      config.videoWidth * horizontalMarginPercent,  // horizontalMargin
      config.videoHeight * verticalMarginPercent    // verticalMargin
    );

    // 🔧 修复竖屏视频字幕Y坐标计算
    // 鍏抽敭鏀硅繘锛?
    // 1. 底部安全区域 = 视频高度 - 字体大小 * 1.8 - 50px（为下降线留出空间）
    // 2. 顶部安全区域 = 字体大小 + 50px
    const fontSize = config.subtitleStyle.fontSize || 48;
    const bottomSafeY = config.videoHeight - fontSize * 1.8 - 50;  // 底部安全Y坐标
    const topSafeY = fontSize + 50;  // 顶部安全Y坐标

    // 🔧 计算特效字幕的Y坐标
    // 重要：如果用户在设置界面明确设置了坐标，保留用户设置（即使超出安全范围）
    // 只有当用户使用默认值时，才应用安全边界
    let effectSubtitleY: number;
    let isUserCustomY = false;

    if (config.effectSubtitleY !== undefined && config.effectSubtitleY !== null) {
      // 鐢ㄦ埛鏄庣‘璁剧疆浜嗗潗鏍?- 保留用户设置
      effectSubtitleY = config.videoHeight * (100 - config.effectSubtitleY) / 100;
      isUserCustomY = true;
      if (effectSubtitleY < topSafeY || effectSubtitleY > bottomSafeY) {
        console.warn('[ZimuShengcheng.arrangeSubtitles] ⚠️ 用户设置的特效字幕Y坐标超出安全范围:', {
          userY: effectSubtitleY,
          安全范围: `${topSafeY}px - ${bottomSafeY}px`,
          提示: '这可能导致字幕超出屏幕，建议调整设置'
        });
      }
    } else {
      // 鐢ㄦ埛鏈缃潗鏍?- 使用修复后的默认值（带安全边界）
      effectSubtitleY = bottomSafeY;
      isUserCustomY = false;
    }

    console.log('[ZimuShengcheng.arrangeSubtitles] 特效字幕 Y 坐标校验:', {
      userSetting: config.effectSubtitleY,
      computedY: effectSubtitleY.toFixed(1),
      isUserCustomY: isUserCustomY ? 'yes' : 'no',
      safeRange: `${topSafeY}px - ${bottomSafeY}px`,
      videoHeight: config.videoHeight,
      orientation: isPortrait ? 'portrait' : 'landscape',
      fontSize
    });

    // 调用特效字幕碰撞检测和左右分散调整
    console.log('[ZimuShengcheng.arrangeSubtitles] 🔍 布局调整前，特效字幕位置:', arranged
      .filter(s => s.type === 'effect_complex' || s.type === 'effect_simple')
      .slice(0, 5)
      .map((s, i) => ({
        index: i,
        text: s.text.substring(0, 15),
        type: s.type,
        x: s.position.x.toFixed(0),
        y: s.position.y.toFixed(0),
        animationType: s.animationConfig?.parameters?.effectType
      }))
    );

    const layoutResult = layoutManager.resolveEffectSubtitleCollisions(
      arranged,
      {
        effectSubtitleY: effectSubtitleY,
        minHorizontalGap: config.subtitleStyle.fontSize * 1.2,
        maxHorizontalOffset: config.videoWidth * 0.35,
        screenWidth: config.videoWidth,
        videoWidth: config.videoWidth,  // 閬胯璁＄畻闇€瑕?
        videoHeight: config.videoHeight,
        avoidanceConfig: config.avoidanceConfig  // 🔧 鍏抽敭锛氫紶鍏ラ伩璁╅厤缃?
      }
    );

    console.log('[ZimuShengcheng.arrangeSubtitles] 🔍 布局调整后，特效字幕位置（详细）:', layoutResult
      .filter(s => s.type === 'effect_complex' || s.type === 'effect_simple')
      .map((s, i) => ({
        index: i,
        text: s.text.substring(0, 15),
        type: s.type,
        x: s.position.x.toFixed(0),
        y: s.position.y.toFixed(0),
        animationType: s.animationConfig?.parameters?.effectType
      }))
    );

    // 💡 关键诊断：显示所有特效字幕的X坐标
    const effectSubtitlesAfter = layoutResult.filter(s => s.type === 'effect_complex' || s.type === 'effect_simple');
    console.log('[ZimuShengcheng.arrangeSubtitles] 💡 调整后所有特效字幕的X坐标:');
    effectSubtitlesAfter.forEach((s, i) => {
      console.log(`  [${i}] ${s.text}: x=${s.position.x.toFixed(0)}`);
    });

    console.log('[ZimuShengcheng.arrangeSubtitles] 碰撞检测完成，结果数量:', layoutResult.length);

    // 🔧 关键检查：验证SmartLayoutManager前后的特效字幕数量和位置
    const effectSubtitlesBefore = arranged.filter(s => s.type === 'effect_complex' || s.type === 'effect_simple');
    const effectSubtitlesAfterLayout = layoutResult.filter(s => s.type === 'effect_complex' || s.type === 'effect_simple');

    console.log('[ZimuShengcheng.arrangeSubtitles] 🔧 SmartLayoutManager前后对比:');
    console.log(`  调用前特效字幕数: ${effectSubtitlesBefore.length}`);
    console.log(`  调用后特效字幕数: ${effectSubtitlesAfterLayout.length}`);

    if (effectSubtitlesBefore.length === 0) {
      console.warn('[ZimuShengcheng.arrangeSubtitles] ⚠️ 没有找到特效字幕！arranged数组中可能没有正确的字幕');
    }

    console.log('[ZimuShengcheng.arrangeSubtitles] 调用后的特效字幕位置:');
    effectSubtitlesAfterLayout.forEach((s, i) => {
      console.log(`  [${i}] \"${s.text}\": x=${s.position.x.toFixed(0)} (应该!=960), type=${s.type}`);
    });

    if (effectSubtitlesAfterLayout.length > 0 && effectSubtitlesAfterLayout.every(s => Math.abs(s.position.x - 960) < 10)) {
      console.error('[ZimuShengcheng.arrangeSubtitles] ❌涓ラ噸闂锛歋martLayoutManager没有修改特效字幕的位置！所有位置都还是960');
    }

    // 🔧 最后的强制修正：根据时间重叠分组特效字幕，确保多个同时出现的字幕能分散位置
    // 杩欐槸涓€涓?fallback锛屼互闃?SmartLayoutManager 娌℃湁姝ｇ‘璧蜂綔鐢?
    const effectSubtitleGroups: ArrangedSubtitle[][] = [];

    for (const subtitle of effectSubtitlesAfterLayout) {
      // 🔧 鏀硅繘锛氭鏌ヤ笌鐜版湁鍒嗙粍鏄惁鏈夋椂闂撮噸鍙狅紝鑰屼笉鏄‘鍒囧尮閰?
      let foundGroup = false;

      for (const group of effectSubtitleGroups) {
        // 检查当前字幕是否与该分组中的任何字幕有时间重叠
        const hasOverlap = group.some(s =>
          (subtitle.start < s.end && subtitle.end > s.start)
        );

        if (hasOverlap) {
          group.push(subtitle);
          foundGroup = true;
          break;
        }
      }

      // 如果没有找到有重叠的分组，创建新分组
      if (!foundGroup) {
        effectSubtitleGroups.push([subtitle]);
      }
    }

    console.log('[ZimuShengcheng.arrangeSubtitles] 🔧 强制位置修正 - 时间重叠分组:', {
      totalSubtitles: effectSubtitlesAfterLayout.length,
      groupCount: effectSubtitleGroups.length,
      groupSizes: effectSubtitleGroups.map(g => g.length)
    });

    let correctedCount = 0;
    for (let groupIdx = 0; groupIdx < effectSubtitleGroups.length; groupIdx++) {
      const group = effectSubtitleGroups[groupIdx];

      if (group.length === 1) {
        // 单个字幕：位置由 SmartLayoutManager 计算，无需强制修正
        // 【修复】不再强制设置位置，保留 SmartLayoutManager 鐨勭粨鏋?
        const sub = group[0];
        console.log(`[ZimuShengcheng.arrangeSubtitles] ✅鍗曚釜瀛楀箷淇濈暀SmartLayoutManager位置: "${sub.text}" x=${sub.position.x.toFixed(0)}`);
      } else {
        // 多个字幕同时出现：位置由 SmartLayoutManager 鐨?left-to-right 逻辑处理
        // 【修复】不再强制设置位置，保留 SmartLayoutManager 计算的左到右排列
        console.log(`[ZimuShengcheng.arrangeSubtitles] ✅澶氬瓧骞曚繚鐣橲martLayoutManager的左到右排列: ${group.map(s => s.text).join(', ')}`);
        const positions = [
          config.videoWidth * 0.25,    // 绗竴涓? 宸?
          config.videoWidth * 0.5,     // 绗簩涓? 涓?
          config.videoWidth * 0.75,    // 绗笁涓? 鍙?
        ];

        // 銆愪慨澶嶃€戜笉鍐嶅己鍒堕噸鏂板垎閰嶄綅缃?- SmartLayoutManager 宸茬粡澶勭悊浜嗗乏鍒板彸鐨勫畨鎺?
        // 淇濈暀鍘熸湁鐨?SmartLayoutManager 计算结果
        console.log(`[ZimuShengcheng.arrangeSubtitles] ✅澶氬瓧骞曠殑SmartLayoutManager位置已保留（不覆盖）:`,
          group.map((s, i) => `[${i}] "${s.text}" x=${s.position.x.toFixed(0)}`).join(', ')
        );
      }
    }

    console.log(`[ZimuShengcheng.arrangeSubtitles] 强制位置修正完成，修正了 ${correctedCount} 个字幕`);

    // 🔧 鍚敤澶氳鎹㈣鍔熻兘锛氬鏅€氬瓧骞曡繘琛岃嚜鍔ㄦ崲琛屽鐞?
    const normalSubtitles = layoutResult.filter(s => s.type === 'normal');
    const otherSubtitles = layoutResult.filter(s => s.type !== 'normal');

    if (normalSubtitles.length > 0) {
      console.log('[ZimuShengcheng.arrangeSubtitles] 瀵规櫘閫氬瓧骞曞惎鐢ㄨ嚜鍔ㄦ崲琛屽鐞?..', {
        normalSubtitleCount: normalSubtitles.length,
        constraints: {
          maxLines: constraints.maxLines,
          maxCharsPerLine: constraints.maxCharsPerLine,
          lineHeight: constraints.lineHeight
        }
      });

      let optimizedNormalSubtitles: ArrangedSubtitle[] = [];
      try {
        optimizedNormalSubtitles = this.optimizeLayout(normalSubtitles, constraints);

        console.log('[ZimuShengcheng.arrangeSubtitles] 自动换行处理完成:', {
          before: normalSubtitles.length,
          after: optimizedNormalSubtitles.length,
          newLineCount: optimizedNormalSubtitles.length - normalSubtitles.length
        });
      } catch (err) {
        console.error('[ZimuShengcheng.arrangeSubtitles] ❌optimizeLayout 涓ラ噸閿欒锛岄檷绾т娇鐢ㄥ師濮嬫櫘閫氬瓧骞?', err);
        // 鍙戠敓閿欒鏃讹紝纭繚涓嶄涪澶卞瓧骞曪紝鐩存帴浣跨敤鍘熷鐨?normalSubtitles
        optimizedNormalSubtitles = normalSubtitles;
      }

      optimizedNormalSubtitles = this.normalizeArrangedNormalSubtitles(optimizedNormalSubtitles);

      // 合并优化后的普通字幕和其他字幕
      return [...optimizedNormalSubtitles, ...otherSubtitles];
    }

    return layoutResult;
  }

  /**
   * 计算布局约束
   * @private
   */
  private calculateLayoutConstraints(config: ZimuConfig): LayoutConstraints {
    const usableWidth = config.videoWidth * 0.8;

    // 🔧 【修复】根据视频方向（横屏/竖屏）使用不同的安全系数
    // 绔栧睆瑙嗛鏈韩灏辩獎锛屼絾鐢ㄦ埛鍙嶉闀挎枃鏈粛浼氳瑁佹帀锛岄渶瑕佽繘涓€姝ュ噺灏忔瘮渚?
    // 妯睆瑙嗛瀹斤紝鍙互浣跨敤鏇翠繚瀹堢殑姣斾緥纭繚涓嶈秴鍑?
    const isPortrait = config.videoHeight > config.videoWidth;
    // 🔧 修复：提高宽度比例到 0.75锛岀粰澶氳瑷€鍏呰冻鐨勬樉绀虹┖闂?
    // 0.68 太保守，导致俄语、日文等文字过度截断
    // 0.75 对所有语言都更友好
    const widthRatio = isPortrait ? 0.68 : 0.76;

    const conservativeUsableWidth = config.videoWidth * widthRatio;
    const maxCharsPerLine = Math.floor(conservativeUsableWidth / config.subtitleStyle.fontSize);
    const horizontalMargin = (config.videoWidth - conservativeUsableWidth) / 2;

    // 🔧 调试：输出计算过程，帮助诊断换行问题
    console.log('[ZimuShengcheng.calculateLayoutConstraints] 💡 布局约束计算:', {
      videoWidth: config.videoWidth,
      videoHeight: config.videoHeight,
      isPortrait: isPortrait,
      widthRatio: widthRatio,
      fontSize: config.subtitleStyle.fontSize,
      usableWidth: usableWidth.toFixed(2),
      conservativeUsableWidth: conservativeUsableWidth.toFixed(2),
      maxCharsPerLine: maxCharsPerLine,
      maxLines: 2,  // 闄愬埗鏈€澶?琛?
      horizontalMargin: horizontalMargin.toFixed(2),
      note: `${isPortrait ? '竖屏' : '横屏'}视频使用${widthRatio}比例`
    });

    return {
      maxLines: 6,  // 🔧 鍏佽鏈€澶?行拆分（每帧2琛岋紝鏈€澶?甯э級锛屾墍鏈夊唴瀹瑰畬鏁存樉绀?
      maxCharsPerLine,
      lineHeight: config.subtitleStyle.fontSize * 1.12,
      horizontalMargin,
      verticalMargin: config.videoHeight * 0.08,
      videoWidth: config.videoWidth,  // 🔧 添加视频宽度，供optimizeLayout使用
      videoHeight: config.videoHeight,  // 🔧 添加视频高度，供optimizeLayout使用
      effectSpacing: 2 // 鐗规晥瀛楀箷涓庢櫘閫氬瓧骞曠殑闂磋窛锛堝瓧绗︽暟锛?
    };
  }

  /**
   * 灏嗘爣鐐圭鍙锋浛鎹负绌烘牸浣滀负鍗犱綅绗?
   * 用于保留原始文本的位置和长度
   * @private
   */
  private normalizeTextForDisplay(text: string): string {
    // 🔧 改进：删除标点符号而不是替换为空格
    // 原因：标点替换为空格会导致文本变长，使用更多屏幕宽度
    // 删除标点可以让文本更紧凑，防止超出屏幕右边界

    // 删除中文标点符号 (包括中文引号"")
    let normalized = text.replace(/[锛屻€傦紒锛燂紱锛氥€屻€嶃€庛€忥紙锛夈€?"]/g, '');

    // 删除常见英文标点符号
    normalized = normalized.replace(/[,.!?;:\(\)\[\]{}"\'"]/g, '');

    console.log(`[ZimuShengcheng.normalizeTextForDisplay] 标点处理:`, {
      original: text.substring(0, 30),
      normalized: normalized.substring(0, 30),
      lengthBefore: text.length,
      lengthAfter: normalized.length
    });

    return normalized;
  }

  /**
   * 灏嗘钀芥寜鍏抽敭璇嶆媶鍒?
   * @private
   */
  private splitSegmentByKeywords(
    segment: CorrectedSegment,
    keywords: KeywordMatch[]
  ): Array<{ text: string; start: number; end: number; isKeyword: boolean }> {
    const parts: any[] = [];
    const text = segment.text;
    let lastIndex = 0;

    // 按关键词位置排序
    const sortedKeywords = keywords.sort((a, b) => a.startIndex - b.startIndex);

    for (const kw of sortedKeywords) {
      // 鍏抽敭璇嶄箣鍓嶇殑鏅€氭枃鏈?
      if (kw.startIndex > lastIndex) {
        const beforeText = text.substring(lastIndex, kw.startIndex);
        const beforeTiming = this.getSegmentRangeTiming(segment, lastIndex, kw.startIndex);
        parts.push({
          text: beforeText,
          start: beforeTiming.start,
          end: beforeTiming.end,
          isKeyword: false
        });
      }

      // 鍏抽敭璇嶆湰韬?
      parts.push({
        text: kw.keyword,
        start: kw.startTime,
        end: kw.endTime,
        isKeyword: true
      });

      lastIndex = kw.endIndex;
    }

    // 鍓╀綑鐨勬櫘閫氭枃鏈?
    if (lastIndex < text.length) {
      const afterText = text.substring(lastIndex);
      const afterTiming = this.getSegmentRangeTiming(segment, lastIndex, text.length);
      parts.push({
        text: afterText,
        start: afterTiming.start,
        end: afterTiming.end,
        isKeyword: false
      });
    }

    return parts;
  }

  private buildNormalSubtitleDisplayText(
    segment: CorrectedSegment,
    keywords: KeywordMatch[],
    config: Pick<ZimuConfig, 'keywordRenderMode'>
  ): { text: string; suppressEffectSubtitle: boolean } {
    const originalText = typeof segment?.text === 'string' ? segment.text : String(segment?.text ?? '');
    if (!originalText || this.isInlineKeywordRenderMode(config) || !Array.isArray(keywords) || keywords.length === 0) {
      return {
        text: originalText,
        suppressEffectSubtitle: false
      };
    }

    const nonKeywordText = this.splitSegmentByKeywords(segment, [...keywords])
      .filter((part) => !part.isKeyword)
      .map((part) => part.text || '')
      .join('')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const normalizedOriginal = this.normalizeTextForDisplay(originalText).trim();
    const normalizedRemaining = this.normalizeTextForDisplay(nonKeywordText).trim();
    const remainingRatio = normalizedOriginal.length > 0
      ? normalizedRemaining.length / normalizedOriginal.length
      : 0;

    // If keywords cover almost the whole sentence, keep the full subtitle and
    // suppress the floating effect subtitle to avoid both skipping and overlap.
    if (!normalizedRemaining || remainingRatio < 0.35) {
      console.log('[ZimuShengcheng] 关键词覆盖比例过高，保留整句普通字幕并关闭浮动特效:', {
        originalText: originalText.substring(0, 30),
        remainingText: nonKeywordText.substring(0, 30),
        remainingRatio
      });
      return {
        text: originalText,
        suppressEffectSubtitle: true
      };
    }

    console.log('[ZimuShengcheng] 浮动关键词模式下剔除普通字幕中的关键词文本:', {
      originalText: originalText.substring(0, 30),
      keywordCount: keywords.length,
      resultText: nonKeywordText.substring(0, 30),
      remainingRatio
    });

    return {
      text: nonKeywordText,
      suppressEffectSubtitle: false
    };
  }

  /**
   * 鍒涘缓鏅€氬瓧骞?
   * @private
   */
  private createNormalSubtitle(
    segment: any,
    config: ZimuConfig,
    constraints: LayoutConstraints,
    segmentKeywords: KeywordMatch[] = []
  ): ArrangedSubtitle | null {
    // 🔧 修复竖屏视频字幕位置：改进Y坐标计算
    const fontSize = config.subtitleStyle.fontSize || 48;
    const isPortrait = config.videoHeight > config.videoWidth;

    // 📍 鏀硅繘鐨勫簳閮╕鍧愭爣璁＄畻锛?
    // 考虑字体下降线（fontSize * 1.8锛夊拰瀹夊叏杈硅窛锛?0px锛?
    // 杩欑‘淇濇櫘閫氬瓧骞曚笉浼氳秴鍑哄睆骞曞簳閮?
    const bottomY = config.videoHeight - fontSize * 1.8 - 50;

    // 添加边界值确保Y坐标始终有效
    const topSafeY = fontSize + 50;
    const bottomSafeY = bottomY;

    // 普通字幕使用原始时长，不受minSubtitleDuration影响
    // minSubtitleDuration浠呮帶鍒剁壒鏁堝瓧骞?
    const start = segment.start;
    const end = segment.end;

    const alignment = config.subtitleStyle.alignment || 'center';
    const displayDecision = this.buildNormalSubtitleDisplayText(segment, segmentKeywords, config);
    const displayText = displayDecision.text;
    if (!displayText.trim()) {
      console.log('[ZimuShengcheng] 普通字幕被关键词特效完全覆盖，跳过基础字幕层:', {
        segmentText: String(segment?.text || '').substring(0, 30),
        keywordCount: segmentKeywords.length
      });
      return null;
    }

    const anchorX = (() => {
      if (config.normalSubtitleX !== undefined && config.normalSubtitleX !== null) {
        return config.videoWidth * config.normalSubtitleX / 100;
      }

      if (alignment === 'right') {
        return config.videoWidth * 0.86;
      }

      if (alignment === 'left') {
        return config.videoWidth * 0.14;
      }

      return config.videoWidth / 2;
    })();

    return {
      type: 'normal',
      // 🔧 保留原始文本（带标点符号），用于智能换行
      // normalize处理（把标点符号替换成空格）将在generateDrawtextCommands鏃惰繘琛?
      text: displayText,
      start,
      end,
      position: {
        x: anchorX,
        // 🔧 修复Y鍧愭爣锛?
        // 濡傛灉鐢ㄦ埛鏄惧紡璁剧疆锛屼繚鐣欑敤鎴疯缃紙鍗充娇瓒呭嚭瀹夊叏鑼冨洿锛?
        // 如果未设置，使用修复后的默认值（考虑文字高度和安全边距）
        y: (() => {
          const requestedPosition = config.subtitleStyle?.position || 'bottom';
          const manualY = config.normalSubtitleY !== undefined && config.normalSubtitleY !== null
            ? config.videoHeight * (100 - config.normalSubtitleY) / 100
            : null;
          const semanticY = requestedPosition === 'top'
            ? topSafeY
            : requestedPosition === 'center'
              ? Math.round(config.videoHeight * 0.5)
              : bottomY;
          const isManualPositionCompatible = manualY !== null && (
            requestedPosition === 'top'
              ? manualY <= config.videoHeight * 0.45
              : requestedPosition === 'center'
                ? manualY >= config.videoHeight * 0.3 && manualY <= config.videoHeight * 0.7
                : manualY >= config.videoHeight * 0.55
          );

          if (manualY !== null && isManualPositionCompatible) {
            // 鐢ㄦ埛鏄庣‘璁剧疆浜嗗潗鏍?- 保留用户设置
            const userY = Math.max(topSafeY, Math.min(manualY, bottomSafeY));
            if (userY < topSafeY || userY > bottomSafeY) {
              console.warn('[createNormalSubtitle] ⚠️ 用户设置的普通字幕Y超出安全范围:', { userY, 安全范围: `${topSafeY}-${bottomSafeY}` });
            }
            return userY;
          } else {
            // 鐢ㄦ埛鏈缃?- 浣跨敤淇鍚庣殑瀹夊叏榛樿鍊?
            return bottomY;
          }
        })(),
        alignment
      },
      style: {
        fontName: config.subtitleStyle.fontName,
        fontSize: config.subtitleStyle.fontSize,
        fontColor: config.subtitleStyle.fontColor,
        outlineColor: config.subtitleStyle.outlineColor,
        outlineWidth: config.subtitleStyle.outlineWidth,
        backgroundColor: config.subtitleStyle.backgroundColor,
        backgroundOpacity: config.subtitleStyle.backgroundOpacity,
        shadowOffset: config.subtitleStyle.shadowOffset,
        shadowColor: config.subtitleStyle.shadowColor,
        shadowBlur: config.subtitleStyle.shadowBlur
      },
      layer: 'drawtext', // 【纯drawtext方案】普通字幕也用drawtext渲染
      ...(displayDecision.suppressEffectSubtitle ? { _suppressEffectSubtitle: true } : {})
    };
  }

  /**
   * 🆕 鑾峰彇鍏抽敭璇嶇粍鐨勪綅缃厤缃?
   * @private
   */
  private getGroupPosition(groupName: string, config: ZimuConfig): import('./ZimuShengcheng.types').KeywordGroupPositionConfig | undefined {
    return config.keywordGroupPositions?.find(p => p.groupName === groupName);
  }

  /**
   * 🆕 估算字幕尺寸（用于碰撞检测）
   * @private
   */
  private estimateSubtitleDimensions(
    text: string,
    fontSize: number,
    fontName?: string
  ): { width: number; height: number } {
    // 估算公式（基于常见字体的宽高比）
    // 中文字符：宽度约等于 fontSize，高度约等于 fontSize
    // 英文字符：宽度约等于 fontSize * 0.6，高度约等于 fontSize

    const chineseCharCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishCharCount = (text.match(/[a-zA-Z]/g) || []).length;
    const otherCharCount = text.length - chineseCharCount - englishCharCount;

    // 估算宽度（像素）
    const estimatedWidth =
      (chineseCharCount * fontSize) +
      (englishCharCount * fontSize * 0.6) +
      (otherCharCount * fontSize * 0.5) +  // 数字、符号等
      (fontSize * 0.3);  // 瀛楅棿璺?

    // 估算高度（像素）= 字体高度 + 上下边距
    const estimatedHeight = fontSize + fontSize * 0.3;

    return {
      width: Math.ceil(estimatedWidth),
      height: Math.ceil(estimatedHeight)
    };
  }

  /**
   * 创建带动画的特效字幕
   * @private
   */
  private createAnimatedEffectSubtitle(
    part: any,
    keyword: KeywordMatch,
    config: ZimuConfig
  ): ArrangedSubtitle {
    // 🔧 修复：特效字幕应该靠近普通字幕底部，而不是固定在上方30%
    // 瀵逛簬绔栧睆瑙嗛锛屽瓧骞曚綅缃渶瑕佺壒娈婂鐞?
    const isPortrait = config.videoHeight > config.videoWidth;
    const fontSize = config.subtitleStyle.fontSize || 48;

    // 🆕 鑾峰彇鍏抽敭璇嶇粍鐨勪綅缃厤缃?
    const groupPosition = this.getGroupPosition(keyword.groupName, config);

    // 📍 鏀硅繘鐨刌鍧愭爣璁＄畻閫昏緫锛?
    // 底部安全位置：videoHeight - fontSize * 1.8 - 50锛堣€冭檻涓嬮檷绾垮拰杈硅窛锛?
    // 杩欑‘淇濇枃瀛椾笉浼氳秴鍑哄睆骞曚笅鏂?
    const bottomY = config.videoHeight - fontSize * 1.8 - 50;
    const topY = bottomY - fontSize - 5; // 鐗规晥瀛楀箷鍦ㄦ櫘閫氬瓧骞曚笂鏂?

    // 🔧 修复：使用关键词中的样式配置覆盖默认样式
    const effectStyle = {
      ...keyword.style,
      // 濡傛灉鍏抽敭璇嶆湁鐗规畩鏍峰紡锛屼娇鐢ㄥ叧閿瘝鐨勬牱寮?
      ...(keyword.effectStyle || {})
    };

    // 🔧 新增：应用最小时长限制到特效字幕
    let start = part.start;
    let end = part.end;
    const actualDuration = end - start;
    if (config.minSubtitleDuration && actualDuration < config.minSubtitleDuration) {
      end = start + config.minSubtitleDuration;
      console.log('[createAnimatedEffectSubtitle] 搴旂敤鏈€灏忔椂闀块檺鍒?', {
        keyword: part.text,
        originalDuration: actualDuration,
        minDuration: config.minSubtitleDuration,
        newEnd: end
      });
    }

    // 璋冭瘯鏃ュ織锛氳緭鍑洪厤缃殑鏈€灏忔椂闀?
    console.log('[createAnimatedEffectSubtitle] 🔧 调试信息:', {
      keyword: part.text,
      configMinDuration: config.minSubtitleDuration,
      thisConfigMinDuration: this.config?.minSubtitleDuration,
      finalDuration: (config.minSubtitleDuration || 2) * 1000,
      start,
      end
    });

    // 🆕 计算字幕尺寸（用于碰撞检测）
    const dimensions = this.estimateSubtitleDimensions(part.text, fontSize);

    // 🆕 璁＄畻瀹為檯缁撴潫鏃堕棿锛堣€冭檻鍔ㄧ敾鏃堕暱锛?
    // 🔧 浼樺厛浣跨敤鍒嗙粍鐨?effectDuration锛屾病鏈夊垯浣跨敤鍏ㄥ眬榛樿鍊?
    const keywordGroup = config.keywordGroups?.find(g => g.name === keyword.groupName);
    const groupEffectDuration = keywordGroup?.effectDuration;
    const animationDurationSeconds = groupEffectDuration ?? config.minSubtitleDuration ?? 2;
    // 🔧 修复：start/end 是毫秒，需要将秒转换为毫秒
    const animationDurationMs = animationDurationSeconds * 1000;
    const actualEnd = Math.max(end, start + animationDurationMs);
    console.log('[createAnimatedEffectSubtitle] effectiveEnd计算:', {
      text: part.text,
      groupName: keyword.groupName,
      groupEffectDuration: groupEffectDuration,
      globalMinDuration: config.minSubtitleDuration,
      usedDuration: animationDurationSeconds,
      animationDurationMs: animationDurationMs,
      start: start.toFixed(2),
      end: end.toFixed(2),
      effectiveEnd: actualEnd.toFixed(2)
    });

    // 🆕 使用Group位置或全局位置
    const effectX = groupPosition?.effectX ?? config.effectSubtitleX ?? 50;
    const hasCustomEffectY = groupPosition?.effectY !== undefined ||
      (config.effectSubtitleY !== undefined && config.effectSubtitleY !== null);
    const effectYPixel = hasCustomEffectY
      ? config.videoHeight * (100 - (groupPosition?.effectY ?? config.effectSubtitleY ?? 50)) / 100
      : topY;

    const subtitle: ArrangedSubtitle = {
      type: 'effect_complex',
      text: part.text,
      start: start,
      end: end,
      position: {
        // 🆕 使用Group坐标或全局坐标（百分比转像素）
        x: config.videoWidth * effectX / 100,
        // 🆕 Y坐标计算：未显式配置时默认放在普通字幕上方，避免和基础字幕叠字
        y: (() => {
          const topBound = fontSize + 50;  // 顶部安全边界
          const bottomBound = config.videoHeight - fontSize * 1.8 - 50;  // 底部安全边界
          const calcY = effectYPixel;

          if (calcY < topBound || calcY > bottomBound) {
            console.warn('[createAnimatedEffectSubtitle] ⚠️ 设置的特效字幕Y超出安全范围:', {
              groupName: keyword.groupName,
              calcY,
              安全范围: `${topBound}-${bottomBound}`
            });
          }
          return calcY;
        })(),
        alignment: 'center'
      },

      // 🆕 新增字段
      width: dimensions.width,          // 字幕宽度
      height: dimensions.height,        // 字幕高度
      keywordGroup: keyword.groupName,  // 关键词组名称
      effectiveEnd: actualEnd,          // 瀹為檯缁撴潫鏃堕棿锛堣€冭檻鍔ㄧ敾鏃堕暱锛?

      style: effectStyle,
      layer: 'drawtext', // 使用drawtext渲染
      animationConfig: {
        type: 'slide',
        duration: animationDurationSeconds * 1000,  // 🔧 浣跨敤鍒嗙粍鐨?effectDuration
        delay: 0,
        // 🔧 从关键词的特效配置中获取完整参数
        intensity: keyword.effectIntensity || 0.8,
        parameters: {
          effectType: keyword.effectType || 'SLIDE_IN_UP',
          // 🔧 传递完整的特效配置参数
          effectConfig: keyword.effectConfig,
          effectStyle: keyword.effectStyle,
          // 🔧 确保duration同步：使用分组的 effectDuration
          duration: animationDurationSeconds * 1000,
          // 🔧 鍏抽敭锛氭爣璁版鍔ㄧ敾闇€瑕佺瓑寰呬綅缃垎閰嶅畬鎴愬悗鍐嶇敓鎴?
          waitForPositionAssignment: true
        },
        // 🆕 浼犻€掕创绾镐俊鎭?
        stickerId: keyword.stickerId,
        stickerConfig: keyword.stickerConfig
      }
    };

    // 🔍 璋冭瘯锛氳緭鍑鸿创绾镐俊鎭?
    console.log(`[createAnimatedEffectSubtitle] 鍒涘缓鐗规晥瀛楀箷锛岃创绾镐俊鎭?`, {
      text: part.text,
      groupName: keyword.groupName,
      stickerId: keyword.stickerId,
      hasStickerConfig: !!keyword.stickerConfig,
      animationConfigStickerId: subtitle.animationConfig?.stickerId
    });

    return subtitle;
  }

  /**
   * 鍒涘缓闈欐€佺壒鏁堝瓧骞曪紙涓嶅甫鍔ㄧ敾锛?
   * @private
   */
  private createStaticEffectSubtitle(
    part: any,
    keyword: KeywordMatch,
    config: ZimuConfig
  ): ArrangedSubtitle {
    // 🔧 修复竖屏视频字幕位置：改进Y坐标计算
    const fontSize = config.subtitleStyle.fontSize || 48;
    const isPortrait = config.videoHeight > config.videoWidth;

    // 🆕 鑾峰彇鍏抽敭璇嶇粍鐨勪綅缃厤缃?
    const groupPosition = this.getGroupPosition(keyword.groupName, config);

    // 📍 鏀硅繘鐨勫簳閮╕鍧愭爣璁＄畻锛?
    // 静态特效字幕也使用安全底部位置
    const bottomY = config.videoHeight - fontSize * 1.8 - 50;

    // 娣诲姞杈圭晫鍊?
    const topSafeY = fontSize + 50;
    const bottomSafeY = bottomY;

    // 🔧 鏂板锛氬簲鐢ㄦ渶灏忔椂闀块檺鍒跺埌闈欐€佺壒鏁堝瓧骞?
    let start = part.start;
    let end = part.end;
    const actualDuration = end - start;
    if (config.minSubtitleDuration && actualDuration < config.minSubtitleDuration) {
      end = start + config.minSubtitleDuration;
      console.log('[createStaticEffectSubtitle] 搴旂敤鏈€灏忔椂闀块檺鍒?', {
        keyword: part.text,
        originalDuration: actualDuration,
        minDuration: config.minSubtitleDuration,
        newEnd: end
      });
    }

    // 🆕 计算字幕尺寸
    const dimensions = this.estimateSubtitleDimensions(part.text, fontSize);

    // 🆕 使用Group位置或全局位置
    const effectX = groupPosition?.effectX ?? config.effectSubtitleX ?? 50;
    const hasCustomEffectY = groupPosition?.effectY !== undefined ||
      (config.effectSubtitleY !== undefined && config.effectSubtitleY !== null);
    const effectYPixel = hasCustomEffectY
      ? config.videoHeight * (100 - (groupPosition?.effectY ?? config.effectSubtitleY ?? 50)) / 100
      : Math.max(topSafeY, Math.min(bottomY - fontSize - 5, bottomSafeY));

    return {
      type: 'effect_simple',
      text: part.text,
      start: start,
      end: end,
      position: {
        // 🆕 使用Group坐标或全局坐标（百分比转像素）
        x: config.videoWidth * effectX / 100,
        // 🆕 Y坐标计算：未显式配置时默认放在普通字幕上方，避免和基础字幕叠字
        y: (() => {
          const calcY = effectYPixel;
          if (calcY < topSafeY || calcY > bottomSafeY) {
            console.warn('[createStaticEffectSubtitle] ⚠️ 设置的静态特效字幕Y超出安全范围:', {
              groupName: keyword.groupName,
              calcY,
              安全范围: `${topSafeY}-${bottomSafeY}`
            });
          }
          return calcY;
        })(),
        alignment: 'center'
      },

      // 🆕 新增字段
      width: dimensions.width,          // 字幕宽度
      height: dimensions.height,        // 字幕高度
      keywordGroup: keyword.groupName,  // 关键词组名称
      effectiveEnd: end,                // 瀹為檯缁撴潫鏃堕棿锛堥潤鎬佺壒鏁堟棤鍔ㄧ敾鏃堕暱锛?

      style: keyword.style,
      layer: 'ass_effect', // 使用ASS渲染
      // 🆕 浼犻€掕创绾镐俊鎭?
      stickerId: keyword.stickerId,
      stickerConfig: keyword.stickerConfig,
      // 🔧 修复：添加特效类型配置，确保effect_simple涔熻兘搴旂敤姝ｇ‘鐨勭壒鏁?
      animationConfig: keyword.effectType ? {
        type: 'slide', // 动画类型占位
        duration: keyword.effectDuration || 2000,
        intensity: keyword.intensity || 0.8,
        delay: 0,
        parameters: {
          effectType: keyword.effectType, // 保存真实的特效类型（如DANMAKU、ARC_TEXT锛?
          speed: keyword.speed || 1.0
        }
      } : undefined
    };
  }

  /**
   * 浼樺寲甯冨眬锛堝鐞嗘崲琛屽拰鎹㈠抚閫昏緫锛?
   * 重新设计：实现完整的智能排版逻辑
   * @private
   */
  private optimizeLayout(
    subtitles: ArrangedSubtitle[],
    constraints: LayoutConstraints
  ): ArrangedSubtitle[] {
    const optimized: ArrangedSubtitle[] = [];
    const MAX_LINES = constraints.maxLines || 2;

    // 🔧 改进：更精确的宽度计算，考虑实际字体宽度比例
    // 根据大多数等宽或比例字体的特性：
    // - 中文字符宽度 ≥瀛椾綋楂樺害锛堟鏂瑰舰锛?
    // - 英文字母平均宽度 ≥瀛椾綋楂樺害 * 0.5
    // - 数字宽度 ≥瀛椾綋楂樺害 * 0.5
    // - 标点符号宽度 ≥瀛椾綋楂樺害 * 0.3
    const calculateDisplayLength = (text: string): number => {
      let length = 0;
      for (const char of text) {
        if (/[\u4e00-\u9fff]/.test(char)) {
          // 中文字符：占1涓瓧浣撳搴?
          length += 1;
        } else if (/[\u3040-\u309f]/.test(char)) {
          // 🆕 鏃ユ枃骞冲亣鍚嶏紙銇?ん）：占1涓瓧浣撳搴?
          length += 1;
        } else if (/[\u30a0-\u30ff]/.test(char)) {
          // 🆕 鏃ユ枃鐗囧亣鍚嶏紙銈?ヴ）：占1涓瓧浣撳搴?
          length += 1;
        } else if (/[\uac00-\ud7af]/.test(char)) {
          // 🆕 韩文（가-힣）：占1涓瓧浣撳搴?
          length += 1;
        } else if (/[\u0400-\u04ff]/.test(char)) {
          // 🆕 瑗块噷灏斿瓧姣嶏紙淇勮銆佷箤鍏嬪叞璇瓑锛夛細鍗?.65涓瓧浣撳搴?
          // 让俄语字符更接近英文宽度，这样能显示更多文字
          length += 0.65;
        } else if (/[a-zA-Z0-9]/.test(char)) {
          // 鑻辨枃瀛楁瘝鍜屾暟瀛楋細鍗?.6涓瓧浣撳搴?
          length += 0.6;
        } else if (/[\s\t\r\n]/.test(char)) {
          // 绌烘牸绛夛細鍗?.3涓瓧浣撳搴?
          length += 0.3;
        } else {
          // 鏍囩偣绗﹀彿绛夛細鍗?.35涓瓧浣撳搴?
          length += 0.35;
        }
      }
      return length;
    };

    // 智能换行：西文按单词边界，中文按字符
    // 🔧 淇锛氶伩鍏嶆妸鍗曡瘝浠庝腑闂存埅鏂紙濡?"Zweig" 琚媶鎴?"Zwe" 鍜?"ig"锛?
    const smartLineBreak = (text: string, maxCharsPerLine: number): string[] => {
      const lines: string[] = [];

      // 🔧 【修复】调整安全系数到 0.95，给予充足的显示空间
      const safetyMargin = 0.95;
      const safeMaxCharsPerLine = maxCharsPerLine * safetyMargin;

      // 🔧 鍒ゆ柇鏄惁涓昏鏄腑鏂?日文/韩文文本
      const cjkCharCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
      const isMostlyCJK = cjkCharCount > text.length * 0.3;

      if (isMostlyCJK) {
        // 🔧 涓棩闊╂枃鏈細鎸夊瓧绗︽媶鍒嗭紙淇濇寔鍘熸湁閫昏緫锛?
        let currentLine = '';
        let currentLength = 0;

        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          const charLength = calculateDisplayLength(char);

          if (currentLength + charLength > safeMaxCharsPerLine && currentLine.length > 0) {
            lines.push(currentLine);
            currentLine = '';
            currentLength = 0;

            if (lines.length >= MAX_LINES) {
              const remainingChars = text.substring(i);
              let truncatedLine = '';
              let truncatedLength = 0;
              for (const c of remainingChars) {
                const cLen = calculateDisplayLength(c);
                if (truncatedLength + cLen <= maxCharsPerLine) {
                  truncatedLine += c;
                  truncatedLength += cLen;
                } else {
                  break;
                }
              }
              if (truncatedLine.length < remainingChars.length) {
                truncatedLine += '...';
              }
              lines[lines.length - 1] += truncatedLine;
              return lines.slice(0, MAX_LINES);
            }
          }
          currentLine += char;
          currentLength += charLength;
        }

        if (currentLine.length > 0) {
          if (lines.length < MAX_LINES) {
            lines.push(currentLine);
          } else {
            lines[lines.length - 1] += currentLine;
          }
        }
      } else {
        // 🔧 銆愬叧閿慨澶嶃€戣タ鏂囷紙鑻辨枃銆佸痉鏂囥€佷縿鏂囩瓑锛夛細鎸夊崟璇嶈竟鐣屾媶鍒?
        // 閬垮厤鎶?"Zweig" 拆成 "Zwe" 鍜?"ig"
        const words = text.split(/\s+/);
        let currentLine = '';
        let currentLength = 0;

        for (const word of words) {
          const wordLength = calculateDisplayLength(word);
          const spaceLength = currentLine ? calculateDisplayLength(' ') : 0;
          const testLength = currentLength + spaceLength + wordLength;

          if (testLength > safeMaxCharsPerLine && currentLine.length > 0) {
            // 褰撳墠琛屽凡婊★紝淇濆瓨骞跺紑濮嬫柊琛?
            lines.push(currentLine.trim());
            currentLine = word;
            currentLength = wordLength;

            if (lines.length >= MAX_LINES) {
              // 已达到最大行数，处理剩余内容
              const remainingWords = words.slice(words.indexOf(word));
              let truncatedLine = remainingWords.join(' ');
              const truncatedLength = calculateDisplayLength(truncatedLine);

              if (truncatedLength > maxCharsPerLine) {
                // 鎴柇澶暱鐨勫唴瀹?
                let finalLine = '';
                let finalLength = 0;
                for (const w of remainingWords) {
                  const wLen = calculateDisplayLength(w);
                  const sLen = finalLine ? 0.3 : 0;  // 空格宽度
                  if (finalLength + sLen + wLen <= maxCharsPerLine) {
                    finalLine += (finalLine ? ' ' : '') + w;
                    finalLength += sLen + wLen;
                  } else {
                    break;
                  }
                }
                if (finalLine.length < truncatedLine.length) {
                  finalLine += '...';
                }
                truncatedLine = finalLine;
              }

              lines[lines.length - 1] = truncatedLine;
              break;
            }
          } else {
            // 添加单词到当前行
            currentLine += (currentLine ? ' ' : '') + word;
            currentLength = calculateDisplayLength(currentLine);
          }
        }

        // 娣诲姞鏈€鍚庝竴琛?
        if (currentLine.length > 0 && lines.length < MAX_LINES) {
          lines.push(currentLine.trim());
        }
      }

      // 🔧 诊断日志（已简化）
      // console.log('[ZimuShengcheng.smartLineBreak] ✅鎷嗗垎瀹屾垚:', { ... });

      return lines.slice(0, MAX_LINES);
    };

    // 🔧 璁＄畻鏂囨湰瀹藉害鐨勮緟鍔╁嚱鏁帮紙涓?SmartLayoutManager 保持一致）
    const calculateTextWidth = (text: string, fontSize: number): number => {
      let width = 0;
      for (const char of text) {
        if (/[\u4e00-\u9fff]/.test(char)) {
          width += fontSize * 0.9; // 中文字符
        } else if (/[\u3040-\u309f]/.test(char)) {
          width += fontSize * 0.9; // 鏃ユ枃骞冲亣鍚?
        } else if (/[\u30a0-\u30ff]/.test(char)) {
          width += fontSize * 0.9; // 鏃ユ枃鐗囧亣鍚?
        } else if (/[\uac00-\ud7af]/.test(char)) {
          width += fontSize * 0.9; // 韩文
        } else if (/[\u0400-\u04ff]/.test(char)) {
          width += fontSize * 0.65; // 瑗块噷灏斿瓧姣嶏紙淇勮銆佷箤鍏嬪叞璇瓑锛?
        } else if (/[a-zA-Z0-9]/.test(char)) {
          width += fontSize * 0.5; // 鑻辨枃瀛楁瘝鍜屾暟瀛?
        } else {
          width += fontSize * 0.3; // 其他字符
        }
      }
      // 🔧 銆愪慨澶嶃€戞瀬澶у箙搴﹀鍔犲畨鍏ㄧ郴鏁帮紝浠?1.6 -> 2.0锛岀‘淇濈粷瀵逛笉浼氳秴鍑哄睆骞?
      // FFmpeg drawtext 鐨勫疄闄呮覆鏌撳搴︿笌浼扮畻鍊煎樊寮傚緢澶э紝蹇呴』浣跨敤鏋侀珮鐨勫畨鍏ㄨ竟璺?
      // 鐢ㄦ埛鍙嶉锛氬嵆浣?1.6 系数，长文本最后的字仍会被裁掉，说明实际宽度远大于估算
      // 使用 2.0 系数意味着估算宽度是实际的两倍，确保绝对安全
      return width * 2.0;
    };

    // 🔧 淇锛氱洿鎺ヤ娇鐢ㄥ疄闄呯殑瑙嗛瀹藉害锛岃€屼笉鏄及绠?
    // 从constraints推导：constraints.maxCharsPerLine = (videoWidth * 0.8) / fontSize
    // 鎵€浠?videoWidth = (maxCharsPerLine * fontSize) / 0.8
    // 但最直接的方式：usableWidth = videoWidth * 0.8，therefore videoWidth = usableWidth / 0.8
    // 鑰?horizontalMargin = videoWidth * 0.1锛屾墍浠?videoWidth = horizontalMargin * 10
    const firstSubtitle = subtitles[0];
    if (!firstSubtitle) {
      return optimized;
    }
    const estimatedScreenWidth = constraints.videoWidth;

    // 处理每个字幕
    for (const subtitle of subtitles) {
      // 🔧 【关键检查】如果字幕已经在 VideoSubtitle.ts 涓垎鎵瑰鐞嗚繃锛岃烦杩?optimizeLayout
      // 杩欎簺瀛楀箷宸茬粡鏈夋纭殑鏃堕棿鍒嗛厤锛屼笉搴旇鍐嶈鎷嗗垎鎴愬琛屽悓鏃舵樉绀?
      if ((subtitle as any)._skipOptimizeLayout) {
        console.log('[ZimuShengcheng.optimizeLayout] ⏭️  璺宠繃宸插垎鎵瑰瓧骞?', {
          text: subtitle.text.substring(0, 30),
          start: subtitle.start,
          end: subtitle.end,
          reason: '此字幕已经过分批处理，不需要再次优化布局'
        });
        optimized.push(subtitle);
        continue;
      }

      const displayLength = calculateDisplayLength(subtitle.text);

      // 🔧 娣诲姞杈圭晫妫€鏌ワ細纭繚瀛楀箷鏂囨湰涓嶈秴鍑哄睆骞?
      let textWidth = calculateTextWidth(subtitle.text, subtitle.style.fontSize);

      // 🔧 銆愭柊澧炪€戝鏋滃瓧骞曟湁鑳屾櫙锛屽鍔犲搴︽潵琛ュ伩鍓嶅悗娣诲姞鐨勭┖鏍?
      // DrawtextGenerator 中会为有背景的字幕前后各添加4涓崐瑙掔┖鏍?
      // 每个半角空格宽度约为 fontSize * 0.3锛屾墍浠ユ€诲鍔?4*2*0.3 = 2.4*fontSize
      const hasBackground = subtitle.style.backgroundColor &&
        subtitle.style.backgroundColor !== 'transparent' &&
        subtitle.style.backgroundOpacity !== undefined &&
        subtitle.style.backgroundOpacity > 0;
      if (hasBackground) {
        const spaceWidth = subtitle.style.fontSize * 2.4;  // 鍓嶅悗鍚?个空格的宽度
        textWidth += spaceWidth;
        // console.log('[ZimuShengcheng.optimizeLayout] 🔧 字幕有背景，增加宽度补偿空格:', { ... });
      }

      const maxTextWidth = estimatedScreenWidth - 2 * constraints.horizontalMargin;

      // 🔧 关键修复：检查文本是否太长，无论如何调整都会超出屏幕
      // 濡傛灉鏄紝寮哄埗鏍囪涓洪渶瑕佹崲琛?
      let forceLineBreak = false;
      if (textWidth > maxTextWidth) {
        forceLineBreak = true;
        console.warn('[ZimuShengcheng.optimizeLayout] ⚠️ 鏂囨湰瀹藉害瓒呰繃鍙敤灞忓箷瀹藉害锛屽己鍒舵崲琛?', {
          text: subtitle.text.substring(0, 50),
          textWidth: textWidth.toFixed(2),
          maxTextWidth: maxTextWidth.toFixed(2),
          overflow: (textWidth - maxTextWidth).toFixed(2)
        });
      }

      // 🔧 智能调整策略 - 鐭枃鏈娇鐢ㄥ睆骞曚腑蹇冿紝闀挎枃鏈皟鏁翠互闃茶秴鍑哄睆骞?
      const screenCenterX = estimatedScreenWidth / 2;
      const leftBound = constraints.horizontalMargin + textWidth / 2;
      const rightBound = estimatedScreenWidth - constraints.horizontalMargin - textWidth / 2;

      let adjustedX = screenCenterX;  // 默认使用屏幕中心
      let positionAdjustmentReason = '使用屏幕中心';

      // 鍙湁鍦ㄤ笉闇€瑕佸己鍒舵崲琛屾椂鎵嶈皟鏁翠綅缃?
      if (!forceLineBreak) {
        if (screenCenterX < leftBound) {
          adjustedX = leftBound;
          positionAdjustmentReason = '文本太长，左边界调整';
        } else if (screenCenterX > rightBound) {
          adjustedX = rightBound;
          positionAdjustmentReason = '文本太长，右边界调整';
        }
      }

      // console.log('[ZimuShengcheng.optimizeLayout] 单行字幕X坐标:', { ... });

      // 🔧 调试：输出每个字幕的换行判断详情（已简化）
      // console.log('[ZimuShengcheng.optimizeLayout] 💡 字幕换行判断:', { ... });

      // 濡傛灉瀛楀箷闀垮害瓒呰繃闄愬埗锛屾垨鏂囨湰瀹藉害瓒呰繃灞忓箷锛岄渶瑕佹崲琛?
      if (displayLength > constraints.maxCharsPerLine || forceLineBreak) {
        const lines = this.shouldUseInlineKeywordOverlay()
          ? this.rebalanceInlineKeywordLines(subtitle.text, smartLineBreak(subtitle.text, constraints.maxCharsPerLine))
          : smartLineBreak(subtitle.text, constraints.maxCharsPerLine);

        // 🔧 添加诊断日志：显示smartLineBreak的详细输出（已简化）
        // console.log('[ZimuShengcheng.optimizeLayout] 🔍 smartLineBreak详细输出:', { ... });

        if (lines.length > 1) {
          // 澶氳瀛楀箷锛氬垱寤哄涓瓧骞曞璞★紝姣忚涓€涓?
          const lineHeight = constraints.lineHeight;
          const originalDuration = subtitle.end - subtitle.start;

          // 🔧 关键修复：为多行字幕调整baseY，确保不超出屏幕底部
          // 原始baseY是为单行设计的，多行需要向上移动以留出足够空间
          // 浣嗚繖鍙鍓?琛屾湁鏁堬紝绗?琛屽強浠ュ悗鏄崟鐙樉绀哄湪涓嬩竴甯э紝涓嶉渶瑕佽皟鏁?
          const linesToDisplay = Math.min(lines.length, 2);  // 褰撳墠甯ф渶澶氭樉绀?琛?
          const totalHeight = linesToDisplay * lineHeight;
          const screenBottom = constraints.videoHeight - constraints.verticalMargin;  // 屏幕底部安全位置
          const multilineLift = linesToDisplay > 1 ? Math.round(lineHeight * 0.55) : 0;
          const adjustedBaseY = Math.max(
            constraints.verticalMargin + lineHeight,
            Math.min(subtitle.position.y - multilineLift, screenBottom - totalHeight + lineHeight)
          );

          // console.log('[ZimuShengcheng.optimizeLayout] 📏 多行字幕Y坐标调整:', { ... });

          // 🔧 【核心改进】多行字幕按时间比例分帧显示
          // 姣忓抚鏈€澶?琛岋紝鍦ㄥ師濮嬫椂闂存鍐呭钩鍧囧垎閰嶏紝涓嶆埅鏂换浣曞唴瀹?
          // 渚嬪锛?行内容在2秒内，拆分为：第1-2琛?0-1绉掞紝绗?-4琛?1-2绉?
          const LINES_PER_FRAME = 2;
          const totalFrames = Math.ceil(lines.length / LINES_PER_FRAME);
          const frameWeights = Array.from({ length: totalFrames }, (_, frameIndex) => {
            const frameLines = lines.slice(frameIndex * LINES_PER_FRAME, (frameIndex + 1) * LINES_PER_FRAME);
            const frameTextWeight = frameLines.reduce((sum, frameLine) => sum + Math.max(1, calculateDisplayLength(frameLine)), 0);
            return Math.max(1, frameTextWeight);
          });
          const totalFrameWeight = frameWeights.reduce((sum, weight) => sum + weight, 0);
          const frameTimings = frameWeights.map((weight, frameIndex) => {
            const startRatio = frameWeights.slice(0, frameIndex).reduce((sum, item) => sum + item, 0) / totalFrameWeight;
            const endRatio = frameWeights.slice(0, frameIndex + 1).reduce((sum, item) => sum + item, 0) / totalFrameWeight;
            return {
              start: subtitle.start + originalDuration * startRatio,
              end: subtitle.start + originalDuration * endRatio
            };
          });

          // console.log('[ZimuShengcheng.optimizeLayout] 📐 多行字幕分帧处理:', { ... });

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const frameIndex = Math.floor(i / LINES_PER_FRAME); // 灞炰簬绗嚑甯?
            const positionInFrame = i % LINES_PER_FRAME; // 鍦ㄨ繖涓€甯т腑鐨勪綅缃?(0 鎴?1)
            const linesInThisFrame = Math.min(LINES_PER_FRAME, lines.length - frameIndex * LINES_PER_FRAME);

            // 🔧 銆愭牳蹇冦€戣绠楄繖涓€琛岀殑鏃堕棿娈?
            const lineStartTime = frameTimings[frameIndex].start;
            const lineEndTime = frameTimings[frameIndex].end;

            // console.log(`[ZimuShengcheng.optimizeLayout] 🔧 鍒涘缓绗?{i + 1}琛屽瓧骞?`, { ... });

            // 🔧 计算Y坐标：每帧内的行使用相同的垂直间距逻辑
            // 如果这帧只有1行，放在底部；如果有2琛岋紝绗?琛屽湪涓婏紝绗?琛屽湪涓?
            let lineY: number;
            if (linesInThisFrame === 1) {
              lineY = adjustedBaseY; // 单行放在底部
            } else {
              // 2行时：positionInFrame=0 在上方，positionInFrame=1 鍦ㄤ笅鏂?
              lineY = adjustedBaseY - (linesInThisFrame - 1 - positionInFrame) * lineHeight;
            }

            // console.log(`[ZimuShengcheng.optimizeLayout] 🆕 绗?{i + 1}行Y坐标计算:`, { ... });

            // 🔧 使用屏幕中心对齐
            const screenCenterX = constraints.videoWidth / 2;
            const lineX = screenCenterX;

            // console.log(`[ZimuShengcheng.optimizeLayout] 澶氳瀛楀箷绗?{i + 1}琛屽潗鏍?`, { ... });

            const lineSubtitle: ArrangedSubtitle = {
              type: subtitle.type,
              text: line,
              start: lineStartTime,
              // 🔧 所有行使用相同的持续时长（如果内容较长，自动延长）
              end: lineEndTime,
              position: {
                x: lineX,
                y: lineY,
                alignment: subtitle.position.alignment || 'center'
              },
              style: {
                ...subtitle.style,
                fontSize: subtitle.style.fontSize // 淇濇寔鍘熷瀛椾綋澶у皬锛岀‘淇濆琛屽瓧浣撲竴鑷?
              },
              layer: subtitle.layer
            };

            // 濡傛灉鏈夊姩鐢婚厤缃紝涔熷鍒惰繃鏉?
            if (subtitle.animationConfig) {
              lineSubtitle.animationConfig = subtitle.animationConfig;
            }

            // console.log(`[ZimuShengcheng.optimizeLayout] ✅绗?{i + 1}行字幕对象已创建，即将push到optimized数组`, { ... });

            optimized.push(lineSubtitle);
          }

          // console.log(`[ZimuShengcheng.optimizeLayout] ✅澶氳瀛楀箷澶勭悊瀹屾垚锛宱ptimized数组中已添加${lines.length}个字幕`, { ... });
        } else {
          // 🔧 关键修复：当 forceLineBreak 涓?true 时，即使 smartLineBreak 鍙繑鍥?1 行，
          // 涔熷簲璇ヤ娇鐢?screenCenterX 鑰屼笉鏄?adjustedX锛岀‘淇濇枃鏈眳涓榻?
          // adjustedX 可能被设置为边界值（leftBound 鎴?rightBound），导致文本偏向右边
          const finalX = forceLineBreak ? (constraints.videoWidth / 2) : adjustedX;

          // console.log('[ZimuShengcheng.optimizeLayout] 鍗曡瀛楀箷浣嶇疆鏈€缁堢‘瀹?', { ... });

          optimized.push({
            ...subtitle,
            position: {
              ...subtitle.position,
              x: finalX
            }
          });
        }
      } else {
        // 字幕长度在限制内，使用调整后的X坐标
        optimized.push({
          ...subtitle,
          position: {
            ...subtitle.position,
            x: adjustedX
          }
        });
      }
    }

    console.log(`[ZimuShengcheng.optimizeLayout] 优化完成: ${subtitles.length} -> ${optimized.length} 个字幕`);
    return optimized;
  }

  // ==================== 步骤4-5: 生成ASS和drawtext ====================

  /**
   * 生成ASS鏂囦欢锛堟櫘閫氬瓧骞曞眰鍜岀畝鍗曠壒鏁堝眰锛?
   * @private
   */
  private async generateASSFiles(
    subtitles: ArrangedSubtitle[],
    config: ZimuConfig
  ): Promise<string[]> {
    const files: string[] = [];

    // 1. 普通字幕层
    const normalSubtitles = subtitles.filter(s => s.layer === 'ass_normal');
    if (normalSubtitles.length > 0) {
      const normalFile = await this.generateNormalASSFile(normalSubtitles, config);
      files.push(normalFile);
    }

    // 2. 特效字幕层（ASS锛?
    const effectSubtitles = subtitles.filter(s => s.layer === 'ass_effect');
    if (effectSubtitles.length > 0) {
      const effectFile = await this.generateEffectASSFile(effectSubtitles, config);
      files.push(effectFile);
    }

    return files;
  }

  /**
   * 生成普通字幕ASS文件
   * @private
   */
  private async generateNormalASSFile(
    subtitles: ArrangedSubtitle[],
    config: ZimuConfig
  ): string {
    // 创建样式
    const normalStyle = ASSGenerator.convertRenderStyleToASS(
      'Normal',
      subtitles[0].style,
      config.videoHeight
    );

    // 创建事件
    const events = subtitles.map(s =>
      ASSGenerator.subtitleToDialogue(s, 'Normal')
    );

    // 生成ASS内容
    const assContent = ASSGenerator.generate(
      events,
      [normalStyle],
      { width: config.videoWidth, height: config.videoHeight, fontDir: config.fontDir }
    );

    // 保存文件
    const tempDir = await this.getTempDir();
    const filePath = `${tempDir}/layer1_normal_${Date.now()}.ass`;
    await ASSGenerator.saveToFile(assContent, filePath);

    return filePath;
  }

  /**
   * 生成特效字幕ASS文件
   * @private
   */
  private async generateEffectASSFile(
    subtitles: ArrangedSubtitle[],
    config: ZimuConfig
  ): Promise<string> {
    // 创建样式（金色特效）
    const effectStyle = this.createGoldEffectStyle(config);

    // 创建事件（带ASS鐗规晥鏍囩锛?
    const events: ASSDialogueEvent[] = subtitles.map(s => {
      const event = ASSGenerator.subtitleToDialogue(s, 'GoldEffect');

      // 添加缩放效果标签
      event.text = ASSGenerator.generateScaleEffect(
        s.text,
        s.position.x,
        s.position.y,
        effectStyle.primaryColour
      );

      return event;
    });

    // 生成ASS内容
    const assContent = ASSGenerator.generate(
      events,
      [effectStyle],
      { width: config.videoWidth, height: config.videoHeight, fontDir: config.fontDir }
    );

    // 保存文件
    const tempDir = await this.getTempDir();
    const filePath = `${tempDir}/layer2_effects_${Date.now()}.ass`;
    await ASSGenerator.saveToFile(assContent, filePath);

    return filePath;
  }

  /**
   * 生成drawtext命令（纯drawtext方案：所有字幕都用drawtext娓叉煋锛?
   * @private
   */
  private generateDrawtextCommands(
    subtitles: ArrangedSubtitle[],
    fontDir: string
  ): string[] {
    const commands: string[] = [];

    console.log('[ZimuShengcheng.generateDrawtextCommands] 开始生成，字幕数量:', subtitles.length);

    // 🔍 关键诊断：检查第一条字幕的时间
    if (subtitles.length > 0) {
      const first = subtitles[0];
      console.log('[ZimuShengcheng] ✅绗竴鏉″瓧骞曠殑鏃堕棿淇℃伅:', {
        start: first.start,
        end: first.end,
        startSec: (first.start / 1000).toFixed(2),
        endSec: (first.end / 1000).toFixed(2),
        text: first.text.substring(0, 30),
        type: first.type
      });
    }

    // 【纯drawtext方案】处理所有字幕，不区分layer
    for (let i = 0; i < subtitles.length; i++) {
      const subtitle = subtitles[i];
      try {
        // 🔍 只记录第1条字幕的详细信息
        if (i === 0) {
          console.log(`[ZimuShengcheng] 绗竴鏉″瓧骞曡鎯? 类型=${subtitle.type}, 文字="${subtitle.text.substring(0, 30)}", 时间=${subtitle.start.toFixed(2)}s-${subtitle.end.toFixed(2)}s`);
        }

        if (subtitle.type === 'normal') {
          const inlineModeEnabled = this.shouldUseInlineKeywordOverlay();
          if (i === 0) {
            console.log('[ZimuShengcheng.generateDrawtextCommands] inline妯″紡妫€鏌?', {
              keywordRenderMode: this.config?.keywordRenderMode,
              inlineModeEnabled,
              keywordMatches: this.keywordMatches.length,
              hasEffectSubtitles: this.arrangedSubtitles.some((subtitle) => subtitle.type !== 'normal'),
              groupsWithEffectId: (this.config?.keywordGroups || []).filter((group: any) => !!group?.effectId).length
            });
          }

          let primaryCommand = '';
          if (inlineModeEnabled) {
            const inlineCommands = this.generateInlineKeywordOverlayDrawtexts(subtitle, fontDir);
            console.log('[ZimuShengcheng.generateDrawtextCommands] inline 高亮命令:', {
              subtitle: subtitle.text.substring(0, 30),
              count: inlineCommands.length,
              overlayMode: inlineCommands.length > 0
            });

            if (inlineCommands.length > 0) {
              commands.push(...inlineCommands);
              primaryCommand = inlineCommands[0];
            } else {
              const baseNormalCommand = this.generateNormalDrawtext(subtitle, fontDir);
              commands.push(baseNormalCommand);
              primaryCommand = baseNormalCommand;
            }
          } else {
            const baseNormalCommand = this.generateNormalDrawtext(subtitle, fontDir);
            commands.push(baseNormalCommand);
            primaryCommand = baseNormalCommand;
          }

          if (i === 0 && primaryCommand) {
            const enableMatch = primaryCommand.match(/enable='([^']+)'/);
            if (enableMatch) {
              console.log(`[ZimuShengcheng] ✅绗竴鏉″瓧骞昬nable: ${enableMatch[1]}`);
            }
          }
        } else if (subtitle.type === 'effect_complex') {
          // 特效字幕（带动画）：使用 drawtext 渲染（支持动画效果）
          // 銆愪慨澶嶃€戣浆鎹㈡椂闂村崟浣嶄负绉?
          const normalizedSubtitle = {
            ...subtitle,
            start: this.normalizeTimeToSeconds(subtitle.start),
            end: this.normalizeTimeToSeconds(subtitle.end)
          };

          const effectType = subtitle.animationConfig?.parameters?.effectType || 'SLIDE_IN_UP';
          const fontfile = this.resolveFontPath(subtitle.style.fontName, fontDir);

          const effectDuration = subtitle.animationConfig?.duration || 2000;
          const effectParams = {
            duration: effectDuration,
            intensity: subtitle.animationConfig?.intensity || 0.8,
            delay: subtitle.animationConfig?.delay || 0,
            speed: subtitle.animationConfig?.parameters?.speed || 1.0,
            ...subtitle.animationConfig?.parameters
          };

          const result = DrawtextGenerator.generateByEffectType(
            normalizedSubtitle,
            fontfile,
            effectType,
            effectParams
          );

          if (Array.isArray(result)) {
            commands.push(...result);
            console.log(`[ZimuShengcheng] 特效字幕命令生成完成，子命令数: ${result.length}`);
          } else {
            commands.push(result);
            console.log(`[ZimuShengcheng] ✅鐢熸垚鐗规晥瀛楀箷鍛戒护瀹屾垚`);
          }
        } else if (subtitle.type === 'effect_simple') {
          // 🔧 修复：简单特效字幕也应该应用特效动画
          // 之前错误地直接生成普通字幕，导致DANMAKU、ARC_TEXT等特效不显示
          const normalizedSubtitle = {
            ...subtitle,
            start: this.normalizeTimeToSeconds(subtitle.start),
            end: this.normalizeTimeToSeconds(subtitle.end)
          };

          const effectType = subtitle.animationConfig?.parameters?.effectType || 'SLIDE_IN_UP';
          const fontfile = this.resolveFontPath(subtitle.style.fontName, fontDir);

            console.log('[ZimuShengcheng] 简单特效字幕生成:', {
            text: subtitle.text.substring(0, 20),
            effectType,
            hasAnimationConfig: !!subtitle.animationConfig
          });

          const effectDuration = subtitle.animationConfig?.duration || 2000;
          const effectParams = {
            duration: effectDuration,
            intensity: subtitle.animationConfig?.intensity || 0.8,
            delay: subtitle.animationConfig?.delay || 0,
            speed: subtitle.animationConfig?.parameters?.speed || 1.0,
            ...subtitle.animationConfig?.parameters
          };

          const result = DrawtextGenerator.generateByEffectType(
            normalizedSubtitle,
            fontfile,
            effectType,
            effectParams
          );

          if (Array.isArray(result)) {
            commands.push(...result);
            console.log(`[ZimuShengcheng] 简单特效字幕命令生成完成，子命令数: ${result.length}`);
          } else {
            commands.push(result);
            console.log('[ZimuShengcheng] 简单特效字幕命令生成完成');
          }
        }
      } catch (error) {
        console.error('[ZimuShengcheng] 生成 drawtext 命令失败:', {
          subtitleText: subtitle.text?.substring(0, 20),
          error: error instanceof Error ? error.message : String(error)
        });

        if (subtitle.type === 'normal') {
          try {
            const fallbackCommand = this.generateSafeNormalDrawtextFallback(subtitle, fontDir);
            commands.push(fallbackCommand);
            console.warn('[ZimuShengcheng] 普通字幕已使用兜底 drawtext 方案恢复输出:', {
              subtitleText: subtitle.text?.substring(0, 20)
            });
          } catch (fallbackError) {
            console.error('[ZimuShengcheng] 普通字幕兜底方案仍然失败:', {
              subtitleText: subtitle.text?.substring(0, 20),
              error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
            });
          }
        }
      }
    }

    console.log('[ZimuShengcheng.generateDrawtextCommands] 鐢熸垚瀹屾垚锛屽懡浠ゆ暟閲?', commands.length);

    // 🔧 取消强制修复：使用实际计算的特效字幕位置
    // 不再强制替换 x 鍙傛暟涓?100，而是保留 SmartLayoutManager 璁＄畻鐨勫€?
    const correctedCommands = commands.map((cmd, idx) => {
      const subtitle = subtitles[idx];
      if (!subtitle) return cmd;

      // 🔧 对特效字幕：保留原始命令（已在generateNormalDrawtext中使用position.x锛?
      if (subtitle.type === 'effect_complex' || subtitle.type === 'effect_simple') {
        console.log(`[ZimuShengcheng.generateDrawtextCommands] ✅鐗规晥瀛楀箷浣跨敤SmartLayoutManager鐨勪綅缃绠?`, {
          text: subtitle.text.substring(0, 15),
          type: subtitle.type,
          position_x: subtitle.position.x,
          command: cmd.substring(0, 100)
        });
      }

      return cmd;  // 保留原始命令
    });

    return correctedCommands;
  }

  private isInlineKeywordRenderMode(config: Pick<ZimuConfig, 'keywordRenderMode'> = this.config): boolean {
    return config?.keywordRenderMode === 'inline-emphasis';
  }

  private shouldUseInlineKeywordOverlay(): boolean {
    if (this.isInlineKeywordRenderMode(this.config)) {
      return true;
    }

    const hasKeywordMatches = this.keywordMatches.length > 0;
    const hasEffectSubtitles = this.arrangedSubtitles.some((subtitle) => subtitle.type !== 'normal');
    const hasConfiguredEffectIds = (this.config?.keywordGroups || []).some((group: any) => !!group?.effectId);

    return hasKeywordMatches && !hasEffectSubtitles && !hasConfiguredEffectIds;
  }

  private resolvePreferredNormalSubtitleY(subtitle: ArrangedSubtitle): number {
    const fallbackY = Math.round(subtitle.position.y);
    if (subtitle.type !== 'normal') {
      return fallbackY;
    }

    const fontSize = this.config?.subtitleStyle?.fontSize || subtitle.style?.fontSize || 48;
    const topSafeY = fontSize + 50;
    const bottomSafeY = this.config.videoHeight - fontSize * 1.8 - 50;
    // Respect the y position already calculated by createNormalSubtitle/optimizeLayout.
    // Recomputing here collapses multi-line subtitles back onto a single baseline.
    return Math.max(topSafeY, Math.min(fallbackY, bottomSafeY));
  }

  private generateInlineKeywordOverlayDrawtexts(
    subtitle: ArrangedSubtitle,
    fontDir: string
  ): string[] {
    if (!this.shouldUseInlineKeywordOverlay() || subtitle.type !== 'normal' || this.keywordMatches.length === 0) {
      return [];
    }

    const subtitleText = this.normalizeTextForDisplay(subtitle.text);
    if (!subtitleText.trim()) {
      return [];
    }

    const subtitleStart = this.normalizeTimeToSeconds(subtitle.start);
    const subtitleEnd = this.normalizeTimeToSeconds(subtitle.end);
    const lines = subtitleText.includes('\n') ? subtitleText.split('\n') : [subtitleText];
    const flattenedText = lines.join('');
    const matches = this.resolveInlineKeywordMatches(flattenedText, subtitleStart, subtitleEnd);

    console.log('[ZimuShengcheng.generateInlineKeywordOverlayDrawtexts] 匹配当前字幕的关键词:', {
      subtitle: subtitle.text.substring(0, 30),
      subtitleStart,
      subtitleEnd,
      totalKeywordMatches: this.keywordMatches.length,
      matchedCount: matches.length,
      matchedKeywords: matches.map((match) => match.keyword),
      matchedRanges: matches.map((match) => `${match.normalizedStartTime.toFixed(3)}-${match.normalizedEndTime.toFixed(3)}`)
    });

    if (matches.length === 0) {
      return [];
    }

    const inlineBaseStyle = this.getInlineBaseStyle(subtitle.style);
    const lineSpacing =
      inlineBaseStyle.backgroundColor &&
      inlineBaseStyle.backgroundColor !== 'transparent' &&
      (inlineBaseStyle.backgroundOpacity ?? 0) > 0
        ? Math.round(inlineBaseStyle.fontSize * 0.18)
        : Math.round(inlineBaseStyle.fontSize * 0.36);
    const lineRuns = this.buildInlineLineRuns(lines, matches, inlineBaseStyle);
    const lineHeights = lineRuns.map((runs) =>
      Math.max(...runs.map((run) => this.estimateInlineRunHeight(run.style)), this.estimateInlineRunHeight(inlineBaseStyle))
    );
    const blockHeight =
      lineHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, lineRuns.length - 1) * lineSpacing;
    const baseY = Math.max(24, Math.min(Math.round(subtitle.position.y), this.config.videoHeight - blockHeight - 24));
    const commands: string[] = [];
    let currentY = baseY;

    lineRuns.forEach((runs, lineIndex) => {
      const lineHeight = lineHeights[lineIndex] || subtitle.style.fontSize;
      const lineWidth = runs.reduce((sum, run, runIndex) => {
        const nextRun = runs[runIndex + 1];
        return sum + this.estimateInlineRunWidth(run.text, run.style) + this.getInlineRunGap(run, nextRun);
      }, 0);
      let currentX = this.computeInlineLineLeftByWidth(
        lineWidth,
        subtitle.position.x,
        subtitle.position.alignment || 'center',
        60
      );

      runs.forEach((run, runIndex) => {
        if (!run.text) {
          return;
        }

        const keywordBaselineOffset = 0;

        const command = this.createInlineTextDrawCommand(
          run.text,
          run.style,
          fontDir,
          currentX,
          currentY + Math.max(0, lineHeight - this.estimateInlineRunHeight(run.style)) + keywordBaselineOffset,
          subtitleStart,
          subtitleEnd
        );
        commands.push(command);
        currentX += this.estimateInlineRunWidth(run.text, run.style) + this.getInlineRunGap(run, runs[runIndex + 1]);
      });

      currentY += lineHeight + lineSpacing;
    });

    return commands;
  }

  private resolveInlineKeywordMatchesFromSubtitle(
    flattenedText: string,
    subtitleStart: number,
    subtitleEnd: number
  ): Array<KeywordMatch & {
    normalizedStartTime: number;
    normalizedEndTime: number;
    occurrenceStart: number;
    occurrenceEnd: number;
  }> {
    const keywordGroups = Array.isArray(this.config?.keywordGroups) ? this.config.keywordGroups : [];
    if (!flattenedText || keywordGroups.length === 0) {
      return [];
    }

    const candidates: Array<KeywordMatch & {
      normalizedStartTime: number;
      normalizedEndTime: number;
      occurrenceStart: number;
      occurrenceEnd: number;
    }> = [];

    for (const group of keywordGroups) {
      const groupKeywords = Array.isArray(group?.keywords) ? group.keywords : [];
      if (groupKeywords.length === 0) {
        continue;
      }

      for (const keywordItem of groupKeywords) {
        const rawKeyword = typeof keywordItem === 'string' ? keywordItem : keywordItem?.keyword;
        const normalizedKeyword = this.normalizeTextForDisplay(String(rawKeyword || ''));
        if (!normalizedKeyword) {
          continue;
        }

        let searchFrom = 0;
        while (searchFrom < flattenedText.length) {
          const occurrenceStart = flattenedText.indexOf(normalizedKeyword, searchFrom);
          if (occurrenceStart === -1) {
            break;
          }

          const style = typeof keywordItem === 'string'
            ? this.buildKeywordStyle(group)
            : keywordItem?.styleOverride
              ? this.buildKeywordStyleFromConfig(keywordItem.styleOverride)
              : this.buildKeywordStyle(group);

          const rawEffectId = (typeof keywordItem === 'string' ? undefined : keywordItem?.effectId) || group?.effectId || group?.effectConfig?.type || 'pulse-scale';
          const effectType = this.normalizeEffectType(rawEffectId);

          candidates.push({
            keyword: normalizedKeyword,
            startIndex: occurrenceStart,
            endIndex: occurrenceStart + normalizedKeyword.length,
            startTime: subtitleStart,
            endTime: subtitleEnd,
            groupId: group?.id || group?.groupId || group?.name || normalizedKeyword,
            groupName: group?.name || group?.groupName || '',
            effectType: effectType as EffectType,
            isAnimated: false,
            style,
            normalizedStartTime: subtitleStart,
            normalizedEndTime: subtitleEnd,
            occurrenceStart,
            occurrenceEnd: occurrenceStart + normalizedKeyword.length
          });

          searchFrom = occurrenceStart + Math.max(1, normalizedKeyword.length);
        }
      }
    }

    const sortedCandidates = candidates.sort((a, b) =>
      a.occurrenceStart - b.occurrenceStart ||
      (b.occurrenceEnd - b.occurrenceStart) - (a.occurrenceEnd - a.occurrenceStart)
    );

    const mergedMatches: Array<KeywordMatch & {
      normalizedStartTime: number;
      normalizedEndTime: number;
      occurrenceStart: number;
      occurrenceEnd: number;
    }> = [];

    for (const candidate of sortedCandidates) {
      const last = mergedMatches[mergedMatches.length - 1];
      if (!last) {
        mergedMatches.push(candidate);
        continue;
      }

      const overlapsOrTouches = candidate.occurrenceStart <= last.occurrenceEnd;
      if (!overlapsOrTouches) {
        mergedMatches.push(candidate);
        continue;
      }

      const lastLength = last.occurrenceEnd - last.occurrenceStart;
      const candidateLength = candidate.occurrenceEnd - candidate.occurrenceStart;
      const dominant = candidateLength > lastLength ? candidate : last;

      last.keyword = flattenedText.slice(
        Math.min(last.occurrenceStart, candidate.occurrenceStart),
        Math.max(last.occurrenceEnd, candidate.occurrenceEnd)
      );
      last.startIndex = Math.min(last.startIndex, candidate.startIndex);
      last.endIndex = Math.max(last.endIndex, candidate.endIndex);
      last.occurrenceStart = Math.min(last.occurrenceStart, candidate.occurrenceStart);
      last.occurrenceEnd = Math.max(last.occurrenceEnd, candidate.occurrenceEnd);
      last.groupId = dominant.groupId;
      last.groupName = dominant.groupName;
      last.effectType = dominant.effectType;
      last.style = dominant.style;
    }

    return mergedMatches.sort((a, b) => a.occurrenceStart - b.occurrenceStart);
  }

  private resolveInlineKeywordMatches(flattenedText: string, subtitleStart: number, subtitleEnd: number): Array<KeywordMatch & {
    normalizedStartTime: number;
    normalizedEndTime: number;
    occurrenceStart: number;
    occurrenceEnd: number;
  }> {
    const usedOccurrences = new Set<number>();

    return this.keywordMatches
      .map((match) => {
        const normalizedKeyword = this.normalizeTextForDisplay(match.keyword);
        if (!normalizedKeyword) {
          return null;
        }

        const normalizedStartTime = this.normalizeTimeToSeconds(match.startTime);
        const normalizedEndTime = this.normalizeTimeToSeconds(match.endTime);
        if (normalizedStartTime >= subtitleEnd || normalizedEndTime <= subtitleStart) {
          return null;
        }

        const occurrenceCandidates = this.findAllInlineTextOccurrences(flattenedText, normalizedKeyword);
        if (occurrenceCandidates.length === 0) {
          return null;
        }

        const occurrenceStart = occurrenceCandidates.find((candidate) => !usedOccurrences.has(candidate));
        if (occurrenceStart === undefined) {
          return null;
        }
        usedOccurrences.add(occurrenceStart);

        return {
          ...match,
          normalizedStartTime,
          normalizedEndTime,
          occurrenceStart,
          occurrenceEnd: occurrenceStart + normalizedKeyword.length
        };
      })
      .filter((match): match is KeywordMatch & {
        normalizedStartTime: number;
        normalizedEndTime: number;
        occurrenceStart: number;
        occurrenceEnd: number;
      } => !!match)
      .sort((a, b) => a.occurrenceStart - b.occurrenceStart || b.occurrenceEnd - a.occurrenceEnd);
  }

  private findAllInlineTextOccurrences(text: string, keyword: string): number[] {
    const occurrences: number[] = [];
    if (!text || !keyword) {
      return occurrences;
    }

    let searchFrom = 0;
    while (searchFrom < text.length) {
      const index = text.indexOf(keyword, searchFrom);
      if (index === -1) {
        break;
      }

      occurrences.push(index);
      searchFrom = index + Math.max(1, keyword.length);
    }

    return occurrences;
  }

  private getInlineProtectedKeywordRanges(text: string): Array<{ start: number; end: number }> {
    const normalizedText = this.normalizeTextForDisplay(text);
    if (!normalizedText || this.keywordMatches.length === 0) {
      return [];
    }

    const rawRanges: Array<{ start: number; end: number }> = [];
    const uniqueKeywords = Array.from(new Set(
      this.keywordMatches
        .map((match) => this.normalizeTextForDisplay(match.keyword))
        .filter((keyword) => !!keyword)
    ));

    uniqueKeywords.forEach((keyword) => {
      this.findAllInlineTextOccurrences(normalizedText, keyword).forEach((start) => {
        rawRanges.push({
          start,
          end: start + keyword.length
        });
      });
    });

    rawRanges.sort((a, b) => a.start - b.start || a.end - b.end);

    return rawRanges.reduce<Array<{ start: number; end: number }>>((merged, current) => {
      const last = merged[merged.length - 1];
      if (!last || current.start > last.end) {
        merged.push({ ...current });
      } else {
        last.end = Math.max(last.end, current.end);
      }
      return merged;
    }, []);
  }

  private rebalanceInlineKeywordLines(text: string, lines: string[]): string[] {
    if (lines.length <= 1) {
      return lines;
    }

    const protectedRanges = this.getInlineProtectedKeywordRanges(text);
    if (protectedRanges.length === 0) {
      return lines;
    }

    const boundaries: number[] = [];
    let consumed = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      consumed += lines[i].length;
      boundaries.push(consumed);
    }

    for (let i = 0; i < boundaries.length; i++) {
      const boundary = boundaries[i];
      const previousBoundary = i === 0 ? 0 : boundaries[i - 1];
      const nextBoundary = i === boundaries.length - 1 ? text.length : boundaries[i + 1];
      const protectedRange = protectedRanges.find((range) => boundary > range.start && boundary < range.end);

      if (!protectedRange) {
        continue;
      }

      const candidateBoundaries = [protectedRange.start, protectedRange.end]
        .filter((candidate) => candidate > previousBoundary && candidate < nextBoundary);

      if (candidateBoundaries.length === 0) {
        continue;
      }

      let bestBoundary = candidateBoundaries[0];
      let bestScore = Number.POSITIVE_INFINITY;

      candidateBoundaries.forEach((candidate) => {
        const leftLength = candidate - previousBoundary;
        const rightLength = nextBoundary - candidate;
        const shorterSide = Math.min(leftLength, rightLength);
        const imbalance = Math.abs(leftLength - rightLength);
        const shortLinePenalty = shorterSide <= 1 ? 1000 : shorterSide <= 2 ? 120 : 0;
        const movementPenalty = Math.abs(candidate - boundary) * 0.25;
        const score = imbalance + shortLinePenalty + movementPenalty;

        if (score < bestScore) {
          bestScore = score;
          bestBoundary = candidate;
        }
      });

      boundaries[i] = bestBoundary;
    }

    const result: string[] = [];
    let start = 0;
    boundaries.forEach((boundary) => {
      result.push(text.slice(start, boundary));
      start = boundary;
    });
    result.push(text.slice(start));

    return result.filter((line) => line.length > 0);
  }

  private buildInlineLineRuns(
    lines: string[],
    matches: Array<KeywordMatch & {
      occurrenceStart: number;
      occurrenceEnd: number;
    }>,
    baseStyle: ArrangedSubtitle['style']
  ): Array<Array<{ text: string; style: ArrangedSubtitle['style']; isKeyword: boolean }>> {
    const lineRuns: Array<Array<{ text: string; style: ArrangedSubtitle['style']; isKeyword: boolean }>> = [];
    let consumed = 0;

    lines.forEach((lineText) => {
      const runs: Array<{ text: string; style: ArrangedSubtitle['style']; isKeyword: boolean }> = [];
      const lineStart = consumed;
      const lineEnd = consumed + lineText.length;
      consumed = lineEnd;

      const lineMatches = matches
        .filter((match) => match.occurrenceStart < lineEnd && match.occurrenceEnd > lineStart)
        .sort((a, b) => a.occurrenceStart - b.occurrenceStart || b.occurrenceEnd - a.occurrenceEnd);

      let cursor = lineStart;
      lineMatches.forEach((match) => {
        const fragmentStart = Math.max(lineStart, match.occurrenceStart);
        const fragmentEnd = Math.min(lineEnd, match.occurrenceEnd);
        if (fragmentStart > cursor) {
          runs.push({
            text: lineText.slice(cursor - lineStart, fragmentStart - lineStart),
            style: { ...baseStyle },
            isKeyword: false
          });
        }

        const keywordText = lineText.slice(fragmentStart - lineStart, fragmentEnd - lineStart);
        runs.push({
          text: keywordText,
          style: {
            ...baseStyle,
            fontName: this.normalizeFontNameValue(match.style?.fontName || baseStyle.fontName),
            fontSize: this.normalizeNumericValue(baseStyle.fontSize, this.config?.subtitleStyle?.fontSize || 48),
            fontColor: this.normalizeColorValue(match.style?.fontColor, baseStyle.fontColor),
            outlineColor: this.normalizeColorValue(match.style?.outlineColor, baseStyle.outlineColor),
            outlineWidth: this.normalizeNumericValue(match.style?.outlineWidth, baseStyle.outlineWidth ?? 0),
            shadowColor: this.normalizeColorValue(match.style?.shadowColor, baseStyle.shadowColor || 'transparent'),
            shadowOffset: this.normalizeNumericValue(match.style?.shadowOffset, baseStyle.shadowOffset ?? 0),
            shadowBlur: this.normalizeNumericValue(match.style?.shadowBlur, baseStyle.shadowBlur ?? 0),
            backgroundColor: this.normalizeColorValue(match.style?.backgroundColor, baseStyle.backgroundColor || 'transparent'),
            backgroundOpacity: this.normalizeNumericValue(match.style?.backgroundOpacity, baseStyle.backgroundOpacity ?? 0)
          },
          isKeyword: true
        });
        cursor = Math.max(cursor, fragmentEnd);
      });

      if (cursor < lineEnd) {
        runs.push({
          text: lineText.slice(cursor - lineStart),
          style: { ...baseStyle },
          isKeyword: false
        });
      }

      lineRuns.push(runs.filter((run) => run.text.length > 0));
    });

    return lineRuns;
  }

  private createInlineTextDrawCommand(
    text: string,
    style: ArrangedSubtitle['style'],
    fontDir: string,
    x: number,
    y: number,
    startTime: number,
    endTime: number
  ): string {
    const fontPath = this.resolveFontPath(style.fontName, fontDir);
    const fontColor = this.convertHexToDrawtext(style.fontColor);
    const outlineColor = this.convertHexToDrawtext(style.outlineColor);
    const escapedText = text
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/:/g, '\\:')
      .replace(/\n/g, '\\n');

    const config: any = {
      fontfile: fontPath,
      text: escapedText,
      x: `max(18,min(${Math.round(x)},w-text_w-18))`,
      y: `max(24,min(${Math.round(y)},h-text_h-24))`,
      fontsize: style.fontSize,
      fontcolor: fontColor,
      borderw: style.outlineWidth || 0,
      bordercolor: outlineColor,
      enable: `between(t,${startTime.toFixed(3)},${endTime.toFixed(3)})`,
      line_spacing: Math.round(style.fontSize * 0.18)
    };

    const shadowOffset = style.shadowOffset ?? 0;
    if (shadowOffset > 0 && style.shadowColor && style.shadowColor !== 'transparent') {
      config.shadowcolor = this.convertHexToDrawtext(style.shadowColor);
      config.shadowx = shadowOffset;
      config.shadowy = shadowOffset;
    }

    return DrawtextGenerator.generateNormalSubtitle(
      config,
      style.backgroundColor,
      style.backgroundOpacity
    );
  }

  private getInlineBaseStyle(style: ArrangedSubtitle['style']): ArrangedSubtitle['style'] {
    return {
      ...style,
      fontName: this.normalizeFontNameValue(style?.fontName),
      fontSize: this.normalizeNumericValue(style?.fontSize, this.config?.subtitleStyle?.fontSize || 48),
      fontColor: this.normalizeColorValue(style?.fontColor, '#FFFFFF'),
      outlineColor: this.normalizeColorValue(style?.outlineColor, '#000000'),
      outlineWidth: this.normalizeNumericValue(style?.outlineWidth, 0),
      shadowColor: this.normalizeColorValue(style?.shadowColor, 'transparent'),
      shadowOffset: this.normalizeNumericValue(style?.shadowOffset, 0),
      shadowBlur: this.normalizeNumericValue(style?.shadowBlur, 0),
      backgroundColor: this.normalizeColorValue(style?.backgroundColor, 'transparent'),
      backgroundOpacity: this.normalizeNumericValue(style?.backgroundOpacity, 0)
    };
  }

  private estimateInlineRunWidth(text: string, style: ArrangedSubtitle['style']): number {
    const baseWidth = this.estimateInlineTextWidth(text, style.fontSize);
    const outlinePadding = Math.ceil((style.outlineWidth ?? 0) * 2);
    const boldSafety = Math.ceil(style.fontSize * 0.04);
    return baseWidth + outlinePadding + boldSafety;
  }

  private estimateInlineRunHeight(style: ArrangedSubtitle['style']): number {
    return Math.round(style.fontSize + Math.max(4, (style.outlineWidth ?? 0) * 2 + style.fontSize * 0.08));
  }

  private getInlineRunGap(
    currentRun: { text: string; style: ArrangedSubtitle['style']; isKeyword: boolean },
    nextRun?: { text: string; style: ArrangedSubtitle['style']; isKeyword: boolean }
  ): number {
    if (!nextRun) {
      return 0;
    }

    const maxFontSize = Math.max(currentRun.style.fontSize, nextRun.style.fontSize);
    if (currentRun.isKeyword || nextRun.isKeyword) {
      return Math.max(6, Math.round(maxFontSize * 0.12));
    }

    return Math.max(2, Math.round(maxFontSize * 0.04));
  }

  private computeInlineLineLeft(
    text: string,
    fontSize: number,
    anchorX: number,
    alignment: 'left' | 'center' | 'right',
    horizontalMargin: number
  ): number {
    const lineWidth = this.estimateInlineTextWidth(text, fontSize);
    const maxX = Math.max(horizontalMargin, this.config.videoWidth - lineWidth - horizontalMargin);

    if (alignment === 'left') {
      return Math.max(horizontalMargin, Math.min(anchorX, maxX));
    }

    if (alignment === 'right') {
      return Math.max(horizontalMargin, Math.min(anchorX - lineWidth, maxX));
    }

    return Math.max(horizontalMargin, Math.min(anchorX - lineWidth / 2, maxX));
  }

  private computeInlineLineLeftByWidth(
    lineWidth: number,
    anchorX: number,
    alignment: 'left' | 'center' | 'right',
    horizontalMargin: number
  ): number {
    const maxX = Math.max(horizontalMargin, this.config.videoWidth - lineWidth - horizontalMargin);

    if (alignment === 'left') {
      return Math.max(horizontalMargin, Math.min(anchorX, maxX));
    }

    if (alignment === 'right') {
      return Math.max(horizontalMargin, Math.min(anchorX - lineWidth, maxX));
    }

    return Math.max(horizontalMargin, Math.min(anchorX - lineWidth / 2, maxX));
  }

  private estimateInlineTextWidth(text: string, fontSize: number): number {
    let width = 0;

    for (const char of text) {
      width += this.estimateInlineCharWidth(char, fontSize);
    }

    return width;
  }

  private estimateInlineCharWidth(char: string, fontSize: number): number {
    if (char === ' ') {
      return fontSize * 0.35;
    }

    if (/[\u4e00-\u9fff]/.test(char)) {
      return fontSize;
    }

    if (/[\u3040-\u30ff]/.test(char) || /[\uac00-\ud7af]/.test(char)) {
      return fontSize * 0.92;
    }

    if (/[a-zA-Z0-9]/.test(char)) {
      return fontSize * 0.56;
    }

    return fontSize * 0.32;
  }

  /**
   * 生成普通字幕的drawtext命令
   * @private
   */
  private generateNormalDrawtext(
    subtitle: ArrangedSubtitle,
    fontDir: string
  ): string {
    const style = subtitle.style;
    const safeFontName = this.normalizeFontNameValue(style?.fontName);
    const safeFontSize = this.normalizeNumericValue(style?.fontSize, this.config?.subtitleStyle?.fontSize || 48);
    const safeFontColor = this.normalizeColorValue(style?.fontColor, '#FFFFFF');
    const safeOutlineColor = this.normalizeColorValue(style?.outlineColor, '#000000');
    const safeOutlineWidth = this.normalizeNumericValue(style?.outlineWidth, 0);
    const safeBackgroundColor = this.normalizeOptionalColorValue(style?.backgroundColor);
    const safeBackgroundOpacity = this.normalizeNumericValue(style?.backgroundOpacity, 0.85);
    const safeShadowColor = this.normalizeOptionalColorValue(style?.shadowColor);
    const safeShadowOffset = this.normalizeNumericValue(style?.shadowOffset, 0);
    const safePositionX = this.normalizeNumericValue(subtitle?.position?.x, this.config.videoWidth / 2);
    const safePositionY = this.normalizeNumericValue(subtitle?.position?.y, this.config.videoHeight * 0.8);
    const safeAlignment = subtitle?.position?.alignment === 'left' || subtitle?.position?.alignment === 'right'
      ? subtitle.position.alignment
      : 'center';

    // ✅娣诲姞璇婃柇鏃ュ織锛氳褰曞瓧浣撹В鏋愯繃绋?
    console.log('[ZimuShengcheng] 生成普通字幕 drawtext 字体信息:', {
      text: subtitle.text.substring(0, 20),
      requestedFontName: safeFontName,
      fontPath: this.fontPathCache.has(safeFontName) ? this.fontPathCache.get(safeFontName) : '未缓存'
    });

    const fontPath = this.resolveFontPath(safeFontName, fontDir);

    // 转换颜色格式
    const fontColor = this.convertHexToDrawtext(safeFontColor);
    const outlineColor = this.convertHexToDrawtext(safeOutlineColor);

    // 背景颜色：保留原始格式（#RRGGBB锛夛紝鐢ㄤ簬鑳屾櫙閫忔槑搴?
    const backgroundColor = safeBackgroundColor || undefined;

    // 背景透明度：0.85 涓嶉€忔槑搴?= 0.15 閫忔槑搴?
    let bgOpacity = safeBackgroundOpacity;

    // 銆愬叧閿慨澶嶃€戞彁鍓嶅畾涔?dynamicBoxw，避免后续代码引用时出现 ReferenceError
    // 【修复背景溢出】根据是否有背景来调整boxw
    // 有背景时，需要更小的boxw防止右边溢出
    // 无背景时，可以使用更大的boxw鏉ユ樉绀哄畬鏁村瓧骞?
    const hasBackground = backgroundColor && bgOpacity > 0 &&
      backgroundColor.toUpperCase() !== 'TRANSPARENT' &&
      backgroundColor !== 'transparent';

    const horizontalMargin = 60;  // 基础左右边距
    // 【修复】当有背景时增加extraSafety锛屾棤鑳屾櫙鏃朵娇鐢ㄦ洿灏忕殑鍊?
    const extraSafety = hasBackground ? 80 : 40;  // 鑳屾櫙鏃?0锛屾棤鑳屾櫙鏃?0
    const dynamicBoxw = this.config.videoWidth - 2 * (horizontalMargin + extraSafety);  // 鍔ㄦ€佽绠?

    // 🔧 淇锛氭鏌?position.x 鏄惁琚?SmartLayoutManager 鏄惧紡淇敼杩?
    // 如果 position.x 明显不等于屏幕中心（偏差超过50px），说明被重新定位了
    const videoCenterX = this.config.videoWidth / 2;  // 閫氬父鏄?960
    const positionDeviation = Math.abs(safePositionX - videoCenterX);
    const hasExplicitPosition = positionDeviation > 50;  // 如果偏差超过50px，认为被显式定位

    // 🔧 寮哄埗淇锛氱壒鏁堝瓧骞曠洿鎺ユ斁鍦ㄥ乏杈癸紝鏅€氬瓧骞曟斁鍦ㄤ腑澶?
    let xExpr: string;

    // 检查是否是特效字幕（特效字幕的 type 不是 'normal'锛?
    const isEffectSubtitle = subtitle.type !== 'normal';

    if (isEffectSubtitle) {
      // 🔧 修复：特效字幕的position.x是SmartLayoutManager计算的水平位置参考点
      // 直接将其用于drawtext的x坐标（FFmpeg浼氫互姝や负鍩哄噯澶勭悊瀵归綈锛?
      const effectX = safePositionX || this.config.videoWidth / 2;
      xExpr = `max(18,min(${effectX},w-text_w-18))`;
      console.log('[ZimuShengcheng.generateNormalDrawtext] 特效字幕使用 SmartLayoutManager 位置:', {
        text: subtitle.text.substring(0, 20),
        type: subtitle.type,
        position_x: safePositionX,
        xExpr: xExpr,
        note: '特效字幕直接使用 SmartLayoutManager 计算的位置'
      });
    } else {
      // 銆愬叧閿慨澶嶃€戞櫘閫氬瓧骞曚篃浣跨敤缁濆瀹氫綅锛岀‘淇?optimizeLayout 璁＄畻鐨?adjustedX 生效
      // subtitle.position.x 已经包含了边界调整后的位置（来自 optimizeLayout 鐨?adjustedX锛?
      const absoluteX = safePositionX;

      // 根据对齐方式计算最终的x坐标
      if (safeAlignment === 'center') {
        // 灞呬腑瀵归綈锛歺鍧愭爣鏄枃鏈腑蹇冪偣锛岄渶瑕佸噺鍘诲崐涓枃鏈搴?
        xExpr = `max(${horizontalMargin},min(${absoluteX}-(text_w/2),w-text_w-${horizontalMargin}))`;
      } else if (safeAlignment === 'right') {
        // 右对齐：x坐标是文本右边缘
        xExpr = `max(${horizontalMargin},min(${absoluteX}-text_w,w-text_w-${horizontalMargin}))`;
      } else {
        // 左对齐：x鍧愭爣灏辨槸鏂囨湰宸﹁竟缂?
        xExpr = `max(${horizontalMargin},min(${absoluteX},w-text_w-${horizontalMargin}))`;
      }

      console.log(`[ZimuShengcheng.generateNormalDrawtext] 普通字幕使用绝对定位（确保边界检查生效）:`, {
        text: subtitle.text.substring(0, 20),
        alignment: safeAlignment,
        position_x: safePositionX,
        adjustedX: absoluteX.toFixed(2),
        xExpr: xExpr,
        note: '使用 optimizeLayout 璁＄畻鐨?adjustedX，确保不超出屏幕'
      });
    }

    const resolvedY = subtitle.type === 'normal'
      ? this.resolvePreferredNormalSubtitleY({
          ...subtitle,
          position: {
            ...subtitle.position,
            x: safePositionX,
            y: safePositionY,
            alignment: safeAlignment
          },
          style: {
            ...subtitle.style,
            fontName: safeFontName,
            fontSize: safeFontSize
          }
        })
      : Math.round(safePositionY);
    const yExpr = `max(24,min(${resolvedY},h-text_h-24))`;

    // 銆愪慨澶嶃€戞椂闂村崟浣嶈浆鎹細纭繚鏃堕棿鍊兼槸浠ョ涓哄崟浣?
    // 浠庢棩蹇楃湅锛屾椂闂村€奸兘鏄绉掞紙濡?290, 1128.888888888889, 59180锛?
    // 缁熶竴杞崲涓虹锛氶櫎浠?1000
    let startTime = subtitle.start / 1000;
    let endTime = subtitle.end / 1000;

    // 楠岃瘉杞崲鍚庣殑鏃堕棿鍊煎悎鐞嗘€?
    // 纭繚鏃堕棿鍊间笉涓鸿礋鏁?
    startTime = Math.max(0, startTime);
    endTime = Math.max(0, endTime);

    // 生成enable琛ㄨ揪寮忥紙浣跨敤杞崲鍚庣殑绉掓暟锛?
    const enableExpr = `between(t,${startTime.toFixed(3)},${endTime.toFixed(3)})`;

    // 🔍 诊断：输出前3条字幕的enable表达式（简单方式）
    // 通过检查开始时间是否是0或接近开始位置来判断是否是前几条字幕
    if (startTime <= 1 || (startTime >= 10 && startTime <= 12) || (startTime >= 15 && startTime <= 16.5)) {
      console.log(`[generateNormalDrawtext] 字幕enable琛ㄨ揪寮? "${subtitle.text.substring(0, 20)}..." -> enable='${enableExpr}' (start=${startTime.toFixed(2)}s)`);
    }

    // 转义文本
    // 🔧 先normalize（把标点符号替换成空格），再escape（转义特殊字符）
    const normalizedText = this.normalizeTextForDisplay(subtitle.text);
    const escapedText = normalizedText
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/:/g, '\\:')
      .replace(/\n/g, '\\n');

    // 銆愪慨澶嶃€戣儗鏅鑹插鐞嗭細纭繚涓嶅嚭鐜?"TRANSPARENT" 瀛楃涓?
    let validBackgroundColor: string | undefined = backgroundColor;
    if (backgroundColor && (backgroundColor.toUpperCase() === 'TRANSPARENT' || backgroundColor === 'transparent')) {
      // 如果背景是透明的，使用黑色完全透明
      validBackgroundColor = '#000000';
      bgOpacity = 0;  // 完全透明
    }

    // 构建drawtext配置
    // 🔧 重要：特效字幕和普通字幕使用不同的配置
    // 特效字幕：不使用boxw闄愬埗锛岀洿鎺ヤ娇鐢ㄥ睆骞曞潗鏍?
    // 普通字幕：使用boxw闄愬埗锛岃嚜鍔ㄦ崲琛?

    const config: any = {
      fontfile: fontPath,
      text: escapedText,
      x: xExpr,
      y: yExpr,
      fontsize: safeFontSize,
      fontcolor: fontColor,
      borderw: safeOutlineWidth,
      bordercolor: outlineColor,
      enable: enableExpr
      // 銆愪慨澶嶃€戝彧鍦ㄦ病鏈夎儗鏅椂璁剧疆琛岄棿璺?
      // 如果有背景，行间距会导致背景框高度多出一长条
    };

    // 【修复】即使有背景也需要设置行间距，以避免多行字幕重叠
    // 鏈夎儗鏅椂浣跨敤杈冨皬鐨勮闂磋窛锛?5%锛夛紝鏃犺儗鏅椂浣跨敤杈冨ぇ鐨勮闂磋窛锛?0%锛?
    // 注意：hasBackground 宸插湪鍓嶉潰瀹氫箟杩囦簡锛岃繖閲岀洿鎺ヤ娇鐢?
    if (hasBackground) {
      config.line_spacing = Math.round(safeFontSize * 0.15);  // 有背景时使用较小的行间距
    } else {
      config.line_spacing = Math.round(safeFontSize * 0.3);   // 鏃犺儗鏅椂澧炲姞琛岄棿璺濓紝鏀瑰杽鍙鎬?
    }

    // 🔧 关键：特效字幕和普通字幕都使用绝对定位，都不使用boxw
    // 原因：当boxw琚缃椂锛屽畠鏀瑰彉浜嗗潗鏍囩郴鐨勮В閲?
    // 不设置boxw时，x鍧愭爣鏄睆骞曠殑缁濆鍍忕礌鍊?
    // 这样才能保证 optimizeLayout 璁＄畻鐨?adjustedX 生效
    // 行换行已经在 optimizeLayout 涓畬鎴愪簡锛堝琛屽瓧骞曞鐞嗗湪绗?450-1538行）

    // 馃啎銆愰煩鏂?日文修复】检测字体是否为需要特殊处理的语言
    const fontNameLower = safeFontName.toLowerCase();
    const isAsianFont = fontNameLower.includes('malgun') ||
      fontNameLower.includes('noto') ||
      fontNameLower.includes('meiryo') ||
      fontNameLower.includes('simhei') ||
      fontNameLower.includes('simsun') ||
      fontNameLower.includes('yahei');

    // 🆕【关键修复】对于亚洲字体（韩文、日文、中文），启用boxw和fix_bounds
    // 浠ラ槻姝㈡枃瀛楄秴鍑哄睆骞?
    if (isAsianFont && !isEffectSubtitle) {
      // 涓轰簹娲茶瑷€鍚敤瀹藉害闄愬埗锛岄槻姝㈣秴鍑哄睆骞?
      // boxw限制：使用视频宽度的80-90%，为边距预留10-20%
      const asianBoxw = Math.floor(this.config.videoWidth * 0.85);
      config.boxw = undefined;
      config.fix_bounds = 1;

      console.log('[ZimuShengcheng] 亚洲字体启用宽度限制:', {
        fontName: style.fontName,
        normalizedFontName: safeFontName,
        boxw: asianBoxw,
        videoWidth: this.config.videoWidth,
        maxWidthPercent: '85%',
        text: subtitle.text.substring(0, 20)
      });
    } else {
      // 英文等其他字体：不使用boxw，按原逻辑处理
      config.boxw = undefined;
      config.fix_bounds = 1;
    }

    // 🔧 诊断：记录boxw配置
    console.log('[ZimuShengcheng.generateNormalDrawtext] 普通字幕宽度限制:', {
      text: subtitle.text.substring(0, 30),
      type: subtitle.type,
      videoWidth: this.config.videoWidth,
      horizontalMargin: horizontalMargin,
      extraSafety: extraSafety,
      dynamicBoxw: dynamicBoxw,
      finalBoxw: config.boxw,
      xExpr: xExpr,
      isNormalSubtitle: !isEffectSubtitle
    });

    // 🔧 诊断：记录最终生成的 x 琛ㄨ揪寮?
    console.log('[ZimuShengcheng.generateNormalDrawtext] 最终 drawtext 参数:', {
      text: subtitle.text.substring(0, 20),
      position_x: safePositionX.toFixed(0),
      xExpr: xExpr,
      yExpr: yExpr,
      alignment: safeAlignment,
      hasExplicitPosition: hasExplicitPosition,
      deviation: (Math.abs(safePositionX - this.config.videoWidth / 2)).toFixed(0)
    });

    const shadowOffset = safeShadowOffset;

    if (shadowOffset > 0 && safeShadowColor && safeShadowColor !== 'transparent') {
      config.shadowcolor = this.convertHexToDrawtext(safeShadowColor);
      config.shadowx = shadowOffset;
      config.shadowy = shadowOffset;
      console.log(`[ZimuShengcheng] 添加阴影效果: color=${config.shadowcolor}, offset=${shadowOffset}, outlineWidth=${safeOutlineWidth}`);
    } else {
      console.log(`[ZimuShengcheng] 鏈坊鍔犻槾褰? shadowOffset=${shadowOffset}, shadowColor=${safeShadowColor}`);
    }

    // 生成drawtext命令（支持背景透明度）
    return DrawtextGenerator.generateNormalSubtitle(
      config,
      validBackgroundColor,  // 使用修复后的背景颜色
      bgOpacity
    );
  }

  private generateSafeNormalDrawtextFallback(
    subtitle: ArrangedSubtitle,
    fontDir: string
  ): string {
    const fallbackSubtitle: ArrangedSubtitle = {
      ...subtitle,
      position: {
        x: this.normalizeNumericValue(subtitle?.position?.x, this.config.videoWidth / 2),
        y: this.normalizeNumericValue(subtitle?.position?.y, this.config.videoHeight * 0.8),
        alignment: subtitle?.position?.alignment === 'left' || subtitle?.position?.alignment === 'right'
          ? subtitle.position.alignment
          : 'center'
      },
      style: {
        ...subtitle.style,
        fontName: 'Microsoft YaHei Bold',
        fontSize: this.normalizeNumericValue(subtitle?.style?.fontSize, this.config?.subtitleStyle?.fontSize || 48),
        fontColor: this.normalizeColorValue(subtitle?.style?.fontColor, '#FFFFFF'),
        outlineColor: this.normalizeColorValue(subtitle?.style?.outlineColor, '#000000'),
        outlineWidth: this.normalizeNumericValue(subtitle?.style?.outlineWidth, 2),
        backgroundColor: this.normalizeOptionalColorValue(subtitle?.style?.backgroundColor) || 'transparent',
        backgroundOpacity: this.normalizeNumericValue(subtitle?.style?.backgroundOpacity, 0),
        shadowColor: this.normalizeOptionalColorValue(subtitle?.style?.shadowColor),
        shadowOffset: this.normalizeNumericValue(subtitle?.style?.shadowOffset, 0),
        shadowBlur: this.normalizeNumericValue(subtitle?.style?.shadowBlur, 0)
      }
    };

    return this.generateNormalDrawtext(fallbackSubtitle, fontDir);
  }

  // 字体路径缓存（避免重复查找）
  private fontPathCache: Map<string, string> = new Map();

  /**
   * 预先解析所有字体路径（异步，使用字体管理器API锛?
   * 在生成drawtext鍛戒护涔嬪墠璋冪敤锛屽皢鎵€鏈夊瓧浣撹矾寰勭紦瀛樿捣鏉?
   * @private
   */
  private async preResolveFontPaths(subtitles: ArrangedSubtitle[]): Promise<void> {
    // ✅娣诲姞鍏ㄥ眬瓒呮椂淇濇姢锛氭暣涓瓧浣撹矾寰勯瑙ｆ瀽杩囩▼鏈€澶?绉?
    return Promise.race([
      this._preResolveFontPathsInternal(subtitles),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('字体路径预解析超时（5秒），将使用同步查找方案')), 5000)
      )
    ]).catch((error) => {
      console.warn(`[ZimuShengcheng] 瀛椾綋璺緞棰勮В鏋愬け璐ワ紝灏嗕娇鐢ㄥ悓姝ユ煡鎵炬柟妗?`, error?.message || error);
      // 鍗充娇澶辫触锛屼篃缁х画鎵ц锛屼娇鐢ㄥ悓姝ユ煡鎵炬柟妗?
    });
  }

  private async _preResolveFontPathsInternal(subtitles: ArrangedSubtitle[]): Promise<void> {
    // 鏀堕泦鎵€鏈夊敮涓€鐨勫瓧浣撳悕绉?
    const fontNames = new Set<string>();
    for (const subtitle of subtitles) {
      if (subtitle.style?.fontName) {
        fontNames.add(subtitle.style.fontName);
      }
    }

    console.log(`[ZimuShengcheng] 寮€濮嬮瑙ｆ瀽瀛椾綋璺緞锛屽瓧浣撴暟閲? ${fontNames.size}`);

    // 并行解析所有字体路径（使用allSettled，确保即使部分失败也不影响其他）
    const fontPathPromises = Array.from(fontNames).map(async (fontName) => {
      // 濡傛灉宸茬粡缂撳瓨锛岃烦杩?
      if (this.fontPathCache.has(fontName)) {
        return;
      }

      // ✅浼樺寲绛栫暐锛氫紭鍏堜娇鐢ㄥ瓧浣撶鐞嗗櫒API锛屽鏋滃け璐ュ垯鍥為€€鍒板悓姝ユ煡鎵?
      // 保留超时机制，避免Python调用失败导致阻塞
      try {
        // 尝试使用字体管理器API查找字体路径（优先方案）
        if (typeof window !== 'undefined' && window.$mapi?.fontManager?.findFontPath) {
          try {
            // ✅娣诲姞瓒呮椂鏈哄埗锛?秒超时，快速失败，避免阻塞
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('字体管理器API调用超时')), 3000)
            );

            const result = await Promise.race([
              window.$mapi.fontManager.findFontPath(fontName, 400),
              timeoutPromise
            ]) as any;

            if (result && result.success && result.data) {
              // ✅妫€鏌ュ瓧浣撹矾寰勬槸鍚﹀寘鍚腑鏂囧瓧绗︼紝濡傛灉鏄垯澶嶅埗鍒颁复鏃剁洰褰曞苟浣跨敤鑻辨枃鏂囦欢鍚?
              const originalFontPath = result.data;
              const safeFontPath = await this.copyFontToSafePath(originalFontPath, fontName);

              this.fontPathCache.set(fontName, safeFontPath);
              console.log(`[ZimuShengcheng] 閫氳繃瀛椾綋绠＄悊鍣ㄦ壘鍒板瓧浣? ${fontName} -> ${safeFontPath}`);
              return;
            }
          } catch (apiError: any) {
            // 超时或API璋冪敤澶辫触锛屽揩閫熷洖閫€鍒板悓姝ユ煡鎵撅紝涓嶉樆濉炴祦绋?
            console.warn(`[ZimuShengcheng] 字体管理器API调用失败（快速回退到同步查找）: ${fontName}`, apiError?.message || apiError);
            // 不抛出错误，继续执行同步查找
          }
        }
      } catch (error: any) {
        // 任何异常都快速捕获，继续使用同步查找
        console.warn(`[ZimuShengcheng] 字体管理器查找异常（将使用同步查找）: ${fontName}`, error?.message || error);
      }

      // 回退方案：使用同步查找逻辑
      try {
        const fontPath = this.resolveFontPathSync(fontName);
        // ✅妫€鏌ュ瓧浣撹矾寰勬槸鍚﹀寘鍚腑鏂囧瓧绗︼紝濡傛灉鏄垯澶嶅埗鍒颁复鏃剁洰褰曞苟浣跨敤鑻辨枃鏂囦欢鍚?
        const safeFontPath = await this.copyFontToSafePath(fontPath, fontName);
        this.fontPathCache.set(fontName, safeFontPath);
        console.log(`[ZimuShengcheng] 使用同步回退方案找到字体: ${fontName} -> ${safeFontPath}`);
      } catch (syncError) {
        console.error(`[ZimuShengcheng] 同步查找字体失败: ${fontName}`, syncError);
        // 鏈€鍚庣殑鍥為€€锛氫娇鐢ㄩ粯璁ゅ瓧浣?
        const systemRoot = process.env.SystemRoot || 'C:/Windows';
        const defaultFont = `${systemRoot}/Fonts/msyhbd.ttc`;
        this.fontPathCache.set(fontName, defaultFont);
        console.warn(`[ZimuShengcheng] 使用默认字体: ${fontName} -> ${defaultFont}`);
      }
    });

    // 使用allSettled确保所有Promise都完成（无论成功或失败）
    const results = await Promise.allSettled(fontPathPromises);

    // 统计成功和失败的数量
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    console.log(`[ZimuShengcheng] 字体路径预解析完成，成功: ${successful}, 失败: ${failed}, 缓存数量: ${this.fontPathCache.size}`);
  }

  /**
   * 将字体文件复制到临时目录，如果路径包含非ASCII字符（如中文），则使用英文文件名
   * 避免 FFmpeg 鍦?Windows 上无法处理中文字体路径的问题
   * @private
   */
  /** 校验字体文件魔数（TTF/OTF/TTC），拦截 Git LFS 指针等损坏文件进入渲染管线 */
  private isValidFontFile(filePath: string): boolean {
    try {
      if (typeof window !== 'undefined' && window.require) {
        const fsNode = window.require('fs');
        if (!fsNode.existsSync(filePath) || fsNode.statSync(filePath).size < 128) {
          return false;
        }
        const fd = fsNode.openSync(filePath, 'r');
        const buf = Buffer.alloc(4);
        fsNode.readSync(fd, buf, 0, 4, 0);
        fsNode.closeSync(fd);
        const magic = buf.toString('hex', 0, 4);
        const ascii = buf.toString('latin1', 0, 4);
        return magic === '00010000' || ascii === 'OTTO' || ascii === 'true' || ascii === 'ttcf';
      }
      return true; // 非 Node 环境（无法读文件）时放行，交由 FFmpeg 自行报错
    } catch (error: any) {
      console.warn(`[ZimuShengcheng] 字体文件校验失败: ${filePath}`, error?.message || error);
      return false;
    }
  }

  /** 兜底系统中文字体：逐个校验有效性后返回（避免用到坏字体源） */
  private getFallbackSystemFont(): string {
    const systemRoot = process.env.SystemRoot || 'C:/Windows';
    const candidates = [`${systemRoot}/Fonts/msyh.ttc`, `${systemRoot}/Fonts/simhei.ttf`, `${systemRoot}/Fonts/arial.ttf`];
    for (const candidate of candidates) {
      if (this.isValidFontFile(candidate)) {
        console.warn(`[ZimuShengcheng] 使用兜底系统字体: ${candidate}`);
        return candidate;
      }
    }
    return candidates[0];
  }

  private async copyFontToSafePath(originalFontPath: string, fontName: string): Promise<string> {
    // 检查路径是否包含非ASCII字符
    const hasNonAscii = /[^\x00-\x7F]/.test(originalFontPath);

    // ✅ 源文件有效性校验：拦截 Git LFS 指针、损坏字体（魔数非 TTF/OTF/TTC）
    if (!this.isValidFontFile(originalFontPath)) {
      console.warn(`[ZimuShengcheng] ⚠️ 字体源文件无效(LFS指针或已损坏)，回退系统字体: ${originalFontPath}`);
      return this.getFallbackSystemFont();
    }

    if (!hasNonAscii) {
      // 路径只包含ASCII瀛楃锛岀洿鎺ヨ繑鍥?
      return originalFontPath;
    }

    console.log(`[ZimuShengcheng] 妫€娴嬪埌闈?ASCII 字符，复制到安全路径: ${originalFontPath}`);

    try {
      // 获取临时目录
      const tempDir = await this.getTempDir();

      // 鐢熸垚瀹夊叏鐨勮嫳鏂囨枃浠跺悕锛氫娇鐢ㄥ瓧浣撳悕绉扮殑鍝堝笇鍊?+ 鎵╁睍鍚?
      const path = await import('path');
      const crypto = await import('crypto');
      const ext = path.extname(originalFontPath);
      const hash = crypto.createHash('md5').update(fontName).digest('hex').substring(0, 8);
      const safeFileName = `font_${hash}${ext}`;
      const safeFontPath = path.join(tempDir, safeFileName).replace(/\\/g, '/');

      // 检查安全路径是否已存在
      if (typeof window !== 'undefined' && window.$mapi?.file?.exists) {
        const exists = await window.$mapi.file.exists(safeFontPath);
        if (exists && this.isValidFontFile(safeFontPath)) {
          console.log(`[ZimuShengcheng] ✅瀹夊叏瀛椾綋璺緞宸插瓨鍦紝鐩存帴浣跨敤: ${safeFontPath}`);
          return safeFontPath;
        }
      } else {
        const fs = await import('fs');
        if (fs.existsSync(safeFontPath) && this.isValidFontFile(safeFontPath)) {
          console.log(`[ZimuShengcheng] ✅瀹夊叏瀛椾綋璺緞宸插瓨鍦紝鐩存帴浣跨敤: ${safeFontPath}`);
          return safeFontPath;
        }
      }

      // 澶嶅埗瀛椾綋鏂囦欢鍒颁复鏃剁洰褰?
      if (typeof window !== 'undefined' && window.$mapi?.file?.copy) {
        await window.$mapi.file.copy(originalFontPath, safeFontPath, { isDataPath: false });
      } else {
        const fs = await import('fs');
        const util = await import('util');
        const copyFile = util.promisify(fs.copyFile);
        await copyFile(originalFontPath, safeFontPath);
      }

      // 验证复制是否成功
      let fileExists = false;
      let fileSize = 0;

      if (typeof window !== 'undefined' && window.$mapi?.file?.exists) {
        fileExists = await window.$mapi.file.exists(safeFontPath);
        if (fileExists && window.$mapi?.file?.stat) {
          const stats = await window.$mapi.file.stat(safeFontPath);
          fileSize = stats?.size || 0;
        }
      } else {
        const fs = await import('fs');
        fileExists = fs.existsSync(safeFontPath);
        if (fileExists) {
          const stats = fs.statSync(safeFontPath);
          fileSize = stats.size;
        }
      }

      if (!fileExists) {
        throw new Error(`字体文件复制失败: ${safeFontPath}`);
      }

      if (fileSize === 0 || !this.isValidFontFile(safeFontPath)) {
        throw new Error(`字体文件复制后大小为 0: ${safeFontPath}`);
      }

      console.log(`[ZimuShengcheng] ✅瀛椾綋鏂囦欢宸插鍒跺埌瀹夊叏璺緞: ${originalFontPath} -> ${safeFontPath} (${fileSize} bytes)`);
      return safeFontPath;

    } catch (error: any) {
      // 复制失败，抛出错误而不是静默回退
      const errorMsg = `鏃犳硶澶勭悊鍖呭惈涓枃鐨勫瓧浣撹矾寰? ${originalFontPath}. 错误: ${error?.message || error}`;
      console.error(`[ZimuShengcheng] ❌${errorMsg}`);
      throw new Error(errorMsg);
    }
  }

  /**
   * 鍚屾瑙ｆ瀽瀛椾綋鏂囦欢璺緞锛堝洖閫€鏂规锛?
   * 当字体管理器API涓嶅彲鐢ㄦ垨澶辫触鏃朵娇鐢?
   * @private
   */
  private resolveFontPathSync(fontName: string): string {
    const normalizedFontName = this.normalizeFontNameValue(fontName);
    // 鍔ㄦ€佽幏鍙栫郴缁熷瓧浣撶洰褰?
    const systemRoot = process.env.SystemRoot || 'C:/Windows';
    const fontsDir = `${systemRoot}/Fonts`;

    if (!normalizedFontName) {
      return `${fontsDir}/msyhbd.ttc`; // 默认字体
    }

    // 回退方案：尝试常见的系统字体路径（Windows锛?
    const systemFonts: Record<string, string> = {
      'microsoft yahei': `${fontsDir}/msyh.ttc`,
      '微软雅黑': `${fontsDir}/msyh.ttc`,
      'msyh': `${fontsDir}/msyh.ttc`,
      'simhei': `${fontsDir}/simhei.ttf`,
      '黑体': `${fontsDir}/simhei.ttf`,
      'simsun': `${fontsDir}/simsun.ttc`,
      '宋体': `${fontsDir}/simsun.ttc`,
      'msyhbd': `${fontsDir}/msyhbd.ttc`
    };

    const fontNameLower = normalizedFontName.toLowerCase().trim();

    // 棣栧厛妫€鏌ョ郴缁熷瓧浣撴槧灏?
    if (systemFonts[fontNameLower]) {
      const fontPath = systemFonts[fontNameLower];
      if (!this.isValidFontFile(fontPath)) {
        console.warn(`[ZimuShengcheng] 系统字体映射目标无效，使用兜底字体: ${fontPath}`);
        return this.getFallbackSystemFont();
      }
      console.log(`[ZimuShengcheng] 使用系统字体映射: ${normalizedFontName} -> ${fontPath}`);
      return fontPath;
    }

    // 鏈€鍚庡洖閫€锛氶粯璁ゅ瓧浣?
    const defaultFont = this.getFallbackSystemFont();
    console.warn(`[ZimuShengcheng] 鏈壘鍒板瓧浣?${normalizedFontName}锛屼娇鐢ㄩ粯璁ゅ瓧浣? ${defaultFont}`);
    return defaultFont;
  }

  /**
   * 瑙ｆ瀽瀛椾綋鏂囦欢璺緞锛堜粠缂撳瓨璇诲彇锛?
   * 必须在preResolveFontPaths之后调用
   * @private
   */
  private resolveFontPath(fontName: string, fontDir: string): string {
    const normalizedFontName = this.normalizeFontNameValue(fontName);
    if (!normalizedFontName) {
      const systemRoot = process.env.SystemRoot || 'C:/Windows';
      return `${systemRoot}/Fonts/msyhbd.ttc`; // 默认字体
    }

    // 浠庣紦瀛樿鍙?
    if (this.fontPathCache.has(normalizedFontName)) {
      return this.fontPathCache.get(normalizedFontName)!;
    }

    // 如果没有缓存，使用同步回退方案
    console.warn(`[ZimuShengcheng] 字体路径未缓存，使用回退方案: ${normalizedFontName}`);
    return this.resolveFontPathSync(normalizedFontName);
  }

  private normalizeFontNameValue(fontName: unknown): string {
    if (typeof fontName === 'string') {
      return fontName.trim();
    }

    if (Array.isArray(fontName)) {
      const firstString = fontName.find((item) => typeof item === 'string' && item.trim().length > 0);
      if (typeof firstString === 'string') {
        return firstString.trim();
      }
    }

    return 'Microsoft YaHei Bold';
  }

  private normalizeColorValue(color: unknown, fallback: string): string {
    if (typeof color === 'string' && color.trim().length > 0) {
      return color.trim();
    }
    return fallback;
  }

  private normalizeOptionalColorValue(color: unknown): string | undefined {
    if (typeof color === 'string' && color.trim().length > 0) {
      return color.trim();
    }
    return undefined;
  }

  private normalizeNumericValue(value: unknown, fallback: number): number {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
  }

  /**
   * 将十六进制颜色转换为drawtext鏍煎紡锛?xRRGGBB锛?
   * @private
   */
  private convertHexToDrawtext(hexColor: unknown): string {
    if (typeof hexColor !== 'string' || !hexColor.trim()) return '0xFFFFFF';

    // 移除 # 前缀
    const hex = hexColor.trim().replace('#', '').toUpperCase();

    // 纭繚鏄?浣嶅崄鍏繘鍒?
    if (hex.length === 8) {
      return `0x${hex.slice(0, 6)}`;
    }
    if (hex.length === 6) {
      return `0x${hex}`;
    }

    return '0xFFFFFF'; // 默认白色
  }

  /**
   * 鏍囧噯鍖栨椂闂村€硷細灏嗘绉掕浆鎹负绉?
   * FFmpeg 鐨?drawtext 闇€瑕佺涓哄崟浣?
   * @private
   */
  private normalizeTimeToSeconds(timeValue: number): number {
    // 绠€鍖栭€昏緫锛氬鏋滄椂闂村€煎ぇ浜?00锛岃涓烘槸姣锛岄渶瑕侀櫎浠?000
    // 因为正常视频字幕的时间戳（以秒为单位）很少会小于100绉?
    // 但如果是毫秒，即使是1秒也会是1000
    if (timeValue > 100) {
      return timeValue / 1000;
    }
    // 濡傛灉鏃堕棿鍊?<= 100锛屽亣璁惧凡缁忔槸绉?
    return timeValue;
  }

  // ==================== 步骤6-7: FFmpeg执行 ====================

  /**
   * 🆕 收集贴纸素材
   * @private
   */
  private collectStickerAssets(subtitles: ArrangedSubtitle[]): { path: string, instances: any[] }[] {
    const assetsMap = new Map<string, any[]>();

    for (const sub of subtitles) {
      // 🔧 修复：贴纸信息存储在 animationConfig 涓?
      // 妫€鏌?animationConfig.stickerId（新位置）或 sub.stickerId锛堝吋瀹规棫浠ｇ爜锛?
      const stickerId = (sub as any).animationConfig?.stickerId || (sub as any).stickerId;
      const stickerConfig = (sub as any).animationConfig?.stickerConfig || (sub as any).stickerConfig;

      // 🔍 调试：记录所有字幕的贴纸信息提取
      if (stickerId || (sub as any).animationConfig) {
        console.log('[ZimuShengcheng.collectStickerAssets] 字幕贴纸信息:', {
          text: sub.text.substring(0, 20),
          stickerId,
          hasStickerConfig: !!stickerConfig,
          hasAnimationConfig: !!(sub as any).animationConfig,
          animationConfigStickerId: (sub as any).animationConfig?.stickerId
        });
      }

      if (stickerId) {
        // 🔧 淇锛氭櫤鑳芥瀯寤鸿创绾歌矾寰?
        // 1. 如果 stickerId 宸茬粡鏄粷瀵硅矾寰勶紙鏋佸皯鎯呭喌锛燂級锛岀洿鎺ヤ娇鐢?
        // 2. 如果 stickerId 包含扩展名，直接使用
        // 3. 否则添加 .png

        // 基础目录 - 浣跨敤浼犲叆鐨?resourcesPath 参数
        const pathModule = window.require('path');
        const stickerBaseDir = pathModule.join(resourcesPath, 'stickers');
        console.log(`[ZimuShengcheng] 贴纸目录: ${stickerBaseDir}`);

        let stickerPath = '';
        if (stickerId === 'explosion') {
          // 兼容旧的硬编码ID
          stickerPath = `${stickerBaseDir}/explosion.png`;
        } else if (stickerId.toLowerCase().endsWith('.png') || stickerId.toLowerCase().endsWith('.jpg') || stickerId.toLowerCase().endsWith('.webp')) {
          // 已经是文件名
          stickerPath = `${stickerBaseDir}/${stickerId}`;
        } else {
          // 纯ID，默认添加png
          stickerPath = `${stickerBaseDir}/${stickerId}.png`;
        }

        // 🔍 璇婃柇鏃ュ織锛氳褰曡创绾歌矾寰勮В鏋?
        console.log(`[ZimuShengcheng] 解析贴纸路径: ID="${stickerId}" -> Path="${stickerPath}"`);

        // 🆕 安全检查：确保文件存在
        let fileExists = true;
        try {
          if (window.require) {
            const fs = window.require('fs');
            if (fs && fs.existsSync && !fs.existsSync(stickerPath)) {
              console.warn(`[ZimuShengcheng] ⚠️ 贴纸文件不存在，跳过: ${stickerPath}`);
              fileExists = false;
            }
          }
        } catch (e) {
          console.warn('[ZimuShengcheng] 鏃犳硶妫€鏌ユ枃浠跺瓨鍦ㄦ€?(非Electron环境?)', e);
        }

        if (fileExists) {
          if (!assetsMap.has(stickerPath)) {
            assetsMap.set(stickerPath, []);
          }

          // 🆕 自适应缩放逻辑
          // 获取字体大小，默认为 72
          const fontSize = (sub.style && sub.style.fontSize) ? Number(sub.style.fontSize) : 72;

          // 鍋囪璐寸焊鏍囧噯澶у皬涓?512x512 (宸茬粡鍦?collector.py 中统一)
          // 目标：贴纸高度约为字体的 2.5 鍊嶏紝浠ヨ鐩栨枃瀛?
          const BASE_SIZE = 512;
          const targetSize = fontSize * 3.0; // 3鍊嶅瓧浣撳ぇ灏?
          const autoScale = targetSize / BASE_SIZE;

          // 鐢ㄦ埛閰嶇疆鐨勭缉鏀?
          const userScale = stickerConfig?.scale ?? 1.0;
          const userOffsetX = stickerConfig?.offsetX ?? 0;
          const userOffsetY = stickerConfig?.offsetY ?? 0;

          // 鏈€缁堝弬鏁?
          const finalScale = autoScale * userScale;

          // 鏃㈢劧鎴戜滑鍦?FFmpeg 涓娇鐢?overlay，通常 overlay 涓嶆敼鍙樺ぇ灏忋€?
          // 我们需要在 overlay 之前缩放 sticker锛屾垨鑰呬娇鐢?overlay 鐨?scale 参数 (濡傛灉鏄緝鏂?ffmpeg)
          // DrawtextGenerator 鐩墠鍙敓鎴?overlay=x:y:enable...
          // 
          // 💡 绛栫暐璋冩暣锛?
          // 为了支持缩放，我们需要在 DrawtextGenerator 涓敮鎸?w/h 鍙傛暟锛?
          // 或者在 buildFFmpegCommand 涓瀯寤?filter chain 鏃跺姞鍏?scale 婊ら暅銆?
          // 
          // 简单方案：利用 overlay 婊ら暅鐨?scale 选项 (ffmpeg 4.x+ 支持 overlay=x:y:enable:scale=...) 
          // 涔熷氨鏄?DrawtextGenerator 生成 overlay=...:scale='...' 
          // 浣?DrawtextGenerator.ts 鐩墠鐨?generateStickerOverlay 没有用到 w/h銆?
          //
          // 鎴戜滑闇€瑕佷紶閫?scale 淇℃伅缁?buildFFmpegCommand，在那边构建 input -> scale -> overlay 閾俱€?
          // 鎴栬€呬慨鏀?DrawtextGenerator.generateStickerOverlay 返回 scale 鍙傛暟銆?

          // 重新审视 DrawtextGenerator.ts:
          // 它只返回 string銆?
          // 
          // 让我们在 assetsMap 涓瓨鍌?scale 淇℃伅銆?
          // sub.position 閫氬父鏄枃瀛楀乏涓嬭鎴栧乏涓婅銆?
          // 鎴戜滑甯屾湜灞呬腑銆?

          // 计算偏移量：
          // 贴纸缩放后的大小
          const scaledWidth = BASE_SIZE * finalScale;
          const scaledHeight = BASE_SIZE * finalScale;

          // 🆕 精确居中逻辑
          const textDims = this.estimateSubtitleDimensions(sub.text, fontSize, sub.style?.fontName);

          // 鏂囨湰涓績鐐?(假设 sub.position 是左上角)
          // 杩欓噷鐨?sub.position.x/y 鏄瓧骞曞湪瑙嗛涓殑宸︿笂瑙掑潗鏍?
          const textCenterX = sub.position.x + (textDims.width / 2);
          const textCenterY = sub.position.y + (textDims.height / 2);

          // 璐寸焊宸︿笂瑙?= 文本中心 - 璐寸焊涓€鍗?+ 用户偏移
          // 这样贴纸中心点会与文本中心点重合（加上用户偏移）
          const x = textCenterX - (scaledWidth / 2) + userOffsetX;
          const y = textCenterY - (scaledHeight / 2) + userOffsetY;

          assetsMap.get(stickerPath)?.push({
            startTime: sub.start / 1000, // 杞负绉?
            endTime: sub.end / 1000,
            x: Math.round(x),
            y: Math.round(y),
            // 🆕 传递缩放比例，后续 buildFFmpegCommand 闇€瑕佸鐞?(鎴栬€?DrawtextGenerator)
            // 目前 DrawtextGenerator 接口 StickerConfig 鏈?w, h銆?
            w: Math.round(scaledWidth),
            h: Math.round(scaledHeight)
          });
        }
      }
    }

    return Array.from(assetsMap.entries()).map(([path, instances]) => ({ path, instances }));
  }

  /**
   * 构建FFmpeg命令
   * @private
   */
  private buildFFmpegCommand(
    inputVideo: string,
    outputVideo: string,
    assFiles: string[],
    drawtextCommands: string[],
    fontDir: string,
    soundInstances?: any[],
    stickerAssets?: { path: string, instances: any[] }[] // 🆕 贴纸参数
  ): FFmpegCommand {
    // 【新增日志】显示即将传递给buildFilterComplex鐨勬墍鏈夊懡浠?
    console.log('[ZimuShengcheng.buildFFmpegCommand] ====== drawtextCommands 诊断信息 ======');
    console.log('[ZimuShengcheng.buildFFmpegCommand] 总命令数:', drawtextCommands.length);
    drawtextCommands.forEach((cmd, index) => {
      const textMatch = cmd.match(/text='([^']*?)'/);
      const textContent = textMatch ? textMatch[1] : '(鏈壘鍒版枃鏈?';
      console.log(`[ZimuShengcheng.buildFFmpegCommand] Command${index}: "${textContent}" (长度${cmd.length})`);
    });
    console.log('[ZimuShengcheng.buildFFmpegCommand] ====== 开始构建filter_complex ======');

    // 🆕 鏂板锛氬鏋滄湁闊虫晥瀹炰緥锛岀敓鎴愰煶棰戞贩闊抽厤缃?
    // Calculate input offset for audio (1 (video) + sticker count)
    // 注意：Build audio mix config 闇€瑕佺煡閬撲箣鍓嶅凡缁忔湁澶氬皯涓?input 浜?
    // 瑙嗛鏄?Input 0
    // 璐寸焊浠?Input 1 寮€濮嬶紝鏈?stickerAssets.length 涓?
    // 闊虫晥浠?Input 1 + stickerAssets.length 寮€濮?
    const stickerCount = stickerAssets ? stickerAssets.length : 0;
    const audioInputStartOffset = stickerCount; // 音效输入的起始偏移量 (鐩稿浜?Input 1)

    let audioMixConfig: { inputFiles: string[]; mixFilter: string } | null = null;
    if (soundInstances && soundInstances.length > 0) {
      console.log('[ZimuShengcheng.buildFFmpegCommand] 🔊 浠ヤ笅闊虫晥闇€瑕佹贩鍏ヨ棰?', soundInstances.length);
      audioMixConfig = this.buildAudioMixConfig(soundInstances, audioInputStartOffset);
    }

    // 🆕 鏋勫缓娣峰悎婊ら暅閾?(优化版：正确分层)
    // 逻辑：Video -> [Stickers] -> [Drawtext] -> Output
    // 先处理贴纸，得到中间流标签，然后传给 DrawtextGenerator

    let currentStream = '[0:v]';
    let filterParts: string[] = [];
    let stickerInputOptions: string[] = [];

    // 1. 鏋勫缓璐寸焊鍙犲姞灞?
    if (stickerAssets && stickerAssets.length > 0) {
      console.log('[ZimuShengcheng] 馃洜锔?鏋勫缓璐寸焊婊ら暅閾?..');

      // 璐寸焊杈撳叆浠?Input 1 寮€濮?(0鏄棰?
      let inputIndex = 1;

      stickerAssets.forEach(asset => {
        // 收集贴纸输入参数
        stickerInputOptions.push('-i', asset.path);

        const instanceCount = asset.instances.length;

        // 1.1 Split 杈撳叆娴?(濡傛灉鏈夊涓疄渚?
        let splitOutputs: string[] = [];
        if (instanceCount > 1) {
          const splitFilter = `[${inputIndex}:v]split=${instanceCount}`;
          let splitLabels = '';
          for (let i = 0; i < instanceCount; i++) {
            const label = `[split_${inputIndex}_${i}]`;
            splitLabels += label;
            splitOutputs.push(label);
          }
          filterParts.push(`${splitFilter}${splitLabels}`);
        } else {
          splitOutputs.push(`[${inputIndex}:v]`);
        }

        // 1.2 处理每个实例 (缩放 + 叠加)
        asset.instances.forEach((instance, idx) => {
          const sourceStream = splitOutputs[idx];
          const scaledStream = `[scaled_${inputIndex}_${idx}]`;

          // 添加缩放滤镜 (濡傛灉鏈?w/h)
          if (instance.w && instance.h) {
            filterParts.push(`${sourceStream}scale=${instance.w}:${instance.h}${scaledStream}`);
          }
          const activeStream = (instance.w && instance.h) ? scaledStream : sourceStream;

          // 生成 overlay 参数
          const overlayParams = `x=${instance.x}:y=${instance.y}:enable='between(t,${instance.startTime},${instance.endTime})'`;
          const nextStream = `[v_stk_out_${inputIndex}_${idx}]`;

          // [current][sticker_input]overlay=...[next]
          filterParts.push(`${currentStream}${activeStream}overlay=${overlayParams}${nextStream}`);
          currentStream = nextStream;
        });

        inputIndex++;
      });

      console.log('[ZimuShengcheng] 贴纸处理完毕，最终流标签:', currentStream);
    }

    // 2. 构建字幕 Drawtext (接收 currentStream 作为输入)
    // 感谢 DrawtextGenerator 鐨勬洿鏂帮紝鐜板湪鍙互浼犻€?inputLabel
    const drawtextFilter = DrawtextGenerator.buildFilterComplex(
      drawtextCommands,
      assFiles,
      fontDir,
      currentStream // 🔑 关键：将贴纸层的输出作为字幕层的输入
    );

    if (drawtextFilter) {
      filterParts.push(drawtextFilter);
    }

    // 组合最终的 filter_complex
    let finalFilterComplex = filterParts.join(';');
    console.log('[ZimuShengcheng] 鏈€缁?filter_complex 长度:', finalFilterComplex.length);


    let fullCommand = DrawtextGenerator.buildFFmpegCommand(
      inputVideo,
      outputVideo,
      finalFilterComplex // 浣跨敤鏈€缁堢殑婊ら暅閾?
    );

    // 【修复】处理过长的filter_complex
    // 如果返回特殊标记，表示需要使用文件方式传递过滤器
    if (fullCommand.startsWith('__USE_FILTER_FILE__:')) {
      console.log('[ZimuShengcheng] 检测到filter_complex杩囬暱锛屽皢浣跨敤鏂囦欢鏂瑰紡浼犻€?..');
      // 鎻愬彇杩囨护鍣ㄥ唴瀹?
      const actualFilterContent = fullCommand.substring('__USE_FILTER_FILE__:'.length);
      // 【修复】使用JSON格式避免路径中的冒号导致分割错误
      const scriptData = JSON.stringify({
        filterContent: actualFilterContent,
        inputVideo: inputVideo,
        outputVideo: outputVideo,
        audioMixConfig: audioMixConfig,  // 🆕 包含音频混音配置
        stickerInputs: stickerInputOptions // 🆕 包含贴纸输入参数
      });
      fullCommand = `__USE_FILTER_SCRIPT__:${scriptData}`;
    }

    return {
      fullCommand,
      filters: [finalFilterComplex],
      assFiles,
      tempFiles: assFiles, // 需要清理的临时文件
      audioMixConfig,  // 🆕 返回音频混音配置
      stickerInputs: stickerInputOptions // 🆕 返回贴纸输入
    };
  }

  /**
   * 🆕 构建音频混音配置
   * @param inputOffset 音频输入的起始偏移量 (榛樿涓?, 即从 Input 1 寮€濮?
   * @private
   */
  private buildAudioMixConfig(soundInstances: any[], inputOffset: number = 0): { inputFiles: string[]; mixFilter: string } | null {
    // 鏀堕泦鏈夋晥鐨勯煶鏁堟枃浠?
    const validInstances: { filePath: string; triggerTime: number; volume: number }[] = [];

    for (const instance of soundInstances) {
      // 通过同步方式获取音效文件路径（这里需要在执行前处理）
      // 简化版：直接从 soundInstances 涓鍙栧凡瑙ｆ瀽鐨勮矾寰?
      if (instance.filePath) {
        validInstances.push({
          filePath: instance.filePath,
          triggerTime: instance.triggerTime || 0,
          volume: instance.params?.volume || 0.7
        });
      }
    }

    if (validInstances.length === 0) {
      console.log('[ZimuShengcheng.buildAudioMixConfig] 没有有效的音效文件');
      return null;
    }

    // 生成输入文件列表
    const inputFiles = validInstances.map(v => v.filePath);

    // 生成混音滤镜
    // 格式: [1:a]adelay=1500|1500,volume=0.7[a1];[2:a]adelay=3000|3000,volume=0.6[a2];[0:a][a1][a2]amix=inputs=3[aout]
    const delayFilters: string[] = [];
    const labels: string[] = ['[0:a]'];  // 原始视频音轨

    validInstances.forEach((instance, index) => {
      // Input Index = 1 (Video) + inputOffset (Stickers) + index (Current Audio)
      const inputIndex = 1 + inputOffset + index;
      const delayMs = Math.round(instance.triggerTime * 1000);
      const volume = instance.volume;
      const label = `a${index}`;

      // 鐢熸垚寤惰繜鍜岄煶閲忔护闀?
      delayFilters.push(`[${inputIndex}:a]adelay=${delayMs}|${delayMs},volume=${volume}[${label}]`);
      labels.push(`[${label}]`);
    });

    // 生成混音滤镜
    // 🔧 淇锛氭坊鍔?normalize=0 禁用归一化，保持原始视频音量不变
    // weights 鍙傛暟锛氱涓€涓槸鍘熷瑙嗛闊抽噺锛堣涓?），其余是音效音量（由实例控制）
    const weights = ['1', ...validInstances.map(() => '1')].join(' ');
    const mixFilter = `${delayFilters.join(';')};${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0:weights=${weights}[aout]`;

    console.log('[ZimuShengcheng.buildAudioMixConfig] 音频混音滤镜:', mixFilter);
    console.log('[ZimuShengcheng.buildAudioMixConfig] 闊虫晥鏂囦欢鏁?', inputFiles.length);

    return {
      inputFiles,
      mixFilter
    };
  }

  /**
   * 执行FFmpeg渲染
   * @private
   */
  private async executeFFmpeg(ffmpegCmd: FFmpegCommand): Promise<void> {
    let actualCommand = ffmpegCmd.fullCommand;
    let filterContent: string | null = null;
    let inputVideo: string | null = null;
    let outputVideo: string | null = null;

    // 【修复】处理过长的filter_complex（使用execFile避免命令行限制）
    // 注意：DrawtextGenerator.buildFFmpegCommand 返回的是 __USE_FILTER_FILE__: 标记
    if (actualCommand.startsWith('__USE_FILTER_FILE__:') || actualCommand.startsWith('__USE_FILTER_SCRIPT__:')) {
      console.log('[ZimuShengcheng] 检测到过长过滤器，使用execFile方式...');
      try {
        // 【修复】解析JSON鏍煎紡鐨勫弬鏁?
        const prefixLen = actualCommand.startsWith('__USE_FILTER_SCRIPT__:')
          ? '__USE_FILTER_SCRIPT__:'.length
          : '__USE_FILTER_FILE__:'.length;
        const jsonStr = actualCommand.substring(prefixLen);
        const scriptData = JSON.parse(jsonStr);
        filterContent = scriptData.filterContent;
        inputVideo = scriptData.inputVideo;
        outputVideo = scriptData.outputVideo;

        console.log('[ZimuShengcheng] 杩囨护鍣ㄤ俊鎭?', {
          filterLength: filterContent?.length || 0,
          filterEmpty: !filterContent || filterContent.trim() === '',
          inputVideo,
          outputVideo
        });

        // 🔧 验证filterContent涓嶄负绌?
        if (!filterContent || filterContent.trim() === '') {
          console.error('[ZimuShengcheng] filterContent 为空');
          throw new Error('FFmpeg filter 内容为空，无法生成字幕视频');
        }
      } catch (error) {
        console.error('[ZimuShengcheng] 解析filter脚本参数失败:', error);
        throw error;
      }
    }

    try {
      // 通过IPC调用FFmpeg
      if (typeof window !== 'undefined' && window.$mapi?.shell?.executeFFmpeg) {
        // 浏览器环境：使用IPC
        console.log('[ZimuShengcheng] 通过IPC调用FFmpeg...');
        if (filterContent && inputVideo && outputVideo) {
          // 🆕 获取音效混音配置
          const audioMixConfig = ffmpegCmd.audioMixConfig;
          if (audioMixConfig && audioMixConfig.inputFiles.length > 0) {
            console.log('[ZimuShengcheng] 🔊 IPC 路径：检测到音效混音配置:', {
              inputFilesCount: audioMixConfig.inputFiles.length,
              mixFilter: audioMixConfig.mixFilter
            });
          }

          // 如果是长过滤器，传递JSON给IPC处理（包含音效配置）
          await window.$mapi.shell.executeFFmpeg(JSON.stringify({
            type: 'ffmpeg_long_filter',
            filterComplex: filterContent,
            inputVideo: inputVideo,
            outputVideo: outputVideo,
            stickerInputs: ffmpegCmd.stickerInputs, // 🆕 传递贴纸输入给 IPC
            // 🆕 浼犻€掗煶鏁堟贩闊抽厤缃?
            audioMixConfig: audioMixConfig
          }));

          console.log('[ZimuShengcheng] 📤 IPC调用Payload:', {
            hasStickerInputs: !!ffmpegCmd.stickerInputs,
            stickerInputsLength: ffmpegCmd.stickerInputs?.length,
            stickerInputsPreview: ffmpegCmd.stickerInputs
          });
        } else {
          await window.$mapi.shell.executeFFmpeg(actualCommand);
        }
      } else {
        // Node.js环境：使用execFile閬垮厤鍛戒护琛岄暱搴﹂檺鍒?
        const { execFile } = await import('child_process');
        const util = await import('util');
        const execFilePromise = util.promisify(execFile);
        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');

        let args: string[];
        let filterScriptFile: string | null = null;

        if (filterContent && inputVideo && outputVideo) {
          // 🔧 修复：使用filter文件而不是命令行参数，避免ENAMETOOLONG错误
          // 创建临时filter脚本文件
          const tempDir = os.default.tmpdir();
          filterScriptFile = path.default.join(tempDir, `ffmpeg_filter_${Date.now()}.txt`);

          // 写入filter_complex鍒版枃浠?
          await fs.promises.writeFile(filterScriptFile, filterContent, 'utf-8');
          console.log('[ZimuShengcheng] 创建filter脚本文件:', filterScriptFile, '大小:', filterContent.length, '字符');

          // 銆愪慨澶嶃€戜娇鐢?-/filter_complex 鍙傛暟璇诲彇鏂囦欢锛?filter_complex_script 已废弃）
          // 🆕 检查是否有音效混音配置
          const audioMixConfig = ffmpegCmd.audioMixConfig;
          // 🆕 获取贴纸输入参数
          const stickerInputs = ffmpegCmd.stickerInputs || [];

          let combinedFilterContent = filterContent;
          let audioArgs: string[] = [];

          if (audioMixConfig && audioMixConfig.inputFiles.length > 0) {
            console.log('[ZimuShengcheng] 🔊 检测到音效混音配置:', {
              inputFilesCount: audioMixConfig.inputFiles.length,
              mixFilter: audioMixConfig.mixFilter
            });

            // 添加音效文件作为额外输入
            for (const soundFile of audioMixConfig.inputFiles) {
              audioArgs.push('-i', soundFile);
            }

            // 将音频混音滤镜添加到视频滤镜末尾
            // 瑙嗛婊ら暅閫氬父浠?[out] 鎴?[v] 缁撳熬锛屾垜浠渶瑕佹坊鍔犻煶棰戞贩闊?
            combinedFilterContent = filterContent + ';' + audioMixConfig.mixFilter;
            console.log('[ZimuShengcheng] 🔊 组合后的滤镜（包含音效）长度:', combinedFilterContent.length);
          }

          // 写入filter_complex鍒版枃浠?
          await fs.promises.writeFile(filterScriptFile, combinedFilterContent, 'utf-8');
          console.log('[ZimuShengcheng] 创建filter脚本文件:', filterScriptFile, '大小:', combinedFilterContent.length, '字符');

          // 构建 args锛氳棰戣緭鍏?+ 音效输入 + 滤镜 + 输出
          if (audioMixConfig && audioMixConfig.inputFiles.length > 0) {
            // 鏈夐煶鏁堟椂锛氫娇鐢?-map 鎸囧畾杈撳嚭娴?
            args = [
              '-y',  // 覆盖已存在的输出文件
              '-i', inputVideo,
              ...stickerInputs, // 🆕一定要加上贴纸输入!
              ...audioArgs,  // 音效文件输入
              `-filter_complex_script`, filterScriptFile,  // 使用滤镜脚本文件
              '-map', '[out]',  // 视频输出
              '-map', '[aout]', // 音频输出
              '-c:v', 'libx264',
              '-preset', 'medium',
              '-crf', '18',
              '-c:a', 'aac',  // 闇€瑕侀噸鏂扮紪鐮侀煶棰?
              '-b:a', '192k',
              outputVideo
            ];
          } else {
            // 无音效：默认参数
            args = [
              '-y',
              '-i', inputVideo,
              ...stickerInputs, // 🆕 无音效时也要加上贴纸输入
              `-filter_complex_script`, filterScriptFile,
              '-map', '[out]',
              // '-map', '0:a?', // 灏濊瘯澶嶅埗鍘熼煶棰戯紙濡傛灉瀛樺湪锛?
              '-c:v', 'libx264',
              '-preset', 'medium',
              '-crf', '18',
              '-c:a', 'copy', // 澶嶅埗闊抽娴?
              outputVideo
            ];
          }
          console.log('[ZimuShengcheng] 使用execFile执行FFmpeg（长过滤器文件模式）...');

          // 确保清理filter文件
          if (!ffmpegCmd.tempFiles) {
            ffmpegCmd.tempFiles = [];
          }
          ffmpegCmd.tempFiles.push(filterScriptFile);
        } else {
          // 姝ｅ父鎯呭喌锛氱洿鎺ユ墽琛?
          console.log('[ZimuShengcheng] 使用execFile执行FFmpeg（普通模式）...');
          args = actualCommand.split(' ').slice(1); // 跳过'ffmpeg'
          args = args.map(arg => arg.startsWith('"') && arg.endsWith('"') ? arg.slice(1, -1) : arg);
        }

        const result = await execFilePromise('ffmpeg', args);
        console.log('[ZimuShengcheng] FFmpeg输出:', result.stdout?.substring(0, 200));

        // FFmpeg 将正常输出（版本信息、编码统计等）输出到 stderr
        // 杩欐槸鏍囧噯琛屼负锛屼笉鏄敊璇?
        if (result.stderr) {
          // 检查是否包含真正的错误信息
          const hasRealError = /error|failed|invalid|fatal/i.test(result.stderr);
          if (hasRealError) {
            console.error('[ZimuShengcheng] FFmpeg错误:', result.stderr);
            throw new Error(result.stderr);
          } else {
            console.log('[ZimuShengcheng] FFmpeg信息输出:', result.stderr.substring(0, 500) + (result.stderr.length > 500 ? '...' : ''));
          }
        }
      }
    } catch (error) {
      console.error('[ZimuShengcheng] FFmpeg执行失败:', error);
      throw error;
    } finally {
      // 清理临时文件
      await this.cleanupTempFiles(ffmpegCmd.tempFiles);
    }
  }

  // ==================== 辅助方法 ====================

  /**
   * 创建金色特效样式
   * @private
   */
  private createGoldEffectStyle(config: ZimuConfig): ASSStyleConfig {
    return {
      name: 'GoldEffect',
      fontname: config.subtitleStyle.fontName || 'Microsoft YaHei Bold',
      fontsize: Math.round((config.subtitleStyle.fontSize || 48) * 1.5),
      primaryColour: '&H0000D7FF',  // 金色（BGR椤哄簭锛?
      secondaryColour: '&H000000FF',
      outlineColour: '&H00008CFF',
      backColour: '&H00000000',
      bold: 1,
      italic: 0,
      borderStyle: 1,
      outline: 4,
      shadow: 0,
      alignment: 2,
      marginL: 10,
      marginR: 10,
      marginV: 200,
      scaleX: 100,
      scaleY: 100
    };
  }

  /**
   * 获取输出目录（用于保存ASS鏂囦欢锛?
   * 改为使用output目录而非系统Temp目录，避免Windows短路径（ADMINI~1锛夐棶棰?
   * @private
   */
  private async getTempDir(): Promise<string> {
    // 🔧 修复：使用系统临时目录而不是项目目录，避免中文路径问题
    // 优先使用 C:\Windows\Temp（Windows 绯荤粺鐩綍锛屼笉鍖呭惈涓枃锛?
    const path = await import('path');
    const fs = await import('fs');

    // Windows 绯荤粺涓存椂鐩綍锛堜笉鍖呭惈涓枃锛?
    const systemTempDir = process.platform === 'win32'
      ? 'C:/Windows/Temp/aigcpanel-fonts'
      : '/tmp/aigcpanel-fonts';

    // 确保目录存在
    if (typeof window !== 'undefined' && window.require) {
      const fsNode = window.require('fs');
      if (!fsNode.existsSync(systemTempDir)) {
        fsNode.mkdirSync(systemTempDir, { recursive: true });
      }
    } else {
      const fsModule = await import('fs');
      if (!fsModule.existsSync(systemTempDir)) {
        fsModule.mkdirSync(systemTempDir, { recursive: true });
      }
    }

    console.log(`[ZimuShengcheng] 使用系统临时目录: ${systemTempDir}`);
    return systemTempDir;
  }

  /**
   * 生成SRT鏂囦欢锛堢敤浜庡睍绀哄拰涓嬭浇锛?
   * @private
   */
  private async generateSRTFile(segments: CorrectedSegment[], config: ZimuConfig): Promise<string> {
    // 生成SRT内容
    let srtContent = '';
    let index = 1;

    // 格式化时间（输入为毫秒，转换为SRT格式：HH:MM:SS,mmm锛?
    const formatSRTTime = (milliseconds: number): string => {
      // 输入统一为毫秒，转换为秒
      const timeInSeconds = milliseconds / 1000;

      const h = Math.floor(timeInSeconds / 3600);
      const m = Math.floor((timeInSeconds % 3600) / 60);
      const s = Math.floor(timeInSeconds % 60);
      const ms = Math.floor((timeInSeconds % 1) * 1000);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };

    // 从修正后的片段生成SRT
    for (const segment of segments) {
      const startTime = formatSRTTime(segment.start);
      const endTime = formatSRTTime(segment.end);

      srtContent += `${index}\n`;
      srtContent += `${startTime} --> ${endTime}\n`;
      srtContent += `${segment.text}\n\n`;
      index++;
    }

    // 保存SRT鏂囦欢鍒拌緭鍑虹洰褰?
    const outputDir = await this.getTempDir();
    const path = await import('path');
    const timestamp = Date.now();
    const srtFileName = `subtitle_${timestamp}.srt`;
    const srtPath = path.join(outputDir, srtFileName).replace(/\\/g, '/');

    // 写入文件
    if (typeof window !== 'undefined' && window.$mapi?.file?.write) {
      await window.$mapi.file.write(srtPath, srtContent, { isDataPath: false });
    } else {
      // Node.js环境
      const fs = await import('fs');
      const util = await import('util');
      const writeFile = util.promisify(fs.writeFile);
      await writeFile(srtPath, srtContent, { encoding: 'utf-8' });
    }

    console.log(`[ZimuShengcheng] SRT 文件已生成: ${srtPath}`);
    return srtPath;
  }

  /**
   * 清理临时文件
   * @private
   */
  private async cleanupTempFiles(files: string[]): Promise<void> {
    for (const file of files) {
      try {
        if (typeof window !== 'undefined' && window.$mapi?.file?.deleteFile) {
          await window.$mapi.file.deleteFile(file);
        } else {
          const fs = await import('fs');
          const util = await import('util');
          const unlink = util.promisify(fs.unlink);
          await unlink(file);
        }
        console.log(`[ZimuShengcheng] 已删除临时文件: ${file}`);
      } catch (error) {
        console.warn(`[ZimuShengcheng] 删除临时文件失败: ${file}`, error);
      }
    }
  }

  /**
   * 生成调试文件（包含所有字幕详细信息）
   * @private
   */
  private async generateDebugFile(
    subtitles: ArrangedSubtitle[],
    drawtextCommands: string[],
    config: ZimuConfig
  ): Promise<string> {
    const tempDir = await this.getTempDir();
    const debugPath = `${tempDir}/subtitle_debug_${Date.now()}.json`;

    // 创建调试信息对象
    const debugInfo = {
      // 基础配置
      config: {
        videoWidth: config.videoWidth,
        videoHeight: config.videoHeight,
        subtitleStyle: config.subtitleStyle,
        keywordGroupsCount: config.keywordGroups?.length || 0
      },

      // 修正后的段落
      segments: this.correctedSegments.map(seg => ({
        text: seg.text,
        start: seg.start,
        end: seg.end,
        duration: seg.end - seg.start
      })),

      // 鍏抽敭璇嶅尮閰嶇粨鏋?
      keywordMatches: this.keywordMatches.map(match => ({
        keyword: match.keyword,
        effectType: match.effectType,
        isAnimated: match.isAnimated,
        startTime: match.startTime,
        endTime: match.endTime,
        duration: match.endTime - match.startTime,
        effectDuration: match.effectDuration, // 毫秒
        groupId: match.groupId,
        groupName: match.groupName
      })),

      // 排列后的字幕详情
      subtitles: subtitles.map((subtitle, index) => {
        const detail: any = {
          index,
          type: subtitle.type,
          text: subtitle.text,
          start: subtitle.start,
          end: subtitle.end,
          duration: subtitle.end - subtitle.start,
          position: subtitle.position,
          style: subtitle.style,
          layer: subtitle.layer
        };

        // 如果有动画配置，添加详细信息
        if (subtitle.animationConfig) {
          detail.animationConfig = {
            type: subtitle.animationConfig.type,
            duration: subtitle.animationConfig.duration, // 毫秒
            delay: subtitle.animationConfig.delay,
            intensity: subtitle.animationConfig.intensity,
            parameters: subtitle.animationConfig.parameters
          };
        }

        // 计算文本宽度（像素）
        const charCount = this.countDisplayChars(subtitle.text);
        detail.charCount = charCount;
        detail.estimatedWidth = charCount * subtitle.style.fontSize * 0.5; // 估算

        return detail;
      }),

      // 最终的drawtext命令
      drawtextCommands: drawtextCommands.map((cmd, index) => ({
        index,
        command: cmd,
        length: cmd.length
      })),

      // SmartLayoutManager信息
      layoutManager: {
        screenWidth: config.videoWidth,
        screenHeight: config.videoHeight,
        longAnimationThreshold: 5.0, // 淇鍚庣殑鍊?
        positionStrategy: 'see SmartLayoutManager.ts'
      },

      // 统计信息
      statistics: {
        totalSubtitles: subtitles.length,
        normalSubtitles: subtitles.filter(s => s.type === 'normal').length,
        effectSimple: subtitles.filter(s => s.type === 'effect_simple').length,
        effectComplex: subtitles.filter(s => s.type === 'effect_complex').length,
        totalDrawtextCommands: drawtextCommands.length
      }
    };

    // 淇濆瓨鍒版枃浠?
    try {
      if (typeof window !== 'undefined' && window.$mapi?.file?.writeText) {
        await window.$mapi.file.writeText(debugPath, JSON.stringify(debugInfo, null, 2));
      } else {
        const fs = await import('fs');
        const util = await import('util');
        const writeFile = util.promisify(fs.writeFile);
        await writeFile(debugPath, JSON.stringify(debugInfo, null, 2), 'utf8');
      }

      console.log(`[ZimuShengcheng] 调试文件已生成: ${debugPath}`);
      return debugPath;

    } catch (error) {
      console.error('[ZimuShengcheng] 生成调试文件失败:', error);
      return '';
    }
  }

  /**
   * 璁＄畻鏄剧ず瀛楃鏁帮紙涓枃绠?，英文算0.5锛?
   * @private
   */
  private countDisplayChars(text: string): number {
    let count = 0;
    for (const char of text) {
      if (/[\u4e00-\u9fff]/.test(char)) {
        count += 1; // 中文
      } else if (/[a-zA-Z0-9\s]/.test(char)) {
        count += 0.5; // 英文数字
      } else {
        count += 0.3; // 标点
      }
    }
    return count;
  }
}
