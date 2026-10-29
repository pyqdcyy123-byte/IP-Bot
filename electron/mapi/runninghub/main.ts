import { ipcMain } from 'electron';
import { RunningHubClient } from './client';
import logger from '../log/main';
import { getElectronSystemConfigSync, fetchElectronSystemConfig } from '../systemConfig';
import * as path from 'path';
import * as fs from 'fs';

let clientInstance1: RunningHubClient | null = null;
let clientInstance2: RunningHubClient | null = null;
let clientInstance3: RunningHubClient | null = null;
let clientInstance4: RunningHubClient | null = null;
let clientInstance5: RunningHubClient | null = null;
let clientInstance6: RunningHubClient | null = null;
let clientInstance7: RunningHubClient | null = null;
let clientInstance8: RunningHubClient | null = null;
let cachedWorkflowId1: string | null = null;
let cachedWorkflowId2: string | null = null;
let cachedWorkflowId3: string | null = null;
let cachedWorkflowId4: string | null = null;
let cachedWorkflowId5: string | null = null;
let cachedWorkflowId6: string | null = null;
let cachedWorkflowId7: string | null = null;
let cachedWorkflowId8: string | null = null;
let cachedNodes1: string | null = null;
let cachedNodes2: string | null = null;
let cachedNodes3: string | null = null;
let cachedNodes4: string | null = null;
let cachedNodes5: string | null = null;
let cachedNodes6: string | null = null;
let cachedNodes7: string | null = null;
let cachedNodes8: string | null = null;
let cachedApiKey1: string | null = null;
let cachedApiKey2: string | null = null;
let cachedApiKey3: string | null = null;
let cachedApiKey4: string | null = null;
let cachedApiKey5: string | null = null;
let cachedApiKey6: string | null = null;
let cachedApiKey7: string | null = null;
let cachedApiKey8: string | null = null;

type CloudBeautySessionData = {
  task_id: string;
  video_upload_url?: string;
  audio_upload_url?: string;
  status_url?: string;
  status?: string;
  queue_position?: number | null;
  assigned_node_id?: string | null;
};

type CloudBeautyAuthMode = 'none' | 'legacy' | 'full';

function buildCloudBeautyHeaders(
  apiKey: string,
  extraHeaders: Record<string, string> = {},
  mode: CloudBeautyAuthMode = 'full'
) {
  const headers: Record<string, string> = { ...extraHeaders };
  if (mode === 'none' || !apiKey) {
    return headers;
  }

  headers['X-API-Key'] = apiKey;
  if (mode === 'full') {
    headers['ApiKey'] = apiKey;
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

function isCloudBeautyAuthError(error: any) {
  const status = error?.response?.status;
  return status === 401 || status === 403;
}

async function cloudBeautyPostWithFallback(
  axios: any,
  url: string,
  data: any,
  params: {
    apiKey: string;
    extraHeaders?: Record<string, string>;
    timeout?: number;
    label: string;
    modes?: CloudBeautyAuthMode[];
    maxBodyLength?: number;
    maxContentLength?: number;
  }
) {
  const modes = params.modes || ['full', 'legacy'];
  let lastError: any = null;

  for (let i = 0; i < modes.length; i++) {
    const mode = modes[i];
    try {
      return await axios.post(url, data, {
        headers: buildCloudBeautyHeaders(params.apiKey, params.extraHeaders || {}, mode),
        timeout: params.timeout,
        maxBodyLength: params.maxBodyLength,
        maxContentLength: params.maxContentLength,
      });
    } catch (error: any) {
      lastError = error;
      if (!isCloudBeautyAuthError(error) || i === modes.length - 1) {
        throw error;
      }
      logger.warn(`[CloudBeauty] ${params.label} 鉴权模式回退`, {
        url,
        mode,
        status: error?.response?.status,
      });
    }
  }

  throw lastError;
}

async function cloudBeautyGetWithFallback(
  axios: any,
  url: string,
  params: {
    apiKey: string;
    extraHeaders?: Record<string, string>;
    timeout?: number;
    label: string;
    modes?: CloudBeautyAuthMode[];
  }
) {
  const modes = params.modes || ['full', 'legacy'];
  let lastError: any = null;

  for (let i = 0; i < modes.length; i++) {
    const mode = modes[i];
    try {
      return await axios.get(url, {
        headers: buildCloudBeautyHeaders(params.apiKey, params.extraHeaders || {}, mode),
        timeout: params.timeout,
      });
    } catch (error: any) {
      lastError = error;
      if (!isCloudBeautyAuthError(error) || i === modes.length - 1) {
        throw error;
      }
      logger.warn(`[CloudBeauty] ${params.label} 鉴权模式回退`, {
        url,
        mode,
        status: error?.response?.status,
      });
    }
  }

  throw lastError;
}

function unwrapCloudBeautyPayload<T = any>(payload: any): T {
  return (payload?.data || payload || {}) as T;
}

function isCloudBeautyFailureStatus(status?: string) {
  const normalized = String(status || '').toLowerCase();
  return ['failed', 'fail', 'error', 'rejected', 'cancelled'].includes(normalized);
}

async function waitForCloudBeautyUploadUrls(params: {
  axios: any;
  baseUrl: string;
  apiKey: string;
  taskId: string;
  statusUrl?: string;
  maxAttempts?: number;
  intervalMs?: number;
}) {
  const pollUrl = params.statusUrl || `${params.baseUrl}/api/task/status/${params.taskId}`;
  const maxAttempts = params.maxAttempts ?? 120;
  const intervalMs = params.intervalMs ?? 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await cloudBeautyGetWithFallback(params.axios, pollUrl, {
      apiKey: params.apiKey,
      timeout: 30000,
      label: '查询上传地址',
      modes: ['full', 'legacy'],
    });
    const statusData = unwrapCloudBeautyPayload<CloudBeautySessionData>(resp.data);

    const uploadReady = !!statusData.video_upload_url && !!statusData.audio_upload_url;
    const nodeAssigned = !!statusData.assigned_node_id;

    if (uploadReady && nodeAssigned) {
      return statusData;
    }

    if (isCloudBeautyFailureStatus(statusData.status)) {
      throw new Error(`等待上传地址失败: ${JSON.stringify(statusData)}`);
    }

    logger.info('[CloudBeauty] 上传地址尚未就绪，继续等待', {
      taskId: params.taskId,
      status: statusData.status,
      queuePosition: statusData.queue_position,
      uploadReady,
      assignedNodeId: statusData.assigned_node_id,
      attempt,
      maxAttempts,
    });

    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(`等待上传地址超时: taskId=${params.taskId}`);
}

function normalizeBaseUrl(url: string): string {
  return (url || '').trim().replace(/\/+$/, '');
}

function getMimeType(filePath: string, kind: 'video' | 'audio'): string {
  const ext = path.extname(filePath).toLowerCase();
  if (kind === 'video') {
    if (ext === '.mov') return 'video/quicktime';
    if (ext === '.mkv') return 'video/x-matroska';
    if (ext === '.avi') return 'video/x-msvideo';
    if (ext === '.webm') return 'video/webm';
    return 'video/mp4';
  }

  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.ogg') return 'audio/ogg';
  return 'audio/mpeg';
}

const cloudBeautyApiModeCache = new Map<string, 'direct' | 'legacy'>();

async function detectCloudBeautyApiMode(baseUrl: string): Promise<'direct' | 'legacy'> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const cachedMode = cloudBeautyApiModeCache.get(normalizedBaseUrl);
  if (cachedMode) {
    return cachedMode;
  }

  const axios = (await import('axios')).default;
  try {
    const openapiResp = await axios.get(`${normalizedBaseUrl}/openapi.json`, {
      timeout: 10000,
    });

    const paths = openapiResp.data?.paths || {};
    const mode = paths['/api/session/create'] ? 'direct' : 'legacy';
    cloudBeautyApiModeCache.set(normalizedBaseUrl, mode);
    return mode;
  } catch (error: any) {
    const status = error?.response?.status;
    if (status === 404 || status === 405) {
      logger.info('[CloudBeauty] openapi.json unavailable, assume legacy mode', {
        baseUrl: normalizedBaseUrl,
        status,
      });
      cloudBeautyApiModeCache.set(normalizedBaseUrl, 'legacy');
      return 'legacy';
    }

    throw error;
  }
}

async function submitCloudBeautyDirectTask(params: {
  baseUrl: string;
  apiKey: string;
  videoPath: string;
  audioPath: string;
  humanWeight: string;
}) {
  const axios = (await import('axios')).default;

  const sessionBody = new URLSearchParams({
    human_weight: params.humanWeight,
    weight_sync: '0.5',
  });

  logger.info('[CloudBeauty] 使用新接口创建直传会话', {
    baseUrl: params.baseUrl,
    humanWeight: params.humanWeight,
  });

  const sessionResp = await cloudBeautyPostWithFallback(
    axios,
    `${params.baseUrl}/api/session/create`,
    sessionBody.toString(),
    {
      apiKey: params.apiKey,
      extraHeaders: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30000,
      label: '创建直传会话',
      modes: ['full', 'legacy'],
    }
  );

  let sessionData = unwrapCloudBeautyPayload<CloudBeautySessionData>(sessionResp.data);
  if (
    sessionData.task_id &&
    (
      !sessionData.video_upload_url ||
      !sessionData.audio_upload_url ||
      !sessionData.assigned_node_id ||
      sessionData.status === 'queued_upload'
    ) &&
    (sessionData.status_url || sessionData.status === 'queued_upload' || typeof sessionData.queue_position === 'number')
  ) {
    logger.info('[CloudBeauty] 直传会话进入排队，等待上传地址', {
      taskId: sessionData.task_id,
      status: sessionData.status,
      queuePosition: sessionData.queue_position,
      assignedNodeId: sessionData.assigned_node_id,
      hasVideoUploadUrl: !!sessionData.video_upload_url,
      hasAudioUploadUrl: !!sessionData.audio_upload_url,
      statusUrl: sessionData.status_url,
    });
    sessionData = await waitForCloudBeautyUploadUrls({
      axios,
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      taskId: sessionData.task_id,
      statusUrl: sessionData.status_url,
    });
  }

  if (!sessionData.task_id || !sessionData.video_upload_url || !sessionData.audio_upload_url || !sessionData.assigned_node_id) {
    throw new Error(`新接口返回数据不完整: ${JSON.stringify(sessionResp.data)}`);
  }

  const uploadFile = async (uploadUrl: string, filePath: string, kind: 'video' | 'audio') => {
    logger.info('[CloudBeauty] 直传文件到 worker', {
      kind,
      uploadUrl,
      filePath,
    });

    // 使用原生 https 模块上传（避免 form-data 在 Electron 打包后被替换为浏览器版）
    const contentType = getMimeType(filePath, kind);
    const fileName = path.basename(filePath);
    const boundary = '----CloudBeautyBoundary' + Math.random().toString(36).substring(2);
    const fileBuffer = fs.readFileSync(filePath);
    const headerPart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    );
    const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`);

    const modes: CloudBeautyAuthMode[] = ['none', 'legacy', 'full'];
    let lastError: any = null;

    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i];
      try {
        const uploadResp = await axios.post(uploadUrl, fileBuffer, {
          headers: {
            ...buildCloudBeautyHeaders(params.apiKey, {}, mode),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 10 * 60 * 1000,
          transformRequest: [(data: any, headers: any) => {
            // 手动构建完整的 multipart body
            const parts = [headerPart, data, footerPart];
            return Buffer.concat(parts);
          }],
        });
        return uploadResp.data;
      } catch (error: any) {
        lastError = error;
        if (!isCloudBeautyAuthError(error) || i === modes.length - 1) {
          throw error;
        }
        logger.warn('[CloudBeauty] worker 上传鉴权模式回退', {
          kind,
          uploadUrl,
          mode,
          status: error?.response?.status,
        });
      }
    }

    throw lastError;
  };

  const videoUploadResult = await uploadFile(sessionData.video_upload_url, params.videoPath, 'video');
  const audioUploadResult = await uploadFile(sessionData.audio_upload_url, params.audioPath, 'audio');

  logger.info('[CloudBeauty] 新接口直传完成', {
    taskId: sessionData.task_id,
    videoUploadResult,
    audioUploadResult,
  });

  return {
    taskId: sessionData.task_id,
    mode: 'direct' as const,
  };
}

async function submitCloudBeautyLegacyTask(params: {
  baseUrl: string;
  apiKey: string;
  videoPath: string;
  audioPath: string;
  humanWeight: string;
  sysCfg: any;
}) {
  const ossConfig = {
    accessKeyId: (params.sysCfg.aliyun_oss_access_key_id || '').trim(),
    accessKeySecret: (params.sysCfg.aliyun_oss_access_key_secret || '').trim(),
    bucket: (params.sysCfg.aliyun_oss_bucket || '').trim(),
    region: (params.sysCfg.aliyun_oss_region || '').trim(),
    endpoint: `https://${(params.sysCfg.aliyun_oss_region || '').trim()}.aliyuncs.com`
  };

  if (!ossConfig.accessKeyId || !ossConfig.bucket) {
    return { success: false, error: 'OSS未配置，无法回退到旧接口模式' };
  }

  logger.info('[CloudBeauty] 回退旧接口 URL 提交模式', {
    bucket: ossConfig.bucket,
    region: ossConfig.region,
    endpoint: ossConfig.endpoint,
  });

  const { uploadToOss } = await import('../aliyun/oss');
  const axios = (await import('axios')).default;
  const FormData = (await import('form-data')).default;

  const videoExt = path.extname(params.videoPath) || '.mp4';
  const audioExt = path.extname(params.audioPath) || '.mp3';
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);

  const videoOssResult = await uploadToOss(params.videoPath, ossConfig, `cloudBeauty/video/${timestamp}_${randomStr}${videoExt}`);
  if (!videoOssResult.success || !videoOssResult.url) {
    return { success: false, error: `视频上传OSS失败: ${videoOssResult.error}` };
  }

  const audioOssResult = await uploadToOss(params.audioPath, ossConfig, `cloudBeauty/audio/${timestamp}_${randomStr}${audioExt}`);
  if (!audioOssResult.success || !audioOssResult.url) {
    return { success: false, error: `音频上传OSS失败: ${audioOssResult.error}` };
  }

  const form = new FormData();
  form.append('video_url', videoOssResult.url);
  form.append('audio_url', audioOssResult.url);
  form.append('human_weight', params.humanWeight);
  form.append('weight_sync', '0.5');

  const resp = await cloudBeautyPostWithFallback(
    axios,
    `${params.baseUrl}/api/task/submit`,
    form,
    {
      apiKey: params.apiKey,
      extraHeaders: form.getHeaders() as Record<string, string>,
      timeout: 30000,
      label: '旧接口提交任务',
      modes: ['full', 'legacy'],
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );

  const taskId = resp.data?.data?.task_id;
  if (!taskId) {
    return { success: false, error: '未获取到task_id: ' + JSON.stringify(resp.data) };
  }

  return { success: true, taskId };
}

async function getClientAsync(mode?: string): Promise<RunningHubClient> {
  await fetchElectronSystemConfig();
  const sysCfg = getElectronSystemConfigSync();
  const apiKey = sysCfg.runninghub_api_key || '';
  // 工作流ID：优先从后台配置读取，如果没有则使用硬编码默认值
  const workflowId1 = sysCfg.runninghub_workflow_id_1 || '2044675464228245506';
  const workflowId2 = sysCfg.runninghub_workflow_id_2 || '1945645768491585538';
  const workflowId3 = sysCfg.runninghub_workflow_id_3 || '1984199202748186626';
  const workflowId4 = sysCfg.runninghub_workflow_id_4 || '2022323003056459778';
  const workflowId5 = sysCfg.runninghub_workflow_id_5 || '1928389791241650178';
  const workflowId6 = sysCfg.runninghub_workflow_id_6 || '1976590859607085058';
  const workflowId7 = sysCfg.runninghub_workflow_id_7 || '1930534351568556033';
  const workflowId8 = sysCfg.runninghub_workflow_id_8 || '2044675464228245506';

  // 云端模型默认节点配置（使用对象格式显式指定 fieldName，避免依赖 DEFAULT_FIELD_NAMES 映射）
  // 云端模型1（网络节点01）：数字人对口型 AI 应用
  const defaultMode1Nodes = {
    videoNode: { id: '228', fieldName: 'video' },
    audioNode: { id: '125', fieldName: 'audio' },
    durationNode: { id: '342', fieldName: 'text', value: '0:{{audioDuration}}' },
    fpsNode: { id: '343', fieldName: 'value', value: '30' },
    widthNode: { id: '345', fieldName: 'value', value: '720' },
    heightNode: { id: '344', fieldName: 'value', value: '1280' },
    textNode: { id: '347', fieldName: 'text' }
  };
  // 云端模型2（网络节点02）
  const defaultMode2Nodes = { videoNode: { id: '1', fieldName: 'file' }, audioNode: { id: '7', fieldName: 'audio' }, textNode: { id: '12', fieldName: 'prompt' } };
  // 云端模型3（网络节点03）
  const defaultMode3Nodes = { videoNode: { id: '2', fieldName: 'file' }, audioNode: { id: '3', fieldName: 'audio' } };
  // 云端模型4（网络节点04）
  const defaultMode4Nodes = { videoNode: { id: '31', fieldName: 'video' }, audioNode: { id: '13', fieldName: 'audio' }, durationNode: { id: '33', fieldName: 'value' }, fpsNode: { id: '36', fieldName: 'int' }, widthNode: { id: '43', fieldName: 'int' }, heightNode: { id: '46', fieldName: 'int' } };
  // 云端模型5（网络节点05）
  const defaultMode5Nodes = { videoNode: { id: '1', fieldName: 'file' }, audioNode: { id: '4', fieldName: 'audio' } };
  // 云端模型6（网络节点06）
  const defaultMode6Nodes = { videoNode: { id: '85', fieldName: 'video' }, audioNode: { id: '4', fieldName: 'audio' } };
  // 云端模型7（网络节点07）
  const defaultMode7Nodes = { videoNode: { id: '3', fieldName: 'file' }, audioNode: { id: '2', fieldName: 'audio' } };
  // 云端模型8（网络节点08，AI应用）：数字人对口型
  const defaultMode8Nodes = {
    videoNode: { id: '228', fieldName: 'video' },
    audioNode: { id: '125', fieldName: 'audio' },
    durationNode: { id: '342', fieldName: 'text', value: '0:{{audioDuration}}' },
    fpsNode: { id: '343', fieldName: 'value', value: '30' },
    widthNode: { id: '345', fieldName: 'value', value: '720' },
    heightNode: { id: '344', fieldName: 'value', value: '1280' },
    textNode: { id: '347', fieldName: 'text' }
  };

  let mode1Nodes: Record<string, any> = defaultMode1Nodes;
  let mode2Nodes: Record<string, any> = defaultMode2Nodes;
  let mode3Nodes: Record<string, any> = defaultMode3Nodes;
  let mode4Nodes: Record<string, any> = defaultMode4Nodes;
  let mode5Nodes: Record<string, any> = defaultMode5Nodes;
  let mode6Nodes: Record<string, any> = defaultMode6Nodes;
  let mode7Nodes: Record<string, any> = defaultMode7Nodes;
  let mode8Nodes: Record<string, any> = defaultMode8Nodes;

  try {
    if (sysCfg.runninghub_mode1_nodes) {
      const parsed = JSON.parse(sysCfg.runninghub_mode1_nodes);
      // 先展开远程配置，再用默认值补全缺失字段（避免 ...parsed 覆盖前面的值）
      mode1Nodes = {
        ...defaultMode1Nodes,
        ...parsed
      };
    }
  } catch (e) {
    logger.warn('[RunningHub] 解析mode1节点配置失败，使用默认值', { error: (e as Error).message, raw: sysCfg.runninghub_mode1_nodes });
  }

  try {
    if (sysCfg.runninghub_mode2_nodes) {
      const parsed = JSON.parse(sysCfg.runninghub_mode2_nodes);
      mode2Nodes = {
        ...defaultMode2Nodes,
        ...parsed
      };
    }
  } catch (e) {
    logger.warn('[RunningHub] 解析mode2节点配置失败，使用默认值', { error: (e as Error).message, raw: sysCfg.runninghub_mode2_nodes });
  }

  try {
    if (sysCfg.runninghub_mode3_nodes) {
      const parsed = JSON.parse(sysCfg.runninghub_mode3_nodes);
      mode3Nodes = { ...defaultMode3Nodes, ...parsed };
    }
  } catch (e) {
    logger.warn('[RunningHub] 解析mode3节点配置失败，使用默认值', { error: (e as Error).message, raw: sysCfg.runninghub_mode3_nodes });
  }

  try {
    if (sysCfg.runninghub_mode4_nodes) {
      const parsed = JSON.parse(sysCfg.runninghub_mode4_nodes);
      mode4Nodes = { ...defaultMode4Nodes, ...parsed };
    }
  } catch (e) {
    logger.warn('[RunningHub] 解析mode4节点配置失败，使用默认值', { error: (e as Error).message, raw: sysCfg.runninghub_mode4_nodes });
  }

  try {
    if (sysCfg.runninghub_mode5_nodes) {
      const parsed = JSON.parse(sysCfg.runninghub_mode5_nodes);
      mode5Nodes = { ...defaultMode5Nodes, ...parsed };
    }
  } catch (e) {
    logger.warn('[RunningHub] 解析mode5节点配置失败，使用默认值', { error: (e as Error).message, raw: sysCfg.runninghub_mode5_nodes });
  }

  try {
    if (sysCfg.runninghub_mode6_nodes) {
      const parsed = JSON.parse(sysCfg.runninghub_mode6_nodes);
      mode6Nodes = { ...defaultMode6Nodes, ...parsed };
    }
  } catch (e) {
    logger.warn('[RunningHub] 解析mode6节点配置失败，使用默认值', { error: (e as Error).message, raw: sysCfg.runninghub_mode6_nodes });
  }

  try {
    if (sysCfg.runninghub_mode7_nodes) {
      const parsed = JSON.parse(sysCfg.runninghub_mode7_nodes);
      mode7Nodes = { ...defaultMode7Nodes, ...parsed };
    }
  } catch (e) {
    logger.warn('[RunningHub] 解析mode7节点配置失败，使用默认值', { error: (e as Error).message, raw: sysCfg.runninghub_mode7_nodes });
  }

  try {
    if (sysCfg.runninghub_mode8_nodes) {
      const parsed = JSON.parse(sysCfg.runninghub_mode8_nodes);
      mode8Nodes = { ...defaultMode8Nodes, ...parsed };
    }
  } catch (e) {
    logger.warn('[RunningHub] 解析mode8节点配置失败，使用默认值', { error: (e as Error).message, raw: sysCfg.runninghub_mode8_nodes });
  }

  logger.info('[RunningHub] 当前配置', {
    mode,
    workflowId1,
    workflowId2,
    workflowId3,
    workflowId4,
    workflowId5,
    workflowId6,
    mode1Nodes,
    mode2Nodes,
    mode3Nodes,
    mode4Nodes,
    mode5Nodes,
    mode6Nodes,
    mode7Nodes,
    mode8Nodes,
    source: sysCfg.runninghub_workflow_id_1 ? '后台' : '默认值'
  });

  const mode1NodesStr = JSON.stringify(mode1Nodes);
  const mode2NodesStr = JSON.stringify(mode2Nodes);
  const mode3NodesStr = JSON.stringify(mode3Nodes);
  const mode4NodesStr = JSON.stringify(mode4Nodes);
  const mode5NodesStr = JSON.stringify(mode5Nodes);
  const mode6NodesStr = JSON.stringify(mode6Nodes);
  const mode7NodesStr = JSON.stringify(mode7Nodes);
  const mode8NodesStr = JSON.stringify(mode8Nodes);

  // 云端模型6
  if (mode === '__CLOUD_MODEL_6__' || mode === 'mode6') {
    if (clientInstance6 && (cachedWorkflowId6 !== workflowId6 || cachedNodes6 !== mode6NodesStr)) {
      logger.info('[RunningHub] mode6配置变更，重建客户端', { oldWorkflow: cachedWorkflowId6, newWorkflow: workflowId6, nodesChanged: cachedNodes6 !== mode6NodesStr });
      clientInstance6 = null;
    }
    if (!clientInstance6) {
      clientInstance6 = new RunningHubClient({
       apiKey,
       workflowId: workflowId6,
        apiVersion: 'v2',
        instanceType: 'default',
        nodes: mode6Nodes
      });
      cachedWorkflowId6 = workflowId6;
      cachedNodes6 = mode6NodesStr;
      logger.info('[RunningHub] 创建v2客户端(mode6/云端模型6)', { workflowId: workflowId6, nodes: mode6Nodes });
    }
    return clientInstance6;
  }

  // 云端模型7
  if (mode === '__CLOUD_MODEL_7__' || mode === 'mode7') {
    if (clientInstance7 && (cachedWorkflowId7 !== workflowId7 || cachedNodes7 !== mode7NodesStr)) {
      logger.info('[RunningHub] mode7配置变更，重建客户端', { oldWorkflow: cachedWorkflowId7, newWorkflow: workflowId7, nodesChanged: cachedNodes7 !== mode7NodesStr });
      clientInstance7 = null;
    }
    if (!clientInstance7) {
      clientInstance7 = new RunningHubClient({
       apiKey,
       workflowId: workflowId7,
        apiVersion: 'v2',
        instanceType: 'default',
        nodes: mode7Nodes
      });
      cachedWorkflowId7 = workflowId7;
      cachedNodes7 = mode7NodesStr;
      logger.info('[RunningHub] 创建v2客户端(mode7/云端模型7)', { workflowId: workflowId7, nodes: mode7Nodes });
    }
    return clientInstance7;
  }

  // 云端模型8（AI应用）
  if (mode === '__CLOUD_MODEL_8__' || mode === 'mode8') {
    if (clientInstance8 && (cachedWorkflowId8 !== workflowId8 || cachedNodes8 !== mode8NodesStr)) {
      logger.info('[RunningHub] mode8配置变更，重建客户端', { oldWorkflow: cachedWorkflowId8, newWorkflow: workflowId8, nodesChanged: cachedNodes8 !== mode8NodesStr });
      clientInstance8 = null;
    }
    if (!clientInstance8) {
      clientInstance8 = new RunningHubClient({
       apiKey,
       workflowId: workflowId8,
        apiVersion: 'v2',
        instanceType: 'default',
        nodes: mode8Nodes
      });
      cachedWorkflowId8 = workflowId8;
      cachedNodes8 = mode8NodesStr;
      logger.info('[RunningHub] 创建v2客户端(mode8/云端模型8)', { workflowId: workflowId8, nodes: mode8Nodes });
    }
    return clientInstance8;
  }

  // 云端模型5
  if (mode === '__CLOUD_MODEL_5__' || mode === 'mode5') {
    if (clientInstance5 && (cachedWorkflowId5 !== workflowId5 || cachedNodes5 !== mode5NodesStr)) {
      logger.info('[RunningHub] mode5配置变更，重建客户端', { oldWorkflow: cachedWorkflowId5, newWorkflow: workflowId5, nodesChanged: cachedNodes5 !== mode5NodesStr });
      clientInstance5 = null;
    }
    if (!clientInstance5) {
      clientInstance5 = new RunningHubClient({
       apiKey,
       workflowId: workflowId5,
        apiVersion: 'v2',
        instanceType: 'default',
        nodes: mode5Nodes
      });
      cachedWorkflowId5 = workflowId5;
      cachedNodes5 = mode5NodesStr;
      logger.info('[RunningHub] 创建v2客户端(mode5/云端模型5)', { workflowId: workflowId5, nodes: mode5Nodes });
    }
    return clientInstance5;
  }

  // 云端模型4
  if (mode === '__CLOUD_MODEL_4__' || mode === 'mode4') {
    if (clientInstance4 && (cachedWorkflowId4 !== workflowId4 || cachedNodes4 !== mode4NodesStr)) {
      logger.info('[RunningHub] mode4配置变更，重建客户端', { oldWorkflow: cachedWorkflowId4, newWorkflow: workflowId4, nodesChanged: cachedNodes4 !== mode4NodesStr });
      clientInstance4 = null;
    }
    if (!clientInstance4) {
      clientInstance4 = new RunningHubClient({
       apiKey,
       workflowId: workflowId4,
        apiVersion: 'v2',
        instanceType: 'default',
        nodes: mode4Nodes
      });
      cachedWorkflowId4 = workflowId4;
      cachedNodes4 = mode4NodesStr;
      logger.info('[RunningHub] 创建v2客户端(mode4/云端模型4)', { workflowId: workflowId4, nodes: mode4Nodes });
    }
    return clientInstance4;
  }

  // 云端模型3
  if (mode === '__CLOUD_MODEL_3__' || mode === 'mode3') {
    if (clientInstance3 && (cachedWorkflowId3 !== workflowId3 || cachedNodes3 !== mode3NodesStr)) {
      logger.info('[RunningHub] mode3配置变更，重建客户端', { oldWorkflow: cachedWorkflowId3, newWorkflow: workflowId3, nodesChanged: cachedNodes3 !== mode3NodesStr });
      clientInstance3 = null;
    }
    if (!clientInstance3) {
      clientInstance3 = new RunningHubClient({
       apiKey,
       workflowId: workflowId3,
        apiVersion: 'v2',
        instanceType: 'default',
        nodes: mode3Nodes
      });
      cachedWorkflowId3 = workflowId3;
      cachedNodes3 = mode3NodesStr;
      logger.info('[RunningHub] 创建v2客户端(mode3/云端模型3)', { workflowId: workflowId3, nodes: mode3Nodes });
    }
    return clientInstance3;
  }

  if (mode === '__CLOUD_MODE2__' || mode === 'mode2') {
    // 工作流ID或节点配置变化时清除缓存
    if (clientInstance2 && (cachedWorkflowId2 !== workflowId2 || cachedNodes2 !== mode2NodesStr)) {
      logger.info('[RunningHub] mode2配置变更，重建客户端', { oldWorkflow: cachedWorkflowId2, newWorkflow: workflowId2, nodesChanged: cachedNodes2 !== mode2NodesStr });
      clientInstance2 = null;
    }
    if (!clientInstance2) {
      clientInstance2 = new RunningHubClient({
       apiKey,
       workflowId: workflowId2,
        apiVersion: 'v2',
        instanceType: 'default',
        nodes: mode2Nodes
      });
      cachedWorkflowId2 = workflowId2;
      cachedNodes2 = mode2NodesStr;
      logger.info('[RunningHub] 创建v2客户端(mode2)', { workflowId: workflowId2, nodes: mode2Nodes });
    }
    return clientInstance2;
  }

  // 工作流ID或节点配置变化时清除缓存
  if (clientInstance1 && (cachedWorkflowId1 !== workflowId1 || cachedNodes1 !== mode1NodesStr)) {
    logger.info('[RunningHub] mode1配置变更，重建客户端', { oldWorkflow: cachedWorkflowId1, newWorkflow: workflowId1, nodesChanged: cachedNodes1 !== mode1NodesStr });
    clientInstance1 = null;
  }
  if (!clientInstance1) {
    clientInstance1 = new RunningHubClient({
      apiKey,
      workflowId: workflowId1,
      // 节点01 现为 AI 应用（数字人对口型），必须走 v2 接口
      apiVersion: 'v2',
      instanceType: 'default',
      nodes: mode1Nodes
    });
    cachedWorkflowId1 = workflowId1;
    cachedNodes1 = mode1NodesStr;
    logger.info('[RunningHub] 创建v1客户端(mode1)', { workflowId: workflowId1, nodes: mode1Nodes });
  }
  return clientInstance1;
}

/**
 * 注册RunningHub IPC handlers
 */
export function registerRunningHubHandlers() {

  // 上传文件
  ipcMain.handle('runninghub:uploadFile', async (event, params) => {
    try {
      const { filePath, fileType, mode } = params;
      logger.info('[RunningHub:IPC] 上传文件', { filePath, fileType, mode });

      const fileName = await (await getClientAsync(mode)).uploadFile(filePath, fileType);
      return { success: true, fileName };
    } catch (error: any) {
      logger.error('[RunningHub:IPC] 上传文件失败', error);
      return { success: false, error: error.message };
    }
  });

  // 创建任务
  ipcMain.handle('runninghub:createTask', async (event, params) => {
    try {
      const { videoFileName, audioFileName, audioDuration, mode, text } = params;
      logger.info('[RunningHub:IPC] 创建任务', { videoFileName, audioFileName, audioDuration, mode, text });

      const taskId = await (await getClientAsync(mode)).createTask(videoFileName, audioFileName, audioDuration, text);
      return { success: true, taskId };
    } catch (error: any) {
      logger.error('[RunningHub:IPC] 创建任务失败', error);
      return { success: false, error: error.message };
    }
  });

  // 查询任务状态
  ipcMain.handle('runninghub:queryTask', async (event, params) => {
    try {
      const { taskId, mode } = params;

      const result = await (await getClientAsync(mode)).queryTask(taskId);
      return { success: true, result };
    } catch (error: any) {
      logger.error('[RunningHub:IPC] 查询任务失败', error);
      return { success: false, error: error.message };
    }
  });

  // 等待任务完成（带轮询）
  ipcMain.handle('runninghub:waitForTaskComplete', async (event, params) => {
    try {
      const { taskId, maxRetries, interval, mode } = params;
      logger.info('[RunningHub:IPC] 等待任务完成', { taskId, maxRetries, mode });

      const result = await (await getClientAsync(mode)).waitForTaskComplete(
        taskId,
        maxRetries,
        interval,
        (status, retryCount) => {
          // 发送进度更新到渲染进程
          event.sender.send('runninghub:task:progress', {
            taskId,
            status,
            retryCount
          });
        }
      );

      return { success: true, result };
    } catch (error: any) {
      logger.error('[RunningHub:IPC] 等待任务完成失败', error);
      return { success: false, error: error.message };
    }
  });

  // 🆕 RunningHub TTS 语音合成
  ipcMain.handle('runninghub:tts:synthesize', async (event, params) => {
    try {
      const { synthesizeSpeech } = await import('./index');
      logger.info('[RunningHub:IPC] 开始TTS语音合成', {
        text: params.text?.substring(0, 50),
        emotion: params.config?.emotion,
        version: params.config?.version
      });

      const result = await synthesizeSpeech(params.text, params.config);
      return result;
    } catch (error: any) {
      logger.error('[RunningHub:IPC] TTS语音合成失败', error);
      return { success: false, error: error.message };
    }
  });

  // 🆕 获取RunningHub可用情感列表
  ipcMain.handle('runninghub:tts:getEmotions', async (event) => {
    try {
      const { getAvailableEmotions } = await import('./index');
      return {
        success: true,
        emotions: getAvailableEmotions()
      };
    } catch (error: any) {
      logger.error('[RunningHub:IPC] 获取情感列表失败', error);
      return { success: false, error: error.message };
    }
  });

  // 🆕 获取T2/T3语音模型配置状态
  ipcMain.handle('runninghub:tts:getModelStatus', async (event) => {
    try {
      await fetchElectronSystemConfig();
      const sysCfg = getElectronSystemConfigSync();
      return {
        success: true,
        t2: {
          configured: !!(sysCfg.runninghub_tts_workflow_id_t2),
          workflowId: sysCfg.runninghub_tts_workflow_id_t2 || '',
          nodes: sysCfg.runninghub_tts_nodes_t2 || ''
        },
        t3: {
          configured: !!(sysCfg.runninghub_tts_workflow_id_t3),
          workflowId: sysCfg.runninghub_tts_workflow_id_t3 || '',
          nodes: sysCfg.runninghub_tts_nodes_t3 || ''
        },
        t4: {
          configured: !!(sysCfg.runninghub_tts_workflow_id_t4),
          workflowId: sysCfg.runninghub_tts_workflow_id_t4 || '',
          nodes: sysCfg.runninghub_tts_nodes_t4 || ''
        },
        t5: {
          configured: !!(sysCfg.runninghub_tts_workflow_id_t5),
          workflowId: sysCfg.runninghub_tts_workflow_id_t5 || '',
          nodes: sysCfg.runninghub_tts_nodes_t5 || ''
        },
        t6: {
          configured: !!(sysCfg.runninghub_tts_workflow_id_t6),
          workflowId: sysCfg.runninghub_tts_workflow_id_t6 || '',
          nodes: sysCfg.runninghub_tts_nodes_t6 || ''
        }
      };
    } catch (error: any) {
      logger.error('[RunningHub:IPC] 获取T2/T3/T4/T5/T6模型状态失败', error);
      return { success: false, error: error.message };
    }
  });

  logger.info('[RunningHub:IPC] Handlers已注册');

  ipcMain.handle('cloudBeauty:submitTask', async (event, params: {
    videoPath: string; audioPath: string; humanWeight: string;
  }) => {
    try {
      const sysCfg = await fetchElectronSystemConfig();
      const baseUrl = normalizeBaseUrl(sysCfg.cloud_beauty_base_url || '');
      const apiKey = sysCfg.cloud_beauty_api_key || '';
      if (!baseUrl || !apiKey) return { success: false, error: '云端美化服务未配置，请确认后台已填写 Base URL 和 API Key' };

      const { videoPath, audioPath, humanWeight } = params;
      logger.info('[CloudBeauty] 提交任务', { videoPath, audioPath, humanWeight });

      const detectedMode = await detectCloudBeautyApiMode(baseUrl);
      logger.info('[CloudBeauty] API mode detected', { baseUrl, detectedMode });
      if (detectedMode === 'direct') {
        const directResult = await submitCloudBeautyDirectTask({
          baseUrl,
           videoPath,
          audioPath,
          humanWeight,
        });
        return { success: true, taskId: directResult.taskId };
      }

      return await submitCloudBeautyLegacyTask({
        baseUrl,
       videoPath,
        audioPath,
        humanWeight,
        sysCfg,
      });
    } catch (error: any) {
      logger.error('[CloudBeauty] 提交任务失败', error);
      const errMsg = error.response
        ? `提交失败(${error.response.status}): ${JSON.stringify(error.response.data)}`
        : error.message;
      return { success: false, error: errMsg };
    }
  });

  ipcMain.handle('cloudBeauty:queryStatus', async (event, params: { taskId: string }) => {
    try {
      const sysCfg = await fetchElectronSystemConfig();
      const baseUrl = normalizeBaseUrl(sysCfg.cloud_beauty_base_url || '');

      const axios = (await import('axios')).default;
      const apiKey = sysCfg.cloud_beauty_api_key || '';
      const resp = await cloudBeautyGetWithFallback(axios, `${baseUrl}/api/task/status/${params.taskId}`, {
       timeout: 30000,
        label: '查询任务状态',
        modes: ['full', 'legacy'],
      });
      const data = unwrapCloudBeautyPayload(resp.data);

      if (data?.download_url && data.download_url.startsWith('/')) {
        data.download_url = baseUrl + data.download_url;
      }

      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
