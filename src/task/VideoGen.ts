// @ts-nocheck
import { DataService } from "../service/DataService";
import { TaskService } from "../service/TaskService";
import { useServerStore } from "../store/modules/server";
import { TaskBiz } from "../store/modules/task";
import type { VideoGenModelConfigType } from "../declarations/app";

const serverStore = useServerStore();

interface SelfServerConfig {
    uhostId: string;
    apiUrl: string;
}

async function getSelfServerConfig(): Promise<SelfServerConfig | null> {
    try {
        const settingsStr = await window.$mapi.config.get('ipAgentSettings');
        if (settingsStr) {
            const settings = typeof settingsStr === 'string' ? JSON.parse(settingsStr) : settingsStr;
            if (settings.selfServerId) {
                return {
                    uhostId: settings.selfServerId,
                    apiUrl: settings.selfServerApiUrl || ''
                };
            }
        }
        return null;
    } catch (e) {
        console.error('[VideoGen] 鑾峰彇鑷富绠楀姏鏈洪厤缃け璐?', e);
        return null;
    }
}

async function runSelfServerMode(bizId: string, record: any, modelConfig: VideoGenModelConfigType) {
    console.log('[VideoGen.runSelfServerMode] start');

    const config = await getSelfServerConfig();
    if (!config || !config.uhostId) {
        throw new Error("SelfServerConfigNotFound");
    }

    let audioFile: string | undefined = undefined;
    if (modelConfig.soundType === "soundGenerate") {
        if (modelConfig.soundAudioFile) {
            audioFile = modelConfig.soundAudioFile;
        } else if (modelConfig.soundGenerateId) {
            const soundRecord = await TaskService.get(modelConfig.soundGenerateId);
            audioFile = soundRecord?.result?.url as string;
        }
    } else if (modelConfig.soundType === "soundCustom") {
        audioFile = modelConfig.soundCustomFile;
    }

    if (!audioFile) {
        throw new Error("AudioFileEmpty");
    }

    const videoFile = modelConfig.videoTemplateUrl;
    if (!videoFile) {
        throw new Error("VideoFileEmpty");
    }

    console.log(`[VideoGen.runSelfServerMode] 📁 文件路径 - 音频: ${audioFile}, 视频: ${videoFile}`);

    try {
        console.log(`[VideoGen.runSelfServerMode] 🎬 开始数字人处理...`);
        const processRes = await window.$mapi.compshare.digitalHumanProcess({
            apiUrl: config.apiUrl,
            audioFile: audioFile,
            videoFile: videoFile
        });

        if (!processRes.success) {
            throw new Error(`鏁板瓧浜哄鐞嗗け璐? ${processRes.message}`);
        }

        const videoUrl = processRes.videoPath;
        console.log(`[VideoGen.runSelfServerMode] ✅澶勭悊瀹屾垚锛岃棰戣矾寰? ${videoUrl}`);

        await TaskService.update(bizId, {
            jobResult: {
                code: 0,
                data: {
                    type: 'success',
                    data: {
                        url: videoUrl
                    }
                }
            }
        });

        console.log('[VideoGen.runSelfServerMode] jobResult saved');
        return "success";
    } catch (error: any) {
        console.error(`[VideoGen.runSelfServerMode] ❌閿欒:`, error);
        throw error;
    }
}

async function runCloudBeautyMode(bizId: string, record: any, modelConfig: VideoGenModelConfigType) {
    console.log('[VideoGen.runCloudBeautyMode] start');

    let audioFile: string | undefined;
    if (modelConfig.soundType === "soundGenerate") {
        if (modelConfig.soundAudioFile) {
            audioFile = modelConfig.soundAudioFile;
        } else if (modelConfig.soundGenerateId) {
            const soundRecord = await TaskService.get(modelConfig.soundGenerateId);
            audioFile = soundRecord?.result?.url as string;
        }
    } else if (modelConfig.soundType === "soundCustom") {
        audioFile = modelConfig.soundCustomFile;
    }
    if (!audioFile) throw new Error("AudioFileEmpty");

    const videoFile = modelConfig.videoTemplateUrl;
    if (!videoFile) throw new Error("VideoFileEmpty");

    const sysCfg = (window as any).__systemConfig || {};
    const humanWeight = (modelConfig as any).cloudBeautyMode || sysCfg.cloud_beauty_default_mode || '256m';

    console.log(`[VideoGen.runCloudBeautyMode] 📁 视频:${videoFile}, 音频:${audioFile}, 模式:${humanWeight}`);

    try {
        const submitRes = await window.$mapi.runninghub.cloudBeautySubmit({
            videoPath: videoFile,
            audioPath: audioFile,
            humanWeight
        });

        if (!submitRes.success) {
            throw new Error(submitRes.error || '提交任务失败');
        }

        const taskId = submitRes.taskId;
        console.log(`[VideoGen.runCloudBeautyMode] ✅浠诲姟宸叉彁浜? taskId: ${taskId}`);

        await TaskService.update(bizId, {
            status: "running",
            statusMsg: `浜戠缇庡寲鐢熸垚涓?(0%)`
        });

        let done = false;
        let attempts = 0;
        const maxAttempts = 200;
        let downloadUrl = '';

        while (!done && attempts < maxAttempts) {
            attempts++;
            await new Promise(r => setTimeout(r, 3000));

            const statusRes = await window.$mapi.runninghub.cloudBeautyQueryStatus({ taskId });
            if (!statusRes.success) {
                console.warn(`[VideoGen.runCloudBeautyMode] 鏌ヨ鐘舵€佸け璐? ${statusRes.error}`);
                continue;
            }

            const statusData = statusRes.data;
            const progress = statusData.progress || 0;
            await TaskService.update(bizId, {
                status: "running",
                statusMsg: `浜戠缇庡寲鐢熸垚涓?(${progress}%)`
            });

            console.log(`[VideoGen.runCloudBeautyMode] 🔄 鐘舵€?${statusData.status} 进度:${progress}%`);

            if (statusData.status === 'done') {
                done = true;
                downloadUrl = statusData.download_url || '';
            } else if (statusData.status === 'failed') {
                throw new Error(`云端美化任务失败: ${statusData.error || '未知错误'}`);
            }
        }

        if (!done) throw new Error('云端美化任务超时');

        console.log(`[VideoGen.runCloudBeautyMode] ✅浠诲姟瀹屾垚, URL: ${downloadUrl}`);

        await TaskService.update(bizId, {
            jobResult: {
                code: 0,
                data: {
                    type: 'success',
                    data: {
                        url: downloadUrl,
                        cloudTaskId: taskId
                    }
                }
            }
        });

        return "success";
    } catch (error: any) {
        console.error(`[VideoGen.runCloudBeautyMode] ❌閿欒:`, error);
        throw error;
    }
}

/**
 * 云端模式：使用RunningHub API执行任务
 */
async function runCloudMode(bizId: string, record: any, modelConfig: VideoGenModelConfigType) {
    console.log(`[VideoGen.runCloudMode] start, serverName=${record.serverName}`);

    if (record.serverName === '__CLOUD_BEAUTY__') {
        return await runCloudBeautyMode(bizId, record, modelConfig);
    }

    const mode = record.serverName;

    // 1. 准备音频文件
    let audioFile: string | undefined = undefined;
    if (modelConfig.soundType === "soundGenerate") {
        if (modelConfig.soundAudioFile) {
            audioFile = modelConfig.soundAudioFile;
        } else if (modelConfig.soundGenerateId) {
            const soundRecord = await TaskService.get(modelConfig.soundGenerateId);
            audioFile = soundRecord?.result?.url as string;
        }
    } else if (modelConfig.soundType === "soundCustom") {
        audioFile = modelConfig.soundCustomFile;
    }

    if (!audioFile) {
        throw new Error("AudioFileEmpty");
    }

    const videoFile = modelConfig.videoTemplateUrl;
    if (!videoFile) {
        throw new Error("VideoFileEmpty");
    }

    console.log(`[VideoGen.runCloudMode] 📁 文件路径 - 音频: ${audioFile}, 视频: ${videoFile}`);

    // 鑾峰彇闊抽鏃堕暱锛堜紭鍏堜娇鐢ㄥ墠绔紶閫掔殑鏃堕暱锛?
    let audioDuration: number | undefined = modelConfig.audioDuration;

    if (mode === '__CLOUD__' || mode === '__CLOUD_MODE2__' || mode === '__CLOUD_MODEL_3__' || mode === '__CLOUD_MODEL_4__' || mode === '__CLOUD_MODEL_5__' || mode === '__CLOUD_MODEL_6__' || mode === '__CLOUD_MODEL_7__' || mode === '__CLOUD_MODEL_8__') {
        if (audioDuration && audioDuration > 0) {
            console.log(`[VideoGen.runCloudMode] using provided audioDuration=${audioDuration}s`);
        } else {
            // 濡傛灉鍓嶇娌℃湁浼犻€掓椂闀匡紝灏濊瘯鐢?ffprobe 获取
            try {
                console.log(`[VideoGen.runCloudMode] 📊 前端未传递时长，尝试用ffprobe获取: ${audioFile}`);
                const videoInfo = await window.$mapi.app.ffprobeVideoInfo(audioFile);
                console.log(`[VideoGen.runCloudMode] 📊 ffprobe返回结果:`, videoInfo);
                if (videoInfo?.duration && videoInfo.duration > 0) {
                    audioDuration = videoInfo.duration;
                    console.log(`[VideoGen.runCloudMode] ffprobe got audio duration: ${audioDuration}s`);
                } else {
                    console.warn(`[VideoGen.runCloudMode] ⚠️ 鏈幏鍙栧埌鏈夋晥鐨勯煶棰戞椂闀? videoInfo:`, videoInfo);
                }
            } catch (error) {
                console.error(`[VideoGen.runCloudMode] ❌鑾峰彇闊抽鏃堕暱澶辫触:`, error);
            }
        }
    }

    try {
        // 2. 上传视频文件
        console.log(`[VideoGen.runCloudMode] ⬆️ 上传视频文件: ${videoFile}, mode: ${mode}`);
        const uploadVideoRes = await window.$mapi.runninghub.uploadFile({
            filePath: videoFile,
            fileType: 'video',
            mode: mode
        });
        if (!uploadVideoRes.success) {
            throw new Error(`视频上传失败: ${uploadVideoRes.error}`);
        }
        const videoFileName = uploadVideoRes.fileName;
        console.log(`[VideoGen.runCloudMode] ✅瑙嗛涓婁紶鎴愬姛: ${videoFileName}`);

        // 3. 上传音频文件
        console.log(`[VideoGen.runCloudMode] ⬆️ 上传音频文件: ${audioFile}, mode: ${mode}`);
        const uploadAudioRes = await window.$mapi.runninghub.uploadFile({
            filePath: audioFile,
            fileType: 'audio',
            mode: mode
        });
        if (!uploadAudioRes.success) {
            throw new Error(`音频上传失败: ${uploadAudioRes.error}`);
        }
        const audioFileName = uploadAudioRes.fileName;
        console.log(`[VideoGen.runCloudMode] ✅闊抽涓婁紶鎴愬姛: ${audioFileName}`);

        // 4. 创建云端任务
        console.log(`[VideoGen.runCloudMode] 🚀 创建云端任务, mode: ${mode}, audioDuration: ${audioDuration}`);
        const createTaskRes = await window.$mapi.runninghub.createTask({
            videoFileName,
            audioFileName,
            audioDuration,
            mode: mode,
            text: modelConfig.text || modelConfig.promptText || ''
        });
        if (!createTaskRes.success) {
            throw new Error(`创建任务失败: ${createTaskRes.error}`);
        }
        const cloudTaskId = createTaskRes.taskId;
        console.log(`[VideoGen.runCloudMode] ✅浠诲姟鍒涘缓鎴愬姛, taskId: ${cloudTaskId}`);

        // 5. 绛夊緟浠诲姟瀹屾垚锛堝甫杞锛屾渶闀?0鍒嗛挓锛?
        console.log(`[VideoGen.runCloudMode] ⏳绛夊緟浠诲姟瀹屾垚锛堟渶闀?0鍒嗛挓锛?..`);
        const waitRes = await window.$mapi.runninghub.waitForTaskComplete({
            taskId: cloudTaskId,
            maxRetries: 600,  // 10分钟 = 600绉?
            interval: 1000,
            mode: mode
        });

        if (!waitRes.success) {
            throw new Error(`任务执行失败: ${waitRes.error}`);
        }

        const result = waitRes.result;
        console.log(`[VideoGen.runCloudMode] ✅浠诲姟瀹屾垚`, result);

        // 6. 保存jobResult（不设置status，让successFunc来处理）
        const videoUrl = result.results?.[0]?.url;
        await TaskService.update(bizId, {
            jobResult: {
                code: 0,
                data: {
                    type: 'success',
                    data: {
                        url: videoUrl,
                        cloudTaskId: cloudTaskId
                    }
                }
            }
        });

        console.log(`[VideoGen.runCloudMode] ✅jobResult已保存，等待successFunc下载视频`);
        return "success";
    } catch (error: any) {
        console.error(`[VideoGen.runCloudMode] ❌閿欒:`, error);
        throw error;
    }
}

export const VideoGen: TaskBiz = {
    runFunc: async (bizId, bizParam) => {
        // console.log('VideoGen.runFunc', {bizId, bizParam})
        const record = await TaskService.get(bizId);
        if (!record) {
            throw new Error("Task record not found");
        }
        const modelConfig: VideoGenModelConfigType = record.modelConfig;

        console.log(`[VideoGen.runFunc] 寮€濮嬫墽琛屼换鍔? ${bizId}`);

        // 云端模式
        if (record.serverName?.startsWith('__CLOUD')) {
            return await runCloudMode(bizId, record, modelConfig);
        }

        // 鑷富绠楀姏鏈烘ā寮?
        if (record.serverName === '__SELF_SERVER__') {
            return await runSelfServerMode(bizId, record, modelConfig);
        }

        // 本地模式
        const { server, serverInfo } = await serverStore.prepareForTask(bizId, bizParam);
        let audioFile: string | undefined = undefined;
        console.log('[VideoGen] 🔍 音频配置:', {
            soundType: modelConfig.soundType,
            soundAudioFile: modelConfig.soundAudioFile,
            soundGenerateId: modelConfig.soundGenerateId,
            soundCustomFile: modelConfig.soundCustomFile
        });

        if (modelConfig.soundType === "soundGenerate") {
            // 🔧 优先使用新的 soundAudioFile（TTS实时合成的音频）
            if (modelConfig.soundAudioFile) {
                audioFile = modelConfig.soundAudioFile;
                console.log('[VideoGen] 🎵 使用TTS鍚堟垚鐨勯煶棰戞枃浠?', audioFile);
            } else if (modelConfig.soundGenerateId) {
                // 鍏煎鏃ф柟寮忥細浠庨煶棰戠敓鎴愪换鍔¤幏鍙?
                const soundRecord = await TaskService.get(modelConfig.soundGenerateId);
                console.log('[VideoGen] 📋 获取到的音频任务记录:', soundRecord);
                audioFile = soundRecord?.result?.url as string;
                console.log('[VideoGen] 🎵 从任务记录提取的音频文件:', audioFile);
            }
        } else if (modelConfig.soundType === "soundCustom") {
            audioFile = modelConfig.soundCustomFile;
            console.log('[VideoGen] 📁 鑷畾涔夐煶棰戞枃浠惰矾寰?', audioFile);
        }

        console.log('[VideoGen] ✅鏈€缁堥煶棰戞枃浠惰矾寰?', audioFile);
        if (!audioFile) {
            console.error('[VideoGen] ❌閿欒锛氶煶棰戞枃浠惰矾寰勪负绌猴紒', {
                soundType: modelConfig.soundType,
                soundAudioFile: modelConfig.soundAudioFile,
                soundGenerateId: modelConfig.soundGenerateId,
                soundCustomFile: modelConfig.soundCustomFile
            });
            throw new Error("AudioFileEmpty");
        }
        const res = await serverStore.call(serverInfo, "videoGen", {
            id: serverStore.generateTaskId("VideoGen", bizId),
            result: record.result,
            param: record.param,
            video: modelConfig.videoTemplateUrl,
            audio: audioFile,
        });
        // console.log('VideoGen.runFunc.res', res)
        if (res.code) {
            throw res.msg || "apiRequest videoGen fail";
        }
        switch (res.data.type) {
            case "success":
                // 🔧 关键修复：必须等待数据库更新完成
                // 否则 successFunc 涓煡璇笉鍒?jobResult
                // 保存 jobResult 鍜?status锛堢‘淇?UI 可以立即看到任务已完成）
                try {
                    await TaskService.update(bizId, {
                        status: "success",
                        jobResult: res,
                    });
                    console.log(`[VideoGen.runFunc] ✅jobResult 已保存到数据库，status=success`);
                } catch (e) {
                    console.error(`[VideoGen.runFunc] ❌淇濆瓨 jobResult 失败: ${e}`);
                }
                return "success";
            case "retry":
                return "retry";
            default:
                throw `unknown res.data.type : ${res.data.type}`;
        }
    },
    successFunc: async (bizId, bizParam) => {
        console.log(`[VideoGen.successFunc] 馃摻锔?开始处理视频生成完成，bizId=${bizId}`);
        const record = await TaskService.get(bizId);
        if (!record) {
            throw new Error("Task record not found");
        }
        console.log(`[VideoGen.successFunc] 📋 从数据库获取任务记录完成`);

        // 🔧 诊断：打印jobResult鐨勫畬鏁村唴瀹?
        if (!record.jobResult) {
            console.error('[VideoGen.successFunc] jobResult is empty or undefined');
            console.error(`[VideoGen.successFunc] 完整record:`, JSON.stringify(record, null, 2));
            throw new Error("jobResult not found");
        }
        console.log(`[VideoGen.successFunc] jobResult 结构:`, JSON.stringify(record.jobResult, null, 2));

        // 🔧 涓烘枃浠朵繚瀛樻坊鍔犺秴鏃朵繚鎶わ紙闃叉鍗′綇锛?
        const SAVE_FILE_TIMEOUT = 60 * 1000; // 60绉掕秴鏃讹紙瑙嗛閫氬父杈冨ぇ锛?
        let savedUrl = "";

        try {
            const videoUrl = record.jobResult?.data?.data?.url;
            console.log(`[VideoGen.successFunc] 🔗 即将保存的视频URL: ${videoUrl}`);
            if (!videoUrl) {
                throw new Error("Video URL not found in jobResult");
            }

            // 云端模式：下载云端视频到本地
            const isCloudMode = record.serverName?.startsWith('__CLOUD');
            if (isCloudMode) {
                console.log(`[VideoGen.successFunc] ☁️ 云端模式，开始下载视频到本地...`);
                const downloadPromise = window.$mapi.file.downloadUrl(videoUrl);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("File download timeout after 60s")), SAVE_FILE_TIMEOUT)
                );
                savedUrl = await Promise.race([downloadPromise, timeoutPromise as any]);
                console.log(`[VideoGen.successFunc] ✅浜戠瑙嗛涓嬭浇瀹屾垚锛屼繚瀛樿矾寰? ${savedUrl}`);
            } else {
                // 本地模式：保存到本地
                const savePromise = DataService.saveFile(videoUrl, {saveGroup: 'video'});
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("File save timeout after 60s")), SAVE_FILE_TIMEOUT)
                );
                savedUrl = await Promise.race([savePromise, timeoutPromise as any]);
                console.log(`[VideoGen.successFunc] ✅鏂囦欢淇濆瓨瀹屾垚锛屼繚瀛樿矾寰? ${savedUrl}`);
            }
        } catch (error: any) {
            console.warn(`[VideoGen] 鏂囦欢淇濆瓨澶辫触鎴栬秴鏃? ${error.message}, 使用原始URL`);
            // 如果文件保存失败或超时，直接使用原始URL
            savedUrl = record.jobResult?.data?.data?.url || "";
            console.warn(`[VideoGen.successFunc] 使用原始URL: ${savedUrl}`);
        }

        // 🔧 确保 savedUrl 涓嶄负绌?
        if (!savedUrl) {
            console.error('[VideoGen.successFunc] savedUrl is empty');
            throw new Error("Failed to get video URL from jobResult");
        }

        // 🔧 准备更新数据
        const updateData = {
            status: "success",
            endTime: Date.now(),
            result: {
                url: savedUrl,
                cloudTaskId: record.jobResult?.data?.data?.cloudTaskId
            },
        };

        console.log(`[VideoGen.successFunc] 📝 准备更新数据库，updateData:`, JSON.stringify(updateData, null, 2));

        try {
            await TaskService.update(bizId, updateData);
            console.log(`[VideoGen.successFunc] ✅鏁版嵁搴撴洿鏂版垚鍔燂紝result.url = ${savedUrl}`);

            // 🔧 验证：重新查询确保数据已保存
            const verifyRecord = await TaskService.get(bizId);
            console.log(`[VideoGen.successFunc] ✅楠岃瘉锛氶噸鏂版煡璇换鍔★紝result:`, {
                url: verifyRecord?.result?.url,
                cloudTaskId: verifyRecord?.result?.cloudTaskId,
                status: verifyRecord?.status,
                endTime: verifyRecord?.endTime
            });

            if (!verifyRecord?.result?.url) {
                console.error('[VideoGen.successFunc] result.url verification failed');
                throw new Error("Failed to verify saved result");
            }
        } catch (updateError: any) {
            console.error(`[VideoGen.successFunc] ❌鏁版嵁搴撴洿鏂板け璐?`, {
                error: updateError?.message,
                bizId,
                updateData: JSON.stringify(updateData)
            });
            throw updateError;
        }

        try { const _u = JSON.parse(localStorage.getItem('auth_user') || '{}'); window.require('electron').ipcRenderer.invoke('auth:reportGeneration', { userId: _u.id, type: 'video', detail: record.name || '' }); } catch(e) {}

        // 云端模式跳过GPU清理
        if (record.serverName?.startsWith('__CLOUD')) {
            console.log(`[VideoGen.successFunc] ☁️ 云端模式，跳过GPU清理`);
            return;
        }

        // 🔧 任务完成后执行GPU娓呯悊锛堜粎鏈湴妯″紡锛?
        // 延迟10秒确保前端数据保存（saveWorkData锛夊畬鎴?
        setTimeout(async () => {
            try {
                const ipAgentSettingsStr = await window.$mapi.config.get('ipAgentSettings');
                const ipAgentSettings = ipAgentSettingsStr ? (typeof ipAgentSettingsStr === 'string' ? JSON.parse(ipAgentSettingsStr) : ipAgentSettingsStr) : {};
                if (!ipAgentSettings.enableGpuCleanup) {
                    console.log('[VideoGen.successFunc] 本地模型进程优化未开启，跳过GPU清理');
                    return;
                }

                console.log('[VideoGen.successFunc] 🧹 任务完成，开始GPU深度清理...');
                if (window.$mapi && window.$mapi.shell) {
                    // 🔧 获取所有模型的完整路径（绝对路径）
                    const modelPaths: string[] = [];
                    for (const record of serverStore.records) {
                        if (record.localPath) {
                            try {
                                // 获取完整绝对路径
                                const serverInfo = await serverStore.serverInfo(record);
                                if (serverInfo.localPath) {
                                    modelPaths.push(serverInfo.localPath);
                                }
                            } catch (e) {
                                console.warn(`[VideoGen.successFunc] 获取路径失败: ${record.name}`, e);
                            }
                        }
                    }

                    // 去重
                    const uniquePaths = modelPaths.filter((path, index, self) => self.indexOf(path) === index);

                    // 🔧 修复：使用打包的Python，而不是依赖系统的py命令
                    const pythonPath = await window.$mapi.shell.getPythonPath();

                    // 🔧 鍔ㄦ€佽幏鍙栬剼鏈矾寰勶紙鏀寔寮€鍙戝拰鐢熶骇鐜锛?
                    const appRoot = (window as any)["APP_ROOT"] || process.env.APP_ROOT || process.cwd();
                    const cleanupScriptPath = `${appRoot}/scripts/cleanup_gpu.py`;

                    // 鏋勫缓鍛戒护琛屽弬鏁帮紙璺緞浠ラ€楀彿鍒嗛殧锛?
                    const pathsArg = uniquePaths.join(',');
                    const command = pathsArg
                        ? `"${pythonPath}" "${cleanupScriptPath}" "${pathsArg}"`
                        : `"${pythonPath}" "${cleanupScriptPath}"`;

                    console.log(`[VideoGen.successFunc] 清理命令: ${command}`);
                    console.log(`[VideoGen.successFunc] Python路径: ${pythonPath}`);
                    console.log(`[VideoGen.successFunc] 脚本路径: ${cleanupScriptPath}`);
                    console.log(`[VideoGen.successFunc] 妯″瀷璺緞鏁? ${uniquePaths.length}`);
                    await window.$mapi.shell.exec(command);
                    console.log('[VideoGen.successFunc] ✅GPU深度清理完成');
                }
            } catch (cleanupError: any) {
                console.warn('[VideoGen.successFunc] ⚠️ GPU清理失败（不影响主流程）:', cleanupError?.message);
            }
        }, 10000); // 延迟10绉掔‘淇濇墍鏈夋暟鎹繚瀛樺畬鎴?
    },
    failFunc: async (bizId, msg, bizParam) => {
        // console.log('VideoGen.failFunc', {bizId, bizParam, msg})
        console.log(`[VideoGen.failFunc] ❌浠诲姟澶辫触: ${bizId}, 错误信息: ${msg}`);

        await TaskService.update(bizId, {
            status: "fail",
            statusMsg: msg,
            endTime: Date.now(),
        });

        // 🔧 任务失败后执行GPU清理
        // 延迟10绉掔‘淇濆墠绔暟鎹繚瀛樺畬鎴?
        setTimeout(async () => {
            try {
                const ipAgentSettingsStr = await window.$mapi.config.get('ipAgentSettings');
                const ipAgentSettings = ipAgentSettingsStr ? (typeof ipAgentSettingsStr === 'string' ? JSON.parse(ipAgentSettingsStr) : ipAgentSettingsStr) : {};
                if (!ipAgentSettings.enableGpuCleanup) {
                    console.log('[VideoGen.failFunc] 本地模型进程优化未开启，跳过GPU清理');
                    return;
                }

                console.log('[VideoGen.failFunc] 🧹 任务失败，开始GPU深度清理...');
                if (window.$mapi && window.$mapi.shell) {
                    // 🔧 获取所有模型的完整路径（绝对路径）
                    const modelPaths: string[] = [];
                    for (const record of serverStore.records) {
                        if (record.localPath) {
                            try {
                                // 获取完整绝对路径
                                const serverInfo = await serverStore.serverInfo(record);
                                if (serverInfo.localPath) {
                                    modelPaths.push(serverInfo.localPath);
                                }
                            } catch (e) {
                                console.warn(`[VideoGen.failFunc] 获取路径失败: ${record.name}`, e);
                            }
                        }
                    }

                    // 去重
                    const uniquePaths = modelPaths.filter((path, index, self) => self.indexOf(path) === index);

                    // 🔧 修复：使用打包的Python，而不是依赖系统的py命令
                    const pythonPath = await window.$mapi.shell.getPythonPath();

                    // 🔧 鍔ㄦ€佽幏鍙栬剼鏈矾寰勶紙鏀寔寮€鍙戝拰鐢熶骇鐜锛?
                    const appRoot = (window as any)["APP_ROOT"] || process.env.APP_ROOT || process.cwd();
                    const cleanupScriptPath = `${appRoot}/scripts/cleanup_gpu.py`;

                    // 鏋勫缓鍛戒护琛屽弬鏁帮紙璺緞浠ラ€楀彿鍒嗛殧锛?
                    const pathsArg = uniquePaths.join(',');
                    const command = pathsArg
                        ? `"${pythonPath}" "${cleanupScriptPath}" "${pathsArg}"`
                        : `"${pythonPath}" "${cleanupScriptPath}"`;

                    console.log(`[VideoGen.failFunc] 清理命令: ${command}`);
                    console.log(`[VideoGen.failFunc] Python路径: ${pythonPath}`);
                    console.log(`[VideoGen.failFunc] 脚本路径: ${cleanupScriptPath}`);
                    console.log(`[VideoGen.failFunc] 妯″瀷璺緞鏁? ${uniquePaths.length}`);
                    await window.$mapi.shell.exec(command);
                    console.log('[VideoGen.failFunc] ✅GPU清理完成');
                }
            } catch (cleanupError: any) {
                console.warn('[VideoGen.failFunc] ⚠️ GPU清理失败（不影响主流程）:', cleanupError?.message);
            }
        }, 10000); // 延迟10绉掔‘淇濇墍鏈夋暟鎹繚瀛樺畬鎴?
    },
    // 🔧 褰撲换鍔¤鐢ㄦ埛鍙栨秷鏃惰皟鐢?
    requestCancelFunc: async (bizId, bizParam) => {
        console.log(`[VideoGen.requestCancelFunc] 🛑 用户取消任务: ${bizId}`);

        // 🔧 任务取消后执行GPU清理
        // 延迟10绉掔‘淇濆墠绔暟鎹繚瀛樺畬鎴?
        setTimeout(async () => {
            try {
                const ipAgentSettingsStr = await window.$mapi.config.get('ipAgentSettings');
                const ipAgentSettings = ipAgentSettingsStr ? (typeof ipAgentSettingsStr === 'string' ? JSON.parse(ipAgentSettingsStr) : ipAgentSettingsStr) : {};
                if (!ipAgentSettings.enableGpuCleanup) {
                    console.log('[VideoGen.requestCancelFunc] 本地模型进程优化未开启，跳过GPU清理');
                    return;
                }

                console.log('[VideoGen.requestCancelFunc] 🧹 任务取消，开始GPU深度清理...');
                if (window.$mapi && window.$mapi.shell) {
                    // 🔧 获取所有模型的完整路径（绝对路径）
                    const modelPaths: string[] = [];
                    for (const record of serverStore.records) {
                        if (record.localPath) {
                            try {
                                // 获取完整绝对路径
                                const serverInfo = await serverStore.serverInfo(record);
                                if (serverInfo.localPath) {
                                    modelPaths.push(serverInfo.localPath);
                                }
                            } catch (e) {
                                console.warn(`[VideoGen.requestCancelFunc] 获取路径失败: ${record.name}`, e);
                            }
                        }
                    }

                    // 去重
                    const uniquePaths = modelPaths.filter((path, index, self) => self.indexOf(path) === index);

                    // 🔧 修复：使用打包的Python，而不是依赖系统的py命令
                    const pythonPath = await window.$mapi.shell.getPythonPath();

                    // 🔧 鍔ㄦ€佽幏鍙栬剼鏈矾寰勶紙鏀寔寮€鍙戝拰鐢熶骇鐜锛?
                    const appRoot = (window as any)["APP_ROOT"] || process.env.APP_ROOT || process.cwd();
                    const cleanupScriptPath = `${appRoot}/scripts/cleanup_gpu.py`;

                    // 鏋勫缓鍛戒护琛屽弬鏁帮紙璺緞浠ラ€楀彿鍒嗛殧锛?
                    const pathsArg = uniquePaths.join(',');
                    const command = pathsArg
                        ? `"${pythonPath}" "${cleanupScriptPath}" "${pathsArg}"`
                        : `"${pythonPath}" "${cleanupScriptPath}"`;

                    console.log(`[VideoGen.requestCancelFunc] 清理命令: ${command}`);
                    console.log(`[VideoGen.requestCancelFunc] Python路径: ${pythonPath}`);
                    console.log(`[VideoGen.requestCancelFunc] 脚本路径: ${cleanupScriptPath}`);
                    console.log(`[VideoGen.requestCancelFunc] 妯″瀷璺緞鏁? ${uniquePaths.length}`);
                    await window.$mapi.shell.exec(command);
                    console.log('[VideoGen.requestCancelFunc] ✅GPU清理完成');
                }
            } catch (cleanupError: any) {
                console.warn('[VideoGen.requestCancelFunc] ⚠️ GPU清理失败（不影响主流程）:', cleanupError?.message);
            }
        }, 10000); // 延迟10绉掔‘淇濇墍鏈夋暟鎹繚瀛樺畬鎴?
    },
};
