import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import logger from '../log/main';
import { buildV2NodeInfoList } from './v2-task-payload.cjs';

/**
 * RunningHub API 配置
 */
/**
 * 节点配置项：支持字符串(nodeId)或对象({id, fieldName})格式
 * 对象格式可自定义 fieldName，适应不同工作流的节点输入字段
 */
export type NodeConfigEntry = string | { id: string; fieldName?: string; value?: string | number };

export interface RunningHubConfig {
  apiKey: string;
  workflowId: string;
  baseUrl?: string;
  apiVersion?: 'v1' | 'v2';
  instanceType?: 'default' | 'plus';
  nodes?: {
    videoNode: NodeConfigEntry;
    audioNode: NodeConfigEntry;
    durationNode?: NodeConfigEntry;
    fpsNode?: NodeConfigEntry;
    widthNode?: NodeConfigEntry;
    heightNode?: NodeConfigEntry;
    maxSideNode?: NodeConfigEntry;
    audioStartNode?: NodeConfigEntry;
    audioEndNode?: NodeConfigEntry;
    textNode?: NodeConfigEntry;
    /** 🔧 扩展：额外节点参数覆盖，fieldValue 支持 {{audioDuration}} 占位符 */
    extraNodes?: Array<{ nodeId: string; fieldName: string; fieldValue: string | number }>;
  };
}

/** 默认 fieldName 映射 */
const DEFAULT_FIELD_NAMES: Record<string, string> = {
  videoNode: 'file',
  audioNode: 'audio',
  durationNode: 'value',
  fpsNode: 'int',
  widthNode: 'int',
  heightNode: 'int',
  maxSideNode: 'int',
  audioStartNode: 'int',
  audioEndNode: 'int',
  textNode: 'text',
};

/**
 * 解析节点配置项，返回 {nodeId, fieldName}
 */
function resolveNode(entry: NodeConfigEntry | undefined, key: string): { nodeId: string; fieldName: string } | null {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { nodeId: entry, fieldName: DEFAULT_FIELD_NAMES[key] || 'value' };
  }
  return { nodeId: entry.id, fieldName: entry.fieldName || DEFAULT_FIELD_NAMES[key] || 'value' };
}

/**
 * 任务状态
 */
export type TaskStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED';

/**
 * 任务查询结果
 */
export interface TaskQueryResult {
  taskId: string;
  status: TaskStatus;
  errorCode?: string;
  errorMessage?: string;
  results?: Array<{
    url: string;
    outputType: string;
  }>;
}

/**
 * RunningHub API 客户端
 * 配置优先级：传入参数 > 系统后台配置 > 硬编码默认值
 * 硬编码默认值确保打包后也能正常工作
 */
export class RunningHubClient {
  private config: Required<RunningHubConfig>;

  /**
   * 工作流节点配置映射表
   * 根据不同工作流ID，返回对应的节点配置
   */
  private getNodesConfig(workflowId: string): Required<RunningHubConfig>['nodes'] {
    return {
      videoNode: { id: '33', fieldName: 'file' },
      audioNode: { id: '2', fieldName: 'audio' }
    };
  }

  /**
   * 硬编码配置（完全写死，不依赖任何外部配置）
   */
  private static HARDCODED = {
    apiKey: '',
    baseUrl: 'https://www.runninghub.cn',
    // 云端模型1（网络节点01）：数字人对口型 AI 应用
    workflowId1: '2044675464228245506',
    nodes1: {
      videoNode: { id: '228', fieldName: 'video' } as NodeConfigEntry,
      audioNode: { id: '125', fieldName: 'audio' } as NodeConfigEntry,
      durationNode: { id: '342', fieldName: 'text', value: '0:{{audioDuration}}' } as NodeConfigEntry,
      fpsNode: { id: '343', fieldName: 'value', value: '30' } as NodeConfigEntry,
      widthNode: { id: '345', fieldName: 'value', value: '720' } as NodeConfigEntry,
      heightNode: { id: '344', fieldName: 'value', value: '1280' } as NodeConfigEntry,
      textNode: { id: '347', fieldName: 'text' } as NodeConfigEntry,
    },
    // 云端模型2（网络节点02）
    workflowId2: '1945645768491585538',
    nodes2: {
      videoNode: { id: '1', fieldName: 'file' } as NodeConfigEntry,
      audioNode: { id: '7', fieldName: 'audio' } as NodeConfigEntry,
      textNode: { id: '12', fieldName: 'prompt' } as NodeConfigEntry,
    },
    // 云端模型3（网络节点03）
    workflowId3: '1984199202748186626',
    nodes3: {
      videoNode: { id: '2', fieldName: 'file' } as NodeConfigEntry,
      audioNode: { id: '3', fieldName: 'audio' } as NodeConfigEntry,
    },
    // 云端模型4（网络节点04）
    workflowId4: '2022323003056459778',
    nodes4: {
      videoNode: { id: '31', fieldName: 'video' } as NodeConfigEntry,
      audioNode: { id: '13', fieldName: 'audio' } as NodeConfigEntry,
      durationNode: { id: '33', fieldName: 'value' } as NodeConfigEntry,
      fpsNode: { id: '36', fieldName: 'int' } as NodeConfigEntry,
      widthNode: { id: '43', fieldName: 'int' } as NodeConfigEntry,
      heightNode: { id: '46', fieldName: 'int' } as NodeConfigEntry,
    },
    // 云端模型5（网络节点05）
    workflowId5: '1928389791241650178',
    nodes5: {
      videoNode: { id: '1', fieldName: 'file' } as NodeConfigEntry,
      audioNode: { id: '4', fieldName: 'audio' } as NodeConfigEntry,
    },
    // 云端模型6（网络节点06）
    workflowId6: '1976590859607085058',
    nodes6: {
      videoNode: { id: '85', fieldName: 'video' } as NodeConfigEntry,
      audioNode: { id: '4', fieldName: 'audio' } as NodeConfigEntry,
    },
    // 云端模型8（AI应用，网络节点08）：数字人对口型
    workflowId8: '2044675464228245506',
    nodes8: {
      videoNode: { id: '228', fieldName: 'video' } as NodeConfigEntry,
      audioNode: { id: '125', fieldName: 'audio' } as NodeConfigEntry,
      durationNode: { id: '342', fieldName: 'text', value: '0:{{audioDuration}}' } as NodeConfigEntry,
      fpsNode: { id: '343', fieldName: 'value', value: '30' } as NodeConfigEntry,
      widthNode: { id: '345', fieldName: 'value', value: '720' } as NodeConfigEntry,
      heightNode: { id: '344', fieldName: 'value', value: '1280' } as NodeConfigEntry,
      textNode: { id: '347', fieldName: 'text' } as NodeConfigEntry,
    },
    apiVersion: 'v2' as const,
    instanceType: 'default' as const,
  };

  constructor(config?: Partial<RunningHubConfig>) {
    const workflowId = config?.workflowId || '';
    const nodes = config?.nodes || RunningHubClient.HARDCODED.nodes1;

    this.config = {
      apiKey: config?.apiKey || RunningHubClient.HARDCODED.apiKey,
      workflowId: workflowId,
      baseUrl: RunningHubClient.HARDCODED.baseUrl,
      apiVersion: config?.apiVersion || RunningHubClient.HARDCODED.apiVersion,
      instanceType: config?.instanceType || RunningHubClient.HARDCODED.instanceType,
      nodes: nodes,
    };

    logger.info('[RunningHub] 客户端已初始化（硬编码模式）', {
      baseUrl: this.config.baseUrl,
      workflowId: this.config.workflowId,
      apiKeyPrefix: this.config.apiKey ? this.config.apiKey.substring(0, 8) + '...' : '(空)',
      nodes: this.config.nodes
    });
  }

  /**
   * 切换到云端模型1
   */
  useModel1() {
    this.config.workflowId = RunningHubClient.HARDCODED.workflowId1;
    this.config.nodes = RunningHubClient.HARDCODED.nodes1;
    logger.info('[RunningHub] 切换到云端模型1', { workflowId: this.config.workflowId });
  }

  /**
   * 切换到云端模型2
   */
  useModel2() {
    this.config.workflowId = RunningHubClient.HARDCODED.workflowId2;
    this.config.nodes = RunningHubClient.HARDCODED.nodes2;
    logger.info('[RunningHub] 切换到云端模型2', { workflowId: this.config.workflowId });
  }

  /**
   * 切换到云端模型3
   */
  useModel3() {
    this.config.workflowId = RunningHubClient.HARDCODED.workflowId3;
    this.config.nodes = RunningHubClient.HARDCODED.nodes3;
    logger.info('[RunningHub] 切换到云端模型3', { workflowId: this.config.workflowId });
  }

  /**
   * 切换到云端模型4
   */
  useModel4() {
    this.config.workflowId = RunningHubClient.HARDCODED.workflowId4;
    this.config.nodes = RunningHubClient.HARDCODED.nodes4;
    logger.info('[RunningHub] 切换到云端模型4', { workflowId: this.config.workflowId });
  }

  /**
   * 切换到云端模型5
   */
  useModel5() {
    this.config.workflowId = RunningHubClient.HARDCODED.workflowId5;
    this.config.nodes = RunningHubClient.HARDCODED.nodes5;
    logger.info('[RunningHub] 切换到云端模型5', { workflowId: this.config.workflowId });
  }

  /**
   * 切换到云端模型6
   */
  useModel6() {
    this.config.workflowId = RunningHubClient.HARDCODED.workflowId6;
    this.config.nodes = RunningHubClient.HARDCODED.nodes6;
    logger.info('[RunningHub] 切换到云端模型6', { workflowId: this.config.workflowId });
  }

  /**
   * 切换到云端模型8（AI应用）
   */
  useModel8() {
    this.config.workflowId = RunningHubClient.HARDCODED.workflowId8;
    this.config.nodes = RunningHubClient.HARDCODED.nodes8;
    logger.info('[RunningHub] 切换到云端模型8(AI应用)', { workflowId: this.config.workflowId });
  }

  /**
   * 上传文件到RunningHub
   * @param filePath 本地文件路径
   * @param fileType 文件类型 (video | audio)
   * @returns 返回文件在服务器上的fileName
   */
  async uploadFile(filePath: string, fileType: 'video' | 'audio'): Promise<string> {
    logger.info(`[RunningHub] 开始上传${fileType}文件`, { filePath });

    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`);
      }

      const stats = fs.statSync(filePath);
      const fileSizeMB = stats.size / (1024 * 1024);
      if (fileSizeMB > 100) {
        throw new Error(`文件大小超过100MB限制: ${fileSizeMB.toFixed(2)}MB`);
      }

      // 检查 API Key 是否已配置
      if (!this.config.apiKey) {
        logger.error(`[RunningHub] API Key 为空，无法上传文件`, {
          filePath,
          fileType,
          configBaseUrl: this.config.baseUrl,
          hasApiKey: false
        });
        throw new Error('API Key 未配置，请在管理后台配置 RunningHub API Key');
      }

      // 文件名转为 ASCII 安全名称，避免中文文件名导致 RunningHub API 返回 [1000] Unknown error
      const originalFileName = path.basename(filePath);
      const ext = path.extname(originalFileName);
      const safeFileName = /^[a-zA-Z0-9_.\-]+$/.test(originalFileName)
        ? originalFileName
        : `upload_${Date.now()}${ext}`;
      logger.info(`[RunningHub] 文件名处理`, { originalFileName, safeFileName });
      const contentType = fileType === 'video' ? 'video/mp4' : 'audio/mpeg';

      const v2UploadUrl = `${this.config.baseUrl}/openapi/v2/media/upload/binary`;
      const v1UploadUrl = `${this.config.baseUrl}/task/openapi/upload`;

      logger.info(`[RunningHub] 上传请求`, {
        v2UploadUrl,
        v1UploadUrl,
        fileType,
        fileSize: `${fileSizeMB.toFixed(2)}MB`,
        apiKeyPrefix: this.config.apiKey.substring(0, 8) + '...',
        originalFileName,
        safeFileName,
        contentType
      });

      const maxRetries = 2;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const result = await this.uploadFileV2(v2UploadUrl, filePath, safeFileName, contentType);
          return result;
        } catch (error: any) {
          lastError = error;
          logger.warn(`[RunningHub] v2上传第${attempt}次失败`, {
            filePath,
            error: error.message,
            willRetry: attempt < maxRetries
          });
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, attempt * 2000));
          }
        }
      }

      logger.info(`[RunningHub] v2上传全部失败，尝试v1接口`, { v1UploadUrl });
      try {
        const result = await this.uploadFileV1(v1UploadUrl, filePath, safeFileName, contentType, fileType);
        return result;
      } catch (v1Error: any) {
        logger.error(`[RunningHub] v1上传也失败`, { error: v1Error.message });
        throw new Error(`上传${fileType}文件失败: v2接口错误[${lastError?.message}], v1接口错误[${v1Error.message}]`);
      }
    } catch (error: any) {
      if (error.message.startsWith('上传') && error.message.includes('文件失败')) {
        throw error;
      }
      logger.error(`[RunningHub] ${fileType}文件上传失败`, {
        filePath,
        fileSize: fs.existsSync(filePath) ? (fs.statSync(filePath).size / (1024 * 1024)).toFixed(2) + 'MB' : 'unknown',
        error: error.message
      });
      throw new Error(`上传${fileType}文件失败: ${error.message}`);
    }
  }

  private uploadFileV2(url: string, filePath: string, fileName: string, contentType: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const requestLib = isHttps ? https : http;

      // 构建 multipart boundary
      const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);

      // 获取文件大小（不再一次性读取整个文件到内存）
      const fileStats = fs.statSync(filePath);

      // 构建 multipart 请求体各部分
      const headerPart = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
      );
      const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`);
      const totalLength = headerPart.length + fileStats.size + footerPart.length;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': totalLength,
        }
      };

      const req = requestLib.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          logger.info(`[RunningHub] 上传响应`, {
            statusCode: res.statusCode,
            contentType: res.headers?.['content-type'],
            dataPreview: data.substring(0, 500),
          });

          // 🔍 将完整响应保存到文件（用于诊断）
          try {
            const debugDir = path.join(process.cwd(), 'rh-debug');
            if (!fs.existsSync(debugDir)) {
              fs.mkdirSync(debugDir, { recursive: true });
            }
            const debugFile = path.join(debugDir, `upload-response-${Date.now()}.txt`);
            fs.writeFileSync(debugFile, `Status: ${res.statusCode}\nHeaders: ${JSON.stringify(res.headers, null, 2)}\n\nBody:\n${data}`);
            logger.info(`[RunningHub] 上传响应已保存到`, { debugFile });
          } catch (e) {
            logger.warn(`[RunningHub] 保存调试响应失败`, { error: (e as Error).message });
          }

          let parsed: any;
          try {
            parsed = JSON.parse(data);
            logger.info(`[RunningHub] 上传响应解析成功`, {
              allKeys: Object.keys(parsed),
              hasCode: parsed.code !== undefined,
              hasMessage: parsed.message !== undefined,
              hasMsg: parsed.msg !== undefined,
              hasError: parsed.error !== undefined,
              hasDetail: parsed.detail !== undefined,
              fullResponse: JSON.stringify(parsed).substring(0, 1000)
            });
          } catch {
            const hint = res.statusCode === 401 ? 'API Key 无效或未配置' :
                         res.statusCode === 403 ? '权限不足，请检查 API Key' :
                         '服务器返回了非 JSON 响应';
            logger.error(`[RunningHub] 上传响应非JSON`, { statusCode: res.statusCode, hint, rawData: data.substring(0, 1000) });
            reject(new Error(`${hint} (HTTP ${res.statusCode})，请在管理后台检查 RunningHub API Key 配置`));
            return;
          }

          // 处理各种可能的响应格式
          logger.info(`[RunningHub] 上传响应解析结果`, {
            allKeys: Object.keys(parsed),
            code: parsed.code,
            codeType: typeof parsed.code,
            msg: parsed.msg,
            message: parsed.message,
            error: parsed.error,
            detail: parsed.detail,
            hasData: !!parsed.data,
            dataFileName: parsed.data?.fileName
          });

          if (parsed.code === undefined) {
            if (parsed.fileName || (parsed.data && parsed.data.fileName)) {
              const resultFileName = parsed.fileName || parsed.data.fileName;
              logger.info(`[RunningHub] 上传成功(无code字段)`, { fileName: resultFileName });
              resolve(resultFileName);
              return;
            }

            const errorMsg = parsed.errorMessage || parsed.errorCode
              ? `[${parsed.errorCode || ''}] ${parsed.errorMessage || ''}`
              : (parsed.error || parsed.detail || parsed.message || parsed.msg || '');
            logger.error(`[RunningHub] 上传响应缺少code字段`, {
              fullResponse: JSON.stringify(parsed).substring(0, 1000),
              allKeys: Object.keys(parsed),
              errorCode: parsed.errorCode,
              errorMessage: parsed.errorMessage
            });

            if (errorMsg) {
              reject(new Error(`上传失败: ${errorMsg}`));
            } else {
              reject(new Error(`上传响应格式异常，缺少code字段: ${JSON.stringify(parsed).substring(0, 200)}`));
            }
            return;
          }

          if (parsed.code !== 0) {
            const apiMsg = parsed.msg || parsed.message || parsed.error || parsed.detail || '';
            logger.error(`[RunningHub] 上传API返回错误`, {
              code: parsed.code,
              msg: parsed.msg,
              message: parsed.message,
              errorMsg: apiMsg,
              fullResponse: JSON.stringify(parsed).substring(0, 500)
            });
            reject(new Error(apiMsg || `上传失败(code=${parsed.code})`));
            return;
          }

          const resultFileName = parsed.data?.fileName;
          if (!resultFileName) {
            reject(new Error('上传成功但未返回文件名'));
            return;
          }

          logger.info(`[RunningHub] 文件上传成功`, { fileName: resultFileName });
          resolve(resultFileName);
        });
      });

      req.on('error', (error: Error) => {
        reject(new Error(`上传请求失败: ${error.message}`));
      });

      req.setTimeout(300000, () => {
        req.destroy();
        reject(new Error('上传超时(5分钟)'));
      });

      // ✅ 流式上传：先写 header，再用 stream 管道传输文件内容，最后写 footer
      req.write(headerPart);

      const fileStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }); // 1MB 缓冲区
      fileStream.on('error', (err) => {
        req.destroy();
        reject(new Error(`读取文件失败: ${err.message}`));
      });

      fileStream.pipe(req, { end: false });

      fileStream.on('end', () => {
        req.write(footerPart);
        req.end();
      });
    });
  }

  private uploadFileV1(url: string, filePath: string, fileName: string, contentType: string, fileType: 'video' | 'audio'): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const requestLib = isHttps ? https : http;
      const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
      const fileStats = fs.statSync(filePath);
      const fileBuffer = fs.readFileSync(filePath);

      const apiKeyPart = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="apiKey"\r\n\r\n` +
        `${this.config.apiKey}\r\n`
      );
      const fileTypePart = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="fileType"\r\n\r\n` +
        `input\r\n`
      );
      const fileHeaderPart = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
      );
      const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`);
      const totalLength = apiKeyPart.length + fileTypePart.length + fileHeaderPart.length + fileBuffer.length + footerPart.length;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': totalLength,
        }
      };

      const req = requestLib.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          logger.info(`[RunningHub] v1上传响应`, {
            statusCode: res.statusCode,
            dataPreview: data.substring(0, 500),
          });

          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            reject(new Error(`v1上传响应非JSON (HTTP ${res.statusCode})`));
            return;
          }

          if (parsed.code === 0 && parsed.data?.fileName) {
            logger.info(`[RunningHub] v1上传成功`, { fileName: parsed.data.fileName });
            resolve(parsed.data.fileName);
            return;
          }

          const errorMsg = parsed.msg || parsed.message || `v1上传失败(code=${parsed.code})`;
          reject(new Error(errorMsg));
        });
      });

      req.on('error', (error: Error) => {
        reject(new Error(`v1上传请求失败: ${error.message}`));
      });

      req.setTimeout(300000, () => {
        req.destroy();
        reject(new Error('v1上传超时(5分钟)'));
      });

      req.write(apiKeyPart);
      req.write(fileTypePart);
      req.write(fileHeaderPart);
      req.write(fileBuffer);
      req.write(footerPart);
      req.end();
    });
  }

  /**
   * 创建云端合成任务
   * @param videoFileName 视频文件名
   * @param audioFileName 音频文件名
   * @param audioDuration 音频时长（秒）
   * @returns 返回任务ID
   */
  async createTask(videoFileName: string, audioFileName: string, audioDuration?: number, text?: string): Promise<string> {
    logger.info('[RunningHub] 开始创建任务', { videoFileName, audioFileName, audioDuration, text, workflowId: this.config.workflowId, apiVersion: this.config.apiVersion });

    try {
      // 检查 API Key 是否已配置
      if (!this.config.apiKey) {
        throw new Error('API Key 未配置，请在管理后台配置 RunningHub API Key');
      }

      if (this.config.apiVersion === 'v2') {
        // 节点参数构建委托给共享纯函数模块（支持 value 覆盖、{{audioDuration}} 模板、extraNodes）
        const videoNode = resolveNode(this.config.nodes.videoNode, 'videoNode')!;
        const audioNode = resolveNode(this.config.nodes.audioNode, 'audioNode')!;
        const cfgNodes: Record<string, any> = {
          videoNode,
          audioNode
        };
        for (const key of ['durationNode', 'fpsNode', 'widthNode', 'heightNode', 'maxSideNode', 'audioStartNode', 'audioEndNode', 'textNode'] as const) {
          const resolved = resolveNode(this.config.nodes[key], key);
          if (resolved) {
            const raw = this.config.nodes[key];
            cfgNodes[key] = (raw && typeof raw === 'object' && raw.value !== undefined)
              ? { ...resolved, value: raw.value }
              : resolved;
          }
        }
        const extraNodes = (this.config.nodes as any)?.extraNodes;
        if (Array.isArray(extraNodes)) cfgNodes.extraNodes = extraNodes;
        const nodeInfoList = buildV2NodeInfoList(cfgNodes, { videoFileName, audioFileName, audioDuration, text });

        const payload = {
          randomSeed: true,
          nodeInfoList,
          instanceType: this.config.instanceType || 'default',
          retainSeconds: 0,
          usePersonalQueue: false
        };

        logger.info('[RunningHub] v2 API请求payload', payload);

        const apiPath = `/openapi/v2/run/ai-app/${this.config.workflowId}`;
        const responseData = await this.nativePost(apiPath, payload);

        logger.info('[RunningHub] v2 API响应', { data: responseData });

        const taskId = responseData.taskId;

        if (!taskId) {
          throw new Error(responseData.errorMessage || '创建任务失败：未返回taskId');
        }

        logger.info('[RunningHub] 任务创建成功（v2）', { taskId, status: responseData.status });

        return taskId;
      }

      const videoNodeV1 = resolveNode(this.config.nodes.videoNode, 'videoNode')!;
      const audioNodeV1 = resolveNode(this.config.nodes.audioNode, 'audioNode')!;
      const nodeInfoList = [
        {
          nodeId: videoNodeV1.nodeId,
          // 🔧 使用配置里的字段名（不同工作流的视频输入字段可能是 file 或 video）
          fieldName: videoNodeV1.fieldName || 'file',
          fieldValue: videoFileName
        },
        {
          nodeId: audioNodeV1.nodeId,
          fieldName: audioNodeV1.fieldName || 'audio',
          fieldValue: audioFileName
        }
      ];

      const payload = {
        apiKey: this.config.apiKey,
        workflowId: this.config.workflowId,
        nodeInfoList
      };

        // 🔧 扩展：额外节点参数覆盖（时长控制、帧率修正等），支持 {{audioDuration}} 占位符
        const extraNodes = (this.config.nodes as any)?.extraNodes;
        if (Array.isArray(extraNodes)) {
          for (const extra of extraNodes) {
            if (!extra?.nodeId || !extra?.fieldName) continue;
            nodeInfoList.push({
              nodeId: String(extra.nodeId),
              fieldName: String(extra.fieldName),
              fieldValue: String(extra.fieldValue ?? '').replace(/\{\{audioDuration\}\}/g, String(audioDuration ?? 0)),
              description: '参数覆盖'
            });
          }
        }

      logger.info('[RunningHub] v1 API请求payload', payload);

      const responseData = await this.nativePost('/task/openapi/create', payload);

      logger.info('[RunningHub] v1 API响应', { data: responseData });

      if (responseData.code !== 0) {
        throw new Error(responseData.msg || '创建任务失败');
      }

      const taskId = responseData.data.taskId;
      logger.info('[RunningHub] 任务创建成功（v1）', {
        taskId,
        status: responseData.data.taskStatus
      });

      return taskId;
    } catch (error: any) {
      logger.error('[RunningHub] 创建任务失败', {
        error: error.message,
        workflowId: this.config.workflowId,
        apiVersion: this.config.apiVersion
      });

      throw new Error(`创建任务失败: ${error.message}`);
    }
  }

  /**
   * 查询任务状态
   * @param taskId 任务ID
   * @returns 返回任务查询结果
   */
  async queryTask(taskId: string): Promise<TaskQueryResult> {
    try {
      const responseData = await this.nativePost('/openapi/v2/query', { taskId });

      const result: TaskQueryResult = {
        taskId: responseData.taskId,
        status: responseData.status,
        errorCode: responseData.errorCode,
        errorMessage: responseData.errorMessage,
        results: responseData.results
      };

      return result;
    } catch (error: any) {
      logger.error('[RunningHub] 查询任务失败', {
        taskId,
        error: error.message
      });
      throw new Error(`查询任务失败: ${error.message}`);
    }
  }

  /**
   * 轮询查询任务状态直到完成
   * @param taskId 任务ID
   * @param maxRetries 最大重试次数，默认360次（6分钟）
   * @param interval 查询间隔，默认1000ms
   * @param onProgress 进度回调函数
   * @returns 返回最终结果
   */
  async waitForTaskComplete(
    taskId: string,
    maxRetries: number = 360,
    interval: number = 1000,
    onProgress?: (status: TaskStatus, retryCount: number) => void
  ): Promise<TaskQueryResult> {
    logger.info('[RunningHub] 开始轮询任务状态', { taskId, maxRetries });

    let retryCount = 0;

    while (retryCount < maxRetries) {
      const result = await this.queryTask(taskId);

      // 调用进度回调
      if (onProgress) {
        onProgress(result.status, retryCount);
      }

      // 任务完成
      if (result.status === 'SUCCESS') {
        logger.info('[RunningHub] 任务完成', {
          taskId,
          retryCount,
          results: result.results
        });
        return result;
      }

      // 任务失败
      if (result.status === 'FAILED') {
        logger.error('[RunningHub] 任务失败', {
          taskId,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage
        });
        throw new Error(result.errorMessage || '任务执行失败');
      }

      // 继续等待
      retryCount++;
      await new Promise(resolve => setTimeout(resolve, interval));
    }

    // 超时
    throw new Error(`任务超时: 已等待 ${maxRetries * interval / 1000} 秒`);
  }

  /**
   * 使用 Node.js 原生 https 模块发送 POST JSON 请求
   * 避免 axios 在 Electron 打包后被 browser 字段替换为浏览器版
   */
  private nativePost(apiPath: string, payload: any, timeout: number = 600000): Promise<any> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(this.config.baseUrl);
      const isHttps = urlObj.protocol === 'https:';
      const requestLib = isHttps ? https : http;
      const bodyStr = JSON.stringify(payload);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: apiPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Length': Buffer.byteLength(bodyStr),
        }
      };

      const req = requestLib.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch {
            reject(new Error(`API响应非JSON (HTTP ${res.statusCode}): ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (error: Error) => {
        reject(new Error(`API请求失败: ${error.message}`));
      });

      req.setTimeout(timeout, () => {
        req.destroy();
        reject(new Error(`API请求超时(${timeout / 1000}s)`));
      });

      req.write(bodyStr);
      req.end();
    });
  }
}
