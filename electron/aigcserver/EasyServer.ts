import {Files} from "../mapi/file/main";
import {Log} from "../mapi/log/main";
import {SendType, ServerApiType, ServerFunctionDataType, ServerInfo} from "../mapi/server/type";
import {AigcServerUtil} from "./util";
import path from "path";
import {getFFmpegExecutablePath, resourceExists} from "../lib/resource-path";

type LauncherResultType = {
    result: {
        [key: string]: any;
    };
    endTime: number | null;
};

const normalizeEasyServerFunctions = (functions: Record<string, any> = {}) => {
    const normalized = {
        ...functions,
    };
    if (normalized.speechRecognition && !normalized.asr) {
        normalized.asr = normalized.speechRecognition;
    }
    return normalized;
};

export const EasyServer = function (config: any) {
    const me = this;
    let controller: any = null;
    let controllerWatching = {
        id: null as string | null,
        launcherResult: null as LauncherResultType | null,
        resolve: null as ((value: any) => void) | null,
        reject: null as ((reason?: any) => void) | null,
        promiseResolved: false,
    };
    this.serverConfig = {
        ...(config || {}),
        easyServer: {
            ...(config?.easyServer || {}),
            functions: normalizeEasyServerFunctions(config?.easyServer?.functions || {}),
        },
    } as {
        easyServer: {
            entry: string;
            entryArgs: string[];
            envs: string[];
            content: string;
            functions: {
                [key: string]: {
                    content?: string;
                    param?: any[];
                };
            };
        };
    };
    this.isRunning = false;
    this.ServerApi = null as ServerApiType | null;
    this.ServerInfo = null as ServerInfo | null;
    this.serverRuntime = {
        startTime: 0,
    };
    this.send = function (type: SendType, data: any) {
        this.ServerApi.event.sendChannel(this.ServerInfo.eventChannelName, {type, data});
    };
    this.init = async function () {
    };
    this.config = async function () {
        return {
            code: 0,
            msg: "ok",
            data: {
                httpUrl: null,
                content: this.serverConfig.easyServer.content || "",
                functions: this.serverConfig.easyServer.functions || {},
            },
        };
    };
    this.start = async function () {
        // console.log('start', this.ServerInfo)
        this.serverRuntime.startTime = Date.now();
        this.send("starting", this.ServerInfo);
    };
    this.ping = async function (): Promise<boolean> {
        // console.log('ping', this.ServerInfo)
        return this.serverRuntime.startTime > 0;
    };
    this.stop = async function () {
        // console.log('stop', this.ServerInfo)
        this.send("stopping", this.ServerInfo);
        this.serverRuntime.startTime = 0;
        if (controller) {
            try {
                await controller.stop();
            } catch (e) {
                Log.warn("easyServer.stop.error", e);
            }
            controller = null;
        }
        this.send("stopped", this.ServerInfo);
        this.send("success", this.ServerInfo);
    };
    this.cancel = async function () {
        if (controller) {
            await controller.stop();
            controller = null;
        }
    };
    this._controllerRunIfNeeded = async function (
        configJsonPath: string | null,
        option: {
            timeout: number;
        }
    ) {
        if (!controller) {
            const _localPath = this.ServerInfo?.localPath || '';
            Log.info("[EasyServer] ServerInfo.localPath", _localPath);
            let command = [];
            command.push(this.serverConfig.easyServer.entry);
            if (this.serverConfig.easyServer.entryArgs) {
                command = command.concat(this.serverConfig.easyServer.entryArgs);
            }
            for (let i = 0; i < command.length; i++) {
                command[i] = command[i].replace("${CONFIG}", `"${configJsonPath}"`);
                command[i] = command[i].replace("${ROOT}", _localPath);
            }
            Log.info("[EasyServer] command", JSON.stringify(command));
            Log.info("[EasyServer] localPath", this.ServerInfo.localPath);
            const envMap = {};
            Log.info('EasyServer.config', JSON.stringify(this.serverConfig.easyServer));
            if (this.serverConfig.easyServer.entry === "launcher") {
                const systemEnv = await this.ServerApi.env();
                // console.log('EasyServer.systemEnv', systemEnv)
                for (const k in systemEnv) {
                    envMap[k] = systemEnv[k];
                }
            }
            // 🔧 修复：添加 FFmpeg 目录到 PATH，让 Python 脚本能找到 ffmpeg
            const pathDirs = [
                `${this.ServerInfo.localPath}`,
                `${this.ServerInfo.localPath}/binary`,
            ];
            const ffmpegPath = getFFmpegExecutablePath();
            if (resourceExists(ffmpegPath)) {
                const ffmpegDir = path.dirname(ffmpegPath);
                pathDirs.push(ffmpegDir);
                Log.info(`[EasyServer] ✓ 已添加 FFmpeg 目录到 PATH: ${ffmpegDir}`);
            }
            envMap["PATH"] = this.ServerApi.getPathEnv(pathDirs);
            envMap["PYTHONIOENCODING"] = "utf-8";
            envMap["AIGCPANEL_SERVER_PLACEHOLDER_CONFIG"] = configJsonPath;
            envMap["AIGCPANEL_SERVER_PLACEHOLDER_ROOT"] = this.ServerInfo.localPath;
            if (this.serverConfig.easyServer.envs) {
                for (const e of this.serverConfig.easyServer.envs) {
                    let pcs = e.split("=");
                    const key = pcs.shift();
                    envMap[key] = pcs.join("=");
                }
            }
            for (const k in envMap) {
                envMap[k] = envMap[k].replace("${CONFIG}", `"${configJsonPath}"`);
                envMap[k] = envMap[k].replace("${ROOT}", this.ServerInfo.localPath);
            }
            const hasMoreQueue = async () => {
                const queueRoot = this.ServerInfo.localPath + `/aigcpanel-queue/`;
                const files = await Files.list(queueRoot);
                const validQueueFiles = files.filter(f => f.name.match(/\.queue\.json$/));
                if (validQueueFiles.length > 0) {
                    const configJson = await Files.temp("json");
                    await Files.copy(validQueueFiles[0].pathname, configJson);
                    await Files.deletes(validQueueFiles[0].pathname);
                    this._controllerRunIfNeeded(configJson, option);
                }
            };
            let timer = null;
            if (option.timeout > 0) {
                timer = setTimeout(() => {
                    if (controller) {
                        try {
                            controller.stop();
                        } catch (e) {
                            Log.error("easyServer.timeout.stop.error", e);
                        }
                    }
                    this.ServerApi.file.appendText(this.ServerInfo.logFile, "timeout", {isDataPath: true});
                    if (controllerWatching.reject) {
                        controllerWatching.reject(undefined);
                    }
                }, option.timeout * 1000);
            }
            let buffer = "";
            controller = await this.ServerApi.app.spawnShell(command, {
                env: envMap,
                cwd: this.ServerInfo.localPath,
                stdout: _data => {
                    // console.log('easyServer.stdout', _data)
                    buffer += _data;
                    // check if has \n and process the buffer
                    let lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    this.ServerApi.file.appendText(this.ServerInfo.logFile, _data, {isDataPath: true});

                    // 发送日志到前端UI
                    if (controllerWatching.id) {
                        this.send("taskLog", {
                            id: controllerWatching.id,
                            type: "stdout",
                            data: _data,
                            timestamp: Date.now()
                        });
                    }

                    const result = this.ServerApi.extractResultFromLogs(controllerWatching.id, lines.join("\n") + "\n");
                    if (result) {
                        if (controllerWatching.launcherResult) {
                            controllerWatching.launcherResult.result = Object.assign(controllerWatching.launcherResult.result, result);
                        }
                        if (controllerWatching.id) {
                            this.send("taskResult", {id: controllerWatching.id, result});
                        }
                    }
                    if (controllerWatching.launcherResult) {
                        controllerWatching.launcherResult.result.error =
                            AigcServerUtil.errorDetect(_data) || controllerWatching.launcherResult.result.error;
                        // 🔧 修复：只有在End=true且已经有有效结果(url/records/error)时才resolve
                        if (controllerWatching.launcherResult.result && controllerWatching.launcherResult.result['End']) {
                            const hasValidResult =
                                controllerWatching.launcherResult.result.url ||
                                controllerWatching.launcherResult.result.records ||
                                controllerWatching.launcherResult.result.error;
                            if (hasValidResult && controllerWatching.resolve && !controllerWatching.promiseResolved) {
                                controllerWatching.promiseResolved = true;
                                controllerWatching.resolve(undefined);
                            }
                        }
                    }
                },
                stderr: _data => {
                    // console.log('easyServer.stderr', _data)
                    this.ServerApi.file.appendText(this.ServerInfo.logFile, _data, {isDataPath: true});

                    // 发送日志到前端UI
                    if (controllerWatching.id) {
                        this.send("taskLog", {
                            id: controllerWatching.id,
                            type: "stderr",
                            data: _data,
                            timestamp: Date.now()
                        });
                    }

                    if (controllerWatching.launcherResult) {
                        controllerWatching.launcherResult.result.error =
                            AigcServerUtil.errorDetect(_data) || controllerWatching.launcherResult.result.error;
                    }
                },
                success: _data => {
                    // console.log('easyServer.success', _data)
                    clearTimeout(timer);
                    controller = null;
                    hasMoreQueue()
                    if (controllerWatching.resolve && !controllerWatching.promiseResolved) {
                        controllerWatching.promiseResolved = true;
                        controllerWatching.resolve(undefined);
                    }
                },
                error: (_data, code) => {
                    // console.log('easyServer.error', {_data, controllerWatching})
                    this.ServerApi.file.appendText(this.ServerInfo.logFile, `exit code ${code}`, {isDataPath: true});
                    clearTimeout(timer);
                    controller = null;
                    hasMoreQueue()
                    if (controllerWatching.reject && !controllerWatching.promiseResolved) {
                        controllerWatching.promiseResolved = true;
                        controllerWatching.reject(undefined);
                    }
                },
            })
        } else if (configJsonPath) {
            const queueName = `${Date.now()}.queue.json`;
            const queuePath = this.ServerInfo.localPath + `/aigcpanel-queue/${queueName}`;
            await Files.copy(configJsonPath, queuePath);
            this.ServerApi.file.appendText(
                this.ServerInfo.logFile,
                `Another task is running, queued at ${queueName}`,
                {isDataPath: true}
            );
        }
    };
    this._callFunc = async function (
        data: ServerFunctionDataType,
        configCalculator: (data: ServerFunctionDataType) => Promise<any>,
        resultDataCalculator: (data: ServerFunctionDataType, launcherResult: LauncherResultType) => Promise<any>,
        option: {
            timeout: number;
        }
    ) {
        option = Object.assign(
            {
                timeout: 24 * 3600,
            },
            option
        );
        const resultData = {
            // success, retry
            type: "success",
            start: 0,
            end: 0,
            data: {},
        };
        if (this.isRunning) {
            resultData.type = "retry";
            return {
                code: 0,
                msg: "ok",
                data: resultData,
            };
        }
        this.isRunning = true;
        resultData.start = Date.now();
        let configJsonPath = null;
        try {
            this.send("taskRunning", {id: data.id});
            const configData = await configCalculator(data);
            configData.setting = this.ServerInfo.setting;
            configJsonPath = await this.ServerApi.launcherPrepareConfigJson(configData);
            // console.log('EasyServer.envMap', envMap)
            const launcherResult: LauncherResultType = {
                result: {},
                endTime: null,
            };
            // console.log('easyServer.start', JSON.stringify({command, envMap, configData}))
            await (async () => {
                return new Promise((resolve, reject) => {
                    controllerWatching.id = data.id;
                    controllerWatching.launcherResult = launcherResult;
                    controllerWatching.resolve = resolve;
                    controllerWatching.reject = reject;
                    controllerWatching.promiseResolved = false;
                    me._controllerRunIfNeeded(configJsonPath, option);
                });
            })();
            resultData.end = Date.now();
            resultData.data = await resultDataCalculator(data, launcherResult);
            // console.log('easyServer.end', launcherResult)
            await Files.deletes(configJsonPath);
            return {
                code: 0,
                msg: "ok",
                data: resultData,
            };
        } catch (e) {
            throw e;
        } finally {
            this.isRunning = false;
        }
    };
    this.soundTts = async function (data: ServerFunctionDataType) {
        // console.log('soundTts', {data, serverInfo: this.ServerInfo})
        return this._callFunc(
            data,
            async (data: ServerFunctionDataType) => {
                return {
                    id: data.id,
                    mode: "local",
                    modelConfig: {
                        type: "soundTts",
                        param: data.param,
                        text: data.text,
                    },
                };
            },
            async (data: ServerFunctionDataType, launcherResult: LauncherResultType) => {
                // 🔧 修复：忽略 {"End": true} 结束标志，只检查真正的错误
                if (!("url" in launcherResult.result)) {
                    // 如果是End标志,直接返回现有结果(涓嶆姤閿?
                    if (launcherResult.result.End === true) {
                        return launcherResult.result;
                    }
                    if (launcherResult.result.error) {
                        throw launcherResult.result.error;
                    }
                    throw "执行失败，请查看模型日志";
                }
                return {
                    url: launcherResult.result.url,
                };
            }
        );
    };
    this.soundClone = async function (data: ServerFunctionDataType) {
        // console.log('soundClone', {data, serverInfo: this.ServerInfo})
        return this._callFunc(
            data,
            async (data: ServerFunctionDataType) => {
                return {
                    id: data.id,
                    mode: "local",
                    modelConfig: {
                        type: "soundClone",
                        param: data.param,
                        text: data.text,
                        promptAudio: data.promptAudio,
                        promptText: data.promptText,
                    },
                };
            },
            async (data: ServerFunctionDataType, launcherResult: LauncherResultType) => {
                // 🔧 修复：忽略 {"End": true} 结束标志，只检查真正的错误
                if (!("url" in launcherResult.result)) {
                    // 如果是End标志,直接返回现有结果(涓嶆姤閿?
                    if (launcherResult.result.End === true) {
                        return launcherResult.result;
                    }
                    if (launcherResult.result.error) {
                        throw launcherResult.result.error;
                    }
                    throw "执行失败，请查看模型日志";
                }
                return {
                    url: launcherResult.result.url,
                };
            }
        );
    };
    this.videoGen = async function (data: ServerFunctionDataType) {
        // console.log('videoGen', JSON.stringify({data, serverInfo: this.ServerInfo}))
        return this._callFunc(
            data,
            async (data: ServerFunctionDataType) => {
                return {
                    id: data.id,
                    mode: "local",
                    modelConfig: {
                        type: "videoGen",
                        param: data.param,
                        video: data.video,
                        audio: data.audio,
                    },
                };
            },
            async (data: ServerFunctionDataType, launcherResult: LauncherResultType) => {
                // 🔧 修复：忽略 {"End": true} 结束标志，只检查真正的错误
                if (!("url" in launcherResult.result)) {
                    // 如果是End标志,直接返回现有结果(涓嶆姤閿?
                    if (launcherResult.result.End === true) {
                        return launcherResult.result;
                    }
                    if (launcherResult.result.error) {
                        throw launcherResult.result.error;
                    }
                    throw "执行失败，请查看模型日志";
                }
                return {
                    url: launcherResult.result.url,
                };
            }
        );
    };
    this.asr = async function (data: ServerFunctionDataType) {
        // console.log('videoGen', JSON.stringify({data, serverInfo: this.ServerInfo}))
        return this._callFunc(
            data,
            async (data: ServerFunctionDataType) => {
                return {
                    id: data.id,
                    mode: "local",
                    modelConfig: {
                        type: 'asr',
                        audio: data.audio,
                        param: data.param,
                    },
                };
            },
            async (data: ServerFunctionDataType, launcherResult: LauncherResultType) => {
                // 🔧 修复：忽略 {"End": true} 结束标志，只检查真正的错误
                if (!("records" in launcherResult.result)) {
                    // 如果是End标志,直接返回现有结果(涓嶆姤閿?
                    if (launcherResult.result.End === true) {
                        return launcherResult.result;
                    }
                    if (launcherResult.result.error) {
                        throw launcherResult.result.error;
                    }
                    throw "执行失败，请查看模型日志";
                }
                return {
                    records: launcherResult.result.records,
                };
            }
        );
    };
    this.textToImage = async function (data: ServerFunctionDataType) {
        // console.log('textToImage', {data, serverInfo: this.ServerInfo})
        return this._callFunc(
            data,
            async (data: ServerFunctionDataType) => {
                return {
                    id: data.id,
                    mode: "local",
                    modelConfig: {
                        type: "textToImage",
                        prompt: data.prompt,
                        param: data.param,
                    },
                };
            },
            async (data: ServerFunctionDataType, launcherResult: LauncherResultType) => {
                // 🔧 修复：忽略 {"End": true} 结束标志，只检查真正的错误
                if (!("url" in launcherResult.result)) {
                    // 如果是End标志,直接返回现有结果(涓嶆姤閿?
                    if (launcherResult.result.End === true) {
                        return launcherResult.result;
                    }
                    if (launcherResult.result.error) {
                        throw launcherResult.result.error;
                    }
                    throw "执行失败，请查看模型日志";
                }
                return {
                    url: launcherResult.result.url,
                };
            }
        );
    };
    this.imageToImage = async function (data: ServerFunctionDataType) {
        // console.log('imageToImage', {data, serverInfo: this.ServerInfo})
        return this._callFunc(
            data,
            async (data: ServerFunctionDataType) => {
                return {
                    id: data.id,
                    mode: "local",
                    modelConfig: {
                        type: "imageToImage",
                        image: data.image,
                        prompt: data.prompt,
                        param: data.param,
                    },
                };
            },
            async (data: ServerFunctionDataType, launcherResult: LauncherResultType) => {
                // 🔧 修复：忽略 {"End": true} 结束标志，只检查真正的错误
                if (!("url" in launcherResult.result)) {
                    // 如果是End标志,直接返回现有结果(涓嶆姤閿?
                    if (launcherResult.result.End === true) {
                        return launcherResult.result;
                    }
                    if (launcherResult.result.error) {
                        throw launcherResult.result.error;
                    }
                    throw "执行失败，请查看模型日志";
                }
                return {
                    url: launcherResult.result.url,
                };
            }
        );
    };
};

